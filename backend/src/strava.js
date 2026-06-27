/**
 * strava.js — Strava OAuth + incremental activity sync (multi-user)
 */

const axios  = require('axios');
const db     = require('./db');
const { trackToTiles, decodePolyline } = require('./tiles');

const REDIRECT_URI = process.env.STRAVA_REDIRECT_URI || 'http://localhost:3000/auth/callback';

// ── OAuth ─────────────────────────────────────────────────────────────────────

function getAuthUrl(clientId, state) {
  return 'https://www.strava.com/oauth/authorize'
    + `?client_id=${encodeURIComponent(clientId)}`
    + '&response_type=code'
    + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
    + '&approval_prompt=auto'
    + '&scope=read,activity:read_all'
    + `&state=${encodeURIComponent(state)}`;
}

async function exchangeCode(userId, code) {
  const user = db.getUserById(userId);
  if (!user?.strava_client_id || !user?.strava_client_secret) {
    throw new Error('Brak konfiguracji Strava API — dodaj Client ID i Secret w profilu');
  }
  const res = await axios.post('https://www.strava.com/oauth/token', {
    client_id:     user.strava_client_id,
    client_secret: user.strava_client_secret,
    code,
    grant_type:    'authorization_code',
    redirect_uri:  REDIRECT_URI,
  });
  const d = res.data;
  db.saveToken(userId, {
    access_token:  d.access_token,
    refresh_token: d.refresh_token,
    expires_at:    d.expires_at,
    athlete_id:    d.athlete?.id ?? null,
    athlete_json:  JSON.stringify(d.athlete ?? {}),
  });
  return d.athlete;
}

async function getValidToken(userId) {
  const tok = db.getToken(userId);
  if (!tok) return null;
  const now = Math.floor(Date.now() / 1000);
  if (tok.expires_at > now + 60) return tok.access_token;

  const user = db.getUserById(userId);
  const res = await axios.post('https://www.strava.com/oauth/token', {
    client_id:     user.strava_client_id,
    client_secret: user.strava_client_secret,
    grant_type:    'refresh_token',
    refresh_token: tok.refresh_token,
  });
  const d = res.data;
  db.saveToken(userId, {
    access_token:  d.access_token,
    refresh_token: d.refresh_token,
    expires_at:    d.expires_at,
    athlete_id:    tok.athlete_id,
    athlete_json:  tok.athlete_json,
  });
  return d.access_token;
}

// ── Incremental sync ──────────────────────────────────────────────────────────

async function syncActivities(userId, onProgress) {
  const token = await getValidToken(userId);
  if (!token) throw new Error('Brak autoryzacji Strava');

  const lastDate = db.getLatestDate(userId);
  const afterTs  = lastDate ? Math.floor(new Date(lastDate).getTime() / 1000) - 86400 : 0;

  onProgress({ phase: 'fetch', done: 0, total: null });

  const activities = [];
  let page = 1;
  while (true) {
    const res = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
      headers: { Authorization: `Bearer ${token}` },
      params:  { per_page: 200, page, after: afterTs },
    });
    if (!res.data.length) break;
    activities.push(...res.data);
    page++;
    onProgress({ phase: 'fetch', done: activities.length, total: null });
    if (activities.length % 200 === 0) await sleep(1500);
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

module.exports = { getAuthUrl, exchangeCode, getValidToken, syncActivities };
