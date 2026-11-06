// Make It Home — swarm test harness.
//
// Boots the real server locally with FAKE Twilio / FAKE Expo push (test/mocks.cjs:
// nothing can ever reach a real phone or external service), then simulates dozens
// of users exercising every safety flow at once and asserts the server does the
// right thing: alerts sent exactly once, escalation on time, hijacks refused,
// rate limits + daily caps enforced, deletes purged.
//
// Run:   node test/swarm.js            (quick — ~3 minutes)
//        node test/swarm.js --full     (adds 5-min liveness + overdue-cycle tests, ~9 min)
//
// No real credentials are read or needed. Uses in-memory storage (no Redis).
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FULL = process.argv.includes('--full');
const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'swarm-test-secret-0123456789abcdef';
const SERVER_DIR = path.join(__dirname, '..');
const LOG_FILE = path.join(__dirname, 'fake-sms-log.jsonl');
const SERVER_OUT = path.join(__dirname, 'server-output.log');

// ── Fake identities ────────────────────────────────────────────────────────────
// Circle numbers: +1415 2xxxxxx — valid E.164, never real (and mocked anyway).
// Own numbers:    +1510 2xxxxxx. Failing numbers: +1999… (fake carrier reject).
const phoneFor = (i, k) => `+1415${2000000 + i * 10 + k}`;
const ownPhone = i => `+1510${2000000 + i}`;
const failPhone = k => `+1999555${1000 + k}`;
const newSid = () => 'session_' + crypto.randomBytes(16).toString('hex');

// ── HTTP + log helpers ─────────────────────────────────────────────────────────
let ipCounter = 0;
const newIp = () => `10.77.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

async function call(method, p, { token, ip, body, secret, raw } = {}) {
  const headers = { 'X-Forwarded-For': ip || '10.0.0.1' };
  if (token) headers['X-MIH-Key'] = token;
  if (secret) headers['X-MIH-Registration-Secret'] = secret;
  let payload;
  if (raw !== undefined) { headers['Content-Type'] = 'text/plain'; payload = raw; }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + p, { method, headers, body: payload, redirect: 'manual' });
  let json = null;
  const text = await res.text().catch(() => '');
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

function logEntries() {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}
const logMark = () => logEntries().length;
const since = mark => logEntries().slice(mark);
const smsTo = (list, phone) => list.filter(e => e.kind === 'sms' && e.to === phone);
const pushTo = (list, phone) => list.filter(e => e.kind === 'push');

async function waitFor(desc, pred, timeoutMs, pollMs = 1000) {
  const t0 = Date.now();
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(pollMs);
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Result collection ──────────────────────────────────────────────────────────
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`);
}

// Registers a device (own IP), optionally syncs a circle. Returns the user.
async function mkUser(i, circle) {
  const ip = newIp();
  const r = await call('POST', '/register', { ip, secret: SECRET, body: { deviceId: `swarm-device-${i}-${crypto.randomBytes(4).toString('hex')}` } });
  if (r.status !== 200 || !r.json?.token) throw new Error(`register failed for user ${i}: ${r.status} ${r.text}`);
  const u = { i, ip, token: r.json.token, circle: circle || [] };
  if (circle && circle.length) {
    const s = await call('POST', '/circle/sync', { token: u.token, ip, body: { phones: circle, name: `Swarm User ${i}` } });
    if (s.status !== 200) throw new Error(`circle sync failed for user ${i}: ${s.status} ${s.text}`);
  }
  return u;
}

// ── Scenarios ──────────────────────────────────────────────────────────────────

async function scnRegistrationAndAuth() {
  console.log('\n— Registration & auth wall —');
  const bad = await call('POST', '/register', { ip: newIp(), secret: 'wrong-secret', body: { deviceId: 'x' } });
  check('register with wrong secret is refused (401)', bad.status === 401, `got ${bad.status}`);

  const noTok = await call('GET', '/circles/mine', { ip: newIp() });
  check('request without device token is refused (401)', noTok.status === 401, `got ${noTok.status}`);
  const badTok = await call('GET', '/circles/mine', { ip: newIp(), token: 'f'.repeat(64) });
  check('request with a made-up token is refused (401)', badTok.status === 401, `got ${badTok.status}`);

  // 5 registrations per hour per IP.
  const sharedIp = newIp();
  let last = null;
  for (let n = 0; n < 6; n++) {
    last = await call('POST', '/register', { ip: sharedIp, secret: SECRET, body: { deviceId: `limit-test-${n}` } });
  }
  check('6th registration from one IP is rate-limited (429)', last.status === 429, `got ${last.status}`);
}

async function scnCircleAndIntros() {
  console.log('\n— Circle sync & intro notices —');
  const good = [phoneFor(1, 0), phoneFor(1, 1), phoneFor(1, 2)];
  const mark = logMark();
  const u = await mkUser(1, [...good, 'not-a-number', '+1415200000', good[0]]); // 2 invalid-ish + 1 dup
  const synced = await call('POST', '/circle/sync', { token: u.token, ip: u.ip, body: { phones: [...good, 'garbage', good[1]], name: 'Swarm User 1' } });
  check('sync keeps valid numbers, drops junk (not whole-array reject)', synced.json?.count === 3, `count=${synced.json?.count}`);

  // Other scenarios run concurrently — only count intros to THIS circle's numbers.
  const mine = e => e.kind === 'sms' && good.includes(e.to) && /added you to their safety circle/.test(e.body);
  const intros = await waitFor('intros', () => {
    const s = since(mark).filter(mine);
    return s.length >= 3 ? s : null;
  }, 8000);
  check('each new circle member got exactly one intro text', intros && intros.length === 3 && new Set(intros.map(e => e.to)).size === 3, `got ${intros ? intros.length : 0}`);

  const mark2 = logMark();
  await call('POST', '/circle/sync', { token: u.token, ip: u.ip, body: { phones: good, name: 'Swarm User 1' } });
  await sleep(2500);
  const re = since(mark2).filter(mine);
  check('re-sync never re-texts intros (once ever)', re.length === 0, `got ${re.length} repeats`);

  const big = Array.from({ length: 101 }, (_, k) => `+1415${3000000 + k}`);
  const over = await call('POST', '/circle/sync', { token: u.token, ip: u.ip, body: { phones: big } });
  check('circle over 100 numbers is rejected (400)', over.status === 400, `got ${over.status}`);

  // Intro throttle: 25 members → 10 intros per sync, drained over re-syncs.
  const mark3 = logMark();
  const twentyFive = Array.from({ length: 25 }, (_, k) => `+1415${4000000 + k}`);
  const u2 = await mkUser(2, twentyFive);
  const mine25 = e => e.kind === 'sms' && twentyFive.includes(e.to) && /added you/.test(e.body);
  await sleep(3500);
  const first = since(mark3).filter(mine25).length;
  check('big circle: intro notices throttled to 10 per sync', first === 10, `got ${first}`);
  const mark4 = logMark();
  await call('POST', '/circle/sync', { token: u2.token, ip: u2.ip, body: { phones: twentyFive, name: 'Swarm User 2' } });
  await sleep(3500);
  const second = since(mark4).filter(mine25).length;
  check('next sync drains the next 10 intros (no one skipped forever)', second === 10, `got ${second}`);

  return u;
}

async function scnSessionLifecycle() {
  console.log('\n— Safety session: start → ack → escalate → safe —');
  const p0 = phoneFor(5, 0), p1 = phoneFor(5, 1);
  const u = await mkUser(5, [p0, p1]);
  await sleep(2500); // let intro sends drain so they don't confuse counts
  const sid = newSid();
  const mark = logMark();

  const start = await call('POST', '/session/start', {
    token: u.token, ip: u.ip,
    body: {
      sessionId: sid, name: 'Swarm User 5', latitude: 37.77, longitude: -122.42,
      tiers: [
        { name: 'First', waitMinutes: 0, phones: [p0] },
        { name: 'Backup', waitMinutes: 1, phones: [p1] },
      ],
    },
  });
  check('session start succeeds and alerts tier 1 only', start.status === 200 && start.json?.sent === 1, `status=${start.status} sent=${start.json?.sent}`);
  const t0sms = smsTo(since(mark), p0);
  check('tier-1 contact got the "started a safety session" text', t0sms.length === 1 && /started a safety session/.test(t0sms[0].body), `got ${t0sms.length}`);
  check('tier-2 contact NOT texted yet', smsTo(since(mark), p1).length === 0);

  // Short link works
  const link = (t0sms[0] && (t0sms[0].body.match(/https?:\/\/\S+/) || [])[0]) || '';
  const code = link.split('/l/')[1];
  check('alert text carries a short live link (/l/…)', !!code, link);
  if (code) {
    const red = await call('GET', `/l/${code}`, { ip: newIp() });
    check('short link redirects to the live page', red.status === 302 && String(red.headers.get('location')).includes(sid), `status=${red.status}`);
  }
  const live = await call('GET', `/live/${sid}`, { ip: newIp() });
  check('live page loads for responders (no login needed)', live.status === 200 && /<html|<!doctype/i.test(live.text));
  const live404 = await call('GET', `/live/${'session_' + '0'.repeat(32)}`, { ip: newIp() });
  check('unknown session live page is a clean 404', live404.status === 404, `got ${live404.status}`);

  // Duplicate start (lost-response retry) must not re-text the circle.
  const mark2 = logMark();
  const dup = await call('POST', '/session/start', {
    token: u.token, ip: u.ip,
    body: { sessionId: sid, name: 'Swarm User 5', tiers: [{ name: 'First', waitMinutes: 0, phones: [p0] }] },
  });
  check('retrying the same start is idempotent (duplicate:true)', dup.status === 200 && dup.json?.duplicate === true, `status=${dup.status} dup=${dup.json?.duplicate}`);
  const dupTexts = since(mark2).filter(e => e.kind === 'sms' && (e.to === p0 || e.to === p1)).length;
  check('duplicate start sent zero extra texts to this circle', dupTexts === 0, `got ${dupTexts}`);

  // Hijack attempts by a different device.
  const attacker = await mkUser(6, [phoneFor(6, 0)]);
  const hj1 = await call('POST', '/session/update', { token: attacker.token, ip: attacker.ip, body: { sessionId: sid, latitude: 0, longitude: 0 } });
  const hj2 = await call('POST', '/session/end', { token: attacker.token, ip: attacker.ip, body: { sessionId: sid } });
  check("another device can't move or end someone's session (403)", hj1.status === 403 && hj2.status === 403, `got ${hj1.status}/${hj2.status}`);

  // Heartbeat + responder ack.
  const hb1 = await call('POST', '/session/update', { token: u.token, ip: u.ip, body: { sessionId: sid, latitude: 37.78, longitude: -122.41 } });
  check('heartbeat accepted', hb1.status === 200 && hb1.json?.ok === true);
  const mark3 = logMark();
  const ack = await call('POST', `/ack/${sid}`, { ip: newIp() });
  check('responder "I\'m on my way" accepted (public link)', ack.status === 303, `got ${ack.status}`);
  // The on-my-way notice goes to EVERY circle member (p0 and p1) — expect 2 texts, once each.
  const onwayOf = () => since(mark3).filter(e => e.kind === 'sms' && (e.to === p0 || e.to === p1) && /on their way/.test(e.body));
  const onway = await waitFor('onway', () => (onwayOf().length >= 2 ? onwayOf() : null), 6000);
  check('whole circle told "someone is on their way", once each', onway && onway.length === 2 && new Set(onway.map(e => e.to)).size === 2, `got ${onwayOf().length}`);
  await call('POST', `/ack/${sid}`, { ip: newIp() });
  await sleep(2000);
  check('second ack does not re-text the circle', onwayOf().length === 2, `got ${onwayOf().length}`);
  const hb2 = await call('POST', '/session/update', { token: u.token, ip: u.ip, body: { sessionId: sid } });
  check('user\'s app sees acknowledged=true on next heartbeat', hb2.json?.acknowledged === true);
  check('ack must NOT stop escalation (session still live)', hb2.json?.ended !== true);

  // Escalation: tier 2 fires ~60s after tier 1 (sweep runs every 15s).
  const esc = await waitFor('escalation', () => {
    const s = smsTo(since(mark), p1).filter(e => /hasn't marked themselves safe/.test(e.body));
    return s.length >= 1 ? s : null;
  }, 110000, 3000);
  check('tier 2 escalation fired on schedule (~60–75s)', !!esc, 'never fired within 110s');
  const escCount = smsTo(since(mark), p1).filter(e => /hasn't marked themselves safe/.test(e.body)).length;
  check('tier 2 fired exactly once', esc && escCount === 1, esc ? `count=${escCount}` : '');

  // Mark safe: ends ALL this device's sessions + safe text; sweep goes quiet.
  const mark4 = logMark();
  const safe = await call('POST', '/safe', { token: u.token, ip: u.ip, body: { name: 'Swarm User 5' } });
  check('marking safe succeeds and texts the circle', safe.status === 200 && safe.json?.sent >= 1, `status=${safe.status}`);
  const hb3 = await call('POST', '/session/update', { token: u.token, ip: u.ip, body: { sessionId: sid } });
  check('session reports ended after safe', hb3.json?.ended === true);
  await sleep(35000); // two sweep passes
  const extra = since(mark4).filter(e => e.kind === 'sms' && (e.to === p0 || e.to === p1) && !/is safe/.test(e.body));
  check('no further alerts after safe (sweep respects ended)', extra.length === 0, `got ${extra.length} extra`);

  // Bad inputs.
  const shortId = await call('POST', '/session/start', { token: u.token, ip: u.ip, body: { sessionId: 'tiny', phones: [p0] } });
  check('short/guessable session id rejected (400)', shortId.status === 400, `got ${shortId.status}`);
  const badCoord = await call('POST', '/session/start', { token: u.token, ip: u.ip, body: { sessionId: newSid(), latitude: 999, longitude: 0, phones: [p0] } });
  check('impossible coordinates rejected (400)', badCoord.status === 400, `got ${badCoord.status}`);
}

async function scnSessionStartTotalFailure() {
  console.log('\n— Alert failure honesty —');
  const u = await mkUser(7, [failPhone(0), failPhone(1)]);
  await sleep(1500);
  const sid = newSid();
  const r = await call('POST', '/session/start', { token: u.token, ip: u.ip, body: { sessionId: sid, name: 'Swarm User 7' } });
  check('when NO contact is reachable the app is told loudly (500)', r.status === 500 && /Could not reach/.test(r.json?.error || ''), `status=${r.status}`);
  const upd = await call('POST', '/session/update', { token: u.token, ip: u.ip, body: { sessionId: sid } });
  check('failed session is removed (retry gets a clean slate)', upd.status === 404, `got ${upd.status}`);

  // Partial failure: one good + one bad number → alert still goes out.
  const good = phoneFor(8, 0);
  const u2 = await mkUser(8, [good, failPhone(2)]);
  await sleep(1500);
  const r2 = await call('POST', '/session/start', { token: u2.token, ip: u2.ip, body: { sessionId: newSid(), name: 'Swarm User 8' } });
  check('one dead number can\'t blackhole the alert (partial send ok)', r2.status === 200 && r2.json?.sent === 1 && r2.json?.failed === 1, `status=${r2.status} sent=${r2.json?.sent} failed=${r2.json?.failed}`);
  await call('POST', '/session/end', { token: u2.token, ip: u2.ip, body: { sessionId: r2.json?.sessionId } });
}

async function scnCheckins() {
  console.log('\n— Check-in timers —');
  const p = phoneFor(10, 0);
  const u = await mkUser(10, [p]);
  await sleep(1500);

  // 1) Timer fires on time.
  const mark = logMark();
  const id1 = 'swarm-checkin-' + crypto.randomBytes(6).toString('hex');
  const st = await call('POST', '/checkin/start', { token: u.token, ip: u.ip, body: { id: id1, name: 'Swarm User 10', durationSeconds: 60, latitude: 37.7, longitude: -122.4 } });
  check('check-in starts (60s)', st.status === 200 && !!st.json?.expiresAt, `status=${st.status}`);
  const clampId = 'swarm-clamp-' + Date.now();
  const tooShort = await call('POST', '/checkin/start', { token: u.token, ip: u.ip, body: { id: clampId, durationSeconds: 5 } });
  const clampedOk = tooShort.status === 200 && (tooShort.json.expiresAt - Date.now()) > 50000;
  check('absurdly short timer clamped to a sane minimum', clampedOk, `expires in ${tooShort.json ? Math.round((tooShort.json.expiresAt - Date.now()) / 1000) : '?'}s`);
  await call('POST', '/checkin/cancel', { token: u.token, ip: u.ip, body: { id: clampId } }); // cleanup so it can't fire mid-test

  // Hijack: another device can't cancel it.
  const attacker = await mkUser(11, [phoneFor(11, 0)]);
  const hj = await call('POST', '/checkin/cancel', { token: attacker.token, ip: attacker.ip, body: { id: id1 } });
  check("another device can't cancel someone's check-in (403)", hj.status === 403, `got ${hj.status}`);

  const fired = await waitFor('checkin fire', () => {
    const s = smsTo(since(mark), p).filter(e => /did not check in|didn't check in|check on them|missed/i.test(e.body));
    return s.length ? s : null;
  }, 95000, 3000);
  check('missed check-in alert fired on deadline (~60s)', !!fired, 'no alert within 95s');

  // 2) Extend actually delays the alarm; cancel+notify texts safe and stays quiet.
  const mark2 = logMark();
  const id2 = 'swarm-checkin-' + crypto.randomBytes(6).toString('hex');
  await call('POST', '/checkin/start', { token: u.token, ip: u.ip, body: { id: id2, name: 'Swarm User 10', durationSeconds: 60 } });
  const ext = await call('POST', '/checkin/extend', { token: u.token, ip: u.ip, body: { id: id2, additionalSeconds: 3600 } });
  check('extend accepted and pushes the deadline out', ext.status === 200 && ext.json.expiresAt - Date.now() > 3_500_000, `status=${ext.status}`);
  await sleep(70000);
  check('extended check-in did NOT fire at the old deadline', smsTo(since(mark2), p).length === 0, `got ${smsTo(since(mark2), p).length} texts`);
  const cancel = await call('POST', '/checkin/cancel', { token: u.token, ip: u.ip, body: { id: id2, notifySafe: true } });
  const safeTxt = await waitFor('safe text', () => smsTo(since(mark2), p).find(e => /checked in and is safe/.test(e.body)), 6000);
  check('cancel with notify sends the "checked in, safe" text', cancel.status === 200 && !!safeTxt, `status=${cancel.status}`);
  const cancel2 = await call('POST', '/checkin/cancel', { token: u.token, ip: u.ip, body: { id: id2 } });
  check('cancelled check-in is gone (second cancel 404)', cancel2.status === 404, `got ${cancel2.status}`);
}

async function scnPushOtp() {
  console.log('\n— Phone verification (OTP) & push delivery —');
  const mePhone = ownPhone(20);
  const me = await mkUser(20, []);
  const friend = await mkUser(21, [mePhone]); // friend's circle contains MY number
  await sleep(2500);

  // Register my number for push: must require a code first.
  const mark = logMark();
  const reg = await call('POST', '/push/register', { token: me.token, ip: me.ip, body: { phone: mePhone, token: 'ExponentPushToken[swarm-user-20]' } });
  check('claiming a number requires SMS proof (pending, not instant)', reg.status === 200 && reg.json?.pending === true, `status=${reg.status}`);
  const codeSms = await waitFor('otp sms', () => smsTo(since(mark), mePhone).find(e => /Make It Home code: \d{6}/.test(e.body)), 6000);
  check('verification code texted to the claimed number', !!codeSms);
  const code = codeSms ? codeSms.body.match(/code: (\d{6})/)[1] : '000000';

  // Re-register while a code is pending → no second text.
  const mark2 = logMark();
  const re = await call('POST', '/push/register', { token: me.token, ip: me.ip, body: { phone: mePhone, token: 'ExponentPushToken[swarm-user-20]' } });
  check('relaunch while code pending does NOT text another code', re.json?.pending === true && re.json?.resent === false && smsTo(since(mark2), mePhone).length === 0);

  const wrong = await call('POST', '/push/verify', { token: me.token, ip: me.ip, body: { phone: mePhone, code: '000001' } });
  check('wrong code rejected', wrong.status === 400, `got ${wrong.status}`);
  const right = await call('POST', '/push/verify', { token: me.token, ip: me.ip, body: { phone: mePhone, code } });
  check('right code verifies the number', right.status === 200 && right.json?.verified === true, `status=${right.status}`);

  const mine = await call('GET', '/circles/mine', { token: me.token, ip: me.ip });
  check('"circles you\'re in" now answers for the verified number', mine.json?.phone === mePhone && (mine.json?.circles || []).some(c => /Swarm User 21/.test(c.name)), JSON.stringify(mine.json));

  // Alerts to my number now arrive as FREE push, not SMS.
  const mark3 = logMark();
  const t = await call('POST', '/test', { token: friend.token, ip: friend.ip, body: { name: 'Swarm User 21' } });
  const push = await waitFor('push', () => since(mark3).find(e => e.kind === 'push' && /testing Make It Home/.test(e.body)), 6000);
  check('alert to a verified app user is delivered as push (no SMS cost)', t.status === 200 && !!push, `status=${t.status}`);
  check('…and no duplicate SMS went to that number', smsTo(since(mark3), mePhone).length === 0, `got ${smsTo(since(mark3), mePhone).length}`);

  // Dead token (ticket-stage): falls back to SMS immediately and forgets the token.
  const deadPhone = ownPhone(22);
  const dead = await mkUser(22, []);
  const friend2 = await mkUser(23, [deadPhone]);
  await sleep(2500);
  const m4 = logMark();
  await call('POST', '/push/register', { token: dead.token, ip: dead.ip, body: { phone: deadPhone, token: 'ExponentPushToken[DEADdevice]' } });
  const dcodeSms = await waitFor('otp', () => smsTo(since(m4), deadPhone).find(e => /code: \d{6}/.test(e.body)), 6000);
  const dcode = dcodeSms ? dcodeSms.body.match(/code: (\d{6})/)[1] : '000000';
  await call('POST', '/push/verify', { token: dead.token, ip: dead.ip, body: { phone: deadPhone, code: dcode } });
  const m5 = logMark();
  await call('POST', '/test', { token: friend2.token, ip: friend2.ip, body: { name: 'Swarm User 23' } });
  const fellBack = await waitFor('sms fallback', () => smsTo(since(m5), deadPhone).find(e => /testing Make It Home/.test(e.body)), 8000);
  check('dead push token → alert still lands via SMS fallback', !!fellBack);
  const m6 = logMark();
  await call('POST', '/test', { token: friend2.token, ip: friend2.ip, body: { name: 'Swarm User 23' } });
  const straightSms = await waitFor('sms direct', () => smsTo(since(m6), deadPhone).find(e => /testing Make It Home/.test(e.body)), 8000);
  const rejectedAgain = since(m6).some(e => e.kind === 'push-reject');
  check('dead token forgotten: next alert goes straight to SMS', !!straightSms && !rejectedAgain, rejectedAgain ? 'push was retried' : '');

  // LATE failure (receipt stage, ~25s later): the silent-loss guard.
  const latePhone = ownPhone(24);
  const late = await mkUser(24, []);
  const friend3 = await mkUser(25, [latePhone]);
  await sleep(2500);
  const m7 = logMark();
  await call('POST', '/push/register', { token: late.token, ip: late.ip, body: { phone: latePhone, token: 'ExponentPushToken[LATEFAILdevice]' } });
  const lcodeSms = await waitFor('otp', () => smsTo(since(m7), latePhone).find(e => /code: \d{6}/.test(e.body)), 6000);
  const lcode = lcodeSms ? lcodeSms.body.match(/code: (\d{6})/)[1] : '000000';
  await call('POST', '/push/verify', { token: late.token, ip: late.ip, body: { phone: latePhone, code: lcode } });
  const m8 = logMark();
  await call('POST', '/test', { token: friend3.token, ip: friend3.ip, body: { name: 'Swarm User 25' } });
  const lateSms = await waitFor('receipt fallback', () => smsTo(since(m8), latePhone).find(e => /testing Make It Home/.test(e.body)), 70000, 3000);
  check('push accepted but never delivered → receipt check texts SMS (~25–55s)', !!lateSms, 'no fallback SMS within 70s');

  // OTP abuse: max 3 codes per number per hour, whoever asks.
  const victim = ownPhone(26);
  let lastReg = null;
  for (let n = 0; n < 4; n++) {
    const dev = await mkUser(30 + n, []);
    lastReg = await call('POST', '/push/register', { token: dev.token, ip: dev.ip, body: { phone: victim, token: `ExponentPushToken[abuse${n}]` } });
  }
  check('4th code to the same number inside an hour is refused (anti-bombing)', lastReg.status === 429, `got ${lastReg.status}`);

  // Guess limit: 6th wrong guess locked out.
  const gPhone = ownPhone(27);
  const guesser = await mkUser(34, []);
  await call('POST', '/push/register', { token: guesser.token, ip: guesser.ip, body: { phone: gPhone, token: 'ExponentPushToken[guesser]' } });
  let lastGuess = null;
  for (let n = 0; n < 6; n++) {
    lastGuess = await call('POST', '/push/verify', { token: guesser.token, ip: guesser.ip, body: { phone: gPhone, code: String(111111 + n) } });
  }
  check('code guessing locked out after 5 tries (429)', lastGuess.status === 429, `got ${lastGuess.status}`);
}

async function scnLimitsAndCap() {
  console.log('\n— Rate limits & daily SMS cap —');
  // smsLimiter: 40 requests / 15 min / device.
  const u = await mkUser(40, [phoneFor(40, 0)]);
  await sleep(1500);
  let got429 = null;
  for (let n = 0; n < 41; n++) {
    const r = await call('POST', '/test', { token: u.token, ip: u.ip, body: { name: 'Limit Tester' } });
    if (r.status === 429) { got429 = { n: n + 1, r }; break; }
  }
  check('alert-endpoint flood rate-limited (~40/15min per device)', !!got429 && got429.n === 41, got429 ? `429 at request ${got429.n}` : 'no 429 in 41 tries');

  // Daily cap: circle of 10 → each /test = 10 messages; cap 250 → blocked past 25 calls.
  const ten = Array.from({ length: 10 }, (_, k) => `+1415${5000000 + k}`);
  const u2 = await mkUser(41, ten);
  await sleep(4000); // intros (10) count toward the cap too
  let capHit = null;
  for (let n = 0; n < 30; n++) {
    const r = await call('POST', '/test', { token: u2.token, ip: u2.ip, body: { name: 'Cap Tester' } });
    if (r.status === 429 && /Daily message limit/.test(r.json?.error || '')) { capHit = n + 1; break; }
    if (r.status === 429) break; // smsLimiter would also be legitimate past 40 — shouldn't happen here
  }
  check('daily message cap enforced (device cut off near 250 msgs/day)', capHit !== null && capHit >= 20 && capHit <= 26, capHit ? `blocked at call ${capHit}` : 'never blocked in 30 calls');
}

async function scnConcurrencyBurst() {
  console.log('\n— 30 users going live at the same moment —');
  const mark = logMark();
  // Index range 100+ is reserved for this scenario — no other scenario's fake
  // numbers may overlap, or SMS-log assertions cross-contaminate.
  const users = await Promise.all(
    Array.from({ length: 30 }, (_, k) => mkUser(100 + k, [phoneFor(100 + k, 0), phoneFor(100 + k, 1)])),
  );
  await sleep(3000);
  const m2 = logMark();
  const starts = await Promise.all(
    users.map(u => call('POST', '/session/start', {
      token: u.token, ip: u.ip,
      body: { sessionId: newSid(), name: `Swarm User ${u.i}`, latitude: 37.7, longitude: -122.4 },
    })),
  );
  const okCount = starts.filter(s => s.status === 200 && s.json?.sent === 2).length;
  check('all 30 simultaneous sessions started and alerted (no drops)', okCount === 30, `${okCount}/30 ok`);

  await sleep(2000);
  const sessionTexts = since(m2).filter(e => e.kind === 'sms' && /started a safety session/.test(e.body));
  check('exactly 60 alert texts (2 per user, zero duplicates)', sessionTexts.length === 60, `got ${sessionTexts.length}`);
  let crossTalk = 0;
  for (const u of users) {
    const mine = sessionTexts.filter(e => e.to === phoneFor(u.i, 0) || e.to === phoneFor(u.i, 1));
    const nameOk = mine.every(e => e.body.includes(`Swarm User ${u.i} `) || e.body.includes(`Swarm User ${u.i}'`));
    if (mine.length !== 2 || !nameOk) crossTalk++;
  }
  check('no cross-talk: every circle only heard about ITS user', crossTalk === 0, `${crossTalk} users mismatched`);

  const health = await call('GET', '/health', { ip: newIp() });
  check('server healthy after the burst', health.status === 200 && health.json?.ok === true);

  // Clean up so the sweep doesn't escalate 30 sessions for the rest of the run.
  await Promise.all(users.map((u, k) => call('POST', '/safe', { token: u.token, ip: u.ip, body: { name: `Swarm User ${u.i}` } })));
}

async function scnAccountDelete() {
  console.log('\n— Delete my data —');
  const phone = ownPhone(60);
  const u = await mkUser(60, [phoneFor(60, 0)]);
  const watcher = await mkUser(61, [phone]);
  await sleep(2500);
  // Verify own number so there's push/ownphone data to purge.
  const m = logMark();
  await call('POST', '/push/register', { token: u.token, ip: u.ip, body: { phone, token: 'ExponentPushToken[deleteme]' } });
  const cSms = await waitFor('otp', () => smsTo(since(m), phone).find(e => /code: \d{6}/.test(e.body)), 6000);
  if (cSms) await call('POST', '/push/verify', { token: u.token, ip: u.ip, body: { phone, code: cSms.body.match(/code: (\d{6})/)[1] } });

  const del = await call('POST', '/account/delete', { token: u.token, ip: u.ip, body: {} });
  check('account delete succeeds', del.status === 200, `got ${del.status}`);
  const after = await call('GET', '/circles/mine', { token: u.token, ip: u.ip });
  check('token dead immediately after delete (401)', after.status === 401, `got ${after.status}`);

  const m2 = logMark();
  await call('POST', '/test', { token: watcher.token, ip: watcher.ip, body: { name: 'Swarm User 61' } });
  const viaSms = await waitFor('sms', () => smsTo(since(m2), phone).find(e => /testing Make It Home/.test(e.body)), 8000);
  const viaPush = since(m2).some(e => e.kind === 'push');
  check('deleted user\'s push binding purged (alerts revert to SMS)', !!viaSms && !viaPush, viaPush ? 'push still bound' : (!viaSms ? 'no SMS either' : ''));
}

async function scnLiveMedia() {
  console.log('\n— Live frames (camera fallback) —');
  const u = await mkUser(65, [phoneFor(65, 0)]);
  await sleep(1500);
  const sid = newSid();
  await call('POST', '/session/start', { token: u.token, ip: u.ip, body: { sessionId: sid, name: 'Swarm User 65' } });
  const frameB64 = Buffer.from('fake-jpeg-bytes-for-swarm-test').toString('base64');
  const post = await call('POST', `/frame/${sid}`, { token: u.token, ip: u.ip, raw: frameB64 });
  check('owner can post a live frame', post.status === 200, `got ${post.status}`);
  const attacker = await mkUser(66, [phoneFor(66, 0)]);
  const hj = await call('POST', `/frame/${sid}`, { token: attacker.token, ip: attacker.ip, raw: frameB64 });
  check("another device can't inject frames into the stream (403)", hj.status === 403, `got ${hj.status}`);
  const got = await call('GET', `/frame/${sid}`, { ip: newIp() });
  check('responder page can fetch the frame', got.status === 200 && got.text.includes('fake-jpeg-bytes'), `got ${got.status}`);
  await call('POST', '/session/end', { token: u.token, ip: u.ip, body: { sessionId: sid } });
}

// --full only: the two 5-minute clocks.
async function scnLivenessTimeout() {
  console.log('\n— [full] Liveness: killed app reads as safe after 5 min —');
  const p = phoneFor(70, 0);
  const u = await mkUser(70, [p]);
  await sleep(1500);
  const sid = newSid();
  const mark = logMark();
  await call('POST', '/session/start', { token: u.token, ip: u.ip, body: { sessionId: sid, name: 'Swarm User 70' } });
  // Heartbeat for 45s, then go silent (simulates swipe-closing the app).
  for (let n = 0; n < 3; n++) { await sleep(15000); await call('POST', '/session/update', { token: u.token, ip: u.ip, body: { sessionId: sid } }); }
  const safe = await waitFor('liveness safe', () => smsTo(since(mark), p).find(e => /is safe/.test(e.body)), 7 * 60 * 1000, 5000);
  check('5 min of silence → circle told "is safe" (app-closed rule)', !!safe, 'no safe text within 7 min of silence');
  const count = smsTo(since(mark), p).filter(e => /is safe/.test(e.body)).length;
  check('…exactly once (no repeat-text storm)', count === 1, `got ${count}`);
  const hb = await call('POST', '/session/update', { token: u.token, ip: u.ip, body: { sessionId: sid } });
  check('session reports ended to a late-returning app', hb.json?.ended === true);
}

async function scnOverdueCycle() {
  console.log('\n— [full] Overdue cycle: never stops until the user is safe —');
  const p = phoneFor(71, 0);
  const u = await mkUser(71, [p]);
  await sleep(1500);
  const sid = newSid();
  const mark = logMark();
  await call('POST', '/session/start', { token: u.token, ip: u.ip, body: { sessionId: sid, name: 'Swarm User 71' } });
  // Keep heartbeating the whole time (user alive but not marking safe).
  const hb = setInterval(() => { call('POST', '/session/update', { token: u.token, ip: u.ip, body: { sessionId: sid } }).catch(() => {}); }, 15000);
  const cycle = await waitFor('overdue cycle', () => smsTo(since(mark), p).find(e => /check-in time has passed/.test(e.body)), 7 * 60 * 1000, 5000);
  clearInterval(hb);
  check('single-tier session re-alerts the circle after ~5 min overdue', !!cycle, 'no overdue text within 7 min');
  const n = smsTo(since(mark), p).filter(e => /check-in time has passed/.test(e.body)).length;
  check('…once per 5-min cycle, not every sweep', n === 1, `got ${n} in the window`);
  await call('POST', '/safe', { token: u.token, ip: u.ip, body: { name: 'Swarm User 71' } });
}

// ── Boot + run ────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Make It Home swarm test ${FULL ? '(FULL mode, ~9 min)' : '(quick mode, ~4 min)'}`);
  console.log('All texting/push is FAKE — nothing leaves this computer.\n');

  const out = fs.createWriteStream(SERVER_OUT);
  const child = spawn(process.execPath, ['-r', path.join(__dirname, 'mocks.cjs'), 'index.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      SERVER_URL: BASE,
      REGISTRATION_SECRET: SECRET,
      TWILIO_ACCOUNT_SID: 'ACswarmfake000000000000000000000',
      TWILIO_API_KEY_SID: 'SKswarmfake000000000000000000000',
      TWILIO_API_KEY_SECRET: 'swarm-fake-secret',
      TWILIO_PHONE_NUMBER: '+15005550006',
      // Force-disable everything external (set to '' so server/.env can't re-enable).
      REDIS_URL: '',
      LIVEKIT_URL: '', LIVEKIT_API_KEY: '', LIVEKIT_API_SECRET: '',
      R2_ENDPOINT: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '', R2_BUCKET: '',
      ALLOWED_ORIGINS: '',
      MIH_FAKE_LOG: LOG_FILE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  child.on('exit', code => { if (code !== null && code !== 0) console.error(`[swarm] server exited early with code ${code} — see ${SERVER_OUT}`); });

  let up = false;
  for (let n = 0; n < 40 && !up; n++) {
    try { const r = await fetch(`${BASE}/health`); up = r.ok; } catch {}
    if (!up) await sleep(500);
  }
  if (!up) {
    console.error(`Server never came up — see ${SERVER_OUT}`);
    child.kill();
    process.exit(1);
  }
  check('server boots with no real credentials and reports healthy', true);

  const t0 = Date.now();
  try {
    await scnRegistrationAndAuth();

    // Long-clock scenarios run CONCURRENTLY with the quick ones — that's the swarm.
    const longRunners = Promise.all([
      scnSessionLifecycle(),
      scnCheckins(),
      scnPushOtp(),
      ...(FULL ? [scnLivenessTimeout(), scnOverdueCycle()] : []),
    ]);
    await scnCircleAndIntros();
    await scnSessionStartTotalFailure();
    await scnLiveMedia();
    await scnConcurrencyBurst();
    await scnLimitsAndCap();
    await longRunners;
    await scnAccountDelete();
  } catch (e) {
    check('run completed without harness crash', false, e?.message || String(e));
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);
  const totalSms = logEntries().filter(e => e.kind === 'sms').length;
  const totalPush = logEntries().filter(e => e.kind === 'push').length;
  console.log('\n══════════════════════════════════════════════════');
  console.log(`RESULT: ${passed}/${results.length} checks passed  (${Math.round((Date.now() - t0) / 1000)}s)`);
  console.log(`Simulated traffic: ${totalSms} fake SMS, ${totalPush} fake pushes — zero real messages.`);
  if (failed.length) {
    console.log('\nFAILED CHECKS:');
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    console.log(`\nServer output: ${SERVER_OUT}`);
    console.log(`Fake SMS log:  ${LOG_FILE}`);
  } else {
    console.log('All checks passed. ✅');
  }
  console.log('══════════════════════════════════════════════════');

  child.kill();
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
