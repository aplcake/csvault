/**
 * fetch-items.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Connects to the CS2 Game Coordinator using your existing session, receives
 * the official items_game_url Valve sends on every login (UpdateItemSchema msg),
 * fetches that file from Valve's own CDN, parses it, and writes items.json.
 *
 * Usage:  node fetch-items.js
 *
 * - Uses session.json (created by the main app on first login)
 * - Close CS2 first — only one GC connection per account
 * - Falls back to skinledger mirror only if Valve CDN fetch fails
 * - Re-run whenever new content releases (cases, majors, operations)
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');

const SteamUser       = require('steam-user');
const GlobalOffensive = require('globaloffensive');
const Protos          = require('./node_modules/globaloffensive/protobufs/generated/base_gcmessages.js');

const SESSION_FILE  = path.join(__dirname, 'session.json');
const ITEMS_FILE    = path.join(__dirname, 'items.json');
const KEYCHAINS_FILE = path.join(__dirname, 'keychains.json');
// Source priority:
// 1. Valve CDN URL from GC (always latest)
// 2. Valve CDN direct (versionless URL, usually works)
// 3. SteamDatabase mirrors (various paths)
// 4. skinledger (stale — last resort)
const STEAMDB_ITEMS_URLS = [
  // pak01_dir paths — most likely location for extracted CS2 files
  'https://raw.githubusercontent.com/SteamDatabase/GameTracking-CS2/master/game/csgo/pak01_dir/scripts/items/items_game.txt',
  'https://raw.githubusercontent.com/SteamDatabase/GameTracking-CS2/master/game/csgo/scripts/items/items_game.txt',
  'https://raw.githubusercontent.com/SteamDatabase/GameTracking-CS2/master/csgo/pak01_dir/scripts/items/items_game.txt',
  'https://raw.githubusercontent.com/SteamDatabase/GameTracking-CS2/master/csgo/scripts/items/items_game.txt',
  'https://raw.githubusercontent.com/nicklvsa/csgo-items/main/items_game.txt',
  'https://cdn.cloudflare.steamstatic.com/apps/730/scripts/items/items_game.txt',
];
const FALLBACK_URL       = 'https://files.skinledger.com/counterstrike/items_game.txt';
const ENGLISH_URL        = 'https://files.skinledger.com/counterstrike/csgo_english.txt';

// Derive candidate English file URLs from the items URL (returns array, tried in order)
function getEnglishUrls(itemsUrl) {
  if (itemsUrl === FALLBACK_URL) return [ENGLISH_URL];
  if (itemsUrl.includes('cdn.cloudflare.steamstatic.com') || itemsUrl.includes('cdn.steam')) {
    return [itemsUrl.replace('items_game.txt', 'csgo_english.txt'), ENGLISH_URL];
  }
  if (itemsUrl.includes('raw.githubusercontent.com')) {
    const urls = [
      itemsUrl.replace('/pak01_dir/scripts/items/items_game.txt', '/pak01_dir/resource/csgo_english.txt'),
      itemsUrl.replace('/scripts/items/items_game.txt', '/resource/csgo_english.txt'),
      itemsUrl.replace('/csgo/pak01_dir/scripts/items/items_game.txt', '/csgo/pak01_dir/resource/csgo_english.txt'),
      itemsUrl.replace('/csgo/scripts/items/items_game.txt', '/csgo/resource/csgo_english.txt'),
      ENGLISH_URL,
    ];
    return [...new Set(urls)];
  }
  return [ENGLISH_URL];
}

// ─── Skip logic ───────────────────────────────────────────────────────────────
// Weapons and gloves are handled by the paint kit schema, skip them here.
// Individual stickers, capsules, cases, agents, patches, pins all have
// market value and are kept.
function shouldSkip(name, def) {
  if (def === 0) return true;
  if ((def >= 1 && def <= 64) || (def >= 500 && def <= 526)) return true;
  const gloves = [4725,4726,4727,4728,4729,4730,4731,4732,4733,4846,4848,5027];
  if (gloves.includes(def)) return true;
  const lo = name.toLowerCase().trim();
  if (!lo || lo === 'sticker name') return true;
  const skipContains = [
    'operation coin', 'service medal', 'map coin',
    'graffiti box', 'sealed graffiti', 'profile background',
    'music kit box', 'gift package', 'tournament pass',
    'esports key', 'case key', 'winter offensive package',
    'phoenix package', 'the cache package', 'combo package',
  ];
  if (new Set(['storage unit','capsule key']).has(lo)) return true;
  for (const s of skipContains) if (lo.includes(s)) return true;
  return false;
}

// ─── HTTP/HTTPS fetch ─────────────────────────────────────────────────────────
function fetchText(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchText(res.headers.location).then(resolve, reject);
      if (res.statusCode !== 200)
        return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', d => buf += d);
      res.on('end', () => resolve(buf));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── Parsers ──────────────────────────────────────────────────────────────────
function parseTranslations(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s+"([^"]+)"\s+"([^"]+)"/);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

// VDF key and { are on separate lines — track depth carefully
function parseItemsGame(text, trans) {
  const result = {};
  const lines = text.split('\n');

  function tr(tag) {
    const key = (tag.startsWith('#') ? tag.slice(1) : tag).toLowerCase();
    return trans[key] || (tag.startsWith('#') ? tag.slice(1) : tag);
  }

  let inItems = false, depth = 0;
  let pendingDef = null;
  let itemDef = null, itemTag = null, itemDepth = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!inItems) {
      if (line === '"items"') { inItems = true; depth = 0; }
      continue;
    }

    const opens  = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;

    if (opens > 0 && pendingDef !== null && itemDef === null) {
      itemDef = pendingDef; pendingDef = null; itemTag = null;
      itemDepth = depth + opens;
      depth += opens - closes;
      continue;
    }

    depth += opens - closes;

    if (itemDef === null && pendingDef === null && depth === 1) {
      const m = line.match(/^"(\d+)"$/);
      if (m) { pendingDef = parseInt(m[1]); continue; }
    }

    if (itemDef !== null) {
      const m = line.match(/^"item_name"\s+"([^"]+)"/);
      if (m) itemTag = m[1];
    }

    if (itemDef !== null && depth < itemDepth) {
      if (itemTag) {
        const name = tr(itemTag);
        if (name && !shouldSkip(name, itemDef)) result[String(itemDef)] = name;
      }
      itemDef = null; itemTag = null; itemDepth = 0;
    }

    if (depth < 0) break;
  }

  return result;
}

function parseKeychainDefinitions(text, trans) {
  const lines = text.split('\n');
  const out = {};
  const tr = (tag) => {
    if (!tag) return '';
    const key = (tag.startsWith('#') ? tag.slice(1) : tag).toLowerCase();
    return trans[key] || (tag.startsWith('#') ? tag.slice(1) : tag);
  };

  let inKeychains = false;
  let depth = 0;
  let pendingId = null;
  let keychainId = null;
  let keychainDepth = 0;
  let keychainTag = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!inKeychains) {
      if (line === '"keychain_definitions"') { inKeychains = true; depth = 0; }
      continue;
    }

    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;

    if (opens > 0 && pendingId !== null && keychainId === null) {
      keychainId = pendingId;
      pendingId = null;
      keychainTag = null;
      keychainDepth = depth + opens;
      depth += opens - closes;
      continue;
    }

    depth += opens - closes;

    if (keychainId === null && pendingId === null && depth === 1) {
      const m = line.match(/^"(\d+)"$/);
      if (m) { pendingId = parseInt(m[1], 10); continue; }
    }

    if (keychainId !== null) {
      const m = line.match(/^"loc_name"\s+"([^"]+)"/);
      if (m) keychainTag = m[1];
    }

    if (keychainId !== null && depth < keychainDepth) {
      const name = tr(keychainTag);
      if (name && keychainId >= 6000 && keychainId < 7000) out[String(keychainId)] = name;
      keychainId = null;
      keychainDepth = 0;
      keychainTag = null;
    }

    if (inKeychains && depth < 0) break;
  }

  return out;
}

// ─── Core: fetch items_game from a URL and write items.json ──────────────────

const COLLECTIONS_FILE = path.join(__dirname, 'collections.json');

// ─── Rarity mapping ───────────────────────────────────────────────────────────
// items_game uses integer quality tags; these map to best_quality ints
// as used by our tradeup math (matching casemove's schema)
const RARITY_INT = {
  'rarity_default':        1,  // Consumer Grade
  'rarity_common':         1,
  'rarity_uncommon':       2,  // Industrial Grade
  'rarity_rare':           4,  // Mil-Spec
  'rarity_mythical':       6,  // Restricted
  'rarity_legendary':      8,  // Classified
  'rarity_ancient':        10, // Covert
  'rarity_immortal':       11, // Contraband (Howl etc)
};
const RARITY_NAME = {
  1: 'Consumer Grade', 2: 'Industrial Grade', 4: 'Mil-Spec Grade',
  6: 'Restricted', 8: 'Classified', 10: 'Covert', 11: 'Contraband',
};

// ─── Parse all top-level VDF sections we need ─────────────────────────────────
// Returns { paintKits, itemSets, lootLists, setTranslations }
function parseItemsGameFull(text, trans) {
  const lines = text.split('\n');
  let depth = 0;
  let section = null; // pending section name at depth 1
  const sections = {};
  let capture = null;

  const WANT = new Set(['paint_kits', 'item_sets', 'client_loot_lists', 'revolving_loot_lists']);

  // The real VDF structure is:
  //   "items_game"          <- depth 0 key
  //   {                     <- depth becomes 1
  //       "paint_kits"      <- depth 1 key (this is what we want)
  //       {                 <- depth becomes 2, start capture
  //           ...
  //       }                 <- depth back to 1, end capture
  //   }
  // So we look for section-name keys at depth 1, and open/close capture at depth 1→2

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    const opens  = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;

    // Detect a pending section key at depth 1
    if (!capture && depth === 1) {
      const m = line.match(/^"([^"]+)"$/);
      if (m) { section = m[1].toLowerCase(); }
    }

    // Opening brace at depth 1 → start/skip capture
    if (line === '{' && depth === 1) {
      if (section && WANT.has(section)) {
        capture = { name: section, lines: [] };
      }
      depth = 2;
      section = null;
      continue;
    }

    depth += opens - closes;

    if (capture) {
      if (depth >= 2) {
        capture.lines.push(raw);
      } else {
        // depth dropped back to 1 — section closed
        sections[capture.name] = capture.lines.join('\n');
        capture = null;
      }
    }
  }

  // ── Parse paint_kits: kit_name -> { wear_min, wear_max } ──────────────────
  const paintKits = {};
  if (sections.paint_kits) {
    let kitName = null, inKit = false, kitDepth = 0;
    let wMin = null, wMax = null;
    for (const raw of sections.paint_kits.split('\n')) {
      const line = raw.trim();
      const o = (line.match(/\{/g)||[]).length;
      const c = (line.match(/\}/g)||[]).length;
      if (!inKit) {
        const m = line.match(/^"([^"]+)"$/);
        if (m) { kitName = m[1].toLowerCase(); wMin = null; wMax = null; continue; }
        if (line === '{' && kitName) { inKit = true; kitDepth = 1; continue; }
      } else {
        kitDepth += o - c;
        if (kitDepth <= 0) {
          if (kitName && kitName !== '0') paintKits[kitName] = { wMin: wMin||'0.00', wMax: wMax||'1.00' };
          inKit = false; kitName = null;
          continue;
        }
        if (kitDepth === 1) {
          let m = line.match(/^"wear_remap_min"\s+"([^"]+)"/);
          if (m) { wMin = parseFloat(m[1]).toFixed(2); continue; }
          m = line.match(/^"wear_remap_max"\s+"([^"]+)"/);
          if (m) { wMax = parseFloat(m[1]).toFixed(2); continue; }
        }
      }
    }
  }

  // ── Parse item_sets: set_key -> { name_tag, items: ['[weapon]kit', ...] } ──
  const itemSets = {};
  if (sections.item_sets) {
    let setKey = null, inSet = false, setDepth = 0, inItems = false, itemsDepth = 0;
    let nameTag = null, setItems = [];
    for (const raw of sections.item_sets.split('\n')) {
      const line = raw.trim();
      const o = (line.match(/\{/g)||[]).length;
      const c = (line.match(/\}/g)||[]).length;
      if (!inSet) {
        const m = line.match(/^"([^"]+)"$/);
        if (m) { setKey = m[1]; nameTag = null; setItems = []; continue; }
        if (line === '{' && setKey) { inSet = true; setDepth = 1; continue; }
      } else {
        setDepth += o - c;
        if (setDepth <= 0) {
          if (setKey) itemSets[setKey] = { nameTag, items: setItems };
          inSet = false; inItems = false; setKey = null;
          continue;
        }
        if (setDepth === 1) {
          let m = line.match(/^"name"\s+"([^"]+)"/);
          if (m) { nameTag = m[1]; continue; }
          m = line.match(/^"items"$/);
          if (m) { inItems = true; itemsDepth = setDepth; continue; }
        }
        if (inItems && setDepth === itemsDepth + 1) {
          const m = line.match(/^"([^"]+)"\s+"\d+"/);
          if (m) setItems.push(m[1]);
        }
        if (inItems && setDepth <= itemsDepth) inItems = false;
      }
    }
  }

  // ── Parse client_loot_lists + revolving_loot_lists: collect rarity nesting ──
  // Structure: "set_key_rarity_level" { "[weapon]kit" "1" }
  // We want to know rarity level of each [weapon]kit in each set
  const lootRarity = {}; // "[weapon]kit" -> rarity int (highest seen)
  for (const secName of ['client_loot_lists', 'revolving_loot_lists']) {
    if (!sections[secName]) continue;
    let listKey = null, inList = false, listDepth = 0;
    for (const raw of sections[secName].split('\n')) {
      const line = raw.trim();
      const o = (line.match(/\{/g)||[]).length;
      const c = (line.match(/\}/g)||[]).length;
      if (!inList) {
        const m = line.match(/^"([^"]+)"$/);
        if (m) { listKey = m[1].toLowerCase(); continue; }
        if (line === '{' && listKey) { inList = true; listDepth = 1; continue; }
      } else {
        listDepth += o - c;
        if (listDepth <= 0) { inList = false; listKey = null; continue; }
        if (listDepth === 1) {
          const m = line.match(/^"([^"]+)"\s+"\d+"/);
          if (m) {
            const item = m[1].toLowerCase();
            // Determine rarity from list key suffix
            let rarity = 0;
            for (const [tag, val] of Object.entries(RARITY_INT)) {
              if (listKey.endsWith('_' + tag.replace('rarity_', ''))) {
                rarity = val; break;
              }
            }
            // Also detect by common suffixes
            if (!rarity) {
              if (listKey.includes('_ancient')) rarity = 10;
              else if (listKey.includes('_legendary')) rarity = 8;
              else if (listKey.includes('_mythical')) rarity = 6;
              else if (listKey.includes('_rare')) rarity = 4;
              else if (listKey.includes('_uncommon')) rarity = 2;
              else if (listKey.includes('_common')) rarity = 1;
            }
            if (rarity && item.startsWith('[')) {
              lootRarity[item] = Math.max(lootRarity[item] || 0, rarity);
            }
          }
        }
      }
    }
  }

  return { paintKits, itemSets, lootRarity };
}


// ─── Build collections.json from ByMykel CSGO-API (primary, always up-to-date) ─
const BYMYKEL_SKINS_URL = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins.json';
const ICON_CACHE_FILE   = path.join(__dirname, 'icon_cache.json');

async function buildCollectionsFromByMykel() {
  console.log('  Fetching skin data from ByMykel CSGO-API...');
  const raw = await fetchText(BYMYKEL_SKINS_URL);
  const skins = JSON.parse(raw);
  console.log('  Skins received: ' + skins.length);

  // Load existing icon cache so we can supplement it
  let iconCache = {};
  try { iconCache = JSON.parse(fs.readFileSync(ICON_CACHE_FILE, 'utf8')); } catch(e) {}
  let iconsAdded = 0;

  // Rarity id -> best_quality int (matches our tradeup RARITY_HEX keys)
  const RARITY_MAP = {
    'rarity_common_weapon':    1,
    'rarity_uncommon_weapon':  2,
    'rarity_rare_weapon':      4,
    'rarity_mythical_weapon':  6,
    'rarity_legendary_weapon': 8,
    'rarity_ancient_weapon':   10,
    'rarity_contraband_weapon':11,
    // Some skins use non-weapon suffix too
    'rarity_common':    1, 'rarity_uncommon': 2, 'rarity_rare': 4,
    'rarity_mythical':  6, 'rarity_legendary': 8, 'rarity_ancient': 10,
    'rarity_contraband':11,
  };
  const RARITY_NAME = {
    1:'Consumer Grade', 2:'Industrial Grade', 4:'Mil-Spec Grade',
    6:'Restricted', 8:'Classified', 10:'Covert', 11:'Contraband',
  };

  const collections = {};

  for (const skin of skins) {
    if (!skin.name || !skin.collections || skin.collections.length === 0) continue;

    const rarityId  = skin.rarity?.id || '';
    const rarityInt = RARITY_MAP[rarityId] || 0;
    if (!rarityInt) continue; // skip if rarity unknown

    // Populate icon cache from ByMykel's GitHub-hosted images
    // These are PNG URLs from counter-strike-image-tracker
    if (skin.image && skin.name) {
      // Convert ByMykel full URL to Steam CDN hash if it contains the hash
      // Otherwise store the full GitHub URL as fallback
      // The market_hash_name for the icon lookup is skin.name + wear suffix,
      // but ByMykel images are per-skin (not per-wear), so store under base name
      const baseName = skin.name; // e.g. "AK-47 | Redline"
      if (!iconCache[baseName] && skin.image.includes('github')) {
        // Store as a special GitHub URL marker — server will serve it directly
        iconCache[baseName] = '__github__' + skin.image;
        iconsAdded++;
      }
    }

    for (const col of skin.collections) {
      const colName = col.name;
      if (!colName) continue;
      if (!collections[colName]) collections[colName] = {};

      const minFloat = typeof skin.min_float === 'number' ? skin.min_float.toFixed(2) : '0.00';
      const maxFloat = typeof skin.max_float === 'number' ? skin.max_float.toFixed(2) : '1.00';

      collections[colName][skin.name] = {
        quality:       RARITY_NAME[rarityInt] || 'Unknown',
        'min-wear':    minFloat,
        'max-wear':    maxFloat,
        category:      'Normal',
        best_quality:  rarityInt,
        trade_up:      rarityInt < 10 && rarityInt > 0,
        image:         skin.image || '',
        imageURL:      skin.image || '',
      };
    }
  }

  // Save updated icon cache
  if (iconsAdded > 0) {
    fs.writeFileSync(ICON_CACHE_FILE, JSON.stringify(iconCache, null, 2));
    console.log('  Icon cache supplemented: +' + iconsAdded + ' entries');
  }

  return collections;
}

// ─── Build collections.json from parsed VDF data ─────────────────────────────
function buildCollections(igText, trans) {
  console.log('Parsing item_sets, paint_kits, loot_lists...');
  const { paintKits, itemSets, lootRarity } = parseItemsGameFull(igText, trans);

  console.log('  paint_kits parsed: ' + Object.keys(paintKits).length);
  console.log('  item_sets parsed:  ' + Object.keys(itemSets).length);
  console.log('  loot rarities:     ' + Object.keys(lootRarity).length);

  // Weapon def-index -> weapon prefix used in item_sets
  // e.g. "[weapon_ak47]" -> "AK-47", "[weapon_p250]" -> "P250"
  // We build this by scanning items_game for item definitions
  const weaponPrefixToName = {};
  {
    const prefRe = /^\[([^\]]+)\]/;
    // Build from existing items.json names + lootRarity keys
    // Pattern: "[weapon_ak47]cu_ak47_cobra" => weapon = "weapon_ak47"
    for (const key of Object.keys(lootRarity)) {
      const m = key.match(/^\[([^\]]+)\]/);
      if (m) weaponPrefixToName[m[1]] = true;
    }
    for (const set of Object.values(itemSets)) {
      for (const item of set.items) {
        const m = item.match(/^\[([^\]]+)\]/);
        if (m) weaponPrefixToName[m[1]] = true;
      }
    }
  }

  // Resolve "[weapon_ak47]cu_ak47_cobra" -> human-readable skin name
  // We need: weapon display name + paint kit display name
  // Paint kit names come from translations (e.g. #PaintKit_cu_ak47_cobra -> "Redline")
  // Weapon names come from translations (#SFUI_WPNHUD_AK47 -> "AK-47" etc)

  // Build weapon tag -> display name from translations
  const weaponDisplayName = {};
  for (const [tag, name] of Object.entries(trans)) {
    if (tag.startsWith('sfui_wpnhud_') || tag.startsWith('wpnhud_')) {
      const weapon = tag.replace('sfui_wpnhud_', '').replace('wpnhud_', '');
      weaponDisplayName[weapon] = name;
    }
  }

  // Also try to derive weapon names from known weapon_ prefixes
  // by stripping "weapon_" and title-casing
  // Hardcoded weapon name map as reliable fallback
  // (translation key lookup is fragile due to key name variations)
  const WEAPON_NAME_FALLBACK = {
    'weapon_ak47':'AK-47','weapon_aug':'AUG','weapon_awp':'AWP',
    'weapon_bizon':'PP-Bizon','weapon_cz75a':'CZ75-Auto','weapon_deagle':'Desert Eagle',
    'weapon_elite':'Dual Berettas','weapon_famas':'FAMAS','weapon_fiveseven':'Five-SeveN',
    'weapon_g3sg1':'G3SG1','weapon_galilar':'Galil AR','weapon_glock':'Glock-18',
    'weapon_hkp2000':'P2000','weapon_m249':'M249','weapon_m4a1':'M4A4',
    'weapon_m4a1_silencer':'M4A1-S','weapon_mac10':'MAC-10','weapon_mag7':'MAG-7',
    'weapon_mp5sd':'MP5-SD','weapon_mp7':'MP7','weapon_mp9':'MP9',
    'weapon_negev':'Negev','weapon_nova':'Nova','weapon_p250':'P250',
    'weapon_p90':'P90','weapon_sawedoff':'Sawed-Off','weapon_scar20':'SCAR-20',
    'weapon_sg556':'SG 553','weapon_ssg08':'SSG 08','weapon_tec9':'Tec-9',
    'weapon_ump45':'UMP-45','weapon_usp_silencer':'USP-S','weapon_xm1014':'XM1014',
    'weapon_revolver':'R8 Revolver','weapon_p2000':'P2000',
    'weapon_knife_flip':'Flip Knife','weapon_knife_gut':'Gut Knife',
    'weapon_knife_karambit':'Karambit','weapon_knife_m9_bayonet':'M9 Bayonet',
    'weapon_knife_tactical':'Huntsman Knife','weapon_bayonet':'Bayonet',
    'weapon_knife_falchion':'Falchion Knife','weapon_knife_survival_bowie':'Bowie Knife',
    'weapon_knife_butterfly':'Butterfly Knife','weapon_knife_push':'Shadow Daggers',
    'weapon_knife_stiletto':'Stiletto Knife','weapon_knife_widowmaker':'Talon Knife',
    'weapon_knife_ursus':'Ursus Knife','weapon_knife_gypsy_jackknife':'Navaja Knife',
    'weapon_knife_outdoor':'Survival Knife','weapon_knife_cord':'Cord Knife',
    'weapon_knife_canis':'Canis Knife','weapon_knife_skeleton':'Skeleton Knife',
    'weapon_knife_css':'Classic Knife','weapon_knife_m9_bayonet':'M9 Bayonet',
    'weapon_pistol_223':'P350',
  };

  function weaponPrefixToDisplayName(prefix) {
    // Try hardcoded map first (most reliable)
    if (WEAPON_NAME_FALLBACK[prefix]) return WEAPON_NAME_FALLBACK[prefix];
    const key = prefix.replace('weapon_', '');
    // Try translation keys
    const candidates = [
      weaponDisplayName[key],
      weaponDisplayName['weapon_' + key],
      trans['sfui_wpnhud_' + key],
      trans['wpnhud_' + key],
    ];
    for (const c of candidates) if (c) return c;
    return null;
  }

  // Build paint kit name -> display name
  function kitToDisplayName(kitName) {
    // Paint kit display name is in translations as "PaintKit_<kit>_Tag" or "#PaintKit_<kit>"
    const candidates = [
      trans['paintkit_' + kitName + '_tag'],
      trans['paintkit_' + kitName],
    ];
    for (const c of candidates) if (c) return c;
    return null;
  }

  // Resolve a full item key like "[weapon_ak47]cu_ak47_cobra" to MHN
  function resolveItemKey(itemKey) {
    const m = itemKey.match(/^\[([^\]]+)\](.+)$/);
    if (!m) return null;
    const [, weaponPrefix, kitName] = m;
    const weapon = weaponPrefixToDisplayName(weaponPrefix);
    const kit = kitToDisplayName(kitName);
    if (!weapon || !kit) return null;
    return weapon + ' | ' + kit;
  }

  // Build the collections.json
  const collections = {};
  let totalSkins = 0, skipped = 0;

  // Debug: show first few sets and why they might fail
  const setKeys = Object.keys(itemSets);
  if (setKeys.length < 5) {
    console.log('  DEBUG item_sets:', JSON.stringify(setKeys));
    if (setKeys.length > 0) {
      const s = itemSets[setKeys[0]];
      console.log('  DEBUG first set nameTag:', s.nameTag, 'items:', s.items.slice(0,2));
      if (s.items[0]) {
        const m = s.items[0].match(/^\[([^\]]+)\](.+)$/);
        if (m) {
          console.log('  DEBUG weapon prefix:', m[1], '-> name:', weaponPrefixToDisplayName ? 'fn exists' : 'MISSING');
        }
      }
    }
  }

  for (const [setKey, setData] of Object.entries(itemSets)) {
    if (!setData.nameTag) continue;
    // Resolve collection display name
    const nameKey = setData.nameTag.startsWith('#') ? setData.nameTag.slice(1).toLowerCase() : setData.nameTag.toLowerCase();
    const collectionName = trans[nameKey] || setData.nameTag;
    if (!collectionName || collectionName.startsWith('#')) { skipped++; continue; }

    const collectionItems = {};

    for (const itemKey of setData.items) {
      const skinName = resolveItemKey(itemKey.toLowerCase());
      if (!skinName) { skipped++; continue; }

      // Get rarity for this item
      const rarityInt = lootRarity[itemKey.toLowerCase()] || 0;

      // Get wear range from paint kit
      const kitName = itemKey.toLowerCase().replace(/^\[[^\]]+\]/, '');
      const kit = paintKits[kitName];
      const minWear = kit ? kit.wMin : '0.00';
      const maxWear = kit ? kit.wMax : '1.00';

      // trade_up = true if rarity < Covert (can always trade up non-Covert, non-Contraband)
      const tradeUp = rarityInt > 0 && rarityInt < 10;

      collectionItems[skinName] = {
        quality: RARITY_NAME[rarityInt] || 'Unknown',
        'min-wear': minWear,
        'max-wear': maxWear,
        category: 'Normal',
        best_quality: rarityInt,
        trade_up: tradeUp,
        image: '',
        imageURL: '',
      };
      totalSkins++;
    }

    if (Object.keys(collectionItems).length > 0) {
      collections[collectionName] = collectionItems;
    }
  }

  console.log('  Collections built: ' + Object.keys(collections).length);
  console.log('  Total skins:       ' + totalSkins);
  console.log('  Skipped (no name): ' + skipped);
  return collections;
}

async function buildItems(itemsGameUrl) {
  const englishUrls = getEnglishUrls(itemsGameUrl);
  const source = itemsGameUrl === FALLBACK_URL ? 'skinledger (last resort)'
    : itemsGameUrl.includes('cdn.cloudflare') ? 'Valve CDN'
    : itemsGameUrl.includes('githubusercontent') ? 'GitHub mirror'
    : 'custom URL';
  console.log('Fetching items_game.txt from ' + source + '...');
  console.log('  ' + itemsGameUrl);

  const igText = await fetchText(itemsGameUrl);
  let enText = null;
  let englishErr = null;
  for (const enUrl of englishUrls) {
    try { enText = await fetchText(enUrl); break; }
    catch(e) { englishErr = e; }
  }
  if (!enText) throw new Error('Failed to fetch english translations: ' + (englishErr?.message || 'unknown'));

  console.log('  items_game.txt : ' + (igText.length / 1024).toFixed(0) + ' KB');
  console.log('  csgo_english   : ' + (enText.length / 1024).toFixed(0) + ' KB');

  const trans = parseTranslations(enText);
  const items = parseItemsGame(igText, trans);

  const out = {
    _note:    'Auto-generated by fetch-items.js. Re-run when new content releases.',
    _source:  itemsGameUrl,
    _updated: new Date().toISOString().slice(0, 10),
    ...items,
  };

  fs.writeFileSync(ITEMS_FILE, JSON.stringify(out, null, 2));

  const keychains = parseKeychainDefinitions(igText, trans);
  fs.writeFileSync(KEYCHAINS_FILE, JSON.stringify(keychains, null, 2));

  console.log('\nWrote: ' + ITEMS_FILE);
  console.log('Wrote: ' + KEYCHAINS_FILE + ' (' + Object.keys(keychains).length + ' charms)');
  // Build collections.json — try ByMykel API first (always current), fall back to VDF parser
  console.log('\nBuilding collections.json...');
  let collections = null;
  try {
    collections = await buildCollectionsFromByMykel();
    const count = Object.keys(collections).length;
    if (count === 0) throw new Error('ByMykel returned 0 collections');
    fs.writeFileSync(COLLECTIONS_FILE, JSON.stringify(collections, null, 2));
    console.log('Wrote: ' + COLLECTIONS_FILE + ' (from ByMykel API)');
    console.log('Collections: ' + count + ', skins: ' + Object.values(collections).reduce((s,c)=>s+Object.keys(c).length,0));
  } catch(e) {
    console.log('  ByMykel fetch failed (' + e.message + ') — falling back to VDF parser...');
    try {
      collections = buildCollections(igText, trans);
      const count = Object.keys(collections).length;
      fs.writeFileSync(COLLECTIONS_FILE, JSON.stringify(collections, null, 2));
      console.log('Wrote: ' + COLLECTIONS_FILE + ' (from VDF parser)');
      console.log('Collections: ' + count);
      if (count === 0) console.warn('  WARNING: VDF parser returned 0 collections — check items_game.txt source');
    } catch(e2) {
      console.error('Both collection sources failed: ' + e2.message);
      console.error('  (existing collections.json kept)');
    }
  }


  console.log('Total: ' + Object.keys(items).length + ' items');

  // Auto-apply known patches for recent items skinledger may be missing
  try {
    require('./patch-items.js');
  } catch(e) { /* patch file optional */ }
  console.log('\nSample:');
  Object.entries(items).slice(0, 8).forEach(([k, v]) => console.log('  ' + k + ': ' + v));
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(SESSION_FILE)) {
    console.error('No session.json — start the main app first to log in, then re-run this.');
    process.exit(1);
  }

  const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  if (!session.refreshToken) {
    console.error('session.json has no refreshToken — log in via the main app first.');
    process.exit(1);
  }

  console.log('Connecting to Steam to get Valve\'s items_game_url...');

  const client = new SteamUser();
  const csgo   = new GlobalOffensive(client);

  let gcUrl    = null;
  let finished = false;

  async function finish(url) {
    if (finished) return;
    finished = true;
    const tryUrls = url === FALLBACK_URL
      ? [...STEAMDB_ITEMS_URLS, FALLBACK_URL]        // no GC url: try all SteamDB paths then skinledger
      : [url, ...STEAMDB_ITEMS_URLS, FALLBACK_URL];  // have GC url: try it, then all SteamDB, then skinledger
    for (const u of tryUrls) {
      try {
        await buildItems(u);
        break;
      } catch(e) {
        console.error('Fetch failed (' + u + '): ' + e.message);
        if (u === FALLBACK_URL) console.error('All sources failed.');
        else console.log('Trying next source...');
      }
    }
    client.logOff();
    process.exit(0);
  }

  // UpdateItemSchema = msg 1049
  // The globaloffensive library passes payload as a protobuf object (not Buffer) for protobuf messages
  // We hook csgo's debug event to see all messages, and also hook raw receivedFromGC
  const Protos = require('./node_modules/globaloffensive/protobufs/generated/base_gcmessages.js');

  // Hook debug to log all GC messages and scan for schema URL
  csgo.on('debug', msg => {
    if (msg.includes('UpdateItemSchema') && !gcUrl) {
      console.log('[GC debug] ' + msg + ' — scanning for URL...');
    }
  });

  // Also hook receivedFromGC directly on the steam client
  client.on('receivedFromGC', (appid, msgType, payload) => {
    if (appid !== 730 || gcUrl) return;
    try {
      // payload may be a Buffer or a protobuf object
      let buf;
      if (Buffer.isBuffer(payload)) {
        buf = payload;
      } else if (payload && typeof payload === 'object' && payload.toBuffer) {
        buf = payload.toBuffer();
      } else if (payload && typeof payload === 'object' && payload.items_game_url) {
        // Already decoded protobuf object
        gcUrl = payload.items_game_url;
        console.log('Got items_game_url (decoded) from msgType ' + msgType + ': ' + gcUrl);
        return;
      } else {
        try { buf = Buffer.from(payload); } catch(e) { return; }
      }
      // Try proto decode for msg 1049
      if (msgType === 1049) {
        const msg = Protos.CMsgUpdateItemSchema.decode(buf);
        if (msg.items_game_url) {
          gcUrl = msg.items_game_url;
          console.log('Got items_game_url from GC (proto): ' + gcUrl);
          return;
        }
      }
      // Raw scan every message for https:// items_game URL
      const str = buf.toString('latin1');
      const idx = str.indexOf('https://');
      if (idx !== -1) {
        let end = idx;
        while (end < str.length && str.charCodeAt(end) >= 32 && str.charCodeAt(end) < 127) end++;
        const url = str.slice(idx, end);
        if (url.includes('items_game') && url.length > 30) {
          gcUrl = url;
          console.log('Got items_game_url (scan) from msgType ' + msgType + ': ' + gcUrl);
        }
      }
    } catch(e) { /* ignore */ }
  });

  csgo.on('connectedToGC', () => {
    console.log('GC connected. Waiting for UpdateItemSchema message...');
    setTimeout(() => {
      if (gcUrl) {
        finish(gcUrl);
      } else {
        console.log('No items_game_url from GC — trying SteamDatabase...');
        finish(FALLBACK_URL);
      }
    }, 8000);
  });

  client.on('loggedOn', () => {
    console.log('Steam logged in. Launching CS2 GC...');
    client.gamesPlayed([730]);
  });

  client.on('error', e => {
    console.error('Steam error:', e.message);
    process.exit(1);
  });

  setTimeout(() => {
    if (!finished) {
      console.log('Timeout — trying SteamDatabase...');
      finish(FALLBACK_URL);
    }
  }, 35000);

  client.logOn({ refreshToken: session.refreshToken });
}

main();
