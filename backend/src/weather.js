/**
 * weather.js — forecast along a route, from MET Norway's Locationforecast.
 *
 * Their terms (https://api.met.no/doc/TermsOfService), which this file follows:
 *   • every request names the application (User-Agent), never a made-up browser;
 *   • answers are kept and not asked for again before their `Expires` time,
 *     afterwards with If-Modified-Since;
 *   • coordinates with at most 4 decimals (here: one — a 0.1° cell, ~7×11 km,
 *     so riders in the same town share one stored forecast);
 *   • browsers never talk to api.met.no themselves, only this proxy does.
 * Data licence: NLOD 2.0 / CC BY 4.0, credited in the app as "MET Norway".
 */

const axios = require('axios');

const BASE = process.env.WEATHER_API_BASE || 'https://api.met.no';
const UA   = process.env.WEATHER_USER_AGENT || process.env.APP_USER_AGENT || 'SquadratsPlanner/2.0 github.com/bigbert73/Squadrats-planner';
const MAX_CELLS = 3000;

const cache = new Map();      // "lat,lng" → { data, expires, lastModified }
const pending = new Map();    // the same cell asked for twice at once: one request
let chain = Promise.resolve(), lastAt = 0;

// One request at a time, at least 120 ms apart (the limit is 20/s per application)
function queued(fn) {
  const run = chain.then(async () => {
    const wait = lastAt + 120 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    try { return await fn(); } finally { lastAt = Date.now(); }
  });
  chain = run.catch(() => {});
  return run;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// Only what the app shows: per time step temperature (°C), wind (m/s, the
// direction it blows FROM), rain (mm/h) and the pictogram name.
function slim(body) {
  const ts = body?.properties?.timeseries;
  if (!Array.isArray(ts)) return null;
  const hours = [];
  for (const s of ts.slice(0, 90)) {
    const d = s?.data?.instant?.details;
    if (!d || typeof s.time !== 'string') continue;
    const n1 = s.data.next_1_hours, n6 = s.data.next_6_hours;
    const rain = n1 ? num(n1.details?.precipitation_amount) : n6 ? (num(n6.details?.precipitation_amount) ?? 0) / 6 : null;
    hours.push({
      t: s.time, temp: num(d.air_temperature), wind: num(d.wind_speed), dir: num(d.wind_from_direction),
      rain: rain == null ? null : Math.round(rain * 10) / 10,
      sym: (n1 || n6)?.summary?.symbol_code || null,
    });
  }
  return hours.length ? { updated: body.properties?.meta?.updated_at || null, hours } : null;
}

async function forecast(lat, lng) {
  const la = (Math.round(lat * 10) / 10).toFixed(1), lo = (Math.round(lng * 10) / 10).toFixed(1);
  const key = `${la},${lo}`, now = Date.now();
  const c = cache.get(key);
  if (c && c.expires > now) return c.data;
  if (pending.has(key)) return pending.get(key);
  const p = queued(async () => {
    const headers = { 'User-Agent': UA, Accept: 'application/json' };
    if (c?.lastModified) headers['If-Modified-Since'] = c.lastModified;
    let r;
    try {
      r = await axios.get(`${BASE}/weatherapi/locationforecast/2.0/compact`, { params: { lat: la, lon: lo }, headers, timeout: 15000, validateStatus: s => s === 200 || s === 304 });
    } catch (e) {
      // their service is down or says "slow down": the stored forecast is better than none
      if (c) { c.expires = now + 10 * 60 * 1000; return c.data; }
      throw e;
    }
    const exp = Date.parse(r.headers?.expires || '');
    const expires = Math.max(now + 10 * 60 * 1000, Number.isFinite(exp) ? exp : now + 60 * 60 * 1000);
    if (r.status === 304 && c) { c.expires = expires; return c.data; }
    const s = slim(r.data);
    if (!s) throw new Error('weather: unexpected answer');
    const data = { lat: Number(la), lng: Number(lo), ...s };
    if (cache.size >= MAX_CELLS) cache.delete(cache.keys().next().value);
    cache.set(key, { data, expires, lastModified: r.headers?.['last-modified'] || null });
    return data;
  }).finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}

module.exports = { forecast, ATTRIBUTION: 'MET Norway' };
