/**
 * reach.js — which squadratinhos have no road or path at all (data/reach.db,
 * built by reach-import.js). Those are suggested as impossible to collect.
 *
 *   status(x, y) → 1 road passes through, 0 no road, -1 unknown (outside data)
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.dirname(process.env.DB_PATH || path.join(__dirname, '../../data/squadrats.db'));
const REACH_DB = path.join(DATA_DIR, 'reach.db');

let blocks = null, mtime = 0, B = 5, checkedAt = 0;
function load() {
  // status() runs for hundreds of thousands of tiles per request: look at the
  // file on disk at most every few seconds, not on every call
  const now = Date.now();
  if (now - checkedAt < 5000) return blocks;
  checkedAt = now;
  let st;
  try { st = fs.statSync(REACH_DB); } catch { blocks = null; return null; }
  if (blocks && st.mtimeMs === mtime) return blocks;
  const db = new Database(REACH_DB, { readonly: true });
  try {
    B = Number(db.prepare("SELECT value FROM meta WHERE key='block_bits'").get()?.value || 5);
    const m = new Map();
    for (const r of db.prepare('SELECT k, road, inside FROM blocks').iterate()) m.set(r.k, { road: r.road, inside: r.inside });
    blocks = m;
    mtime = st.mtimeMs;
  } finally { db.close(); }
  return blocks;
}

function status(x, y) {
  const m = load();
  if (!m) return -1;
  const b = m.get((x >> B) * 4096 + (y >> B));
  if (!b) return -1;
  const s = (1 << B) - 1, i = (y & s) * (1 << B) + (x & s), bit = 1 << (i & 7);
  if (b.inside && !(b.inside[i >> 3] & bit)) return -1;
  return b.road[i >> 3] & bit ? 1 : 0;
}

// Tiles without a road in a z17 tile range, skipping the given key set ("x,y")
function noRoadIn(x0, y0, x1, y1, skip) {
  const out = [];
  if (!load()) return out;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (status(x, y) === 0 && !skip.has(`${x},${y}`)) out.push([x, y]);
  }
  return out;
}

module.exports = { status, noRoadIn, available: () => !!load() };
