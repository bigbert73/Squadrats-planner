/**
 * popular.js — how "popular" a track is, for the "Popularne" planning mode.
 *
 * Two open sources, both usable without anyone's permission:
 *  - OpenStreetMap public GPS traces, rendered by OSMF as density tiles
 *    (gps.tile.openstreetmap.org/lines): palette PNGs whose alpha grows with
 *    the number of traces through a pixel. Fetched on demand, cached on disk
 *    (data/gpstiles) and in memory — politely, a handful at a time;
 *  - signed cycle routes and cycleways from the local OSM extract
 *    (data/popular.db, built by popular-import.js).
 *
 * popularity(coords) → { share, gps, network } — share of the track (0..1,
 * length-weighted) on roads that are busy with traces or part of the cycle
 * network.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const axios = require('axios');
const Database = require('better-sqlite3');

const DATA_DIR = path.dirname(process.env.DB_PATH || path.join(__dirname, '../../data/squadrats.db'));
const CELLS_DB = path.join(DATA_DIR, 'popular.db');
const TILE_DIR = path.join(DATA_DIR, 'gpstiles');
const GPS_URL = 'https://gps.tile.openstreetmap.org/lines';
const GPS_Z = 13;                         // ~12 m/px in Poland, 3 km tiles
const TILE_MAX_AGE_MS = 60 * 864e5;       // re-fetch after 60 days
const MEM_TILES = 600;                    // decoded tiles kept in memory (64 KB each)
const FETCH_CONCURRENCY = 4;
const UA = 'SquadratsPlanner/2.0 (personal bike route planner; self-hosted)';
const STEP_KM = 0.025;
// A pixel's alpha saturates after a few traces, so it only says "someone
// recorded a track here". What grows with the number of riders is the width
// of the band: GPS scatter spreads many traces ±10-20 m across the road.
// Measure the share of lit pixels in a 5×5 window (±24 m) around the point:
// a lone trace fills ~15-25%, a well-ridden path 60-90%.
const ALPHA_ON = 40, WIN = 2, FILL_LO = 0.15, FILL_HI = 0.7;
const W_ROUTE = 1, W_CYCLEWAY = 0.8;

// ── cycle network cells ─────────────────────────────────────────────────────

let cells = null, cellsMtime = 0, cellZ = 18;
function loadCells() {
  let st;
  try { st = fs.statSync(CELLS_DB); } catch { cells = null; return null; }
  if (cells && st.mtimeMs === cellsMtime) return cells;
  const db = new Database(CELLS_DB, { readonly: true });
  try {
    cellZ = Number(db.prepare("SELECT value FROM meta WHERE key='zoom'").get()?.value || 18);
    const n = db.prepare('SELECT COUNT(*) AS n FROM cells').get().n;
    const keys = new Float64Array(n), w = new Uint8Array(n);
    let i = 0;
    for (const r of db.prepare('SELECT k, w FROM cells ORDER BY k').iterate()) { keys[i] = r.k; w[i] = r.w; i++; }
    cells = { keys, w };
    cellsMtime = st.mtimeMs;
  } finally { db.close(); }
  return cells;
}
function cellWeight(lat, lng) {
  const c = loadCells();
  if (!c) return 0;
  const n = 2 ** cellZ;
  const k = tileXf(lng, n) | 0, y = tileYf(lat, n) | 0;
  const key = k * n + y;
  let lo = 0, hi = c.keys.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, v = c.keys[mid];
    if (v === key) return c.w[mid] & 1 ? W_ROUTE : W_CYCLEWAY;
    if (v < key) lo = mid + 1; else hi = mid - 1;
  }
  return 0;
}

// ── GPS trace tiles ─────────────────────────────────────────────────────────

const tileXf = (lng, n) => (lng + 180) / 360 * n;
const tileYf = (lat, n) => {
  const r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n;
};

// Minimal PNG decoder → per-pixel alpha (Uint8Array 256×256). Handles what
// the GPS tile server produces (8-bit palette with tRNS) plus 8-bit RGBA /
// grey+alpha for safety.
function pngAlpha(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let i = 8, w = 0, h = 0, depth = 0, type = 0, trns = null;
  const idat = [];
  while (i < buf.length) {
    const len = buf.readUInt32BE(i), t = buf.toString('ascii', i + 4, i + 8), d = buf.subarray(i + 8, i + 8 + len);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; if (d[12]) throw new Error('interlaced PNG'); }
    else if (t === 'tRNS') trns = d;
    else if (t === 'IDAT') idat.push(d);
    else if (t === 'IEND') break;
    i += 12 + len;
  }
  // Sub-byte depths only for palette/grey (empty tiles come as 1-bit palette)
  if (depth !== 8 && !(depth < 8 && (type === 3 || type === 0))) throw new Error('unsupported PNG ' + type + '/' + depth);
  const bpp = depth < 8 ? 1 : { 3: 1, 6: 4, 4: 2, 0: 1, 2: 3 }[type];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = depth < 8 ? Math.ceil(w * depth / 8) : w * bpp, out = new Uint8Array(w * h);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const idx = depth < 8 ? (cur[(x * depth) >> 3] >> (8 - depth - ((x * depth) & 7))) & ((1 << depth) - 1) : cur[x];
      out[y * w + x] =
        type === 3 ? (trns && idx < trns.length ? trns[idx] : 255) :
        type === 0 && depth < 8 ? (idx ? 255 : 0) :
        type === 6 ? cur[x * 4 + 3] :
        type === 4 ? cur[x * 2 + 1] : 255;
    }
    [prev, cur] = [cur, prev];
  }
  return out;
}

const mem = new Map();        // "x,y" → Uint8Array alpha | null (empty / unavailable)
const pending = new Map();    // "x,y" → Promise
let active = 0;
const queue = [];
const slot = () => new Promise((res) => { if (active < FETCH_CONCURRENCY) { active++; res(); } else queue.push(res); });
const release = () => { const next = queue.shift(); if (next) next(); else active--; };

function remember(key, v) {
  mem.delete(key);
  mem.set(key, v);
  if (mem.size > MEM_TILES) mem.delete(mem.keys().next().value);
  return v;
}

async function loadTile(x, y) {
  const key = `${x},${y}`;
  if (mem.has(key)) return remember(key, mem.get(key));
  if (pending.has(key)) return pending.get(key);
  const p = (async () => {
    const file = path.join(TILE_DIR, String(GPS_Z), String(x), `${y}.png`);
    let buf = null;
    try {
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs < TILE_MAX_AGE_MS) buf = fs.readFileSync(file);
    } catch {}
    if (!buf) {
      await slot();
      try {
        const r = await axios.get(`${GPS_URL}/${GPS_Z}/${x}/${y}.png`, { responseType: 'arraybuffer', timeout: 8000, headers: { 'User-Agent': UA } });
        buf = Buffer.from(r.data);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, buf);
      } catch (e) {
        // Keep an older copy if we have one; otherwise this tile counts as
        // "no data" for now (not cached, retried next time).
        try { buf = fs.readFileSync(file); } catch { return null; }
      } finally { release(); }
    }
    try { return remember(key, pngAlpha(buf)); } catch { return remember(key, null); }
  })().finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}

// Trace density around a point, 0..1
function gpsWeight(tile, px, py) {
  if (!tile) return 0;
  let on = 0, tot = 0;
  for (let dy = -WIN; dy <= WIN; dy++) for (let dx = -WIN; dx <= WIN; dx++) {
    const x = px + dx, y = py + dy;
    if (x >= 0 && x < 256 && y >= 0 && y < 256) { tot++; if (tile[y * 256 + x] > ALPHA_ON) on++; }
  }
  return Math.max(0, Math.min(1, (on / tot - FILL_LO) / (FILL_HI - FILL_LO)));
}

// ── scoring ─────────────────────────────────────────────────────────────────

function hav(a, b) {
  const r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lng - a.lng) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function popularity(coords) {
  const pts = [];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    const n = Math.max(1, Math.ceil(hav(a, b) / STEP_KM));
    for (let k = 0; k < n; k++) pts.push({ lat: a.lat + (b.lat - a.lat) * k / n, lng: a.lng + (b.lng - a.lng) * k / n });
  }
  if (!pts.length) return { share: 0, gps: 0, network: 0 };
  const n = 2 ** GPS_Z;
  const pix = pts.map(p => ({ fx: tileXf(p.lng, n), fy: tileYf(p.lat, n) }));
  const need = new Set(pix.map(q => `${Math.floor(q.fx)},${Math.floor(q.fy)}`));
  const got = new Map();
  await Promise.all([...need].map(async (k) => { const [x, y] = k.split(',').map(Number); got.set(k, await loadTile(x, y)); }));
  let share = 0, gps = 0, net = 0;
  pts.forEach((p, i) => {
    const { fx, fy } = pix[i];
    const tx = Math.floor(fx), ty = Math.floor(fy);
    const g = gpsWeight(got.get(`${tx},${ty}`), Math.floor((fx - tx) * 256), Math.floor((fy - ty) * 256));
    const c = cellWeight(p.lat, p.lng);
    gps += g; net += c > 0 ? 1 : 0;
    share += Math.max(g, c);
  });
  return { share: share / pts.length, gps: gps / pts.length, network: net / pts.length };
}

module.exports = { popularity, pngAlpha, available: () => !!loadCells() };
