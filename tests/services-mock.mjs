// Stand-ins for the other services the backend talks to, for the test stack.
// Nothing here reaches the internet, and no real account, key or mailbox is used.
//
//   StatsHunters   GET /share/<code>/api/activities?page=N
//                    code "sharegood1": 2 pages of activities with z14 tiles, then an empty page
//                    code "shareempty": no activities;  anything else: 404
//   MET Norway     GET /weatherapi/locationforecast/2.0/compact?lat=&lon=
//                    66 hours of forecast; wind from `windDir` at `windSpeed` m/s
//   Apple          GET /auth/authorize   "the person approved": a page that posts code+state back
//                  POST /auth/token      code → id_token (RS256);  GET /auth/keys
//   SMTP           port 2525: accepts any message; GET /__mails lists them
//   GET/POST /__state   what the tests set and read (windDir, windSpeed, weatherFail,
//                       appleSub, appleEmail, appleVerified, appleDeny, calls, lastUA)
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';

const st = { windDir: 270, windSpeed: 6, weatherFail: false, appleSub: 'apple-001', appleEmail: 'apple001@example.org', appleVerified: true, appleDeny: false,
  calls: { statshunters: 0, weather: 0, weather304: 0, appleAuthorize: 0, appleToken: 0, mails: 0 }, lastUA: {} };
const mails = [];

// ── Apple: a signing key of our own ──────────────────────────────────────────
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'mock-key-1';
const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
function idToken(aud, sub, email, verified) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${b64({ iss: 'https://appleid.apple.com', aud, sub, iat: now, exp: now + 600, ...(email ? { email, email_verified: verified ? 'true' : 'false' } : {}) })}`;
  return `${body}.${crypto.sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`;
}
const esc = (s) => String(s).replace(/[<>&"']/g, c => `&#${c.charCodeAt(0)};`);

// ── StatsHunters: squares west of Poznań, far from every other test ──────────
const X0 = 8950, Y0 = 5400;
const shPages = [
  [{ id: 1, name: 'Ride 1', tiles: [{ x: X0, y: Y0 }, { x: X0 + 1, y: Y0 }, { x: X0 + 2, y: Y0 }] },
   { id: 2, name: 'Ride 2', tiles: [{ x: X0 + 2, y: Y0 }, { x: X0 + 2, y: Y0 + 1 }] }],
  [{ id: 3, name: 'Ride 3', tiles: [[X0 + 3, Y0 + 1], [X0 + 4, Y0 + 1]] }, { id: 4, name: 'No map' },
   { id: 5, name: 'Broken', tiles: [{ x: -1, y: 5 }, { x: 'a', y: 2 }, null, { x: 99999, y: 1 }] }],
];

const send = (res, code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };

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
  if (u.pathname === '/__mails') {
    if (req.method === 'DELETE') mails.length = 0;
    return send(res, 200, mails);
  }

  let m;
  if ((m = /^\/share\/([^/]+)\/api\/activities$/.exec(u.pathname))) {
    st.calls.statshunters++; st.lastUA.statshunters = req.headers['user-agent'] || '';
    if (m[1] === 'shareempty') return send(res, 200, { activities: [] });
    if (m[1] !== 'sharegood1') return send(res, 404, { error: 'not found' });
    return send(res, 200, { activities: shPages[(Number(u.searchParams.get('page')) || 1) - 1] || [] });
  }

  if (u.pathname === '/weatherapi/locationforecast/2.0/compact') {
    st.calls.weather++; st.lastUA.weather = req.headers['user-agent'] || '';
    st.lastWeatherQuery = u.search;
    if (st.weatherFail) return send(res, 503, { error: 'down' });
    const lastMod = new Date(Math.floor(Date.now() / 3600000) * 3600000).toUTCString();
    const headers = { Expires: new Date(Date.now() + 30 * 60000).toUTCString(), 'Last-Modified': lastMod };
    if (req.headers['if-modified-since'] === lastMod) { st.calls.weather304++; res.writeHead(304, headers); return res.end(); }
    const t0 = Math.floor(Date.now() / 3600000) * 3600000;
    const timeseries = Array.from({ length: 66 }, (_, i) => ({
      time: new Date(t0 + i * 3600000).toISOString().replace('.000Z', 'Z'),
      data: {
        instant: { details: { air_temperature: 12 + (i % 5), wind_speed: st.windSpeed, wind_from_direction: st.windDir, relative_humidity: 70 } },
        next_1_hours: { summary: { symbol_code: i % 3 ? 'partlycloudy_day' : 'lightrain' }, details: { precipitation_amount: i % 3 ? 0 : 0.4 } },
      },
    }));
    return send(res, 200, { type: 'Feature', geometry: { type: 'Point', coordinates: [Number(u.searchParams.get('lon')), Number(u.searchParams.get('lat')), 100] },
      properties: { meta: { updated_at: new Date(t0).toISOString() }, timeseries } }, headers);
  }

  if (u.pathname === '/auth/authorize') {
    st.calls.appleAuthorize++;
    const back = u.searchParams.get('redirect_uri'), state = u.searchParams.get('state') || '';
    st.lastAppleAuthorize = Object.fromEntries(u.searchParams);
    const fields = st.appleDeny ? { error: 'user_cancelled_authorize', state } : { code: `apple-${st.appleSub}`, state };
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><title>Apple (mock)</title><form id="f" method="post" action="${esc(back)}">${
      Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join('')}</form><script>document.getElementById('f').submit()</script>`);
  }
  if (u.pathname === '/auth/token' && req.method === 'POST') {
    st.calls.appleToken++;
    // the client secret must be a token signed for Apple (ES256, aud appleid.apple.com)
    let okSecret = false;
    try {
      const [h, p] = String(body.client_secret || '').split('.').slice(0, 2).map(x => JSON.parse(Buffer.from(x, 'base64url').toString()));
      okSecret = h.alg === 'ES256' && !!h.kid && p.aud === 'https://appleid.apple.com' && p.sub === body.client_id && !!p.iss;
    } catch {}
    if (!okSecret) return send(res, 400, { error: 'invalid_client' });
    const mm = /^apple-(.+)$/.exec(body.code || '');
    if (!mm || body.grant_type !== 'authorization_code') return send(res, 400, { error: 'invalid_grant' });
    return send(res, 200, { access_token: 'a', token_type: 'Bearer', expires_in: 3600, id_token: idToken(body.client_id, mm[1], st.appleEmail, st.appleVerified) });
  }
  if (u.pathname === '/auth/keys') return send(res, 200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }] });

  send(res, 404, { error: 'not in the mock' });
}).listen(3998, () => console.log('services mock on :3998'));

// ── SMTP: just enough of the protocol for one message per connection ────────
net.createServer((sock) => {
  let buf = '', data = null, mail = { from: null, to: [] };
  sock.setEncoding('utf8');
  sock.write('220 mock ESMTP\r\n');
  sock.on('error', () => {});
  sock.on('data', (chunk) => {
    buf += chunk;
    for (;;) {
      if (data !== null) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end === -1) return;
        data += buf.slice(0, end); buf = buf.slice(end + 5);
        // quoted-printable / base64 bodies are decoded for the tests
        let text = data;
        const [head, ...rest] = data.split('\r\n\r\n');
        let bodyText = rest.join('\r\n\r\n');
        if (/content-transfer-encoding:\s*base64/i.test(head)) bodyText = Buffer.from(bodyText.replace(/\s+/g, ''), 'base64').toString('utf8');
        else if (/content-transfer-encoding:\s*quoted-printable/i.test(head))
          bodyText = Buffer.from(bodyText.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
        const subj = /^subject:\s*(.*(?:\r\n[ \t].*)*)/im.exec(head)?.[1] || '';
        mails.push({ from: mail.from, to: mail.to, subject: subj, text: bodyText.replace(/\r\n/g, '\n'), raw: text.slice(0, 4000), at: Date.now() });
        st.calls.mails++;
        data = null; mail = { from: null, to: [] };
        sock.write('250 OK queued\r\n');
        continue;
      }
      const nl = buf.indexOf('\r\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO') sock.write('250-mock\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n');
      else if (cmd === 'HELO') sock.write('250 mock\r\n');
      else if (cmd === 'MAIL') { mail.from = /<([^>]*)>/.exec(line)?.[1] || ''; sock.write('250 OK\r\n'); }
      else if (cmd === 'RCPT') { mail.to.push(/<([^>]*)>/.exec(line)?.[1] || ''); sock.write('250 OK\r\n'); }
      else if (cmd === 'DATA') { data = ''; sock.write('354 go ahead\r\n'); }
      else if (cmd === 'RSET' || cmd === 'NOOP') sock.write('250 OK\r\n');
      else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); return; }
      else sock.write('502 not implemented\r\n');
    }
  });
}).listen(2525, () => console.log('smtp sink on :2525'));
