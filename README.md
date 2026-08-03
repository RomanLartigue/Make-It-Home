# Make It Home

A personal-safety app. Hold the **beacon** to go live — your safety circle gets your
live location and a recording — or swipe to set a check-in timer that alerts them if you
don't make it home.

This repository is the **real, shippable app** (Expo / React Native + a Node server).
The `prototype/` folder is the phase-1 design draft (plain HTML/CSS/JS) we build toward —
it is a reference blueprint, **not** the product.

## Structure

```
app/                  expo-router screens (file-based routing)
  (tabs)/
    index.tsx         Home — the hold-and-swipe beacon (go live / check-in)
    contacts.tsx      Safety circle (add people, action sheet)
    guide.tsx         How it works
    explore.tsx       Settings (name, server test, legal, delete my data)
  escalation.tsx      Escalation ladder (who's alerted first)
  legal.tsx           In-app Terms / Privacy viewer
  onboarding.tsx      Name → Terms → Location
components/beacon/    Shared beacon UI kit (Card, Row, Toggle, buttons…)
constants/beacon.ts   Beacon design tokens (colors, radii)
constants/legal.ts    Terms / Privacy copy
server/               Node/Express backend (SMS, live tracking, uploads)
prototype/            Phase-1 design draft (reference only)
```

The dark "beacon" visual language (colors, the radial timer, escalation, coverage) is
ported from `prototype/`. Backend wiring (device auth token, `/session`, `/checkin`,
`/upload`, live tracking) is unchanged from the original app.

## Run it

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the app

   ```bash
   npx expo start
   ```

   Open in the [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/),
   [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/), or a
   development build. Camera + background location require a real device or simulator —
   Expo Go covers most of the rest.

3. The backend lives in `server/`. Copy `server/.env.example` to `server/.env`, fill in
   your Twilio + registration secret, then `cd server && npm install && npm start`.

## Before making this repo public

`constants/config.ts` contains a hard-coded `REGISTRATION_SECRET` and the production
`SERVER_URL`. **Rotate `REGISTRATION_SECRET`** (in the app and on the server) before
publishing, and never commit `server/.env`.

## What's ported vs. still to port

Phase-1 UI now live in the app: beacon home (hold = go live, swipe = 15/30/45/60 timer),
coverage strip, safety circle + action sheet, escalation ladder, guide, settings, in-app
legal, and the Name → Terms → Location onboarding.

Still on the prototype only (next phases): discreet/duress triggers, fake call, duress
decoy, coverage-health detail, safety routines, PIN-to-cancel, and a real map view.
