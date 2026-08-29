// One-off: register recordings that finalized in R2 but never made it into
// history (the presign-expiry bug). Verifies each object exists, mints a 90d
// r2: media token, adds the history entry, and points the session at it.
// Run via `railway run`. Temporary.
const crypto = require('crypto');
const Redis = require('ioredis');
const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');

const SESSIONS = [
  'session_d16c800f84cdefa3b20d72894df96059',
  'session_47ae6cf50341055188fe1d65122f0d8d',
];
const GOLD_MEDIA_TTL = 90 * 24 * 60 * 60;

(async () => {
  const { REDIS_URL, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, SERVER_URL } = process.env;
  if (!REDIS_URL) { console.log('RESULT: no redis'); process.exit(1); }
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
  const s3 = new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  for (const sid of SESSIONS) {
    try {
      const raw = await redis.get(`session:${sid}`);
      if (!raw) { console.log(`RESULT: ${sid} — session gone from redis, skip`); continue; }
      const session = JSON.parse(raw);
      const key = `recordings/${sid}.mp4`;
      let size = null;
      try {
        const head = await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
        size = Number(head.ContentLength) || null;
      } catch {
        console.log(`RESULT: ${sid} — no object in R2, skip`);
        continue;
      }
      const token = session.ownerToken || '';
      const mediaToken = crypto.randomBytes(24).toString('hex');
      await redis.set(`mediatoken:${mediaToken}`, JSON.stringify({ filename: `r2:${key}`, ownerToken: token, expiresAt: Date.now() + GOLD_MEDIA_TTL * 1000 }), 'EX', GOLD_MEDIA_TTL);
      const url = `${SERVER_URL}/r2media/${mediaToken}`;
      // history
      const hraw = await redis.get(`history:${token}`);
      const list = hraw ? JSON.parse(hraw) : [];
      if (!list.some(e => e.id === `egress-${sid}`)) {
        list.unshift({
          id: `egress-${sid}`,
          kind: 'video',
          sessionId: sid,
          createdAt: session.endedAt || Date.now(),
          expiresAt: Date.now() + GOLD_MEDIA_TTL * 1000,
          sizeBytes: size,
          mediaUrl: url,
          latitude: session.latitude ?? null,
          longitude: session.longitude ?? null,
          durationSec: null,
        });
        await redis.set(`history:${token}`, JSON.stringify(list.slice(0, 200)), 'EX', GOLD_MEDIA_TTL);
      }
      session.recordingUrl = url;
      await redis.set(`session:${sid}`, JSON.stringify(session), 'EX', 24 * 60 * 60);
      console.log(`RESULT: ${sid} — recovered (${Math.round((size || 0) / 1e6)}MB) -> history + live page`);
    } catch (e) {
      console.log(`RESULT: ${sid} — FAILED: ${e.message}`);
    }
  }
  redis.disconnect();
})();
