/**
 * db.js — SQLite database layer
 *
 * Schema:
 *   activities      — Strava activities we've already processed (prevents re-import)
 *   tiles_sq        — zoom-14 squadrat tiles the user has visited
 *   tiles_sqi       — zoom-17 squadratinho tiles
 *   tokens          — Strava OAuth tokens (single-row table)
 */

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/squadrats.db');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Performance pragmas — safe for single-writer use
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -32000');  // 32 MB
db.pragma('foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS tokens (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    access_token  TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at    INTEGER NOT NULL,
    athlete_id    INTEGER,
    athlete_json  TEXT
  );

  CREATE TABLE IF NOT EXISTS activities (
    strava_id     INTEGER PRIMARY KEY,
    name          TEXT,
    sport_type    TEXT,
    start_date    TEXT,
    distance_m    REAL,
    processed_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tiles_sq (
    tx   INTEGER NOT NULL,
    ty   INTEGER NOT NULL,
    PRIMARY KEY (tx, ty)
  );

  CREATE TABLE IF NOT EXISTS tiles_sqi (
    tx   INTEGER NOT NULL,
    ty   INTEGER NOT NULL,
    PRIMARY KEY (tx, ty)
  );

  -- Index for fast bounding-box queries
  CREATE INDEX IF NOT EXISTS idx_sq_tx  ON tiles_sq (tx);
  CREATE INDEX IF NOT EXISTS idx_sq_ty  ON tiles_sq (ty);
  CREATE INDEX IF NOT EXISTS idx_sqi_tx ON tiles_sqi (tx);
  CREATE INDEX IF NOT EXISTS idx_sqi_ty ON tiles_sqi (ty);
`);

// ── Prepared statements ───────────────────────────────────────────────────────

const stmts = {
  // Tokens
  upsertToken: db.prepare(`
    INSERT INTO tokens (id, access_token, refresh_token, expires_at, athlete_id, athlete_json)
    VALUES (1, @access_token, @refresh_token, @expires_at, @athlete_id, @athlete_json)
    ON CONFLICT(id) DO UPDATE SET
      access_token  = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at    = excluded.expires_at,
      athlete_id    = excluded.athlete_id,
      athlete_json  = excluded.athlete_json
  `),
  getToken: db.prepare('SELECT * FROM tokens WHERE id = 1'),
  clearToken: db.prepare('DELETE FROM tokens WHERE id = 1'),

  // Activities
  insertActivity: db.prepare(`
    INSERT OR IGNORE INTO activities (strava_id, name, sport_type, start_date, distance_m)
    VALUES (@strava_id, @name, @sport_type, @start_date, @distance_m)
  `),
  hasActivity: db.prepare('SELECT 1 FROM activities WHERE strava_id = ?'),
  countActivities: db.prepare('SELECT COUNT(*) as n FROM activities'),
  latestActivityDate: db.prepare(
    "SELECT start_date FROM activities ORDER BY start_date DESC LIMIT 1"
  ),

  // Tiles SQ (zoom 14)
  insertTileSQ:  db.prepare('INSERT OR IGNORE INTO tiles_sq (tx, ty) VALUES (?, ?)'),
  countTilesSQ:  db.prepare('SELECT COUNT(*) as n FROM tiles_sq'),
  getTilesSQ:    db.prepare('SELECT tx, ty FROM tiles_sq'),
  getTilesSQBbox:db.prepare('SELECT tx, ty FROM tiles_sq WHERE tx BETWEEN ? AND ? AND ty BETWEEN ? AND ?'),

  // Tiles SQI (zoom 17)
  insertTileSQI:  db.prepare('INSERT OR IGNORE INTO tiles_sqi (tx, ty) VALUES (?, ?)'),
  countTilesSQI:  db.prepare('SELECT COUNT(*) as n FROM tiles_sqi'),
  getTilesSQI:    db.prepare('SELECT tx, ty FROM tiles_sqi'),
  getTilesSQIBbox:db.prepare('SELECT tx, ty FROM tiles_sqi WHERE tx BETWEEN ? AND ? AND ty BETWEEN ? AND ?'),
};

// ── Batch insert helper (uses transaction for speed) ─────────────────────────

const insertTilesSQBatch  = db.transaction((tiles) => {
  for (const [tx, ty] of tiles) stmts.insertTileSQ.run(tx, ty);
});

const insertTilesSQIBatch = db.transaction((tiles) => {
  for (const [tx, ty] of tiles) stmts.insertTileSQI.run(tx, ty);
});

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  db,
  stmts,
  insertTilesSQBatch,
  insertTilesSQIBatch,

  // Convenience wrappers
  getToken()  { return stmts.getToken.get(); },
  saveToken(t){ stmts.upsertToken.run(t); },
  clearToken(){ stmts.clearToken.run(); },

  hasActivity(id)    { return !!stmts.hasActivity.get(id); },
  saveActivity(act)  { stmts.insertActivity.run(act); },
  getActivityCount() { return stmts.countActivities.get().n; },
  getLatestDate()    { return stmts.latestActivityDate.get()?.start_date || null; },

  getSQCount()  { return stmts.countTilesSQ.get().n; },
  getSQICount() { return stmts.countTilesSQI.get().n; },

  // Return all tiles as flat array of {tx,ty}
  getAllTilesSQ()    { return stmts.getTilesSQ.all(); },
  getAllTilesSQI()   { return stmts.getTilesSQI.all(); },

  // Bounding-box query (for viewport culling in API)
  getTilesSQBbox(x0, x1, y0, y1)  { return stmts.getTilesSQBbox.all(x0, x1, y0, y1); },
  getTilesSQIBbox(x0, x1, y0, y1) { return stmts.getTilesSQIBbox.all(x0, x1, y0, y1); },
};
