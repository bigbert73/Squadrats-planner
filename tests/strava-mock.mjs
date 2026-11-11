// A stand-in for strava.com in the test stack: the OAuth screens and the three
// API calls the backend makes. No real Strava account or token is involved.
//
//   GET  /oauth/authorize          "the rider clicked Authorize": straight back to redirect_uri
//   POST /oauth/token              code "ath-<n>" → tokens of athlete n; refresh "rt-<n>"
//   GET  /api/v3/athlete/activities
//   POST /oauth/deauthorize
//   GET/POST /__state              what the tests set and read:
//     athlete   who "is logged in at Strava" for the next authorize (number)
//     scope     the scopes they leave ticked
//     deny      true = they press Cancel
//     limit     true = the application is at its athlete limit (token → 403)
//     rate429   client id whose API calls get 429 ("" = nobody)
//     calls     counters
import http from 'node:http';

const SECRET = 'test-secret';   // every application of the mock has this secret
const st = { athlete: 7001, scope: 'read,activity:read,activity:read_all', deny: false, limit: false, rate429: '', revoked: [],
  calls: { authorize: 0, token: 0, refresh: 0, activities: 0, deauthorize: 0 } };
const issued = new Map();       // access token → { athlete, client }

// Google polyline encoding (what Strava's summary_polyline is)
function encode(points) {
  let out = '', pl = 0, pg = 0;
  const num = (v) => { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const [lat, lng] of points) { const a = Math.round(lat * 1e5), b = Math.round(lng * 1e5); out += num(a - pl) + num(b - pg); pl = a; pg = b; }
  return out;
}
// Each athlete rides in a place of their own (east of Warsaw, 0.05° apart)
function ridesOf(n) {
  const lat = 52.14 + (n % 7) * 0.05, lng = 21.23 + (n % 5) * 0.05;
  const leg = (dy, dx) => Array.from({ length: 30 }, (_, i) => [lat + dy * i / 29, lng + dx * i / 29]);
  return [
    { id: n * 1000 + 1, name: 'Poranna jazda', sport_type: 'Ride', start_date: '2026-05-01T07:00:00Z', distance: 4200, map: { summary_polyline: encode(leg(0.03, 0.01)) } },
    { id: n * 1000 + 2, name: 'Wieczorna jazda', sport_type: 'Ride', start_date: '2026-05-02T17:00:00Z', distance: 5100, map: { summary_polyline: encode(leg(0.005, 0.05)) } },
  ];
}
const athleteOf = (n) => ({ id: n, firstname: 'Test', lastname: `Rider${n}`, username: `rider${n}` });
function tokens(n, client) {
  const access = `at-${n}-${Math.random().toString(36).slice(2)}`;
  issued.set(access, { athlete: n, client: String(client) });
  return { token_type: 'Bearer', access_token: access, refresh_token: `rt-${n}`, expires_at: Math.floor(Date.now() / 1000) + 21600, expires_in: 21600 };
}

const send = (res, code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
const limits = (used) => ({ 'X-RateLimit-Limit': '200,2000', 'X-RateLimit-Usage': `${used},${used}`, 'X-ReadRateLimit-Limit': '100,1000', 'X-ReadRateLimit-Usage': `${used},${used}` });

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://mock');
  let raw = '';
  for await (const c of req) raw += c;
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = Object.fromEntries(new URLSearchParams(raw)); }

  if (u.pathname === '/__state') {
    if (req.method === 'POST') Object.assign(st, body);
    return send(res, 200, st);
  }
  if (u.pathname === '/oauth/authorize') {
    st.calls.authorize++;
    const back = new URL(u.searchParams.get('redirect_uri'));
    back.searchParams.set('state', u.searchParams.get('state') || '');
    if (st.deny) back.searchParams.set('error', 'access_denied');
    else { back.searchParams.set('code', `ath-${st.athlete}`); back.searchParams.set('scope', st.scope); }
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }
  if (u.pathname === '/oauth/token' && req.method === 'POST') {
    if (body.client_secret !== SECRET) return send(res, 401, { message: 'Authorization Error', errors: [{ resource: 'Application', field: 'client_secret', code: 'invalid' }] });
    if (body.grant_type === 'refresh_token') {
      st.calls.refresh++;
      const m = /^rt-(\d+)$/.exec(body.refresh_token || '');
      if (!m || st.revoked.includes(+m[1])) return send(res, 400, { message: 'Bad Request', errors: [{ resource: 'RefreshToken', field: 'refresh_token', code: 'invalid' }] });
      return send(res, 200, tokens(+m[1], body.client_id));
    }
    st.calls.token++;
    if (st.limit) return send(res, 403, { message: 'Forbidden', errors: [{ resource: 'Application', field: 'limit of connected athletes', code: 'exceeded' }] });
    const m = /^ath-(\d+)$/.exec(body.code || '');
    if (!m) return send(res, 400, { message: 'Bad Request', errors: [{ resource: 'AuthorizationCode', field: 'code', code: 'invalid' }] });
    return send(res, 200, { ...tokens(+m[1], body.client_id), athlete: athleteOf(+m[1]) });
  }
  if (u.pathname === '/api/v3/athlete/activities') {
    st.calls.activities++;
    const t = issued.get((req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!t || st.revoked.includes(t.athlete)) return send(res, 401, { message: 'Authorization Error' });
    if (st.rate429 && String(st.rate429) === t.client) return send(res, 429, { message: 'Rate Limit Exceeded' }, limits(100));
    return send(res, 200, u.searchParams.get('page') === '1' ? ridesOf(t.athlete) : [], limits(3));
  }
  if (u.pathname === '/oauth/deauthorize' && req.method === 'POST') {
    st.calls.deauthorize++;
    const tok = u.searchParams.get('access_token') || body.access_token;
    if (!issued.has(tok)) return send(res, 401, { message: 'Authorization Error' });
    issued.delete(tok);
    return send(res, 200, { access_token: tok });
  }
  send(res, 404, { message: 'Record Not Found' });
}).listen(3999, () => console.log('strava mock on :3999'));
