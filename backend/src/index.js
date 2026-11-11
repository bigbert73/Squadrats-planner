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
const apple  = require('./apple');
const mail   = require('./mail');
const weather = require('./weather');
const statshunters = require('./statshunters');
const axios  = require('axios');
const crypto = require('crypto');

const app  = express();
app.disable('x-powered-by');
// Behind a reverse proxy: how many proxies sit in front of the backend (OpenShift: router + nginx).
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));
const PORT = process.env.PORT || 3000;

// A rejected promise in an async handler would otherwise be an unhandled
// rejection, which ends the process — one bad request would log everyone
// out of a running sync or route calculation. Every handler registered below
// hands its errors to the error middleware at the end of this file instead.
for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
  const register = app[m].bind(app);
  app[m] = (route, ...handlers) => register(route, ...handlers.map(h => (typeof h !== 'function' || h.length > 3) ? h
    : function (req, res, next) {
      try { const r = h(req, res, next); if (r && typeof r.catch === 'function') r.catch(next); }
      catch (e) { next(e); }
    }));
}
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

app.use(compression());

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'");
  // A page of another site must not be able to make the browser change data
  // here with the visitor's session (the cookie is SameSite=Lax as well).
  // The one exception is Apple's answer to "Sign in with Apple", which Apple
  // delivers as a form POST from its own site; it changes nothing by itself
  // (see /auth/apple/callback).
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['sec-fetch-site'] === 'cross-site'
      && !(req.method === 'POST' && req.path === '/auth/apple/callback'))
    return res.status(403).json({ error: 'Żądanie z innej strony' });
  next();
});

// Session signing key. Without JWT_SECRET in the environment a random key is
// created once and kept next to the database (data/ is not in the repository),
// so sessions survive restarts and there is no shared default to forge them with.
function loadJwtSecret() {
  const file = path.join(path.dirname(process.env.DB_PATH || path.join(__dirname, '../../data/squadrats.db')), '.jwt-secret');
  try { const s = fs.readFileSync(file, 'utf8').trim(); if (s.length >= 32) return s; } catch {}
  const s = crypto.randomBytes(48).toString('hex');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, s + '\n', { mode: 0o600 });
    console.log(`[auth] JWT_SECRET nie jest ustawiony: utworzono losowy klucz sesji (${file})`);
  } catch (e) {
    console.warn(`[auth] JWT_SECRET nie jest ustawiony i nie udało się zapisać klucza (${e.message}): sesje wygasną przy restarcie`);
  }
  return s;
}
const JWT_SECRET = process.env.JWT_SECRET || loadJwtSecret();

const COOKIE_OPTS = {
  httpOnly: true,
  secure:   process.env.COOKIE_SECURE === 'true',
  sameSite: 'lax',
  maxAge:   30 * 24 * 60 * 60 * 1000, // 30 days
};

app.use(cookieParser());

// Who is asking, from the session cookie: { userId, v } or null. Checks the
// signature only; requireAuth also checks that the account still exists.
function sessionOf(req) {
  if (req._session !== undefined) return req._session;
  let s = null;
  const token = req.cookies?.token;
  if (typeof token === 'string' && token) {
    try {
      const d = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
      // OAuth state tokens are signed with the same key but carry a purpose
      if (Number.isInteger(d.userId) && !d.p) s = { userId: d.userId, v: d.v | 0 };
    } catch {}
  }
  return (req._session = s);
}
function issueSession(req, res, user) {
  res.cookie('token', jwt.sign({ userId: user.id, v: user.token_version | 0 }, JWT_SECRET, { expiresIn: '30d' }), COOKIE_OPTS);
}

// Request bodies: small for anyone not logged in (login and registration are
// a few hundred bytes); a route with its geometry needs a few MB, a GPX file more.
const jsonSmall = express.json({ limit: '64kb' }), jsonMid = express.json({ limit: '8mb' }), jsonBig = express.json({ limit: '30mb' });
app.use((req, res, next) => {
  if (!sessionOf(req)) return jsonSmall(req, res, next);
  return (req.path === '/api/gpx/import' ? jsonBig : jsonMid)(req, res, next);
});

const FRONTEND = path.join(__dirname, '../../frontend');
app.use(express.static(FRONTEND));

// ── Input checks ──────────────────────────────────────────────────────────────

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
// A position usable on the tile grid (Web Mercator ends at ±85.05°)
const okPt = (p) => !!p && typeof p === 'object' && isNum(p.lat) && isNum(p.lng) && Math.abs(p.lat) <= 85.05 && Math.abs(p.lng) <= 180;
const cleanPts = (arr, max) => (Array.isArray(arr) ? arr : []).filter(okPt).slice(0, max).map(p => ({ lat: p.lat, lng: p.lng }));
const text = (v, max) => (typeof v === 'string' ? v : '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const BIKE_PROFILES = new Set(['standard', 'fastbike', 'gravel', 'rowery-pl', 'safety', 'mtb', 'trekking', 'foot', 'run']);
// The name the app shows (header, browser tab, installed icon, e-mails, GPX).
// "Squadrats" is somebody else's trademark: set APP_NAME to your own.
const APP_NAME = text(process.env.APP_NAME, 60) || 'Squadrats Route Planner';
const APP_SHORT_NAME = text(process.env.APP_SHORT_NAME, 14) || (APP_NAME.length <= 14 ? APP_NAME : APP_NAME.split(/\s+/)[0].slice(0, 14));
// The address people reach the app at, for links that leave it (e-mail).
// Never taken from the request: its Host header is whatever the sender wrote.
const PUBLIC_BASE = (process.env.APP_BASE_URL || oauth.APP_BASE).replace(/\/+$/, '');
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const N_SQI = 2 ** 17;
const okTile = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < N_SQI && y < N_SQI;

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const s = sessionOf(req);
  if (!s) return res.status(401).json({ error: req.cookies?.token ? 'Nieprawidłowy token' : 'Nie zalogowany' });
  const user = db.getUserById(s.userId);
  // account deleted, or password changed on another device since this session began
  if (!user || (user.token_version | 0) !== s.v) {
    res.clearCookie('token');
    return res.status(401).json({ error: 'Sesja wygasła. Zaloguj się ponownie.' });
  }
  req.userId = user.id;
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Tylko administrator' });
    next();
  });
}

function safeUser(user) {
  const tok = db.getToken(user.id);
  const own = strava.ownCreds(user);
  return {
    id:                user.id,
    username:          user.username,
    email:             user.email,
    role:              user.role,
    has_password:      !!user.password_hash,
    oauth_provider:    user.oauth_provider || null,
    // can connect: with the shared application of this installation or own keys
    strava_configured: !!strava.credsFor(user),
    strava_shared:     !!strava.appCreds(),
    // keys of their own, other than the shared application's
    strava_own_keys:   !!own && own.id !== strava.appCreds()?.id,
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
const okPassword = (p) => typeof p === 'string' && p.length <= 200 && PASSWORD_POLICY.test(p);
// Letters, digits and . _ - (a space inside is fine); shown to the admin and
// usable as a login, so no markup, no control characters, no e-mail look-alikes.
const USERNAME_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N}._ -]{1,30})[\p{L}\p{N}._-]$/u;
const EMAIL_RE = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,180}\.[^\s@<>"'.]{2,}$/;
// Compared against when the account does not exist or has no password, so the
// answer takes as long as a real check.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(12).toString('hex'), 10);

app.post('/api/auth/register', registerLimiter, async (req, res) => {
  const b = req.body || {};
  if (typeof b.username !== 'string' || typeof b.password !== 'string' || !b.username.trim() || !b.password)
    return res.status(400).json({ error: 'Nazwa użytkownika i hasło są wymagane' });
  const username = b.username.trim().normalize('NFC');
  if (username.length < 3)  return res.status(400).json({ error: 'Nazwa użytkownika min. 3 znaki' });
  if (username.length > 32) return res.status(400).json({ error: 'Nazwa użytkownika maks. 32 znaki' });
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Nazwa użytkownika: tylko litery, cyfry, kropka, myślnik i podkreślenie' });
  if (!okPassword(b.password)) return res.status(400).json({ error: 'Hasło min. 8 znaków i co najmniej 1 cyfra' });
  let email = null;
  if (b.email !== undefined && b.email !== null && b.email !== '') {
    if (typeof b.email !== 'string' || b.email.length > 254 || !EMAIL_RE.test(b.email.trim())) return res.status(400).json({ error: 'Nieprawidłowy adres e-mail' });
    email = b.email.trim();
  }
  for (const k of ['strava_client_id', 'strava_client_secret'])
    if (b[k] !== undefined && b[k] !== null && typeof b[k] !== 'string') return res.status(400).json({ error: 'Nieprawidłowe dane Strava API' });
  const sid = text(b.strava_client_id, 40), ssec = text(b.strava_client_secret, 100);
  if (sid && !/^\d{1,12}$/.test(sid)) return res.status(400).json({ error: 'Client ID ze Stravy to sama liczba' });

  if (db.getUserByUsername(username) || db.getUserByEmail(username)) return res.status(409).json({ error: 'Nazwa użytkownika jest zajęta' });
  if (email && (db.getUserByEmail(email) || db.getUserByUsername(email))) return res.status(409).json({ error: 'Email jest już zarejestrowany' });

  const hash = await bcrypt.hash(b.password, 10);
  let userId;
  try {
    userId = db.createUser(username, hash, email).lastInsertRowid;
  } catch (e) {
    // two registrations of the same name at the same moment
    if (/UNIQUE/i.test(e.message)) return res.status(409).json({ error: 'Nazwa użytkownika jest zajęta' });
    throw e;
  }
  if (sid && ssec) db.updateStravaCredentials(userId, sid, ssec);
  db.updateLastLogin(userId);
  const user = db.getUserById(userId);
  issueSession(req, res, user);
  res.json({ user: safeUser(user) });
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password)
    return res.status(400).json({ error: 'Wymagana nazwa i hasło' });
  if (username.length > 254 || password.length > 200) return res.status(401).json({ error: 'Nieprawidłowe dane logowania' });
  const name = username.trim();
  const user = db.getUserByUsername(name) || db.getUserByEmail(name);
  // Accounts created with Google have no password: same answer as a wrong one
  const ok = await bcrypt.compare(password, user?.password_hash || DUMMY_HASH);
  if (!user || !user.password_hash || !ok) return res.status(401).json({ error: 'Nieprawidłowe dane logowania' });
  db.updateLastLogin(user.id);
  issueSession(req, res, user);
  res.json({ user: safeUser(user) });
  setImmediate(() => buildUserCache(user.id));
});

// ── Forgotten password ────────────────────────────────────────────────────────
// A link with a random token goes to the account's e-mail address. Only the
// token's hash is stored; it works once, for an hour. Needs SMTP_URL.

const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 6, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Zbyt wiele próśb o nowe hasło. Spróbuj ponownie za godzinę.' },
});
const RESET_TTL_MS = 60 * 60 * 1000;

app.post('/api/auth/forgot', forgotLimiter, (req, res) => {
  if (!mail.configured()) return res.status(404).json({ error: 'Odzyskiwanie hasła e-mailem nie jest włączone' });
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  if (email.length > 254 || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Nieprawidłowy adres e-mail' });
  const lang = mail.LANGS.includes(req.body?.lang) ? req.body.lang : 'pl';
  // The same answer, sent before anything is looked up: neither its content
  // nor its timing says whether the address has an account.
  res.json({ ok: true });
  setImmediate(async () => {
    try {
      const user = db.getUserByEmail(email);
      if (!user || db.recentResets(user.id, RESET_TTL_MS) >= 3) return;   // at most 3 letters an hour per account
      const token = crypto.randomBytes(32).toString('base64url');
      db.addReset(sha256(token), user.id, Date.now() + RESET_TTL_MS);
      // in the fragment, so the token is never sent to (or logged by) a server on the way
      await mail.sendReset({ to: user.email, link: `${PUBLIC_BASE}/#reset=${token}`, lang, appName: APP_NAME, appBase: PUBLIC_BASE });
    } catch (e) { console.error('[mail] reset:', e.message); }
  });
});

app.post('/api/auth/reset', loginLimiter, async (req, res) => {
  const { token, password } = req.body || {};
  const gone = () => res.status(400).json({ error: 'Link wygasł albo został już użyty. Poproś o nowy.' });
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return gone();
  if (!okPassword(password)) return res.status(400).json({ error: 'Hasło min. 8 znaków i co najmniej 1 cyfra' });
  const r = db.getReset(sha256(token));
  const user = r && db.getUserById(r.user_id);
  if (!user) return gone();
  db.clearResets(user.id);                                  // before anything slow: the link works once
  db.updatePasswordHash(user.id, await bcrypt.hash(password, 10));   // ends every session of the account
  db.updateLastLogin(user.id);
  const fresh = db.getUserById(user.id);
  issueSession(req, res, fresh);
  res.json({ user: safeUser(fresh) });
  setImmediate(() => buildUserCache(user.id));
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json(safeUser(req.user)));

// ── Profile routes ────────────────────────────────────────────────────────────

app.put('/api/profile/strava', requireAuth, (req, res) => {
  const id = text(req.body?.strava_client_id, 40), secret = text(req.body?.strava_client_secret, 100);
  if (id && !/^\d{1,12}$/.test(id)) return res.status(400).json({ error: 'Client ID ze Stravy to sama liczba' });
  // Both empty: back to the shared application. Secret left empty next to an
  // unchanged ID: keep the one already saved (it is never sent to the browser).
  const keep = id && !secret && id === String(req.user.strava_client_id || '') ? req.user.strava_client_secret : null;
  if (id && !secret && !keep) return res.status(400).json({ error: 'Podaj Client Secret' });
  if (!id && secret) return res.status(400).json({ error: 'Podaj Client ID' });
  db.updateStravaCredentials(req.userId, id || null, secret || keep || null);
  res.json({ user: safeUser(db.getUserById(req.userId)) });
});

// Disconnect Strava: the authorisation is withdrawn at Strava and the tokens
// are forgotten here. Squares already collected stay (they are the rider's own
// record; deleting the account removes them).
async function stravaDisconnect(userId) {
  const tok = db.getToken(userId);
  if (!tok) return false;
  // Strava keeps one authorisation per athlete and application: leave it alone
  // while another account here still relies on it.
  if (!db.athleteSharedByOthers(userId, tok)) {
    try { await strava.deauthorize(userId); }
    catch (e) { console.warn(`[strava] deauthorize user=${userId}: ${e.response?.status || e.message}`); }
  }
  db.clearToken(userId);
  return true;
}
app.post('/api/profile/strava/disconnect', requireAuth, async (req, res) => {
  await stravaDisconnect(req.userId);
  res.json({ user: safeUser(db.getUserById(req.userId)) });
});

// A new password ends the sessions on every other device; this one continues.
function setPassword(req, res, hash) {
  db.updatePasswordHash(req.userId, hash);
  issueSession(req, res, db.getUserById(req.userId));
  res.json({ ok: true });
}

app.put('/api/profile/password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (typeof current_password !== 'string' || typeof new_password !== 'string' || !current_password || !new_password)
    return res.status(400).json({ error: 'Wymagane oba hasła' });
  if (!okPassword(new_password)) return res.status(400).json({ error: 'Hasło min. 8 znaków i co najmniej 1 cyfra' });
  if (!req.user.password_hash) return res.status(400).json({ error: 'Konto social login nie ma hasła. Możesz ustawić nowe hasło bez podawania obecnego.' });
  if (current_password.length > 200 || !await bcrypt.compare(current_password, req.user.password_hash))
    return res.status(403).json({ error: 'Nieprawidłowe obecne hasło' });
  setPassword(req, res, await bcrypt.hash(new_password, 10));
});

// The address the "forgot my password" link goes to. Whoever can change it can
// take the account over, so an account with a password asks for it.
app.put('/api/profile/email', requireAuth, loginLimiter, async (req, res) => {
  const b = req.body || {};
  let email = null;
  if (b.email !== undefined && b.email !== null && b.email !== '') {
    if (typeof b.email !== 'string' || b.email.length > 254 || !EMAIL_RE.test(b.email.trim())) return res.status(400).json({ error: 'Nieprawidłowy adres e-mail' });
    email = b.email.trim();
  }
  if (req.user.password_hash) {
    const cur = b.current_password;
    if (typeof cur !== 'string' || !cur) return res.status(400).json({ error: 'Podaj obecne hasło' });
    if (cur.length > 200 || !await bcrypt.compare(cur, req.user.password_hash)) return res.status(403).json({ error: 'Nieprawidłowe obecne hasło' });
  }
  if (email) {
    const other = db.getUserByEmail(email) || db.getUserByUsername(email);
    if (other && other.id !== req.userId) return res.status(409).json({ error: 'Email jest już zarejestrowany' });
  }
  try { db.setEmail(req.userId, email); }
  catch (e) { if (/UNIQUE/i.test(e.message)) return res.status(409).json({ error: 'Email jest już zarejestrowany' }); throw e; }
  db.clearResets(req.userId);   // links sent to the old address stop working
  res.json({ user: safeUser(db.getUserById(req.userId)) });
});

app.put('/api/profile/layers', requireAuth, (req, res) => {
  const l = req.body?.layers;
  if (!l || typeof l !== 'object' || Array.isArray(l)) return res.status(400).json({ error: 'Nieprawidłowe warstwy' });
  const clean = Object.fromEntries(Object.entries(l).filter(([k, v]) => /^[a-z0-9-]{1,20}$/.test(k) && typeof v === 'boolean').slice(0, 30));
  db.setMapLayers(req.userId, JSON.stringify(clean));
  res.json({ ok: true });
});

app.put('/api/profile/home', requireAuth, (req, res) => {
  const { lat, lng } = req.body || {};
  const clear = lat === null || lat === undefined;
  if (!clear && !okPt({ lat, lng })) return res.status(400).json({ error: 'Nieprawidłowe koordynaty' });
  db.setHomePoint(req.userId, clear ? null : lat, clear ? null : lng);
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
  const key = typeof req.query.key === 'string' ? req.query.key : '';
  const userId = /^[0-9a-f]{16,64}$/i.test(key) ? db.userIdByGarminKey(key) : null;
  console.log(`[garmin] area user=${userId || '-'}`);
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
  const { new_password } = req.body || {};
  if (!okPassword(new_password)) return res.status(400).json({ error: 'Hasło min. 8 znaków i co najmniej 1 cyfra' });
  if (req.user.password_hash) return res.status(400).json({ error: 'Konto ma już hasło. Użyj opcji zmiany hasła.' });
  setPassword(req, res, await bcrypt.hash(new_password, 10));
});

// ── Account deletion (by the user) ────────────────────────────────────────────
// Confirmed with the password, or with the username for Google/Strava-only
// accounts. Revokes the Strava authorisation, then removes every row of the
// user: activities, squares, routes, blocked squares, tokens.
app.delete('/api/profile', requireAuth, async (req, res) => {
  const user = req.user;
  const { password, confirm } = req.body || {};
  if (user.password_hash) {
    if (typeof password !== 'string' || !password || password.length > 200 || !await bcrypt.compare(password, user.password_hash))
      return res.status(403).json({ error: 'Nieprawidłowe hasło' });
  } else if (typeof confirm !== 'string' || confirm.trim().toLowerCase() !== String(user.username).toLowerCase()) {
    return res.status(403).json({ error: 'Wpisz swoją nazwę użytkownika, aby potwierdzić' });
  }
  if (user.role === 'admin') {
    const others = db.getAllUsers().filter(u => u.id !== user.id);
    if (others.length && !others.some(u => u.role === 'admin'))
      return res.status(400).json({ error: 'Jesteś jedynym administratorem. Najpierw nadaj komuś rolę admina.' });
  }
  await stravaDisconnect(user.id);
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
    strava_configured: !!(u.strava_client_id) || !!strava.appCreds(),
    strava_own_keys:   !!(u.strava_client_id) && String(u.strava_client_id) !== strava.appCreds()?.id,
    strava_connected:  !!db.getToken(u.id),
    sq_count:          db.getSQCount(u.id),
  }));
  res.json({ users });
});

// The account an admin route names in its path, or a 404
function adminTarget(req, res) {
  const id = /^\d{1,15}$/.test(req.params.id) ? Number(req.params.id) : NaN;
  const target = Number.isSafeInteger(id) ? db.getUserById(id) : null;
  if (!target) { res.status(404).json({ error: 'Użytkownik nie istnieje' }); return null; }
  return target;
}

app.put('/api/admin/users/:id/role', requireAdmin, (req, res) => {
  const target = adminTarget(req, res);
  if (!target) return;
  if (target.id === req.userId) return res.status(400).json({ error: 'Nie możesz zmienić własnej roli' });
  const role = req.body?.role;
  if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Nieprawidłowa rola' });
  db.updateUserRole(target.id, role);
  console.log(`[admin] user ${req.userId} set role of user ${target.id} to ${role}`);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const target = adminTarget(req, res);
  if (!target) return;
  if (target.id === req.userId) return res.status(400).json({ error: 'Nie możesz usunąć własnego konta' });
  db.deleteUser(target.id);
  invalidateUserCache(target.id);
  for (let i = clientLogs.length - 1; i >= 0; i--) if (clientLogs[i].uid === target.id) clientLogs.splice(i, 1);
  console.log(`[admin] user ${req.userId} deleted user ${target.id}`);
  res.json({ ok: true });
});

// ── Health check (no auth — for OCP probes) ──────────────────────────────────

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ── OAuth providers (public — tells frontend which buttons to show) ────────────

app.get('/api/auth/providers', (req, res) => {
  res.json({
    google: !!process.env.GOOGLE_CLIENT_ID,
    strava: !!strava.appCreds(),   // "Continue with Strava": log in and connect in one step
    apple:  apple.configured(),
    reset:  mail.configured(),     // "forgot my password" by e-mail
    appName: APP_NAME,
  });
});

// What a phone or desktop needs to install the app (name and icons)
app.get('/api/manifest.webmanifest', (req, res) => {
  res.set('Content-Type', 'application/manifest+json; charset=utf-8');
  res.set('Cache-Control', 'no-cache');
  res.send(JSON.stringify({
    name: APP_NAME, short_name: APP_SHORT_NAME, id: '/', start_url: '/', scope: '/',
    display: 'standalone', orientation: 'any', background_color: '#0f1115', theme_color: '#0f1115',
    categories: ['sports', 'navigation', 'travel'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }));
});

// ── Social OAuth flows ────────────────────────────────────────────────────────

// The `state` that travels through the provider and back is signed, carries
// its purpose (so it can never be used as a session, nor a session as a state)
// and, for Google, a number that must match a cookie of the browser that
// started the login: nobody can be logged in to somebody else's account by
// following a prepared link.
function verifyState(state, purpose) {
  if (typeof state !== 'string' || !state) return null;
  try {
    const d = jwt.verify(state, JWT_SECRET, { algorithms: ['HS256'] });
    return d.p === purpose ? d : null;
  } catch { return null; }
}

function oauthSuccess(req, res, user) {
  db.updateLastLogin(user.id);
  issueSession(req, res, user);
  res.redirect('/?auth=ok');
  setImmediate(() => buildUserCache(user.id));
}

function oauthError(res, err) {
  console.error('[OAuth]', err.response?.status || '', err.message || err);
  res.redirect('/?auth=error&msg=' + encodeURIComponent(String(err.message || err).slice(0, 200)));
}

// Google
app.get('/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(404).send('Google OAuth nie jest skonfigurowane');
  // Google sends the browser back to one fixed address. Start there, so the
  // cookie set below is still there when it returns.
  let home = null;
  try { home = new URL(oauth.APP_BASE); } catch {}
  if (home && req.hostname !== home.hostname && req.query.c === undefined) return res.redirect(`${oauth.APP_BASE}/auth/google?c=1`);
  const n = crypto.randomBytes(16).toString('hex');
  res.cookie('oauth_n', n, { httpOnly: true, secure: COOKIE_OPTS.secure, sameSite: 'lax', maxAge: 10 * 60 * 1000, path: '/auth' });
  res.redirect(oauth.googleAuthUrl(jwt.sign({ p: 'google', n }, JWT_SECRET, { expiresIn: '10m' })));
});
app.get('/auth/google/callback', async (req, res) => {
  const { code, error, state } = req.query;
  const n = req.cookies?.oauth_n;
  res.clearCookie('oauth_n', { path: '/auth' });
  if (error) return oauthError(res, new Error(typeof error === 'string' ? error : 'oauth_error'));
  const st = verifyState(state, 'google');
  if (!st || typeof n !== 'string' || st.n !== n) return res.redirect('/?auth=error&msg=invalid_state');
  if (typeof code !== 'string' || !code) return res.redirect('/?auth=error&msg=no_code');
  try { oauthSuccess(req, res, await oauth.googleCallback(code)); }
  catch (e) { oauthError(res, e); }
});

// Apple
const appleRedirect = () => `${oauth.APP_BASE}/auth/apple/callback`;
app.get('/auth/apple', (req, res) => {
  if (!apple.configured()) return res.status(404).send('Logowanie Apple nie jest skonfigurowane');
  let home = null;
  try { home = new URL(oauth.APP_BASE); } catch {}
  if (home && req.hostname !== home.hostname && req.query.c === undefined) return res.redirect(`${oauth.APP_BASE}/auth/apple?c=1`);
  const n = crypto.randomBytes(16).toString('hex');
  res.cookie('oauth_n', n, { httpOnly: true, secure: COOKIE_OPTS.secure, sameSite: 'lax', maxAge: 10 * 60 * 1000, path: '/auth' });
  res.redirect(apple.authUrl(jwt.sign({ p: 'apple', n }, JWT_SECRET, { expiresIn: '10m' }), appleRedirect()));
});
// Apple answers with a form POST from appleid.apple.com. The browser does not
// attach our cookies to it (SameSite), so nothing is decided here: the answer
// is handed to a page load of our own, where the cookie that proves this
// browser started the login is present.
app.post('/auth/apple/callback', express.urlencoded({ extended: false, limit: '16kb' }), (req, res) => {
  const b = req.body || {}, q = new URLSearchParams();
  for (const k of ['code', 'state', 'error']) if (typeof b[k] === 'string' && b[k].length <= 4000) q.set(k, b[k]);
  res.redirect(303, '/auth/apple/finish?' + q);
});
app.get('/auth/apple/finish', async (req, res) => {
  const { code, error, state } = req.query;
  const n = req.cookies?.oauth_n;
  res.clearCookie('oauth_n', { path: '/auth' });
  if (!apple.configured()) return res.redirect('/?auth=error&msg=not_configured');
  if (error) return oauthError(res, new Error(typeof error === 'string' ? error : 'oauth_error'));
  const st = verifyState(state, 'apple');
  if (!st || typeof n !== 'string' || st.n !== n) return res.redirect('/?auth=error&msg=invalid_state');
  if (typeof code !== 'string' || !code) return res.redirect('/?auth=error&msg=no_code');
  try {
    const who = await apple.exchange(code, appleRedirect());
    oauthSuccess(req, res, await oauth.findOrCreate('apple', who.sub, who.email));
  } catch (e) { oauthError(res, e); }
});

// ── Strava OAuth ──────────────────────────────────────────────────────────────
// Two ways in, one address Strava returns to (/auth/callback):
//   /auth/strava        connect Strava to the account that is logged in
//   /auth/strava/login  "Continue with Strava": log in (or create the account)
//                       and connect in one step, with the shared application

app.get('/auth/strava', requireAuth, (req, res) => {
  const creds = strava.credsFor(req.user);
  if (!creds) return res.redirect('/?error=strava-config-missing');
  const state = jwt.sign({ p: 'strava', uid: req.userId }, JWT_SECRET, { expiresIn: '10m' });
  res.redirect(strava.getAuthUrl(creds.id, state));
});

app.get('/auth/strava/login', (req, res) => {
  const app_ = strava.appCreds();
  if (!app_) return res.status(404).send('Logowanie przez Stravę nie jest skonfigurowane');
  // Strava returns to one fixed address: start there, so the cookie is still there
  let home = null;
  try { home = new URL(oauth.APP_BASE); } catch {}
  if (home && req.hostname !== home.hostname && req.query.c === undefined) return res.redirect(`${oauth.APP_BASE}/auth/strava/login?c=1`);
  const n = crypto.randomBytes(16).toString('hex');
  res.cookie('oauth_n', n, { httpOnly: true, secure: COOKIE_OPTS.secure, sameSite: 'lax', maxAge: 10 * 60 * 1000, path: '/auth' });
  res.redirect(strava.getAuthUrl(app_.id, jwt.sign({ p: 'strava-login', n }, JWT_SECRET, { expiresIn: '10m' })));
});

// What went wrong, in words a rider can act on
function stravaAuthError(e) {
  const detail = JSON.stringify(e.response?.data || '');
  if (e.code === 'STRAVA_RATE') return e.message;
  if (e.response?.status === 403 || /limit of connected athletes/i.test(detail))
    return 'Ta instalacja osiągnęła limit kont Stravy. Administrator musi poprosić Stravę o zwiększenie limitu.';
  if (e.response?.status === 400 || e.response?.status === 401) return 'Strava odrzuciła autoryzację. Spróbuj ponownie.';
  return e.response ? `Strava odpowiedziała błędem ${e.response.status}` : (e.message || 'Błąd połączenia ze Stravą');
}

// A login name for an account created by "Continue with Strava"
function usernameForAthlete(a) {
  const clean = (v) => String(v || '').normalize('NFC').replace(/[^\p{L}\p{N}._ -]/gu, '').replace(/\s+/g, ' ').trim();
  const base = [clean(a.firstname), clean(a.lastname)].filter(Boolean).join(' ').slice(0, 28).trim();
  const free = (n) => USERNAME_RE.test(n) && !db.getUserByUsername(n) && !db.getUserByEmail(n);
  if (base && free(base)) return base;
  for (let i = 2; base && i < 50; i++) if (free(`${base} ${i}`)) return `${base} ${i}`;
  return `strava_${a.id}`;
}

// First sync right after connecting, so the squares are there without a click
function syncSoon(userId) {
  setImmediate(() => runStravaSync(userId, 'auto').catch(e => console.warn(`[strava] first sync user=${userId}: ${e.message}`)));
}

app.get('/auth/callback', async (req, res) => {
  const { code, error, state, scope } = req.query;
  const n = req.cookies?.oauth_n;
  if (n) res.clearCookie('oauth_n', { path: '/auth' });
  if (error || typeof code !== 'string' || !code) {
    const msg = error === 'access_denied' ? 'Nie udzielono dostępu do Stravy' : (typeof error === 'string' ? error.slice(0, 100) : 'no_code');
    return res.redirect('/?auth=error&msg=' + encodeURIComponent(msg));
  }
  if (!strava.scopeAllowsActivities(scope))
    return res.redirect('/?auth=error&msg=' + encodeURIComponent('Bez dostępu do aktywności nie da się policzyć kwadratów. Połącz ponownie i zostaw zaznaczone aktywności.'));

  // ── log in with Strava ──
  const login = verifyState(state, 'strava-login');
  if (login) {
    const app_ = strava.appCreds();
    if (!app_ || typeof n !== 'string' || login.n !== n) return res.redirect('/?auth=error&msg=invalid_state');
    try {
      const d = await strava.exchangeWith(app_, code);
      const athlete = d.athlete;
      if (!athlete || !Number.isSafeInteger(athlete.id)) throw new Error('Strava nie zwróciła identyfikatora konta');
      // the account this athlete is connected to, else the one they created
      // by logging in with Strava before, else a new one
      let user = db.getUserByAthlete(athlete.id) || db.getUserByOAuth('strava', String(athlete.id));
      let fresh = false;
      if (!user) {
        user = db.getUserById(db.createOAuthUser('strava', String(athlete.id), null, usernameForAthlete(athlete)).lastInsertRowid);
        fresh = true;
        console.log(`[strava] new account ${user.id} created by Strava login`);
      }
      // An account with its own application keeps the tokens of that application
      const own = strava.ownCreds(user), had = db.getToken(user.id);
      if (!had || !own || own.id === app_.id) {
        strava.saveExchanged(user.id, d, app_.id);
        invalidateUserCache(user.id);
        if (!had) { fresh = true; syncSoon(user.id); }
      }
      db.updateLastLogin(user.id);
      issueSession(req, res, user);
      res.redirect(fresh ? '/?auth=strava-new' : '/?auth=ok');
      setImmediate(() => buildUserCache(user.id));
    } catch (e) {
      console.error('[strava] login:', e.response?.status || '', e.message);
      res.redirect('/?auth=error&msg=' + encodeURIComponent(stravaAuthError(e)));
    }
    return;
  }

  // ── connect Strava to the account that started the flow ──
  // If this browser is logged in here, it has to be that same account.
  const st = verifyState(state, 'strava');
  const s = sessionOf(req);
  if (!st || !Number.isInteger(st.uid) || (s && s.userId !== st.uid) || !db.getUserById(st.uid))
    return res.redirect('/?auth=error&msg=invalid_state');
  const userId = st.uid;
  try {
    await strava.exchangeCode(userId, code);
    invalidateUserCache(userId);
    syncSoon(userId);
    res.redirect('/?auth=strava-ok');
  } catch (e) {
    console.error('[strava] connect:', e.response?.status || '', e.message);
    res.redirect('/?auth=error&msg=' + encodeURIComponent(stravaAuthError(e)));
  }
});

// ── Per-user tile cache ───────────────────────────────────────────────────────

// At most USER_CACHE_MAX accounts stay in memory (a rider with 50 000
// squadratinhos takes about 15 MB); the least recently used one is dropped
// and simply rebuilt from the database on that person's next request.
const userCaches = new Map();
const USER_CACHE_MAX = Math.max(2, parseInt(process.env.USER_CACHE_MAX, 10) || 40);

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
  while (userCaches.size > USER_CACHE_MAX) userCaches.delete(userCaches.keys().next().value);
  return c;
}

function getUserCache(userId) {
  const c = userCaches.get(userId);
  if (!c) return buildUserCache(userId);
  userCaches.delete(userId); userCaches.set(userId, c);   // Map keeps insertion order: move to the fresh end
  return c;
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
  const tok = db.getToken(req.userId);
  const paused = tok ? strava.pausedFor(tok.client_id || `own:${req.userId}`) : 0;
  res.json({
    connected: !!tok,
    everyMin: Math.round(autoSyncEveryMs(tok?.client_id) / 60000),
    running: syncRunning.has(req.userId),
    pausedUntil: paused ? new Date(paused).toISOString() : null,
    last: st ? { source: st.source, at: st.at, result: st.result ? JSON.parse(st.result) : null, error: st.error } : null,
  });
});

// Background sync: picks up new rides without anyone pressing "Synchronizuj".
// Polling (not Strava webhooks) because webhooks need a publicly reachable URL.
//
// Strava counts requests per application (by default 1000 reads a day and 100
// per 15 minutes), so riders on the shared application share one allowance.
// A check costs one request; the background keeps to STRAVA_DAILY_BUDGET of
// them a day (the rest is left for first syncs, the button and token
// refreshes): up to about a dozen riders are checked every 30 minutes, more
// riders proportionally less often. Riders with their own keys always get 30.
const AUTO_SYNC_EVERY_MS = 30 * 60 * 1000;
const STRAVA_DAILY_BUDGET = Math.max(50, parseInt(process.env.STRAVA_DAILY_BUDGET, 10) || 600);
const AUTO_SYNC_PER_TICK = 20;   // shared-application riders per 5-minute round
function autoSyncEveryMs(clientId, users = db.usersWithStrava()) {
  if (!strava.isShared(clientId)) return AUTO_SYNC_EVERY_MS;
  const n = users.filter(u => strava.isShared(u.client_id)).length;
  return Math.max(AUTO_SYNC_EVERY_MS, Math.ceil(n * 24 * 3600 * 1000 / STRAVA_DAILY_BUDGET));
}
async function autoSyncTick() {
  const users = db.usersWithStrava();
  const sharedEvery = autoSyncEveryMs(strava.appCreds()?.id, users);
  const age = (u) => u.last_at ? Date.now() - Date.parse(u.last_at) : 1e15;
  let shared = 0;
  // longest-waiting first
  for (const u of users.sort((a, b) => age(b) - age(a))) {
    const isShared = strava.isShared(u.client_id);
    if (age(u) < (isShared ? sharedEvery : AUTO_SYNC_EVERY_MS)) continue;
    if (strava.pausedFor(u.client_id || `own:${u.user_id}`)) continue;
    if (isShared && ++shared > AUTO_SYNC_PER_TICK) continue;
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
  const c = (db.routeCoords(userId, id) || []).filter(p => Array.isArray(p) && isNum(p[0]) && isNum(p[1]));
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
const GPX_TYPE = { foot: 'hiking', run: 'running' };
const xmlEsc = s => String(s).replace(/[<>&"']/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]));
app.get('/api/routes/:id/gpx', requireAuth, (req, res) => {
  const r = db.getRoute(req.userId, +req.params.id);
  if (!r) return res.status(404).json({ error: 'Nie ma takiej trasy' });
  const c = JSON.parse(r.coords).filter(p => Array.isArray(p) && isNum(p[0]) && isNum(p[1]));
  const hasElev = c.some(p => p[2] > 0);
  const name = xmlEsc(r.name);
  const pts = c.map(p => `      <trkpt lat="${(+p[0]).toFixed(6)}" lon="${(+p[1]).toFixed(6)}">${hasElev ? `<ele>${(+p[2] || 0).toFixed(1)}</ele>` : ''}</trkpt>`).join('\n');
  const named = JSON.parse(r.waypoints).filter(w => w && typeof w.name === 'string' && w.name && isNum(w.lat) && isNum(w.lng))
    .map(w => `  <wpt lat="${(+w.lat).toFixed(6)}" lon="${(+w.lng).toFixed(6)}"><name>${xmlEsc(w.name)}</name></wpt>\n`).join('');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="SquadratsPlanner" version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${name}</name><time>${new Date(r.created_at.replace(' ', 'T') + 'Z').toISOString()}</time></metadata>
${named}  <trk>
    <name>${name}</name>
    <type>${GPX_TYPE[r.profile] || 'cycling'}</type>
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
    hints: r.hints ? JSON.parse(r.hints) : null,
  });
});

// What a saved route may hold. Everything a browser sends is rebuilt from the
// fields the app knows, so an account cannot park arbitrary data here and a
// broken entry cannot break the list, the thumbnail or the GPX later.
const MAX_ROUTES_PER_USER = 500;
const cleanWaypoint = (w) => {
  if (!okPt(w)) return null;
  const out = { type: typeof w.type === 'string' && /^[a-z]{1,12}$/.test(w.type) ? w.type : 'mid', lat: w.lat, lng: w.lng };
  for (const [k, max] of [['label', 80], ['name', 40]]) {
    if (w[k] === null) out[k] = null;
    else if (typeof w[k] === 'string') out[k] = text(w[k], max) || null;
  }
  return out;
};
// Elevation / surface profile: a list of small rows of numbers and short words
function cleanProfile(p) {
  if (!Array.isArray(p) || !p.length || p.length > 20000) return null;
  const okVal = (v) => v === null || isNum(v) || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 40);
  for (const row of p) {
    if (Array.isArray(row)) { if (row.length > 6 || !row.every(isNum)) return null; }
    else if (row && typeof row === 'object') {
      const e = Object.entries(row);
      if (e.length > 8 || !e.every(([k, v]) => k.length <= 20 && okVal(v))) return null;
    } else return null;
  }
  const s = JSON.stringify(p);
  return s.length <= 1500000 ? s : null;
}

// Turns for spoken navigation: [index of the route point, command, exit, metres, angle]
function cleanHints(h, nCoords) {
  if (!Array.isArray(h) || !h.length || h.length > 5000) return null;
  const out = [];
  for (const r of h) {
    if (!Array.isArray(r) || r.length < 2 || r.length > 5 || !r.every(isNum)) return null;
    if (!Number.isInteger(r[0]) || r[0] < 0 || r[0] >= nCoords) return null;
    out.push([r[0], r[1] | 0, r[2] | 0, Math.round(r[3] || 0), Math.round(r[4] || 0)]);
  }
  return JSON.stringify(out);
}

app.post('/api/routes', requireAuth, (req, res) => {
  const b = req.body || {};
  const name = text(b.name, 80);
  if (!name) return res.status(400).json({ error: 'Podaj nazwę trasy' });
  if (!Array.isArray(b.coords) || b.coords.length < 2 || b.coords.length > 50000) return res.status(400).json({ error: 'Brak trasy do zapisania' });
  if (!Array.isArray(b.waypoints)) return res.status(400).json({ error: 'Brak punktów trasy' });
  const coords = [];
  for (const c of b.coords) {
    if (!Array.isArray(c) || !okPt({ lat: c[0], lng: c[1] })) return res.status(400).json({ error: 'Nieprawidłowe współrzędne trasy' });
    coords.push([+c[0].toFixed(6), +c[1].toFixed(6), isNum(c[2]) ? Math.max(-500, Math.min(9000, Math.round(c[2]))) : 0]);
  }
  if (db.listRoutes(req.userId).length >= MAX_ROUTES_PER_USER)
    return res.status(400).json({ error: `Limit zapisanych tras (${MAX_ROUTES_PER_USER}). Usuń którąś, aby zapisać nową.` });
  const int = (v, max) => Math.max(0, Math.min(max, Math.round(isNum(v) ? v : 0)));
  const id = db.insertRoute(req.userId, {
    name,
    distance_km: isNum(b.distanceKm) ? Math.max(0, Math.min(100000, b.distanceKm)) : 0,
    new_sq: int(b.newSQ, 1e7), new_sqi: int(b.newSQI, 1e7),
    mode: text(b.mode, 20) || null, profile: text(b.profile, 20) || null, is_loop: b.loop ? 1 : 0,
    waypoints: JSON.stringify(b.waypoints.slice(0, 200).map(cleanWaypoint).filter(Boolean).slice(0, 50)),
    coords: JSON.stringify(coords),
    elev_profile: cleanProfile(b.elevProfile),
    surface_profile: cleanProfile(b.surfaceProfile),
    hints: cleanHints(b.hints, coords.length),
  });
  res.json({ id: Number(id) });
});

app.delete('/api/routes/:id', requireAuth, (req, res) => {
  routeSummaryCache.delete(`${req.userId}:${+req.params.id}`);
  if (!db.deleteRoute(req.userId, +req.params.id)) return res.status(404).json({ error: 'Nie ma takiej trasy' });
  res.json({ ok: true });
});

// ── Route links ───────────────────────────────────────────────────────────────
// A saved route can be given a public address (/s/<token>): anyone who has it
// sees the line on a map and can download the GPX, without an account. The
// link shows the route and its name, nothing about its author. By default the
// first and last 300 m are left out — a route usually starts at home.

const SHARE_TRIM_M = 300;
app.post('/api/routes/:id/share', requireAuth, (req, res) => {
  const r = db.getRoute(req.userId, +req.params.id);
  if (!r) return res.status(404).json({ error: 'Nie ma takiej trasy' });
  const trim = req.body?.hideEnds === false ? 0 : SHARE_TRIM_M;
  const token = r.share_token || crypto.randomBytes(12).toString('base64url');
  db.shareRoute(req.userId, r.id, token, trim);
  res.json({ token, trim_m: trim });
});
app.delete('/api/routes/:id/share', requireAuth, (req, res) => {
  if (!db.shareRoute(req.userId, +req.params.id, null, 0)) return res.status(404).json({ error: 'Nie ma takiej trasy' });
  res.json({ ok: true });
});

const sharedLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Zbyt wiele zapytań. Spróbuj ponownie za chwilę.' },
});
const mBetween = (a, b) => {
  const r = Math.PI / 180, dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(h)));
};
// What the link shows: the line without `trim` metres at both ends (never more
// than a tenth of the route at each)
function sharedRoute(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{12,40}$/.test(token)) return null;
  const r = db.routeByShare(token);
  if (!r) return null;
  let c = [];
  try { c = JSON.parse(r.coords).filter(p => Array.isArray(p) && isNum(p[0]) && isNum(p[1])); } catch {}
  if (c.length < 2) return null;
  const cum = [0];
  for (let i = 1; i < c.length; i++) cum.push(cum[i - 1] + mBetween(c[i - 1], c[i]));
  const total = cum[cum.length - 1], trim = Math.min(r.share_trim_m | 0, total * 0.1);
  if (trim > 0) {
    c = c.filter((_, i) => cum[i] >= trim && cum[i] <= total - trim);
    if (c.length < 2) return null;
  }
  let ref = c[0][2] || 0, up = 0;
  for (const p of c) { const e = p[2] || 0; if (e > ref + 3) { up += e - ref; ref = e; } else if (e < ref - 3) ref = e; }
  return {
    name: r.name, created_at: r.created_at, profile: r.profile || null, loop: !!r.is_loop,
    distance_km: Math.round((total - 2 * trim) / 10) / 100, ascent_m: Math.round(up), trimmed_m: Math.round(trim), coords: c,
  };
}
app.get('/api/shared/:token', sharedLimiter, (req, res) => {
  const r = sharedRoute(req.params.token);
  if (!r) return res.status(404).json({ error: 'Ten link nie jest już aktywny' });
  res.json({ ...r, app: APP_NAME });
});
app.get('/api/shared/:token/gpx', sharedLimiter, (req, res) => {
  const r = sharedRoute(req.params.token);
  if (!r) return res.status(404).json({ error: 'Ten link nie jest już aktywny' });
  const hasElev = r.coords.some(p => p[2] > 0), name = xmlEsc(r.name);
  const pts = r.coords.map(p => `      <trkpt lat="${(+p[0]).toFixed(6)}" lon="${(+p[1]).toFixed(6)}">${hasElev ? `<ele>${(+p[2] || 0).toFixed(1)}</ele>` : ''}</trkpt>`).join('\n');
  const file = (r.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L')
    .replace(/[^A-Za-z0-9 _.-]+/g, ' ').trim().replace(/\s+/g, '_').slice(0, 60) || 'trasa') + '.gpx';
  res.set('Content-Type', 'application/gpx+xml; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${file}"`);
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="${xmlEsc(APP_NAME)}" version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${name}</name></metadata>
  <trk>
    <name>${name}</name>
    <type>${GPX_TYPE[r.profile] || 'cycling'}</type>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`);
});
// The page behind the link. Its title and description are filled in here, so
// a messenger shows the route's name and length when the link is pasted.
app.get('/s/:token', sharedLimiter, (req, res) => {
  const r = sharedRoute(req.params.token);
  let html;
  try { html = fs.readFileSync(path.join(FRONTEND, 'shared.html'), 'utf8'); } catch { return res.status(404).send('Not found'); }
  const title = r ? `${r.name} · ${String(r.distance_km).replace('.', ',')} km` : APP_NAME;
  const desc = r ? `${r.loop ? 'Pętla' : 'Trasa'} ${String(r.distance_km).replace('.', ',')} km, ${r.ascent_m} m w górę. ${APP_NAME}` : APP_NAME;
  res.status(r ? 200 : 404).set('Content-Type', 'text/html; charset=utf-8').set('Cache-Control', 'no-cache')
    .send(html.replace(/__OG_TITLE__/g, xmlEsc(title)).replace(/__OG_DESC__/g, xmlEsc(desc)).replace(/__APP_NAME__/g, xmlEsc(APP_NAME)));
});

// ── Weather along a route ─────────────────────────────────────────────────────
// Forecast for one place (a 0.1° cell), from MET Norway through weather.js.
const weatherLimiter = rateLimit({
  windowMs: 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Zbyt wiele zapytań o pogodę. Spróbuj ponownie za chwilę.' },
});
app.get('/api/weather', requireAuth, weatherLimiter, async (req, res) => {
  const p = { lat: Number(req.query.lat), lng: Number(req.query.lng) };
  if (!okPt(p)) return res.status(400).json({ error: 'Nieprawidłowe koordynaty' });
  try { res.json({ ...await weather.forecast(p.lat, p.lng), source: weather.ATTRIBUTION }); }
  catch (e) {
    console.warn('[weather]', e.response?.status || '', e.message);
    res.status(502).json({ error: 'Prognoza jest chwilowo niedostępna' });
  }
});

// ── Stats ─────────────────────────────────────────────────────────────────────

// ── Frontend log telemetry ─────────────────────────────────────────────────

const clientLogs = [];
const MAX_LOGS = 500;

app.post('/api/log', requireAuth, (req, res) => {
  const { level, msg, data, url, line } = req.body || {};
  const entry = {
    t: new Date().toISOString(),
    uid: req.userId,
    level: ['log', 'info', 'warn', 'error'].includes(level) ? level : 'log',
    msg: text(typeof msg === 'string' ? msg : JSON.stringify(msg ?? ''), 500),
    data: data ? text(JSON.stringify(data), 500) : undefined,
    url: typeof url === 'string' ? text(url, 200) : undefined,
    line: isNum(line) ? line : undefined,
  };
  clientLogs.push(entry);
  if (clientLogs.length > MAX_LOGS) clientLogs.shift();
  if (entry.level === 'error') console.error('[CLIENT]', entry.t, `uid=${entry.uid}`, entry.msg, entry.data || '');
  res.json({ ok: true });
});

app.get('/api/log', requireAdmin, (req, res) => {
  const n = Math.max(1, Math.min(MAX_LOGS, parseInt(req.query.n) || 50));
  res.json(clientLogs.slice(-n));
});

// ──────────────────────────────────────────────────────────────────────────────

app.get('/api/stats', requireAuth, (req, res) => {
  res.json(getUserCache(req.userId).stats);
});

// ── Tile endpoints ────────────────────────────────────────────────────────────

function parseBbox(q) {
  if (q.x0 === undefined) return null;
  const b = [q.x0, q.x1, q.y0, q.y1].map(v => (typeof v === 'string' && /^-?\d{1,9}$/.test(v) ? +v : NaN));
  return b.every(Number.isFinite) ? b : null;
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
  const tx = Number(req.body?.tx), ty = Number(req.body?.ty);
  if (!okTile(tx, ty)) return res.status(400).json({ error: 'tx, ty required' });
  if (db.hasTileSQI(req.userId, tx, ty)) return res.status(409).json({ error: 'Ten SQI jest już zdobyty' });
  const blocked = db.toggleBlockedSQI(req.userId, tx, ty);
  invalidateUserCache(req.userId);
  res.json({ blocked, tx, ty });
});

// Squadratinhos with no road or path in OSM: suggested as impossible to
// collect (owned and already blocked ones left out). z17 tile range.
app.get('/api/tiles/noroad', requireAuth, (req, res) => {
  const [x0, y0, x1, y1] = ['x0', 'y0', 'x1', 'y1'].map(k => parseInt(req.query[k], 10));
  if (!okTile(x0, y0) || !okTile(x1, y1) || x1 < x0 || y1 < y0) return res.status(400).json({ error: 'x0,y0,x1,y1 required' });
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
  const list = Array.isArray(req.body?.tiles) ? req.body.tiles : [];
  if (!list.length || list.length > 20000) return res.status(400).json({ error: 'tiles: 1..20000 [tx,ty]' });
  const c = getUserCache(req.userId);
  const owned = new Set(c.sqiRows.map(r => `${r.tx},${r.ty}`));
  const ok = list.filter(t => Array.isArray(t)).map(t => [Number(t[0]), Number(t[1])])
    .filter(([x, y]) => okTile(x, y) && !owned.has(`${x},${y}`));
  if (!ok.length) return res.json({ added: 0 });
  const added = db.addBlockedSQIMany(req.userId, ok);
  invalidateUserCache(req.userId);
  res.json({ added });
});

// How much of what can be collected around a point is collected:
// squadratinhos within r km, minus those with no road and those marked blocked
app.get('/api/tiles/reach-stats', requireAuth, (req, res) => {
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
  const rKm = Math.min(100, Math.max(1, parseFloat(req.query.r) || 50));
  // above 72° the tiles get so narrow that a 100 km circle holds tens of millions
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 72 || Math.abs(lng) > 180) return res.status(400).json({ error: 'lat/lng' });
  if (!reach.available()) return res.json({ available: false });
  const c = getUserCache(req.userId);
  const Z = tiles.Z_SQI, n = 2 ** Z;
  const ctr = tiles.latLngToTile(lat, lng, Z);
  // The answer only changes with the rider's tiles, and those changes drop the
  // whole user cache: remember it there (the panel asks again on every open).
  const memoKey = `${ctr.x},${ctr.y},${rKm}`;
  if (c.reachStats?.key === memoKey) return res.json(c.reachStats.value);
  const kmPerTile = 40075 * Math.cos(lat * Math.PI / 180) / n;
  const rT = Math.ceil(rKm / kmPerTile) + 1, r2 = (rKm / kmPerTile) ** 2;
  // numeric keys: this loop visits up to a million tiles, strings would cost seconds
  const W = 2 * rT + 1, keyOf = (x, y) => (y - ctr.y + rT) * W + (x - ctr.x + rT);
  const inWin = r => Math.abs(r.tx - ctr.x) <= rT && Math.abs(r.ty - ctr.y) <= rT;
  const owned = new Set(), blocked = new Set();
  for (const r of c.sqiRows) if (inWin(r)) owned.add(keyOf(r.tx, r.ty));
  for (const r of c.blockedSQI) if (inWin(r)) blocked.add(keyOf(r.tx, r.ty));
  let nOwned = 0, nOpen = 0, nNoRoad = 0, nBlocked = 0, nUnknown = 0;
  for (let dy = -rT; dy <= rT; dy++) for (let dx = -rT; dx <= rT; dx++) {
    if (dx * dx + dy * dy > r2) continue;              // tiles are square in Mercator
    const x = ctr.x + dx, y = ctr.y + dy, k = keyOf(x, y);
    if (owned.has(k)) { nOwned++; continue; }
    if (blocked.has(k)) { nBlocked++; continue; }
    const s = reach.status(x, y);
    if (s < 0) nUnknown++; else if (s === 0) nNoRoad++; else nOpen++;
  }
  const collectable = nOwned + nOpen;
  const value = {
    available: true, r: rKm, owned: nOwned, open: nOpen, noRoad: nNoRoad, blocked: nBlocked, unknown: nUnknown,
    collectable, pct: collectable ? Math.round(1000 * nOwned / collectable) / 10 : 0,
  };
  c.reachStats = { key: memoKey, value };
  res.json(value);
});

// ── Route planning ────────────────────────────────────────────────────────────

const { fetchRoute, routeDistanceKm } = routing;
const MAX_ROUTE_POINTS = 50, MAX_TARGET_KM = 500;

// "No data for this area" and "no road near this point" are the rider's to
// fix (move the point), not a server fault: 422 with a code the app knows.
function routeFail(res, e) {
  if (e instanceof routing.RoutingAreaError)
    return res.status(422).json({ error: e.message, code: e.code === 'NO_ROUTING_DATA' ? 'no-routing-data' : 'no-road-near' });
  return res.status(502).json({ error: 'Routing error: ' + e.message });
}
// Every point has to lie where routing data is installed (the public OSRM
// fallback of the 'standard' profile is the only engine without that limit)
function outsideCoverage(points, bikeProfile, needsBRouter) {
  if (bikeProfile === 'standard' && !needsBRouter) return false;
  return points.some(p => !routing.covered(p));
}

// Where routes can be planned and where the OpenStreetMap layers (places,
// cycle network, squares without a road) have data. Public: no personal data.
app.get('/api/coverage', (req, res) => {
  const c = routing.coverage();
  const pdb = getPoiDb();
  let osm = null;
  if (pdb) {
    const meta = Object.fromEntries(pdb.prepare('SELECT key, value FROM meta').all().map(m => [m.key, m.value]));
    osm = { regions: meta.regions ? meta.regions.split(',') : ['poland'], timestamp: meta.osm_timestamp || null, places: Number(meta.count) || null };
  }
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ routing: { tiles: c.tiles, step: c.step, bbox: c.bbox }, osm });
});

app.post('/api/route/detour', requireAuth, async (req, res) => {
  const b = req.body || {};
  const loop = b.loop === true, returnLeg = b.returnLeg === true;
  // 'heatmap' (old "Pop." option) never had data behind it; treat as SQI.
  const mode = ['sq', 'sqi', 'yard', 'yardi', 'shortest', 'popular', 'prio'].includes(b.mode) ? b.mode : 'sqi';
  if (!Array.isArray(b.waypoints) || !b.waypoints.length) return res.status(400).json({ error: 'waypoints required' });
  if (b.waypoints.length > MAX_ROUTE_POINTS) return res.status(400).json({ error: `Za dużo punktów trasy (maks. ${MAX_ROUTE_POINTS})` });
  if (!b.waypoints.every(okPt)) return res.status(400).json({ error: 'Nieprawidłowe współrzędne punktu trasy' });
  const waypoints = b.waypoints.map(p => ({ lat: p.lat, lng: p.lng }));
  // the profile name becomes part of the routing engine's address
  const bikeProfile = BIKE_PROFILES.has(b.bikeProfile) ? b.bikeProfile : 'standard';
  const targetKm = isNum(b.targetKm) && b.targetKm > 0 ? b.targetKm : 0;
  if (targetKm > MAX_TARGET_KM) return res.status(400).json({ error: `Maksymalna długość trasy to ${MAX_TARGET_KM} km` });
  const avoidCoords = cleanPts(b.avoidCoords, 3000);

  const c = getUserCache(req.userId);
  const start = waypoints[0], end = waypoints[waypoints.length - 1];
  const samePoint = tiles.haversineDistance(start, end) < 0.4;
  const isLoop = loop || samePoint;
  if (outsideCoverage(waypoints, bikeProfile, isLoop || returnLeg || mode === 'popular')) return routeFail(res, routing.noData());

  // Loop from just a start point: the planner builds and scores real loops
  // (way back on different roads) for every mode.
  if (isLoop && (waypoints.length === 1 || (samePoint && waypoints.length === 2))) {
    try {
      return res.json(await planner.planLoop({
        start, targetKm, mode, bikeProfile, sqRows: c.sqRows, sqiRows: c.sqiRows, yard: c.yard, yardi: c.yardi,
        uberi: c.uberi, blockedSQI: c.blockedSQI, priority: mode === 'prio' ? getPriority(req.userId, c) : null,
        windFrom: isNum(b.windFrom) ? ((b.windFrom % 360) + 360) % 360 : null,
      }));
    } catch (e) {
      if (e instanceof planner.PlannerError) return res.status(422).json({ error: e.message });
      return routeFail(res, e);
    }
  }

  // Loop through the user's own waypoints: closed, second half avoids the
  // first. A→B: plain routing; a return leg avoids the outbound track.
  const pts = isLoop && !samePoint ? [...waypoints, start] : [...waypoints];
  const avoid = returnLeg && avoidCoords.length > 1 ? avoidCoords : null;
  const route = (p) => isLoop
    ? planner.routeLoopHalves(p, routing.brouterProfile(bikeProfile))
    : fetchRoute(p, avoid ? routing.brouterProfile(bikeProfile) : bikeProfile, 0, avoid);

  if (mode === 'shortest') {
    try { return res.json(await route(pts)); }
    catch (e) { return routeFail(res, e); }
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
      if (!alts.length) return res.status(502).json({ error: 'Routing error: brak trasy' });
      const minKm = Math.min(...alts.map(routeDistanceKm));
      const ok = alts.filter(d => routeDistanceKm(d) <= minKm * 1.2);
      ok.sort((a, b) => b.planner.popular.share - a.planner.popular.share);
      return res.json(ok[0]);
    } catch (e) { return routeFail(res, e); }
  }

  // Long A→B route: straight-line >80km — skip iterative detour, one direct call.
  const directKm = tiles.haversineDistance(start, end);
  if (!isLoop && directKm > 80) {
    try { return res.json(await route(pts)); }
    catch (e) { return routeFail(res, e); }
  }

  const ownedSQSet  = new Set(c.sqRows.map(r => `${r.tx},${r.ty}`));
  const ownedSQISet = new Set(c.sqiRows.map(r => `${r.tx},${r.ty}`));
  for (const r of c.blockedSQI) ownedSQISet.add(`${r.tx},${r.ty}`); // never a detour target
  const tolerance = 0.15, target = Math.max(0, targetKm);
  let routeData;
  try { routeData = await route(pts); }
  catch (e) { return routeFail(res, e); }

  const baseKm = routeDistanceKm(routeData);
  if (!baseKm) return res.status(502).json({ error: 'Could not compute base route' });

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
app.post('/api/route/leg', requireAuth, async (req, res) => {
  const { from, to, avoid } = req.body || {};
  if (!okPt(from) || !okPt(to)) return res.status(400).json({ error: 'from/to required' });
  if (tiles.haversineDistance(from, to) > 300) return res.status(400).json({ error: 'Punkty są za daleko od siebie (maks. 300 km)' });
  const bikeProfile = BIKE_PROFILES.has(req.body.bikeProfile) ? req.body.bikeProfile : 'standard';
  const av = Array.isArray(avoid) ? cleanPts(avoid, 3000) : null;
  if (outsideCoverage([from, to], bikeProfile, av && av.length > 1)) return routeFail(res, routing.noData());
  try {
    if (av && av.length > 1) return res.json(await fetchRoute([from, to], routing.brouterProfile(bikeProfile), 0, av));
    return res.json(await fetchRoute([from, to], bikeProfile));
  } catch (e) { return routeFail(res, e); }
});

// ── GPX import ────────────────────────────────────────────────────────────────

// Turning a track into squares takes time in proportion to its length, so a
// track gets a length budget (in degrees; 1° ≈ 70–110 km). A file that claims
// to circle the planet a thousand times is refused instead of stalling
// everybody else's requests.
function trackLongerThan(coords, maxDeg) {
  let d = 0;
  for (let i = 1; i < coords.length; i++) {
    d += Math.hypot(coords[i].lat - coords[i - 1].lat, coords[i].lng - coords[i - 1].lng);
    if (d > maxDeg) return true;
  }
  return false;
}

app.post('/api/gpx/import', requireAuth, (req, res) => {
  const gpxText = req.body?.gpxText;
  if (typeof gpxText !== 'string' || !gpxText) return res.status(400).json({ error: 'gpxText required' });
  // track and route points; lat / lon in either order, either kind of quote
  const coords = [];
  const tagRe = /<(?:trkpt|rtept)\b([^>]{0,300})>/g, attr = (s, n) => { const m = new RegExp(`\\b${n}\\s*=\\s*["']([^"']{1,40})["']`).exec(s); return m ? Number(m[1]) : NaN; };
  let m, seen = 0;
  while ((m = tagRe.exec(gpxText)) !== null) {
    seen++;
    const p = { lat: attr(m[1], 'lat'), lng: attr(m[1], 'lon') };
    if (okPt(p)) coords.push(p);
  }
  if (!coords.length) return res.status(400).json({ error: seen ? 'Plik nie zawiera poprawnych współrzędnych' : 'W pliku nie ma punktów GPS (trkpt)' });
  if (trackLongerThan(coords, 400)) return res.status(400).json({ error: 'Ślad w pliku jest zbyt długi, aby go zaimportować' });
  const { sq14, sq17 } = tiles.trackToTiles(coords);
  const newSQ  = db.insertTilesSQBatch(req.userId, [...sq14].map(k => k.split(',').map(Number)));
  const newSQI = db.insertTilesSQIBatch(req.userId, [...sq17].map(k => k.split(',').map(Number)));
  invalidateUserCache(req.userId);
  res.json({
    points: coords.length,
    newSQ, newSQI,
    totalSQ:  db.getSQCount(req.userId),
    totalSQI: db.getSQICount(req.userId),
  });
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
    if (!sq.size && !sqi.size) return res.status(400).json({ error: 'W pliku nie ma kwadratów. Wybierz plik KML pobrany ze squadrats.com.' });
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
    res.status(400).json({ error: 'Błąd parsowania KML: ' + e.message });
  }
});

// ── Squares from StatsHunters and VeloViewer ──────────────────────────────────
// Both count the same z14 squares. Additive, like the Squadrats import.

const importing = new Set();
app.post('/api/import/statshunters', requireAuth, async (req, res) => {
  const code = statshunters.shareCode(req.body?.link);
  if (!code) return res.status(400).json({ error: 'Wklej link udostępniania ze StatsHunters (statshunters.com/share/…)' });
  if (importing.has(req.userId)) return res.status(409).json({ error: 'Import już trwa' });
  importing.add(req.userId);
  try {
    const { sq, activities } = await statshunters.fetchTiles(code);
    if (!sq.size) return res.status(400).json({ error: 'Pod tym linkiem nie ma kwadratów. Sprawdź w StatsHunters, czy link udostępnia aktywności.' });
    const addedSQ = db.insertTilesSQBatch(req.userId, [...sq].map(k => k.split(',').map(Number)));
    invalidateUserCache(req.userId);
    res.json({ addedSQ, parsedSQ: sq.size, activities, totalSQ: db.getSQCount(req.userId), totalSQI: db.getSQICount(req.userId) });
  } catch (e) {
    if (e instanceof statshunters.ImportError) return res.status(400).json({ error: e.message });
    throw e;
  } finally { importing.delete(req.userId); }
});

app.post('/api/import/veloviewer-kml', requireAuth, express.text({ limit: '30mb', type: '*/*' }), (req, res) => {
  const xml = req.body;
  if (!xml || typeof xml !== 'string' || xml.length < 50) return res.status(400).json({ error: 'Pusty plik KML' });
  try {
    const { sq, polygons } = require('./kml').parseTileKml(xml);
    if (!sq.size) return res.status(400).json({ error: 'W pliku nie ma kwadratów. Wybierz plik KML z kafelkami Explorer wyeksportowany z VeloViewer.' });
    const addedSQ = db.insertTilesSQBatch(req.userId, [...sq].map(k => k.split(',').map(Number)));
    invalidateUserCache(req.userId);
    res.json({ addedSQ, parsedSQ: sq.size, polygons, totalSQ: db.getSQCount(req.userId), totalSQI: db.getSQICount(req.userId) });
  } catch (e) {
    res.status(400).json({ error: 'Błąd parsowania KML: ' + e.message });
  }
});

// ── Preview tiles ─────────────────────────────────────────────────────────────

app.post('/api/route/preview-tiles', requireAuth, (req, res) => {
  const raw = req.body?.coords;
  if (!Array.isArray(raw) || !raw.length) return res.status(400).json({ error: 'coords required' });
  if (raw.length > 60000 || !raw.every(okPt)) return res.status(400).json({ error: 'Nieprawidłowe współrzędne trasy' });
  const coords = raw.map(p => ({ lat: p.lat, lng: p.lng }));
  if (trackLongerThan(coords, 60)) return res.status(400).json({ error: 'Trasa jest zbyt długa' });
  const c = getUserCache(req.userId);
  const ownedSQ  = new Set(c.sqRows.map(r => `${r.tx},${r.ty}`));
  const ownedSQI = new Set(c.sqiRows.map(r => `${r.tx},${r.ty}`));
  for (const r of c.blockedSQI) ownedSQI.add(`${r.tx},${r.ty}`); // can't be collected
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

// For logged-in users only: these answers carry the Google key, and the
// coverage check spends its quota.
const queryPt = (q) => { const p = { lat: parseFloat(q.lat), lng: parseFloat(q.lng) }; return okPt(p) ? p : null; };

app.get('/api/streetview/embed-url', requireAuth, (req, res) => {
  const { lat, lng } = queryPt(req.query) || {};
  const key = process.env.GOOGLE_MAPS_KEY;
  if (!key || lat === undefined) return res.json({ url: null });
  const url = `https://www.google.com/maps/embed/v1/streetview?key=${key}&location=${parseFloat(lat).toFixed(6)},${parseFloat(lng).toFixed(6)}&heading=0&pitch=0&fov=90`;
  res.json({ url });
});

app.get('/api/streetview/viewer', requireAuth, (req, res) => {
  const pt = queryPt(req.query);
  const key = process.env.GOOGLE_MAPS_KEY;
  if (!key || !pt) return res.status(404).send('No API key');
  const la = pt.lat.toFixed(6), ln = pt.lng.toFixed(6);
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

const SV_MAX_POINTS = 400; // the app asks about ~300 points of a route
app.post('/api/streetview/coverage', requireAuth, async (req, res) => {
  const key = process.env.GOOGLE_MAPS_KEY;
  if (!Array.isArray(req.body?.points) || req.body.points.length > SV_MAX_POINTS) return res.status(400).json({ error: `points: 1..${SV_MAX_POINTS}` });
  const points = req.body.points.filter(okPt).slice(0, SV_MAX_POINTS);
  if (!key || !points.length) return res.json({ coverage: null });
  try {
    const coverage = await Promise.all(points.map(async p => {
      const url = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${p.lat.toFixed(6)},${p.lng.toFixed(6)}&source=outdoor&key=${key}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
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
  const query = req.body?.query;
  if (typeof query !== 'string' || !query.trim()) return res.status(400).json({ error: 'Missing query' });
  if (query.length > 20000) return res.status(400).json({ error: 'Zapytanie jest zbyt długie' });

  const key = crypto.createHash('sha1').update(query).digest('hex');
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
  const b = req.body || {};
  const radiusM = isNum(b.radiusM) ? b.radiusM : 400;
  const wanted = (Array.isArray(b.tags) ? b.tags : []).filter(t => typeof t === 'string' && t.length <= 60).slice(0, 200);
  if (!Array.isArray(b.coords) || b.coords.length < 2) return res.status(400).json({ error: 'coords required' });
  if (b.coords.length > 60000 || !b.coords.every(okPt)) return res.status(400).json({ error: 'Nieprawidłowe współrzędne trasy' });
  const coords = b.coords;
  const pdb = getPoiDb();
  if (!pdb) return res.status(503).json({ error: 'Brak lokalnej bazy POI', fallback: true });
  // The local database covers the OSM extracts it was built from. A route
  // that leaves them gets its places from Overpass (the app asks there next).
  if (reach.available()) {
    const step = Math.max(1, Math.floor(coords.length / 60));
    let seen = 0, outside = 0;
    for (let i = 0; i < coords.length; i += step) {
      const t = tiles.latLngToTile(coords[i].lat, coords[i].lng, 17);
      seen++; if (reach.status(t.x, t.y) < 0) outside++;
    }
    if (outside > seen * 0.1) return res.status(503).json({ error: 'Trasa wychodzi poza lokalną bazę miejsc', fallback: true });
  }

  const rKm = Math.min(2, Math.max(0.05, radiusM / 1000));
  const lat0 = coords[0].lat, kx = 111.32 * Math.cos(lat0 * Math.PI / 180), ky = 110.57;
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (const p of coords) {
    if (p.lat < minLat) minLat = p.lat; if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng; if (p.lng > maxLng) maxLng = p.lng;
  }
  const dLat = rKm / ky, dLng = rKm / kx;
  // every place inside the route's bounding box is read from the database
  if ((maxLat - minLat) * (maxLng - minLng) > 40) return res.status(400).json({ error: 'Trasa obejmuje zbyt duży obszar, aby szukać miejsc' });

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
  // [{lat,lng}, ...]; one Wikipedia request each, so only as many as the app sends
  const samples = cleanPts(req.body?.samples, 40);
  if (!samples.length) return res.status(400).json({ error: 'Missing samples' });
  try {
    const wikiHeaders = { 'User-Agent': 'SquadratsApp/2.0' };
    const seen = new Set();
    const articles = [];

    // Search within 1km radius of each sampled route point, deduplicate
    for (const pt of samples) {
      const url = `https://pl.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${pt.lat.toFixed(6)}|${pt.lng.toFixed(6)}&gsradius=1000&gslimit=20&format=json&origin=*`;
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
    res.status(502).json({ error: 'Wikipedia nie odpowiada' });
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

// An unknown API address is an error, not the app's start page
app.use('/api', (req, res) => res.status(404).json({ error: 'Nie ma takiego adresu API' }));

app.get('*', (req, res) => res.sendFile(path.join(FRONTEND, 'index.html')));

// ── Errors ────────────────────────────────────────────────────────────────────
// Whatever goes wrong in a handler ends here: the client gets a short JSON
// answer (never a stack trace), the details go to the server log.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode;
  if (status >= 400 && status < 500) {
    return res.status(status).json({
      error: status === 413 ? 'Zbyt duże żądanie' : err.type === 'entity.parse.failed' ? 'Nieprawidłowy JSON' : 'Nieprawidłowe żądanie',
    });
  }
  console.error(`[error] ${req.method} ${req.path}:`, err);
  res.status(500).json({ error: 'Błąd serwera' });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  ${APP_NAME.slice(0, 35).padEnd(35)} ║`);
  console.log(`║  http://localhost:${PORT}               ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
  console.log(`  Użytkownicy: ${db.getUserCount()}`);
  console.log(`  DB: ${process.env.DB_PATH}\n`);
});
