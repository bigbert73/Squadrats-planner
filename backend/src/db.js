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
    password_hash        TEXT,
    role                 TEXT NOT NULL DEFAULT 'user',
    strava_client_id     TEXT,
    strava_client_secret TEXT,
    oauth_provider       TEXT,
    oauth_id             TEXT,
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

  CREATE TABLE IF NOT EXISTS saved_routes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    distance_km    REAL NOT NULL,
    new_sq         INTEGER NOT NULL DEFAULT 0,
    new_sqi        INTEGER NOT NULL DEFAULT 0,
    mode           TEXT,
    profile        TEXT,
    is_loop        INTEGER NOT NULL DEFAULT 1,
    waypoints      TEXT NOT NULL,   -- JSON [{type,lat,lng,label}]
    coords         TEXT NOT NULL,   -- JSON [[lat,lng,elev], ...]
    elev_profile   TEXT,            -- JSON as returned by BRouter, or NULL
    surface_profile TEXT            -- JSON as returned by BRouter, or NULL
  );
  CREATE INDEX IF NOT EXISTS idx_saved_routes_user ON saved_routes(user_id, created_at);

  -- result of the last background / manual Strava sync per user
  CREATE TABLE IF NOT EXISTS sync_status (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    source     TEXT NOT NULL,     -- 'auto' | 'manual'
    at         TEXT NOT NULL,     -- ISO time the sync finished
    result     TEXT,              -- JSON {fetched, processed, newSQ, newSQI, ...}
    error      TEXT
  );

  -- squadratinhos the rider marked as impossible to collect (private land,
  -- no access); routing ignores them until they are actually collected
  CREATE TABLE IF NOT EXISTS blocked_sqi (
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

// ── OAuth migration (add oauth_provider/oauth_id, make password_hash nullable) ──
// Must run before the home-point/heatmap column migrations below: on a fresh DB
// it rebuilds the `users` table (DROP+RENAME), which would otherwise wipe out
// columns those migrations had just added.
(function migrateOAuth() {
  const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!cols.includes('oauth_provider')) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE users_oauth_tmp (
          id                   INTEGER PRIMARY KEY AUTOINCREMENT,
          username             TEXT UNIQUE NOT NULL COLLATE NOCASE,
          email                TEXT UNIQUE COLLATE NOCASE,
          password_hash        TEXT,
          role                 TEXT NOT NULL DEFAULT 'user',
          strava_client_id     TEXT,
          strava_client_secret TEXT,
          oauth_provider       TEXT,
          oauth_id             TEXT,
          created_at           TEXT NOT NULL DEFAULT (datetime('now')),
          last_login           TEXT
        );
        INSERT INTO users_oauth_tmp
          (id,username,email,password_hash,role,strava_client_id,strava_client_secret,created_at,last_login)
          SELECT id,username,email,password_hash,role,strava_client_id,strava_client_secret,created_at,last_login
          FROM users;
        DROP TABLE users;
        ALTER TABLE users_oauth_tmp RENAME TO users;
      `);
      try {
        db.exec("CREATE UNIQUE INDEX idx_users_oauth ON users(oauth_provider,oauth_id) WHERE oauth_provider IS NOT NULL");
      } catch(_) {}
    })();
    console.log('[DB] Migracja: dodano kolumny OAuth (oauth_provider, oauth_id)');
  } else {
    try {
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oauth ON users(oauth_provider,oauth_id) WHERE oauth_provider IS NOT NULL");
    } catch(_) {}
  }
})();

// ── Home point migration ───────────────────────────────────────────────────────
(function migrateHomePoint() {
  try { db.exec("ALTER TABLE users ADD COLUMN home_lat REAL"); } catch(_) {}
  try { db.exec("ALTER TABLE users ADD COLUMN home_lng REAL"); } catch(_) {}
})();

// ── Garmin device key: lets the Connect IQ data field fetch tiles without a
// browser session (sent as ?key=, no cookies on the watch side) ──────────────
(function migrateGarminKey() {
  try { db.exec("ALTER TABLE users ADD COLUMN garmin_key TEXT"); } catch(_) {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_garmin_key ON users(garmin_key)"); } catch(_) {}
})();

// ── Strava heatmap session cookies (feature removed) ─────────────────────────
// The heatmap proxy used to store a user's Strava session cookie; wipe any
// that are left. The columns stay so old databases still open.
(function dropHeatmapCreds() {
  try { db.exec("UPDATE users SET hm_kp = NULL, hm_pol = NULL, hm_sig = NULL WHERE hm_kp IS NOT NULL OR hm_pol IS NOT NULL OR hm_sig IS NOT NULL"); } catch(_) {}
})();

// ── Prepared statements ───────────────────────────────────────────────────────

const q = {
  insertUser:       db.prepare("INSERT INTO users (username,email,password_hash,role,strava_client_id,strava_client_secret) VALUES (@username,@email,@password_hash,@role,@strava_client_id,@strava_client_secret)"),
  getUserById:      db.prepare("SELECT * FROM users WHERE id = ?"),
  getUserByName:    db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE"),
  getUserByEmail:   db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE"),
  getAllUsers:       db.prepare("SELECT id,username,email,role,strava_client_id,oauth_provider,created_at,last_login FROM users ORDER BY id"),
  countUsers:       db.prepare("SELECT count(*) as n FROM users"),
  updateRole:       db.prepare("UPDATE users SET role = ? WHERE id = ?"),
  updateStrava:     db.prepare("UPDATE users SET strava_client_id = ?, strava_client_secret = ? WHERE id = ?"),
  updateLastLogin:  db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?"),
  updatePassHash:   db.prepare("UPDATE users SET password_hash = ? WHERE id = ?"),
  updateHome:       db.prepare("UPDATE users SET home_lat = ?, home_lng = ? WHERE id = ?"),
  setGarminKey:     db.prepare("UPDATE users SET garmin_key = ? WHERE id = ?"),
  userByGarminKey:  db.prepare("SELECT id FROM users WHERE garmin_key = ?"),
  deleteUser:       db.prepare("DELETE FROM users WHERE id = ?"),

  getUserByOAuth:   db.prepare("SELECT * FROM users WHERE oauth_provider = ? AND oauth_id = ?"),
  insertOAuthUser:  db.prepare("INSERT INTO users (username,email,password_hash,role,oauth_provider,oauth_id) VALUES (?,?,NULL,?,?,?)"),
  linkOAuth:        db.prepare("UPDATE users SET oauth_provider=?, oauth_id=? WHERE id=?"),

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
  hasTileSQI:       db.prepare("SELECT 1 FROM tiles_sqi WHERE user_id = ? AND tx = ? AND ty = ?"),

  getBlockedSQI:    db.prepare("SELECT tx,ty FROM blocked_sqi WHERE user_id = ?"),
  hasBlockedSQI:    db.prepare("SELECT 1 FROM blocked_sqi WHERE user_id = ? AND tx = ? AND ty = ?"),
  addBlockedSQI:    db.prepare("INSERT OR IGNORE INTO blocked_sqi (user_id,tx,ty) VALUES (?,?,?)"),
  delBlockedSQI:    db.prepare("DELETE FROM blocked_sqi WHERE user_id = ? AND tx = ? AND ty = ?"),
  // once collected after all, a blocked tile stops being blocked
  listRoutes:       db.prepare("SELECT id,name,created_at,distance_km,new_sq,new_sqi,mode,profile,is_loop FROM saved_routes WHERE user_id = ? ORDER BY created_at DESC, id DESC"),
  getRoute:         db.prepare("SELECT * FROM saved_routes WHERE user_id = ? AND id = ?"),
  insertRoute:      db.prepare(`INSERT INTO saved_routes (user_id,name,distance_km,new_sq,new_sqi,mode,profile,is_loop,waypoints,coords,elev_profile,surface_profile)
                                VALUES (@user_id,@name,@distance_km,@new_sq,@new_sqi,@mode,@profile,@is_loop,@waypoints,@coords,@elev_profile,@surface_profile)`),
  deleteRoute:      db.prepare("DELETE FROM saved_routes WHERE user_id = ? AND id = ?"),
  renameRoute:      db.prepare("UPDATE saved_routes SET name = ? WHERE user_id = ? AND id = ?"),
  routeCoords:      db.prepare("SELECT coords FROM saved_routes WHERE user_id = ? AND id = ?"),

  usersWithStrava:  db.prepare("SELECT t.user_id, s.at AS last_at FROM strava_tokens t LEFT JOIN sync_status s ON s.user_id = t.user_id"),
  getSyncStatus:    db.prepare("SELECT * FROM sync_status WHERE user_id = ?"),
  setSyncStatus:    db.prepare(`INSERT INTO sync_status (user_id,source,at,result,error) VALUES (?,?,?,?,?)
                                ON CONFLICT(user_id) DO UPDATE SET source=excluded.source,at=excluded.at,result=excluded.result,error=excluded.error`),

  clearOwnedBlocked: db.prepare("DELETE FROM blocked_sqi WHERE user_id = ? AND EXISTS (SELECT 1 FROM tiles_sqi t WHERE t.user_id = blocked_sqi.user_id AND t.tx = blocked_sqi.tx AND t.ty = blocked_sqi.ty)"),
};

// return the count of rows actually inserted (vs. ignored as already-owned),
// so callers can report a real "+N new" delta instead of the input size.
const batchSQ  = db.transaction((userId, tiles) => { let n=0; for (const [tx,ty] of tiles) n += q.insertTileSQ.run(userId,tx,ty).changes; return n; });
const batchSQI = db.transaction((userId, tiles) => { let n=0; for (const [tx,ty] of tiles) n += q.insertTileSQI.run(userId,tx,ty).changes; return n; });

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
  getUserByOAuth(p, id)    { return q.getUserByOAuth.get(p, id); },
  getAllUsers()             { return q.getAllUsers.all(); },
  getUserCount()           { return q.countUsers.get().n; },
  updateUserRole(id, role) { q.updateRole.run(role, id); },
  updateStravaCredentials(id, cid, csec) { q.updateStrava.run(cid, csec, id); },
  updateLastLogin(id)      { q.updateLastLogin.run(id); },
  updatePasswordHash(id, h){ q.updatePassHash.run(h, id); },
  setHomePoint(id, lat, lng){ q.updateHome.run(lat, lng, id); },
  setGarminKey(id, key)     { q.setGarminKey.run(key, id); },
  userIdByGarminKey(key)    { return key ? q.userByGarminKey.get(key)?.id ?? null : null; },
  // Older databases were migrated without ON DELETE CASCADE on some tables,
  // so remove every row that belongs to the user explicitly
  deleteUser: db.transaction((id) => {
    for (const t of ['strava_tokens', 'activities', 'tiles_sq', 'tiles_sqi', 'blocked_sqi', 'saved_routes', 'sync_status']) {
      db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(id);
    }
    q.deleteUser.run(id);
  }),
  getStravaAccessToken(id)  { return db.prepare("SELECT access_token FROM strava_tokens WHERE user_id = ?").get(id)?.access_token || null; },

  createOAuthUser(provider, oauthId, email, username) {
    const role = q.countUsers.get().n === 0 ? 'admin' : 'user';
    return q.insertOAuthUser.run(username, email || null, role, provider, oauthId);
  },
  linkOAuth(userId, provider, oauthId) { q.linkOAuth.run(provider, oauthId, userId); },

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
  insertTilesSQBatch(userId, tiles)       { return batchSQ(userId, tiles); },

  // Tiles SQI
  getSQICount(userId)                      { return q.countTilesSQI.get(userId).n; },
  getAllTilesSQI(userId)                    { return q.getTilesSQI.all(userId); },
  getTilesSQIBbox(userId, x0, x1, y0, y1) { return q.getTilesSQIBbox.all(userId, x0, x1, y0, y1); },
  insertTilesSQIBatch(userId, tiles)       { return batchSQI(userId, tiles); },
  hasTileSQI(userId, tx, ty)               { return !!q.hasTileSQI.get(userId, tx, ty); },

  // Saved routes
  listRoutes(userId)         { return q.listRoutes.all(userId); },
  getRoute(userId, id)       { return q.getRoute.get(userId, id); },
  insertRoute(userId, r)     { return q.insertRoute.run({ user_id: userId, ...r }).lastInsertRowid; },
  deleteRoute(userId, id)    { return q.deleteRoute.run(userId, id).changes > 0; },
  renameRoute(userId, id, n) { return q.renameRoute.run(n, userId, id).changes > 0; },
  routeCoords(userId, id)    { const r = q.routeCoords.get(userId, id); return r ? JSON.parse(r.coords) : null; },

  // Strava sync status
  usersWithStrava()          { return q.usersWithStrava.all(); },
  getSyncStatus(userId)      { return q.getSyncStatus.get(userId); },
  setSyncStatus(userId, source, result, error) {
    q.setSyncStatus.run(userId, source, new Date().toISOString(), result ? JSON.stringify(result) : null, error || null);
  },

  // Blocked (uncollectable) SQI
  getBlockedSQI(userId)                    { q.clearOwnedBlocked.run(userId); return q.getBlockedSQI.all(userId); },
  addBlockedSQIMany(userId, list) {
    let n = 0;
    db.transaction(() => { for (const [tx, ty] of list) n += q.addBlockedSQI.run(userId, tx, ty).changes; })();
    return n;
  },
  toggleBlockedSQI(userId, tx, ty) {
    if (q.hasBlockedSQI.get(userId, tx, ty)) { q.delBlockedSQI.run(userId, tx, ty); return false; }
    q.addBlockedSQI.run(userId, tx, ty); return true;
  },
};
