/**
 * photos.js — our own cache of Wikimedia Commons geotagged photos (data/photos.db).
 *
 * Commons geosearch is slow (~3 s) and throttled, and Wikimedia allows an
 * unidentified server only 10 req/min, so browsers do the fetching and hand
 * the results here. The map is split into fixed grid cells; a cell searched
 * once (all its geotagged files: id, position, title) is served from here
 * for CELL_TTL_DAYS. Image details (thumbnail, author, licence) are stored
 * per file as browsers fetch them. Only Wikimedia URLs are accepted, since
 * what one user's browser stores is shown to others.
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(path.dirname(process.env.DB_PATH || './data/squadrats.db'), 'photos.db');
const CELL_LAT = 0.02, CELL_LNG = 0.03;   // ~2.2 × 2 km around Warsaw
const CELL_TTL_DAYS = 60;
const MAX_HITS_PER_CELL = 2000;

let db = null;
function getDb() {
  if (db) return db;
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS commons_cells (cell TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, n INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS commons_files (
      pageid INTEGER PRIMARY KEY, lat REAL NOT NULL, lng REAL NOT NULL, title TEXT NOT NULL,
      thumb TEXT, page TEXT, author TEXT, date TEXT, license TEXT, info_at INTEGER);
    CREATE INDEX IF NOT EXISTS commons_files_pos ON commons_files(lat, lng);
  `);
  return db;
}

const cellOf = (lat, lng) => `${Math.floor(lat / CELL_LAT)},${Math.floor(lng / CELL_LNG)}`;
const validCell = (c) => typeof c === 'string' && /^-?\d{1,5},-?\d{1,5}$/.test(c);
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

// Cells searched recently enough to trust, out of those asked about.
function doneCells(cells) {
  const since = Date.now() - CELL_TTL_DAYS * 864e5;
  const q = getDb().prepare('SELECT 1 FROM commons_cells WHERE cell = ? AND fetched_at >= ?');
  return cells.filter(c => validCell(c) && q.get(c, since));
}

// km from a point to the polyline through pts (equirectangular)
function kmToPolyline(lat, lng, pts) {
  const kx = 111.32 * Math.cos(lat * Math.PI / 180), ky = 110.57;
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[Math.min(i + 1, pts.length - 1)];
    const ax = (a.lng - lng) * kx, ay = (a.lat - lat) * ky, dx = (b.lng - a.lng) * kx, dy = (b.lat - a.lat) * ky, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

// Cached files within corridorKm of the route samples.
function filesNear(samples, corridorKm) {
  if (!samples.length) return [];
  const pad = corridorKm / 111 * 1.6;
  let s = 90, n = -90, w = 180, e = -180;
  for (const p of samples) { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lng); e = Math.max(e, p.lng); }
  const rows = getDb().prepare('SELECT * FROM commons_files WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?')
    .all(s - pad, n + pad, w - pad * 1.7, e + pad * 1.7);
  return rows.filter(r => kmToPolyline(r.lat, r.lng, samples) <= corridorKm);
}

const saveCell = (cell, hits) => {
  if (!validCell(cell) || !Array.isArray(hits)) return 0;
  const d = getDb();
  const ins = d.prepare(`INSERT INTO commons_files (pageid, lat, lng, title) VALUES (?, ?, ?, ?)
    ON CONFLICT(pageid) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, title = excluded.title`);
  let n = 0;
  d.transaction(() => {
    for (const h of hits.slice(0, MAX_HITS_PER_CELL)) {
      const id = Number(h?.pageid), lat = Number(h?.lat), lng = Number(h?.lng);
      if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
      const title = str(h.title, 300);
      if (!/^File:.+\.(jpe?g|webp)$/i.test(title)) continue;
      ins.run(id, lat, lng, title); n++;
    }
    d.prepare('INSERT OR REPLACE INTO commons_cells (cell, fetched_at, n) VALUES (?, ?, ?)').run(cell, Date.now(), n);
  })();
  return n;
};

const THUMB_RE = /^https:\/\/(upload|thumb)\.wikimedia\.org\/wikipedia\/commons\/[\w%./()~,'!*+-]+$/;
const PAGE_RE = /^https:\/\/commons\.wikimedia\.org\/wiki\/File:[\w%./()~,'!*+-]+$/;
function saveInfo(items) {
  if (!Array.isArray(items)) return 0;
  const up = getDb().prepare(`UPDATE commons_files SET thumb = ?, page = ?, author = ?, date = ?, license = ?, info_at = ? WHERE pageid = ?`);
  let n = 0;
  getDb().transaction(() => {
    for (const it of items.slice(0, 500)) {
      const id = Number(it?.pageid);
      const thumb = str(it?.thumb, 1000).split('?')[0];   // drop Wikimedia's utm_* tracking params
      if (!Number.isInteger(id) || !THUMB_RE.test(thumb) || !PAGE_RE.test(it.page || '')) continue;
      n += up.run(thumb, it.page, str(it.author, 80), str(it.date, 10), str(it.license, 40), Date.now(), id).changes;
    }
  })();
  return n;
}

module.exports = { CELL_LAT, CELL_LNG, cellOf, doneCells, filesNear, saveCell, saveInfo };
