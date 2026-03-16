/**
 * patch-items.js
 * Supplements items.json with known-missing 2024/2025/2026 cases, capsules and collections.
 * Run after fetch-items.js if you see NO MHN errors for recent content.
 * Usage: node patch-items.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ITEMS_FILE = path.join(__dirname, 'items.json');

// Known missing items: def_index -> market_hash_name
// These are cases, sticker capsules, and collection items from 2024-2026
// that skinledger doesn't have yet.
// Add more here whenever new content drops.
const PATCHES = {
  // ── 2024 Cases ──────────────────────────────────────────────────────────────
  "4942": "Kilowatt Case",
  "5027": "Gallery Case",

  // ── 2025 Cases ──────────────────────────────────────────────────────────────
  "5119": "Fever Case",
  "5120": "Ascent Case",
  "5121": "Boreal Case",
  "5122": "Radiant Case",
  "5123": "Train 2025 Case",
  "5137": "Genesis Case",

  // ── 2026 Cases ──────────────────────────────────────────────────────────────
  "5160": "Achroma Case",
  "5161": "Harlequin Case",
  "5162": "Dead Hand Case",

  // ── 2024 Sticker Capsules ───────────────────────────────────────────────────
  "5028": "Gallery Legends Sticker Capsule",
  "5029": "Gallery Challengers Sticker Capsule",
  "5030": "Gallery Contenders Sticker Capsule",

  // ── 2025 Sticker Capsules ───────────────────────────────────────────────────
  "5085": "2025 RMR Legends Sticker Capsule",
  "5086": "2025 RMR Challengers Sticker Capsule",
  "5087": "2025 RMR Contenders Sticker Capsule",

  // ── 2024 Collections (souvenir packages etc) ────────────────────────────────
  "4965": "Gallery Collection Package",
  "4966": "Graphic Design Collection Package",
  "4967": "Overpass 2024 Collection Package",
  "4968": "Sport & Field Collection Package",

  // ── 2025 Collections ────────────────────────────────────────────────────────
  "5090": "Ascent Collection Package",
  "5091": "Boreal Collection Package",
  "5092": "Fever Collection Package",
  "5093": "Radiant Collection Package",
  "5094": "Train 2025 Collection Package",

  // ── Keys ────────────────────────────────────────────────────────────────────
  "4943": "Kilowatt Case Key",
  "5031": "Gallery Case Key",
};

if (!fs.existsSync(ITEMS_FILE)) {
  console.error('items.json not found — run fetch-items.js first');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(ITEMS_FILE, 'utf8'));
let added = 0, updated = 0;

for (const [defIndex, name] of Object.entries(PATCHES)) {
  if (!data[defIndex]) { data[defIndex] = name; added++; }
  else if (data[defIndex] !== name) { data[defIndex] = name; updated++; }
}

fs.writeFileSync(ITEMS_FILE, JSON.stringify(data, null, 2));
console.log(`Patched items.json: +${added} added, ${updated} updated. Total: ${Object.keys(data).filter(k => !k.startsWith('_')).length} items`);
