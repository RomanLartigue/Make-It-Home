require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const twilio = require('twilio');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const Redis = require('ioredis');

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_API_KEY_SID,
  TWILIO_API_KEY_SECRET,
  TWILIO_PHONE_NUMBER,
  SERVER_URL,
  REGISTRATION_SECRET,
  ALLOWED_ORIGINS,
  REDIS_URL,
  PORT = 3000,
} = process.env;

// ── Required config check (fail fast) ─────────────────────────────────────────
// Runs before the Twilio client is constructed so a missing credential produces
// a clear message instead of a stack trace. In production a missing var is fatal;
// in dev we only warn so the server can boot for local UI work.
const REQUIRED_ENV = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_API_KEY_SID',
  'TWILIO_API_KEY_SECRET',
  'TWILIO_PHONE_NUMBER',
  'SERVER_URL',
  'REGISTRATION_SECRET',
];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length) {
  const msg = `[config] Missing required env var(s): ${missingEnv.join(', ')}.`;
  if (process.env.NODE_ENV === 'production') {
    console.error(`${msg} Refusing to start in production.`);
    process.exit(1);
  } else {
    console.warn(`${msg} Continuing in dev — SMS / live-tracking features will not work.`);
  }
}

const app = express();

// Railway (and most hosts) put a reverse proxy in front of the app, so the real
// client IP arrives in X-Forwarded-For. Trust the first proxy hop so
// express-rate-limit keys on the actual device IP instead of lumping every
// request under the proxy's single IP (which exhausts the shared SMS limit and
// 429s /session/start for everyone).
app.set('trust proxy', 1);

// ── Security headers ──────────────────────────────────────────────────────────
// Sets X-Content-Type-Options, X-Frame-Options, Strict-Transport-Security,
// X-DNS-Prefetch-Control, and more. contentSecurityPolicy is customised to
// allow the live tracking page to load Google Maps and inline styles.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'none'"],
      styleSrc: ["'unsafe-inline'"],   // live page uses inline <style>
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'https://maps.google.com'],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,    // allow media to be fetched by Twilio
}));

// ── CORS ──────────────────────────────────────────────────────────────────────
// ALLOWED_ORIGINS is a comma-separated list of permitted origins, e.g.:
//   https://makeithome.app,https://admin.makeithome.app
// If unset, only the live tracking page (same-origin) and the mobile app
// (no Origin header) are allowed through — cross-origin browser requests
// from unknown sites are blocked.
const allowedOrigins = ALLOWED_ORIGINS
  ? ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [];

app.use(cors({
  origin(origin, callback) {
    // Mobile app requests have no Origin header — always allow.
    if (!origin) return callback(null, true);
    // Allow explicitly listed origins.
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} is not allowed.`));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'X-MIH-Key', 'X-MIH-Registration-Secret'],
}));

app.use(express.json());

// Lightweight request log — shows which endpoints devices actually reach (helps
// tell "app never called the server" apart from "server rejected the call").
app.use((req, res, next) => {
  if (req.path !== '/health') console.log(`[req] ${req.method} ${req.path} ip=${req.ip}`);
  next();
});

// Diagnostic: the app POSTs uncaught JS startup errors here so we can read the
// real error text in the server logs (a Release build otherwise just abort()s
// with no visible message). Public + unauthenticated on purpose — it only logs.
app.post('/clientlog', (req, res) => {
  const b = req.body || {};
  console.log('[clientlog] ===== CLIENT STARTUP ERROR =====');
  console.log('[clientlog] phase   =', b.phase);
  console.log('[clientlog] isFatal =', b.isFatal);
  console.log('[clientlog] name    =', b.name);
  console.log('[clientlog] message =', b.message);
  console.log('[clientlog] stack   =', b.stack);
  console.log('[clientlog] ================================');
  res.json({ ok: true });
});

// Only build the Twilio client when credentials are present. Without them the
// twilio() constructor throws, which would crash the server on boot — but in dev
// (e.g. while A2P/toll-free verification is pending) we want the server to run
// without Twilio. When null, send attempts fail gracefully (allSettled) instead
// of crashing, so /health and everything non-SMS still work.
//
// Uses an API Key (SID + secret) scoped to the account, rather than the account
// auth token — the recommended production credential (revocable, least-privilege).
const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_API_KEY_SID && TWILIO_API_KEY_SECRET
    ? twilio(TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, { accountSid: TWILIO_ACCOUNT_SID })
    : null;
if (!twilioClient) {
  console.warn('[twilio] No credentials set — SMS/MMS sending is disabled (server still runs).');
}

// ── Redis client (optional) ───────────────────────────────────────────────────
// If REDIS_URL is set, check-ins and sessions are persisted across restarts.
// If not set, falls back to in-memory Maps (fine for local dev).
let redis = null;
if (REDIS_URL) {
  redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
  redis.on('connect', () => console.log('[redis] Connected.'));
  redis.on('error', err => console.error('[redis] Error:', err.message));
  redis.connect().catch(() => {
    console.warn('[redis] Could not connect — falling back to in-memory store.');
    redis = null;
  });
}

// In production, check-in timers MUST survive restarts/redeploys — otherwise the
// "we'll alert your circle if you don't check in" promise silently breaks. Warn
// loudly at boot when Redis isn't configured in production.
if (process.env.NODE_ENV === 'production' && !REDIS_URL) {
  console.warn(
    '⚠️  FATAL for safety guarantees: Redis is NOT configured (REDIS_URL unset). ' +
    'Check-in timers live only in memory and will be LOST on the next restart/redeploy. ' +
    'Attach Redis and set REDIS_URL before serving real users.',
  );
}

const CHECKIN_PREFIX = 'checkin:';
const SESSION_PREFIX = 'session:';
const SESSION_TTL = 24 * 60 * 60; // seconds

async function redisSet(key, value, ttlSeconds) {
  if (!redis) return;
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds).catch(() => {});
}

async function redisDel(key) {
  if (!redis) return;
  await redis.del(key).catch(() => {});
}

async function redisGet(key) {
  if (!redis) return null;
  const raw = await redis.get(key).catch(() => null);
  return raw ? JSON.parse(raw) : null;
}

async function redisScanAll(pattern) {
  if (!redis) return [];
  const keys = [];
  let cursor = '0';
  do {
    const [next, found] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100).catch(() => ['0', []]);
    cursor = next;
    keys.push(...found);
  } while (cursor !== '0');
  return keys;
}

// ── Per-device token store ────────────────────────────────────────────────────
// Tokens are 256-bit random hex strings issued at device registration.
// Redis stores them with a 90-day TTL; in-memory Map is the fallback.
const TOKEN_PREFIX = 'token:';
const TOKEN_TTL = 90 * 24 * 60 * 60; // 90 days in seconds
const tokenStore = new Map(); // id → true (in-memory fallback)

async function saveToken(token, deviceId) {
  if (redis) {
    await redisSet(`${TOKEN_PREFIX}${token}`, { deviceId }, TOKEN_TTL);
  } else {
    tokenStore.set(token, deviceId);
    setTimeout(() => tokenStore.delete(token), Math.min(TOKEN_TTL * 1000, 2_147_483_647));
  }
}

async function isTokenValid(token) {
  if (redis) {
    const val = await redisGet(`${TOKEN_PREFIX}${token}`);
    return val !== null;
  }
  return tokenStore.has(token);
}

// ── Signed media tokens ───────────────────────────────────────────────────────
// Each uploaded file gets a single-use 192-bit random token embedded in its
// URL. Twilio can download without auth headers; guessing is infeasible.
// Tokens expire when the file is deleted (24 h after upload).
const MEDIA_TOKEN_PREFIX = 'mediatoken:';
const MEDIA_TOKEN_TTL = 24 * 60 * 60; // 24 hours in seconds
const mediaTokenStore = new Map(); // token → filename (in-memory fallback)

async function saveMediaToken(token, filename, ownerToken) {
  if (redis) {
    await redisSet(`${MEDIA_TOKEN_PREFIX}${token}`, { filename, ownerToken }, MEDIA_TOKEN_TTL);
  } else {
    mediaTokenStore.set(token, { filename, ownerToken });
    setTimeout(() => mediaTokenStore.delete(token), MEDIA_TOKEN_TTL * 1000);
  }
}

async function resolveMediaToken(token) {
  if (redis) {
    const val = await redisGet(`${MEDIA_TOKEN_PREFIX}${token}`);
    return val?.filename ?? null;
  }
  return mediaTokenStore.get(token)?.filename ?? null;
}

// ── Per-device safety circle ──────────────────────────────────────────────────
// The set of numbers a device is allowed to message, stored server-side at
// /circle/sync. Messaging endpoints only ever send to a device's stored circle,
// so a leaked registration secret / token can't turn the server into an open
// SMS/MMS relay to arbitrary numbers.
const CIRCLE_PREFIX = 'circle:';
const circleStore = new Map(); // token → string[] (in-memory fallback)

async function saveCircle(token, phones) {
  if (redis) {
    await redisSet(`${CIRCLE_PREFIX}${token}`, { phones }, TOKEN_TTL);
  } else {
    circleStore.set(token, phones);
  }
}

async function getCircle(token) {
  if (!token) return [];
  if (redis) {
    const val = await redisGet(`${CIRCLE_PREFIX}${token}`);
    return val?.phones ?? [];
  }
  return circleStore.get(token) ?? [];
}

// ── Per-device daily message cap ──────────────────────────────────────────────
const DAILY_CAP = 50; // messages per device per day
const msgCounts = new Map(); // `${token}:${yyyy-mm-dd}` → count (in-memory fallback)

async function incrDailyCount(token, n) {
  const key = `${token}:${new Date().toISOString().slice(0, 10)}`;
  if (redis) {
    const c = await redis.incrby(`msgcount:${key}`, n).catch(() => 0);
    if (c === n) await redis.expire(`msgcount:${key}`, 25 * 60 * 60).catch(() => {});
    return c;
  }
  const c = (msgCounts.get(key) || 0) + n;
  msgCounts.set(key, c);
  return c;
}

// Resolves the recipients for a messaging request: always the device's stored
// circle, narrowed to the intersection with client-supplied phones when given
// (but never down to zero when a circle exists). Also enforces the daily cap.
// Returns { recipients } or { status, error }.
async function recipientsFor(req, clientPhones) {
  const token = String(req.headers['x-mih-key'] || '');
  const stored = await getCircle(token);
  if (!stored.length) {
    return { status: 400, error: 'No safety circle on file for this device. Add contacts and try again.' };
  }
  let recipients = stored;
  if (Array.isArray(clientPhones) && clientPhones.length) {
    const set = new Set(stored);
    const inter = clientPhones.filter(p => set.has(p));
    if (inter.length) recipients = inter;
  }
  const count = await incrDailyCount(token, recipients.length);
  if (count > DAILY_CAP) {
    return { status: 429, error: 'Daily message limit reached for this device.' };
  }
  return { recipients };
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Panic/alert endpoints: a safety app shouldn't hard-block a user who triggers
// repeatedly, so keep this generous. Logs a line when it does reject, so a
// "can't reach server" report can be distinguished from a rate-limit.
const smsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn(`[ratelimit] 429 ${req.method} ${req.path} ip=${req.ip}`);
    res.status(429).json({ error: 'Too many requests. Please wait before trying again.' });
  },
});

// Tight limit on registration: 5 attempts per hour per IP.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many registration attempts. Try again later.' },
});

app.use('/register', registerLimiter);
app.use('/upload', smsLimiter);
app.use('/safe', smsLimiter);
app.use('/checkin/start', smsLimiter);
app.use('/session/start', smsLimiter);
app.use('/test', smsLimiter);

// ── Public static assets (legal pages + opt-in screenshots) ───────────────────
// Served from server/public with NO X-MIH-Key auth so a plain browser (and the
// carrier / A2P reviewer) can open them. Mounted before the auth middleware so
// these paths never require a token:
//   GET /privacy       → public/privacy.html
//   GET /terms         → public/terms.html
//   GET /optin-1.png … → public/optin-1.png (any file dropped into public/)
const publicDir = path.join(__dirname, 'public');
app.get('/privacy', (req, res) => res.sendFile(path.join(publicDir, 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(publicDir, 'terms.html')));
app.use(express.static(publicDir));

// ── Hosted web app (Expo web export) ──────────────────────────────────────────
// The Expo web build lives in server/web (exported with baseUrl "/app"). Serving
// it here lets anyone run the app in a browser with nothing to install — same
// origin as the API, so its fetch() calls need no CORS. Mounted before the auth
// middleware so the static assets load without a token; the app still obtains a
// per-device token via /register at runtime like the native app does.
//
// The global helmet CSP is strict (script-src 'none') for the live-tracking
// page; the SPA needs to run its own JS bundle, so relax CSP for /app responses.
const webAppDir = path.join(__dirname, 'web');
const APP_CSP =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; " +
  "font-src 'self' data:; " +
  "connect-src 'self' https://maps.google.com; " +
  "worker-src 'self' blob:; " +
  "child-src 'self' blob:";
app.use('/app', (req, res, next) => {
  res.setHeader('Content-Security-Policy', APP_CSP);
  next();
});
app.use('/app', express.static(webAppDir));
// SPA fallback: client-side routes (/app/contacts, /app/onboarding, …) that don't
// map to a real file are served the app shell so the router can handle them.
app.get(/^\/app(\/.*)?$/, (req, res) => res.sendFile(path.join(webAppDir, 'index.html')));

// ── Auth middleware ───────────────────────────────────────────────────────────
// Unauthenticated paths:
//   /health         — monitoring
//   /register       — issues tokens (guarded by REGISTRATION_SECRET)
//   /media/*        — guarded by signed per-file query token (Twilio has no X-MIH-Key)
//   /privacy /terms — public legal pages (also short-circuited by the static
//                     mount above; listed here as defense in depth)
// Everything else requires a valid per-device token in X-MIH-Key.
app.use(async (req, res, next) => {
  if (
    req.path === '/health' ||
    req.path === '/register' ||
    req.path === '/privacy' ||
    req.path === '/terms' ||
    req.path.startsWith('/media/') ||
    req.path.startsWith('/live/') ||
    req.path.startsWith('/ack/') ||
    (req.method === 'GET' && req.path.startsWith('/frame/'))
  ) return next();
  const token = req.headers['x-mih-key'];
  if (!token) return res.status(401).json({ error: 'Unauthorized.' });
  const valid = await isTokenValid(String(token));
  if (!valid) return res.status(401).json({ error: 'Unauthorized.' });
  next();
});

// ── HTML escaping ─────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// ── Phone number validation ───────────────────────────────────────────────────
// Accepts E.164 format only: + followed by 7–15 digits.
const E164_RE = /^\+[1-9]\d{6,14}$/;

function validatePhones(phones) {
  if (!Array.isArray(phones) || phones.length === 0) {
    return 'No phone numbers provided.';
  }
  const invalid = phones.filter(p => typeof p !== 'string' || !E164_RE.test(p));
  if (invalid.length > 0) {
    return `Invalid phone number(s): ${invalid.join(', ')}. Numbers must be in E.164 format (e.g. +12125551234).`;
  }
  return null; // null = valid
}

// ── Input hardening ───────────────────────────────────────────────────────────
// Coordinates: both absent is allowed (we may alert before a GPS fix). When
// present, they must be finite and in range — otherwise a caller could inject
// text/links into the SMS body via the maps URL. Returns an error string or null.
function validateCoords(latitude, longitude) {
  if (latitude == null && longitude == null) return null;
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return 'latitude/longitude must be valid numbers (lat -90..90, lon -180..180).';
  }
  return null;
}

// Clamp a timer duration to [60s, 24h]. Returns null for non-numbers / <= 0
// (a negative fired the alert immediately; a huge value overflowed setTimeout).
function clampDuration(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.max(Math.round(n), 60), 86400);
}

// Coerce to string, trim, cap at 100 chars before it's used in an SMS.
function cleanName(name) {
  return (typeof name === 'string' ? name : '').trim().slice(0, 100);
}

// ── Shared helpers ────────────────────────────────────────────────────────────
// Sends to every recipient independently so one bad number (stale entry, carrier
// reject) can't blackhole the whole alert. Returns a summary; never throws.
async function sendSmsToAll(phones, body) {
  if (!twilioClient) {
    return { sent: 0, failed: phones.length, errors: ['Twilio not configured on the server.'] };
  }
  const results = await Promise.allSettled(
    // Promise.resolve().then(...) so a SYNCHRONOUS throw from create() becomes a
    // rejected promise (caught by allSettled) instead of escaping and crashing.
    phones.map(to =>
      Promise.resolve().then(() => twilioClient.messages.create({ body, from: TWILIO_PHONE_NUMBER, to })),
    ),
  );
  const sent = results.filter(r => r.status === 'fulfilled').length;
  const errors = results
    .filter(r => r.status === 'rejected')
    .map(r => r.reason?.message || String(r.reason));
  return { sent, failed: errors.length, errors };
}

// ── Check-in timer store ──────────────────────────────────────────────────────
// In-memory Map holds the live timeout handles (can't be serialised).
// Redis holds the metadata so timers can be restored after a restart.
const checkIns = new Map(); // id → { timeout, phones, name, latitude, longitude, expiresAt }

function buildAlertBody(name, latitude, longitude) {
  const who = name?.trim() || 'Someone';
  const mapsLink =
    latitude != null && longitude != null
      ? `\n\nLast known location: https://maps.google.com/?q=${latitude},${longitude}`
      : '';
  return `🚨 EMERGENCY — ${who} missed their check-in! Open Make It Home NOW.${mapsLink} Reply STOP to opt out.`;
}

function scheduleAlert(id, entry, delayMs) {
  return setTimeout(async () => {
    checkIns.delete(id);
    await redisDel(`${CHECKIN_PREFIX}${id}`);
    const r = await sendSmsToAll(entry.phones, buildAlertBody(entry.name, entry.latitude, entry.longitude));
    console.log(`[checkin] Fired for ${id}: sent ${r.sent}/${entry.phones.length}${r.failed ? `, ${r.failed} failed` : ''}.`);
    if (r.failed) console.error(`[checkin] ${id} send errors:`, r.errors.join('; '));
  }, Math.max(delayMs, 0));
}

// ── Restore check-ins from Redis on startup ───────────────────────────────────
async function restoreCheckIns() {
  const keys = await redisScanAll(`${CHECKIN_PREFIX}*`);
  if (!keys.length) return;
  console.log(`[checkin] Restoring ${keys.length} active check-in(s) from Redis…`);
  for (const key of keys) {
    const entry = await redisGet(key);
    if (!entry) continue;
    const id = key.slice(CHECKIN_PREFIX.length);
    const delayMs = entry.expiresAt - Date.now();
    if (delayMs <= 0) {
      // Already expired while server was down — fire alert immediately
      console.log(`[checkin] ${id} expired while offline, firing now.`);
      await redisDel(key);
      sendSmsToAll(entry.phones, buildAlertBody(entry.name, entry.latitude, entry.longitude))
        .then(r => console.log(`[checkin] Late alert for ${id}: sent ${r.sent}, failed ${r.failed}.`));
      continue;
    }
    const timeout = scheduleAlert(id, entry, delayMs);
    checkIns.set(id, { ...entry, timeout });
    console.log(`[checkin] Restored ${id}, fires in ${Math.round(delayMs / 1000)}s.`);
  }
}

// ── Video storage ─────────────────────────────────────────────────────────────
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => cb(null, `${Date.now()}-recording.mp4`),
});

function videoFileFilter(req, file, cb) {
  if (file.mimetype === 'video/mp4') {
    cb(null, true);
  } else {
    cb(Object.assign(new Error('Only video/mp4 files are accepted.'), { status: 415 }), false);
  }
}

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
  fileFilter: videoFileFilter,
});

// Deletes any upload older than the media TTL. Runs at boot and hourly, so a
// restart (which loses the per-file delete-on-fetch fallback timers) can't
// strand recordings on disk forever.
// TODO (production): recordings should live in object storage (S3/R2) behind
// short-lived signed URLs, not on this container's ephemeral disk.
function sweepOldUploads() {
  const cutoff = Date.now() - MEDIA_TOKEN_TTL * 1000;
  fs.readdir(uploadDir, (err, files) => {
    if (err) return;
    for (const f of files) {
      const fp = path.join(uploadDir, f);
      fs.stat(fp, (e, st) => {
        if (!e && st.isFile() && st.mtimeMs < cutoff) fs.unlink(fp, () => {});
      });
    }
  });
}

// GET /media/:filename?token=<signed-token>
// Serves a recorded video only when the signed token matches.
// Twilio calls this URL without auth headers, so it is exempt from the
// X-MIH-Key middleware but protected by the per-file query token instead.
app.get('/media/:filename', async (req, res) => {
  const { filename } = req.params;
  const { token } = req.query;

  // Reject obviously bad filenames before touching the filesystem
  if (!filename || !/^[\w.-]+$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename.' });
  }
  if (!token || typeof token !== 'string') {
    return res.status(401).json({ error: 'Missing media token.' });
  }

  const expected = await resolveMediaToken(token);
  if (!expected || expected !== filename) {
    return res.status(403).json({ error: 'Invalid or expired media token.' });
  }

  const filePath = path.join(uploadDir, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found.' });
  }

  // Not single-use: an MMS to N contacts is N independent Twilio fetches of this
  // URL, so deleting on first fetch would 404 every recipient but the first.
  // Cleanup is the 24h token TTL + hourly sweepOldUploads().
  res.sendFile(filePath);
});

// ── POST /upload ──────────────────────────────────────────────────────────────
app.post('/upload', (req, res, next) => {
  upload.single('video')(req, res, err => {
    if (err) {
      const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400);
      return res.status(status).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file received.' });

  let phones;
  try {
    phones = JSON.parse(req.body.phones || '[]');
  } catch {
    return res.status(400).json({ error: 'phones must be a JSON array.' });
  }
  const r = await recipientsFor(req, phones);
  if (r.error) return res.status(r.status).json({ error: r.error });
  const recipients = r.recipients;
  if (!SERVER_URL) return res.status(500).json({ error: 'SERVER_URL is not configured.' });
  if (!twilioClient) return res.status(503).json({ error: 'Twilio not configured on the server.' });

  // Generate a signed token so Twilio can download the file without auth headers
  const mediaToken = crypto.randomBytes(24).toString('hex');
  await saveMediaToken(mediaToken, req.file.filename, String(req.headers['x-mih-key'] || ''));
  const mediaUrl = `${SERVER_URL}/media/${req.file.filename}?token=${mediaToken}`;
  const body = '🎥 Safety recording from your safety circle. Reply STOP to opt out.';

  const results = await Promise.allSettled(
    // Promise.resolve().then(...) so a synchronous throw can't escape allSettled.
    recipients.map(to =>
      Promise.resolve().then(() =>
        twilioClient.messages.create({ body, from: TWILIO_PHONE_NUMBER, to, mediaUrl: [mediaUrl] }),
      ),
    ),
  );
  const sent = results.filter(x => x.status === 'fulfilled').length;
  const failed = results.length - sent;
  if (sent === 0) {
    console.error('[/upload] All MMS sends failed.');
    return res.status(500).json({ error: 'Could not reach any contact.', failed });
  }
  console.log(`[/upload] Sent MMS ${sent}/${recipients.length}, ${failed} failed. Media: ${mediaUrl}`);

  // Attach the recording to its session so the responder's live page can offer a
  // "Download recording" link (the user already has a local copy in their roll).
  const sessionId = req.body.sessionId;
  if (sessionId) {
    const token = String(req.headers['x-mih-key'] || '');
    const session = await sessionGet(sessionId);
    if (session && (!session.ownerToken || session.ownerToken === token)) {
      session.recordingUrl = mediaUrl;
      await sessionSet(sessionId, session);
    }
  }

  // Cleanup is handled by delete-on-fetch (the /media route) plus the boot sweep,
  // which survive a restart — the old per-file setTimeout did not.
  res.json({ sent, failed, mediaUrl });
});

// ── POST /checkin/start ───────────────────────────────────────────────────────
app.post('/checkin/start', async (req, res) => {
  const { id, phones, name, durationSeconds, latitude, longitude } = req.body;

  if (!id) return res.status(400).json({ error: 'id is required.' });
  const dur = clampDuration(durationSeconds);
  if (dur === null) {
    return res.status(400).json({ error: 'durationSeconds must be a positive number.' });
  }
  const coordErr = validateCoords(latitude, longitude);
  if (coordErr) return res.status(400).json({ error: coordErr });
  const r = await recipientsFor(req, phones);
  if (r.error) return res.status(r.status).json({ error: r.error });
  const recipients = r.recipients;

  // Replace any existing timer for this id
  if (checkIns.has(id)) clearTimeout(checkIns.get(id).timeout);

  const expiresAt = Date.now() + dur * 1000;
  // Bind this check-in to the creating device so only it can cancel/extend it.
  const ownerToken = String(req.headers['x-mih-key'] || '');
  const entry = { phones: recipients, name: cleanName(name), latitude: latitude ?? null, longitude: longitude ?? null, expiresAt, ownerToken };

  await redisSet(`${CHECKIN_PREFIX}${id}`, entry, dur + 60); // +60s grace period
  const timeout = scheduleAlert(id, entry, dur * 1000);
  checkIns.set(id, { ...entry, timeout });

  console.log(`[/checkin/start] Started ${id}, fires in ${dur}s.`);
  res.json({ id, expiresAt });
});

// ── POST /checkin/cancel ──────────────────────────────────────────────────────
app.post('/checkin/cancel', async (req, res) => {
  const { id, notifySafe } = req.body;
  if (!id) return res.status(400).json({ error: 'id is required.' });

  const entry = checkIns.get(id);
  if (!entry) return res.status(404).json({ error: 'Check-in not found.' });
  // Only the owning device may cancel (prevents silencing someone else's alarm).
  const token = String(req.headers['x-mih-key'] || '');
  if (entry.ownerToken && entry.ownerToken !== token) {
    return res.status(403).json({ error: 'Forbidden.' });
  }

  clearTimeout(entry.timeout);
  checkIns.delete(id);
  await redisDel(`${CHECKIN_PREFIX}${id}`);
  console.log(`[/checkin/cancel] Cancelled ${id}.`);

  if (notifySafe) {
    const who = entry.name?.trim() || 'Your contact';
    const r = await sendSmsToAll(entry.phones, `✅ ${who} has checked in and is safe. Reply STOP to opt out.`);
    console.log(`[/checkin/cancel] Safe SMS: sent ${r.sent}, failed ${r.failed}.`);
  }

  res.json({ cancelled: true });
});

// ── POST /checkin/extend ──────────────────────────────────────────────────────
app.post('/checkin/extend', async (req, res) => {
  const { id, additionalSeconds } = req.body;
  if (!id) return res.status(400).json({ error: 'id is required.' });
  const add = clampDuration(additionalSeconds);
  if (add === null) {
    return res.status(400).json({ error: 'additionalSeconds must be a positive number.' });
  }

  const entry = checkIns.get(id);
  if (!entry) return res.status(404).json({ error: 'Check-in not found.' });
  // Only the owning device may extend it.
  const token = String(req.headers['x-mih-key'] || '');
  if (entry.ownerToken && entry.ownerToken !== token) {
    return res.status(403).json({ error: 'Forbidden.' });
  }

  clearTimeout(entry.timeout);

  const newExpiresAt = entry.expiresAt + add * 1000;
  const newDelay = newExpiresAt - Date.now();
  const updatedEntry = { ...entry, expiresAt: newExpiresAt };

  await redisSet(`${CHECKIN_PREFIX}${id}`, updatedEntry, Math.ceil(newDelay / 1000) + 60);
  const timeout = scheduleAlert(id, updatedEntry, newDelay);
  checkIns.set(id, { ...updatedEntry, timeout });

  console.log(`[/checkin/extend] Extended ${id} by ${additionalSeconds}s.`);
  res.json({ id, expiresAt: newExpiresAt });
});

// ── Live session tracking ─────────────────────────────────────────────────────
// Sessions are stored in Redis (with 24h TTL) when available, in-memory otherwise.
const sessionsMemory = new Map(); // fallback when Redis is not configured

// Latest live camera frame per session, for the responder's near-live view.
// Deliberately in-memory only and latest-only: frames are transient, high-churn
// (~1 every 2s), and worthless after the session ends. sessionId → { buf, at }.
const liveFrames = new Map();

async function sessionSet(sessionId, data) {
  if (redis) {
    await redisSet(`${SESSION_PREFIX}${sessionId}`, data, SESSION_TTL);
  } else {
    sessionsMemory.set(sessionId, data);
  }
}

async function sessionGet(sessionId) {
  if (redis) return redisGet(`${SESSION_PREFIX}${sessionId}`);
  return sessionsMemory.get(sessionId) ?? null;
}

async function sessionDel(sessionId) {
  if (redis) {
    await redisDel(`${SESSION_PREFIX}${sessionId}`);
  } else {
    sessionsMemory.delete(sessionId);
  }
}

// ── Staged escalation ─────────────────────────────────────────────────────────
// A session carries an ordered list of tiers, each { name, waitMinutes, phones,
// alertedAt }. Tier 0 is alerted at /session/start; a background sweep climbs to
// each later tier once (previous tier's alertedAt + waitMinutes) has elapsed and
// no one has acknowledged. A responder tapping "I'm on my way" acks the session,
// which halts the climb.
function clampWait(m) {
  const n = Number(m);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(120, Math.round(n));
}
function cleanTierName(s) {
  const t = String(s ?? '').trim().slice(0, 40);
  return t || 'Responders';
}
function sessionBody(name, liveLink) {
  const who = name ? `${name} needs help` : 'Someone needs help';
  return `🚨 EMERGENCY — ${who}! Open Make It Home NOW.\n\nTrack live: ${liveLink}\n\nReply STOP to opt out.`;
}
function sessionBodyEscalated(name, liveLink) {
  const who = name ? `${name} still needs help` : 'Someone still needs help';
  return `🚨 EMERGENCY — ${who} — no one has responded yet. Open Make It Home NOW.\n\nTrack live: ${liveLink}\n\nReply STOP to opt out.`;
}

// Validate the client's tier grouping against the device's stored circle, drop
// empty tiers, and apply the daily cap on the union. Falls back to a single
// "everyone at once" tier when no usable grouping was sent.
async function buildTiers(req, clientTiers, flatPhones) {
  const token = String(req.headers['x-mih-key'] || '');
  const stored = await getCircle(token);
  if (!stored.length) {
    return { status: 400, error: 'No safety circle on file for this device. Add contacts and try again.' };
  }
  const inCircle = new Set(stored);

  let groups;
  if (Array.isArray(clientTiers) && clientTiers.length) {
    groups = clientTiers
      .map(t => ({
        name: cleanTierName(t?.name),
        waitMinutes: clampWait(t?.waitMinutes),
        phones: Array.isArray(t?.phones) ? [...new Set(t.phones.filter(p => inCircle.has(p)))] : [],
      }))
      .filter(g => g.phones.length);
  }
  if (!groups || !groups.length) {
    let recipients = stored;
    if (Array.isArray(flatPhones) && flatPhones.length) {
      const inter = flatPhones.filter(p => inCircle.has(p));
      if (inter.length) recipients = inter;
    }
    groups = [{ name: 'Everyone', waitMinutes: 0, phones: [...new Set(recipients)] }];
  }

  const union = [...new Set(groups.flatMap(g => g.phones))];
  const count = await incrDailyCount(token, union.length);
  if (count > DAILY_CAP) {
    return { status: 429, error: 'Daily message limit reached for this device.' };
  }
  groups.forEach(g => { g.alertedAt = null; });
  return { tiers: groups };
}

// Returns [sessionId, session] for every live session (redis or in-memory).
async function allSessions() {
  const out = [];
  if (redis) {
    for (const key of await redisScanAll(`${SESSION_PREFIX}*`)) {
      const s = await redisGet(key);
      if (s) out.push([key.slice(SESSION_PREFIX.length), s]);
    }
  } else {
    for (const [sid, s] of sessionsMemory) out.push([sid, s]);
  }
  return out;
}

// One pass over live sessions, alerting the next due tier of any unacknowledged
// session. Idempotent per tier (guarded by alertedAt). Survives restarts because
// session state (including alertedAt) lives in redis.
async function escalationSweep() {
  const sessions = await allSessions();
  const now = Date.now();
  for (const [sessionId, s] of sessions) {
    if (!s || !Array.isArray(s.tiers) || s.acknowledged) continue;
    let lastAlerted = -1;
    for (let i = 0; i < s.tiers.length; i++) if (s.tiers[i].alertedAt) lastAlerted = i;
    const nextIdx = lastAlerted + 1;
    if (lastAlerted < 0 || nextIdx >= s.tiers.length) continue;
    const prev = s.tiers[lastAlerted];
    const next = s.tiers[nextIdx];
    const dueAt = (prev.alertedAt || now) + (Number(next.waitMinutes) || 0) * 60000;
    if (now < dueAt) continue;

    const liveLink = `${SERVER_URL}/live/${sessionId}`;
    const result = await sendSmsToAll(next.phones, sessionBodyEscalated(s.name, liveLink));
    next.alertedAt = Date.now();
    await sessionSet(sessionId, s);
    console.log(
      `[escalation] ${sessionId}: alerted tier ${nextIdx + 1} "${next.name}" ${result.sent}/${next.phones.length}.`,
    );
  }
}

let sweepRunning = false;
setInterval(async () => {
  // Drop live frames from sessions that ended or went quiet (>3 min stale).
  const cutoff = Date.now() - 3 * 60 * 1000;
  for (const [sid, f] of liveFrames) if (f.at < cutoff) liveFrames.delete(sid);

  if (sweepRunning) return;
  sweepRunning = true;
  try { await escalationSweep(); } catch (e) { console.error('[escalation] sweep error:', e?.message || e); }
  finally { sweepRunning = false; }
}, 15000);

// POST /session/start
app.post('/session/start', async (req, res) => {
  const { sessionId, phones, name, latitude, longitude, tiers: clientTiers } = req.body;
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required.' });
  }
  const coordErr = validateCoords(latitude, longitude);
  if (coordErr) return res.status(400).json({ error: coordErr });

  // Build validated, tier-grouped recipients (falls back to one all-at-once tier).
  const built = await buildTiers(req, clientTiers, phones);
  if (built.error) return res.status(built.status).json({ error: built.error });
  const tiers = built.tiers;
  const nm = cleanName(name);

  // Bind this session to the creating device so only it can update/end it.
  const ownerToken = String(req.headers['x-mih-key'] || '');
  const now = Date.now();
  tiers[0].alertedAt = now; // first tier is alerted immediately, below
  await sessionSet(sessionId, {
    name: nm,
    latitude: latitude ?? null,
    longitude: longitude ?? null,
    ownerToken,
    updatedAt: now,
    startedAt: now,
    tiers,
    acknowledged: false,
    ackedAt: null,
  });

  // In-memory fallback: expire after 24h
  if (!redis) setTimeout(() => sessionsMemory.delete(sessionId), SESSION_TTL * 1000);

  const liveLink = `${SERVER_URL}/live/${sessionId}`;
  const result = await sendSmsToAll(tiers[0].phones, sessionBody(nm, liveLink));
  if (result.sent === 0) {
    console.error(`[/session/start] ${sessionId} tier1 all sends failed:`, result.errors.join('; '));
    return res.status(500).json({ error: 'Could not reach any contact.', sessionId, liveLink, failed: result.failed });
  }
  console.log(
    `[/session/start] Started ${sessionId}: tier1 sent ${result.sent}/${tiers[0].phones.length}, ${result.failed} failed; ${tiers.length} tier(s).`,
  );
  res.json({ sessionId, liveLink, sent: result.sent, failed: result.failed, tiers: tiers.length });
});

// POST /session/update
app.post('/session/update', async (req, res) => {
  const { sessionId, latitude, longitude } = req.body;
  const coordErr = validateCoords(latitude, longitude);
  if (coordErr) return res.status(400).json({ error: coordErr });
  const session = await sessionGet(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  // Only the device that started the session may move its location.
  const token = String(req.headers['x-mih-key'] || '');
  if (session.ownerToken && session.ownerToken !== token) {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  await sessionSet(sessionId, { ...session, latitude: latitude ?? null, longitude: longitude ?? null, updatedAt: Date.now() });
  res.json({ ok: true });
});

// POST /session/end
app.post('/session/end', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required.' });
  // Only the owning device may end the session.
  const session = await sessionGet(sessionId);
  const token = String(req.headers['x-mih-key'] || '');
  if (session && session.ownerToken && session.ownerToken !== token) {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  await sessionDel(sessionId);
  liveFrames.delete(sessionId);
  console.log(`[/session/end] Ended session ${sessionId}.`);
  res.json({ ended: true });
});

// ── Live camera frames ────────────────────────────────────────────────────────
// The go-live device POSTs a low-res JPEG (base64 in a text/plain body) every
// ~2s; the responder's live page polls GET /frame to show a near-live view.
// Latest-only and in-memory (frames are transient). POST is owner-authenticated
// by X-MIH-Key + session owner; GET is public, guarded by the unguessable
// sessionId like the live page itself.
app.post('/frame/:sessionId', express.text({ type: '*/*', limit: '5mb' }), async (req, res) => {
  const sessionId = req.params.sessionId;
  const session = await sessionGet(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  const token = String(req.headers['x-mih-key'] || '');
  if (session.ownerToken && session.ownerToken !== token) {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  const b64 = typeof req.body === 'string' ? req.body : '';
  const buf = b64 ? Buffer.from(b64, 'base64') : Buffer.alloc(0);
  if (!buf.length || buf.length > 3 * 1024 * 1024) {
    return res.status(400).json({ error: 'Invalid frame.' });
  }
  liveFrames.set(sessionId, { buf, at: Date.now() });
  res.json({ ok: true });
});

app.get('/frame/:sessionId', (req, res) => {
  const f = liveFrames.get(req.params.sessionId);
  if (!f) return res.status(204).end();
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'no-store');
  res.send(f.buf);
});

// JSON state for the live page's polling: location, ack, recording, live frame.
app.get('/live/:sessionId/state', async (req, res) => {
  const s = await sessionGet(req.params.sessionId);
  if (!s) return res.status(404).json({ error: 'gone' });
  res.json({
    lat: s.latitude ?? null,
    lng: s.longitude ?? null,
    updatedAt: s.updatedAt ?? null,
    acknowledged: !!s.acknowledged,
    recordingUrl: s.recordingUrl || null,
    hasFrame: liveFrames.has(req.params.sessionId),
  });
});

// POST /ack/:sessionId
// A responder tapping "I'm on my way" on the live page acknowledges the session,
// which halts the escalation climb (no further tiers are alerted). Public (no
// auth) — it's reached from the live link, guarded only by knowing the
// unguessable sessionId. A POST (form submit), never a GET, so SMS/link-preview
// prefetchers can't acknowledge by accident.
app.post('/ack/:sessionId', async (req, res) => {
  const sessionId = req.params.sessionId;
  const session = await sessionGet(sessionId);
  if (session && !session.acknowledged) {
    session.acknowledged = true;
    session.ackedAt = Date.now();
    await sessionSet(sessionId, session);
    console.log(`[ack] ${sessionId} acknowledged — escalation halted.`);
  }
  res.redirect(303, `/live/${sessionId}`);
});

// GET /live/:sessionId
app.get('/live/:sessionId', async (req, res) => {
  const sessionId = req.params.sessionId;
  const session = await sessionGet(sessionId);
  if (!session) {
    return res.status(404).send(
      `<html><body style="background:#0a0a0a;color:#666;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-size:18px;">Session not found or expired.</body></html>`,
    );
  }

  const { name, latitude, longitude, updatedAt, acknowledged } = session;
  const safeName = escapeHtml(name || '');
  const displayName = safeName || 'Your contact';
  const displayTitle = safeName || 'Someone';
  const hasCoords = latitude != null && longitude != null;
  const mapsUrl = hasCoords
    ? `https://maps.google.com/?q=${encodeURIComponent(latitude)},${encodeURIComponent(longitude)}`
    : 'https://maps.google.com/';
  const ago = Math.round((Date.now() - updatedAt) / 1000);
  const agoText = ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;
  const coordsText = hasCoords
    ? `${Number(latitude).toFixed(5)}, ${Number(longitude).toFixed(5)}`
    : 'Location pending…';
  const ackPath = `/ack/${encodeURIComponent(sessionId)}`;
  const sidJson = JSON.stringify(sessionId);

  // When acknowledged, later responders see it's handled and the button is gone.
  const respondBlock = acknowledged
    ? `<div class="acked">✓ Someone is on their way</div>`
    : `<form method="POST" action="${ackPath}" style="margin-top:14px">
    <button class="ack" type="submit">I&#x27;m on my way — stop alerting others</button>
  </form>`;

  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${displayTitle} — Make It Home</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0a0a0a;color:#fff;display:flex;flex-direction:column;align-items:center;min-height:100vh;padding:24px 20px 40px;text-align:center}
    .dot{width:9px;height:9px;border-radius:50%;background:#dc2626;display:inline-block;margin-right:7px;animation:pulse 1.5s ease-in-out infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
    .live{color:#dc2626;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin:6px 0 14px;display:flex;align-items:center;justify-content:center}
    .videowrap{position:relative;width:100%;max-width:420px;aspect-ratio:3/4;background:#111;border:1px solid #222;border-radius:16px;overflow:hidden;margin-bottom:18px}
    #frame{width:100%;height:100%;object-fit:cover;display:block}
    #waiting{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#555;font-size:14px;padding:20px;text-align:center}
    .name{font-size:30px;font-weight:bold;margin-bottom:4px}
    .sub{color:#666;font-size:14px;margin-bottom:22px}
    .btn{display:inline-block;background:#dc2626;color:#fff;text-decoration:none;padding:16px 36px;border-radius:14px;font-size:17px;font-weight:bold}
    .ack{display:inline-block;background:#166534;color:#fff;border:none;padding:15px 26px;border-radius:14px;font-size:16px;font-weight:bold;cursor:pointer;line-height:1.3;max-width:320px}
    .ack:active{opacity:.85}
    .acked{margin-top:14px;color:#4ade80;font-size:16px;font-weight:700;background:rgba(22,101,52,0.18);border:1px solid #166534;padding:14px 22px;border-radius:12px}
    .dl{display:inline-block;margin-top:14px;background:#1f2937;color:#fff;text-decoration:none;padding:14px 24px;border-radius:12px;font-size:15px;font-weight:600;border:1px solid #374151}
    .meta{color:#444;font-size:11px;margin-top:22px;line-height:1.8;font-variant-numeric:tabular-nums}
  </style>
</head>
<body>
  <div class="live"><span class="dot"></span>LIVE</div>
  <div class="videowrap">
    <img id="frame" alt="">
    <div id="waiting">Waiting for live video…<br>(starts when the camera is recording)</div>
  </div>
  <div class="name">${displayName}</div>
  <div class="sub">needs help — tap to navigate</div>
  <a id="maps" class="btn" href="${mapsUrl}">Open in Maps</a>
  <div id="respond">${respondBlock}</div>
  <div id="dlwrap"></div>
  <div class="meta">
    <span id="coords">${coordsText}</span><br>
    <span id="ago">Updated ${agoText}</span> &middot; live
  </div>
  <script>
    var SID = ${sidJson};
    var img = document.getElementById('frame');
    var waiting = document.getElementById('waiting');
    img.onload = function(){ if (img.naturalWidth > 0) waiting.style.display = 'none'; };
    img.onerror = function(){ waiting.style.display = 'flex'; };
    function frameTick(){ img.src = '/frame/' + encodeURIComponent(SID) + '?t=' + Date.now(); }
    frameTick();
    setInterval(frameTick, 2000);

    function fmtAgo(ms){ var s = Math.round((Date.now() - ms) / 1000); return s < 60 ? s + 's ago' : Math.round(s/60) + 'm ago'; }
    function stateTick(){
      fetch('/live/' + encodeURIComponent(SID) + '/state').then(function(r){ return r.ok ? r.json() : null; }).then(function(s){
        if (!s) return;
        if (s.lat != null && s.lng != null){
          document.getElementById('coords').textContent = Number(s.lat).toFixed(5) + ', ' + Number(s.lng).toFixed(5);
          document.getElementById('maps').href = 'https://maps.google.com/?q=' + s.lat + ',' + s.lng;
        }
        if (s.updatedAt) document.getElementById('ago').textContent = 'Updated ' + fmtAgo(s.updatedAt);
        if (s.acknowledged) document.getElementById('respond').innerHTML = '<div class="acked">✓ Someone is on their way</div>';
        var dl = document.getElementById('dlwrap');
        if (s.recordingUrl && !dl.dataset.set){
          dl.dataset.set = '1';
          var a = document.createElement('a');
          a.className = 'dl'; a.href = s.recordingUrl; a.textContent = '⬇ Download recording';
          a.setAttribute('download', ''); a.setAttribute('target', '_blank');
          dl.appendChild(a);
        }
      }).catch(function(){});
    }
    stateTick();
    setInterval(stateTick, 5000);
  </script>
</body>
</html>`);
});

// ── POST /safe ────────────────────────────────────────────────────────────────
app.post('/safe', async (req, res) => {
  const { phones, name } = req.body;
  const r = await recipientsFor(req, phones);
  if (r.error) return res.status(r.status).json({ error: r.error });
  const recipients = r.recipients;
  const who = cleanName(name) || 'Your contact';
  const result = await sendSmsToAll(recipients, `✅ ${who} is safe — false alarm. Reply STOP to opt out.`);
  if (result.sent === 0) {
    console.error('[/safe] All sends failed:', result.errors.join('; '));
    return res.status(500).json({ error: 'Could not reach any contact.', failed: result.failed });
  }
  console.log(`[/safe] Sent ${result.sent}/${recipients.length}, ${result.failed} failed.`);
  res.json({ sent: result.sent, failed: result.failed });
});

// ── POST /test ────────────────────────────────────────────────────────────────
// Sends a clearly-labeled test message to the whole circle so a user can confirm
// their alerts actually arrive — without a real emergency. Same auth + circle
// validation as a real alert.
app.post('/test', async (req, res) => {
  const { phones, name } = req.body;
  const r = await recipientsFor(req, phones);
  if (r.error) return res.status(r.status).json({ error: r.error });
  const recipients = r.recipients;
  const who = cleanName(name) || 'Someone';
  const body = `🧪 TEST — ${who} is testing Make It Home. This is only a test, NOT a real emergency — no action needed. Reply STOP to opt out.`;
  const result = await sendSmsToAll(recipients, body);
  if (result.sent === 0) {
    console.error('[/test] All sends failed:', result.errors.join('; '));
    return res.status(500).json({ error: 'Could not reach any contact.', failed: result.failed });
  }
  console.log(`[/test] Sent ${result.sent}/${recipients.length}, ${result.failed} failed.`);
  res.json({ sent: result.sent, failed: result.failed });
});

// ── Account deletion helpers ──────────────────────────────────────────────────
async function deleteToken(token) {
  if (redis) await redisDel(`${TOKEN_PREFIX}${token}`);
  else tokenStore.delete(token);
}

async function deleteCircleFor(token) {
  if (redis) await redisDel(`${CIRCLE_PREFIX}${token}`);
  else circleStore.delete(token);
}

async function deleteSessionsOwnedBy(token) {
  if (redis) {
    for (const key of await redisScanAll(`${SESSION_PREFIX}*`)) {
      const s = await redisGet(key);
      if (s && s.ownerToken === token) await redisDel(key);
    }
  } else {
    for (const [sid, s] of sessionsMemory) {
      if (s && s.ownerToken === token) sessionsMemory.delete(sid);
    }
  }
}

async function deleteCheckInsOwnedBy(token) {
  for (const [id, entry] of checkIns) {
    if (entry.ownerToken === token) {
      clearTimeout(entry.timeout);
      checkIns.delete(id);
      await redisDel(`${CHECKIN_PREFIX}${id}`);
    }
  }
  if (redis) {
    for (const key of await redisScanAll(`${CHECKIN_PREFIX}*`)) {
      const e = await redisGet(key);
      if (e && e.ownerToken === token) await redisDel(key);
    }
  }
}

async function deleteMediaOwnedBy(token) {
  if (redis) {
    for (const key of await redisScanAll(`${MEDIA_TOKEN_PREFIX}*`)) {
      const v = await redisGet(key);
      if (v && v.ownerToken === token) {
        if (v.filename) fs.unlink(path.join(uploadDir, v.filename), () => {});
        await redisDel(key);
      }
    }
  } else {
    for (const [mt, v] of mediaTokenStore) {
      if (v && v.ownerToken === token) {
        if (v.filename) fs.unlink(path.join(uploadDir, v.filename), () => {});
        mediaTokenStore.delete(mt);
      }
    }
  }
}

// ── POST /account/delete ──────────────────────────────────────────────────────
// Purges everything tied to the calling device: its sessions, check-in timers,
// uploaded media, stored circle, and the token itself. Idempotent — after this
// the token is invalid, so a repeat call is rejected 401 by the auth middleware.
app.post('/account/delete', async (req, res) => {
  const token = String(req.headers['x-mih-key'] || '');
  await deleteSessionsOwnedBy(token);
  await deleteCheckInsOwnedBy(token);
  await deleteMediaOwnedBy(token);
  await deleteCircleFor(token);
  await deleteToken(token); // last — we needed it to find the above
  console.log('[/account/delete] Purged all data for a device.');
  res.json({ deleted: true });
});

// ── POST /circle/sync ─────────────────────────────────────────────────────────
// Stores the caller's safety circle (the numbers it's allowed to message).
// The app calls this whenever the circle changes. Accepts an empty array (the
// user removed everyone). Authenticated by X-MIH-Key via the middleware.
app.post('/circle/sync', async (req, res) => {
  const { phones } = req.body;
  if (!Array.isArray(phones)) {
    return res.status(400).json({ error: 'phones must be an array.' });
  }
  if (phones.length) {
    const phoneErr = validatePhones(phones);
    if (phoneErr) return res.status(400).json({ error: phoneErr });
  }
  const token = String(req.headers['x-mih-key'] || '');
  const unique = [...new Set(phones)];
  await saveCircle(token, unique);
  console.log(`[/circle/sync] Stored ${unique.length} number(s) for a device.`);
  res.json({ count: unique.length });
});

// ── POST /register ────────────────────────────────────────────────────────────
// Issues a per-device token. Caller must present the REGISTRATION_SECRET in
// X-MIH-Registration-Secret. Rate-limited to 5 requests/hour/IP.
app.post('/register', async (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId || typeof deviceId !== 'string' || deviceId.length > 128) {
    return res.status(400).json({ error: 'deviceId is required.' });
  }
  if (!REGISTRATION_SECRET || req.headers['x-mih-registration-secret'] !== REGISTRATION_SECRET) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  await saveToken(token, deviceId);
  console.log(`[/register] Issued token for device ${deviceId.slice(0, 8)}…`);
  res.json({ token });
});

// ── Health check ──────────────────────────────────────────────────────────────
// In production, a missing Redis is a real fault (check-in timers won't survive
// restarts), so surface it as 503 for monitors. In dev, in-memory is fine → 200.
app.get('/health', (req, res) => {
  const redisUp = !!redis;
  if (process.env.NODE_ENV === 'production' && !redisUp) {
    return res.status(503).json({ ok: false, redis: false });
  }
  res.json({ ok: true, redis: redisUp });
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Make It Home server listening on port ${PORT}`);
  sweepOldUploads();
  setInterval(sweepOldUploads, 60 * 60 * 1000); // hourly
  await restoreCheckIns();
});
