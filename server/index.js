require('dotenv').config();

const crypto = require('crypto');
const { spawn } = require('child_process');
let LiveKit = null;
try { LiveKit = require('livekit-server-sdk'); } catch { LiveKit = null; }
// Prebuilt ffmpeg binary — Railway's build image has no system ffmpeg.
let FFMPEG_PATH = null;
try { FFMPEG_PATH = require('ffmpeg-static'); } catch { FFMPEG_PATH = null; }
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
  // LiveKit (real-time video). Optional — when unset, the app falls back to the
  // snapshot live view. LIVEKIT_URL is the wss:// project URL.
  LIVEKIT_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  // Cloudflare R2 (S3-compatible) — where LiveKit egress writes the recording of
  // a live session. Optional: without it, live sessions stream but aren't saved.
  R2_ENDPOINT,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  PORT = 3000,
} = process.env;

const LIVEKIT_ENABLED = !!(LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET);
// Recording is REMOVED (product/cost decision, Sept 2026): sessions are
// live-only — the circle watches in real time and can screen-record the live
// page for a copy. Hard-off regardless of R2 credentials so no egress compute
// or storage is ever billed. Flip back to the credential check to re-enable.
const EGRESS_ENABLED = false;

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
    // Mobile app requests have no Origin header; iOS in-app browsers (Messages
    // link previews etc.) send the literal string "null" — allow both, or the
    // live page's "I'm on my way" form 500s from inside the SMS app.
    if (!origin || origin === 'null') return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // The server's own pages (live tracking) post back to the same origin.
    try {
      if (SERVER_URL && origin === new URL(SERVER_URL).origin) return callback(null, true);
    } catch {}
    // Unknown origin: send no CORS headers (browser JS can't read the response)
    // but do NOT error the request — plain form POSTs aren't CORS-gated, and
    // throwing here turned them into "internal error" pages.
    callback(null, false);
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
  // Session lifecycle breadcrumbs (background/foreground/upload) — one line each.
  if (b.phase === 'session-trace') {
    console.log(`[trace] ${b.name || '?'} — ${b.message || ''}`);
    return res.json({ ok: true });
  }
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

// Gold "cloud recording history": recordings are kept for 90 days instead of 24h.
const GOLD_MEDIA_TTL = 90 * 24 * 60 * 60; // seconds
const HISTORY_PREFIX = 'history:';        // history:<deviceToken> → [{...}, ...] (newest first)
const HISTORY_MAX = 200;
const historyStore = new Map();           // in-memory fallback

async function saveMediaToken(token, filename, ownerToken, ttlSeconds = MEDIA_TOKEN_TTL) {
  if (redis) {
    await redisSet(`${MEDIA_TOKEN_PREFIX}${token}`, { filename, ownerToken, expiresAt: Date.now() + ttlSeconds * 1000 }, ttlSeconds);
  } else {
    mediaTokenStore.set(token, { filename, ownerToken, expiresAt: Date.now() + ttlSeconds * 1000 });
    setTimeout(() => mediaTokenStore.delete(token), ttlSeconds * 1000);
  }
}

async function getHistory(ownerToken) {
  if (redis) return (await redisGet(`${HISTORY_PREFIX}${ownerToken}`)) || [];
  return historyStore.get(ownerToken) || [];
}
async function setHistory(ownerToken, list) {
  const trimmed = list.slice(0, HISTORY_MAX);
  if (redis) await redisSet(`${HISTORY_PREFIX}${ownerToken}`, trimmed, GOLD_MEDIA_TTL);
  else historyStore.set(ownerToken, trimmed);
}
async function addHistoryEntry(ownerToken, entry) {
  const list = await getHistory(ownerToken);
  await setHistory(ownerToken, [entry, ...list.filter(e => e.id !== entry.id)]);
}

// Per-session list of uploaded segment files (video AND audio), so /merge can
// stitch each kind into ONE continuous file at session end. 24h bookkeeping.
const SESSUPLOAD_PREFIX = 'sessup:';
const sessUploadMemory = new Map();
async function sessUploadAdd(sessionId, ownerToken, filename, kind) {
  if (redis) {
    const key = `${SESSUPLOAD_PREFIX}${sessionId}`;
    const rec = (await redisGet(key)) || { ownerToken, files: [] };
    rec.files.push({ name: filename, kind });
    await redisSet(key, rec, 86400);
  } else {
    const rec = sessUploadMemory.get(sessionId) || { ownerToken, files: [] };
    rec.files.push({ name: filename, kind });
    sessUploadMemory.set(sessionId, rec);
  }
}
async function sessUploadGet(sessionId) {
  if (redis) return redisGet(`${SESSUPLOAD_PREFIX}${sessionId}`);
  return sessUploadMemory.get(sessionId) ?? null;
}
async function sessUploadDel(sessionId) {
  if (redis) await redisDel(`${SESSUPLOAD_PREFIX}${sessionId}`);
  else sessUploadMemory.delete(sessionId);
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
// Abuse guard on Twilio spend. Generous enough for heavy testing/demo days — a
// hit cap silently blocking a real alert is worse than a few dollars of SMS.
const DAILY_CAP = 250; // messages per device per day
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
// LiveKit browser SDK for the live viewer page (served from our own origin so
// the strict CSP can allow it). Long-cache — it's a versioned vendor bundle.
// Direct filesystem path — livekit-client's "exports" map blocks require.resolve
// of the dist subpath.
const LIVEKIT_UMD_PATH = path.join(__dirname, 'node_modules', 'livekit-client', 'dist', 'livekit-client.umd.js');
app.get('/livekit-client.js', (req, res) => {
  if (!fs.existsSync(LIVEKIT_UMD_PATH)) return res.status(404).send('// livekit-client not installed');
  res.set('Cache-Control', 'public, max-age=86400');
  res.type('application/javascript');
  res.sendFile(LIVEKIT_UMD_PATH);
});
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
    req.path.startsWith('/l/') ||
    req.path.startsWith('/ack/') ||
    (req.method === 'GET' && req.path.startsWith('/frame/')) ||
    (req.method === 'GET' && req.path.startsWith('/audiochunk/')) ||
    (req.method === 'GET' && req.path.startsWith('/livekit/view-token/')) ||
    (req.method === 'GET' && req.path.startsWith('/r2media/'))
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

// SMS COST NOTE (applies to every template here): carriers bill per SEGMENT —
// 160 chars for plain GSM text, but ONE emoji (or curly quote/em dash) drops
// that to 67 chars/segment. Emoji on the long alert texts made each one 4
// segments (~5c). Long templates are therefore plain GSM and kept tight; the
// short "safe" texts keep their ✅ (they fit one segment either way).
function buildAlertBody(name, latitude, longitude) {
  const who = name?.trim() || 'Someone';
  // 5 decimals ≈ 1m precision — full-precision floats waste a whole segment.
  const mapsLink =
    latitude != null && longitude != null
      ? `\nLast seen: https://maps.google.com/?q=${Number(latitude).toFixed(5)},${Number(longitude).toFixed(5)}`
      : '';
  return `Make It Home: ${who} missed their check-in. Please check on them.${mapsLink}\nReply STOP to opt out.`;
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
  // Gold uploads (query ?gold=1) get a "gold-" prefix so the sweeper keeps them
  // for the long Gold retention instead of 24h. (multer runs before body fields
  // are parsed, so the flag rides on the query string.)
  filename: (req, file, cb) => {
    const mime = String(file.mimetype || '');
    const ext = /audio/.test(mime) ? 'm4a' : mime === 'video/quicktime' ? 'mov' : 'mp4';
    cb(null, `${req.query?.gold === '1' ? 'gold-' : ''}${Date.now()}-recording.${ext}`);
  },
});

// Accepts the recorded video (mp4) and — when video can't run (e.g. the phone
// was locked mid-session) — the background audio (m4a) as fallback evidence.
// iOS records QuickTime (video/quicktime .mov) and the RN uploader sometimes
// substitutes its own mime for the declared one — so accept any video/* or
// audio/* type from our own app rather than pinning exact strings.
function videoFileFilter(req, file, cb) {
  const t = String(file.mimetype || '');
  if (t.startsWith('video/') || t.startsWith('audio/')) {
    cb(null, true);
  } else {
    cb(Object.assign(new Error(`Only video or audio files are accepted (got ${t || 'unknown'}).`), { status: 415 }), false);
  }
}

const upload = multer({
  storage,
  // Recordings are minutes long now (15-60 min sessions), so files run large.
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB
  fileFilter: videoFileFilter,
});

// Deletes any upload older than the media TTL. Runs at boot and hourly, so a
// restart (which loses the per-file delete-on-fetch fallback timers) can't
// strand recordings on disk forever.
// TODO (production): recordings should live in object storage (S3/R2) behind
// short-lived signed URLs, not on this container's ephemeral disk.
// Gold recordings are named "gold-<ts>-recording.mp4" and kept for GOLD_MEDIA_TTL;
// everything else expires at MEDIA_TOKEN_TTL.
function sweepOldUploads() {
  const now = Date.now();
  fs.readdir(uploadDir, (err, files) => {
    if (err) return;
    for (const f of files) {
      const fp = path.join(uploadDir, f);
      const ttl = f.startsWith('gold-') ? GOLD_MEDIA_TTL : MEDIA_TOKEN_TTL;
      fs.stat(fp, (e, st) => {
        if (!e && st.isFile() && st.mtimeMs < now - ttl * 1000) fs.unlink(fp, () => {});
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
      console.error(`[/upload] Rejected (${status}): ${err.message}`);
      return res.status(status).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) {
    console.error('[/upload] Rejected (400): no file in request.');
    return res.status(400).json({ error: 'No file received.' });
  }
  if (!SERVER_URL) return res.status(500).json({ error: 'SERVER_URL is not configured.' });

  const isGoldUpload = req.query?.gold === '1';
  // historyOnly = store + (Gold) add to cloud history, but DON'T MMS the circle.
  // Used for the background-audio fallback when no video was captured.
  const historyOnly = req.query?.historyOnly === '1';
  const kind = /audio/.test(req.file.mimetype) ? 'audio' : 'video';
  const ownerToken = String(req.headers['x-mih-key'] || '');

  // Signed token so the file can be fetched without auth headers (Twilio / links).
  const mediaToken = crypto.randomBytes(24).toString('hex');
  await saveMediaToken(mediaToken, req.file.filename, ownerToken, isGoldUpload ? GOLD_MEDIA_TTL : MEDIA_TOKEN_TTL);
  const mediaUrl = `${SERVER_URL}/media/${req.file.filename}?token=${mediaToken}`;

  let sent = 0, failed = 0;
  if (!historyOnly) {
    let phones;
    try {
      phones = JSON.parse(req.body.phones || '[]');
    } catch {
      return res.status(400).json({ error: 'phones must be a JSON array.' });
    }
    const r = await recipientsFor(req, phones);
    if (r.error) {
      console.error(`[/upload] Rejected (${r.status}): ${r.error}`);
      return res.status(r.status).json({ error: r.error });
    }
    const recipients = r.recipients;
    if (!twilioClient) return res.status(503).json({ error: 'Twilio not configured on the server.' });

    // Twilio caps MMS media around 5 MB. Attach small clips directly; for
    // anything bigger, text a watch/download link instead (the signed media URL
    // works in any browser).
    const attach = (req.file.size || 0) <= 4.5 * 1024 * 1024;
    const body = attach
      ? '🎥 Safety recording from your safety circle. Reply STOP to opt out.'
      : `🎥 Safety recording from your safety circle — watch or download it here: ${mediaUrl}\nReply STOP to opt out.`;
    const results = await Promise.allSettled(
      recipients.map(to =>
        Promise.resolve().then(() =>
          twilioClient.messages.create({
            body,
            from: TWILIO_PHONE_NUMBER,
            to,
            ...(attach ? { mediaUrl: [mediaUrl] } : {}),
          }),
        ),
      ),
    );
    sent = results.filter(x => x.status === 'fulfilled').length;
    failed = results.length - sent;
    if (sent === 0) {
      console.error('[/upload] All MMS sends failed.');
      return res.status(500).json({ error: 'Could not reach any contact.', failed });
    }
    console.log(`[/upload] Sent MMS ${sent}/${recipients.length}, ${failed} failed. Media: ${mediaUrl}`);
  } else {
    console.log(`[/upload] History-only ${kind} stored: ${mediaUrl}`);
  }

  // Attach the recording to its session so the responder's live page can offer a
  // "Download recording" link (the user already has a local copy in their roll).
  const sessionId = req.body.sessionId;
  let sessionMeta = null;
  if (sessionId && kind === 'video') {
    const session = await sessionGet(sessionId);
    if (session && (!session.ownerToken || session.ownerToken === ownerToken)) {
      session.recordingUrl = mediaUrl;
      await sessionSet(sessionId, session);
      sessionMeta = session;
    }
  }

  // Gold cloud history: remember this recording for the device so it can be
  // listed/downloaded/deleted later from the History screen.
  if (isGoldUpload) {
    await addHistoryEntry(ownerToken, {
      id: req.file.filename,
      kind, // 'video' | 'audio'
      sessionId: sessionId || null,
      createdAt: Date.now(),
      expiresAt: Date.now() + GOLD_MEDIA_TTL * 1000,
      sizeBytes: req.file.size || null,
      mediaUrl,
      latitude: sessionMeta?.latitude ?? (req.body.latitude != null ? Number(req.body.latitude) : null),
      longitude: sessionMeta?.longitude ?? (req.body.longitude != null ? Number(req.body.longitude) : null),
      durationSec: req.body.durationSec != null ? Number(req.body.durationSec) : null,
    });
  }

  // Track segments per session so /merge can stitch each kind into one file.
  if (sessionId) {
    await sessUploadAdd(sessionId, ownerToken, req.file.filename, kind);
  }

  res.json({ sent, failed, mediaUrl, kind });
});

// ── POST /merge ───────────────────────────────────────────────────────────────
// Stitch a session's video segments (created because iOS force-finalizes the
// movie file whenever the app is backgrounded) into ONE continuous video, so the
// user sees a single recording per session instead of a pile of clips. Uses
// ffmpeg's concat demuxer with stream copy — same device + settings, so no
// re-encode. On any failure the individual segments are simply kept.
// Concat same-codec segments with stream copy. Returns {outName, size} or null.
async function ffmpegConcat(sessionId, files, ext, gold) {
  if (!FFMPEG_PATH) {
    console.error(`[merge] ${sessionId}: ffmpeg binary unavailable.`);
    return null;
  }
  const outName = `${gold ? 'gold-' : ''}${Date.now()}-recording-full.${ext}`;
  const outPath = path.join(uploadDir, outName);
  const listPath = path.join(uploadDir, `concat-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`);
  fs.writeFileSync(listPath, files.map(f => `file '${path.join(uploadDir, f)}'`).join('\n'));
  try {
    await new Promise((resolve, reject) => {
      const p = spawn(FFMPEG_PATH, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath]);
      let err = '';
      p.stderr.on('data', d => { err += d; });
      p.on('error', reject);
      p.on('close', code => (code === 0 ? resolve(null) : reject(new Error(`ffmpeg exit ${code}: ${err.slice(-300)}`))));
    });
    fs.unlink(listPath, () => {});
    return { outName, size: fs.statSync(outPath).size };
  } catch (e) {
    fs.unlink(listPath, () => {});
    fs.unlink(outPath, () => {});
    console.error(`[merge] ${sessionId}: concat failed — keeping segments. ${e.message}`);
    return null;
  }
}

app.post('/merge', async (req, res) => {
  const { sessionId, gold: goldReq } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required.' });
  const token = String(req.headers['x-mih-key'] || '');
  const rec = await sessUploadGet(sessionId);
  if (!rec || !Array.isArray(rec.files)) return res.json({ merged: false });
  if (rec.ownerToken && rec.ownerToken !== token) return res.status(403).json({ error: 'Forbidden.' });

  // Normalize (older records stored bare filename strings = video segments).
  const entries = rec.files
    .map(f => (typeof f === 'string' ? { name: f, kind: 'video' } : f))
    .filter(f => f && /^[\w.-]+$/.test(f.name) && fs.existsSync(path.join(uploadDir, f.name)));

  // Merge one kind's segments into one file and swap the Gold-history entries.
  // Audio merges even from ONE chunk (live-audio chunk files never enter history
  // on their own — the merged file is their only route in); video needs 2+.
  const mergeKind = async kind => {
    const files = entries.filter(f => f.kind === kind).map(f => f.name);
    if (files.length < (kind === 'audio' ? 1 : 2)) return null;
    // Chunk files carry no gold- prefix, so the client states its Gold status.
    const gold = goldReq === true || files.some(f => f.startsWith('gold-'));
    const ext = kind === 'audio' ? 'm4a' : (path.extname(files[0]) || '.mov').slice(1);
    let out;
    if (files.length === 1) {
      // Single file — nothing to concat; promote it as-is.
      out = { outName: files[0], size: fs.statSync(path.join(uploadDir, files[0])).size, single: true };
    } else {
      out = await ffmpegConcat(sessionId, files, ext, gold);
      if (!out) return null;
    }
    const mediaToken = crypto.randomBytes(24).toString('hex');
    await saveMediaToken(mediaToken, out.outName, token, gold ? GOLD_MEDIA_TTL : MEDIA_TOKEN_TTL);
    const mediaUrl = `${SERVER_URL}/media/${out.outName}?token=${mediaToken}`;
    if (gold) {
      const list = await getHistory(token);
      const seg = new Set(files);
      const removed = list.filter(e => seg.has(e.id));
      const kept = list.filter(e => !seg.has(e.id));
      const first = removed[removed.length - 1] || {};
      const totalDur = removed.reduce((a, e) => a + (Number(e.durationSec) || 0), 0);
      kept.unshift({
        id: out.outName,
        kind,
        sessionId,
        createdAt: first.createdAt || Date.now(),
        expiresAt: Date.now() + GOLD_MEDIA_TTL * 1000,
        sizeBytes: out.size,
        mediaUrl,
        latitude: first.latitude ?? null,
        longitude: first.longitude ?? null,
        durationSec: totalDur || null,
      });
      await setHistory(token, kept);
    }
    if (!out.single) for (const f of files) fs.unlink(path.join(uploadDir, f), () => {});
    console.log(`[merge] ${sessionId}: ${files.length} ${kind} segment(s) -> ${out.outName} (${Math.round(out.size / 1e6)}MB)`);
    return mediaUrl;
  };

  const videoUrl = await mergeKind('video');
  const audioUrl = await mergeKind('audio');

  // Point the live page's player/download at the full video.
  if (videoUrl) {
    const session = await sessionGet(sessionId);
    if (session && (!session.ownerToken || session.ownerToken === token)) {
      session.recordingUrl = videoUrl;
      await sessionSet(sessionId, session);
    }
  }
  await sessUploadDel(sessionId);
  liveAudio.delete(sessionId);
  res.json({ merged: !!(videoUrl || audioUrl), videoUrl, audioUrl });
});

// ── POST /history/clear ───────────────────────────────────────────────────────
// Delete the calling device's ENTIRE recording history (files included).
app.post('/history/clear', async (req, res) => {
  const token = String(req.headers['x-mih-key'] || '');
  const list = await getHistory(token);
  for (const e of list) {
    if (e.id && /^[\w.-]+$/.test(e.id)) fs.unlink(path.join(uploadDir, e.id), () => {});
  }
  await setHistory(token, []);
  console.log(`[/history/clear] Removed ${list.length} entries.`);
  res.json({ ok: true, removed: list.length });
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

// Short live links: /l/<code> → /live/<sessionId>. Exists purely to keep SMS
// to one billable segment (the full Railway URL + session id is ~100 chars by
// itself). Codes carry 48 bits of randomness — unguessable like session ids.
const SHORT_PREFIX = 'short:';
const shortsMemory = new Map();
async function shortSet(code, sessionId) {
  if (redis) await redisSet(`${SHORT_PREFIX}${code}`, sessionId, SESSION_TTL);
  else shortsMemory.set(code, sessionId);
}
async function shortGet(code) {
  if (redis) return redisGet(`${SHORT_PREFIX}${code}`);
  return shortsMemory.get(code) ?? null;
}
// Prefer the short form wherever a session is linked in an SMS; sessions from
// old app builds (no shortId) keep getting the long link.
function liveLinkFor(sessionId, session) {
  return session?.shortId ? `${SERVER_URL}/l/${session.shortId}` : `${SERVER_URL}/live/${sessionId}`;
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
// each later tier on schedule, then cycles every 5 min. Only the USER marking
// safe (session.ended) stops the alerts — a responder's ack is informational.
function clampWait(m) {
  const n = Number(m);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(120, Math.round(n));
}
function cleanTierName(s) {
  const t = String(s ?? '').trim().slice(0, 40);
  return t || 'Responders';
}
// Tone: Make It Home is a digital witness, not a 911 replacement — the texts
// ask the circle to CHECK ON the user, they don't scream emergency.
function sessionBody(name, liveLink) {
  const who = name || 'Your contact';
  return `Make It Home: ${who} started a safety session. Watch live: ${liveLink}\nReply STOP to opt out.`;
}
function sessionBodyEscalated(name, liveLink) {
  const who = name || 'Your contact';
  return `${who} hasn't marked themselves safe yet - please check on them: ${liveLink}\nReply STOP to opt out.`;
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

// End every live session owned by a device. Marking `ended` (rather than
// deleting) keeps the responder's live page + recording delivery working while
// stopping ALL further alerts — scheduled rounds and the overdue cycle alike.
// Used when the user marks safe, so alerts stop even if the /session/end call
// never reached us. Only the USER's own actions route here.
async function endSessionsOwnedBy(token) {
  if (!token) return 0;
  let n = 0;
  for (const [sid, s] of await allSessions()) {
    if (s && s.ownerToken === token && !s.ended) {
      await sessionSet(sid, { ...s, ended: true, endedAt: Date.now() });
      n++;
    }
  }
  return n;
}

// One pass over live sessions, alerting the next due tier of any unacknowledged
// session. Idempotent per tier (guarded by alertedAt). Survives restarts because
// session state (including alertedAt) lives in redis.
// Merge sweep-owned progress (alertedAt / cycleAt) onto a FRESH read of the
// session before writing back. The Twilio sends take seconds; writing the stale
// pre-send object whole would silently revert anything that landed meanwhile —
// most catastrophically the user's `ended: true` (session alerts forever) or a
// location update. The sweep only ever owns its own progress fields.
async function commitSweepProgress(sessionId, mutate) {
  const fresh = await sessionGet(sessionId);
  if (!fresh) return false;
  mutate(fresh);
  await sessionSet(sessionId, fresh);
  return true;
}

async function escalationSweep() {
  const sessions = await allSessions();
  const now = Date.now();
  for (const [sessionId, s] of sessions) {
    // NOTE: a responder's "I'm on my way" (acknowledged) does NOT stop the
    // climb — only the USER ends alerts, by marking safe (which ends the
    // session). `ended` is the single off switch.
    if (!s || !Array.isArray(s.tiers) || s.ended) continue;

    // Swipe-closing the app = "I'm safe" (product decision). A killed app can
    // run no code, so this is detected by silence: the app heartbeats
    // /session/update every 15s while alive (foreground AND background), and
    // each heartbeat refreshes updatedAt. ~2 min of silence ⇒ the app was
    // closed ⇒ end the session and tell the circle the user is safe, exactly
    // as if they'd pressed the button. (Trade-off, accepted: a dead battery is
    // indistinguishable from a swipe-close and also reads as safe.)
    const lastSeen = Number(s.updatedAt || s.startedAt || 0);
    if (lastSeen && now - lastSeen > 2 * 60 * 1000) {
      const fresh = await sessionGet(sessionId);
      if (!fresh || fresh.ended) continue;
      await sessionSet(sessionId, { ...fresh, ended: true, endedAt: Date.now(), endedBy: 'app-closed' });
      liveFrames.delete(sessionId);
      const phones = [...new Set((s.tiers || []).flatMap(t => t.phones || []))];
      const nm = cleanName(s.name) || 'Your contact';
      if (phones.length && twilioClient) {
        sendSmsToAll(phones, `✅ ${nm} is safe. Reply STOP to opt out.`)
          .then(r => console.log(`[liveness] ${sessionId}: app closed — safe notice sent ${r.sent}/${phones.length}.`))
          .catch(() => {});
      }
      // Finalize the recording like a normal end would.
      if (s.livekit && EGRESS_ENABLED) {
        const coords =
          s.latitude != null && s.longitude != null
            ? { latitude: s.latitude, longitude: s.longitude }
            : null;
        stopAndRegisterEgress(sessionId, s.ownerToken, s.name, coords).catch(() => {});
      }
      console.log(`[liveness] ${sessionId}: no heartbeat for ${Math.round((now - lastSeen) / 1000)}s — ended as safe (app closed).`);
      continue;
    }

    let lastAlerted = -1;
    for (let i = 0; i < s.tiers.length; i++) if (s.tiers[i].alertedAt) lastAlerted = i;
    if (lastAlerted < 0) continue;
    const nextIdx = lastAlerted + 1;

    if (nextIdx < s.tiers.length) {
      // Still climbing the scheduled rounds (0 / ⅓ / ⅔ / 3-3 of the timer).
      const prev = s.tiers[lastAlerted];
      const next = s.tiers[nextIdx];
      const dueAt = (prev.alertedAt || now) + (Number(next.waitMinutes) || 0) * 60000;
      if (now < dueAt) continue;
      // Re-check just before sending: the user may have marked safe since the
      // batch read at the top of the sweep.
      const pre = await sessionGet(sessionId);
      if (!pre || pre.ended) continue;
      const liveLink = liveLinkFor(sessionId, s);
      const result = await sendSmsToAll(next.phones, sessionBodyEscalated(s.name, liveLink));
      const at = Date.now();
      await commitSweepProgress(sessionId, fresh => {
        if (Array.isArray(fresh.tiers) && fresh.tiers[nextIdx]) fresh.tiers[nextIdx].alertedAt = at;
      });
      console.log(
        `[escalation] ${sessionId}: alerted tier ${nextIdx + 1} "${next.name}" ${result.sent}/${next.phones.length}.`,
      );
      continue;
    }

    // All scheduled rounds fired and the user STILL hasn't marked safe: the
    // overdue cycle. Re-alert the whole circle every 5 minutes — with the live
    // link (current location + stream/recording) — forever, until the user is
    // safe. Only the user can stop this.
    const lastTier = s.tiers[s.tiers.length - 1];
    const lastAt = Number(s.cycleAt || lastTier.alertedAt || 0);
    if (!lastAt || now - lastAt < 5 * 60 * 1000) continue;
    const phones = [...new Set(s.tiers.flatMap(t => t.phones || []))];
    if (!phones.length) continue;
    const pre = await sessionGet(sessionId);
    if (!pre || pre.ended) continue;
    const liveLink = liveLinkFor(sessionId, s);
    const nm = cleanName(s.name) || 'Your contact';
    const result = await sendSmsToAll(
      phones,
      `${nm}'s check-in time has passed - please check on them: ${liveLink}\nReply STOP to opt out.`,
    );
    const at = Date.now();
    await commitSweepProgress(sessionId, fresh => { fresh.cycleAt = at; });
    console.log(`[escalation] ${sessionId}: overdue cycle alert ${result.sent}/${phones.length}.`);
  }
}

let sweepRunning = false;
setInterval(async () => {
  // Drop live frames/audio from sessions that ended or went quiet (>3 min stale).
  const cutoff = Date.now() - 3 * 60 * 1000;
  for (const [sid, f] of liveFrames) if (f.at < cutoff) liveFrames.delete(sid);
  for (const [sid, e] of liveAudio) {
    const last = e.chunks[e.chunks.length - 1];
    if (!last || last.at < cutoff) liveAudio.delete(sid);
  }

  if (sweepRunning) return;
  sweepRunning = true;
  try { await escalationSweep(); } catch (e) { console.error('[escalation] sweep error:', e?.message || e); }
  finally { sweepRunning = false; }
}, 15000);

// POST /session/start
app.post('/session/start', async (req, res) => {
  const { sessionId, phones, name, latitude, longitude, tiers: clientTiers, livekit } = req.body;
  // Strict id shape: it's embedded in SMS links and the live page's markup, so
  // never let an attacker-shaped id exist in the first place.
  if (!sessionId || !/^[\w-]{8,64}$/.test(String(sessionId))) {
    return res.status(400).json({ error: 'Valid sessionId required.' });
  }
  const coordErr = validateCoords(latitude, longitude);
  if (coordErr) return res.status(400).json({ error: coordErr });

  // Build validated, tier-grouped recipients (falls back to one all-at-once tier).
  const built = await buildTiers(req, clientTiers, phones);
  if (built.error) {
    // ALWAYS log alert rejections — a silently failing panic alert is the worst
    // possible failure mode (this exact gap hid a daily-cap outage).
    console.error(`[/session/start] REJECTED ${sessionId} (${built.status}): ${built.error}`);
    return res.status(built.status).json({ error: built.error });
  }
  const tiers = built.tiers;
  const nm = cleanName(name);

  // Bind this session to the creating device so only it can update/end it.
  const ownerToken = String(req.headers['x-mih-key'] || '');
  const now = Date.now();
  const shortId = crypto.randomBytes(6).toString('base64url'); // 8 chars, 48 bits
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
    livekit: LIVEKIT_ENABLED && livekit === true,
    shortId,
  });
  await shortSet(shortId, sessionId);

  // In-memory fallback: expire after 24h
  if (!redis) setTimeout(() => sessionsMemory.delete(sessionId), SESSION_TTL * 1000);

  const liveLink = `${SERVER_URL}/l/${shortId}`;
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
  // acknowledged lets the user's app show "someone is on their way" (it never
  // affects the alerting — that runs until the user marks safe).
  res.json({ ok: true, acknowledged: !!session.acknowledged });
});

// POST /session/end
// Marks the session ended rather than deleting it: the recording uploads +
// merge finish AFTER this call, and the circle's live page must still be able
// to receive the final video (it stays watchable/downloadable until the
// session's 24h TTL expires). Escalation stops via the `ended` flag.
app.post('/session/end', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required.' });
  // Only the owning device may end the session.
  const session = await sessionGet(sessionId);
  const token = String(req.headers['x-mih-key'] || '');
  if (session && session.ownerToken && session.ownerToken !== token) {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  if (session) {
    await sessionSet(sessionId, { ...session, ended: true, endedAt: Date.now() });
    // LiveKit session: stop recording and (async) register the finished MP4.
    if (session.livekit && EGRESS_ENABLED) {
      const coords =
        session.latitude != null && session.longitude != null
          ? { latitude: session.latitude, longitude: session.longitude }
          : null;
      stopAndRegisterEgress(sessionId, session.ownerToken, session.name, coords).catch(() => {});
    }
  }
  liveFrames.delete(sessionId);
  console.log(`[/session/end] Ended session ${sessionId} (kept for recording delivery).`);
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

// ── Live audio chunks ─────────────────────────────────────────────────────────
// The go-live device records rolling ~5s audio clips for the WHOLE session and
// POSTs each one; the live page fetches them in sequence so the responder can
// LISTEN live (a few seconds behind). Chunks are also tracked per session so
// /merge stitches them into the one full-session audio in Gold history.
const liveAudio = new Map(); // sessionId → { seq, chunks: [{seq, name, at}] }
const chunkStorage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => cb(null, `chunk-${Date.now()}-${Math.floor(Math.random() * 1e6)}.m4a`),
});
const chunkUpload = multer({
  storage: chunkStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (rq, f, cb) => cb(null, /audio|octet/.test(String(f.mimetype || ''))),
});

app.post('/audiochunk/:sessionId', chunkUpload.single('chunk'), async (req, res) => {
  const sessionId = req.params.sessionId;
  const session = await sessionGet(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  const token = String(req.headers['x-mih-key'] || '');
  if (session.ownerToken && session.ownerToken !== token) {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  if (!req.file) return res.status(400).json({ error: 'No chunk received.' });
  let entry = liveAudio.get(sessionId);
  if (!entry) {
    entry = { seq: 0, chunks: [] };
    liveAudio.set(sessionId, entry);
  }
  entry.seq += 1;
  entry.chunks.push({ seq: entry.seq, name: req.file.filename, at: Date.now() });
  while (entry.chunks.length > 24) entry.chunks.shift(); // live window ~2 min; files stay for /merge
  await sessUploadAdd(sessionId, token, req.file.filename, 'audio');
  res.json({ ok: true, seq: entry.seq });
});

// Next chunk after ?after=<seq>. Public like GET /frame — guarded by the
// unguessable session id.
app.get('/audiochunk/:sessionId', (req, res) => {
  const entry = liveAudio.get(req.params.sessionId);
  const after = Number(req.query.after || 0);
  const next = entry?.chunks.find(c => c.seq > after);
  if (!next) return res.status(204).end();
  res.set('X-Chunk-Seq', String(next.seq));
  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', 'audio/mp4');
  res.sendFile(path.join(uploadDir, next.name));
});

// ── Reverse geocoding (OpenStreetMap Nominatim, free/keyless) ────────────────
// Turns coordinates into a human address for the live page. Cached on a ~110m
// grid for 30 min so polling never hammers Nominatim (their limit is 1 req/s).
const geoCache = new Map(); // "lat,lng" 3dp → { addr, at }
async function reverseGeocode(lat, lng) {
  if (lat == null || lng == null) return null;
  const key = `${Number(lat).toFixed(3)},${Number(lng).toFixed(3)}`;
  const hit = geoCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.addr;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&zoom=17`,
      { headers: { 'User-Agent': 'MakeItHome-Safety-App/1.0' }, signal: ctrl.signal },
    );
    clearTimeout(t);
    if (!r.ok) return hit?.addr ?? null;
    const j = await r.json();
    // display_name is long ("12 Main St, Springfield, County, State, Zip, USA")
    // — keep the useful front half.
    const addr = j?.display_name ? String(j.display_name).split(',').slice(0, 4).join(',').trim() : null;
    geoCache.set(key, { addr, at: Date.now() });
    if (geoCache.size > 500) geoCache.delete(geoCache.keys().next().value);
    return addr;
  } catch {
    return hit?.addr ?? null;
  }
}

// ── LiveKit egress (recording) → Cloudflare R2 ────────────────────────────────
// A live session is recorded server-side by LiveKit egress writing an MP4 to R2.
// We start egress when the host publishes, stop it at session end, then (on a
// short poll) presign the R2 object and register it as the session's recording.
const httpLiveKitUrl = LIVEKIT_URL ? LIVEKIT_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:') : '';
let egressClient = null;
let s3Client = null;
let getSignedUrl = null;
let GetObjectCommand = null;
if (EGRESS_ENABLED && LiveKit) {
  try {
    egressClient = new LiveKit.EgressClient(httpLiveKitUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    const { S3Client, GetObjectCommand: GOC } = require('@aws-sdk/client-s3');
    ({ getSignedUrl } = require('@aws-sdk/s3-request-presigner'));
    GetObjectCommand = GOC;
    s3Client = new S3Client({
      region: 'auto',
      endpoint: R2_ENDPOINT,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    });
    console.log('[egress] enabled — recordings will be saved to R2.');
  } catch (e) {
    console.error('[egress] init failed:', e.message);
    egressClient = null;
  }
}

const EGRESS_PREFIX = 'egress:'; // egress:<sessionId> → { egressId, key }

// Start recording a live session. filename key is deterministic per session so
// we can find it in R2 afterward. Room composite = whatever the host publishes.
async function startEgress(sessionId) {
  if (!egressClient) return null;
  const key = `recordings/${sessionId}.mp4`;
  try {
    const output = new LiveKit.EncodedFileOutput({
      fileType: LiveKit.EncodedFileType.MP4,
      filepath: key,
      output: {
        case: 's3',
        value: new LiveKit.S3Upload({
          accessKey: R2_ACCESS_KEY_ID,
          secret: R2_SECRET_ACCESS_KEY,
          bucket: R2_BUCKET,
          endpoint: R2_ENDPOINT,
          region: 'auto',
          forcePathStyle: true,
        }),
      },
    });
    const info = await egressClient.startRoomCompositeEgress(sessionId, output, { layout: 'speaker' });
    const rec = { egressId: info.egressId, key };
    if (redis) await redisSet(`${EGRESS_PREFIX}${sessionId}`, rec, SESSION_TTL);
    else egressMemory.set(sessionId, rec);
    console.log(`[egress] started ${info.egressId} for ${sessionId} -> ${key}`);
    return rec;
  } catch (e) {
    console.error(`[egress] start failed for ${sessionId}: ${e.message}`);
    return null;
  }
}
const egressMemory = new Map();
async function getEgress(sessionId) {
  if (redis) return redisGet(`${EGRESS_PREFIX}${sessionId}`);
  return egressMemory.get(sessionId) ?? null;
}

// Presign a GET URL for an R2 object. S3 SigV4 caps expiry at 7 days, so these
// are SHORT-lived — long-lived access goes through /r2media/<token> below,
// which redirects to a fresh presigned URL each time.
async function presignRecording(key, expiresIn = 3600) {
  if (!s3Client || !getSignedUrl || !GetObjectCommand) return null;
  try {
    return await getSignedUrl(s3Client, new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }), {
      expiresIn,
    });
  } catch (e) {
    console.error(`[egress] presign failed: ${e.message}`);
    return null;
  }
}

// Long-lived recording access: our own signed token (90d, same store as /media)
// maps to the R2 key; each GET mints a fresh 1h presigned URL and redirects.
async function registerRecordingUrl(key, ownerToken) {
  const mediaToken = crypto.randomBytes(24).toString('hex');
  await saveMediaToken(mediaToken, `r2:${key}`, ownerToken, GOLD_MEDIA_TTL);
  return `${SERVER_URL}/r2media/${mediaToken}`;
}

// Stop egress at session end, then poll until the MP4 is finalized in R2 and
// register it as the session's recording (live page + Gold history).
async function stopAndRegisterEgress(sessionId, ownerToken, name, coords) {
  const rec = await getEgress(sessionId);
  if (!rec || !egressClient) return;
  try { await egressClient.stopEgress(rec.egressId); } catch (e) { /* may already be stopping */ }
  // Poll egress status until complete (bounded ~2 min for typical clips).
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 3000));
    let info;
    try {
      const list = await egressClient.listEgress({ egressId: rec.egressId });
      info = Array.isArray(list) ? list[0] : list;
    } catch { continue; }
    if (!info) continue;
    const status = info.status;
    // 3 = EGRESS_COMPLETE in the enum; also accept the string form.
    const done = status === 3 || status === 'EGRESS_COMPLETE';
    const failed = status === 4 || status === 5 || status === 'EGRESS_FAILED' || status === 'EGRESS_ABORTED';
    if (failed) { console.error(`[egress] ${sessionId} failed (status ${status}).`); return; }
    if (!done) continue;
    // Finalized — presign and register.
    const fileResult = info.fileResults?.[0] || info.file;
    const key = fileResult?.filename || rec.key;
    const sizeBytes = Number(fileResult?.size) || null;
    const durationSec = fileResult?.duration ? Math.round(Number(fileResult.duration) / 1e9) : null;
    const url = await registerRecordingUrl(key, ownerToken);
    if (!url) return;
    const session = await sessionGet(sessionId);
    if (session) await sessionSet(sessionId, { ...session, recordingUrl: url });
    await addHistoryEntry(ownerToken, {
      id: `egress-${sessionId}`,
      kind: 'video',
      sessionId,
      createdAt: Date.now(),
      expiresAt: Date.now() + GOLD_MEDIA_TTL * 1000,
      sizeBytes,
      mediaUrl: url,
      latitude: coords?.latitude ?? null,
      longitude: coords?.longitude ?? null,
      durationSec,
    });
    if (redis) await redisDel(`${EGRESS_PREFIX}${sessionId}`);
    else egressMemory.delete(sessionId);
    console.log(`[egress] ${sessionId} complete -> registered recording (${durationSec || '?'}s).`);
    return;
  }
  console.error(`[egress] ${sessionId} did not finalize in time.`);
}

// ── LiveKit tokens ────────────────────────────────────────────────────────────
// Mint a short-lived JWT granting access to a room named after the sessionId.
async function mintLiveKitToken(identity, room, { publish }) {
  const at = new LiveKit.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    ttl: '4h',
  });
  at.addGrant({
    room,
    roomJoin: true,
    canPublish: !!publish,
    canSubscribe: true,
    canPublishData: !!publish,
  });
  return at.toJwt();
}

// Long-lived recording link: our signed token (90d) → fresh presigned R2 URL.
// Public like /media — the unguessable token IS the auth (Twilio-less browser
// access for the circle). Guarded to recordings/ keys only.
app.get('/r2media/:token', async (req, res) => {
  const stored = await resolveMediaToken(String(req.params.token || ''));
  if (!stored || !stored.startsWith('r2:')) return res.status(404).json({ error: 'Not found or expired.' });
  const key = stored.slice(3);
  if (!key.startsWith('recordings/')) return res.status(404).json({ error: 'Not found.' });
  const url = await presignRecording(key, 3600);
  if (!url) return res.status(503).json({ error: 'Recording storage unavailable.' });
  res.redirect(302, url);
});

// The go-live phone asks for a PUBLISHER token (authenticated device). Room =
// sessionId. Returns the wss URL too so the client needs no hardcoded config.
//
// SECURITY: the sessionId is NOT secret (it's in the SMS live link), and this
// is called BEFORE /session/start creates the session — so ownership can't be
// checked against the session. Instead the FIRST caller reserves the room for
// its device token; any other device asking to publish into the same room is
// refused. The legit phone always reserves before the SMS goes out, so a
// responder can never hijack the stream.
const PUBLISHER_PREFIX = 'publisher:';
const publisherMemory = new Map();
app.post('/livekit/publish-token', async (req, res) => {
  if (!LIVEKIT_ENABLED || !LiveKit) return res.status(503).json({ error: 'LiveKit not configured.' });
  const { sessionId } = req.body || {};
  if (!sessionId || !/^[\w-]+$/.test(sessionId)) return res.status(400).json({ error: 'Valid sessionId required.' });
  const token = String(req.headers['x-mih-key'] || '');
  const claimed = redis ? await redisGet(`${PUBLISHER_PREFIX}${sessionId}`) : publisherMemory.get(sessionId);
  if (claimed && claimed !== token) {
    console.log(`[livekit] publish-token REFUSED for ${sessionId}: room already claimed by another device.`);
    return res.status(403).json({ error: 'Forbidden.' });
  }
  const session = await sessionGet(sessionId);
  if (session && ((session.ownerToken && session.ownerToken !== token) || session.ended)) {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  if (redis) await redisSet(`${PUBLISHER_PREFIX}${sessionId}`, token, SESSION_TTL);
  else publisherMemory.set(sessionId, token);
  const lkToken = await mintLiveKitToken(`host-${sessionId}`.slice(0, 60), sessionId, { publish: true });
  res.json({ url: LIVEKIT_URL, token: lkToken });
});

// The phone calls this once it has CONNECTED and started publishing, so the
// room exists when egress attaches. Authenticated (owning device only).
app.post('/livekit/start-egress', async (req, res) => {
  if (!EGRESS_ENABLED) { console.log('[egress] start-egress: not enabled'); return res.json({ recording: false }); }
  const { sessionId } = req.body || {};
  if (!sessionId || !/^[\w-]+$/.test(sessionId)) return res.status(400).json({ error: 'Valid sessionId required.' });
  const session = await sessionGet(sessionId);
  const token = String(req.headers['x-mih-key'] || '');
  if (!session) { console.log(`[egress] start-egress: session ${sessionId} not found`); return res.status(404).json({ error: 'Session not found.' }); }
  if (session.ownerToken && session.ownerToken !== token) {
    console.log(`[egress] start-egress: owner mismatch for ${sessionId}`);
    return res.status(403).json({ error: 'Forbidden.' });
  }
  if (await getEgress(sessionId)) return res.json({ recording: true }); // already recording
  const rec = await startEgress(sessionId);
  res.json({ recording: !!rec });
});

// The responder's browser gets a SUBSCRIBE-ONLY token. Public — reached from the
// live link, guarded by the unguessable sessionId (same trust model as /frame).
// A viewer can never publish. Only issued while the session exists and is live.
app.get('/livekit/view-token/:sessionId', async (req, res) => {
  if (!LIVEKIT_ENABLED || !LiveKit) return res.status(503).json({ error: 'LiveKit not configured.' });
  const sessionId = req.params.sessionId;
  const s = await sessionGet(sessionId);
  if (!s || s.ended) return res.status(404).json({ error: 'gone' });
  const viewer = `viewer-${crypto.randomBytes(6).toString('hex')}`;
  const token = await mintLiveKitToken(viewer, sessionId, { publish: false });
  res.json({ url: LIVEKIT_URL, token });
});

// JSON state for the live page's polling: location, ack, recording, live frame.
app.get('/live/:sessionId/state', async (req, res) => {
  const s = await sessionGet(req.params.sessionId);
  if (!s) return res.status(404).json({ error: 'gone' });
  res.json({
    lat: s.latitude ?? null,
    lng: s.longitude ?? null,
    address: await reverseGeocode(s.latitude, s.longitude),
    updatedAt: s.updatedAt ?? null,
    acknowledged: !!s.acknowledged,
    ended: !!s.ended,
    recordingUrl: s.recordingUrl || null,
    hasFrame: liveFrames.has(req.params.sessionId),
    // Tells the live page whether to use the WebRTC player or the snapshot feed.
    livekit: LIVEKIT_ENABLED && !!s.livekit,
  });
});

// POST /ack/:sessionId
// A responder tapping "I'm on my way" acknowledges the session — informational
// ONLY (alerts continue until the user marks safe). Public (no
// auth) — it's reached from the live link, guarded only by knowing the
// unguessable sessionId. A POST (form submit), never a GET, so SMS/link-preview
// prefetchers can't acknowledge by accident.
app.post('/ack/:sessionId', async (req, res) => {
  const sessionId = req.params.sessionId;
  const session = await sessionGet(sessionId);
  // Ended sessions are kept for recording delivery — a stale tab's "on my way"
  // must not text the whole circle about a finished session.
  if (session && !session.acknowledged && !session.ended) {
    session.acknowledged = true;
    session.ackedAt = Date.now();
    await sessionSet(sessionId, session);
    console.log(`[ack] ${sessionId} acknowledged (informational — alerts continue until the user is safe).`);
    // Tell the circle someone is heading over. Purely informational: it does
    // NOT stop the alerts — only the user marking safe does. Sent once
    // (guarded by the acknowledged flag). The user's app surfaces it too, via
    // the acknowledged flag in /session/update responses.
    const phones = [...new Set((session.tiers || []).flatMap(t => t.phones || []))];
    if (phones.length && twilioClient) {
      const nm = cleanName(session.name) || 'your contact';
      sendSmsToAll(
        phones,
        `🟢 Someone from ${nm}'s safety circle is on their way to them. Reply STOP to opt out.`,
      )
        .then(r => console.log(`[ack] ${sessionId}: on-my-way notice sent ${r.sent}/${phones.length}.`))
        .catch(() => {});
    }
  }
  res.redirect(303, `/live/${sessionId}`);
});

// GET /l/:code — short live link (SMS cost: keeps alert texts to one segment).
// 302s to the real live page; expired/unknown codes get a friendly note.
app.get('/l/:code', async (req, res) => {
  const code = String(req.params.code || '');
  if (!/^[\w-]{6,20}$/.test(code)) return res.status(404).send('Not found.');
  const sid = await shortGet(code);
  if (!sid) return res.status(404).send('This link has expired.');
  res.redirect(302, `/live/${encodeURIComponent(sid)}`);
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
  const isLiveKit = LIVEKIT_ENABLED && !!session.livekit; // real-time video session
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
  // JSON.stringify doesn't escape "</script>"; < does, defusing markup
  // breakout even if an unexpected id ever reaches this page.
  const sidJson = JSON.stringify(sessionId).replace(/</g, '\\u003c');

  // When acknowledged, later responders see it's handled and the button is gone.
  const respondBlock = session.ended
    ? `<div class="acked">Session ended</div>`
    : acknowledged
      ? `<div class="acked">✓ Someone is on their way</div>`
      : `<form method="POST" action="${ackPath}" style="margin-top:14px">
    <button class="ack" type="submit">I&#x27;m on my way</button>
  </form>`;

  // The global helmet CSP is script-src 'none' — correct for every other page,
  // but it silenced THIS page's own script (live frames, location refresh, ack
  // banner, recording player never ran). Allow exactly our inline script via a
  // per-response nonce; everything else stays locked down.
  const nonce = crypto.randomBytes(16).toString('base64');
  // LiveKit needs the signaling websocket (wss) + a web worker; the SDK is
  // served from our own origin. Only widen the policy for LiveKit sessions.
  const lkConnect = isLiveKit ? ' https://*.livekit.cloud wss://*.livekit.cloud' : '';
  const lkWorker = isLiveKit ? " worker-src 'self' blob:;" : '';
  // Egress recordings play via /r2media/<token>, which 302s to a presigned R2
  // URL — CSP checks the redirect TARGET too, so the R2 host must be allowed
  // in media-src or the inline <video> player silently fails for the circle.
  const r2Media = EGRESS_ENABLED ? ' https://*.r2.cloudflarestorage.com' : '';
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'nonce-${nonce}' 'self'; style-src 'unsafe-inline'; ` +
      `img-src 'self' data:; connect-src 'self'${lkConnect}; media-src 'self' blob:${r2Media};${lkWorker} ` +
      `frame-src 'none'; object-src 'none'`,
  );

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
    .rec{margin-top:16px;width:100%;max-width:520px;border-radius:14px;border:1px solid #374151;background:#000;display:block}
    .reclabel{margin-top:14px;color:#cbd5e1;font-size:14px;font-weight:600}
    .addr{color:#9aa4b2;font-size:13.5px;font-weight:600;margin-top:20px;max-width:360px;line-height:1.5}
    .listen{background:#1f2937;color:#fff;border:1px solid #374151;border-radius:999px;padding:11px 22px;font-size:14px;font-weight:700;cursor:pointer;margin-bottom:18px}
    .listen.on{background:rgba(22,101,52,0.25);border-color:#166534;color:#4ade80}
    .meta{color:#444;font-size:11px;margin-top:8px;line-height:1.8;font-variant-numeric:tabular-nums}
  </style>
</head>
<body>
  <div class="live" id="livehdr"><span class="dot"></span>LIVE</div>
  <div class="videowrap">
    ${isLiveKit
      ? `<video id="lkvideo" autoplay playsinline muted style="width:100%;height:100%;object-fit:cover;display:block;background:#000"></video>`
      : `<img id="frame" alt="">`}
    <div id="waiting">Connecting to the live camera…<br>${isLiveKit ? 'Tap “Unmute” below to hear live audio.' : 'The full video can be watched and downloaded here when the session ends.'}</div>
  </div>
  ${isLiveKit
    ? `<button id="lkmute" class="listen">🔊 Tap to unmute</button>`
    : `<button id="listen" class="listen">🔊 Listen live</button>`}
  <div class="name">${displayName}</div>
  <div class="sub">started a safety session — keep an eye on them</div>
  <a id="maps" class="btn" href="${mapsUrl}">Open in Maps</a>
  <div id="respond">${respondBlock}</div>
  <div id="dlwrap"></div>
  <div class="addr" id="addr"></div>
  <div class="meta">
    <span id="coords">${coordsText}</span><br>
    <span id="ago">Updated ${agoText}</span>
  </div>
  ${isLiveKit ? `<script nonce="${nonce}" src="/livekit-client.js"></script>` : ''}
  <script nonce="${nonce}">
    var SID = ${sidJson};
    var IS_LK = ${isLiveKit};
    var waiting = document.getElementById('waiting');
    var gotFrame = false;
    var isEnded = false;
    var stopMedia = function(){};

    if (IS_LK) {
      // ── Real-time WebRTC viewer (LiveKit) ──
      var video = document.getElementById('lkvideo');
      var muteBtn = document.getElementById('lkmute');
      var lkRoom = null;
      muteBtn.onclick = function(){
        video.muted = !video.muted;
        muteBtn.textContent = video.muted ? '🔊 Tap to unmute' : '🔇 Audio on (tap to mute)';
        muteBtn.classList.toggle('on', !video.muted);
        video.play().catch(function(){});
      };
      fetch('/livekit/view-token/' + encodeURIComponent(SID)).then(function(r){ return r.ok ? r.json() : null; }).then(function(cfg){
        if (!cfg || !window.LivekitClient) { waiting.textContent = 'Live stream unavailable.'; return; }
        lkRoom = new LivekitClient.Room({ adaptiveStream: true });
        lkRoom.on(LivekitClient.RoomEvent.TrackSubscribed, function(track){
          track.attach(video); // both camera + mic feed the one <video> element
          if (track.kind === 'video'){ gotFrame = true; waiting.style.display = 'none'; }
        });
        lkRoom.on(LivekitClient.RoomEvent.TrackMuted, function(){ /* host backgrounded — video freezes */ });
        lkRoom.connect(cfg.url, cfg.token).catch(function(){ waiting.textContent = 'Could not connect to the live stream.'; });
      }).catch(function(){ waiting.textContent = 'Could not connect to the live stream.'; });
      stopMedia = function(){ if (lkRoom) { try { lkRoom.disconnect(); } catch(e){} } };
    } else {
      // ── Snapshot viewer + rolling live audio ──
      var img = document.getElementById('frame');
      img.onload = function(){ if (img.naturalWidth > 0){ gotFrame = true; waiting.style.display = 'none'; } };
      img.onerror = function(){ if (!gotFrame) waiting.style.display = 'flex'; };
      var frameTimer = setInterval(function(){ if (!isEnded) img.src = '/frame/' + encodeURIComponent(SID) + '?t=' + Date.now(); }, 1200);
      img.src = '/frame/' + encodeURIComponent(SID) + '?t=' + Date.now();
      var audioSeq = 0, listening = false;
      var player = new Audio();
      var listenBtn = document.getElementById('listen');
      var pump = function(){
        if (!listening || isEnded) return;
        fetch('/audiochunk/' + encodeURIComponent(SID) + '?after=' + audioSeq).then(function(r){
          if (!r.ok || r.status === 204){ setTimeout(pump, 1200); return null; }
          audioSeq = Number(r.headers.get('X-Chunk-Seq') || (audioSeq + 1));
          return r.blob();
        }).then(function(b){
          if (!b) return;
          var url = URL.createObjectURL(b);
          player.src = url;
          player.onended = function(){ URL.revokeObjectURL(url); pump(); };
          player.play().catch(function(){ URL.revokeObjectURL(url); setTimeout(pump, 1500); });
        }).catch(function(){ setTimeout(pump, 2000); });
      };
      listenBtn.onclick = function(){
        if (listening){ listening = false; player.pause(); listenBtn.classList.remove('on'); listenBtn.textContent = '🔊 Listen live'; return; }
        listening = true; listenBtn.classList.add('on'); listenBtn.textContent = '🔊 Listening… (tap to stop)';
        pump();
      };
      stopMedia = function(){ clearInterval(frameTimer); listening = false; player.pause(); listenBtn.style.display = 'none'; };
    }

    function fmtAgo(ms){ var s = Math.round((Date.now() - ms) / 1000); return s < 60 ? s + 's ago' : Math.round(s/60) + 'm ago'; }
    function stateTick(){
      fetch('/live/' + encodeURIComponent(SID) + '/state').then(function(r){ return r.ok ? r.json() : null; }).then(function(s){
        if (!s) return;
        if (s.lat != null && s.lng != null){
          document.getElementById('coords').textContent = Number(s.lat).toFixed(5) + ', ' + Number(s.lng).toFixed(5);
          document.getElementById('maps').href = 'https://maps.google.com/?q=' + s.lat + ',' + s.lng;
        }
        if (s.address) document.getElementById('addr').textContent = '📍 ' + s.address;
        if (s.updatedAt) document.getElementById('ago').textContent = 'Updated ' + fmtAgo(s.updatedAt);
        if (s.ended && !isEnded){
          isEnded = true;
          stopMedia();
          var mb = document.getElementById('lkmute'); if (mb) mb.style.display = 'none';
          document.getElementById('livehdr').textContent = 'SESSION ENDED';
          document.getElementById('livehdr').style.color = '#9aa4b2';
          document.getElementById('respond').innerHTML = '<div class="acked">Session ended</div>';
          if (!gotFrame) waiting.innerHTML = 'Session ended. The live stream has stopped.';
        }
        if (s.acknowledged && !isEnded) document.getElementById('respond').innerHTML = '<div class="acked">✓ Someone is on their way</div>';
        var dl = document.getElementById('dlwrap');
        if (s.recordingUrl && !dl.dataset.set){
          dl.dataset.set = '1';
          // Inline player so the circle can WATCH + HEAR the recording right
          // here, plus a download link to save it.
          var lbl = document.createElement('div');
          lbl.className = 'reclabel'; lbl.textContent = 'Safety recording';
          dl.appendChild(lbl);
          var v = document.createElement('video');
          v.className = 'rec'; v.src = s.recordingUrl;
          v.setAttribute('controls', ''); v.setAttribute('playsinline', '');
          v.setAttribute('preload', 'metadata');
          dl.appendChild(v);
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
  // Marking safe MUST halt escalation, even if /session/end never reached us
  // (dropped connection, app killed). Acknowledge every session this device owns.
  const ownerToken = String(req.headers['x-mih-key'] || '');
  const halted = await endSessionsOwnedBy(ownerToken);
  if (halted) console.log(`[/safe] Halted escalation on ${halted} session(s).`);
  const r = await recipientsFor(req, phones);
  if (r.error) return res.status(r.status).json({ error: r.error });
  const recipients = r.recipients;
  const who = cleanName(name) || 'Your contact';
  const result = await sendSmsToAll(recipients, `✅ ${who} is safe. Reply STOP to opt out.`);
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
  const body = `TEST - ${who} is testing Make It Home. This is only a test, NOT a real emergency - no action needed. Reply STOP to opt out.`;
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
  // Gold history: remove entries + files.
  for (const e of await getHistory(token)) fs.unlink(path.join(uploadDir, e.id), () => {});
  if (redis) await redisDel(`${HISTORY_PREFIX}${token}`); else historyStore.delete(token);
  await deleteCircleFor(token);
  await deleteToken(token); // last — we needed it to find the above
  console.log('[/account/delete] Purged all data for a device.');
  res.json({ deleted: true });
});

// ── Gold cloud recording history ──────────────────────────────────────────────
// GET  /history          → this device's recordings (newest first), sans expired
// POST /history/delete   → { id } removes one entry + its file (user-deletable)
// Authenticated by X-MIH-Key; entries are always scoped to the calling device.
app.get('/history', async (req, res) => {
  const ownerToken = String(req.headers['x-mih-key'] || '');
  const now = Date.now();
  const list = (await getHistory(ownerToken)).filter(e => !e.expiresAt || e.expiresAt > now);
  res.json({ items: list });
});

app.post('/history/delete', async (req, res) => {
  const ownerToken = String(req.headers['x-mih-key'] || '');
  const { id } = req.body || {};
  if (!id || typeof id !== 'string' || !/^[\w.-]+$/.test(id)) {
    return res.status(400).json({ error: 'id is required.' });
  }
  const list = await getHistory(ownerToken);
  const entry = list.find(e => e.id === id);
  if (!entry) return res.status(404).json({ error: 'Not found.' });
  await setHistory(ownerToken, list.filter(e => e.id !== id));
  fs.unlink(path.join(uploadDir, id), () => {});
  console.log('[/history/delete] Removed a Gold recording for a device.');
  res.json({ deleted: true });
});

// ── Gold: nearby emergency services ───────────────────────────────────────────
// GET /nearby?lat=..&lng=..  → nearest police stations, hospitals, fire stations
// Data: OpenStreetMap via the Overpass API (free, no key, worldwide). Proxied so
// the app never talks to a third party directly, results are cached briefly, and
// coordinates are validated. "Useful data, nothing critical" — the app always
// tells users to call their local emergency number in a real emergency.
const NEARBY_CACHE = new Map(); // key → { at, data }
const NEARBY_CACHE_TTL = 10 * 60 * 1000;
const NEARBY_RADIUS_M = 8000;
// Primary + a fallback mirror. kumi.systems was dropped: it hangs on this query.
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const OVERPASS_TIMEOUT_MS = 40000;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

app.get('/nearby', async (req, res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  const coordErr = validateCoords(lat, lng);
  if (coordErr || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'lat and lng are required.' });
  }
  // Cache on a ~500m grid so nearby users share results.
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const cached = NEARBY_CACHE.get(key);
  if (cached && Date.now() - cached.at < NEARBY_CACHE_TTL) return res.json(cached.data);

  const q = `[out:json][timeout:35];
(
  nwr(around:${NEARBY_RADIUS_M},${lat},${lng})["amenity"="police"];
  nwr(around:${NEARBY_RADIUS_M},${lat},${lng})["amenity"="hospital"];
  nwr(around:${NEARBY_RADIUS_M},${lat},${lng})["amenity"="fire_station"];
);
out center tags;`;

  let json = null, lastErr = null;
  for (const url of OVERPASS_URLS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), OVERPASS_TIMEOUT_MS);
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'MakeItHome/1.0 (safety app)' },
        body: 'data=' + encodeURIComponent(q),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!r.ok) throw new Error(`Overpass HTTP ${r.status}`);
      json = await r.json();
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!json) {
    console.warn('[/nearby] Overpass unavailable:', lastErr?.message || lastErr);
    return res.status(503).json({ error: 'Nearby data is temporarily unavailable.' });
  }

  const byType = { police: [], hospital: [], fire_station: [] };
  for (const el of json.elements || []) {
    const tags = el.tags || {};
    const type = tags.amenity;
    if (!byType[type]) continue;
    const plat = el.lat ?? el.center?.lat, plng = el.lon ?? el.center?.lon;
    if (plat == null || plng == null) continue;
    const addr = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ') || tags['addr:full'] || null;
    byType[type].push({
      name: tags.name || (type === 'police' ? 'Police station' : type === 'hospital' ? 'Hospital' : 'Fire station'),
      lat: plat,
      lng: plng,
      distanceKm: Math.round(haversineKm(lat, lng, plat, plng) * 10) / 10,
      phone: tags.phone || tags['contact:phone'] || null,
      address: addr,
      emergency: tags.emergency === 'yes' || undefined,
    });
  }
  for (const k of Object.keys(byType)) {
    byType[k].sort((a, b) => a.distanceKm - b.distanceKm);
    byType[k] = byType[k].slice(0, 5);
  }
  const data = { at: Date.now(), radiusKm: NEARBY_RADIUS_M / 1000, ...byType };
  NEARBY_CACHE.set(key, { at: Date.now(), data });
  res.json(data);
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
