// Swarm-test service mocks. Preloaded into the server process with `node -r`.
// NEVER loaded in production — only test/swarm.js passes it on the command line.
//
// What it does:
//   1. require('twilio') returns a fake client: every "SMS" is appended to the
//      JSONL file at MIH_FAKE_LOG instead of being sent. Numbers starting with
//      +1999 simulate a carrier reject (throws), so failure paths can be tested.
//   2. global.fetch intercepts Expo's push API (fake tickets/receipts),
//      Nominatim and Overpass (canned responses). Push tokens containing DEAD
//      are rejected at the ticket stage (DeviceNotRegistered); tokens containing
//      LATEFAIL are accepted but fail at the receipt stage — exercising both
//      SMS-fallback paths.
//   3. Any OTHER non-localhost fetch is blocked and logged, guaranteeing the
//      test run can never touch a real external service.
'use strict';

const Module = require('module');
const fs = require('fs');

const LOG = process.env.MIH_FAKE_LOG;
if (!LOG) throw new Error('[mocks] MIH_FAKE_LOG must be set to a writable file path.');
fs.writeFileSync(LOG, ''); // fresh log per run

function log(entry) {
  fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), ...entry }) + '\n');
}

// ── Fake Twilio ────────────────────────────────────────────────────────────────
function fakeTwilio(_keySid, _keySecret, _opts) {
  return {
    messages: {
      create: async ({ body, from, to }) => {
        if (String(to).startsWith('+1999')) {
          log({ kind: 'sms-fail', to, body });
          throw new Error(`[fake twilio] carrier rejected ${to}`);
        }
        log({ kind: 'sms', to, from, body });
        return { sid: 'SMfake' + Math.random().toString(36).slice(2) };
      },
    },
  };
}

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'twilio') return fakeTwilio;
  return origLoad.apply(this, arguments);
};

// ── Fake fetch (Expo push, geocoding) + external-network block ────────────────
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);

  if (u.startsWith('https://exp.host/--/api/v2/push/send')) {
    let msgs = [];
    try { msgs = JSON.parse(opts.body); } catch {}
    const data = msgs.map(m => {
      if (String(m.to).includes('DEAD')) {
        log({ kind: 'push-reject', to: m.to, body: m.body });
        return { status: 'error', message: 'device not registered', details: { error: 'DeviceNotRegistered' } };
      }
      const id = 'receipt-' + Math.random().toString(36).slice(2);
      log({ kind: 'push', to: m.to, title: m.title, body: m.body, data: m.data, id });
      return { status: 'ok', id };
    });
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (u.startsWith('https://exp.host/--/api/v2/push/getReceipts')) {
    let ids = [];
    try { ids = JSON.parse(opts.body).ids || []; } catch {}
    const receipts = {};
    for (const id of ids) {
      // The send mock logged which push token each receipt id belongs to; a
      // LATEFAIL token's receipt reports an error so the SMS fallback fires.
      const line = fs.readFileSync(LOG, 'utf8').split('\n').find(l => l.includes(`"id":"${id}"`));
      const late = line && line.includes('LATEFAIL');
      receipts[id] = late
        ? { status: 'error', message: 'Mismatched credentials', details: { error: 'InvalidCredentials' } }
        : { status: 'ok' };
      if (late) log({ kind: 'receipt-fail', id });
    }
    return new Response(JSON.stringify({ data: receipts }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (u.includes('nominatim.openstreetmap.org')) {
    return new Response(JSON.stringify({ display_name: '123 Test Street, Faketown' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (u.includes('overpass')) {
    return new Response(JSON.stringify({ elements: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(url, opts);

  log({ kind: 'blocked-fetch', url: u });
  throw new Error('[mocks] external fetch blocked during swarm test: ' + u);
};

console.log('[mocks] Fake Twilio + fake Expo push active. SMS log:', LOG);
