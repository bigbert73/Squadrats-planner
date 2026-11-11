/**
 * strava.js — Strava OAuth + incremental activity sync (multi-user)
 *
 * Two kinds of Strava API application can stand behind a rider's connection:
 *   • the shared one of this installation (STRAVA_CLIENT_ID / _SECRET in the
 *     environment): riders connect with one click, nothing to set up;
 *   • the rider's own (Client ID + Secret saved in their profile): its own
 *     rate limit, independent of everybody else.
 * A token can only be refreshed by the application that issued it, so every
 * stored token remembers its client id.
 */

const axios  = require('axios');
const db     = require('./db');
const { trackToTiles, decodePolyline } = require('./tiles');

const REDIRECT_URI = process.env.STRAVA_REDIRECT_URI || 'http://localhost:3000/auth/callback';
// Both are replaced by a local stand-in in the test suite
const API  = process.env.STRAVA_API_BASE  || 'https://www.strava.com';   // token exchange and the API
const AUTH = process.env.STRAVA_AUTH_BASE || 'https://www.strava.com';   // the screen the rider is sent to

// ── Applications ──────────────────────────────────────────────────────────────

// STRAVA_SHARED=0 keeps the environment keys private to the first admin
// (the behaviour before one-click connecting existed).
function appCreds() {
  if (process.env.STRAVA_SHARED === '0') return null;
  const id = (process.env.STRAVA_CLIENT_ID || '').trim(), secret = (process.env.STRAVA_CLIENT_SECRET || '').trim();
  return id && secret ? { id, secret } : null;
}
function ownCreds(user) {
  return user?.strava_client_id && user?.strava_client_secret
    ? { id: String(user.strava_client_id), secret: user.strava_client_secret } : null;
}
// For a new connection: the rider's own application if they have one
function credsFor(user) { return ownCreds(user) || appCreds(); }
// For an existing token: the application that issued it
function credsForToken(user, tok) {
  const own = ownCreds(user), app = appCreds();
  if (!tok?.client_id) return own || app;
  if (own && own.id === tok.client_id) return own;
  if (app && app.id === tok.client_id) return app;
  return null;
}
const isShared = (clientId) => { const app = appCreds(); return !!app && !!clientId && app.id === String(clientId); };

// ── Rate limits ───────────────────────────────────────────────────────────────
// Strava counts requests per application: 15-minute windows that start on the
// quarter hour and a daily total that resets at midnight UTC. After a 429 the
// application is left alone until the window that ran out is over.

const pausedUntil = new Map();   // client id → epoch ms
const usage = new Map();         // client id → { short, day, shortLimit, dayLimit, at } (read requests)

class StravaLimitError extends Error {
  constructor(until) {
    super('Strava chwilowo ogranicza liczbę zapytań — spróbuj ponownie później');
    this.code = 'STRAVA_RATE';
    this.until = until;
  }
}

function noteHeaders(clientId, headers) {
  if (!clientId || !headers) return;
  const pair = (k) => String(headers[k] || '').split(',').map(n => parseInt(n, 10));
  const [s, d] = pair(headers['x-readratelimit-usage'] ? 'x-readratelimit-usage' : 'x-ratelimit-usage');
  const [sl, dl] = pair(headers['x-readratelimit-limit'] ? 'x-readratelimit-limit' : 'x-ratelimit-limit');
  if (Number.isFinite(s) && Number.isFinite(d)) usage.set(String(clientId), { short: s, day: d, shortLimit: sl || null, dayLimit: dl || null, at: Date.now() });
}

function pauseAfter429(clientId) {
  const u = usage.get(String(clientId)), now = new Date();
  let until;
  if (u && u.dayLimit && u.day >= u.dayLimit) {
    until = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 30);
  } else {
    const q = 15 * 60 * 1000;
    until = Math.floor(now.getTime() / q) * q + q + 30 * 1000;
  }
  pausedUntil.set(String(clientId), until);
  console.warn(`[strava] rate limit reached for application ${clientId}; paused until ${new Date(until).toISOString()}`);
  return until;
}

function pausedFor(clientId) {
  const t = pausedUntil.get(String(clientId)) || 0;
  return t > Date.now() ? t : 0;
}

// Every call to Strava goes through here. `always` is for the one request
// that cannot wait: trading the code of a rider who has just clicked
// "Authorize" for tokens (the code expires within minutes).
async function call(clientId, cfg, always = false) {
  const p = always ? 0 : pausedFor(clientId);
  if (p) throw new StravaLimitError(p);
  try {
    const res = await axios({ timeout: 30000, ...cfg });
    noteHeaders(clientId, res.headers);
    return res;
  } catch (e) {
    noteHeaders(clientId, e.response?.headers);
    if (e.response?.status === 429) throw new StravaLimitError(pauseAfter429(clientId));
    throw e;
  }
}

// ── OAuth ─────────────────────────────────────────────────────────────────────

// activity:read is asked for next to activity:read_all, so a rider who
// unticks "private activities" on Strava's screen still shares the public ones.
function getAuthUrl(clientId, state) {
  return `${AUTH}/oauth/authorize`
    + `?client_id=${encodeURIComponent(clientId)}`
    + '&response_type=code'
    + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
    + '&approval_prompt=auto'
    + '&scope=read,activity:read,activity:read_all'
    + `&state=${encodeURIComponent(state)}`;
}

// The scopes Strava reports back: without any activity scope there is nothing to sync
function scopeAllowsActivities(scope) {
  if (typeof scope !== 'string' || !scope) return true;   // older flows did not report it
  return scope.split(/[ ,]+/).some(s => s === 'activity:read' || s === 'activity:read_all');
}

function tokenRow(d, clientId, keep) {
  return {
    access_token:  d.access_token,
    refresh_token: d.refresh_token,
    expires_at:    d.expires_at,
    athlete_id:    d.athlete?.id ?? keep?.athlete_id ?? null,
    athlete_json:  d.athlete ? JSON.stringify(d.athlete) : (keep?.athlete_json ?? '{}'),
    client_id:     String(clientId),
  };
}

// Code → tokens + athlete, with the given application. Nothing is stored.
async function exchangeWith(creds, code) {
  const res = await call(creds.id, { method: 'post', url: `${API}/oauth/token`, data: {
    client_id:     creds.id,
    client_secret: creds.secret,
    code,
    grant_type:    'authorization_code',
    redirect_uri:  REDIRECT_URI,
  } }, true);
  if (!res.data?.access_token || !res.data?.refresh_token) throw new Error('Strava nie zwróciła tokenu');
  return res.data;
}

// Connect Strava to an existing account
async function exchangeCode(userId, code) {
  const creds = credsFor(db.getUserById(userId));
  if (!creds) throw new Error('Brak konfiguracji Strava API — dodaj Client ID i Secret w profilu');
  const d = await exchangeWith(creds, code);
  db.saveToken(userId, tokenRow(d, creds.id));
  return d.athlete;
}

function saveExchanged(userId, d, clientId) { db.saveToken(userId, tokenRow(d, clientId)); }

async function getValidToken(userId) {
  const tok = db.getToken(userId);
  if (!tok) return null;
  const now = Math.floor(Date.now() / 1000);
  if (tok.expires_at > now + 60) return tok.access_token;

  const creds = credsForToken(db.getUserById(userId), tok);
  if (!creds) throw new Error('Połączenie ze Stravą wygasło — połącz Stravę ponownie w Profilu');
  let res;
  try {
    res = await call(creds.id, { method: 'post', url: `${API}/oauth/token`, data: {
      client_id:     creds.id,
      client_secret: creds.secret,
      grant_type:    'refresh_token',
      refresh_token: tok.refresh_token,
    } });
  } catch (e) {
    // the rider removed the app on strava.com, or the keys were changed
    if (e.response?.status === 400 || e.response?.status === 401)
      throw new Error('Połączenie ze Stravą wygasło — połącz Stravę ponownie w Profilu');
    throw e;
  }
  const d = res.data;
  db.saveToken(userId, tokenRow(d, creds.id, tok));
  return d.access_token;
}

// Tell Strava to forget this rider's authorisation of the application
async function deauthorize(userId) {
  const tok = db.getToken(userId);
  if (!tok) return false;
  let token = tok.access_token;
  try { token = await getValidToken(userId) || token; } catch (_) {}
  await call(tok.client_id || 'own', { method: 'post', url: `${API}/oauth/deauthorize`, params: { access_token: token }, timeout: 8000 });
  return true;
}

// ── Incremental sync ──────────────────────────────────────────────────────────

async function syncActivities(userId, onProgress) {
  const token = await getValidToken(userId);
  if (!token) throw new Error('Brak autoryzacji Strava');
  const clientId = db.getToken(userId)?.client_id || `own:${userId}`;

  const lastDate = db.getLatestDate(userId);
  const afterTs  = lastDate ? Math.floor(new Date(lastDate).getTime() / 1000) - 86400 : 0;

  onProgress({ phase: 'fetch', done: 0, total: null });

  const activities = [];
  let page = 1;
  while (true) {
    let res;
    try {
      res = await call(clientId, { method: 'get', url: `${API}/api/v3/athlete/activities`,
        headers: { Authorization: `Bearer ${token}` },
        params:  { per_page: 200, page, after: afterTs },
      });
    } catch (e) {
      if (e.response?.status === 401) throw new Error('Połączenie ze Stravą wygasło — połącz Stravę ponownie w Profilu');
      throw e;
    }
    if (!Array.isArray(res.data) || !res.data.length) break;
    activities.push(...res.data);
    page++;
    onProgress({ phase: 'fetch', done: activities.length, total: null });
    if (res.data.length < 200) break;   // last page: no extra request just to see an empty one
    await sleep(API.startsWith('https://www.strava.com') ? 1500 : 0);
  }

  onProgress({ phase: 'process', done: 0, total: activities.length });

  let processed = 0, skipped = 0;
  const sqBefore  = db.getSQCount(userId);
  const sqiBefore = db.getSQICount(userId);

  for (const act of activities) {
    if (db.hasActivity(userId, act.id)) { skipped++; continue; }

    const polyline = act.map?.summary_polyline;
    if (polyline) {
      const coords = decodePolyline(polyline);
      if (coords.length > 1) {
        const { sq14, sq17 } = trackToTiles(coords);
        db.insertTilesSQBatch(userId, [...sq14].map(k => k.split(',').map(Number)));
        db.insertTilesSQIBatch(userId, [...sq17].map(k => k.split(',').map(Number)));
      }
    }

    db.saveActivity(userId, {
      strava_id:  act.id,
      name:       act.name,
      sport_type: act.sport_type || act.type,
      start_date: act.start_date,
      distance_m: act.distance,
    });

    processed++;
    if (processed % 10 === 0) {
      onProgress({ phase: 'process', done: processed, total: activities.length });
    }
  }

  return {
    fetched:   activities.length,
    processed,
    skipped,
    newSQ:  db.getSQCount(userId)  - sqBefore,
    newSQI: db.getSQICount(userId) - sqiBefore,
    totalSQ:  db.getSQCount(userId),
    totalSQI: db.getSQICount(userId),
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  getAuthUrl, exchangeCode, exchangeWith, saveExchanged, getValidToken, syncActivities, deauthorize,
  appCreds, ownCreds, credsFor, isShared, pausedFor, scopeAllowsActivities, StravaLimitError,
  usageOf: (clientId) => usage.get(String(clientId)) || null,
};
