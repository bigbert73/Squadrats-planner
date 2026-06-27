/**
 * db.js — SQLite database layer (multi-user)
 */

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const bcrypt   = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/squadrats.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -32000');
db.pragma('foreign_keys = ON');

// ── Target schema ─────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    username             TEXT UNIQUE NOT NULL COLLATE NOCASE,
    email                TEXT UNIQUE COLLATE NOCASE,
    password_hash        TEXT NOT NULL,
    role                 TEXT NOT NULL DEFAULT 'user',
    strava_client_id     TEXT,
    strava_client_secret TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    last_login           TEXT
  );

  CREATE TABLE IF NOT EXISTS strava_tokens (
    user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    access_token  TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at    INTEGER NOT NULL,
    athlete_id    INTEGER,
    athlete_json  TEXT
  );

  CREATE TABLE IF NOT EXISTS activities (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    strava_id    INTEGER NOT NULL,
    name         TEXT,
    sport_type   TEXT,
    start_date   TEXT,
    distance_m   REAL,
    processed_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, strava_id)
  );

  CREATE TABLE IF NOT EXISTS tiles_sq (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tx      INTEGER NOT NULL,
    ty      INTEGER NOT NULL,
    PRIMARY KEY (user_id, tx, ty)
  );

  CREATE TABLE IF NOT EXISTS tiles_sqi (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tx      INTEGER NOT NULL,
    ty      INTEGER NOT NULL,
    PRIMARY KEY (user_id, tx, ty)
  );
`;

// ── Migration (single-user → multi-user) ──────────────────────────────────────

function generatePassword(len = 14) {
  const ch = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%';
  return Array.from({ length: len }, () => ch[Math.floor(Math.random() * ch.length)]).join('');
}

function runMigration() {
  const hasOldTiles = db.prepare(
    "SELECT count(*) as n FROM sqlite_master WHERE type='table' AND name='tiles_sq'"
  ).get().n > 0;

  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  let adminPassword   = process.env.ADMIN_PASSWORD;
  let generated       = false;
  if (!adminPassword) { adminPassword = generatePassword(); generated = true; }

  const hash = bcrypt.hashSync(adminPassword, 10);

  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        username             TEXT UNIQUE NOT NULL COLLATE NOCASE,
        email                TEXT UNIQUE COLLATE NOCASE,
        password_hash        TEXT NOT NULL,
        role                 TEXT NOT NULL DEFAULT 'user',
        strava_client_id     TEXT,
        strava_client_secret TEXT,
        created_at           TEXT NOT NULL DEFAULT (datetime('now')),
        last_login           TEXT
      );
      CREATE TABLE IF NOT EXISTS strava_tokens (
        user_id       INTEGER PRIMARY KEY,
        access_token  TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at    INTEGER NOT NULL,
        athlete_id    INTEGER,
        athlete_json  TEXT
      );
    `);

    db.prepare(
      "INSERT OR IGNORE INTO users (username,password_hash,role,strava_client_id,strava_client_secret) VALUES (?,?,?,?,?)"
    ).run(adminUsername, hash, 'admin',
      process.env.STRAVA_CLIENT_ID     || null,
      process.env.STRAVA_CLIENT_SECRET || null
    );

    const adminId = db.prepare("SELECT id FROM users WHERE username = ?").get(adminUsername).id;

    if (hasOldTiles) {
      try { db.exec("ALTER TABLE tiles_sq   RENAME TO tiles_sq_old");  } catch(_) {}
      try { db.exec("ALTER TABLE tiles_sqi  RENAME TO tiles_sqi_old"); } catch(_) {}
      try { db.exec("ALTER TABLE activities RENAME TO activities_old"); } catch(_) {}

      db.exec(`
        CREATE TABLE IF NOT EXISTS tiles_sq (
          user_id INTEGER NOT NULL, tx INTEGER NOT NULL, ty INTEGER NOT NULL,
          PRIMARY KEY (user_id, tx, ty)
        );
        CREATE TABLE IF NOT EXISTS tiles_sqi (
          user_id INTEGER NOT NULL, tx INTEGER NOT NULL, ty INTEGER NOT NULL,
          PRIMARY KEY (user_id, tx, ty)
        );
        CREATE TABLE IF NOT EXISTS activities (
          user_id INTEGER NOT NULL, strava_id INTEGER NOT NULL,
          name TEXT, sport_type TEXT, start_date TEXT, distance_m REAL,
          processed_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (user_id, strava_id)
        );
      `);

      db.prepare(`INSERT INTO tiles_sq  SELECT ${adminId}, tx, ty FROM tiles_sq_old`).run();
      db.prepare(`INSERT INTO tiles_sqi SELECT ${adminId}, tx, ty FROM tiles_sqi_old`).run();
      db.prepare(`INSERT INTO activities SELECT ${adminId},strava_id,name,sport_type,start_date,distance_m,processed_at FROM activities_old`).run();

      const oldTok = db.prepare("SELECT * FROM tokens WHERE id = 1").get();
      if (oldTok) {
        db.prepare("INSERT OR IGNORE INTO strava_tokens VALUES (?,?,?,?,?,?)")
          .run(adminId, oldTok.access_token, oldTok.refresh_token, oldTok.expires_at, oldTok.athlete_id, oldTok.athlete_json);
      }

      db.exec("DROP TABLE IF EXISTS tiles_sq_old; DROP TABLE IF EXISTS tiles_sqi_old; DROP TABLE IF EXISTS activities_old; DROP TABLE IF EXISTS tokens;");
    }
  })();

  if (generated) {
    console.log('\n' + '═'.repeat(58));
    console.log('  MIGRACJA MULTI-USER');
    console.log(`  Admin: ${adminUsername}   Hasło: ${adminPassword}`);
    console.log('  ⚠️  Zapisz to hasło — nie zostanie pokazane ponownie!');
    console.log('═'.repeat(58) + '\n');
  } else {
    console.log(`[DB] Admin: ${adminUsername} (hasło z ADMIN_PASSWORD)`);
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const hasUsers = db.prepare("SELECT count(*) as n FROM sqlite_master WHERE type='table' AND name='users'").get().n > 0;
if (!hasUsers) runMigration();
db.exec(SCHEMA_SQL);

// ── Prepared statements ───────────────────────────────────────────────────────

const q = {
  insertUser:       db.prepare("INSERT INTO users (username,email,password_hash,role,strava_client_id,strava_client_secret) VALUES (@username,@email,@password_hash,@role,@strava_client_id,@strava_client_secret)"),
  getUserById:      db.prepare("SELECT * FROM users WHERE id = ?"),
  getUserByName:    db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE"),
  getUserByEmail:   db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE"),
  getAllUsers:       db.prepare("SELECT id,username,email,role,strava_client_id,created_at,last_login FROM users ORDER BY id"),
  countUsers:       db.prepare("SELECT count(*) as n FROM users"),
  updateRole:       db.prepare("UPDATE users SET role = ? WHERE id = ?"),
  updateStrava:     db.prepare("UPDATE users SET strava_client_id = ?, strava_client_secret = ? WHERE id = ?"),
  updateLastLogin:  db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?"),
  updatePassHash:   db.prepare("UPDATE users SET password_hash = ? WHERE id = ?"),
  deleteUser:       db.prepare("DELETE FROM users WHERE id = ?"),

  upsertToken:      db.prepare(`INSERT INTO strava_tokens (user_id,access_token,refresh_token,expires_at,athlete_id,athlete_json) VALUES (@user_id,@access_token,@refresh_token,@expires_at,@athlete_id,@athlete_json) ON CONFLICT(user_id) DO UPDATE SET access_token=excluded.access_token,refresh_token=excluded.refresh_token,expires_at=excluded.expires_at,athlete_id=excluded.athlete_id,athlete_json=excluded.athlete_json`),
  getToken:         db.prepare("SELECT * FROM strava_tokens WHERE user_id = ?"),
  clearToken:       db.prepare("DELETE FROM strava_tokens WHERE user_id = ?"),

  insertActivity:   db.prepare("INSERT OR IGNORE INTO activities (user_id,strava_id,name,sport_type,start_date,distance_m) VALUES (@user_id,@strava_id,@name,@sport_type,@start_date,@distance_m)"),
  hasActivity:      db.prepare("SELECT 1 FROM activities WHERE user_id = ? AND strava_id = ?"),
  countActivities:  db.prepare("SELECT count(*) as n FROM activities WHERE user_id = ?"),
  latestDate:       db.prepare("SELECT start_date FROM activities WHERE user_id = ? ORDER BY start_date DESC LIMIT 1"),

  insertTileSQ:     db.prepare("INSERT OR IGNORE INTO tiles_sq (user_id,tx,ty) VALUES (?,?,?)"),
  countTilesSQ:     db.prepare("SELECT count(*) as n FROM tiles_sq WHERE user_id = ?"),
  getTilesSQ:       db.prepare("SELECT tx,ty FROM tiles_sq WHERE user_id = ?"),
  getTilesSQBbox:   db.prepare("SELECT tx,ty FROM tiles_sq WHERE user_id = ? AND tx BETWEEN ? AND ? AND ty BETWEEN ? AND ?"),

  insertTileSQI:    db.prepare("INSERT OR IGNORE INTO tiles_sqi (user_id,tx,ty) VALUES (?,?,?)"),
  countTilesSQI:    db.prepare("SELECT count(*) as n FROM tiles_sqi WHERE user_id = ?"),
  getTilesSQI:      db.prepare("SELECT tx,ty FROM tiles_sqi WHERE user_id = ?"),
  getTilesSQIBbox:  db.prepare("SELECT tx,ty FROM tiles_sqi WHERE user_id = ? AND tx BETWEEN ? AND ? AND ty BETWEEN ? AND ?"),
};

const batchSQ  = db.transaction((userId, tiles) => { for (const [tx,ty] of tiles) q.insertTileSQ.run(userId,tx,ty); });
const batchSQI = db.transaction((userId, tiles) => { for (const [tx,ty] of tiles) q.insertTileSQI.run(userId,tx,ty); });

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  db,

  // User management
  createUser(username, passwordHash, email) {
    const role = q.countUsers.get().n === 0 ? 'admin' : 'user';
    return q.insertUser.run({ username, email: email || null, password_hash: passwordHash, role, strava_client_id: null, strava_client_secret: null });
  },
  getUserById(id)          { return q.getUserById.get(id); },
  getUserByUsername(u)     { return q.getUserByName.get(u); },
  getUserByEmail(e)        { return q.getUserByEmail.get(e); },
  getAllUsers()             { return q.getAllUsers.all(); },
  getUserCount()           { return q.countUsers.get().n; },
  updateUserRole(id, role) { q.updateRole.run(role, id); },
  updateStravaCredentials(id, cid, csec) { q.updateStrava.run(cid, csec, id); },
  updateLastLogin(id)      { q.updateLastLogin.run(id); },
  updatePasswordHash(id, h){ q.updatePassHash.run(h, id); },
  deleteUser(id)           { q.deleteUser.run(id); },

  // Strava tokens
  getToken(userId)         { return q.getToken.get(userId); },
  saveToken(userId, t)     { q.upsertToken.run({ user_id: userId, ...t }); },
  clearToken(userId)       { q.clearToken.run(userId); },

  // Activities
  hasActivity(userId, id)  { return !!q.hasActivity.get(userId, id); },
  saveActivity(userId, act){ q.insertActivity.run({ user_id: userId, ...act }); },
  getActivityCount(userId) { return q.countActivities.get(userId).n; },
  getLatestDate(userId)    { return q.latestDate.get(userId)?.start_date || null; },

  // Tiles SQ
  getSQCount(userId)                      { return q.countTilesSQ.get(userId).n; },
  getAllTilesSQ(userId)                    { return q.getTilesSQ.all(userId); },
  getTilesSQBbox(userId, x0, x1, y0, y1) { return q.getTilesSQBbox.all(userId, x0, x1, y0, y1); },
  insertTilesSQBatch(userId, tiles)       { batchSQ(userId, tiles); },

  // Tiles SQI
  getSQICount(userId)                      { return q.countTilesSQI.get(userId).n; },
  getAllTilesSQI(userId)                    { return q.getTilesSQI.all(userId); },
  getTilesSQIBbox(userId, x0, x1, y0, y1) { return q.getTilesSQIBbox.all(userId, x0, x1, y0, y1); },
  insertTilesSQIBatch(userId, tiles)       { batchSQI(userId, tiles); },
};
