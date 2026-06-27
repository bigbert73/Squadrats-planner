/**
 * index.js — Express API server
 *
 * Routes:
 *   GET  /auth/strava            → redirect to Strava OAuth
 *   GET  /auth/callback          → exchange code, save tokens
 *   GET  /api/auth-status        → { authenticated, athlete }
 *   POST /api/logout             → clear tokens
 *
 *   POST /api/sync               → start incremental sync (SSE stream)
 *   GET  /api/stats              → tile counts + yard + uber sizes
 *
 *   GET  /api/tiles/sq           → all zoom-14 tiles (bbox optional)
 *   GET  /api/tiles/sqi          → all zoom-17 tiles (bbox optional)
 *   GET  /api/tiles/yard         → yard tiles (zoom-14)
 *   GET  /api/tiles/uber         → übersquadrat tiles (zoom-14)
 *   GET  /api/tiles/yardinho     → yardinho tiles (zoom-17)
 *   GET  /api/tiles/uberinho     → übersquadratinho tiles (zoom-17)
 *
 *   GET  /api/route              → proxy to OSRM
 *   POST /api/route/detour       → compute detour waypoints + proxy OSRM
 *
 *   POST /api/gpx/import         → import GPX file
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve frontend
const FRONTEND = path.join(__dirname, '../../frontend');
app.use(express.static(FRONTEND));

const db     = require('./db');
const strava = require('./strava');
const tiles  = require('./tiles');
const axios  = require('axios');
const { insertTilesSQBatch, insertTilesSQIBatch } = require('./db');

// ── Auth ──────────────────────────────────────────────────────────────────────

app.get('/auth/strava', (req, res) => {
  res.redirect(strava.getAuthUrl());
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/?auth=error&msg=' + (error || 'no_code'));
  try {
    await strava.exchangeCode(code);
    res.redirect('/?auth=success');
  } catch (e) {
    console.error('OAuth error:', e.message);
    res.redirect('/?auth=error&msg=' + encodeURIComponent(e.message));
  }
});

app.get('/api/auth-status', (req, res) => {
  const tok = db.getToken();
  res.json({
    authenticated: !!tok,
    athlete: tok ? JSON.parse(tok.athlete_json || '{}') : null,
  });
});

app.post('/api/logout', (req, res) => {
  db.clearToken();
  res.json({ ok: true });
});

// ── Sync (Server-Sent Events for live progress) ───────────────────────────────

app.post('/api/sync', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const result = await strava.syncActivities((progress) => {
      send(progress);
    });
    invalidateCache();
    send({ phase: 'done', ...result });
  } catch (e) {
    send({ phase: 'error', message: e.message });
  } finally {
    res.end();
  }
});

// ── Tile + stats cache ────────────────────────────────────────────────────────
//
// computeUber runs a 4096×4096 DP loop — seconds of CPU that block the event
// loop if called per-request.  Pre-compute everything once at startup and after
// every sync; all endpoints then serve from memory in microseconds.

let cache = null;

function buildCache() {
  const sqRows  = db.getAllTilesSQ();
  const sqiRows = db.getAllTilesSQI();
  const yard    = tiles.computeYard(sqRows);
  const uber    = tiles.computeUber(sqRows);
  const yardi   = tiles.computeYard(sqiRows);
  const uberi   = tiles.computeUber(sqiRows);
  cache = {
    sqRows, sqiRows, yard, uber, yardi, uberi,
    stats: {
      sq:         db.getSQCount(),
      sqi:        db.getSQICount(),
      activities: db.getActivityCount(),
      yard:       { size: yard.size },
      uber:       { size: uber.size },
      yardi:      { size: yardi.size },
      uberi:      { size: uberi.size },
    },
  };
  console.log(`Cache built — SQ:${cache.stats.sq} SQI:${cache.stats.sqi} yard:${yard.size} uber:${uber.size}`);
}

function invalidateCache() { cache = null; }

function getCache() {
  if (!cache) buildCache();
  return cache;
}

// Pre-build cache after startup so probes don't trigger heavy computation
setImmediate(() => {
  try { buildCache(); } catch (e) { console.error('Cache build failed:', e.message); }
});

// ── Stats ─────────────────────────────────────────────────────────────────────

app.get('/api/stats', (req, res) => {
  res.json(getCache().stats);
});

// ── Tile endpoints ────────────────────────────────────────────────────────────

function parseBbox(q) {
  if (q.x0 !== undefined) return [+q.x0, +q.x1, +q.y0, +q.y1];
  return null;
}

app.get('/api/tiles/sq', (req, res) => {
  const bbox = parseBbox(req.query);
  res.json(bbox ? db.getTilesSQBbox(...bbox) : getCache().sqRows);
});

app.get('/api/tiles/sqi', (req, res) => {
  const bbox = parseBbox(req.query);
  res.json(bbox ? db.getTilesSQIBbox(...bbox) : getCache().sqiRows);
});

app.get('/api/tiles/yard',     (req, res) => res.json(getCache().yard));
app.get('/api/tiles/uber',     (req, res) => res.json(getCache().uber));
app.get('/api/tiles/yardinho', (req, res) => res.json(getCache().yardi));
app.get('/api/tiles/uberinho', (req, res) => res.json(getCache().uberi));

// ── Route (OSRM proxy) ────────────────────────────────────────────────────────

app.get('/api/route', async (req, res) => {
  const { coordinates, profile = 'bike' } = req.query;
  if (!coordinates) return res.status(400).json({ error: 'coordinates required' });

  try {
    const url = `https://router.project-osrm.org/route/v1/${profile}/${coordinates}`
      + `?overview=full&geometries=geojson&steps=false`;
    const r = await axios.get(url, { timeout: 15000 });
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: 'OSRM error: ' + e.message });
  }
});

const BROUTER_URL = process.env.BROUTER_URL || 'http://brouter:17777';

async function fetchOsrmRoute(points) {
  const coords = points.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/bike/${coords}?overview=full&geometries=geojson&steps=false`;
  const r = await axios.get(url, { timeout: 20000 });
  return r.data;
}

async function fetchBRouterRoute(points, profile) {
  const lonlats = points.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join('|');
  // timeout=60 tells BRouter to allow up to 60s per request (default is 8s which kills long routes)
  const url = `${BROUTER_URL}/brouter?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=geojson&timeout=60`;
  const r = await axios.get(url, { timeout: 90000 });
  const feat = r.data?.features?.[0];
  if (!feat) throw new Error('BRouter: empty response');
  return {
    code: 'Ok',
    engine: 'brouter',
    profile,
    routes: [{
      distance: parseFloat(feat.properties?.['track-length'] || 0),
      geometry: feat.geometry,
    }]
  };
}

async function fetchRoute(points, bikeProfile) {
  if (bikeProfile && bikeProfile !== 'standard') {
    try {
      return await fetchBRouterRoute(points, bikeProfile);
    } catch (e) {
      console.warn(`BRouter (${bikeProfile}) failed, falling back to OSRM:`, e.message);
    }
  }
  const data = await fetchOsrmRoute(points);
  return { ...data, engine: 'osrm', profile: bikeProfile || 'standard' };
}

function routeDistanceKm(routeData) {
  return routeData?.routes?.[0]?.distance / 1000 || 0;
}

// POST body: { waypoints:[{lat,lng}], mode, loop }
// Returns optimised OSRM route with detour waypoints injected
app.post('/api/route/detour', async (req, res) => {
  const { waypoints, mode = 'sq', loop = false, targetKm = 0, bikeProfile = 'standard' } = req.body;
  if (!waypoints?.length) return res.status(400).json({ error: 'waypoints required' });

  const c = getCache();
  const ownedSQSet  = new Set(c.sqRows.map(r => `${r.tx},${r.ty}`));
  const ownedSQISet = new Set(c.sqiRows.map(r => `${r.tx},${r.ty}`));

  let pts = [...waypoints];
  const start = waypoints[0];
  const end = waypoints[waypoints.length - 1];
  const samePoint = tiles.haversineDistance(start, end) < 0.4;

  if (loop || samePoint) {
    if (samePoint && waypoints.length === 2) {
      pts = tiles.createLoopWaypoints(start, targetKm || 15);
    } else {
      pts.push(pts[0]);
    }
  }

  if (mode === 'shortest') {
    try {
      const routeData = await fetchRoute(pts, bikeProfile);
      return res.json(routeData);
    } catch (e) {
      return res.status(500).json({ error: 'Routing error: ' + e.message });
    }
  }

  const tolerance = 0.15;
  const target = Math.max(0, targetKm);
  let routeData;

  try {
    routeData = await fetchRoute(pts, bikeProfile);
  } catch (e) {
    return res.status(500).json({ error: 'Routing error: ' + e.message });
  }

  const baseKm = routeDistanceKm(routeData);
  if (baseKm === 0) return res.status(500).json({ error: 'Could not compute base route' });

  const minKm = target > 0 ? target * (1 - tolerance) : 0;
  const maxKm = target > 0 ? target * (1 + tolerance) : Infinity;

  if (!target || target <= baseKm || (baseKm >= minKm && baseKm <= maxKm)) {
    return res.json(routeData);
  }

  // Road factor: ratio of real OSRM distance to straight-line haversine.
  // Used to convert the OSRM-space target into haversine-space before
  // passing it to buildDetourWaypoints (which works in haversine km).
  const baseHaversineKm = pts.slice(1).reduce((sum, pt, i) => sum + tiles.haversineDistance(pts[i], pt), 0);
  const roadFactor = baseHaversineKm > 0.1
    ? Math.min(3, Math.max(0.8, baseKm / baseHaversineKm))
    : 1.3;

  let best = { data: routeData, diff: Math.abs(baseKm - target) };
  let lo = baseKm;
  let hi = target * 2;
  let currentTarget = target;
  let prevRouteKm = baseKm;

  for (let attempt = 0; attempt < 8; attempt++) {
    const scaledTarget = currentTarget / roadFactor;
    const detourPts = tiles.buildDetourWaypoints(pts, ownedSQSet, ownedSQISet, mode, scaledTarget);
    if (detourPts.length < 2) break;

    let detourData;
    try {
      detourData = await fetchRoute(detourPts, bikeProfile);
    } catch (e) {
      break;
    }

    const routeKm = routeDistanceKm(detourData);
    const diff = Math.abs(routeKm - target);
    if (diff < best.diff) best = { data: detourData, diff };
    if (routeKm >= minKm && routeKm <= maxKm) {
      return res.json(detourData);
    }

    // Binary search: narrow the range toward target
    if (routeKm < minKm) lo = Math.max(lo, currentTarget);
    else hi = Math.min(hi, currentTarget);

    if (hi - lo < 0.5 || Math.abs(routeKm - prevRouteKm) < 0.1) break;
    prevRouteKm = routeKm;
    currentTarget = (lo + hi) / 2;
  }

  return res.json(best.data);
});

// ── GPX import ────────────────────────────────────────────────────────────────

// POST body: { gpxText: "..." }
app.post('/api/gpx/import', (req, res) => {
  const { gpxText } = req.body;
  if (!gpxText) return res.status(400).json({ error: 'gpxText required' });

  try {
    // Simple regex-based GPX parser (no DOM in Node)
    const ptRe = /lat="([^"]+)"\s+lon="([^"]+)"/g;
    const coords = [];
    let m;
    while ((m = ptRe.exec(gpxText)) !== null) {
      coords.push({ lat: parseFloat(m[1]), lng: parseFloat(m[2]) });
    }
    if (!coords.length) return res.status(400).json({ error: 'No GPS points found' });

    const { sq14, sq17 } = tiles.trackToTiles(coords);
    insertTilesSQBatch([...sq14].map(k => k.split(',').map(Number)));
    insertTilesSQIBatch([...sq17].map(k => k.split(',').map(Number)));
    invalidateCache();

    res.json({
      points: coords.length,
      newSQ:  sq14.size,
      newSQI: sq17.size,
      totalSQ:  db.getSQCount(),
      totalSQI: db.getSQICount(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Compute new tiles for a planned route (without saving) ───────────────────

app.post('/api/route/preview-tiles', (req, res) => {
  const { coords } = req.body; // [{lat,lng},...]
  if (!coords?.length) return res.status(400).json({ error: 'coords required' });

  const ownedSQ  = new Set(db.getAllTilesSQ().map(r => `${r.tx},${r.ty}`));
  const ownedSQI = new Set(db.getAllTilesSQI().map(r => `${r.tx},${r.ty}`));

  const { sq14, sq17 } = tiles.trackToTiles(coords);
  const newSQ  = [...sq14].filter(k => !ownedSQ.has(k)).map(k => {
    const [tx,ty]=k.split(',').map(Number); return {tx,ty};
  });
  const newSQI = [...sq17].filter(k => !ownedSQI.has(k)).map(k => {
    const [tx,ty]=k.split(',').map(Number); return {tx,ty};
  });

  res.json({ newSQ, newSQI, countSQ: newSQ.length, countSQI: newSQI.length });
});

// ── SPA fallback ──────────────────────────────────────────────────────────────
// ── Street View embed URL (requires GOOGLE_MAPS_KEY env var) ─────────────────
app.get('/api/streetview/embed-url', (req, res) => {
  const { lat, lng } = req.query;
  const key = process.env.GOOGLE_MAPS_KEY;
  if (!key || !lat || !lng) return res.json({ url: null });
  const url = `https://www.google.com/maps/embed/v1/streetview?key=${key}&location=${parseFloat(lat).toFixed(6)},${parseFloat(lng).toFixed(6)}&heading=0&pitch=0&fov=90`;
  res.json({ url });
});

// ── Street View interactive viewer — Maps JS API + postMessage position updates
app.get('/api/streetview/viewer', (req, res) => {
  const { lat, lng } = req.query;
  const key = process.env.GOOGLE_MAPS_KEY;
  if (!key || !lat || !lng) return res.status(404).send('No API key');
  const la = parseFloat(lat).toFixed(6);
  const ln = parseFloat(lng).toFixed(6);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<style>*{margin:0;padding:0}html,body,#sv{width:100%;height:100vh;overflow:hidden}</style></head>
<body><div id="sv"></div><script>
function svInit(){
  var pano=new google.maps.StreetViewPanorama(document.getElementById('sv'),{
    position:{lat:${la},lng:${ln}},
    pov:{heading:0,pitch:0},
    addressControl:false,showRoadLabels:true,motionTracking:false
  });
  function send(){
    var pos=pano.getPosition();
    if(!pos)return;
    var pov=pano.getPov();
    window.parent.postMessage({type:'sv-update',lat:pos.lat(),lng:pos.lng(),heading:pov.heading},'*');
  }
  pano.addListener('position_changed',send);
  pano.addListener('pov_changed',send);
}
<\/script>
<script src="https://maps.googleapis.com/maps/api/js?key=${key}&callback=svInit" async defer><\/script>
</body></html>`);
});

// ── Street View coverage (requires GOOGLE_MAPS_KEY env var) ──────────────────
app.post('/api/streetview/coverage', async (req, res) => {
  const { points } = req.body;
  const key = process.env.GOOGLE_MAPS_KEY;
  if (!key || !points?.length) return res.json({ coverage: null });
  try {
    const coverage = await Promise.all(points.map(async p => {
      const url = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${p.lat},${p.lng}&source=outdoor&key=${key}`;
      const r = await fetch(url);
      const d = await r.json();
      return { lat: p.lat, lng: p.lng, ok: d.status === 'OK' };
    }));
    res.json({ coverage });
  } catch (e) {
    res.json({ coverage: null });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(FRONTEND, 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  Squadrats Route Planner v2.0        ║`);
  console.log(`║  http://localhost:${PORT}               ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
  console.log(`  DB: ${process.env.DB_PATH}`);
  console.log(`  SQ tiles:  ${db.getSQCount()}`);
  console.log(`  SQI tiles: ${db.getSQICount()}`);
  console.log(`  Activities: ${db.getActivityCount()}\n`);
});
