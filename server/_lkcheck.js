// One-off connectivity check: proves the LiveKit credentials + URL actually
// reach LiveKit Cloud. Run via `railway run` so the env is injected. Temporary.
const { RoomServiceClient, AccessToken } = require('livekit-server-sdk');
(async () => {
  const url = process.env.LIVEKIT_URL;
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;
  if (!url || !key || !secret) {
    console.log('RESULT: missing env vars');
    process.exit(1);
  }
  // RoomServiceClient uses the https host, not wss.
  const httpUrl = url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  try {
    const svc = new RoomServiceClient(httpUrl, key, secret);
    const rooms = await svc.listRooms();
    console.log(`RESULT: OK — connected to LiveKit Cloud. Active rooms: ${rooms.length}`);
    rooms.forEach(r => console.log(`  room "${r.name}" — ${r.numParticipants} participant(s)`));
    // Also prove token minting works.
    const at = new AccessToken(key, secret, { identity: 'check' });
    at.addGrant({ room: 'check', roomJoin: true });
    const jwt = await at.toJwt();
    console.log(`RESULT: token mint OK (${jwt.length} chars)`);
  } catch (e) {
    console.log(`RESULT: FAILED — ${e.message}`);
    process.exit(2);
  }
})();
