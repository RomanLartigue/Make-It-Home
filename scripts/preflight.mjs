#!/usr/bin/env node
/*
 * Pre-build preflight for Make It Home.
 *
 * Run this BEFORE every TestFlight/production build:
 *     npm run preflight          (fast checks)
 *     npm run preflight -- --full (also compiles the production Hermes bundle)
 *
 * Why this exists: every launch crash we ever hit was one of two classes that a
 * normal `expo start` (Expo Go) run does NOT reveal, because Expo Go ships a
 * fixed, warm set of native modules and supplies its own URL scheme:
 *   1. A config gap  — e.g. a missing `scheme` → expo-router throws at launch.
 *   2. A native module that misbehaves in a Release standalone build — e.g.
 *      expo-audio initialized at startup and corrupted the process.
 * This script catches class (1) outright, and surfaces class (2) so any newly
 * added native module gets deliberately tested on a real build, not assumed safe.
 */
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { join, extname } from 'node:path';

let failures = 0;
let warnings = 0;
const ok = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const bad = (m) => { console.log('  \x1b[31m✗\x1b[0m ' + m); failures++; };
const warn = (m) => { console.log('  \x1b[33m⚠\x1b[0m ' + m); warnings++; };
const head = (m) => console.log('\n\x1b[1m' + m + '\x1b[0m');
const sh = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const app = JSON.parse(readFileSync('app.json', 'utf8')).expo;

// ── 1. TypeScript ────────────────────────────────────────────────────────────
head('1. TypeScript');
try { sh('npx tsc --noEmit'); ok('tsc: no type errors'); }
catch (e) { bad('tsc reported errors:\n' + (e.stdout || e.message || '').trim()); }

// ── 2. Git working tree ──────────────────────────────────────────────────────
head('2. Git');
try {
  const s = sh('git status --porcelain').trim();
  if (s) warn('uncommitted changes (a build snapshots committed code):\n' + s);
  else ok('working tree clean');
} catch { warn('not a git repo / git unavailable'); }

// ── 3. app.json — the config gaps that crash a standalone launch ──────────────
head('3. app.json config (standalone launch requirements)');
app.scheme ? ok(`scheme = "${app.scheme}"`)
           : bad('scheme MISSING → expo-router throws at launch in a standalone build');
app.extra?.eas?.projectId ? ok('extra.eas.projectId set') : bad('extra.eas.projectId missing');
app.ios?.bundleIdentifier ? ok(`ios.bundleIdentifier = ${app.ios.bundleIdentifier}`)
                          : bad('ios.bundleIdentifier missing');
app.version ? ok(`version = ${app.version}`) : bad('version missing');
app.newArchEnabled === false ? ok('newArchEnabled = false (as intended)')
                             : warn(`newArchEnabled = ${app.newArchEnabled} (verify intended)`);

// ── 4. Entry point — the permanent startup safety net ────────────────────────
head('4. Startup safety net');
pkg.main === 'index.js'
  ? ok('main = index.js (fatal launch errors are shown + shipped, not silent)')
  : warn(`main = ${pkg.main} — startup error reporter bypassed; a launch crash would be a silent abort`);

// ── 5. Every non-relative import resolves ────────────────────────────────────
head('5. Imports resolve (a missing package = standalone launch crash)');
const SRC_DIRS = ['app', 'utils', 'constants', 'components', 'hooks'];
const files = [];
const walk = (d) => {
  if (!existsSync(d)) return;
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (['.ts', '.tsx', '.js', '.jsx'].includes(extname(p))) files.push(p);
  }
};
SRC_DIRS.forEach(walk);
const pkgs = new Set();
const re = /(?:from|import|require)\s*\(?\s*['"]([^.'"][^'"]*)['"]/g;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  let m;
  while ((m = re.exec(src))) {
    let name = m[1];
    if (name.startsWith('@/')) continue;
    const parts = name.split('/');
    name = name.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    pkgs.add(name);
  }
}
const builtin = new Set(['react', 'react-native', 'react-dom']);
let missing = 0;
for (const name of [...pkgs].sort()) {
  if (builtin.has(name)) continue;
  if (existsSync(join('node_modules', name))) { /* fine */ }
  else { bad(`import "${name}" not found in node_modules`); missing++; }
}
if (!missing) ok(`all ${pkgs.size} imported packages resolve`);

// ── 6. Native modules — the "works in Expo Go, dies in Release" class ─────────
head('6. Native modules (each MUST be verified on a real Release build)');
const NATIVE_RE = /^(expo-|react-native-|@react-native)/;
const nativeDeps = Object.keys(pkg.dependencies || {}).filter(
  (d) => NATIVE_RE.test(d) && d !== 'react-native',
);
console.log('  ' + nativeDeps.join(', '));
warn('If any of these was ADDED since the last build that launched on TestFlight, '
   + 'test the standalone build before trusting it — Expo Go does not exercise it.');
// Known-bad pins learned the hard way:
if (pkg.dependencies?.['expo-audio']) {
  bad('expo-audio is present — it crashed the Release launch (native abort at startup). '
    + 'Do not re-add without verifying a standalone build.');
}

// ── 7. (optional) Production Hermes bundle compile ───────────────────────────
if (process.argv.includes('--full')) {
  head('7. Production bundle (Hermes compile — the real store path)');
  const out = '.preflight-export';
  try {
    sh(`npx expo export --platform ios --output-dir ${out}`);
    const dir = join(out, '_expo', 'static', 'js', 'ios');
    const bundle = existsSync(dir) && readdirSync(dir).find((f) => f.endsWith('.hbc'));
    bundle ? ok(`Hermes bundle compiled (${bundle})`) : bad('no .hbc bundle produced');
  } catch (e) {
    bad('expo export failed:\n' + (e.stdout || e.message || '').trim());
  } finally {
    try { rmSync(out, { recursive: true, force: true }); } catch {}
  }
} else {
  head('7. Production bundle');
  console.log('  (skipped — run "npm run preflight -- --full" to also compile the Hermes bundle)');
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(56));
if (failures) {
  console.log(`\x1b[31m✗ ${failures} blocking issue(s)\x1b[0m` + (warnings ? `, ${warnings} warning(s)` : ''));
  console.log('Fix the blocking issues before building.');
  process.exit(1);
} else {
  console.log(`\x1b[32m✓ Preflight passed\x1b[0m` + (warnings ? ` (${warnings} warning(s) to review)` : ''));
  console.log('Safe to build. For extra safety before a store build: npm run preflight -- --full');
  process.exit(0);
}
