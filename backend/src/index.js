/**
 * index.js — Express API server (multi-user)
 */

const express      = require('express');
const compression  = require('compression');
const path         = require('path');
const cookieParser = require('cookie-parser');
const jwt          = require('jsonwebtoken');
const bcrypt       = require('bcryptjs');

const app  = express();
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
  maxAge:   30 * 24 * 60 * 60 * 1000,
};

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const FRONTEND = path.join(__dirname, '../../frontend');
app.use(express.static(FRONTEND));

const db     = require('./db');
const strava = require('./strava');
const tiles  = require('./tiles');
const oauth  = require('./oauth');
const axios  = require('axios');

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
  };
}

// ── Auth routes ───────────────────────────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  const { username, password, email, strava_client_id, strava_client_secret } = req.body;
  if (!username?.trim() || !password) return res.status(400).json({ error: 'Nazwa użytkownika i hasło są wymagane' });
  if (username.trim().length < 3)     return res.status(400).json({ error: 'Nazwa użytkownika min. 3 znaki' });
  if (password.length < 6)            return res.status(400).json({ error: 'Hasło min. 6 znaków' });

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

app.post('/api/auth/login', async (req, res) => {
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
  if (new_password.length < 6) return res.status(400).json({ error: 'Nowe hasło min. 6 znaków' });
  const user = db.getUserById(req.userId);
  if (!user.password_hash) return res.status(400).json({ error: 'Konto social login nie ma hasła. Możesz ustawić nowe hasło bez podawania obecnego.' });
  if (!await bcrypt.compare(current_password, user.password_hash))
    return res.status(401).json({ error: 'Nieprawidłowe obecne hasło' });
  db.updatePasswordHash(req.userId, await bcrypt.hash(new_password, 10));
  res.json({ ok: true });
});

app.put('/api/profile/home', requireAuth, (req, res) => {
  const { lat, lng } = req.body;
  if (lat !== null && (typeof lat !== 'number' || typeof lng !== 'number'))
    return res.status(400).json({ error: 'Nieprawidłowe koordynaty' });
  db.setHomePoint(req.userId, lat ?? null, lng ?? null);
  res.json({ user: safeUser(db.getUserById(req.userId)) });
});

app.put('/api/profile/set-password', requireAuth, async (req, res) => {
  const { new_password } = req.body;
  if (!new_password || new_password.length < 6) return res.status(400).json({ error: 'Hasło min. 6 znaków' });
  const user = db.getUserById(req.userId);
  if (user.password_hash) return res.status(400).json({ error: 'Konto ma już hasło. Użyj opcji zmiany hasła.' });
  db.updatePasswordHash(req.userId, await bcrypt.hash(new_password, 10));
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
  const c = {
    sqRows, sqiRows, yard, uber, yardi, uberi,
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

app.post('/api/sync', requireAuth, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = d => res.write(`data: ${JSON.stringify(d)}\n\n`);
  try {
    const result = await strava.syncActivities(req.userId, p => send(p));
    invalidateUserCache(req.userId);
    send({ phase: 'done', ...result });
  } catch (e) {
    send({ phase: 'error', message: e.message });
  } finally {
    res.end();
  }
});

// ── Stats ─────────────────────────────────────────────────────────────────────

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
    stats:     c.stats,
  });
});

// ── Route (OSRM proxy) ────────────────────────────────────────────────────────

const BROUTER_URL = process.env.BROUTER_URL || 'http://brouter:17777';

async function fetchOsrmRoute(points) {
  const coords = points.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/bike/${coords}?overview=full&geometries=geojson&steps=false`;
  const r = await axios.get(url, { timeout: 20000 });
  return r.data;
}

async function fetchBRouterRoute(points, profile) {
  const lonlats = points.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join('|');
  const url = `${BROUTER_URL}/brouter?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=geojson&timeout=60`;
  const r = await axios.get(url, { timeout: 90000 });
  const feat = r.data?.features?.[0];
  if (!feat) throw new Error('BRouter: pusta odpowiedź');

  let elevProfile = null;
  let surfaceProfile = null;
  const msgs = feat.properties?.messages;
  if (Array.isArray(msgs) && msgs.length > 1) {
    let cumDist = 0;
    const rows = msgs.slice(1).map(row => {
      const segDist = parseFloat(row[3]) / 1000;
      cumDist += segDist;
      const wayTags = row[4] || '';
      const surfM = wayTags.match(/surface=(\S+)/);
      const hwM   = wayTags.match(/highway=(\S+)/);
      const cycM  = wayTags.match(/cycleway=(\S+)/);
      const surface = surfM ? surfM[1] : null;
      const highway = hwM  ? hwM[1]  : null;
      const cycleway = cycM ? cycM[1] : null;
      return { dist: Math.round(cumDist * 100) / 100, elev: parseFloat(row[2]), segDist: Math.round(segDist * 1000) / 1000, surface, highway, cycleway };
    });
    elevProfile = rows.map(r => ({ dist: r.dist, elev: r.elev }));
    surfaceProfile = rows.map(r => ({ dist: r.dist, segDist: r.segDist, surface: r.surface, highway: r.highway, cycleway: r.cycleway }));
  }

  return {
    code: 'Ok', engine: 'brouter', profile,
    routes: [{ distance: parseFloat(feat.properties?.['track-length'] || 0), geometry: feat.geometry, elevProfile, surfaceProfile }]
  };
}

async function fetchRoute(points, bikeProfile) {
  if (bikeProfile && bikeProfile !== 'standard') {
    try { return await fetchBRouterRoute(points, bikeProfile); }
    catch (e) { console.warn(`BRouter (${bikeProfile}) failed, falling back to OSRM:`, e.message); }
  }
  const data = await fetchOsrmRoute(points);
  return { ...data, engine: 'osrm', profile: bikeProfile || 'standard' };
}

function routeDistanceKm(d) { return d?.routes?.[0]?.distance / 1000 || 0; }

app.post('/api/route/detour', requireAuth, async (req, res) => {
  const { waypoints, mode = 'sq', loop = false, targetKm = 0, bikeProfile = 'standard' } = req.body;
  if (!waypoints?.length) return res.status(400).json({ error: 'waypoints required' });

  const c = getUserCache(req.userId);
  const ownedSQSet  = new Set(c.sqRows.map(r => `${r.tx},${r.ty}`));
  const ownedSQISet = new Set(c.sqiRows.map(r => `${r.tx},${r.ty}`));

  let pts = [...waypoints];
  const start = waypoints[0], end = waypoints[waypoints.length - 1];
  const samePoint = tiles.haversineDistance(start, end) < 0.4;

  if (loop || samePoint) {
    if (samePoint && waypoints.length === 2) pts = tiles.createLoopWaypoints(start, targetKm || 15);
    else pts.push(pts[0]);
  }

  if (mode === 'shortest') {
    try { return res.json(await fetchRoute(pts, bikeProfile)); }
    catch (e) { return res.status(500).json({ error: 'Routing error: ' + e.message }); }
  }

  // Long A→B route: straight-line >80km — skip iterative detour, one direct call.
  // Detour algorithm is designed for loops/short routes; for 100km+ A→B it just
  // adds unnecessary BRouter requests and unhelpful waypoints.
  const directKm = tiles.haversineDistance(start, waypoints[waypoints.length - 1]);
  if (!loop && !samePoint && directKm > 80) {
    try { return res.json(await fetchRoute(pts, bikeProfile)); }
    catch (e) { return res.status(500).json({ error: 'Routing error: ' + e.message }); }
  }

  const tolerance = 0.15, target = Math.max(0, targetKm);
  let routeData;
  try { routeData = await fetchRoute(pts, bikeProfile); }
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

  // Fewer iterations for medium-long routes (>50km) — convergence is harder anyway
  const maxAttempts = baseKm > 50 ? 3 : 8;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const detourPts = tiles.buildDetourWaypoints(pts, ownedSQSet, ownedSQISet, mode, currentTarget / roadFactor);
    if (detourPts.length < 2) break;
    let dd;
    try { dd = await fetchRoute(detourPts, bikeProfile); } catch { break; }
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

// ── Komoot import ─────────────────────────────────────────────────────────────

app.get('/api/komoot/tour', requireAuth, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Brak URL' });

  // Support: /tour/ID, /t/ID, /pl-pl/tour/ID, /pl-pl/smarttour/ID, /smarttour/ID
  const m = url.match(/komoot\.(?:com|de)\/(?:[a-z]{2}-[a-z]{2}\/)?(?:smart)?(?:tour|t)\/(\d+)/i);
  if (!m) return res.status(400).json({ error: 'Nieprawidłowy link Komoot. Wklej URL trasy, np. https://www.komoot.com/tour/1234567890 lub https://www.komoot.com/pl-pl/smarttour/40291321' });

  const id = m[1];
  try {
    const r = await fetch(`https://www.komoot.com/api/v007/tours/${id}?_embedded=coordinates`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.komoot.com/',
      }
    });
    if (!r.ok) {
      const msg = (r.status === 401 || r.status === 403)
        ? 'Trasa jest prywatna — wyeksportuj GPX z Komoot'
        : `Błąd Komoot API (${r.status})`;
      return res.status(r.status).json({ error: msg });
    }
    const d = await r.json();
    const items = d._embedded?.coordinates?.items;
    if (!items?.length) return res.status(404).json({ error: 'Brak punktów trasy w odpowiedzi Komoot' });

    res.json({
      name: d.name || `Trasa Komoot #${id}`,
      distanceM: Math.round(d.distance || 0),
      sport: d.sport || '',
      coords: items.map(c => ({ lat: c.lat, lng: c.lng, elev: c.alt ?? 0 })),
    });
  } catch (e) {
    res.status(500).json({ error: 'Błąd połączenia z Komoot: ' + e.message });
  }
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

// ── Preview tiles ─────────────────────────────────────────────────────────────

app.post('/api/route/preview-tiles', requireAuth, (req, res) => {
  const { coords } = req.body;
  if (!coords?.length) return res.status(400).json({ error: 'coords required' });
  const ownedSQ  = new Set(db.getAllTilesSQ(req.userId).map(r => `${r.tx},${r.ty}`));
  const ownedSQI = new Set(db.getAllTilesSQI(req.userId).map(r => `${r.tx},${r.ty}`));
  const { sq14, sq17 } = tiles.trackToTiles(coords);
  const newSQ  = [...sq14].filter(k => !ownedSQ.has(k)).map(k => { const [tx,ty]=k.split(',').map(Number); return {tx,ty}; });
  const newSQI = [...sq17].filter(k => !ownedSQI.has(k)).map(k => { const [tx,ty]=k.split(',').map(Number); return {tx,ty}; });
  res.json({ newSQ, newSQI, countSQ: newSQ.length, countSQI: newSQI.length });
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
