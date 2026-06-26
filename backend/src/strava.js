/**
 * strava.js — Strava OAuth + incremental activity sync
 *
 * Sync strategy:
 *   1. First sync: fetch ALL activities (paginated)
 *   2. Subsequent syncs: fetch only activities after latest known date
 *   3. Each activity's summary_polyline is decoded → tiles saved to DB
 *   4. Already-processed activity IDs are skipped instantly
 */

const axios  = require('axios');
const db     = require('./db');
const { trackToTiles, decodePolyline } = require('./tiles');
const { insertTilesSQBatch, insertTilesSQIBatch } = require('./db');

const CLIENT_ID     = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const REDIRECT_URI  = process.env.STRAVA_REDIRECT_URI || 'http://localhost:3000/auth/callback';

// ── OAuth ────────────────────────────────────────────────────────────────────

function getAuthUrl() {
  return 'https://www.strava.com/oauth/authorize'
    + `?client_id=${CLIENT_ID}`
    + '&response_type=code'
    + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
    + '&approval_prompt=auto'
    + '&scope=read,activity:read_all';
}

async function exchangeCode(code) {
  const res = await axios.post('https://www.strava.com/oauth/token', {
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
  });
  const d = res.data;
  db.saveToken({
    access_token:  d.access_token,
    refresh_token: d.refresh_token,
    expires_at:    d.expires_at,
    athlete_id:    d.athlete?.id ?? null,
    athlete_json:  JSON.stringify(d.athlete ?? {}),
  });
  return d.athlete;
}

async function getValidToken() {
  const tok = db.getToken();
  if (!tok) return null;
  const now = Math.floor(Date.now() / 1000);
  if (tok.expires_at > now + 60) return tok.access_token;

  // Refresh
  const res = await axios.post('https://www.strava.com/oauth/token', {
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type:    'refresh_token',
    refresh_token: tok.refresh_token,
  });
  const d = res.data;
  db.saveToken({
    access_token:  d.access_token,
    refresh_token: d.refresh_token,
    expires_at:    d.expires_at,
    athlete_id:    tok.athlete_id,
    athlete_json:  tok.athlete_json,
  });
  return d.access_token;
}

// ── Incremental sync ─────────────────────────────────────────────────────────

/**
 * Sync new activities from Strava.
 * Emits progress events via the onProgress callback: { phase, done, total, newSQ, newSQI }
 */
async function syncActivities(onProgress) {
  const token = await getValidToken();
  if (!token) throw new Error('Not authenticated');

  const lastDate = db.getLatestDate();
  // If we have data, fetch from lastDate − 1 day (handle timezone slop)
  const afterTs = lastDate
    ? Math.floor(new Date(lastDate).getTime() / 1000) - 86400
    : 0;

  onProgress({ phase: 'fetch', done: 0, total: null });

  // ── Fetch activity list (paginated) ──────────────────────────────────────
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
    // Strava rate limit: 200/15min — stay safe
    if (activities.length % 200 === 0) await sleep(1500);
  }

  onProgress({ phase: 'process', done: 0, total: activities.length });

  // ── Process each activity ─────────────────────────────────────────────────
  let processed = 0, skipped = 0, newSQ = 0, newSQI = 0;
  const sqBefore  = db.getSQCount();
  const sqiBefore = db.getSQICount();

  for (const act of activities) {
    // Skip already processed
    if (db.hasActivity(act.id)) { skipped++; continue; }

    // Decode polyline → tiles
    const polyline = act.map?.summary_polyline;
    if (polyline) {
      const coords = decodePolyline(polyline);
      if (coords.length > 1) {
        const { sq14, sq17 } = trackToTiles(coords);
        const sq14arr  = [...sq14].map(k => k.split(',').map(Number));
        const sq17arr  = [...sq17].map(k => k.split(',').map(Number));
        insertTilesSQBatch(sq14arr);
        insertTilesSQIBatch(sq17arr);
      }
    }

    // Record activity as processed
    db.saveActivity({
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

  newSQ  = db.getSQCount()  - sqBefore;
  newSQI = db.getSQICount() - sqiBefore;

  return {
    fetched:   activities.length,
    processed,
    skipped,
    newSQ,
    newSQI,
    totalSQ:   db.getSQCount(),
    totalSQI:  db.getSQICount(),
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { getAuthUrl, exchangeCode, getValidToken, syncActivities };
