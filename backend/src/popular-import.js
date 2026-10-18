/**
 * popular-import.js — rasterise OSM cycling infrastructure into a compact
 * cell index used by the "Popularne" planning mode.
 *
 *   node src/popular-import.js <routes.geojsonseq> <cycleways.geojsonseq> <out.db> [osm-timestamp]
 *
 * Inputs are `osmium export` linestrings of (1) ways that are members of
 * route=bicycle relations (EuroVelo, Green Velo, regional/local trails) and
 * (2) highway=cycleway / bicycle=designated ways. Every z18 tile (~95 m in
 * Poland) a line passes through is stored with a bitmask: 1 = signed cycle
 * route, 2 = cycleway. Builds into <out.db>.tmp and renames at the end.
 */

const fs = require('fs');
const readline = require('readline');
const Database = require('better-sqlite3');

const Z = 18, N = 2 ** Z, STEP_KM = 0.015;

const tileX = (lng) => Math.floor((lng + 180) / 360 * N);
const tileY = (lat) => {
  const r = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * N);
};
function distKm(a, b) {
  const r = Math.PI / 180, dLa = (b[1] - a[1]) * r, dLo = (b[0] - a[0]) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLo / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function rasterise(path, bit, cells) {
  const rl = readline.createInterface({ input: fs.createReadStream(path), crlfDelay: Infinity });
  let lines = 0;
  for await (const raw of rl) {
    const line = raw.replace(/^\x1e/, '').trim();
    if (!line) continue;
    let f;
    try { f = JSON.parse(line); } catch { continue; }
    const c = f.geometry?.type === 'LineString' ? f.geometry.coordinates : null;
    if (!c || c.length < 2) continue;
    lines++;
    for (let i = 1; i < c.length; i++) {
      const n = Math.max(1, Math.ceil(distKm(c[i - 1], c[i]) / STEP_KM));
      for (let k = 0; k <= n; k++) {
        const lng = c[i - 1][0] + (c[i][0] - c[i - 1][0]) * k / n;
        const lat = c[i - 1][1] + (c[i][1] - c[i - 1][1]) * k / n;
        const key = tileX(lng) * N + tileY(lat);
        cells.set(key, (cells.get(key) || 0) | bit);
      }
    }
  }
  return lines;
}

async function main() {
  const [routesPath, waysPath, outPath, osmTs] = process.argv.slice(2);
  if (!routesPath || !waysPath || !outPath) {
    console.error('usage: popular-import.js <routes.geojsonseq> <cycleways.geojsonseq> <out.db> [osm-timestamp]');
    process.exit(1);
  }
  const cells = new Map();
  const nr = await rasterise(routesPath, 1, cells);
  const nw = await rasterise(waysPath, 2, cells);

  const tmp = outPath + '.tmp';
  fs.rmSync(tmp, { force: true });
  const db = new Database(tmp);
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  db.exec(`CREATE TABLE cells (k INTEGER PRIMARY KEY, w INTEGER NOT NULL) WITHOUT ROWID;
           CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);`);
  const ins = db.prepare('INSERT INTO cells (k, w) VALUES (?, ?)');
  db.transaction(() => { for (const [k, w] of cells) ins.run(k, w); })();
  const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  meta.run('zoom', String(Z));
  meta.run('imported_at', new Date().toISOString());
  if (osmTs) meta.run('osm_timestamp', osmTs);
  db.close();
  fs.renameSync(tmp, outPath);
  console.log(`popular: ${nr} route ways, ${nw} cycleways → ${cells.size} cells`);
}

main().catch((e) => { console.error(e); process.exit(1); });
