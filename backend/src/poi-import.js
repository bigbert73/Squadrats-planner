/**
 * poi-import.js — load POIs exported from an OSM extract (osmium export
 * geojsonseq) into a standalone SQLite file with an R-tree index.
 *
 *   node src/poi-import.js <in.geojsonseq> <out.db> [osm-timestamp]
 *
 * Builds into <out.db>.tmp and renames over <out.db> at the end, so a
 * running server never sees a half-built database. Areas (e.g. a
 * supermarket mapped as a building) are reduced to the centre of their
 * outline.
 */

const fs = require('fs');
const readline = require('readline');
const Database = require('better-sqlite3');

const KEEP = ['name', 'brand', 'amenity', 'shop', 'tourism', 'historic', 'cuisine', 'opening_hours', 'stars'];

function centroid(geom) {
  let pts;
  switch (geom?.type) {
    case 'Point': return geom.coordinates;
    case 'LineString': pts = geom.coordinates; break;
    case 'Polygon': pts = geom.coordinates[0]; break;
    case 'MultiPolygon': pts = geom.coordinates[0][0]; break;
    default: return null;
  }
  if (!pts?.length) return null;
  let x = 0, y = 0;
  for (const [lng, lat] of pts) { x += lng; y += lat; }
  return [x / pts.length, y / pts.length];
}

async function main() {
  const [inPath, outPath, osmTs] = process.argv.slice(2);
  if (!inPath || !outPath) { console.error('usage: poi-import.js <in.geojsonseq> <out.db> [osm-timestamp]'); process.exit(1); }
  const tmp = outPath + '.tmp';
  fs.rmSync(tmp, { force: true });
  const db = new Database(tmp);
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  db.exec(`
    CREATE TABLE pois (id INTEGER PRIMARY KEY, osm TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, tags TEXT NOT NULL);
    CREATE VIRTUAL TABLE pois_rtree USING rtree(id, min_lat, max_lat, min_lng, max_lng);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  const ins = db.prepare('INSERT INTO pois (id, osm, lat, lng, tags) VALUES (?, ?, ?, ?, ?)');
  const insR = db.prepare('INSERT INTO pois_rtree (id, min_lat, max_lat, min_lng, max_lng) VALUES (?, ?, ?, ?, ?)');
  const flush = db.transaction((rows) => {
    for (const r of rows) { ins.run(r.id, r.osm, r.lat, r.lng, r.tags); insR.run(r.id, r.lat, r.lat, r.lng, r.lng); }
  });

  const rl = readline.createInterface({ input: fs.createReadStream(inPath), crlfDelay: Infinity });
  let id = 0, skipped = 0, batch = [];
  for await (const raw of rl) {
    const line = raw.replace(/^\x1e/, '').trim();
    if (!line) continue;
    let f;
    try { f = JSON.parse(line); } catch { skipped++; continue; }
    const c = centroid(f.geometry);
    if (!c) { skipped++; continue; }
    const p = f.properties || {};
    const tags = {};
    for (const k of KEEP) if (p[k] != null) tags[k] = p[k];
    if (!tags.amenity && !tags.shop && !tags.tourism && !tags.historic) { skipped++; continue; } // referenced vertex, not a POI
    batch.push({ id: ++id, osm: `${p['@type'] || 'n'}/${p['@id'] ?? ''}`, lat: c[1], lng: c[0], tags: JSON.stringify(tags) });
    if (batch.length >= 5000) { flush(batch); batch = []; }
  }
  if (batch.length) flush(batch);
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('osm_timestamp', osmTs || '');
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('imported_at', new Date().toISOString());
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('count', String(id));
  db.close();
  fs.renameSync(tmp, outPath);
  console.log(`POI import: ${id} POIs → ${outPath} (skipped ${skipped})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
