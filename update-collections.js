/**
 * update-collections.js
 * ─────────────────────
 * Fetches the latest CS2 skin collection data from ByMykel/CSGO-API and
 * rebuilds collections.json in the format expected by the tradeup calculator.
 *
 * Run with:   node update-collections.js
 *
 * Source:     https://github.com/ByMykel/CSGO-API
 * Data URL:   https://bymykel.github.io/CSGO-API/api/en/collections.json
 *             https://bymykel.github.io/CSGO-API/api/en/skins.json
 *
 * The script merges collection membership + skin float ranges to produce the
 * same schema as the bundled collections.json but up to date.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── rarity name → best_quality int (matches casemove's schema) ──────────────
const RARITY_TO_QUALITY = {
  'Consumer Grade':   1,
  'Industrial Grade': 2,
  'Mil-Spec Grade':   4,
  'Restricted':       6,
  'Classified':       8,
  'Covert':           10,
  'Contraband':       11,
};

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'cs2-vault/1.0' } }, res => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('Fetching collection list…');
  const collections = await fetchJSON(
    'https://bymykel.github.io/CSGO-API/api/en/collections.json'
  );
  console.log(`  Got ${collections.length} collections`);

  console.log('Fetching skin details…');
  const skins = await fetchJSON(
    'https://bymykel.github.io/CSGO-API/api/en/skins.json'
  );
  console.log(`  Got ${skins.length} skins`);

  // Index skins by their collection id
  // Each skin has: { id, name, rarity:{id,name}, min_float, max_float,
  //                  collections:[{id,name}], image }
  const skinsByCollection = {};
  for (const skin of skins) {
    if (!skin.collections || skin.collections.length === 0) continue;
    // A skin can belong to multiple collections (rare but happens)
    for (const col of skin.collections) {
      if (!skinsByCollection[col.id]) skinsByCollection[col.id] = [];
      skinsByCollection[col.id].push(skin);
    }
  }

  // Build the output in casemove's schema:
  // { "Collection Name": { "Skin Name": { quality, min-wear, max-wear, category,
  //                                        best_quality, trade_up, imageURL } } }
  const output = {};
  let totalSkins = 0;
  let skippedNoRarity = 0;

  for (const col of collections) {
    const colSkins = skinsByCollection[col.id];
    if (!colSkins || colSkins.length === 0) continue;

    // Find the max rarity in this collection (Covert / Contraband)
    // Skins at max rarity have trade_up = false; all others = true
    const rarityQualities = colSkins
      .map(s => RARITY_TO_QUALITY[s.rarity?.name])
      .filter(Boolean);

    if (rarityQualities.length === 0) {
      skippedNoRarity++;
      continue;
    }

    const maxQuality = Math.max(...rarityQualities);

    const colEntry = {};
    for (const skin of colSkins) {
      const rarityName = skin.rarity?.name;
      const quality = RARITY_TO_QUALITY[rarityName];
      if (!quality) continue;

      // Strip wear suffix from skin name (ByMykel names are bare, e.g. "AK-47 | Redline")
      const skinName = skin.name;

      colEntry[skinName] = {
        quality: rarityName,
        'min-wear': (skin.min_float ?? 0).toFixed(2),
        'max-wear': (skin.max_float ?? 1).toFixed(2),
        category: skin.stattrak ? 'StatTrak' : 'Normal',
        best_quality: quality,
        trade_up: quality < maxQuality,
        imageURL: skin.image || '',
      };
      totalSkins++;
    }

    if (Object.keys(colEntry).length > 0) {
      output[col.name] = colEntry;
    }
  }

  const outPath = path.join(__dirname, 'collections.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(`\nDone!`);
  console.log(`  Collections: ${Object.keys(output).length}`);
  console.log(`  Skins:       ${totalSkins}`);
  if (skippedNoRarity > 0) console.log(`  Skipped (no rarity data): ${skippedNoRarity}`);
  console.log(`  Written to:  ${outPath}`);
  console.log(`\nRestart the server to pick up the new data.`);
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
