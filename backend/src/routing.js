/**
 * routing.js — thin clients for BRouter (local) and OSRM (public demo).
 *
 * `avoid` is an optional list of {lat,lng} describing road already ridden;
 * BRouter gets it as a weighted polyline no-go, so it prefers other roads but
 * can still use them where there is no alternative (e.g. the last street home).
 */

const axios = require('axios');

const BROUTER_URL = process.env.BROUTER_URL || 'http://brouter:17777';
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

async function fetchBRouterRoute(points, profile, altIdx = 0, avoid = null) {
  const lonlats = points.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join('|');
  const url = `${BROUTER_URL}/brouter?lonlats=${lonlats}&profile=${profile}&alternativeidx=${altIdx}&format=geojson&timeout=60${avoidParam(avoid)}`;
  const r = await axios.get(url, { timeout: 90000 });
  const feat = r.data?.features?.[0];
  if (!feat) throw new Error('BRouter: pusta odpowiedź');

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

  return {
    code: 'Ok', engine: 'brouter', profile,
    routes: [{ distance: parseFloat(feat.properties?.['track-length'] || 0), geometry: feat.geometry, elevProfile, surfaceProfile }]
  };
}

// 'standard' means OSRM, which can't avoid roads; callers that need `avoid`
// honoured should use brouterProfile() instead.
async function fetchRoute(points, bikeProfile, altIdx = 0, avoid = null) {
  if (bikeProfile && bikeProfile !== 'standard') {
    try { return await fetchBRouterRoute(points, bikeProfile, altIdx, avoid); }
    catch (e) { console.warn(`BRouter (${bikeProfile}) failed, falling back to OSRM:`, e.message); }
  }
  const data = await fetchOsrmRoute(points);
  return { ...data, engine: 'osrm', profile: bikeProfile || 'standard' };
}

function brouterProfile(bikeProfile) {
  return !bikeProfile || bikeProfile === 'standard' ? 'trekking' : bikeProfile;
}

function routeDistanceKm(d) { return d?.routes?.[0]?.distance / 1000 || 0; }

// Concatenate consecutive legs (each a fetchRoute result) into one response.
function mergeLegs(legs) {
  const coords = [], elev = [], surf = [];
  let distM = 0, offKm = 0;
  for (const leg of legs) {
    const r = leg.routes[0];
    const c = r.geometry.coordinates;
    coords.push(...(coords.length ? c.slice(1) : c));
    for (const p of r.elevProfile || []) elev.push({ ...p, dist: Math.round((p.dist + offKm) * 100) / 100 });
    for (const p of r.surfaceProfile || []) surf.push({ ...p, dist: Math.round((p.dist + offKm) * 100) / 100 });
    distM += r.distance || 0;
    offKm += (r.distance || 0) / 1000;
  }
  const allElev = legs.every(l => l.routes[0].elevProfile?.length);
  const allSurf = legs.every(l => l.routes[0].surfaceProfile?.length);
  return {
    code: 'Ok', engine: legs[0].engine, profile: legs[0].profile,
    routes: [{
      distance: distM,
      geometry: { type: 'LineString', coordinates: coords },
      elevProfile: allElev ? elev : null,
      surfaceProfile: allSurf ? surf : null,
    }],
  };
}

module.exports = { fetchRoute, fetchBRouterRoute, brouterProfile, routeDistanceKm, mergeLegs };
