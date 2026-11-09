/**
 * index.js — Express API server (multi-user)
 */

const express      = require('express');
const compression  = require('compression');
const path         = require('path');
const fs           = require('fs');
const cookieParser = require('cookie-parser');
const jwt          = require('jsonwebtoken');
const bcrypt       = require('bcryptjs');
const { rateLimit } = require('express-rate-limit');

const app  = express();
// Behind a reverse proxy: how many proxies sit in front of the backend (OpenShift: router + nginx).
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));
const PORT = process.env.PORT || 3000;

app.use(compression());

const JWT_SECRET = process.env.JWT_SECRET || (() => {
  console.warn('\n⚠️  JWT_SECRET nie jest ustawiony — używam domyślnego (NIEBEZPIECZNE w produkcji)!\n');
  return 'dev-squadrats-secret-change-in-production';
})();

const COOKIE_OPTS = {
  httpOnly: true,
  secure:   process.env.COOKIE_SECURE === 'true',
  sameSite: 'lax',
  maxAge:   30 * 24 * 60 * 60 * 1000, // 30 days
};

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const FRONTEND = path.join(__dirname, '../../frontend');
app.use(express.static(FRONTEND));

const db     = require('./db');
const strava = require('./strava');
const tiles  = require('./tiles');
const routing = require('./routing');
const planner = require('./planner');
const popular = require('./popular');
const reach   = require('./reach');
const priority = require('./priority');
const photos = require('./photos');
const mapillary = require('./mapillary');
const oauth  = require('./oauth');
const axios  = require('axios');
const crypto = require('crypto');

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'Nie zalogowany' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch {
    return res.status(401).json({ error: 'Nieprawidłowy token' });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    const user = db.getUserById(req.userId);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Tylko administrator' });
    req.user = user;
    next();
  });
}

function safeUser(user) {
  const tok = db.getToken(user.id);
  return {
    id:                user.id,
    username:          user.username,
    email:             user.email,
    role:              user.role,
    has_password:      !!user.password_hash,
    oauth_provider:    user.oauth_provider || null,
    strava_configured: !!(user.strava_client_id && user.strava_client_secret),
    strava_client_id:  user.strava_client_id,
    created_at:        user.created_at,
    last_login:        user.last_login,
    strava_connected:  !!tok,
    strava_athlete:    tok ? JSON.parse(tok.athlete_json || '{}') : null,
    home_lat:          user.home_lat ?? null,
    home_lng:          user.home_lng ?? null,
    layers:            user.map_layers ? JSON.parse(user.map_layers) : null,
  };
}

// ── Rate limiters ─────────────────────────────────────────────────────────────

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 godzina
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zbyt wiele prób rejestracji. Spróbuj ponownie za godzinę.' },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minut
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zbyt wiele prób logowania. Spróbuj ponownie za 15 minut.' },
});

// ── Auth routes ───────────────────────────────────────────────────────────────

const PASSWORD_POLICY = /^(?=.*[0-9]).{8,}$/; // min 8 znaków + co najmniej 1 cyfra

app.post('/api/auth/register', registerLimiter, async (req, res) => {
  const { username, password, email, strava_client_id, strava_client_secret } = req.body;
  if (!username?.trim() || !password) return res.status(400).json({ error: 'Nazwa użytkownika i hasło są wymagane' });
  if (username.trim().length < 3)     return res.status(400).json({ error: 'Nazwa użytkownika min. 3 znaki' });
  if (!PASSWORD_POLICY.test(password)) return res.status(400).json({ error: 'Hasło min. 8 znaków i co najmniej 1 cyfra' });

  if (db.getUserByUsername(username.trim())) return res.status(409).json({ error: 'Nazwa użytkownika jest zajęta' });
  if (email && db.getUserByEmail(email))     return res.status(409).json({ error: 'Email jest już zarejestrowany' });

  try {
    const hash   = await bcrypt.hash(password, 10);
    const result = db.createUser(username.trim(), hash, email?.trim() || null);
    const userId = result.lastInsertRowid;
    if (strava_client_id && strava_client_secret) {
      db.updateStravaCredentials(userId, strava_client_id.trim(), strava_client_secret.trim());
    }
    db.updateLastLogin(userId);
    const user  = db.getUserById(userId);
    const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie('token', token, COOKIE_OPTS);
    res.json({ user: safeUser(user) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Wymagana nazwa i hasło' });
  const user = db.getUserByUsername(username) || db.getUserByEmail(username);
  if (!user) return res.status(401).json({ error: 'Nieprawidłowe dane logowania' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Nieprawidłowe dane logowania' });
  db.updateLastLogin(user.id);
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, COOKIE_OPTS);
  res.json({ user: safeUser(user) });
  setImmediate(() => buildUserCache(user.id));
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.getUserById(req.userId);
  if (!user) return res.status(401).json({ error: 'Użytkownik nie istnieje' });
  res.json(safeUser(user));
});

// ── Profile routes ────────────────────────────────────────────────────────────

app.put('/api/profile/strava', requireAuth, (req, res) => {
  const { strava_client_id, strava_client_secret } = req.body;
  db.updateStravaCredentials(req.userId, strava_client_id?.trim() || null, strava_client_secret?.trim() || null);
  res.json({ user: safeUser(db.getUserById(req.userId)) });
});

app.put('/api/profile/password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Wymagane oba hasła' });
  if (!PASSWORD_POLICY.test(new_password)) return res.status(400).json({ error: 'Hasło min. 8 znaków i co najmniej 1 cyfra' });
  const user = db.getUserById(req.userId);
  if (!user.password_hash) return res.status(400).json({ error: 'Konto social login nie ma hasła. Możesz ustawić nowe hasło bez podawania obecnego.' });
  if (!await bcrypt.compare(current_password, user.password_hash))
    return res.status(401).json({ error: 'Nieprawidłowe obecne hasło' });
  db.updatePasswordHash(req.userId, await bcrypt.hash(new_password, 10));
  res.json({ ok: true });
});

app.put('/api/profile/layers', requireAuth, (req, res) => {
  const l = req.body?.layers;
  if (!l || typeof l !== 'object' || Array.isArray(l)) return res.status(400).json({ error: 'Nieprawidłowe warstwy' });
  const clean = Object.fromEntries(Object.entries(l).filter(([k, v]) => /^[a-z0-9-]{1,20}$/.test(k) && typeof v === 'boolean').slice(0, 30));
  db.setMapLayers(req.userId, JSON.stringify(clean));
  res.json({ ok: true });
});

app.put('/api/profile/home', requireAuth, (req, res) => {
  const { lat, lng } = req.body;
  if (lat !== null && (typeof lat !== 'number' || typeof lng !== 'number'))
    return res.status(400).json({ error: 'Nieprawidłowe koordynaty' });
  db.setHomePoint(req.userId, lat ?? null, lng ?? null);
  const c = userCaches.get(req.userId);
  if (c) delete c.priority; // priorities are ranked by distance from home
  res.json({ user: safeUser(db.getUserById(req.userId)) });
});

// ── Garmin Connect IQ data field ──────────────────────────────────────────────
// The field's background service asks for the squares around the rider every
// few minutes (through the phone; Garmin requires HTTPS). Answer is a compact
// bitmap: n×n squadratinhos (z17) and m×m squadrats (z14) centred on the
// rider, row-major, 1 = collected, as hex; blocked SQI in a second bitmap.
app.post('/api/profile/garmin-key', requireAuth, (req, res) => {
  const key = crypto.randomBytes(12).toString('hex');
  db.setGarminKey(req.userId, key);
  res.json({ key });
});
app.get('/api/profile/garmin-key', requireAuth, (req, res) => {
  res.json({ key: db.getUserById(req.userId)?.garmin_key || null });
});

function bitmapHex(n, test) {
  const bytes = Buffer.alloc(Math.ceil(n * n / 8));
  for (let i = 0; i < n * n; i++) if (test(i % n, Math.floor(i / n))) bytes[i >> 3] |= 0x80 >> (i & 7);
  return bytes.toString('hex');
}
app.get('/api/garmin/area', (req, res) => {
  const userId = db.userIdByGarminKey(String(req.query.key || ''));
  console.log(`[garmin] area user=${userId || '-'} ${(+req.query.lat).toFixed(2)},${(+req.query.lng).toFixed(2)}`);
  if (!userId) return res.status(401).json({ error: 'bad key' });
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 85) return res.status(400).json({ error: 'lat/lng' });
  const c = getUserCache(userId);
  const N = 48, M = 12;
  const qi = tiles.latLngToTile(lat, lng, tiles.Z_SQI), qs = tiles.latLngToTile(lat, lng, tiles.Z_SQ);
  const ix = qi.x - N / 2, iy = qi.y - N / 2, sx = qs.x - M / 2, sy = qs.y - M / 2;
  const inBox = (r, x0, y0, n) => r.tx >= x0 && r.tx < x0 + n && r.ty >= y0 && r.ty < y0 + n;
  const sqi = new Set(c.sqiRows.filter(r => inBox(r, ix, iy, N)).map(r => `${r.tx},${r.ty}`));
  const blk = new Set(c.blockedSQI.filter(r => inBox(r, ix, iy, N)).map(r => `${r.tx},${r.ty}`));
  const sq = new Set(c.sqRows.filter(r => inBox(r, sx, sy, M)).map(r => `${r.tx},${r.ty}`));
  res.json({
    ix, iy, n: N, sqi: bitmapHex(N, (x, y) => sqi.has(`${ix + x},${iy + y}`)),
    blk: bitmapHex(N, (x, y) => blk.has(`${ix + x},${iy + y}`)),
    sx, sy, m: M, sq: bitmapHex(M, (x, y) => sq.has(`${sx + x},${sy + y}`)),
    tot: { sq: c.sqRows.length, sqi: c.sqiRows.length },
  });
});

app.put('/api/profile/set-password', requireAuth, async (req, res) => {
  const { new_password } = req.body;
  if (!new_password || !PASSWORD_POLICY.test(new_password)) return res.status(400).json({ error: 'Hasło min. 8 znaków i co najmniej 1 cyfra' });
  const user = db.getUserById(req.userId);
  if (user.password_hash) return res.status(400).json({ error: 'Konto ma już hasło. Użyj opcji zmiany hasła.' });
  db.updatePasswordHash(req.userId, await bcrypt.hash(new_password, 10));
  res.json({ ok: true });
});

// ── Account deletion (by the user) ────────────────────────────────────────────
// Confirmed with the password, or with the username for Google/Strava-only
// accounts. Revokes the Strava authorisation, then removes every row of the
// user: activities, squares, routes, blocked squares, tokens.
app.delete('/api/profile', requireAuth, async (req, res) => {
  const user = db.getUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'Użytkownik nie istnieje' });
  const { password, confirm } = req.body || {};
  if (user.password_hash) {
    if (!password || !await bcrypt.compare(password, user.password_hash))
      return res.status(403).json({ error: 'Nieprawidłowe hasło' });
  } else if (String(confirm || '').trim().toLowerCase() !== String(user.username).toLowerCase()) {
    return res.status(403).json({ error: 'Wpisz swoją nazwę użytkownika, aby potwierdzić' });
  }
  if (user.role === 'admin') {
    const others = db.getAllUsers().filter(u => u.id !== user.id);
    if (others.length && !others.some(u => u.role === 'admin'))
      return res.status(400).json({ error: 'Jesteś jedynym administratorem. Najpierw nadaj komuś rolę admina.' });
  }
  const token = db.getStravaAccessToken(user.id);
  if (token) {
    try {
      await axios.post('https://www.strava.com/oauth/deauthorize', null, { params: { access_token: token }, timeout: 8000 });
    } catch (e) {
      console.warn(`[account] strava deauthorize user=${user.id}: ${e.response?.status || e.message}`);
    }
  }
  db.deleteUser(user.id);
  invalidateUserCache(user.id);
  for (let i = clientLogs.length - 1; i >= 0; i--) if (clientLogs[i].uid === user.id) clientLogs.splice(i, 1);
  console.log(`[account] user ${user.id} deleted their account`);
  res.clearCookie('token');
  res.json({ ok: true });
});

// ── Admin routes ──────────────────────────────────────────────────────────────

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.getAllUsers().map(u => ({
    ...u,
    oauth_provider:    u.oauth_provider || null,
    strava_configured: !!(u.strava_client_id),
    strava_connected:  !!db.getToken(u.id),
    sq_count:          db.getSQCount(u.id),
  }));
  res.json({ users });
});

app.put('/api/admin/users/:id/role', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.userId) return res.status(400).json({ error: 'Nie możesz zmienić własnej roli' });
  const { role } = req.body;
  if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Nieprawidłowa rola' });
  db.updateUserRole(id, role);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.userId) return res.status(400).json({ error: 'Nie możesz usunąć własnego konta' });
  db.deleteUser(id);
  invalidateUserCache(id);
  res.json({ ok: true });
});

// ── Health check (no auth — for OCP probes) ──────────────────────────────────

app.get('/api/health', (req, res) => res.json({ ok: true, users: db.getUserCount() }));

// ── OAuth providers (public — tells frontend which buttons to show) ────────────

app.get('/api/auth/providers', (req, res) => {
  res.json({
    google: !!process.env.GOOGLE_CLIENT_ID,
  });
});

// ── Social OAuth flows ────────────────────────────────────────────────────────

function oauthState() {
  return jwt.sign({ t: Date.now() }, JWT_SECRET, { expiresIn: '10m' });
}

function oauthSuccess(res, user) {
  db.updateLastLogin(user.id);
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, COOKIE_OPTS);
  res.redirect('/?auth=ok');
  setImmediate(() => buildUserCache(user.id));
}

function oauthError(res, err) {
  console.error('[OAuth]', err);
  res.redirect('/?auth=error&msg=' + encodeURIComponent(err.message || String(err)));
}

// Google
app.get('/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(404).send('Google OAuth nie jest skonfigurowane');
  res.redirect(oauth.googleAuthUrl(oauthState()));
});
app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return oauthError(res, new Error(error));
  try { oauthSuccess(res, await oauth.googleCallback(code)); }
  catch (e) { oauthError(res, e); }
});

// ── Strava OAuth ──────────────────────────────────────────────────────────────

app.get('/auth/strava', requireAuth, (req, res) => {
  const user = db.getUserById(req.userId);
  if (!user?.strava_client_id || !user?.strava_client_secret) {
    return res.redirect('/?error=strava-config-missing');
  }
  const state = jwt.sign({ userId: req.userId }, JWT_SECRET, { expiresIn: '10m' });
  res.redirect(strava.getAuthUrl(user.strava_client_id, state));
});

app.get('/auth/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error || !code) return res.redirect('/?auth=error&msg=' + encodeURIComponent(error || 'no_code'));
  let userId;
  try {
    userId = jwt.verify(state, JWT_SECRET).userId;
  } catch {
    return res.redirect('/?auth=error&msg=invalid_state');
  }
  try {
    await strava.exchangeCode(userId, code);
    invalidateUserCache(userId);
    res.redirect('/?auth=strava-ok');
  } catch (e) {
    console.error('Strava OAuth error:', e.message);
    res.redirect('/?auth=error&msg=' + encodeURIComponent(e.message));
  }
});

// ── Per-user tile cache ───────────────────────────────────────────────────────

const userCaches = new Map();

function buildUserCache(userId) {
  const sqRows  = db.getAllTilesSQ(userId);
  const sqiRows = db.getAllTilesSQI(userId);
  const yard    = tiles.computeYard(sqRows);
  const uber    = tiles.computeUber(sqRows);
  const yardi   = tiles.computeYard(sqiRows);
  const uberi   = tiles.computeUber(sqiRows);
  const blockedSQI = db.getBlockedSQI(userId);
  const c = {
    sqRows, sqiRows, yard, uber, yardi, uberi, blockedSQI,
    stats: {
      sq:         db.getSQCount(userId),
      sqi:        db.getSQICount(userId),
      activities: db.getActivityCount(userId),
      yard:  { size: yard.size },
      uber:  { size: uber.size },
      yardi: { size: yardi.size },
      uberi: { size: uberi.size },
    },
  };
  userCaches.set(userId, c);
  return c;
}

function getUserCache(userId) {
  return userCaches.has(userId) ? userCaches.get(userId) : buildUserCache(userId);
}

function invalidateUserCache(userId) {
  userCaches.delete(userId);
}

// ── Sync ──────────────────────────────────────────────────────────────────────
// One sync per user at a time, whether started by the button or by the
// background schedule; every run records its result for /api/sync/status.

const syncRunning = new Set();
async function runStravaSync(userId, source, onProgress = () => {}) {
  if (syncRunning.has(userId)) throw new Error('Synchronizacja już trwa');
  syncRunning.add(userId);
  try {
    const result = await strava.syncActivities(userId, onProgress);
    invalidateUserCache(userId);
    db.setSyncStatus(userId, source, result, null);
    return result;
  } catch (e) {
    db.setSyncStatus(userId, source, null, e.message);
    throw e;
  } finally {
    syncRunning.delete(userId);
  }
}

app.post('/api/sync', requireAuth, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = d => res.write(`data: ${JSON.stringify(d)}\n\n`);
  try {
    const result = await runStravaSync(req.userId, 'manual', p => send(p));
    send({ phase: 'done', ...result });
  } catch (e) {
    send({ phase: 'error', message: e.message });
  } finally {
    res.end();
  }
});

app.get('/api/sync/status', requireAuth, (req, res) => {
  const st = db.getSyncStatus(req.userId);
  res.json({
    connected: !!db.getToken(req.userId),
    everyMin: AUTO_SYNC_EVERY_MS / 60000,
    running: syncRunning.has(req.userId),
    last: st ? { source: st.source, at: st.at, result: st.result ? JSON.parse(st.result) : null, error: st.error } : null,
  });
});

// Background sync: picks up new rides without anyone pressing "Synchronizuj".
// Polling (not Strava webhooks) because webhooks need a publicly reachable
// URL; at 30 min per connected user it stays far inside Strava's rate limits
// for a handful of riders.
const AUTO_SYNC_EVERY_MS = 30 * 60 * 1000;
async function autoSyncTick() {
  for (const u of db.usersWithStrava()) {
    if (u.last_at && Date.now() - Date.parse(u.last_at) < AUTO_SYNC_EVERY_MS) continue;
    try {
      const r = await runStravaSync(u.user_id, 'auto');
      if (r.newSQ || r.newSQI) console.log(`[auto-sync] user ${u.user_id}: +${r.newSQ} SQ, +${r.newSQI} SQI`);
    } catch (e) {
      console.warn(`[auto-sync] user ${u.user_id}: ${e.message}`);
    }
  }
}
setTimeout(autoSyncTick, 60 * 1000);
setInterval(autoSyncTick, 5 * 60 * 1000);

// ── Saved routes ──────────────────────────────────────────────────────────────

// List entries carry a tiny outline (SVG points in a 100×100 box, start first)
// and the climb, both derived from the stored coords once and memoised: a
// saved route's geometry never changes.
const routeSummaryCache = new Map();
function routeSummary(userId, id) {
  const key = `${userId}:${id}`;
  if (routeSummaryCache.has(key)) return routeSummaryCache.get(key);
  const c = db.routeCoords(userId, id) || [];
  let sum = { thumb: '', ascent_m: 0 };
  if (c.length >= 2) {
    const midLat = c.reduce((a, p) => a + p[0], 0) / c.length;
    const kx = Math.cos(midLat * Math.PI / 180);
    const xs = c.map(p => p[1] * kx), ys = c.map(p => -p[0]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const span = Math.max(x1 - x0, y1 - y0) || 1e-9;
    const ox = (100 - (x1 - x0) / span * 92) / 2, oy = (100 - (y1 - y0) / span * 92) / 2;
    const step = Math.max(1, Math.floor(c.length / 120));
    const pts = [];
    for (let i = 0; i < c.length; i += step) pts.push(i);
    if (pts[pts.length - 1] !== c.length - 1) pts.push(c.length - 1);
    sum.thumb = pts.map(i => `${(ox + (xs[i] - x0) / span * 92).toFixed(1)},${(oy + (ys[i] - y0) / span * 92).toFixed(1)}`).join(' ');
    // climb with a 3 m hysteresis so DEM noise doesn't add up
    let ref = c[0][2] || 0, up = 0;
    for (const p of c) { const e = p[2] || 0; if (e > ref + 3) { up += e - ref; ref = e; } else if (e < ref - 3) ref = e; }
    sum.ascent_m = Math.round(up);
  }
  routeSummaryCache.set(key, sum);
  return sum;
}

app.get('/api/routes', requireAuth, (req, res) =>
  res.json(db.listRoutes(req.userId).map(r => ({ ...r, ...routeSummary(req.userId, r.id) }))));

// Course GPX of a saved route, named after it (Garmin Connect uses the <name>
// as the course title when the file is imported or shared to the app).
const xmlEsc = s => String(s).replace(/[<>&"']/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]));
app.get('/api/routes/:id/gpx', requireAuth, (req, res) => {
  const r = db.getRoute(req.userId, +req.params.id);
  if (!r) return res.status(404).json({ error: 'Nie ma takiej trasy' });
  const c = JSON.parse(r.coords);
  const hasElev = c.some(p => p[2] > 0);
  const name = xmlEsc(r.name);
  const pts = c.map(p => `      <trkpt lat="${(+p[0]).toFixed(6)}" lon="${(+p[1]).toFixed(6)}">${hasElev ? `<ele>${(+p[2] || 0).toFixed(1)}</ele>` : ''}</trkpt>`).join('\n');
  const named = JSON.parse(r.waypoints).filter(w => w.name)
    .map(w => `  <wpt lat="${(+w.lat).toFixed(6)}" lon="${(+w.lng).toFixed(6)}"><name>${xmlEsc(w.name)}</name></wpt>\n`).join('');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="SquadratsPlanner" version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${name}</name><time>${new Date(r.created_at.replace(' ', 'T') + 'Z').toISOString()}</time></metadata>
${named}  <trk>
    <name>${name}</name>
    <type>cycling</type>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
  const file = (r.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L')
    .replace(/[^A-Za-z0-9 _.-]+/g, ' ').trim().replace(/\s+/g, '_').slice(0, 60) || `trasa_${r.id}`) + '.gpx';
  res.set('Content-Type', 'application/gpx+xml; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${file}"`);
  res.send(gpx);
});

app.patch('/api/routes/:id', requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Podaj nazwę trasy' });
  if (!db.renameRoute(req.userId, +req.params.id, name)) return res.status(404).json({ error: 'Nie ma takiej trasy' });
  res.json({ ok: true, name });
});

app.get('/api/routes/:id', requireAuth, (req, res) => {
  const r = db.getRoute(req.userId, +req.params.id);
  if (!r) return res.status(404).json({ error: 'Nie ma takiej trasy' });
  res.json({
    ...r,
    waypoints: JSON.parse(r.waypoints), coords: JSON.parse(r.coords),
    elev_profile: r.elev_profile ? JSON.parse(r.elev_profile) : null,
    surface_profile: r.surface_profile ? JSON.parse(r.surface_profile) : null,
  });
});

app.post('/api/routes', requireAuth, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Podaj nazwę trasy' });
  if (!Array.isArray(b.coords) || b.coords.length < 2 || b.coords.length > 50000) return res.status(400).json({ error: 'Brak trasy do zapisania' });
  if (!Array.isArray(b.waypoints)) return res.status(400).json({ error: 'Brak punktów trasy' });
  const id = db.insertRoute(req.userId, {
    name,
    distance_km: +b.distanceKm || 0,
    new_sq: b.newSQ | 0, new_sqi: b.newSQI | 0,
    mode: b.mode || null, profile: b.profile || null, is_loop: b.loop ? 1 : 0,
    waypoints: JSON.stringify(b.waypoints.slice(0, 50)),
    coords: JSON.stringify(b.coords.map(c => [+(+c[0]).toFixed(6), +(+c[1]).toFixed(6), Math.round(+c[2] || 0)])),
    elev_profile: b.elevProfile ? JSON.stringify(b.elevProfile) : null,
    surface_profile: b.surfaceProfile ? JSON.stringify(b.surfaceProfile) : null,
  });
  res.json({ id: Number(id) });
});

app.delete('/api/routes/:id', requireAuth, (req, res) => {
  routeSummaryCache.delete(`${req.userId}:${+req.params.id}`);
  if (!db.deleteRoute(req.userId, +req.params.id)) return res.status(404).json({ error: 'Nie ma takiej trasy' });
  res.json({ ok: true });
});

// ── Stats ─────────────────────────────────────────────────────────────────────

// ── Frontend log telemetry ─────────────────────────────────────────────────

const clientLogs = [];
const MAX_LOGS = 500;

app.post('/api/log', requireAuth, (req, res) => {
  const { level = 'log', msg, data, url, line } = req.body || {};
  const entry = {
    t: new Date().toISOString(),
    uid: req.userId,
    level,
    msg: String(msg || '').slice(0, 500),
    data: data ? JSON.stringify(data).slice(0, 500) : undefined,
    url: url ? String(url).slice(0, 200) : undefined,
    line,
  };
  clientLogs.push(entry);
  if (clientLogs.length > MAX_LOGS) clientLogs.shift();
  if (level === 'error') console.error('[CLIENT]', entry.t, `uid=${entry.uid}`, entry.msg, entry.data || '');
  res.json({ ok: true });
});

app.get('/api/log', requireAuth, (req, res) => {
  if (req.userRole !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const n = parseInt(req.query.n) || 50;
  res.json(clientLogs.slice(-n));
});

// ──────────────────────────────────────────────────────────────────────────────

app.get('/api/stats', requireAuth, (req, res) => {
  res.json(getUserCache(req.userId).stats);
});

// ── Tile endpoints ────────────────────────────────────────────────────────────

function parseBbox(q) {
  if (q.x0 !== undefined) return [+q.x0, +q.x1, +q.y0, +q.y1];
  return null;
}

app.get('/api/tiles/sq', requireAuth, (req, res) => {
  const bbox = parseBbox(req.query);
  res.json(bbox ? db.getTilesSQBbox(req.userId, ...bbox) : getUserCache(req.userId).sqRows);
});
app.get('/api/tiles/sqi', requireAuth, (req, res) => {
  const bbox = parseBbox(req.query);
  res.json(bbox ? db.getTilesSQIBbox(req.userId, ...bbox) : getUserCache(req.userId).sqiRows);
});
app.get('/api/tiles/yard',     requireAuth, (req, res) => res.json(getUserCache(req.userId).yard));
app.get('/api/tiles/uber',     requireAuth, (req, res) => res.json(getUserCache(req.userId).uber));
app.get('/api/tiles/yardinho', requireAuth, (req, res) => res.json(getUserCache(req.userId).yardi));
app.get('/api/tiles/uberinho', requireAuth, (req, res) => res.json(getUserCache(req.userId).uberi));

// Single-request tile load: sq + sqi + yard + uber + yardinho + uberinho + stats in one call
app.get('/api/tiles/all', requireAuth, (req, res) => {
  const c = getUserCache(req.userId);
  res.json({
    sq:        c.sqRows,
    sqi:       c.sqiRows,
    yard:      c.yard,
    uber:      c.uber,
    yardinho:  c.yardi,
    uberinho:  c.uberi,
    blockedSqi: c.blockedSQI,
    stats:     c.stats,
  });
});

// Toggle a squadratinho as "impossible to collect" (long press on the map).
app.post('/api/tiles/blocked/toggle', requireAuth, (req, res) => {
  const tx = parseInt(req.body.tx, 10), ty = parseInt(req.body.ty, 10);
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) return res.status(400).json({ error: 'tx, ty required' });
  if (db.hasTileSQI(req.userId, tx, ty)) return res.status(409).json({ error: 'Ten SQI jest już zdobyty' });
  const blocked = db.toggleBlockedSQI(req.userId, tx, ty);
  invalidateUserCache(req.userId);
  res.json({ blocked, tx, ty });
});

// Squadratinhos with no road or path in OSM: suggested as impossible to
// collect (owned and already blocked ones left out). z17 tile range.
app.get('/api/tiles/noroad', requireAuth, (req, res) => {
  const [x0, y0, x1, y1] = ['x0', 'y0', 'x1', 'y1'].map(k => parseInt(req.query[k], 10));
  if (![x0, y0, x1, y1].every(Number.isFinite) || x1 < x0 || y1 < y0) return res.status(400).json({ error: 'x0,y0,x1,y1 required' });
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 250000) return res.status(400).json({ error: 'range too large' });
  if (!reach.available()) return res.json({ available: false, tiles: [] });
  const c = getUserCache(req.userId);
  const skip = new Set();
  for (const r of c.sqiRows) if (r.tx >= x0 && r.tx <= x1 && r.ty >= y0 && r.ty <= y1) skip.add(`${r.tx},${r.ty}`);
  for (const r of c.blockedSQI) skip.add(`${r.tx},${r.ty}`);
  res.json({ available: true, tiles: reach.noRoadIn(x0, y0, x1, y1, skip) });
});

// Priority squadratinhos: the uncollected ones that grow the
// Übersquadratinho / Yardinho, near home and reachable (priority.js). Part
// of the user cache, so every sync or blocked-tile change recomputes it.
function getPriority(userId, c) {
  if (!c.priority) {
    const u = db.getUserById(userId);
    let home = u?.home_lat != null ? { lat: u.home_lat, lng: u.home_lng } : null;
    if (!home && c.uberi.tiles.length) {
      const t = c.uberi.tiles[Math.floor(c.uberi.tiles.length / 2)];
      home = tiles.tileCenter(t.tx, t.ty, tiles.Z_SQI);
    }
    c.priority = home
      ? priority.computePriority({ sqiRows: c.sqiRows, blockedSQI: c.blockedSQI, uberi: c.uberi, yardi: c.yardi, home })
      : { home: null, tiles: [], windows: [] };
  }
  return c.priority;
}

app.get('/api/tiles/priority', requireAuth, (req, res) => {
  res.json(getPriority(req.userId, getUserCache(req.userId)));
});

// Accept suggestions: mark many squadratinhos as impossible at once
app.post('/api/tiles/blocked/bulk', requireAuth, (req, res) => {
  const list = Array.isArray(req.body.tiles) ? req.body.tiles : [];
  if (!list.length || list.length > 20000) return res.status(400).json({ error: 'tiles: 1..20000 [tx,ty]' });
  const c = getUserCache(req.userId);
  const owned = new Set(c.sqiRows.map(r => `${r.tx},${r.ty}`));
  const ok = list.map(t => [parseInt(t[0], 10), parseInt(t[1], 10)])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && !owned.has(`${x},${y}`));
  const added = db.addBlockedSQIMany(req.userId, ok);
  invalidateUserCache(req.userId);
  res.json({ added });
});

// How much of what can be collected around a point is collected:
// squadratinhos within r km, minus those with no road and those marked blocked
app.get('/api/tiles/reach-stats', requireAuth, (req, res) => {
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
  const rKm = Math.min(100, Math.max(1, parseFloat(req.query.r) || 50));
  if (!isFinite(lat) || !isFinite(lng)) return res.status(400).json({ error: 'lat/lng' });
  if (!reach.available()) return res.json({ available: false });
  const c = getUserCache(req.userId);
  const Z = tiles.Z_SQI, n = 2 ** Z;
  const ctr = tiles.latLngToTile(lat, lng, Z);
  const kmPerTile = 40075 * Math.cos(lat * Math.PI / 180) / n;
  const rT = Math.ceil(rKm / kmPerTile) + 1, r2 = (rKm / kmPerTile) ** 2;
  const owned = new Set(), blocked = new Set();
  for (const r of c.sqiRows) if (Math.abs(r.tx - ctr.x) <= rT && Math.abs(r.ty - ctr.y) <= rT) owned.add(`${r.tx},${r.ty}`);
  for (const r of c.blockedSQI) blocked.add(`${r.tx},${r.ty}`);
  let nOwned = 0, nOpen = 0, nNoRoad = 0, nBlocked = 0, nUnknown = 0;
  for (let dy = -rT; dy <= rT; dy++) for (let dx = -rT; dx <= rT; dx++) {
    if (dx * dx + dy * dy > r2) continue;              // tiles are square in Mercator
    const x = ctr.x + dx, y = ctr.y + dy, k = `${x},${y}`;
    if (owned.has(k)) { nOwned++; continue; }
    if (blocked.has(k)) { nBlocked++; continue; }
    const s = reach.status(x, y);
    if (s < 0) nUnknown++; else if (s === 0) nNoRoad++; else nOpen++;
  }
  const collectable = nOwned + nOpen;
  res.json({
    available: true, r: rKm, owned: nOwned, open: nOpen, noRoad: nNoRoad, blocked: nBlocked, unknown: nUnknown,
    collectable, pct: collectable ? Math.round(1000 * nOwned / collectable) / 10 : 0,
  });
});

// ── Route planning ────────────────────────────────────────────────────────────

const { fetchRoute, routeDistanceKm } = routing;

app.post('/api/route/detour', requireAuth, async (req, res) => {
  const { waypoints, loop = false, targetKm = 0, bikeProfile = 'standard', returnLeg = false, avoidCoords = null } = req.body;
  // 'heatmap' (old "Pop." option) never had data behind it; treat as SQI.
  const mode = ['sq', 'sqi', 'yard', 'yardi', 'shortest', 'popular', 'prio'].includes(req.body.mode) ? req.body.mode : 'sqi';
  if (!waypoints?.length) return res.status(400).json({ error: 'waypoints required' });

  const c = getUserCache(req.userId);
  const start = waypoints[0], end = waypoints[waypoints.length - 1];
  const samePoint = tiles.haversineDistance(start, end) < 0.4;
  const isLoop = loop || samePoint;

  // Loop from just a start point: the planner builds and scores real loops
  // (way back on different roads) for every mode.
  if (isLoop && (waypoints.length === 1 || (samePoint && waypoints.length === 2))) {
    try {
      return res.json(await planner.planLoop({
        start, targetKm, mode, bikeProfile, sqRows: c.sqRows, sqiRows: c.sqiRows, yard: c.yard, yardi: c.yardi,
        uberi: c.uberi, blockedSQI: c.blockedSQI, priority: mode === 'prio' ? getPriority(req.userId, c) : null,
      }));
    } catch (e) {
      if (e instanceof planner.PlannerError) return res.status(422).json({ error: e.message });
      return res.status(500).json({ error: 'Routing error: ' + e.message });
    }
  }

  // Loop through the user's own waypoints: closed, second half avoids the
  // first. A→B: plain routing; a return leg avoids the outbound track.
  const pts = isLoop && !samePoint ? [...waypoints, start] : [...waypoints];
  const avoid = returnLeg && Array.isArray(avoidCoords) && avoidCoords.length > 1 ? avoidCoords : null;
  const route = (p) => isLoop
    ? planner.routeLoopHalves(p, routing.brouterProfile(bikeProfile))
    : fetchRoute(p, avoid ? routing.brouterProfile(bikeProfile) : bikeProfile, 0, avoid);

  if (mode === 'shortest') {
    try { return res.json(await route(pts)); }
    catch (e) { return res.status(500).json({ error: 'Routing error: ' + e.message }); }
  }

  // Popular roads: loops through the rider's own waypoints are routed as
  // they are; A→B picks the most popular of BRouter's alternatives that is
  // at most 20% longer than the shortest one.
  if (mode === 'popular') {
    try {
      const coordsOf = (d) => d.routes[0].geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
      const withPop = async (d) => { d.planner = { popular: await popular.popularity(coordsOf(d)) }; return d; };
      if (isLoop || avoid) return res.json(await withPop(await route(pts)));
      const prof = routing.brouterProfile(bikeProfile);
      const alts = (await Promise.all([0, 1, 2, 3].map(i =>
        routing.fetchBRouterRoute(pts, prof, i, null, 30000).then(withPop).catch(() => null)))).filter(Boolean);
      if (!alts.length) return res.status(500).json({ error: 'Routing error: brak trasy' });
      const minKm = Math.min(...alts.map(routeDistanceKm));
      const ok = alts.filter(d => routeDistanceKm(d) <= minKm * 1.2);
      ok.sort((a, b) => b.planner.popular.share - a.planner.popular.share);
      return res.json(ok[0]);
    } catch (e) { return res.status(500).json({ error: 'Routing error: ' + e.message }); }
  }

  // Long A→B route: straight-line >80km — skip iterative detour, one direct call.
  const directKm = tiles.haversineDistance(start, end);
  if (!isLoop && directKm > 80) {
    try { return res.json(await route(pts)); }
    catch (e) { return res.status(500).json({ error: 'Routing error: ' + e.message }); }
  }

  const ownedSQSet  = new Set(c.sqRows.map(r => `${r.tx},${r.ty}`));
  const ownedSQISet = new Set(c.sqiRows.map(r => `${r.tx},${r.ty}`));
  for (const r of c.blockedSQI) ownedSQISet.add(`${r.tx},${r.ty}`); // never a detour target
  const tolerance = 0.15, target = Math.max(0, targetKm);
  let routeData;
  try { routeData = await route(pts); }
  catch (e) { return res.status(500).json({ error: 'Routing error: ' + e.message }); }

  const baseKm = routeDistanceKm(routeData);
  if (!baseKm) return res.status(500).json({ error: 'Could not compute base route' });

  const minKm = target > 0 ? target * (1 - tolerance) : 0;
  const maxKm = target > 0 ? target * (1 + tolerance) : Infinity;
  if (!target || target <= baseKm || (baseKm >= minKm && baseKm <= maxKm)) return res.json(routeData);

  const baseHavKm = pts.slice(1).reduce((s, p, i) => s + tiles.haversineDistance(pts[i], p), 0);
  const roadFactor = baseHavKm > 0.1 ? Math.min(3, Math.max(0.8, baseKm / baseHavKm)) : 1.3;

  let best = { data: routeData, diff: Math.abs(baseKm - target) };
  let lo = baseKm, hi = target * 2, currentTarget = target, prevKm = baseKm;
  const maxAttempts = baseKm > 50 ? 3 : 8;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const detourPts = tiles.buildDetourWaypoints(pts, ownedSQSet, ownedSQISet, mode === 'prio' ? 'sqi' : mode, currentTarget / roadFactor);
    if (detourPts.length < 2) break;
    let dd;
    try { dd = await route(detourPts); } catch { break; }
    const km = routeDistanceKm(dd);
    const diff = Math.abs(km - target);
    if (diff < best.diff) best = { data: dd, diff };
    if (km >= minKm && km <= maxKm) return res.json(dd);
    if (km < minKm) lo = Math.max(lo, currentTarget);
    else hi = Math.min(hi, currentTarget);
    if (hi - lo < 0.5 || Math.abs(km - prevKm) < 0.1) break;
    prevKm = km;
    currentTarget = (lo + hi) / 2;
  }
  return res.json(best.data);
});

// One leg between two tapped points (draw mode, like Strava's route builder):
// plain routing on roads with the chosen bike profile, no squares, no loop
// planner (/detour treats two points <400 m apart as a loop request).
// `avoid` (closing the loop back to start) steers it off the road already drawn.
const LEG_PROFILES = new Set(['standard', 'fastbike', 'gravel', 'rowery-pl', 'safety', 'mtb', 'trekking']);
app.post('/api/route/leg', requireAuth, async (req, res) => {
  const { from, to, avoid } = req.body || {};
  const okPt = p => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
  if (!okPt(from) || !okPt(to)) return res.status(400).json({ error: 'from/to required' });
  if (tiles.haversineDistance(from, to) > 300) return res.status(400).json({ error: 'Punkty są za daleko od siebie (maks. 300 km)' });
  const bikeProfile = LEG_PROFILES.has(req.body.bikeProfile) ? req.body.bikeProfile : 'standard';
  const av = Array.isArray(avoid) ? avoid.filter(okPt).slice(0, 3000) : null;
  try {
    if (av && av.length > 1) return res.json(await fetchRoute([from, to], routing.brouterProfile(bikeProfile), 0, av));
    return res.json(await fetchRoute([from, to], bikeProfile));
  } catch (e) { return res.status(502).json({ error: 'Routing error: ' + e.message }); }
});

// ── GPX import ────────────────────────────────────────────────────────────────

app.post('/api/gpx/import', requireAuth, (req, res) => {
  const { gpxText } = req.body;
  if (!gpxText) return res.status(400).json({ error: 'gpxText required' });
  try {
    const ptRe = /lat="([^"]+)"\s+lon="([^"]+)"/g;
    const coords = [];
    let m;
    while ((m = ptRe.exec(gpxText)) !== null) coords.push({ lat: parseFloat(m[1]), lng: parseFloat(m[2]) });
    if (!coords.length) return res.status(400).json({ error: 'No GPS points found' });
    const { sq14, sq17 } = tiles.trackToTiles(coords);
    db.insertTilesSQBatch(req.userId, [...sq14].map(k => k.split(',').map(Number)));
    db.insertTilesSQIBatch(req.userId, [...sq17].map(k => k.split(',').map(Number)));
    invalidateUserCache(req.userId);
    res.json({
      points: coords.length,
      newSQ:  sq14.size,
      newSQI: sq17.size,
      totalSQ:  db.getSQCount(req.userId),
      totalSQI: db.getSQICount(req.userId),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Squadrats.com KML import (gold-source owned squares) ──────────────────────
// Their export is a merged-outline polygon per zoom level (not a square
// list), so kml.js rasterizes it back onto our tile grid. Additive only —
// never removes tiles — so it's safe to re-run after every fresh export.

app.post('/api/squadrats/import-kml', requireAuth, express.text({ limit: '30mb', type: '*/*' }), (req, res) => {
  const xml = req.body;
  if (!xml || typeof xml !== 'string' || xml.length < 50) return res.status(400).json({ error: 'Pusty plik KML' });
  try {
    const { parseSquadratsKml } = require('./kml');
    const { sq, sqi, sqSize, sqiSize } = parseSquadratsKml(xml);
    const addedSQ  = db.insertTilesSQBatch(req.userId, [...sq].map(k => k.split(',').map(Number)));
    const addedSQI = db.insertTilesSQIBatch(req.userId, [...sqi].map(k => k.split(',').map(Number)));
    invalidateUserCache(req.userId);
    res.json({
      addedSQ, addedSQI,
      parsedSQ: sq.size,
      parsedSQI: sqi.size,
      reportedSQ: sqSize,
      reportedSQI: sqiSize,
      totalSQ:  db.getSQCount(req.userId),
      totalSQI: db.getSQICount(req.userId),
    });
  } catch (e) {
    res.status(500).json({ error: 'Błąd parsowania KML: ' + e.message });
  }
});

// ── Preview tiles ─────────────────────────────────────────────────────────────

app.post('/api/route/preview-tiles', requireAuth, (req, res) => {
  const { coords } = req.body;
  if (!coords?.length) return res.status(400).json({ error: 'coords required' });
  const ownedSQ  = new Set(db.getAllTilesSQ(req.userId).map(r => `${r.tx},${r.ty}`));
  const ownedSQI = new Set(db.getAllTilesSQI(req.userId).map(r => `${r.tx},${r.ty}`));
  for (const r of getUserCache(req.userId).blockedSQI) ownedSQI.add(`${r.tx},${r.ty}`); // can't be collected
  const { sq14, sq17 } = tiles.trackToTiles(coords);
  const newSQ  = [...sq14].filter(k => !ownedSQ.has(k)).map(k => { const [tx,ty]=k.split(',').map(Number); return {tx,ty}; });
  const newSQI = [...sq17].filter(k => !ownedSQI.has(k)).map(k => { const [tx,ty]=k.split(',').map(Number); return {tx,ty}; });
  res.json({ newSQ, newSQI, countSQ: newSQ.length, countSQI: newSQI.length });
});

// ── Mapy.com tiles ────────────────────────────────────────────────────────────
// Base maps from Mapy.com (outdoor = detailed paths). The API key stays on
// the server: tiles are fetched through here, for logged-in users only.
const MAPY_SETS = new Set(['outdoor', 'aerial', 'basic', 'winter']);
app.get('/api/mapy/status', requireAuth, (req, res) => res.json({ enabled: !!process.env.MAPY_API_KEY }));
app.get('/api/mapy/tile/:set/:z/:x/:y', requireAuth, async (req, res) => {
  const key = process.env.MAPY_API_KEY;
  if (!key) return res.status(404).end();
  const [z, x, y] = ['z', 'x', 'y'].map(k => Number(req.params[k]));
  if (!MAPY_SETS.has(req.params.set) || ![z, x, y].every(Number.isInteger) || z < 0 || z > 20) return res.status(400).end();
  try {
    const r = await axios.get(`https://api.mapy.com/v1/maptiles/${req.params.set}/256/${z}/${x}/${y}`,
      { params: { apikey: key }, responseType: 'arraybuffer', timeout: 15000, validateStatus: () => true });
    res.status(r.status).type(r.headers['content-type'] || 'image/png')
      .set('Cache-Control', r.status === 200 ? 'private, max-age=86400' : 'no-store').send(Buffer.from(r.data));
  } catch (e) {
    res.status(502).end();
  }
});

// ── Street View ───────────────────────────────────────────────────────────────

app.get('/api/streetview/embed-url', (req, res) => {
  const { lat, lng } = req.query;
  const key = process.env.GOOGLE_MAPS_KEY;
  if (!key || !lat || !lng) return res.json({ url: null });
  const url = `https://www.google.com/maps/embed/v1/streetview?key=${key}&location=${parseFloat(lat).toFixed(6)},${parseFloat(lng).toFixed(6)}&heading=0&pitch=0&fov=90`;
  res.json({ url });
});

app.get('/api/streetview/viewer', (req, res) => {
  const { lat, lng } = req.query;
  const key = process.env.GOOGLE_MAPS_KEY;
  if (!key || !lat || !lng) return res.status(404).send('No API key');
  const la = parseFloat(lat).toFixed(6), ln = parseFloat(lng).toFixed(6);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
*{margin:0;padding:0}html,body,#sv{width:100%;height:100vh;overflow:hidden}
#no-sv{display:none;position:absolute;inset:0;background:#111928;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:#93a8c0;font-family:sans-serif;font-size:13px;text-align:center;padding:20px}
#no-sv svg{opacity:.4}
#no-sv a{color:#4da8ff;font-size:12px;margin-top:4px}
</style></head>
<body>
<div id="sv"></div>
<div id="no-sv">
  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
  <span>Brak Street View w tym miejscu</span>
  <a href="https://www.google.com/maps/@${la},${ln},3a,75y/" target="_blank">Otwórz Google Maps</a>
</div>
<script>
function svInit(){
  var svc=new google.maps.StreetViewService();
  svc.getPanorama({location:{lat:${la},lng:${ln}},radius:100,source:google.maps.StreetViewSource.OUTDOOR},function(data,status){
    if(status===google.maps.StreetViewStatus.OK){
      var pano=new google.maps.StreetViewPanorama(document.getElementById('sv'),{
        pano:data.location.pano,pov:{heading:0,pitch:0},
        addressControl:false,showRoadLabels:true,motionTracking:false
      });
      function send(){
        var pos=pano.getPosition();if(!pos)return;
        var pov=pano.getPov();
        window.parent.postMessage({type:'sv-update',lat:pos.lat(),lng:pos.lng(),heading:pov.heading},'*');
      }
      pano.addListener('position_changed',send);
      pano.addListener('pov_changed',send);
      window.parent.postMessage({type:'sv-update',lat:data.location.latLng.lat(),lng:data.location.latLng.lng(),heading:0},'*');
    }else{
      document.getElementById('sv').style.display='none';
      var el=document.getElementById('no-sv');el.style.display='flex';
      window.parent.postMessage({type:'sv-no-coverage',lat:${la},lng:${ln}},'*');
    }
  });
}
<\/script>
<script src="https://maps.googleapis.com/maps/api/js?key=${key}&callback=svInit" async defer><\/script>
</body></html>`);
});

app.post('/api/streetview/coverage', async (req, res) => {
  const { points } = req.body;
  const key = process.env.GOOGLE_MAPS_KEY;
  if (!key || !points?.length) return res.json({ coverage: null });
  try {
    const coverage = await Promise.all(points.map(async p => {
      const url = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${p.lat},${p.lng}&source=outdoor&key=${key}`;
      const r = await fetch(url);
      const d = await r.json();
      if (d.status === 'OK' && d.location) {
        return { lat: p.lat, lng: p.lng, ok: true, pLat: d.location.lat, pLng: d.location.lng };
      }
      return { lat: p.lat, lng: p.lng, ok: false };
    }));
    res.json({ coverage });
  } catch { res.json({ coverage: null }); }
});

// ── Google place lookup for POI popups ────────────────────────────────────────
// Places API (New) Text Search with an IDs-only field mask (free SKU) turns an
// OSM name + position into a Google place_id, so the popup link opens the
// place card (reviews, photos) instead of a search. Without the API enabled
// the frontend keeps its plain name@position search link.
const gPlaceCache = new Map();
let gPlaceOffUntil = 0;
app.get('/api/poi/gplace', requireAuth, async (req, res) => {
  const key = process.env.GOOGLE_MAPS_KEY;
  const name = String(req.query.name || '').trim().slice(0, 120);
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
  if (!key || !name || !Number.isFinite(lat) || !Number.isFinite(lng) || Date.now() < gPlaceOffUntil)
    return res.json({ placeId: null });
  const ck = `${name}|${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (gPlaceCache.has(ck)) return res.json({ placeId: gPlaceCache.get(ck) });
  try {
    const r = await axios.post('https://places.googleapis.com/v1/places:searchText', {
      textQuery: name, languageCode: 'pl', maxResultCount: 1,
      locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 150 } },
    }, { headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id' }, timeout: 8000 });
    const placeId = r.data?.places?.[0]?.id || null;
    if (gPlaceCache.size > 5000) gPlaceCache.clear();
    gPlaceCache.set(ck, placeId);
    res.json({ placeId });
  } catch (e) {
    if (e.response?.status === 403) gPlaceOffUntil = Date.now() + 10 * 60 * 1000; // API not enabled
    res.json({ placeId: null });
  }
});

// ── Overpass API proxy ────────────────────────────────────────────────────────
// Public Overpass mirrors are frequently "at capacity" (502/429/500) for a
// few seconds to minutes; overpass-api.de itself asks clients to retry with
// exponential backoff. Rotate through mirrors, back off between full rounds,
// and cache successes so reopening the same route doesn't hit them again.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const OVERPASS_BUDGET_MS = 75000;
const OVERPASS_CACHE_TTL_MS = 24 * 3600 * 1000;
const overpassCache = new Map();

app.post('/api/route/overpass', requireAuth, async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Missing query' });

  const key = require('crypto').createHash('sha1').update(query).digest('hex');
  const hit = overpassCache.get(key);
  if (hit && Date.now() - hit.t < OVERPASS_CACHE_TTL_MS) return res.json(hit.data);

  const body = `data=${encodeURIComponent(query)}`;
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SquadratsApp/2.0 (personal route planner)' };
  const deadline = Date.now() + OVERPASS_BUDGET_MS;
  let delay = 1000;
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    const ep = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
    try {
      const r = await axios.post(ep, body, { headers, timeout: Math.max(5000, Math.min(45000, deadline - Date.now())) });
      // A server-side timeout comes back as 200 with a remark and no data.
      if (r.data?.remark && !r.data.elements?.length) throw new Error(`remark: ${r.data.remark.slice(0, 80)}`);
      if (r.data?.elements?.length) {
        overpassCache.set(key, { t: Date.now(), data: r.data });
        if (overpassCache.size > 100) overpassCache.delete(overpassCache.keys().next().value);
      }
      if (attempt) console.log(`Overpass OK on attempt ${attempt + 1} (${ep})`);
      return res.json(r.data);
    } catch (e) {
      const status = e.response?.status;
      console.error(`Overpass error (${ep}): ${status || e.message}`);
      if (status === 400) return res.status(400).json({ error: 'Błędne zapytanie Overpass' });
    }
    if (attempt % OVERPASS_ENDPOINTS.length === OVERPASS_ENDPOINTS.length - 1) {
      await new Promise(r => setTimeout(r, Math.min(delay, Math.max(0, deadline - Date.now()))));
      delay = Math.min(delay * 2, 15000);
    }
  }
  res.status(503).json({ error: 'Serwery OpenStreetMap (Overpass) są teraz przeciążone' });
});

// ── Local POI database (data/pois.db, built by tools/update-pois.sh) ──────────
// Same answer shape as Overpass ({elements:[{type,id,lat,lon,tags}]}) so the
// frontend renders either. Reopened automatically when an update swaps the file.

const POI_DB_PATH = path.join(path.dirname(process.env.DB_PATH || './data/squadrats.db'), 'pois.db');
let poiDb = null, poiDbMtime = 0;
function getPoiDb() {
  let st;
  try { st = fs.statSync(POI_DB_PATH); } catch { return null; }
  if (!poiDb || st.mtimeMs !== poiDbMtime) {
    try { poiDb?.close(); } catch {}
    poiDb = new (require('better-sqlite3'))(POI_DB_PATH, { readonly: true });
    poiDbMtime = st.mtimeMs;
  }
  return poiDb;
}

const isOrlen = (t) => /orlen/i.test(`${t.brand || ''} ${t.name || ''}`);

app.post('/api/route/pois', requireAuth, (req, res) => {
  const { coords, radiusM = 400, tags: wanted = [] } = req.body;
  const pdb = getPoiDb();
  if (!pdb) return res.status(503).json({ error: 'Brak lokalnej bazy POI', fallback: true });
  if (!Array.isArray(coords) || coords.length < 2) return res.status(400).json({ error: 'coords required' });

  const rKm = Math.min(2, Math.max(0.05, radiusM / 1000));
  const lat0 = coords[0].lat, kx = 111.32 * Math.cos(lat0 * Math.PI / 180), ky = 110.57;
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (const p of coords) {
    if (p.lat < minLat) minLat = p.lat; if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng; if (p.lng > maxLng) maxLng = p.lng;
  }
  const dLat = rKm / ky, dLng = rKm / kx;

  // Route segments bucketed on a ~1 km grid so each candidate only checks
  // nearby segments.
  const CELL = 0.01, grid = new Map(), cellKey = (la, ln) => `${Math.floor(la / CELL)},${Math.floor(ln / CELL)}`;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    const seen = new Set();
    for (const t of [0, 0.5, 1]) {
      const k = cellKey(a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t);
      if (seen.has(k)) continue; seen.add(k);
      (grid.get(k) || grid.set(k, []).get(k)).push(i);
    }
  }
  const near = (lat, lng) => {
    const cy = Math.floor(lat / CELL), cx = Math.floor(lng / CELL);
    const ry = Math.ceil(dLat / CELL) + 1, rx = Math.ceil(dLng / CELL) + 1;
    for (let y = cy - ry; y <= cy + ry; y++) for (let x = cx - rx; x <= cx + rx; x++) {
      for (const i of grid.get(`${y},${x}`) || []) {
        const a = coords[i - 1], b = coords[i];
        const ax = (a.lng - lng) * kx, ay = (a.lat - lat) * ky, dx = (b.lng - a.lng) * kx, dy = (b.lat - a.lat) * ky;
        const l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
        if (Math.hypot(ax + t * dx, ay + t * dy) <= rKm) return true;
      }
    }
    return false;
  };

  const want = new Set(wanted);
  const rows = pdb.prepare(`SELECT p.id, p.osm, p.lat, p.lng, p.tags FROM pois_rtree r JOIN pois p ON p.id = r.id
    WHERE r.min_lat >= ? AND r.max_lat <= ? AND r.min_lng >= ? AND r.max_lng <= ?`)
    .all(minLat - dLat, maxLat + dLat, minLng - dLng, maxLng + dLng);
  const elements = [];
  const byName = new Map(); // the same place is often mapped twice (a point and its building)
  for (const r of rows) {
    const tags = JSON.parse(r.tags);
    const kind = ['amenity', 'shop', 'tourism', 'historic'].find(k => tags[k] && (!want.size || want.has(`${k}=${tags[k]}`)));
    if (!kind) continue;
    if (kind === 'amenity' && tags.amenity === 'fuel' && !isOrlen(tags)) continue; // only Orlen stations count as shops
    if (!near(r.lat, r.lng)) continue;
    {
      // Same name+type within 80 m, or same unnamed type within 40 m.
      const k = `${(tags.name || '').toLowerCase()}|${kind}=${tags[kind]}`;
      const lim = tags.name ? 0.08 : 0.04;
      const prev = byName.get(k) || [];
      if (prev.some(p => Math.hypot((p.lat - r.lat) * ky, (p.lng - r.lng) * kx) < lim)) continue;
      prev.push(r); byName.set(k, prev);
    }
    elements.push({ type: 'node', id: r.osm, lat: r.lat, lon: r.lng, tags });
    if (elements.length >= 2000) break;
  }
  const meta = Object.fromEntries(pdb.prepare('SELECT key, value FROM meta').all().map(m => [m.key, m.value]));
  res.json({ elements, source: 'local', osmTimestamp: meta.osm_timestamp || null });
});

// ── Wikipedia POI near route ───────────────────────────────────────────────────
app.post('/api/route/wiki-poi', requireAuth, async (req, res) => {
  const { samples } = req.body; // [{lat,lng}, ...]
  if (!samples?.length) return res.status(400).json({ error: 'Missing samples' });
  try {
    const wikiHeaders = { 'User-Agent': 'SquadratsApp/2.0' };
    const seen = new Set();
    const articles = [];

    // Search within 1km radius of each sampled route point, deduplicate
    for (const pt of samples) {
      const url = `https://pl.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${pt.lat}|${pt.lng}&gsradius=1000&gslimit=20&format=json&origin=*`;
      try {
        const r = await axios.get(url, { timeout: 6000, headers: wikiHeaders });
        for (const a of (r.data?.query?.geosearch || [])) {
          if (!seen.has(a.pageid)) { seen.add(a.pageid); articles.push(a); }
        }
      } catch (_) { /* skip failed point */ }
    }

    if (!articles.length) return res.json({ pois: [] });

    // Batch-fetch thumbnails + short extracts (max 50 pageids per request)
    const allPages = {};
    for (let i = 0; i < articles.length; i += 50) {
      const chunk = articles.slice(i, i + 50);
      const pageids = chunk.map(a => a.pageid).join('|');
      const thumbUrl = `https://pl.wikipedia.org/w/api.php?action=query&pageids=${pageids}&prop=pageimages|extracts|info&pithumbsize=240&exintro=true&exsentences=2&explaintext=true&inprop=length&format=json&origin=*`;
      try {
        const r = await axios.get(thumbUrl, { timeout: 8000, headers: wikiHeaders });
        Object.assign(allPages, r.data?.query?.pages || {});
      } catch (_) { /* skip */ }
    }

    const pois = articles.map(a => {
      const page = allPages[String(a.pageid)];
      return {
        id: a.pageid,
        title: a.title,
        lat: a.lat,
        lng: a.lon,
        thumb: page?.thumbnail?.source || null,
        extract: page?.extract || '',
        length: page?.length || 0,
        url: `https://pl.wikipedia.org/wiki/${encodeURIComponent(a.title.replace(/ /g, '_'))}`
      };
    }).filter(p => p.thumb)
      .sort((a, b) => b.length - a.length) // dłuższy artykuł = ważniejsze miejsce
      .slice(0, 15);

    res.json({ pois });
  } catch (e) {
    console.error('Wiki POI error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Commons photo cache (see photos.js) ───────────────────────────────────────
// route: which of the route's grid cells are cached, plus the cached files in
// the corridor; cell / info: what the browser fetched from Commons.
const PHOTO_CORRIDOR_KM = 0.3;
const photoSamples = (arr) => (Array.isArray(arr) ? arr : [])
  .filter(p => Number.isFinite(p?.lat) && Number.isFinite(p?.lng)).slice(0, 2000);
app.post('/api/photos/route', requireAuth, (req, res) => {
  const cells = (Array.isArray(req.body?.cells) ? req.body.cells : []).slice(0, 2000);
  res.json({ done: photos.doneCells(cells), files: photos.filesNear(photoSamples(req.body?.samples), PHOTO_CORRIDOR_KM) });
});
app.post('/api/photos/cell', requireAuth, (req, res) => {
  res.json({ saved: photos.saveCell(req.body?.cell, req.body?.hits) });
});
app.post('/api/photos/info', requireAuth, (req, res) => {
  res.json({ saved: photos.saveInfo(req.body?.items) });
});

// ── Mapillary photos along the route (see mapillary.js) ──────────────────────
// Positions from vector tiles, thinned to about one image per PHOTO_CELL_DEG
// (newest first); the thumbnail is fetched when a popup opens.
const PHOTO_CELL_DEG = 0.0015;     // ~150 m

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch { out[k] = []; } }
  }));
  return out;
}

app.post('/api/route/photos', requireAuth, async (req, res) => {
  const token = process.env.MAPILLARY_TOKEN;
  if (!token) return res.json({ photos: [], mapillary: false });
  const samples = photoSamples(req.body?.samples);
  if (!samples.length) return res.json({ photos: [], mapillary: true });
  const pad = 0.004, tilesNeeded = new Set();
  for (const p of samples) for (const dy of [-pad, 0, pad]) for (const dx of [-pad * 1.6, 0, pad * 1.6])
    tilesNeeded.add(mapillary.tileOf(p.lat + dy, p.lng + dx).join(','));
  const lists = await mapLimit([...tilesNeeded].slice(0, 400), 6, (k) => mapillary.tileImages(...k.split(',').map(Number), token));
  let s = 90, n = -90, w = 180, e = -180;
  for (const p of samples) { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lng); e = Math.max(e, p.lng); }
  const cand = lists.flat().filter(im => im && im.lat > s - pad && im.lat < n + pad && im.lng > w - pad * 1.6 && im.lng < e + pad * 1.6)
    .sort((a, b) => b.t - a.t);
  // corridor test once per ~150 m cell (from its centre), exact only near the edge
  const seen = new Set(), cellKm = new Map(), out = [];
  for (const im of cand) {
    const cy = Math.floor(im.lat / PHOTO_CELL_DEG), cx = Math.floor(im.lng / PHOTO_CELL_DEG), k = `${cy},${cx}`;
    if (seen.has(k)) continue;
    if (!cellKm.has(k)) cellKm.set(k, photos.kmToPolyline((cy + 0.5) * PHOTO_CELL_DEG, (cx + 0.5) * PHOTO_CELL_DEG, samples));
    const ck = cellKm.get(k);
    if (ck > PHOTO_CORRIDOR_KM + 0.12) continue;
    if (ck > PHOTO_CORRIDOR_KM - 0.12 && photos.kmToPolyline(im.lat, im.lng, samples) > PHOTO_CORRIDOR_KM) continue;
    seen.add(k);
    out.push({ src: 'mapillary', id: im.id, lat: im.lat, lng: im.lng, pano: im.pano,
      date: im.t ? new Date(im.t).toISOString().slice(0, 10) : '', page: `https://www.mapillary.com/app/?pKey=${im.id}` });
  }
  res.json({ photos: out, mapillary: true });
});

// Thumbnail + author for one image (signed URLs expire, so fetched on demand).
app.get('/api/mapillary/image/:id', requireAuth, async (req, res) => {
  const token = process.env.MAPILLARY_TOKEN;
  if (!token || !/^\d{1,20}$/.test(req.params.id)) return res.status(404).json({});
  try {
    const r = await axios.get(`https://graph.mapillary.com/${req.params.id}`, { timeout: 10000,
      params: { access_token: token, fields: 'thumb_1024_url,creator,captured_at' } });
    res.json({ thumb: r.data.thumb_1024_url || null, author: r.data.creator?.username || '' });
  } catch (e) { res.status(502).json({}); }
});

// ── SPA fallback ──────────────────────────────────────────────────────────────

app.get('*', (req, res) => res.sendFile(path.join(FRONTEND, 'index.html')));

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  Squadrats Route Planner v2 Multi    ║`);
  console.log(`║  http://localhost:${PORT}               ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
  console.log(`  Użytkownicy: ${db.getUserCount()}`);
  console.log(`  DB: ${process.env.DB_PATH}\n`);
});
