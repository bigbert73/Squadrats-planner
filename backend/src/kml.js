/**
 * kml.js — import "gold source" owned-square data from a squadrats.com KML
 * export ("Pobierz KML" in their app). Their export is a merged-outline
 * polygon (one outer boundary + many holes) per zoom level, not a list of
 * individual squares — so we rasterize it back onto our own tile grid.
 *
 * Every vertex in their export sits exactly on a Z_SQ/Z_SQI tile boundary,
 * which makes an even-odd scanline fill cheap and exact: build the set of
 * vertical edges for a ring (outer + its holes together — even-odd parity
 * handles holes with no special-casing), sweep row by row, and pair up
 * crossings into covered tile-x ranges.
 */

const tiles = require('./tiles');

function extractBlocks(str, tag) {
  const open = `<${tag}>`, close = `</${tag}>`;
  const out = [];
  let i = 0;
  while (true) {
    const s = str.indexOf(open, i);
    if (s === -1) break;
    const e = str.indexOf(close, s);
    if (e === -1) break;
    out.push(str.slice(s + open.length, e));
    i = e + close.length;
  }
  return out;
}

function parseCoords(text) {
  // Positions off the tile grid (beyond ±85.05°, not numbers) are dropped: at
  // the poles the tile row is infinite and the fill below would never end.
  return text.trim().split(/\s+/).filter(Boolean).map(pair => {
    const parts = pair.split(',');
    return [parseFloat(parts[0]), parseFloat(parts[1])];
  }).filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 85.05 && Math.abs(lon) <= 180);
}

// More squares than anyone has ever collected: a file above this is not an
// export of somebody's rides, and filling it would use up the server's memory.
const MAX_TILES = 3000000;

function lonLatToTileFrac(lon, lat, z) {
  const n = 1 << z;
  const x = (lon + 180) / 360 * n;
  const latRad = lat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return { x, y };
}

// Fills `out` (a Set of "tx,ty") with every tile whose center lies inside
// the given rings (outer ring + hole rings, even-odd rule) at zoom z.
function ringsToTiles(rings, z, out) {
  const edges = [];
  let minY = Infinity, maxY = -Infinity;
  for (const ring of rings) {
    const pts = ring.map(([lon, lat]) => lonLatToTileFrac(lon, lat, z));
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      // only vertical edges matter for a horizontal scanline sweep
      if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) > 1e-6) {
        const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
        edges.push({ x: a.x, y0, y1 });
        if (y0 < minY) minY = y0;
        if (y1 > maxY) maxY = y1;
      }
    }
  }
  if (!edges.length) return;
  const tyStart = Math.floor(minY), tyEnd = Math.ceil(maxY);
  for (let ty = tyStart; ty < tyEnd; ty++) {
    const midY = ty + 0.5;
    const xs = [];
    for (const e of edges) if (midY > e.y0 && midY < e.y1) xs.push(e.x);
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const txStart = Math.round(xs[i]), txEnd = Math.round(xs[i + 1]);
      if (out.size + (txEnd - txStart) > MAX_TILES) throw new Error('obszar w pliku jest zbyt duży');
      for (let tx = txStart; tx < txEnd; tx++) out.add(`${tx},${ty}`);
    }
  }
}

/**
 * Parses a squadrats.com KML export and returns the owned tile sets it
 * encodes, keyed the same way the rest of the app keys tiles ("tx,ty").
 */
function parseSquadratsKml(xml) {
  const result = { sq: new Set(), sqi: new Set(), sqSize: null, sqiSize: null };
  const placemarks = extractBlocks(xml, 'Placemark');
  for (const pm of placemarks) {
    const nameMatch = pm.match(/<name>([^<]*)<\/name>/);
    const name = nameMatch ? nameMatch[1].trim() : '';
    if (name !== 'squadrats' && name !== 'squadratinhos') continue;
    const z = name === 'squadrats' ? tiles.Z_SQ : tiles.Z_SQI;
    const target = name === 'squadrats' ? result.sq : result.sqi;
    const sizeMatch = pm.match(/<Data name="size"><value>(\d+)<\/value><\/Data>/);
    if (sizeMatch) {
      if (name === 'squadrats') result.sqSize = +sizeMatch[1];
      else result.sqiSize = +sizeMatch[1];
    }
    for (const poly of extractBlocks(pm, 'Polygon')) {
      const rings = [];
      const outer = extractBlocks(poly, 'outerBoundaryIs')[0];
      if (outer) {
        const coordsText = extractBlocks(outer, 'coordinates')[0];
        if (coordsText) rings.push(parseCoords(coordsText));
      }
      for (const inner of extractBlocks(poly, 'innerBoundaryIs')) {
        const coordsText = extractBlocks(inner, 'coordinates')[0];
        if (coordsText) rings.push(parseCoords(coordsText));
      }
      if (rings.length) ringsToTiles(rings, z, target);
    }
  }
  return result;
}

// Any other KML that draws squares as polygons — VeloViewer's "Explorer tiles"
// export is one polygon (or 3D box) per ticked tile. A polygon the size of one
// z14 tile is that tile; a bigger one (a merged outline, a max square) is
// filled like the Squadrats export. Returns a Set of "tx,ty" at z14.
function parseTileKml(xml) {
  const sq = new Set();
  let polygons = 0;
  const polyRe = /<Polygon\b[^>]*>([\s\S]*?)<\/Polygon>/g, coordRe = /<coordinates\b[^>]*>([\s\S]*?)<\/coordinates>/g;
  let m;
  while ((m = polyRe.exec(xml)) !== null) {
    const rings = [];
    let c;
    coordRe.lastIndex = 0;
    while ((c = coordRe.exec(m[1])) !== null) { const r = parseCoords(c[1]); if (r.length >= 4) rings.push(r); }
    if (!rings.length) continue;
    polygons++;
    const pts = rings[0].map(([lon, lat]) => lonLatToTileFrac(lon, lat, tiles.Z_SQ));
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    if (x1 - x0 <= 1.2 && y1 - y0 <= 1.2) {
      // the side walls of a 3D box are flat in plan: no tile of their own
      if (x1 - x0 < 0.5 || y1 - y0 < 0.5) continue;
      sq.add(`${Math.floor((x0 + x1) / 2)},${Math.floor((y0 + y1) / 2)}`);
    } else ringsToTiles(rings, tiles.Z_SQ, sq);
    if (sq.size > MAX_TILES) throw new Error('obszar w pliku jest zbyt duży');
  }
  return { sq, polygons };
}

module.exports = { parseSquadratsKml, parseTileKml };
