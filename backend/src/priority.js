/**
 * priority.js — which uncollected squadratinhos are worth riding to next.
 *
 * A tile earns points for what it does for the two "shape" goals:
 *  - Übersquadratinho: for every side k a bit larger than today's, the k×k
 *    windows (no tile marked impossible inside) missing the fewest tiles; each
 *    missing tile gets (k − current) / effort of the window, so the one tile
 *    that alone unlocks 27×27 scores far above one of the 26 that 32×32 needs;
 *  - Yardinho: how many tiles it turns "complete" (all 4 neighbours owned)
 *    next to the current Yardinho.
 * Points are then scaled down for tiles with no road in OSM (reach.db; often
 * fields, woods, fenced land — collectable on foot at best) and with distance
 * from home. Recomputed whenever the user's tiles change (part of the user
 * cache, which every sync and every blocked-tile toggle invalidates).
 */

const tiles = require('./tiles');
const reach = require('./reach');

const Z = tiles.Z_SQI;
const RADIUS_KM = 30;
const UBER_STEPS = 16;          // look at sides current+1 … current+16
const WINDOWS_PER_K = 3;        // best non-overlapping windows kept per side
const NOROAD_EFFORT = 3;        // a no-road tile costs like 3 with a road
const MAX_TILES = 800;

const ROAD_FACTOR = { 1: 1, 0: 0.35, '-1': 0.8 };
const distFactor = (km) => 1 / (1 + km / 15);

function tileKm(lat) { return 40075 * Math.cos(lat * Math.PI / 180) / (1 << Z); }

function computePriority({ sqiRows, blockedSQI, uberi, yardi, home }) {
  const ctr = tiles.latLngToTile(home.lat, home.lng, Z);
  const R = Math.ceil(RADIUS_KM / tileKm(home.lat));
  const x0 = ctr.x - R, y0 = ctr.y - R, W = 2 * R + 1;
  const inb = (x, y) => x >= x0 && x < x0 + W && y >= y0 && y < y0 + W;
  const idx = (x, y) => (y - y0) * W + (x - x0);

  const own = new Uint8Array(W * W), blk = new Uint8Array(W * W), noroad = new Uint8Array(W * W);
  const ownedKeys = new Set();
  for (const r of sqiRows) { ownedKeys.add(`${r.tx},${r.ty}`); if (inb(r.tx, r.ty)) own[idx(r.tx, r.ty)] = 1; }
  for (const r of blockedSQI) if (inb(r.tx, r.ty)) blk[idx(r.tx, r.ty)] = 1;
  const roadOf = new Map();
  const road = (x, y) => {
    const k = idx(x, y);
    if (!roadOf.has(k)) roadOf.set(k, reach.status(x, y));
    return roadOf.get(k);
  };
  if (reach.available()) {
    for (let y = y0; y < y0 + W; y++) for (let x = x0; x < x0 + W; x++) {
      const i = idx(x, y);
      if (!own[i] && !blk[i] && road(x, y) === 0) noroad[i] = 1;
    }
  }

  // 2D prefix sums for O(1) window counts
  const prefix = (a) => {
    const p = new Int32Array((W + 1) * (W + 1));
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++)
      p[(y + 1) * (W + 1) + x + 1] = a[y * W + x] + p[y * (W + 1) + x + 1] + p[(y + 1) * (W + 1) + x] - p[y * (W + 1) + x];
    return p;
  };
  const pOwn = prefix(own), pBlk = prefix(blk), pNr = prefix(noroad);
  const sum = (p, x, y, k) => p[(y + k) * (W + 1) + x + k] - p[y * (W + 1) + x + k] - p[(y + k) * (W + 1) + x] + p[y * (W + 1) + x];

  const score = new Map();   // idx → { u, uk, um, y }
  const entry = (i) => { let e = score.get(i); if (!e) { e = { u: 0, uk: 0, um: 0, y: 0 }; score.set(i, e); } return e; };

  // ── Übersquadratinho ──
  const cur = uberi?.size || 0;
  const windows = [];
  for (let k = cur + 1; k <= cur + UBER_STEPS && k < W; k++) {
    const cand = [];
    for (let y = 0; y + k <= W; y++) for (let x = 0; x + k <= W; x++) {
      if (sum(pBlk, x, y, k)) continue;
      const miss = k * k - sum(pOwn, x, y, k);
      if (miss > 4 * k) continue;               // hopelessly empty window
      const nr = sum(pNr, x, y, k);
      cand.push({ x, y, miss, nr, effort: miss + (NOROAD_EFFORT - 1) * nr });
    }
    cand.sort((a, b) => a.effort - b.effort);
    const kept = [];
    for (const c of cand) {
      if (kept.some(o => Math.abs(o.x - c.x) < k / 2 && Math.abs(o.y - c.y) < k / 2)) continue;
      kept.push(c);
      if (kept.length >= WINDOWS_PER_K) break;
    }
    for (const c of kept) {
      const gain = k - cur, val = gain / c.effort;
      windows.push({ k, x: c.x + x0, y: c.y + y0, miss: c.miss, noRoad: c.nr, gain, val: +val.toFixed(3) });
      for (let y = c.y; y < c.y + k; y++) for (let x = c.x; x < c.x + k; x++) {
        const i = y * W + x;
        if (own[i]) continue;
        const e = entry(i);
        if (val > e.u) { e.u = val; e.uk = k; e.um = c.miss; }
      }
    }
  }

  // ── Yardinho ──
  // A tile is complete when its 4 neighbours are owned. Collecting m can
  // complete m itself and its owned neighbours; count those touching the
  // current Yardinho (or each other, via m).
  const yardKeys = new Set((yardi?.tiles || []).map(t => `${t.tx},${t.ty}`));
  const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const has = (x, y, mx, my) => (x === mx && y === my) || ownedKeys.has(`${x},${y}`);
  const complete = (x, y, mx, my) => N4.every(([dx, dy]) => has(x + dx, y + dy, mx, my));
  const seen = new Set();
  for (const t of yardi?.tiles || []) {
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
      const mx = t.tx + dx, my = t.ty + dy, mk = `${mx},${my}`;
      if (seen.has(mk) || !inb(mx, my)) continue;
      seen.add(mk);
      const i = idx(mx, my);
      if (own[i] || blk[i]) continue;
      let n = 0;
      for (const [cx, cy] of [[mx, my], ...N4.map(([ax, ay]) => [mx + ax, my + ay])]) {
        if (!has(cx, cy, mx, my) || yardKeys.has(`${cx},${cy}`)) continue;
        if (!complete(cx, cy, mx, my)) continue;
        // part of the Yardinho once complete: touches it, or is m (which
        // touches the new neighbour it completes)
        if (N4.some(([ax, ay]) => yardKeys.has(`${cx + ax},${cy + ay}`)) || (cx === mx && cy === my)) n++;
      }
      if (n) entry(i).y = n;
    }
  }

  // ── combine ──
  const homePt = { lat: home.lat, lng: home.lng };
  const out = [];
  for (const [i, e] of score) {
    const x = (i % W) + x0, y = Math.floor(i / W) + y0;
    if (blk[i]) continue;
    const c = tiles.tileCenter(x, y, Z);
    const km = tiles.haversineDistance(homePt, c);
    if (km > RADIUS_KM) continue;
    const rd = road(x, y);
    const base = 60 * e.u + 2 * e.y;
    const s = base * ROAD_FACTOR[rd] * distFactor(km);
    if (s < 0.3) continue;
    out.push({ tx: x, ty: y, s: +s.toFixed(2), road: rd, km: +km.toFixed(1),
      ...(e.uk ? { uk: e.uk, um: e.um } : {}), ...(e.y ? { yd: e.y } : {}) });
  }
  out.sort((a, b) => b.s - a.s);
  out.length = Math.min(out.length, MAX_TILES);
  for (const t of out) t.tier = t.s >= 12 ? 1 : t.s >= 4 ? 2 : 3;

  windows.sort((a, b) => b.val - a.val || b.k - a.k);
  return { home: homePt, uberi: cur, yardi: yardi?.size || 0, tiles: out, windows: windows.slice(0, 12) };
}

module.exports = { computePriority };
