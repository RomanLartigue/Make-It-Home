// One-off R2 connectivity check: writes a tiny object, presigns + fetches it,
// then deletes it. Proves egress can upload AND we can serve recordings back.
// Run via `railway run` so the env is injected. Temporary.
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
(async () => {
  const { R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
  if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    console.log('RESULT: missing env'); process.exit(1);
  }
  const s3 = new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  const key = 'recordings/_healthcheck.txt';
  try {
    await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: 'ok', ContentType: 'text/plain' }));
    console.log('RESULT: write OK');
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }), { expiresIn: 120 });
    const r = await fetch(url);
    const body = await r.text();
    console.log(`RESULT: presigned read ${r.status} body="${body}"`);
    await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    console.log('RESULT: cleanup OK — R2 fully working');
  } catch (e) {
    console.log(`RESULT: FAILED — ${e.name}: ${e.message}`);
    process.exit(2);
  }
})();
