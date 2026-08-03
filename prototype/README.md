# Make It Home — Prototype

An interactive front-end prototype of **Make It Home**, a personal-safety app.
Pure HTML / CSS / JavaScript — no build step, no dependencies.

## Structure
- `index.html` — markup for every screen + the desktop navigator panel
- `styles.css` — all styling (dark "beacon" theme, responsive; hides the navigator on mobile widths)
- `app.js` — all interactivity: screen navigation, the hold-and-swipe beacon, escalation drag-to-reorder,
  the check-in note countdown, geolocation request, coverage logic, the PIN pad, and the fake call

## Run it locally
Open `index.html` in a browser. For geolocation to work (and to match production), serve over http/https:
- **VS Code:** the *Live Server* extension → "Go Live"
- **or:** `npx serve` in this folder, then open the printed URL

## Deploy (GitHub Pages)
Push to a repository, then **Settings → Pages → deploy from branch**. `index.html` is served automatically.

## Notes
- This is a **design prototype** — it demonstrates the flows and UI. It is not wired to real SMS,
  location broadcasting, or recording; those belong in the production app.
- The left navigator panel is a developer aid; it auto-hides below 820px so on a phone it's just the app.
