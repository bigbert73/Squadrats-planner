/**
 * reach-import.js — find squadratinhos (z17 tiles) that no road or path
 * passes through, i.e. most likely impossible to collect (lakes, military
 * areas, fenced-off land, the middle of a big forest without tracks).
 *
 *   osmium export ... highways | node src/reach-import.js - <extract.poly> <out.db> [osm-timestamp]
 *
 * Input: `osmium export -f geojsonseq` linestrings of highway=* ways (from
 * stdin with "-"). Ways a cyclist can't use are skipped (motorways,
 * expressways, private/no access without a foot/bicycle exception, planned
 * or abandoned roads). Every z17 tile a usable way passes through is marked
 * "has road".
 *
 * The extract's .poly boundary says where the data is complete: a tile
 * outside it is "unknown", never "unreachable".
 *
 * Several extracts: build one index per extract, then join them:
 *
 *   node src/reach-import.js --merge <out.db> <osm-timestamp> <regions> <a.db> <b.db> …
 *
 * (a squadratinho is inside when any extract covers it, and has a road when
 * any extract has one there).
 *
 * Output, per z12 block (32×32 squadratinhos): road bitmap and inside
 * bitmap (NULL = whole block inside), row-major, LSB first, 128 bytes each.
 */

const fs = require('fs');
const readline = require('readline');
const Database = require('better-sqlite3');

const Z = 17, N = 2 ** Z, B = 5, BS = 1 << B, STEP_KM = 0.02;

const SKIP_HIGHWAY = new Set(['motorway', 'motorway_link', 'construction', 'proposed', 'abandoned',
  'disused', 'razed', 'platform', 'raceway', 'bus_guideway', 'elevator', 'corridor', 'escape',
  'emergency_bay', 'busway', 'no']);
const NO_ACCESS = new Set(['private', 'no', 'military', 'forestry_no']);
const YES = new Set(['yes', 'designated', 'permissive', 'destination', 'official']);

function usable(p) {
  if (!p || !p.highway || SKIP_HIGHWAY.has(p.highway)) return false;
  if (p.motorroad === 'yes') return false;               // Polish expressways (highway=trunk + motorroad)
  if (p.area === 'yes' && p.highway !== 'pedestrian') return false;
  const bike = p.bicycle, foot = p.foot;
  if (YES.has(bike) || YES.has(foot)) return true;
  if (NO_ACCESS.has(p.access)) return false;
  if ((bike === 'no' || bike === 'dismount') && foot === 'no') return false;
  return true;
}

const tileXf = (lng) => (lng + 180) / 360 * N;
const tileYf = (lat) => {
  const r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * N;
};
const tileLat = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / N))) * 180 / Math.PI;
function distKm(a, b) {
  const r = Math.PI / 180, dLa = (b[1] - a[1]) * r, dLo = (b[0] - a[0]) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLo / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Osmosis .poly: name, then rings ("1" outer / "!2" hole) of "lng lat" lines
function readPoly(path) {
  const rings = [];
  let cur = null;
  for (const raw of fs.readFileSync(path, 'utf8').split('\n').slice(1)) {
    const line = raw.trim();
    if (!line) continue;
    if (line === 'END') { if (cur) { rings.push(cur); cur = null; } continue; }
    if (!cur) { cur = []; continue; }                     // ring header
    const [lng, lat] = line.split(/\s+/).map(Number);
    cur.push([lng, lat]);
  }
  return rings;
}

const blocks = new Map();   // z12 key → { road: Uint8Array(128), inside: Uint8Array(128) }
function block(bx, by) {
  const k = bx * 4096 + by;
  let b = blocks.get(k);
  if (!b) blocks.set(k, b = { road: new Uint8Array(128), inside: new Uint8Array(128) });
  return b;
}
const setBit = (arr, x, y) => { const i = (y & (BS - 1)) * BS + (x & (BS - 1)); arr[i >> 3] |= 1 << (i & 7); };

// Even-odd scanline fill of the extract polygon, sampled at tile centres
function markInside(rings) {
  let minLat = 90, maxLat = -90;
  for (const r of rings) for (const [, lat] of r) { minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat); }
  const y0 = Math.floor(tileYf(maxLat)), y1 = Math.floor(tileYf(minLat));
  let cells = 0;
  for (let y = y0; y <= y1; y++) {
    const lat = tileLat(y + 0.5), xs = [];
    for (const r of rings) for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      if ((a[1] > lat) !== (b[1] > lat)) xs.push(a[0] + (lat - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xa = Math.ceil(tileXf(xs[i]) - 0.5), xb = Math.floor(tileXf(xs[i + 1]) - 0.5);
      for (let x = xa; x <= xb; x++) { setBit(block(x >> B, y >> B).inside, x, y); cells++; }
    }
  }
  return cells;
}

function writeDb(outPath, osmTs, regions) {
  const tmp = outPath + '.tmp';
  fs.rmSync(tmp, { force: true });
  const db = new Database(tmp);
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  db.exec(`CREATE TABLE blocks (k INTEGER PRIMARY KEY, road BLOB NOT NULL, inside BLOB) WITHOUT ROWID;
           CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);`);
  const ins = db.prepare('INSERT INTO blocks (k, road, inside) VALUES (?, ?, ?)');
  let unreachable = 0;
  db.transaction(() => {
    for (const [k, b] of blocks) {
      const full = b.inside.every(v => v === 255);
      for (let i = 0; i < 128; i++) { let m = b.inside[i] & ~b.road[i]; while (m) { unreachable += m & 1; m >>= 1; } }
      ins.run(k, Buffer.from(b.road), full ? null : Buffer.from(b.inside));
    }
  })();
  const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  meta.run('zoom', String(Z));
  meta.run('block_bits', String(B));
  meta.run('imported_at', new Date().toISOString());
  if (osmTs) meta.run('osm_timestamp', osmTs);
  if (regions) meta.run('regions', regions);
  db.close();
  fs.renameSync(tmp, outPath);
  return unreachable;
}

function merge([outPath, osmTs, regions, ...parts]) {
  if (!outPath || !parts.length) { console.error('usage: reach-import.js --merge <out.db> <osm-timestamp> <regions> <a.db> <b.db> …'); process.exit(1); }
  for (const p of parts) {
    const db = new Database(p, { readonly: true, fileMustExist: true });
    for (const r of db.prepare('SELECT k, road, inside FROM blocks').iterate()) {
      let b = blocks.get(r.k);
      if (!b) blocks.set(r.k, b = { road: new Uint8Array(128), inside: new Uint8Array(128) });
      for (let i = 0; i < 128; i++) { b.road[i] |= r.road[i]; b.inside[i] |= r.inside ? r.inside[i] : 255; }
    }
    db.close();
  }
  if (!blocks.size) throw new Error('nothing to merge; keeping the old index');
  const unreachable = writeDb(outPath, osmTs, regions);
  console.log(`reach: ${parts.length} extract(s) joined, ${unreachable} SQI without a road, ${blocks.size} blocks`);
}

async function main() {
  if (process.argv[2] === '--merge') return merge(process.argv.slice(3));
  const [input, polyPath, outPath, osmTs] = process.argv.slice(2);
  if (!input || !polyPath || !outPath) {
    console.error('usage: reach-import.js <highways.geojsonseq|-> <extract.poly> <out.db> [osm-timestamp]');
    process.exit(1);
  }
  const insideCells = markInside(readPoly(polyPath));

  const rl = readline.createInterface({ input: input === '-' ? process.stdin : fs.createReadStream(input), crlfDelay: Infinity });
  let ways = 0, used = 0;
  for await (const raw of rl) {
    const line = raw.replace(/^\x1e/, '').trim();
    if (!line) continue;
    let f;
    try { f = JSON.parse(line); } catch { continue; }
    ways++;
    const c = f.geometry?.type === 'LineString' ? f.geometry.coordinates : null;
    if (!c || c.length < 2 || !usable(f.properties)) continue;
    used++;
    for (let i = 1; i < c.length; i++) {
      const n = Math.max(1, Math.ceil(distKm(c[i - 1], c[i]) / STEP_KM));
      for (let k = 0; k <= n; k++) {
        const x = Math.floor(tileXf(c[i - 1][0] + (c[i][0] - c[i - 1][0]) * k / n));
        const y = Math.floor(tileYf(c[i - 1][1] + (c[i][1] - c[i - 1][1]) * k / n));
        const b = blocks.get((x >> B) * 4096 + (y >> B));
        if (b) setBit(b.road, x, y);                        // outside the extract: not needed
      }
    }
  }

  if (!used) throw new Error('no usable ways in the input; keeping the old index');
  const unreachable = writeDb(outPath, osmTs);
  console.log(`reach: ${ways} ways (${used} usable), ${insideCells} SQI in extract, ${unreachable} without a road, ${blocks.size} blocks`);
}

main().catch((e) => { console.error(e); process.exit(1); });
