/**
 * statshunters.js — squares of a StatsHunters account, read through the
 * account's own "share link" (statshunters.com → Settings → Share): no login,
 * no key, and the rider decides what the link exposes.
 *
 * The link's API lists activities page by page, each with the z14 tiles it
 * touched ({x, y}); those are the same squares as ours. It carries no z17
 * data, so squadratinhos still come from Strava / GPX / Squadrats KML.
 */

const axios = require('axios');

const BASE = process.env.STATSHUNTERS_BASE || 'https://www.statshunters.com';
const UA   = process.env.APP_USER_AGENT || 'SquadratsPlanner/2.0 github.com/bigbert73/Squadrats-planner';
const MAX_PAGES = 400, MAX_TILES = 3000000;

class ImportError extends Error {}

// A pasted link or the bare code from it; anything else is refused, so the
// server only ever asks statshunters.com
function shareCode(input) {
  const s = String(input || '').trim();
  if (s.length > 300) return null;
  const m = /^(?:https?:\/\/)?(?:www\.)?statshunters\.com\/share\/([A-Za-z0-9]{4,64})(?:[/?#].*)?$/i.exec(s) || /^([A-Za-z0-9]{4,64})$/.exec(s);
  return m ? m[1] : null;
}

async function fetchTiles(code) {
  const sq = new Set();
  let activities = 0;
  const real = BASE === 'https://www.statshunters.com';
  for (let page = 1; page <= MAX_PAGES; page++) {
    let r;
    try {
      r = await axios.get(`${BASE}/share/${code}/api/activities`, {
        params: { page }, timeout: 30000, maxContentLength: 60 * 1024 * 1024, maxRedirects: 2,
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        // a redirect must stay on their site
        beforeRedirect: (o) => { if (real && !/(^|\.)statshunters\.com$/i.test(o.hostname || '')) throw new ImportError('StatsHunters odesłał pod inny adres'); },
        validateStatus: s => s < 500,
      });
    } catch (e) {
      if (e instanceof ImportError) throw e;
      throw new ImportError('StatsHunters nie odpowiada — spróbuj ponownie później');
    }
    if (r.status === 401 || r.status === 403 || r.status === 404) throw new ImportError('StatsHunters nie zna takiego linku. Skopiuj go ze statshunters.com → Settings → Share.');
    if (r.status === 429) throw new ImportError('StatsHunters chwilowo ogranicza liczbę zapytań — spróbuj ponownie później');
    const list = r.data?.activities;
    if (r.status !== 200 || !Array.isArray(list)) throw new ImportError('StatsHunters odpowiedział w nieznanym formacie');
    if (!list.length) break;
    for (const a of list) {
      activities++;
      if (!Array.isArray(a?.tiles)) continue;
      for (const t of a.tiles) {
        const x = Array.isArray(t) ? t[0] : t?.x, y = Array.isArray(t) ? t[1] : t?.y;
        if (Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < 16384 && y < 16384) sq.add(`${x},${y}`);
      }
      if (sq.size > MAX_TILES) throw new ImportError('Za dużo kwadratów w odpowiedzi');
    }
    if (real) await new Promise(res => setTimeout(res, 300));
  }
  return { sq, activities };
}

module.exports = { shareCode, fetchTiles, ImportError };
