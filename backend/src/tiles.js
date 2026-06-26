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
  // Build a Set of "x,y" keys
  const owned = new Set(tileRows.map(r => `${r.tx},${r.ty}`));

  // Find tiles with all 4 neighbours
  const complete = new Set();
  for (const key of owned) {
    const [x, y] = key.split(',').map(Number);
    if (owned.has(`${x},${y-1}`) && owned.has(`${x},${y+1}`) &&
        owned.has(`${x-1},${y}`) && owned.has(`${x+1},${y}`)) {
      complete.add(key);
    }
  }
  if (!complete.size) return { size: 0, tiles: [] };

  // BFS connected components
  const visited = new Set();
  let best = [];

  for (const start of complete) {
    if (visited.has(start)) continue;
    const comp = [];
    const queue = [start];
    while (queue.length) {
      const k = queue.shift();
      if (visited.has(k) || !complete.has(k)) continue;
      visited.add(k); comp.push(k);
      const [x, y] = k.split(',').map(Number);
      for (const nk of [`${x},${y-1}`,`${x},${y+1}`,`${x-1},${y}`,`${x+1},${y}`]) {
        if (!visited.has(nk) && complete.has(nk)) queue.push(nk);
      }
    }
    if (comp.length > best.length) best = comp;
  }

  return {
    size:  best.length,
    tiles: best.map(k => { const [x,y]=k.split(',').map(Number); return {tx:x,ty:y}; }),
  };
}

// ── Übersquadrat algorithm ──────────────────────────────────────────────────
//
// Largest axis-aligned square sub-grid fully filled with visited tiles.
// Classic 2-D DP solution: O(W×H) time and space where W,H are bounding-box dims.
//
// For very sparse world-wide data the bounding box can be huge.
// We cap the DP at 4096×4096 tiles (safe — user's tiles cluster regionally).

function computeUber(tileRows) {
  if (!tileRows.length) return { size: 0, tiles: [] };

  // Build owned set + bounding box
  const owned = new Set(tileRows.map(r => `${r.tx},${r.ty}`));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const r of tileRows) {
    if (r.tx < minX) minX = r.tx; if (r.tx > maxX) maxX = r.tx;
    if (r.ty < minY) minY = r.ty; if (r.ty > maxY) maxY = r.ty;
  }

  const W = Math.min(maxX - minX + 1, 4096);
  const H = Math.min(maxY - minY + 1, 4096);

  // dp[row][col] = side of largest all-owned square with bottom-right here
  const dp = new Array(H + 1).fill(null).map(() => new Uint16Array(W + 1));
  let bestSide = 0, bestCol = 0, bestRow = 0;

  for (let row = 1; row <= H; row++) {
    for (let col = 1; col <= W; col++) {
      if (owned.has(`${minX+col-1},${minY+row-1}`)) {
        dp[row][col] = Math.min(dp[row-1][col], dp[row][col-1], dp[row-1][col-1]) + 1;
        if (dp[row][col] > bestSide) {
          bestSide = dp[row][col];
          bestCol  = col;
          bestRow  = row;
        }
      }
    }
  }

  if (!bestSide) return { size: 0, tiles: [] };

  const x0 = minX + bestCol - bestSide;
  const y0 = minY + bestRow - bestSide;
  const tiles = [];
  for (let dy = 0; dy < bestSide; dy++)
    for (let dx = 0; dx < bestSide; dx++)
      tiles.push({ tx: x0+dx, ty: y0+dy });

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

module.exports = {
  Z_SQ, Z_SQI,
  latLngToTile, tileNW, tileBounds,
  tileCenter, destinationPoint, haversineDistance, createLoopWaypoints,
  tilesOnSegment, trackToTiles,
  decodePolyline,
  computeYard, computeUber,
  buildDetourWaypoints,
};
