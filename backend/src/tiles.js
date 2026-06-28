/**
 * tiles.js — Squadrats tile engine
 *
 * Squadrat     = OSM slippy-map zoom 14  (~1524 m at equator, ~1050 m at 52°N)
 * Squadratinho = OSM slippy-map zoom 17  (~191 m at equator, ~131 m at 52°N)
 *
 * Key insight: tiles are NOT defined by degrees (0.1°×0.1°) but by the
 * Mercator Web projection used by OpenStreetMap / Leaflet.
 */

const Z_SQ  = 14;
const Z_SQI = 17;

// ── OSM Slippy Map conversions ─────────────────────────────────────────────

/** lat/lng (WGS84) → tile {x, y} at zoom z */
function latLngToTile(lat, lng, z) {
  const n   = 1 << z;  // 2^z
  const x   = Math.floor((lng + 180) / 360 * n);
  const lr  = lat * Math.PI / 180;
  const y   = Math.floor((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n);
  return { x, y };
}

/** Tile {x,y} NW corner → lat/lng */
function tileNW(x, y, z) {
  const n      = 1 << z;
  const lng    = x / n * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
  return { lat: latRad * 180 / Math.PI, lng };
}

/** Tile bounds → [[south, west], [north, east]] (Leaflet-compatible) */
function tileBounds(x, y, z) {
  const nw = tileNW(x,   y,   z);
  const se = tileNW(x+1, y+1, z);
  return [[se.lat, nw.lng], [nw.lat, se.lng]];
}

function tileCenter(x, y, z) {
  const nw = tileNW(x, y, z);
  const se = tileNW(x + 1, y + 1, z);
  return { lat: (nw.lat + se.lat) / 2, lng: (nw.lng + se.lng) / 2 };
}

const EARTH_RADIUS_KM = 6371;
function toRad(deg) { return deg * Math.PI / 180; }
function toDeg(rad) { return rad * 180 / Math.PI; }

function haversineDistance(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function destinationPoint(lat, lng, bearingDeg, distanceKm) {
  const φ1 = toRad(lat);
  const λ1 = toRad(lng);
  const θ  = toRad(bearingDeg);
  const δ  = distanceKm / EARTH_RADIUS_KM;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: toDeg(φ2), lng: ((toDeg(λ2) + 540) % 360) - 180 };
}

function createLoopWaypoints(center, targetKm = 15) {
  // radius calibrated so loop haversine ≈ 0.62 * targetKm (≈6.24r),
  // which at typical road factor ~1.3 gives OSRM ≈ 0.81 * targetKm.
  // Undershooting on purpose so the iteration can always extend.
  const radius = Math.max(1, Math.min(25, targetKm / 10));
  const bearings = [30, 120, 210, 300];
  const points = [center];
  for (const bearing of bearings) {
    points.push(destinationPoint(center.lat, center.lng, bearing, radius));
  }
  points.push(center);
  return points;
}

// ── Segment → touched tiles (Bresenham-style, zoom-aware step size) ─────────

/**
 * Returns a Set of "tx,ty" strings for every tile touched by the GPS segment.
 * Step size is calibrated to never skip a tile at the given zoom level.
 */
function tilesOnSegment(lat1, lng1, lat2, lng2, z) {
  const tiles = new Set();

  // At zoom 14, one tile ≈ 0.022° lat × varies lng. Step 0.005° is safe.
  // At zoom 17 (8× smaller), we need 0.0005°.
  const step = z >= 17 ? 0.0004 : 0.004;

  const dLat = lat2 - lat1;
  const dLng = lng2 - lng1;
  const dist  = Math.sqrt(dLat * dLat + dLng * dLng);
  const steps = Math.max(1, Math.ceil(dist / step));

  for (let i = 0; i <= steps; i++) {
    const f   = i / steps;
    const lat = lat1 + dLat * f;
    const lng = lng1 + dLng * f;
    const { x, y } = latLngToTile(lat, lng, z);
    tiles.add(`${x},${y}`);
  }
  return tiles;
}

/**
 * Process a full GPS track (array of {lat,lng}) and return two Sets:
 *   sq14 — zoom-14 tile keys "x,y"
 *   sq17 — zoom-17 tile keys "x,y"
 */
function trackToTiles(coords) {
  const sq14 = new Set();
  const sq17 = new Set();
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1];
    tilesOnSegment(a.lat, a.lng, b.lat, b.lng, Z_SQ) .forEach(k => sq14.add(k));
    tilesOnSegment(a.lat, a.lng, b.lat, b.lng, Z_SQI).forEach(k => sq17.add(k));
  }
  return { sq14, sq17 };
}

// ── Decode Google Encoded Polyline ──────────────────────────────────────────

function decodePolyline(str) {
  let i = 0, lat = 0, lng = 0;
  const pts = [];
  while (i < str.length) {
    let r = 0, s = 0, b;
    do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << s; s += 5; } while (b >= 0x20);
    lat += (r & 1) ? ~(r >> 1) : (r >> 1);
    r = 0; s = 0;
    do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << s; s += 5; } while (b >= 0x20);
    lng += (r & 1) ? ~(r >> 1) : (r >> 1);
    pts.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return pts;
}

// ── Yard algorithm ──────────────────────────────────────────────────────────
//
// A tile belongs to the Yard iff ALL 4 cardinal neighbours are also visited.
// The Yard is the LARGEST connected component of such "complete" tiles.

function computeYard(tileRows) {
  if (!tileRows.length) return { size: 0, tiles: [] };

  // Encode tile coords as a single number: key = (tx - minX) * STRIDE + (ty - minY)
  // STRIDE > height of bbox so neighbour offsets ±1 never wrap across columns.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const r of tileRows) {
    if (r.tx < minX) minX = r.tx; if (r.tx > maxX) maxX = r.tx;
    if (r.ty < minY) minY = r.ty; if (r.ty > maxY) maxY = r.ty;
  }
  const STRIDE = maxY - minY + 2; // +2 prevents column wrap-around
  const enc = (tx, ty) => (tx - minX) * STRIDE + (ty - minY);
  const decX = k => Math.floor(k / STRIDE) + minX;
  const decY = k => (k % STRIDE) + minY;

  const owned = new Set();
  for (const r of tileRows) owned.add(enc(r.tx, r.ty));

  // Complete tiles: all 4 cardinal neighbours present
  const complete = new Set();
  for (const k of owned) {
    if (owned.has(k - STRIDE) && owned.has(k + STRIDE) && owned.has(k - 1) && owned.has(k + 1))
      complete.add(k);
  }
  if (!complete.size) return { size: 0, tiles: [] };

  // BFS connected components on integer keys
  const visited = new Set();
  let best = [];
  for (const start of complete) {
    if (visited.has(start)) continue;
    const comp = [];
    const queue = [start];
    visited.add(start);
    while (queue.length) {
      const k = queue.pop();
      comp.push(k);
      for (const nk of [k - STRIDE, k + STRIDE, k - 1, k + 1]) {
        if (!visited.has(nk) && complete.has(nk)) { visited.add(nk); queue.push(nk); }
      }
    }
    if (comp.length > best.length) best = comp;
  }

  return {
    size:  best.length,
    tiles: best.map(k => ({ tx: decX(k), ty: decY(k) })),
  };
}

// ── Übersquadrat algorithm ──────────────────────────────────────────────────
//
// Largest axis-aligned square sub-grid fully filled with visited tiles.
// Sparse DP: process tiles sorted in row-major order. For each tile (tx,ty),
// dp = min(dp[tx-1,ty], dp[tx,ty-1], dp[tx-1,ty-1]) + 1.
// O(N log N) time, O(N) space — correct for any geographic spread.

function computeUber(tileRows) {
  if (!tileRows.length) return { size: 0, tiles: [] };

  // Sort row-major so each tile's three DP predecessors are already computed
  const sorted = tileRows.slice().sort((a, b) => a.ty !== b.ty ? a.ty - b.ty : a.tx - b.tx);

  // Encode (tx,ty) as a single safe integer — zoom ≤17 so tx,ty < 2^17 = 131072
  const STRIDE = 200000;
  const key = (tx, ty) => ty * STRIDE + tx;

  const dp = new Map();
  let bestSide = 0, bestX = 0, bestY = 0;

  for (const { tx, ty } of sorted) {
    const v = Math.min(
      dp.get(key(tx - 1, ty))     || 0,
      dp.get(key(tx,     ty - 1)) || 0,
      dp.get(key(tx - 1, ty - 1)) || 0
    ) + 1;
    dp.set(key(tx, ty), v);
    if (v > bestSide) { bestSide = v; bestX = tx; bestY = ty; }
  }

  if (!bestSide) return { size: 0, tiles: [] };

  const x0 = bestX - bestSide + 1;
  const y0 = bestY - bestSide + 1;
  const tiles = [];
  for (let dy = 0; dy < bestSide; dy++)
    for (let dx = 0; dx < bestSide; dx++)
      tiles.push({ tx: x0 + dx, ty: y0 + dy });

  return { size: bestSide, tiles };
}

// ── Route-planning helpers ──────────────────────────────────────────────────

// ── Detour helpers ─────────────────────────────────────────────────────────

// Spiral (Chebyshev) outward from a lat/lng point until an unowned, unused tile
// is found.  Returns { x, y, key } or null.
function nearestUnownedTileFrom(lat, lng, z, ownedSet, usedSet, maxRadius) {
  const { x: ox, y: oy } = latLngToTile(lat, lng, z);
  for (let r = 0; r <= maxRadius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.abs(dx) < r && Math.abs(dy) < r) continue; // skip inner ring
        const key = `${ox + dx},${oy + dy}`;
        if (!ownedSet.has(key) && !usedSet.has(key))
          return { x: ox + dx, y: oy + dy, key };
      }
    }
  }
  return null;
}

// Count unowned tiles in a (2r+1)² neighbourhood — proxy for "unexplored richness".
function countNewTilesNear(tx, ty, ownedSet, r = 2) {
  let n = 0;
  for (let dx = -r; dx <= r; dx++)
    for (let dy = -r; dy <= r; dy++)
      if (!ownedSet.has(`${tx + dx},${ty + dy}`)) n++;
  return n;
}

/**
 * Given a list of waypoints and owned tile sets, insert intermediate detour
 * points toward unvisited tiles (for OSRM routing request).
 */
function estimateRouteDistanceKm(points) {
  let dist = 0;
  for (let i = 1; i < points.length; i++) {
    dist += haversineDistance(points[i - 1], points[i]);
  }
  return dist;
}

function buildDetourWaypoints(waypoints, ownedSQ, ownedSQI, mode, targetKm = 0) {
  if (mode === 'shortest') return waypoints;
  const ownedSet = mode === 'sqi' ? ownedSQI : ownedSQ;
  const z        = mode === 'sqi' ? Z_SQI : Z_SQ;
  const baseFactor = mode === 'yard' ? 0.16 : 0.22;
  const route     = [waypoints[0]];
  const routeKm   = estimateRouteDistanceKm(waypoints);
  const target    = targetKm > 0 ? Math.max(routeKm, targetKm) : routeKm;
  if (targetKm > 0 && target <= routeKm * 1.05) return waypoints;

  const extraNeeded = Math.max(0, target - routeKm);
  const desiredDetours = Math.max(4, Math.min(24, 4 + Math.round(extraNeeded / Math.max(routeKm, 1) * 5)));
  // factor calibrated so total added haversine distance ≈ extraNeeded:
  //   extra ≈ 2 * factor * desiredDetours * routeKm  (alternating zigzag)
  const rawFactor = extraNeeded > 0
    ? extraNeeded / (2 * desiredDetours * Math.max(routeKm, 1))
    : baseFactor;
  const factor = Math.max(0.04, Math.min(0.55, rawFactor));
  const used = new Set();
  const segments = Math.max(1, waypoints.length - 1);
  const perSegment = Math.max(1, Math.ceil(desiredDetours / segments));

  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i], b = waypoints[i + 1];
    const dlat = b.lat - a.lat, dlng = b.lng - a.lng;
    const segDist = Math.sqrt(dlat * dlat + dlng * dlng);
    const count = Math.max(1, Math.min(perSegment, desiredDetours - used.size));

    // maxRadius: how many tiles to spiral outward when the target offset is owned.
    // Scales with factor so tight routes don't stray too far.
    const maxRadius = Math.max(2, Math.min(5, Math.round(factor * 50)));

    for (let t = 1; t <= count && used.size < desiredDetours; t++) {
      const f  = t / (count + 1);
      const ml = a.lat + dlat * f, mg = a.lng + dlng * f;

      // Try multiple perpendicular scales on both sides; for each, spiral to the
      // nearest unowned tile.  Pick the candidate surrounded by the most new tiles
      // (highest "unexplored richness") so the route heads into fresh territory.
      let best = null, bestScore = -1;
      for (const scale of [1, 0.6, 1.6, 0.3, 2.2]) {
        for (const sign of [1, -1]) {
          const offLat = ml + sign * dlng * factor * scale;
          const offLng = mg - sign * dlat * factor * scale;
          const found = nearestUnownedTileFrom(offLat, offLng, z, ownedSet, used, maxRadius);
          if (!found) continue;
          const score = countNewTilesNear(found.x, found.y, ownedSet);
          if (score > bestScore) { bestScore = score; best = found; }
        }
      }

      if (best) {
        used.add(best.key);
        route.push(tileCenter(best.x, best.y, z));
      }
    }

    route.push(b);
  }

  return route;
}

// ── Kwadratownia: greedy nearest-unvisited-SQI algorithm ─────────────────────
//
// Phase 1 (outbound): from start, repeatedly route to the nearest unvisited SQI
// tile until cumulative haversine distance ≥ targetKm/2.
// Phase 2 (return): from the turnaround point, greedily visit nearest unvisited
// tiles whose direction has a positive dot-product with the home vector (i.e.
// closer to start). Stop when within 1.5 km of start or waypoint cap is reached.
// Last 1-2 km approaching home may share roads — expected and acceptable.

function buildKwadratowniaWaypoints(start, targetKm, sqiRows) {
  const ownedSet = new Set(sqiRows.map(r => `${r.tx},${r.ty}`));

  // Bounding box of candidate unvisited tiles around start
  const { x: sTx, y: sTy } = latLngToTile(start.lat, start.lng, Z_SQI);
  const degPerTile = 360 / (1 << Z_SQI);
  const kmPerTileLat = degPerTile * 111;
  const kmPerTileLng = degPerTile * 111 * Math.cos(toRad(start.lat));
  const searchKm = targetKm * 0.65;
  const radX = Math.ceil(searchKm / kmPerTileLng);
  const radY = Math.ceil(searchKm / kmPerTileLat);

  // Use one tileNW call + linear offsets (fast, error < 0.5% over 30 km)
  const nw0 = tileNW(sTx, sTy, Z_SQI);
  const nw1 = tileNW(sTx + 1, sTy + 1, Z_SQI);
  const dLat = nw0.lat - nw1.lat; // positive: tile y increases southward

  const candidates = [];
  for (let dy = -radY; dy <= radY; dy++) {
    const lat = nw0.lat - (dy + 0.5) * dLat;
    for (let dx = -radX; dx <= radX; dx++) {
      const tx = sTx + dx, ty = sTy + dy;
      const key = `${tx},${ty}`;
      if (!ownedSet.has(key)) {
        const lng = nw0.lng + (dx + 0.5) * degPerTile;
        candidates.push({ lat, lng, key });
      }
    }
  }
  if (!candidates.length) return [start, start];

  const visited = new Set();
  const waypoints  = [start];
  let cur  = { lat: start.lat, lng: start.lng };
  let cumKm = 0;
  const halfKm = targetKm / 2;
  const MAX_PER_PHASE = 20;

  function nearestUnvisited(from, dirDx, dirDy) {
    let best = null, bestSd = Infinity;
    for (const c of candidates) {
      if (visited.has(c.key)) continue;
      const dx = c.lng - from.lng, dy = c.lat - from.lat;
      // direction filter: dot product must be positive (toward home) when provided
      if (dirDx !== null && dx * dirDx + dy * dirDy <= 0) continue;
      const sd = dx * dx + dy * dy;
      if (sd < bestSd) { bestSd = sd; best = c; }
    }
    return best;
  }

  // Phase 1: outbound
  for (let i = 0; i < MAX_PER_PHASE; i++) {
    const best = nearestUnvisited(cur, null, null);
    if (!best) break;
    const d = haversineDistance(cur, best);
    if (cumKm + d > halfKm) break;
    visited.add(best.key);
    waypoints.push({ lat: best.lat, lng: best.lng });
    cumKm += d;
    cur = best;
  }

  // Phase 2: return toward start
  for (let i = 0; i < MAX_PER_PHASE; i++) {
    if (haversineDistance(cur, start) < 1.5) break;
    const hx = start.lng - cur.lng, hy = start.lat - cur.lat;
    const best = nearestUnvisited(cur, hx, hy);
    if (!best) break;
    const d = haversineDistance(cur, best);
    visited.add(best.key);
    waypoints.push({ lat: best.lat, lng: best.lng });
    cumKm += d;
    cur = best;
  }

  waypoints.push(start);
  return waypoints;
}

module.exports = {
  Z_SQ, Z_SQI,
  latLngToTile, tileNW, tileBounds,
  tileCenter, destinationPoint, haversineDistance, createLoopWaypoints,
  tilesOnSegment, trackToTiles,
  decodePolyline,
  computeYard, computeUber,
  buildDetourWaypoints,
  buildKwadratowniaWaypoints,
};
