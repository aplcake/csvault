# CS2 Vault

A local tool for valuing your CS2 inventory and storage units. Runs entirely on your machine — no accounts, no cloud, no API keys.

![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue)

---

## What it does

- Connects to Steam and the CS2 Game Coordinator to read your full inventory including all storage unit contents
- Fetches live prices from the Steam Community Market
- Displays everything in a clean browser UI with item images, float values, and total valuations
- Lets you mark and group storage unit items by colour — useful for planning tradeups, float farming, etc.
- Exports to CSV

---

## Requirements

- [Node.js](https://nodejs.org/) v18 or newer
- A Steam account that owns CS2

---

## Install & run

**First time:**
```
npm install
npm start
```

Or just double-click **`start.bat`** on Windows.

Your browser will open automatically at `http://localhost:3000`.

> **No hot-reload:** This is a plain Node server, not a dev build, so the browser won't update automatically when things change. If prices don't appear, items look stale, or you've just loaded storage units — **press F5** to refresh. After restarting the server (e.g. after `update.bat`) you'll need to close and reopen the tab too.

---

## Logging in

You have two options on the login screen:

**QR Login** *(recommended)*
Click **Show QR Code**, then scan with the Steam mobile app. No password needed.

**Password Login**
Enter your Steam username and password. If your account has Steam Guard, you'll be prompted for the code. Optionally paste your base64-encoded shared secret to skip the 2FA prompt entirely.

Your session is saved locally so you won't need to log in again on restart.

---

## Usage

Once logged in and connected (green dot in the sidebar):

1. **Overview** — summary cards showing total value, with a full sortable/filterable table of all items and prices
2. **Items** — image grid of your active inventory items
3. **Storage** — browse each storage unit individually; mark items with colour groups (blue / yellow / green / orange / purple) to plan tradeups and float sets, filter by colour, sort by float

**Loading storage units:** Click **▦ Load Storage** in Overview. The app connects directly to the CS2 GC to read the contents — takes a few seconds per unit.

**Fetching prices:** Click **$ Fetch All Prices**. Prices come from the Steam Community Market at ~1 req/sec to stay within rate limits. Cached prices are saved to `prices_cache.json` and reused on restart.

**Updating item names + collections:** Run `update.bat` (or `node fetch-items.js`) to refresh both the item database and the tradeup collection data from the same Valve CDN source. Do this after any CS2 update that adds new weapon collections or skins. Restart the server after running.

---

## Files

| File | Purpose |
|------|---------|
| `start.bat` | Launch the app (Windows) |
| `update.bat` | Update item names and pull latest app files |
| `server.js` | Express backend — Steam connection, GC, pricing |
| `public/index.html` | React frontend (single file, no build step) |
| `fetch-items.js` | Fetches latest `items.json` **and** `collections.json` from Valve's CDN |
| `patch-items.js` | Supplements `items.json` with known-missing recent entries |
| `items.json` | Item name database (cases, stickers, capsules, agents, charms) |
| `prices_cache.json` | Cached market prices *(auto-generated, not committed)* |
| `session.json` | Saved Steam session *(auto-generated, not committed)* |

---

## Notes

- Prices come from the Steam Community Market — no third-party API or key required
- Your Steam credentials are sent only to Steam's own servers and are never stored in plain text
- The session token saved in `session.json` is equivalent to staying logged in — keep it private and don't commit it
- Storage unit contents are read via the CS2 Game Coordinator, the same way the CS2 client itself does
- **Close CS2 before running the app** — only one GC connection per account is allowed at a time

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "No items in this unit" | Click **Load Storage** and wait for the green dot on each unit tab |
| Items show as "Unknown Kit XXXX" | Run `update.bat` to refresh `items.json`, then reload |
| Prices not loading | Steam Market rate-limits at ~1 req/sec — just wait, it will finish |
| Can't connect / GC timeout | Close CS2 if it's running, then restart the app |
| QR code stuck on "Generating..." | Restart the app and try again |
