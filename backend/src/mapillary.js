/**
 * mapillary.js — Mapillary street-level images near a route.
 *
 * Image positions come from Mapillary's vector tiles (one z14 tile, ~2.4 km,
 * in ~0.5 s with every image in it) rather than the Graph API image search,
 * which needs ~1–3 s per small bbox. Thumbnails are looked up per image only
 * when a popup opens, since their signed URLs expire. A minimal MVT decoder
 * is enough here: point features of the "image" layer and their properties.
 */

const axios = require('axios');

const Z = 14;
const TILE_TTL_MS = 24 * 3600 * 1000;
const tileCache = new Map();   // `${x},${y}` → { at, imgs: [{id, lat, lng, t}] }

// ── protobuf / MVT ──
function reader(buf) {
  let pos = 0;
  const varint = () => {
    let v = 0, mul = 1, b;
    do { b = buf[pos++]; v += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80);
    return v;
  };
  return {
    end: () => pos >= buf.length,
    tag: () => { const t = varint(); return [Math.floor(t / 8), t & 7]; },
    varint,
    bytes: () => { const n = varint(); const b = buf.subarray(pos, pos + n); pos += n; return b; },
    double: () => { const v = buf.readDoubleLE(pos); pos += 8; return v; },
    float: () => { const v = buf.readFloatLE(pos); pos += 4; return v; },
    skip: (wt) => { if (wt === 0) varint(); else if (wt === 1) pos += 8; else if (wt === 2) pos += varint(); else if (wt === 5) pos += 4; },
  };
}
const packed = (b) => { const r = reader(b), out = []; while (!r.end()) out.push(r.varint()); return out; };
const zz = (n) => (n % 2 ? -(n + 1) / 2 : n / 2);

function decodeValue(b) {
  const r = reader(b);
  let v = null;
  while (!r.end()) {
    const [f, wt] = r.tag();
    if (f === 1) v = r.bytes().toString('utf8');
    else if (f === 2) v = r.float();
    else if (f === 3) v = r.double();
    else if (f === 4 || f === 5) v = r.varint();
    else if (f === 6) v = zz(r.varint());
    else if (f === 7) v = !!r.varint();
    else r.skip(wt);
  }
  return v;
}

function imagesInTile(buf, tx, ty) {
  const out = [], r = reader(buf);
  while (!r.end()) {
    const [f, wt] = r.tag();
    if (f !== 3) { r.skip(wt); continue; }
    const lr = reader(r.bytes());
    let name = '', extent = 4096;
    const keys = [], values = [], feats = [];
    while (!lr.end()) {
      const [lf, lwt] = lr.tag();
      if (lf === 1) name = lr.bytes().toString('utf8');
      else if (lf === 2) feats.push(lr.bytes());
      else if (lf === 3) keys.push(lr.bytes().toString('utf8'));
      else if (lf === 4) values.push(decodeValue(lr.bytes()));
      else if (lf === 5) extent = lr.varint();
      else lr.skip(lwt);
    }
    if (name !== 'image') continue;
    const n = 2 ** Z;
    for (const fb of feats) {
      const fr = reader(fb);
      let tags = [], geom = [];
      while (!fr.end()) {
        const [ff, fwt] = fr.tag();
        if (ff === 2) tags = packed(fr.bytes());
        else if (ff === 4) geom = packed(fr.bytes());
        else fr.skip(fwt);
      }
      if (geom.length < 3 || (geom[0] & 7) !== 1) continue;   // MoveTo point
      const px = zz(geom[1]), py = zz(geom[2]);
      const props = {};
      for (let i = 0; i + 1 < tags.length; i += 2) props[keys[tags[i]]] = values[tags[i + 1]];
      if (!props.id) continue;
      const lng = (tx + px / extent) / n * 360 - 180;
      const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + py / extent) / n))) * 180 / Math.PI;
      out.push({ id: String(props.id), lat, lng, t: props.captured_at || 0, pano: !!props.is_pano });
    }
  }
  return out;
}

async function tileImages(x, y, token) {
  const k = `${x},${y}`, c = tileCache.get(k);
  if (c && Date.now() - c.at < TILE_TTL_MS) return c.imgs;
  const r = await axios.get(`https://tiles.mapillary.com/maps/vtp/mly1_public/2/${Z}/${x}/${y}`,
    { params: { access_token: token }, responseType: 'arraybuffer', timeout: 20000 });
  const imgs = imagesInTile(Buffer.from(r.data), x, y);
  if (tileCache.size > 3000) tileCache.clear();
  tileCache.set(k, { at: Date.now(), imgs });
  return imgs;
}

const tileOf = (lat, lng) => {
  const n = 2 ** Z, la = lat * Math.PI / 180;
  return [Math.floor((lng + 180) / 360 * n), Math.floor((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * n)];
};

module.exports = { Z, tileOf, tileImages };
