# Release checklist (TestFlight / App Store builds)

The app runs in Expo Go long before it runs as a standalone build, and **Expo Go
hides two whole classes of launch crash** because it ships its own warm native
modules and supplies its own URL scheme. Everything below exists because we hit
those the hard way.

## Before every production build

1. **Run the preflight**
   ```bash
   npm run preflight            # fast
   npm run preflight -- --full  # also compiles the production Hermes bundle
   ```
   It must pass with no blocking (✗) issues. Review any ⚠ warnings.

2. **Commit everything** — a build snapshots committed code, not your working tree.

3. **If you added or upgraded a native module** (`expo-*`, `react-native-*`),
   treat it as guilty until proven innocent: it can work perfectly in Expo Go and
   still crash the Release build at launch. Build it to TestFlight and confirm the
   app launches before relying on it. The preflight lists native modules for
   exactly this reason.

## Guardrails that must stay in place

- **`package.json` → `"main": "index.js"`** — this is the permanent startup safety
  net. In a Release build there is no red-box; an uncaught launch error is
  normally a silent `abort()`. `index.js` catches a fatal launch error, shows it
  on screen, persists it, and POSTs it to the server `/clientlog` so it is never a
  silent mystery again. Do not change `main` back to `expo-router/entry`.

- **`app.json` → `"scheme"`** — required or expo-router throws at launch in a
  standalone build (Expo Go masks this by providing `exp://`).

## Crashes we've already solved (don't repeat)

| Symptom | Root cause | Fix |
|---|---|---|
| Every standalone build died at launch; Expo Go fine | `app.json` had no `scheme` | added `"scheme": "makeithome"` |
| Launch crash starting at build 9; native "Instruction Abort" in text layout | `expo-audio` corrupted the process at startup (its native init runs regardless of JS) | removed `expo-audio`; fake call rings via vibration until a verified-safe audio route is added |

## How to read a launch `.ips` crash log

- Signature `com.facebook.react.ExceptionsManagerQueue` → `abort()` = a **fatal
  error surfaced through RN's reporter**. The *real* cause is on another thread
  (look for an `Instruction Abort` / a native module's thread).
- The app binary's frames are stripped, but ObjC method names survive — symbolicate
  offsets against the build's `.ipa` (download via `eas build:view --json` →
  `applicationArchiveUrl`) by parsing the Mach-O `__objc_classlist`.
- Compare the header `slice_uuid` across logs: identical UUID = EAS reused the
  cached native binary (only JS changed); use `--clear-cache` to force a rebuild.
