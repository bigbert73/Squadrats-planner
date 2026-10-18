/**
 * planner.js — loop planning that maximises new tiles without riding the same
 * road twice.
 *
 * Candidates come in two shapes:
 *  - compact ellipses through the start, in 16 directions × 3 widths, with
 *    ring points nudged onto nearby rich unowned tiles;
 *  - "petals" that reach out to the richest target clusters (straight out, or
 *    via a side point on either flank) — they get much farther from home for
 *    the same distance, which is where unexplored tiles usually are.
 * Every loop is routed in two halves and the second half avoids the first
 * half's roads (weighted BRouter no-go polyline), so the way back is different.
 * Candidates are pre-ranked on their straight-line polygon, the best are
 * routed and scored on what the routed track actually collects, its length
 * fit and how much of it repeats itself; a short local search (rotations,
 * widths, side points, length rescaling) refines the leaders.
 */

const tiles = require('./tiles');
const routing = require('./routing');
const popular = require('./popular');

const ROAD_FACTOR = 1.35;    // routed km / ellipse perimeter, measured on loops around Warsaw
const RING_POINTS = 6;
const LEN_TOLERANCE = 0.10;
const CONCURRENCY = 8;
// Loop shapes: ellipse minor/major ratio. 1 = circle (compact, stays near
// home); narrow ones reach ~2× farther out and come back on a parallel road.
const ASPECTS = [1, 0.6, 0.35];
const DIRECTIONS = 16;
const ROUTED_CANDIDATES = 16;
// Optional refinement rounds are skipped once planning has taken this long
// (dense city streets make every BRouter call slower).
const SOFT_BUDGET_MS = 9000;
const SEARCH_START_BUDGET_MS = 6000;
// A petal loop's farthest point sits at ≈ this × its routed length.
const PETAL_REACH = 0.36;

// ── geometry ────────────────────────────────────────────────────────────────

const coordsOf = (data) => data.routes[0].geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));

// Resample the track every ~20 m and flag samples that lie within 20 m of a
// part of the track more than ~160 m away along it — the same road ridden
// twice: out-and-back legs, but also short dead-end jabs into a waypoint
// (a 1 km threshold used to hide those).
function reuseAnalysis(coords) {
  const STEP_KM = 0.02, GAP = 8, NEAR_KM = 0.02;
  const pts = [];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    const n = Math.max(1, Math.ceil(tiles.haversineDistance(a, b) / STEP_KM));
    for (let k = 0; k < n; k++) pts.push({ lat: a.lat + (b.lat - a.lat) * k / n, lng: a.lng + (b.lng - a.lng) * k / n });
  }
  if (coords.length) pts.push(coords[coords.length - 1]);
  const cell = 0.0004, grid = new Map();
  const cellOf = (p) => [Math.floor(p.lat / cell), Math.floor(p.lng / cell)];
  pts.forEach((p, i) => {
    const k = cellOf(p).join(',');
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  const flags = new Uint8Array(pts.length);
  let reused = 0;
  pts.forEach((p, i) => {
    const [cy, cx] = cellOf(p);
    for (let dy = -1; dy <= 1 && !flags[i]; dy++) for (let dx = -1; dx <= 1 && !flags[i]; dx++) {
      for (const j of grid.get(`${cy + dy},${cx + dx}`) || []) {
        if (Math.abs(i - j) > GAP && tiles.haversineDistance(p, pts[j]) < NEAR_KM) { flags[i] = 1; break; }
      }
    }
    reused += flags[i];
  });
  return { fraction: pts.length ? reused / pts.length : 0, pts, flags };
}

// ── objective ───────────────────────────────────────────────────────────────

function buildContext({ mode, sqRows, sqiRows, yard, yardi, blockedSQI }) {
  const ownedSQ  = new Set(sqRows.map(r => `${r.tx},${r.ty}`));
  const ownedSQI = new Set(sqiRows.map(r => `${r.tx},${r.ty}`));
  // Squadratinhos marked as impossible to collect: never a target, never
  // counted as collected by a route.
  const blocked = new Set((blockedSQI || []).map(r => `${r.tx},${r.ty}`));
  const takenSQI = blocked.size ? new Set([...ownedSQI, ...blocked]) : ownedSQI;
  const ctx = { mode, sqRows, sqiRows, ownedSQ, ownedSQI, takenSQI, yardBefore: yard?.size || 0, yardiBefore: yardi?.size || 0 };

  // Unowned tiles within 2 of the Yard(inho): visiting them is what can turn
  // owned border tiles "complete" and grow it.
  const nearYard = (yardTiles, owned) => {
    const near = new Set();
    for (const t of yardTiles || []) {
      for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
        const k = `${t.tx + dx},${t.ty + dy}`;
        if (!owned.has(k)) near.add(k);
      }
    }
    ctx.targets = near;
    ctx.isTarget = (k) => near.has(k);
    ctx.valueOf = (x, y) => {
      let n = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (near.has(`${x + dx},${y + dy}`)) n++;
      return n;
    };
  };

  if (mode === 'sqi') {
    ctx.z = tiles.Z_SQI;
    ctx.isTarget = (k) => !takenSQI.has(k);
    ctx.valueOf = (x, y) => tiles.countNewTilesNear(x, y, takenSQI, 3);
  } else if (mode === 'sq') {
    ctx.z = tiles.Z_SQ;
    ctx.isTarget = (k) => !ownedSQ.has(k);
    ctx.valueOf = (x, y) => 1 + tiles.countNewTilesNear(x, y, ownedSQ, 1);
  } else if (mode === 'yard') {
    ctx.z = tiles.Z_SQ;
    nearYard(yard?.tiles, ownedSQ);
  } else if (mode === 'yardi') {
    ctx.z = tiles.Z_SQI;
    nearYard(yardi?.tiles, takenSQI);
  } else {
    // 'shortest': no tile objective, just a clean loop; 'popular': no tile
    // objective either, the track is scored on how popular its roads are
    ctx.z = null;
  }
  return ctx;
}

async function evaluate(data, ctx, targetKm) {
  const coords = coordsOf(data);
  const pop = ctx.mode === 'popular' ? await popular.popularity(coords) : null;
  const km = routing.routeDistanceKm(data);
  const { sq14, sq17 } = tiles.trackToTiles(coords);
  let newSQ = 0, newSQI = 0;
  const newSQKeys = [], newSQIKeys = [];
  for (const k of sq14) if (!ctx.ownedSQ.has(k)) { newSQ++; newSQKeys.push(k); }
  for (const k of sq17) if (!ctx.takenSQI.has(k)) { newSQI++; newSQIKeys.push(k); }

  const toRows = (keys) => keys.map(k => { const [tx, ty] = k.split(',').map(Number); return { tx, ty }; });
  let yardGain = 0;
  if (ctx.mode === 'yard' && newSQKeys.length) {
    yardGain = tiles.computeYard(ctx.sqRows.concat(toRows(newSQKeys))).size - ctx.yardBefore;
  } else if (ctx.mode === 'yardi' && newSQIKeys.length) {
    yardGain = tiles.computeYard(ctx.sqiRows.concat(toRows(newSQIKeys))).size - ctx.yardiBefore;
  }

  const value =
    ctx.mode === 'sqi'  ? newSQI + 20 * newSQ :
    ctx.mode === 'sq'   ? 100 * newSQ + 0.5 * newSQI :
    ctx.mode === 'yard' ? 100 * yardGain + 20 * newSQ + 0.2 * newSQI :
    ctx.mode === 'yardi' ? 10 * yardGain + newSQI + 20 * newSQ :
    ctx.mode === 'popular' ? 100 * pop.share :
    10;
  const reuse = reuseAnalysis(coords);
  const dev = Math.abs(km - targetKm) / targetKm;
  const lenFactor = dev <= LEN_TOLERANCE ? 1 : Math.max(0.02, 1 - 5 * (dev - LEN_TOLERANCE));
  // Riding the same road twice is something the rider actively dislikes:
  // 8% repeated road costs about half the score.
  const reuseFactor = Math.max(0.05, 1 - 6 * reuse.fraction);
  return { km, newSQ, newSQI, yardGain, pop, value, reuse, score: (value + 1) * lenFactor * reuseFactor };
}

// ── candidate geometry ──────────────────────────────────────────────────────

function tileKm(z, lat) { return 40075 * Math.cos(lat * Math.PI / 180) / (1 << z); }

// Best target tile within snapKm of p (value discounted by distance), or null.
function snapToTarget(p, ctx, snapKm) {
  const { x: cx, y: cy } = tiles.latLngToTile(p.lat, p.lng, ctx.z);
  const rad = Math.ceil(snapKm / tileKm(ctx.z, p.lat)) + 1;
  let best = null, bestV = 0;
  for (let dx = -rad; dx <= rad; dx++) for (let dy = -rad; dy <= rad; dy++) {
    const x = cx + dx, y = cy + dy;
    if (!ctx.isTarget(`${x},${y}`)) continue;
    const c = tiles.tileCenter(x, y, ctx.z);
    const d = tiles.haversineDistance(p, c);
    if (d > snapKm) continue;
    const v = ctx.valueOf(x, y) * (1 - 0.5 * d / snapKm);
    if (v > bestV) { bestV = v; best = c; }
  }
  return best;
}

// Ellipse perimeter (Ramanujan) and the semi-major axis for a given one.
function perimeter(a, k) {
  const b = a * k;
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}
function semiMajor(perimeterKm, k) { return perimeterKm / perimeter(1, k); }

// Compact loop: ellipse through `start` (one end of its major axis), major
// axis along bearing `dir`, perimeter ≈ km of road; ring points nudged onto
// nearby target tiles, kept small relative to the loop's width so the shape
// (and its separate way back) survives.
function ellipseLoop(start, dir, km, k, ctx) {
  const a = semiMajor(km / ROAD_FACTOR, k), b = a * k;
  const centre = tiles.destinationPoint(start.lat, start.lng, dir, a);
  const ring = [];
  for (let i = 1; i <= RING_POINTS; i++) {
    const t = Math.PI + i * 2 * Math.PI / (RING_POINTS + 1);
    const x = a * Math.cos(t), y = b * Math.sin(t);
    const brg = (dir + Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    let p = tiles.destinationPoint(centre.lat, centre.lng, brg, Math.hypot(x, y));
    if (ctx.z !== null) p = snapToTarget(p, ctx, Math.max(0.5, 0.3 * b + 0.08 * a)) || p;
    ring.push(p);
  }
  return [start, ...ring, start];
}

// Reaching loop: out to a far point T (optionally via a side point W) and back
// on other roads — the return leg avoids the outbound one. Reaches much
// farther than an ellipse of the same length, which is where unexplored tiles
// usually are. `km` rescales the reach (T slides along its bearing).
function petalLoop(start, sh, km, ctx) {
  const s = km / sh.baseKm;
  const pick = (p, snapKm) => (ctx.z !== null && snapToTarget(p, ctx, snapKm)) || p;
  const T = s === 1 && sh.T ? sh.T : pick(tiles.destinationPoint(start.lat, start.lng, sh.dir, sh.d * s), 1.2);
  if (!sh.side) return [start, T, start];
  const W = pick(tiles.destinationPoint(start.lat, start.lng, (sh.dir + sh.side + 360) % 360, sh.d * s * 0.55),
                 Math.max(0.8, sh.d * 0.12));
  return [start, W, T, start];
}

const loopPts = (start, sh, km, ctx) =>
  sh.kind === 'ellipse' ? ellipseLoop(start, sh.dir, km, sh.k, ctx) : petalLoop(start, sh, km, ctx);

// Cheap pre-score: tile objective along the straight-line polygon.
function proxyScore(pts, ctx) {
  if (ctx.z === null) return 0;
  const { sq14, sq17 } = tiles.trackToTiles(pts);
  let v = 0;
  for (const k of (ctx.z === tiles.Z_SQI ? sq17 : sq14)) if (ctx.isTarget(k)) v++;
  return v;
}

// Target clusters within reach, richest first, spread out in distance and
// bearing so candidates explore different areas. Rated on SQ-sized blocks:
// for SQI/Yardinho by target squadratinhos in the block's 3×3 neighbourhood
// (big unexplored areas beat lone blocks; SQI also gets a bonus for a block
// that is itself an unowned SQ); for SQ/Yard by the target tiles themselves.
function targetClusters(start, minKm, maxKm, ctx, max = 6) {
  if (ctx.z === null) return [];
  const sqiMode = ctx.z === tiles.Z_SQI;
  const z = tiles.Z_SQ;
  const { x: cx, y: cy } = tiles.latLngToTile(start.lat, start.lng, z);
  const rad = Math.ceil(maxKm / tileKm(z, start.lat)) + 2;
  const blockFree = new Map();
  if (sqiMode) {
    for (let dx = -rad; dx <= rad; dx++) for (let dy = -rad; dy <= rad; dy++) {
      const x = cx + dx, y = cy + dy;
      let v = 0;
      for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) if (ctx.isTarget(`${x * 8 + i},${y * 8 + j}`)) v++;
      blockFree.set(`${x},${y}`, v);
    }
  }
  const found = [];
  for (let dx = -rad + 1; dx < rad; dx++) for (let dy = -rad + 1; dy < rad; dy++) {
    const x = cx + dx, y = cy + dy;
    let v;
    if (sqiMode) {
      if (blockFree.get(`${x},${y}`) < (ctx.mode === 'sqi' ? 24 : 1)) continue;
      v = 0;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) v += blockFree.get(`${x + i},${y + j}`) || 0;
      if (ctx.mode === 'sqi' && !ctx.ownedSQ.has(`${x},${y}`)) v += 200;
    } else {
      if (!ctx.isTarget(`${x},${y}`)) continue;
      v = ctx.valueOf(x, y);
    }
    const c = tiles.tileCenter(x, y, z);
    const d = tiles.haversineDistance(start, c);
    if (d <= maxKm && d >= minKm) found.push({ ...c, d, v, brg: bearing(start, c) });
  }
  found.sort((a, b) => b.v - a.v || a.d - b.d);
  const out = [];
  for (const f of found) {
    if (out.some(o => tiles.haversineDistance(o, f) < 3 ||
        (Math.abs(((o.brg - f.brg + 540) % 360) - 180) < 15 && f.d / o.d > 0.7 && f.d / o.d < 1.4))) continue;
    out.push(f);
    if (out.length >= max) break;
  }
  return out;
}

function nearestTargetKm(start, ctx, limitKm = 80) {
  if (ctx.targets) {
    let best = Infinity;
    for (const k of ctx.targets) {
      const [x, y] = k.split(',').map(Number);
      best = Math.min(best, tiles.haversineDistance(start, tiles.tileCenter(x, y, ctx.z)));
    }
    return best <= limitKm ? best : Infinity;
  }
  const { x: cx, y: cy } = tiles.latLngToTile(start.lat, start.lng, ctx.z);
  const rad = Math.ceil(limitKm / tileKm(ctx.z, start.lat));
  let best = Infinity;
  for (let dx = -rad; dx <= rad; dx++) for (let dy = -rad; dy <= rad; dy++) {
    if (!ctx.isTarget(`${cx + dx},${cy + dy}`)) continue;
    best = Math.min(best, tiles.haversineDistance(start, tiles.tileCenter(cx + dx, cy + dy, ctx.z)));
  }
  return best;
}

// ── routing ─────────────────────────────────────────────────────────────────

// Route a closed loop [start, …, start] in two halves; the second half avoids
// the first half's roads.
async function routeLoopHalves(pts, profile, timeoutMs = 90000) {
  const mid = pts.length < 4 ? 1 : Math.ceil((pts.length - 1) / 2);
  const out = await routing.fetchBRouterRoute(pts.slice(0, mid + 1), profile, 0, null, timeoutMs);
  const back = await routing.fetchBRouterRoute(pts.slice(mid), profile, 0, coordsOf(out), timeoutMs);
  return routing.mergeLegs([out, back]);
}
// Exploring candidates: a leg that BRouter can't find within this long is
// dropped rather than waited for (it's one of dozens of options).
const CANDIDATE_LEG_TIMEOUT_MS = 6000;
const routeCandidate = (pts, profile) => routeLoopHalves(pts, profile, CANDIDATE_LEG_TIMEOUT_MS);

async function mapLimit(items, limit, fn) {
  const res = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { res[i] = await fn(items[i], i); } catch (e) { res[i] = null; }
    }
  }));
  return res;
}

// ── entry point ─────────────────────────────────────────────────────────────

class PlannerError extends Error {}

async function planLoop({ start, targetKm, mode, bikeProfile, sqRows, sqiRows, yard, yardi, blockedSQI }) {
  const t0 = Date.now(), overBudget = () => Date.now() - t0 > SOFT_BUDGET_MS;
  const profile = routing.brouterProfile(bikeProfile);
  const ctx = buildContext({ mode, sqRows, sqiRows, yard, yardi, blockedSQI });
  const target = Math.max(5, targetKm || 15);
  const reach = PETAL_REACH * target * (1 + LEN_TOLERANCE);

  if (ctx.mode === 'sq' || ctx.mode === 'yard' || ctx.mode === 'yardi') {
    const nearest = nearestTargetKm(start, ctx);
    if (nearest > reach) {
      const what = { sq: 'nowych SQ', yard: 'kwadratów powiększających Yard', yardi: 'kwadratów powiększających Yardinho' }[ctx.mode];
      if (!isFinite(nearest)) throw new PlannerError(`Brak ${what} w promieniu 80 km`);
      const minKm = Math.ceil(nearest / (PETAL_REACH * (1 + LEN_TOLERANCE)) / 5) * 5;
      throw new PlannerError(`Brak ${what} w zasięgu ${Math.round(target)} km — najbliższe ~${nearest.toFixed(0)} km stąd, ustaw pętlę ≥ ${minKm} km`);
    }
  }

  // Candidates: compact ellipses in every direction × aspect, and reaching
  // loops ("petals") toward the richest target clusters, each plain or with a
  // side point on either flank. Pre-score each pool on its straight-line
  // polygon and route only the most promising (routing is the expensive part).
  const ellipses = [], petals = [];
  for (let i = 0; i < DIRECTIONS; i++) {
    for (const k of ASPECTS) ellipses.push({ kind: 'ellipse', dir: i * 360 / DIRECTIONS, k });
  }
  for (const c of targetClusters(start, reach * 0.4, reach, ctx)) {
    for (const side of [0, 35, -35]) {
      petals.push({ kind: 'petal', dir: bearing(start, c), d: c.d, T: { lat: c.lat, lng: c.lng }, side, baseKm: target });
    }
  }
  for (const sh of [...ellipses, ...petals]) {
    sh.pts = loopPts(start, sh, target, ctx);
    sh.proxy = proxyScore(sh.pts, ctx);
  }
  const byProxy = (x, y) => y.proxy - x.proxy;
  const picked = petals.sort(byProxy).slice(0, ROUTED_CANDIDATES / 2);
  for (const sh of ellipses.sort(byProxy)) {
    if (picked.length >= ROUTED_CANDIDATES) break;
    if (picked.some(p => p.k === sh.k && Math.abs(((p.dir - sh.dir + 540) % 360) - 180) < 30)) continue;
    picked.push(sh);
  }

  const tryLoop = async (sh, km) => {
    const pts = km === target ? sh.pts : loopPts(start, sh, km, ctx);
    const data = await routeCandidate(pts, profile);
    return { sh, km, pts, data, ev: await evaluate(data, ctx, target) };
  };

  let results = (await mapLimit(picked, CONCURRENCY, (sh) => tryLoop(sh, target))).filter(Boolean);
  if (!results.length) throw new Error('Nie udało się wyznaczyć żadnej pętli (BRouter)');

  // Local search: real roads make the shape → result mapping noisy, so take
  // the best few and try neighbouring shapes (rotated, wider/narrower or a
  // different side point), each already rescaled by its parent's observed
  // road distance so length converges at the same time.
  const variants = (x, step) => {
    const sh = x.sh, km = x.km * Math.max(0.6, Math.min(1.5, target / x.ev.km));
    const out = [{ sh, km }];
    for (const dd of [-step, step]) out.push({ sh: { ...sh, dir: (sh.dir + dd + 360) % 360, T: null }, km });
    if (sh.kind === 'ellipse') {
      for (const f of [0.7, 1.4]) out.push({ sh: { ...sh, k: Math.min(1, Math.max(0.2, sh.k * f)) }, km });
    } else {
      for (const ds of [-step * 1.5, step * 1.5]) out.push({ sh: { ...sh, side: sh.side + ds, T: null }, km });
    }
    return out;
  };
  for (const [n, step] of [[4, 12], [2, 6]]) {
    if (Date.now() - t0 > (step === 12 ? SEARCH_START_BUDGET_MS : SOFT_BUDGET_MS)) break;
    results.sort((x, y) => y.ev.score - x.ev.score);
    const next = results.slice(0, n).flatMap(x => variants(x, step));
    results = results.concat((await mapLimit(next, CONCURRENCY, (v) => tryLoop(v.sh, v.km))).filter(Boolean));
  }
  results.sort((x, y) => y.ev.score - x.ev.score);
  // Still out of tolerance (some profiles run much longer than the shape
  // predicts): rescale the leaders once more, gently and aggressively.
  const off = (x) => Math.abs(x.ev.km - target) / target > LEN_TOLERANCE;
  if (off(results[0])) {
    const next = results.slice(0, 3).flatMap(x => {
      const f = target / x.ev.km;
      return [f, f * f].map(g => ({ sh: x.sh, km: x.km * Math.max(0.4, Math.min(1.8, g)) }));
    });
    results = results.concat((await mapLimit(next, CONCURRENCY, (v) => tryLoop(v.sh, v.km))).filter(Boolean));
    results.sort((x, y) => y.ev.score - x.ev.score);
  }

  // Prefer anything within the length tolerance; only fall back to an
  // over/under-length loop when nothing fits.
  let best = results.find(x => !off(x)) || results[0];

  // Second pass: a waypoint is redundant if the loop collects (almost) the
  // same without it — typically a jab into a tile the route covers anyway
  // elsewhere. Try dropping each one; keep the best drop that loses <2% of
  // the value while being shorter or repeating less road, or that simply
  // scores better (less same-road riding outweighs a few tiles). Two rounds.
  for (let round = 0; round < 2 && best.pts.length > 3 && !(round && overBudget()); round++) {
    const idx = best.pts.map((_, i) => i).slice(1, -1);
    const trials = (await mapLimit(idx, CONCURRENCY, async (i) => {
      const pts = best.pts.filter((_, j) => j !== i);
      const data = await routeCandidate(pts, profile);
      return { ...best, pts, data, ev: await evaluate(data, ctx, target) };
    })).filter(Boolean).filter(t =>
      (!off(t) || off(best)) && (
        t.ev.score > best.ev.score ||
        (t.ev.value >= best.ev.value * 0.98 &&
         (t.ev.km < best.ev.km - 0.2 || t.ev.reuse.fraction < best.ev.reuse.fraction - 0.002))));
    if (!trials.length) break;
    trials.sort((x, y) => y.ev.score - x.ev.score);
    best = trials[0];
  }

  const out = best.data;
  out.routes[0].reuse = best.ev.reuse.fraction;
  out.planner = {
    candidates: results.length,
    newSQ: best.ev.newSQ, newSQI: best.ev.newSQI, yardGain: best.ev.yardGain,
    reuse: best.ev.reuse.fraction,
    popular: best.ev.pop,
    waypoints: best.pts.map(p => ({ lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6) })),
  };
  return out;
}

function bearing(from, to) {
  const r = Math.PI / 180;
  const y = Math.sin((to.lng - from.lng) * r) * Math.cos(to.lat * r);
  const x = Math.cos(from.lat * r) * Math.sin(to.lat * r) - Math.sin(from.lat * r) * Math.cos(to.lat * r) * Math.cos((to.lng - from.lng) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

module.exports = { planLoop, routeLoopHalves, reuseAnalysis, evaluate, buildContext, PlannerError };
