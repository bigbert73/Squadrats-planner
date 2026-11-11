/**
 * routing.js — thin clients for BRouter (local) and OSRM (public demo).
 *
 * `avoid` is an optional list of {lat,lng} describing road already ridden;
 * BRouter gets it as a weighted polyline no-go, so it prefers other roads but
 * can still use them where there is no alternative (e.g. the last street home).
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const BROUTER_URL = process.env.BROUTER_URL || 'http://brouter:17777';

// ── Coverage ──────────────────────────────────────────────────────────────────
// BRouter plans on .rd5 files, one per 5°×5° tile named after its south-west
// corner (E5_N50 = 5–10°E, 50–55°N), fetched by tools/update-segments.sh.
// Where there is no file there is no route: say so, instead of handing out a
// route from somewhere else.
const SEGMENTS_DIR = process.env.SEGMENTS_DIR
  || path.join(path.dirname(process.env.DB_PATH || path.join(__dirname, '../../data/squadrats.db')), 'brouter-segments');
let cov = null, covAt = 0;
function coverage() {
  if (cov && Date.now() - covAt < 60000) return cov;
  let names = [];
  try { names = fs.readdirSync(SEGMENTS_DIR).filter(f => /^[EW]\d+_[NS]\d+\.rd5$/.test(f)); } catch {}
  // no folder to look at (BRouter runs elsewhere): unknown, nothing is refused up front
  const tiles = names.length ? names.map(f => f.slice(0, -4)).sort() : null;
  let bbox = null;
  if (tiles) {
    bbox = { west: 180, south: 90, east: -180, north: -90 };
    for (const t of tiles) {
      const m = /^([EW])(\d+)_([NS])(\d+)$/.exec(t);
      const lng = (m[1] === 'W' ? -1 : 1) * Number(m[2]), lat = (m[3] === 'S' ? -1 : 1) * Number(m[4]);
      bbox.west = Math.min(bbox.west, lng); bbox.east = Math.max(bbox.east, lng + 5);
      bbox.south = Math.min(bbox.south, lat); bbox.north = Math.max(bbox.north, lat + 5);
    }
  }
  cov = { tiles, set: tiles ? new Set(tiles) : null, bbox, step: 5 };
  covAt = Date.now();
  return cov;
}
function tileName(lat, lng) {
  const lo = Math.floor(lng / 5) * 5, la = Math.floor(lat / 5) * 5;
  return `${lo < 0 ? 'W' + -lo : 'E' + lo}_${la < 0 ? 'S' + -la : 'N' + la}`;
}
function covered(p) {
  const c = coverage();
  return !c.set || c.set.has(tileName(p.lat, p.lng));
}

class RoutingAreaError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const noData = () => new RoutingAreaError('NO_ROUTING_DATA', 'Ten obszar jest poza zasięgiem planowania tras');
// BRouter answers 400 with one line of text
function brouterError(text) {
  if (typeof text !== 'string') return null;
  if (/datafile \S+ not found/i.test(text)) return noData();
  if (/-position not mapped/i.test(text)) return new RoutingAreaError('NO_ROAD_NEAR', 'W pobliżu punktu nie ma drogi, którą da się pojechać');
  return null;
}
// Tuned on real loops around Warsaw: weight 1000 with a vertex every ~200 m
// took return-leg reuse from 98% to 0% at ~+1% length; 5000 forced 30% longer
// detours, 300 leaked back onto the road when vertices were sparser.
const AVOID_WEIGHT = 1000;
const AVOID_SPACING_KM = 0.2;
const AVOID_MAX_PTS = 300;

async function fetchOsrmRoute(points) {
  const coords = points.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/bike/${coords}?overview=full&geometries=geojson&steps=false`;
  const r = await axios.get(url, { timeout: 20000 });
  return r.data;
}

function avoidParam(avoid) {
  if (!avoid || avoid.length < 2) return '';
  let total = 0;
  for (let i = 1; i < avoid.length; i++) total += haversineKm(avoid[i - 1], avoid[i]);
  const spacing = Math.max(AVOID_SPACING_KM, total / AVOID_MAX_PTS);
  const pts = [avoid[0]];
  let acc = 0;
  for (let i = 1; i < avoid.length; i++) {
    acc += haversineKm(avoid[i - 1], avoid[i]);
    if (acc >= spacing || i === avoid.length - 1) { pts.push(avoid[i]); acc = 0; }
  }
  return `&polylines=${pts.map(p => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`).join(',')},${AVOID_WEIGHT}`;
}

function haversineKm(a, b) {
  const r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lng - a.lng) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// timeoutMs: callers exploring many optional candidates pass a short limit so
// one hard-to-route candidate can't stall the whole batch.
// Walking and running share BRouter's hiking profile; the rider's choice only
// changes the pace and the length range in the app.
const FOOT_PROFILES = new Set(['foot', 'run']);
const BROUTER_NAME = { foot: 'hiking-mountain', run: 'hiking-mountain' };
const isFoot = (p) => FOOT_PROFILES.has(p);

async function fetchBRouterRoute(points, profile, altIdx = 0, avoid = null, timeoutMs = 90000) {
  profile = BROUTER_NAME[profile] || profile;
  const lonlats = points.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join('|');
  const url = `${BROUTER_URL}/brouter?lonlats=${lonlats}&profile=${profile}&alternativeidx=${altIdx}&format=geojson&turnInstructionMode=2&timeout=${Math.ceil(Math.min(timeoutMs, 60000) / 1000)}${avoidParam(avoid)}`;
  let r;
  try { r = await axios.get(url, { timeout: timeoutMs }); }
  catch (e) { throw brouterError(e.response?.data) || e; }
  const feat = r.data?.features?.[0];
  if (!feat) throw brouterError(r.data) || new Error('BRouter: pusta odpowiedź');
  // A point far out at sea can be "snapped" to a ferry line tens of km away:
  // a route that starts or ends that far from where it was asked to is no answer.
  const g = feat.geometry?.coordinates;
  if (Array.isArray(g) && g.length) {
    const off = (c, p) => Math.hypot((c[1] - p.lat) * 111, (c[0] - p.lng) * 111 * Math.cos(p.lat * Math.PI / 180));
    if (off(g[0], points[0]) > 3 || off(g[g.length - 1], points[points.length - 1]) > 3) throw brouterError('to-position not mapped in existing datafile');
  }

  let elevProfile = null;
  let surfaceProfile = null;
  const msgs = feat.properties?.messages;
  if (Array.isArray(msgs) && msgs.length > 1) {
    // Find WayTags column index dynamically from header (default 9)
    const hdr = msgs[0];
    const wtIdx = Array.isArray(hdr) ? hdr.indexOf('WayTags') : 9;
    const tagIdx = wtIdx >= 0 ? wtIdx : 9;
    let cumDist = 0;
    const rows = msgs.slice(1).map(row => {
      const segDist = parseFloat(row[3]) / 1000;
      cumDist += segDist;
      const wayTags = row[tagIdx] || '';
      const surfM = wayTags.match(/surface=(\S+)/);
      const hwM   = wayTags.match(/highway=(\S+)/);
      const cycM  = wayTags.match(/cycleway=(\S+)/);
      return {
        dist: Math.round(cumDist * 100) / 100, elev: parseFloat(row[2]),
        segDist: Math.round(segDist * 1000) / 1000,
        surface: surfM ? surfM[1] : null, highway: hwM ? hwM[1] : null, cycleway: cycM ? cycM[1] : null,
      };
    });
    elevProfile = rows.map(r => ({ dist: r.dist, elev: r.elev }));
    surfaceProfile = rows.map(r => ({ dist: r.dist, segDist: r.segDist, surface: r.surface, highway: r.highway, cycleway: r.cycleway }));
  }

  // Turns for spoken navigation: [index into the geometry, command, roundabout
  // exit, metres to the next one, angle]. Commands as in BRouter's VoiceHint.
  const vh = feat.properties?.voicehints;
  const hints = Array.isArray(vh)
    ? vh.filter(h => Array.isArray(h) && Number.isInteger(h[0]) && h[0] >= 0 && h[0] < g.length)
        .map(h => [h[0], h[1] | 0, h[2] | 0, Math.round(Number(h[3]) || 0), Math.round(Number(h[4]) || 0)])
    : null;

  return {
    code: 'Ok', engine: 'brouter', profile,
    routes: [{ distance: parseFloat(feat.properties?.['track-length'] || 0), geometry: feat.geometry, elevProfile, surfaceProfile, hints }]
  };
}

// 'standard' means OSRM, which can't avoid roads; callers that need `avoid`
// honoured should use brouterProfile() instead.
async function fetchRoute(points, bikeProfile, altIdx = 0, avoid = null) {
  if (bikeProfile && bikeProfile !== 'standard') {
    try { return await fetchBRouterRoute(points, bikeProfile, altIdx, avoid); }
    catch (e) {
      // "no data here" / "no road there" is an answer, not an outage
      if (e instanceof RoutingAreaError) throw e;
      // the public OSRM only knows bicycles: no route is better than a cycling one for a walker
      if (isFoot(bikeProfile)) throw e;
      console.warn(`BRouter (${bikeProfile}) failed, falling back to OSRM:`, e.message);
    }
  }
  const data = await fetchOsrmRoute(points);
  return { ...data, engine: 'osrm', profile: bikeProfile || 'standard' };
}

function brouterProfile(bikeProfile) {
  if (BROUTER_NAME[bikeProfile]) return BROUTER_NAME[bikeProfile];
  return !bikeProfile || bikeProfile === 'standard' ? 'trekking' : bikeProfile;
}

function routeDistanceKm(d) { return d?.routes?.[0]?.distance / 1000 || 0; }

// Concatenate consecutive legs (each a fetchRoute result) into one response.
function mergeLegs(legs) {
  const coords = [], elev = [], surf = [], hints = [];
  let distM = 0, offKm = 0;
  for (const leg of legs) {
    const r = leg.routes[0];
    const c = r.geometry.coordinates;
    const at = coords.length ? coords.length - 1 : 0;   // where this leg's first point lands
    for (const h of r.hints || []) hints.push([h[0] + at, h[1], h[2], h[3], h[4]]);
    coords.push(...(coords.length ? c.slice(1) : c));
    for (const p of r.elevProfile || []) elev.push({ ...p, dist: Math.round((p.dist + offKm) * 100) / 100 });
    for (const p of r.surfaceProfile || []) surf.push({ ...p, dist: Math.round((p.dist + offKm) * 100) / 100 });
    distM += r.distance || 0;
    offKm += (r.distance || 0) / 1000;
  }
  const allElev = legs.every(l => l.routes[0].elevProfile?.length);
  const allSurf = legs.every(l => l.routes[0].surfaceProfile?.length);
  const allHints = legs.every(l => Array.isArray(l.routes[0].hints));
  return {
    code: 'Ok', engine: legs[0].engine, profile: legs[0].profile,
    routes: [{
      distance: distM,
      geometry: { type: 'LineString', coordinates: coords },
      elevProfile: allElev ? elev : null,
      surfaceProfile: allSurf ? surf : null,
      hints: allHints ? hints : null,
    }],
  };
}

module.exports = { fetchRoute, fetchBRouterRoute, brouterProfile, isFoot, routeDistanceKm, mergeLegs, coverage, covered, noData, RoutingAreaError };
