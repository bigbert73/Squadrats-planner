// API tests: accounts, multi-user isolation, input validation, features.
// Run against the isolated stack (tests/stack.sh up):  node tests/api.mjs
import { suite, assert, Client, newUser, adminClient, signJwt, sql, ensureUp, health, sleep, uniq, PASSWORD, ENV, BASE,
  AREA, tileOf, tileCenter, gpxOf, routeBody, xmlWellFormed, line, HERE } from './lib.mjs';
import { loadI18n, readPack, codePairs, serverTexts } from './i18n-lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const S = suite('api');
const { t } = S;
const only = process.argv[2]; // optional id prefix filter, e.g. "MU"
const T = (id, title, fn, o) => (!only || id.startsWith(only)) ? t(id, title, fn, o) : null;
// The request must be answered and must not take the backend down.
async function survives(fn) {
  let res, err;
  try { res = await fn(); } catch (e) { err = e; }
  const restarted = await ensureUp();
  assert.ok(!restarted, 'backend padł po tym żądaniu (proces się wyłączył)');
  if (err) throw new Error('brak odpowiedzi: ' + err.message);
  return res;
}
const no5xx = (r, what = '') => assert.ok(r.status < 500, `${what} → HTTP ${r.status}: ${r.text.slice(0, 140)}`);
const is4xx = (r, what = '') => assert.ok(r.status >= 400 && r.status < 500, `${what} → HTTP ${r.status}: ${r.text.slice(0, 140)}`);
const noStack = (r) => assert.ok(!/\bat [\w.<>]+ \(.*:\d+:\d+\)|node_modules/.test(r.text), 'odpowiedź zawiera ślad stosu: ' + r.text.slice(0, 160));

await ensureUp();
const anon = new Client();
const A = await newUser('ala'), B = await newUser('bob'), C = await newUser('cel');
const admin = await adminClient();

// ═════════════════════════ AUTH: accounts and sessions ═════════════════════
await T('AUTH-01', 'rejestracja: konto użytkownika, ciasteczko httpOnly + SameSite', async () => {
  assert.equal(A.user.role, 'user');
  assert.match(A.setCookie, /HttpOnly/i); assert.match(A.setCookie, /SameSite=Lax/i);
  for (const k of ['password_hash', 'strava_client_secret', 'garmin_key']) assert.ok(!(k in A.user), `odpowiedź zawiera ${k}`);
});
await T('AUTH-02', 'rejestracja: walidacja (krótka nazwa, słabe hasło, braki)', async () => {
  const c = new Client();
  for (const [b, why] of [[{ username: 'ab', password: PASSWORD }, 'krótka nazwa'], [{ username: uniq(), password: 'krotkie1' .slice(0, 7) }, 'krótkie hasło'],
    [{ username: uniq(), password: 'bezcyfryyy' }, 'hasło bez cyfry'], [{ password: PASSWORD }, 'brak nazwy'], [{ username: uniq() }, 'brak hasła'], [{ username: '   ', password: PASSWORD }, 'same spacje']]) {
    const r = await new Client().post('/api/auth/register', b); assert.equal(r.status, 400, why + ' → ' + r.status);
  }
});
await T('AUTH-03', 'rejestracja: zajęta nazwa (bez względu na wielkość liter) i email → 409', async () => {
  const em = uniq('m') + '@example.org';
  const u = await newUser('dup', { email: em });
  assert.equal((await new Client().post('/api/auth/register', { username: u.username.toUpperCase(), password: PASSWORD })).status, 409);
  assert.equal((await new Client().post('/api/auth/register', { username: uniq(), password: PASSWORD, email: em.toUpperCase() })).status, 409);
});
await T('AUTH-04', 'rejestracja: nazwa/hasło/email nie-tekstowe → 400, backend działa', async () => {
  for (const b of [{ username: 12345, password: PASSWORD }, { username: { a: 1 }, password: PASSWORD }, { username: ['abc'], password: PASSWORD },
    { username: uniq(), password: 12345678 }, { username: uniq(), password: PASSWORD, email: { x: 1 } }, { username: uniq(), password: PASSWORD, strava_client_id: 5, strava_client_secret: 6 }]) {
    const r = await survives(() => new Client().post('/api/auth/register', b, { timeout: 8000 }));
    is4xx(r, JSON.stringify(b).slice(0, 50));
  }
}, { sev: 1 });
await T('AUTH-05', 'rejestracja: nazwa z HTML/za długa/znaki sterujące odrzucona', async () => {
  for (const u of ['<img src=x onerror=alert(1)>', "x');alert(1);//", 'a'.repeat(200), 'ab\ncd', 'ab\u0000cd']) {
    const r = await new Client().post('/api/auth/register', { username: u + uniq('').slice(0, 6), password: PASSWORD });
    assert.equal(r.status, 400, `nazwa ${JSON.stringify(u.slice(0, 30))} przyjęta (${r.status})`);
  }
}, { sev: 2 });
await T('AUTH-06', 'logowanie: nazwą i emailem; złe hasło i nieznane konto → to samo 401', async () => {
  const em = uniq('m') + '@example.org';
  const u = await newUser('log', { email: em });
  assert.equal((await new Client().post('/api/auth/login', { username: u.username, password: PASSWORD })).status, 200);
  assert.equal((await new Client().post('/api/auth/login', { username: em, password: PASSWORD })).status, 200);
  const bad = await new Client().post('/api/auth/login', { username: u.username, password: 'zle-haslo-9' });
  const none = await new Client().post('/api/auth/login', { username: uniq('nikt'), password: PASSWORD });
  assert.equal(bad.status, 401); assert.equal(none.status, 401); assert.equal(bad.json.error, none.json.error);
});
await T('AUTH-07', 'logowanie: dane nie-tekstowe → 4xx, backend działa', async () => {
  for (const b of [{ username: { a: 1 }, password: PASSWORD }, { username: ['a'], password: PASSWORD }, { username: 5, password: 5 }, { username: A.username, password: { x: 1 } }, { username: A.username, password: ['a'] }]) {
    const r = await survives(() => new Client().post('/api/auth/login', b, { timeout: 8000 }));
    is4xx(r, JSON.stringify(b).slice(0, 50));
  }
}, { sev: 1 });
await T('AUTH-08', 'logowanie hasłem na konto Google (bez hasła) → 401, backend działa', async () => {
  const name = uniq('goog');
  sql("INSERT INTO users (username,email,password_hash,role,oauth_provider,oauth_id) VALUES (?,?,NULL,'user','google',?)", [name, name + '@example.org', name]);
  const r = await survives(() => new Client().post('/api/auth/login', { username: name, password: PASSWORD }, { timeout: 8000 }));
  assert.equal(r.status, 401);
}, { sev: 1 });
await T('AUTH-09', '/me: brak, śmieci, zły podpis, alg=none, wygasły token → 401', async () => {
  const c = new Client();
  assert.equal((await c.get('/api/auth/me')).status, 401);
  for (const tok of ['abc', signJwt({ userId: A.id }, 'inny-sekret'), signJwt({ userId: A.id }, '', { alg: 'none', typ: 'JWT' }),
    signJwt({ userId: A.id, exp: Math.floor(Date.now() / 1000) - 10 })]) {
    c.cookie = tok; assert.equal((await c.get('/api/auth/me')).status, 401, tok.slice(0, 20));
  }
  c.cookie = signJwt({ userId: A.id }); assert.equal((await c.get('/api/auth/me')).status, 200, 'kontrola: poprawny token działa');
});
await T('AUTH-10', 'token nieistniejącego użytkownika → 401 na każdym endpoincie', async () => {
  const c = new Client(); c.cookie = signJwt({ userId: 999999 });
  const bad = [];
  for (const [m, u, b] of [['GET', '/api/auth/me'], ['GET', '/api/routes'], ['GET', '/api/tiles/all'], ['GET', '/api/stats'], ['POST', '/api/routes', routeBody('x')],
    ['POST', '/api/gpx/import', { gpxText: gpxOf([AREA, { lat: AREA.lat + 0.001, lng: AREA.lng }]) }], ['POST', '/api/tiles/blocked/toggle', { tx: 1, ty: 1 }], ['PUT', '/api/profile/layers', { layers: { a: true } }]]) {
    const r = await c.req(m, u, b); if (r.status !== 401) bad.push(`${m} ${u} → ${r.status}`);
  }
  const orphans = sql('SELECT (SELECT count(*) FROM tiles_sqi WHERE user_id=999999)+(SELECT count(*) FROM blocked_sqi WHERE user_id=999999) n')[0].n;
  sql('DELETE FROM tiles_sq WHERE user_id=999999'); sql('DELETE FROM tiles_sqi WHERE user_id=999999'); sql('DELETE FROM blocked_sqi WHERE user_id=999999');
  assert.ok(!bad.length && !orphans, `${bad.join('; ')}${orphans ? ` · osierocone wiersze w bazie: ${orphans}` : ''}`);
}, { sev: 2 });
await T('AUTH-11', 'wylogowanie czyści ciasteczko', async () => {
  const u = await newUser('out');
  const r = await u.post('/api/auth/logout');
  assert.equal(r.status, 200); assert.equal(u.cookie, null);
  assert.equal((await u.get('/api/auth/me')).status, 401);
});
await T('AUTH-12', 'zmiana hasła: złe obecne 403, słabe 400, poprawna zmiana działa', async () => {
  const u = await newUser('pw');
  assert.equal((await u.put('/api/profile/password', { current_password: 'zle-haslo-1', new_password: 'Nowe-haslo-2' })).status, 403);
  assert.equal((await u.put('/api/profile/password', { current_password: PASSWORD, new_password: 'slabe' })).status, 400);
  assert.equal((await u.put('/api/profile/password', { current_password: PASSWORD, new_password: 'Nowe-haslo-2' })).status, 200);
  assert.equal((await new Client().post('/api/auth/login', { username: u.username, password: PASSWORD })).status, 401);
  assert.equal((await new Client().post('/api/auth/login', { username: u.username, password: 'Nowe-haslo-2' })).status, 200);
});
await T('AUTH-13', 'zmiana hasła unieważnia inne sesje (drugie urządzenie)', async () => {
  const u = await newUser('pw2');
  const other = new Client(); await other.post('/api/auth/login', { username: u.username, password: PASSWORD });
  await sleep(1100);
  assert.equal((await u.put('/api/profile/password', { current_password: PASSWORD, new_password: 'Nowe-haslo-2' })).status, 200);
  assert.equal((await other.get('/api/auth/me')).status, 401, 'stara sesja na drugim urządzeniu nadal działa');
  assert.equal((await u.get('/api/auth/me')).status, 200, 'sesja, w której zmieniono hasło, ma działać dalej');
}, { sev: 2 });
await T('AUTH-14', 'usunięcie konta: złe hasło 403; po usunięciu brak danych i logowania', async () => {
  const u = await newUser('del');
  await u.post('/api/routes', routeBody('do usunięcia'));
  await u.post('/api/gpx/import', { gpxText: gpxOf([AREA, { lat: AREA.lat + 0.002, lng: AREA.lng }]) });
  await u.post('/api/tiles/blocked/toggle', { tx: 5, ty: 5 });
  assert.equal((await u.del('/api/profile', { password: 'zle-haslo-1' })).status, 403);
  const tok = u.cookie;
  assert.equal((await u.del('/api/profile', { password: PASSWORD })).status, 200);
  const left = sql(`SELECT (SELECT count(*) FROM users WHERE id=?1)+(SELECT count(*) FROM saved_routes WHERE user_id=?1)+(SELECT count(*) FROM tiles_sq WHERE user_id=?1)
    +(SELECT count(*) FROM tiles_sqi WHERE user_id=?1)+(SELECT count(*) FROM blocked_sqi WHERE user_id=?1)+(SELECT count(*) FROM activities WHERE user_id=?1) n`, [u.id])[0].n;
  assert.equal(left, 0, 'zostały wiersze użytkownika');
  assert.equal((await new Client().post('/api/auth/login', { username: u.username, password: PASSWORD })).status, 401);
  const old = new Client(); old.cookie = tok;
  assert.equal((await old.get('/api/auth/me')).status, 401);
});
await T('AUTH-15', 'stary token usuniętego konta nie tworzy danych', async () => {
  const u = await newUser('del2'); const tok = u.cookie;
  await u.del('/api/profile', { password: PASSWORD });
  const old = new Client(); old.cookie = tok;
  const r1 = await old.post('/api/gpx/import', { gpxText: gpxOf([AREA, { lat: AREA.lat + 0.002, lng: AREA.lng }]) });
  const r2 = await old.get('/api/tiles/all');
  const n = sql('SELECT (SELECT count(*) FROM tiles_sq WHERE user_id=?1)+(SELECT count(*) FROM tiles_sqi WHERE user_id=?1) n', [u.id])[0].n;
  sql('DELETE FROM tiles_sq WHERE user_id=?', [u.id]); sql('DELETE FROM tiles_sqi WHERE user_id=?', [u.id]);
  assert.ok(r1.status === 401 && r2.status === 401 && n === 0, `import → ${r1.status}, kafelki → ${r2.status}, osierocone wiersze: ${n}`);
}, { sev: 2 });
await T('AUTH-16', 'limit prób logowania na adres (11. próba → 429), inne adresy bez wpływu', async () => {
  const c = new Client(); let last;
  for (let i = 0; i < 11; i++) last = await c.post('/api/auth/login', { username: uniq('x'), password: 'zle-haslo-1' });
  assert.equal(last.status, 429);
  assert.equal((await new Client().post('/api/auth/login', { username: A.username, password: PASSWORD })).status, 200);
});
await T('AUTH-17', 'limit rejestracji na adres (6. → 429)', async () => {
  const ip = '10.250.0.' + (1 + Math.floor(Math.random() * 250)); let last;
  for (let i = 0; i < 6; i++) last = await new Client(ip).post('/api/auth/register', { username: uniq('rl'), password: PASSWORD });
  assert.equal(last.status, 429);
});
await T('AUTH-18', 'jedyny administrator nie może usunąć swojego konta', async () => {
  const r = await admin.del('/api/profile', { password: ENV.SQ_TEST_ADMIN_PASSWORD });
  assert.equal(r.status, 400); assert.equal((await admin.get('/api/auth/me')).status, 200);
});
await T('AUTH-19', 'set-password działa tylko dla konta bez hasła', async () => {
  assert.equal((await A.put('/api/profile/set-password', { new_password: 'Inne-haslo-3' })).status, 400);
});
await T('AUTH-20', 'równoczesna rejestracja tej samej nazwy: jedno 200, reszta 409 (nie 500)', async () => {
  const name = uniq('race');
  const rs = await Promise.all(Array.from({ length: 6 }, () => new Client().post('/api/auth/register', { username: name, password: PASSWORD })));
  const codes = rs.map(r => r.status).sort().join(',');
  assert.equal(rs.filter(r => r.status === 200).length, 1, codes);
  assert.ok(rs.every(r => r.status === 200 || r.status === 409), codes);
  assert.equal(sql('SELECT count(*) n FROM users WHERE username=?', [name])[0].n, 1);
}, { sev: 3 });

// ═════════════════════════ MU: several users at once ════════════════════════
const p0 = AREA, pA = { lat: 52.20, lng: 21.05 }, pB = { lat: 52.05, lng: 21.40 };
await T('MU-01', 'trasy: B nie widzi, nie pobierze, nie zmieni i nie usunie trasy A', async () => {
  const id = (await A.post('/api/routes', routeBody('Tajna trasa A'))).json.id;
  assert.ok(id > 0);
  assert.equal((await B.get('/api/routes')).json.length, 0);
  for (const [m, u, b] of [['GET', `/api/routes/${id}`], ['GET', `/api/routes/${id}/gpx`], ['PATCH', `/api/routes/${id}`, { name: 'przejęta' }], ['DELETE', `/api/routes/${id}`]])
    assert.equal((await B.req(m, u, b)).status, 404, `${m} ${u}`);
  for (const [m, u] of [['GET', `/api/routes/${id}`], ['GET', `/api/routes/${id}/gpx`], ['GET', '/api/routes']]) assert.equal((await anon.req(m, u)).status, 401);
  const mine = await A.get(`/api/routes/${id}`);
  assert.equal(mine.status, 200); assert.equal(mine.json.name, 'Tajna trasa A');
});
await T('MU-02', 'kwadraty: import A nie zmienia kwadratów ani statystyk B i C', async () => {
  const r = await A.post('/api/gpx/import', { gpxText: gpxOf([pA, { lat: pA.lat + 0.01, lng: pA.lng + 0.01 }]) });
  assert.equal(r.status, 200); assert.ok(r.json.newSQI > 0);
  const a = (await A.get('/api/tiles/all')).json, b = (await B.get('/api/tiles/all')).json, c = (await C.get('/api/stats')).json;
  assert.ok(a.sqi.length > 0 && a.stats.sqi === a.sqi.length);
  assert.equal(b.sq.length + b.sqi.length, 0); assert.equal(c.sq + c.sqi, 0);
  const tA = tileOf(pA.lat, pA.lng, 17);
  assert.ok(a.sqi.some(x => x.tx === tA.x && x.ty === tA.y), 'kafelek startu jest u A');
});
await T('MU-03', 'ta sama trasa: dla A 0 nowych, dla B nowe (podgląd liczy z własnych kwadratów)', async () => {
  const coords = [pA, { lat: pA.lat + 0.01, lng: pA.lng + 0.01 }];
  const a = (await A.post('/api/route/preview-tiles', { coords })).json, b = (await B.post('/api/route/preview-tiles', { coords })).json;
  assert.equal(a.countSQI, 0); assert.ok(b.countSQI > 0);
});
await T('MU-04', 'zablokowane SQI są osobne dla każdego konta', async () => {
  const tl = tileOf(pB.lat, pB.lng, 17);
  assert.equal((await A.post('/api/tiles/blocked/toggle', { tx: tl.x, ty: tl.y })).json.blocked, true);
  assert.equal((await B.get('/api/tiles/all')).json.blockedSqi.length, 0);
  assert.equal((await B.post('/api/tiles/blocked/toggle', { tx: tl.x, ty: tl.y })).json.blocked, true, 'B blokuje ten sam kafelek niezależnie');
  assert.equal((await A.post('/api/tiles/blocked/toggle', { tx: tl.x, ty: tl.y })).json.blocked, false);
  assert.equal((await B.get('/api/tiles/all')).json.blockedSqi.length, 1, 'odblokowanie u A nie rusza B');
  await B.post('/api/tiles/blocked/toggle', { tx: tl.x, ty: tl.y });
});
await T('MU-05', 'dom, warstwy i klucz Garmin są osobne', async () => {
  await A.put('/api/profile/home', { lat: 52.1, lng: 21.2 });
  await A.put('/api/profile/layers', { layers: { sqi: false, prio: true } });
  const ka = (await A.post('/api/profile/garmin-key')).json.key, kb = (await B.post('/api/profile/garmin-key')).json.key;
  const b = (await B.get('/api/auth/me')).json, a = (await A.get('/api/auth/me')).json;
  assert.equal(b.home_lat, null); assert.equal(b.layers, null);
  assert.equal(a.home_lat, 52.1); assert.deepEqual(a.layers, { sqi: false, prio: true });
  assert.notEqual(ka, kb); assert.equal((await B.get('/api/profile/garmin-key')).json.key, kb);
});
await T('MU-06', 'Garmin: klucz A pokazuje kwadraty A, klucz B — B; zły klucz 401; nowy klucz unieważnia stary', async () => {
  const ka = (await A.get('/api/profile/garmin-key')).json.key, kb = (await B.get('/api/profile/garmin-key')).json.key;
  const q = k => anon.get(`/api/garmin/area?key=${k}&lat=${pA.lat}&lng=${pA.lng}`);
  const a = (await q(ka)).json, b = (await q(kb)).json;
  assert.ok(a.tot.sqi > 0 && /[1-9a-f]/.test(a.sqi)); assert.equal(b.tot.sqi, 0); assert.ok(!/[1-9a-f]/.test(b.sqi));
  assert.equal(a.sqi.length, 48 * 48 / 4); assert.equal(a.sq.length, 12 * 12 / 4);
  const bit = (hex, n, x, y) => { const i = y * n + x; return (parseInt(hex.substr((i >> 3) * 2, 2), 16) >> (7 - (i & 7))) & 1; };
  const tl = tileOf(pA.lat, pA.lng, 17);
  assert.equal(bit(a.sqi, 48, tl.x - a.ix, tl.y - a.iy), 1, 'bit kafelka, na którym stoi kolarz');
  assert.equal((await q('zly')).status, 401); assert.equal((await anon.get(`/api/garmin/area?lat=1&lng=1`)).status, 401);
  assert.equal((await anon.get(`/api/garmin/area?key=${ka}&lat=x&lng=y`)).status, 400);
  await A.post('/api/profile/garmin-key');
  assert.equal((await q(ka)).status, 401, 'stary klucz po wygenerowaniu nowego');
});
await T('MU-07', 'sekret Strava nie wraca w żadnej odpowiedzi (profil, lista admina)', async () => {
  const secret = 'SEKRET' + uniq('');
  const r = await A.put('/api/profile/strava', { strava_client_id: '12345', strava_client_secret: secret });
  assert.equal(r.status, 200); assert.equal(r.json.user.strava_configured, true); assert.equal(r.json.user.strava_own_keys, true);
  for (const x of [r, await A.get('/api/auth/me'), await admin.get('/api/admin/users')]) assert.ok(!x.text.includes(secret), 'sekret w odpowiedzi');
  assert.equal((await B.get('/api/auth/me')).json.strava_own_keys, false);
  assert.equal((await A.put('/api/profile/strava', {})).json.user.strava_own_keys, false);
});
await T('MU-08', 'panel admina: zwykły użytkownik 403, niezalogowany 401', async () => {
  for (const [m, u, b] of [['GET', '/api/admin/users'], ['PUT', `/api/admin/users/${B.id}/role`, { role: 'admin' }], ['PUT', `/api/admin/users/${A.id}/role`, { role: 'admin' }], ['DELETE', `/api/admin/users/${B.id}`], ['GET', '/api/log']]) {
    assert.equal((await A.req(m, u, b)).status, 403, `${m} ${u} jako użytkownik`);
    assert.equal((await anon.req(m, u, b)).status, 401, `${m} ${u} bez logowania`);
  }
  assert.equal((await A.get('/api/auth/me')).json.role, 'user'); assert.equal((await B.get('/api/auth/me')).status, 200);
}, { sev: 1 });
await T('MU-09', 'admin: lista bez haseł; nadanie i odebranie roli; własnej roli i konta nie ruszy', async () => {
  const l = await admin.get('/api/admin/users');
  assert.equal(l.status, 200); assert.ok(l.json.users.length >= 4); assert.ok(!/password|secret|garmin_key/.test(l.text));
  const u = await newUser('prom');
  assert.equal((await admin.put(`/api/admin/users/${u.id}/role`, { role: 'admin' })).status, 200);
  assert.equal((await u.get('/api/admin/users')).status, 200, 'nowy admin ma dostęp od razu');
  assert.equal((await admin.put(`/api/admin/users/${u.id}/role`, { role: 'user' })).status, 200);
  assert.equal((await u.get('/api/admin/users')).status, 403, 'po odebraniu roli dostęp znika od razu');
  assert.equal((await admin.put(`/api/admin/users/${u.id}/role`, { role: 'root' })).status, 400);
  assert.equal((await admin.put(`/api/admin/users/${admin.id}/role`, { role: 'user' })).status, 400);
  assert.equal((await admin.del(`/api/admin/users/${admin.id}`)).status, 400);
});
await T('MU-10', 'admin usuwa użytkownika: dane znikają, jego sesja przestaje działać', async () => {
  const u = await newUser('kick'); await u.post('/api/routes', routeBody('x'));
  assert.equal((await admin.del(`/api/admin/users/${u.id}`)).status, 200);
  assert.equal(sql('SELECT (SELECT count(*) FROM users WHERE id=?1)+(SELECT count(*) FROM saved_routes WHERE user_id=?1) n', [u.id])[0].n, 0);
  const r = await u.get('/api/routes');
  assert.equal(r.status, 401, 'sesja usuniętego użytkownika nadal działa: ' + r.status);
}, { sev: 2 });
await T('MU-11', 'admin: nieistniejący użytkownik → 404, nie „ok”', async () => {
  assert.equal((await admin.del('/api/admin/users/999999')).status, 404);
  assert.equal((await admin.put('/api/admin/users/999999/role', { role: 'user' })).status, 404);
  assert.equal((await admin.put('/api/admin/users/abc/role', { role: 'user' })).status, 404);
}, { sev: 4 });
await T('MU-12', 'admin może czytać dziennik błędów przeglądarek (/api/log)', async () => {
  await A.post('/api/log', { level: 'error', msg: 'test-log-' + A.username });
  const r = await admin.get('/api/log?n=20');
  assert.equal(r.status, 200, 'HTTP ' + r.status); assert.ok(r.json.some(e => e.msg.includes(A.username)));
}, { sev: 3 });
await T('MU-13', 'równoległa praca 3 kont (60 żądań): każdy kończy z własnymi danymi', async () => {
  const users = [await newUser('par'), await newUser('par'), await newUser('par')];
  const jobs = [];
  users.forEach((u, k) => {
    const base = { lat: 51.5 + k * 0.3, lng: 20.0 + k * 0.3 };
    for (let i = 0; i < 8; i++) jobs.push(u.post('/api/routes', routeBody(`${u.username}-${i}`)));
    for (let i = 0; i < 6; i++) jobs.push(u.post('/api/tiles/blocked/toggle', { tx: 70000 + k * 100 + i, ty: 40000 }));
    for (let i = 0; i < 6; i++) jobs.push(u.post('/api/gpx/import', { gpxText: gpxOf([{ lat: base.lat + i * 0.01, lng: base.lng }, { lat: base.lat + i * 0.01 + 0.004, lng: base.lng }]) }));
  });
  const rs = await Promise.all(jobs);
  assert.ok(rs.every(r => r.status === 200), 'kody: ' + [...new Set(rs.map(r => r.status))].join(','));
  for (const [k, u] of users.entries()) {
    const routes = (await u.get('/api/routes')).json, all = (await u.get('/api/tiles/all')).json;
    assert.equal(routes.length, 8); assert.ok(routes.every(r => r.name.startsWith(u.username)), 'cudza trasa na liście');
    assert.equal(all.blockedSqi.length, 6); assert.ok(all.blockedSqi.every(b => b.tx >= 70000 + k * 100 && b.tx < 70000 + k * 100 + 6));
    const lat0 = 51.5 + k * 0.3;
    assert.ok(all.sqi.length > 0 && all.sqi.every(s => { const c = tileCenter(s.tx, s.ty, 17); return Math.abs(c.lat - lat0) < 0.1; }), 'cudze kwadraty');
    assert.equal(all.stats.sqi, all.sqi.length);
  }
}, { sev: 1 });
await T('MU-14', 'dwie sesje jednego konta widzą te same dane', async () => {
  const u = await newUser('two'); const s2 = new Client(); await s2.post('/api/auth/login', { username: u.username, password: PASSWORD });
  const id = (await u.post('/api/routes', routeBody('z telefonu'))).json.id;
  assert.ok((await s2.get('/api/routes')).json.some(r => r.id === id));
  await s2.post('/api/gpx/import', { gpxText: gpxOf([pB, { lat: pB.lat + 0.003, lng: pB.lng }]) });
  assert.ok((await u.get('/api/stats')).json.sqi > 0, 'statystyki w pierwszej sesji odświeżone po imporcie w drugiej');
});
await T('MU-15', 'synchronizacja bez Stravy: błąd tylko dla tego konta, status osobny', async () => {
  const r = await A.post('/api/sync');
  assert.match(r.text, /"phase":"error"/); assert.match(r.text, /Brak autoryzacji Strava/);
  const sa = (await A.get('/api/sync/status')).json, sb = (await B.get('/api/sync/status')).json;
  assert.equal(sa.connected, false); assert.ok(sa.last?.error); assert.equal(sb.last, null);
});
await T('MU-16', 'wspólna pamięć zdjęć: wpis jednego konta nie przemyci HTML ani obcych adresów do innych', async () => {
  const pid = 900000000 + Math.floor(Math.random() * 1e6);
  const cell = `${Math.floor(pA.lat / 0.02)},${Math.floor(pA.lng / 0.03)}`;
  const s = await A.post('/api/photos/cell', { cell, hits: [
    { pageid: pid, lat: pA.lat, lng: pA.lng, title: 'File:<img src=x onerror=alert(1)>.jpg' }, { pageid: pid + 1, lat: pA.lat, lng: pA.lng, title: 'File:Dobre zdjęcie.jpg' },
    { pageid: pid + 2, lat: pA.lat, lng: pA.lng, title: 'nie-plik' }, { pageid: 'x', lat: 'a', lng: 'b', title: 'File:a.jpg' }] });
  assert.equal(s.status, 200);
  await A.post('/api/photos/info', { items: [
    { pageid: pid + 1, thumb: 'https://evil.example/x.jpg', page: 'https://commons.wikimedia.org/wiki/File:A.jpg', author: 'x' },
    { pageid: pid + 1, thumb: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/A.jpg', page: 'javascript:alert(1)', author: 'x' },
    { pageid: pid, thumb: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/A.jpg" onerror="alert(1)', page: 'https://commons.wikimedia.org/wiki/File:A.jpg', author: '<b>x</b>' }] });
  const r = await B.post('/api/photos/route', { cells: [cell], samples: [pA, { lat: pA.lat + 0.001, lng: pA.lng }] });
  assert.equal(r.status, 200);
  const mine = r.json.files.filter(f => f.pageid >= pid && f.pageid <= pid + 3);
  sql('SELECT 1'); // photos live in their own database; rows are harmless test data
  assert.ok(mine.every(f => !/[<>"]/.test(f.title)), 'tytuł z HTML trafił do innego użytkownika: ' + mine.map(f => f.title).join(' | '));
  assert.ok(mine.every(f => !f.thumb && !f.page), 'przyjęto niedozwolony adres');
}, { sev: 2 });

// ═════════════════════════ FN: features through the API ═════════════════════
let rid;
await T('FN-01', 'trasa: zapis i odczyt zachowują wszystkie pola (nazwy punktów, profil, wysokości)', async () => {
  const body = routeBody('Pętla Żółć → „Świder” 🚴', { loop: true, mode: 'prio', profile: 'gravel',
    waypoints: [{ type: 'start', lat: 52.1, lng: 21.2, label: 'Dom', name: 'Zażółć gęślą jaźń' }, { type: 'mid', lat: 52.11, lng: 21.21, name: 'Sklep & <bar>' }, { type: 'end', lat: 52.12, lng: 21.22 }],
    elevProfile: [[0, 100], [1, 120]], surfaceProfile: [{ s: 'asphalt', km: 2 }] });
  const r = await A.post('/api/routes', body); assert.equal(r.status, 200); rid = r.json.id;
  const g = (await A.get(`/api/routes/${rid}`)).json;
  assert.equal(g.name, body.name); assert.equal(g.is_loop, 1); assert.equal(g.mode, 'prio'); assert.equal(g.profile, 'gravel');
  assert.deepEqual(g.waypoints, body.waypoints); assert.deepEqual(g.elev_profile, body.elevProfile); assert.deepEqual(g.surface_profile, body.surfaceProfile);
  assert.equal(g.coords.length, body.coords.length); assert.equal(g.distance_km, 3.2); assert.equal(g.new_sqi, 7);
});
await T('FN-02', 'lista tras: najnowsza pierwsza, miniatura i przewyższenie', async () => {
  const l = (await A.get('/api/routes')).json;
  assert.equal(l[0].id, rid); assert.ok(l[0].thumb.split(' ').length >= 2); assert.ok(l[0].ascent_m >= 15, 'przewyższenie ' + l[0].ascent_m);
  assert.ok(!('coords' in l[0]), 'lista nie powinna nieść geometrii');
});
await T('FN-03', 'GPX: poprawny XML, nazwy z &<>" zabezpieczone, punkty nazwane jako <wpt>', async () => {
  const r = await A.get(`/api/routes/${rid}/gpx`);
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /gpx\+xml/);
  assert.equal(xmlWellFormed(r.text), null);
  assert.match(r.text, /<wpt lat="52\.110000" lon="21\.210000"><name>Sklep &amp; &lt;bar&gt;<\/name><\/wpt>/);
  assert.equal((r.text.match(/<trkpt /g) || []).length, 20); assert.equal((r.text.match(/<wpt /g) || []).length, 2);
  assert.match(r.headers.get('content-disposition'), /filename="[A-Za-z0-9 _.-]+\.gpx"/);
});
await T('FN-04', 'zmiana nazwy trasy: przycinanie do 80 znaków, pusta → 400', async () => {
  assert.equal((await A.patch(`/api/routes/${rid}`, { name: '   ' })).status, 400);
  const r = await A.patch(`/api/routes/${rid}`, { name: 'x'.repeat(200) });
  assert.equal(r.json.name.length, 80); assert.equal((await A.get(`/api/routes/${rid}`)).json.name.length, 80);
});
await T('FN-05', 'usunięcie trasy: znika z listy, drugi raz 404', async () => {
  assert.equal((await A.del(`/api/routes/${rid}`)).status, 200);
  assert.equal((await A.del(`/api/routes/${rid}`)).status, 404); assert.equal((await A.get(`/api/routes/${rid}`)).status, 404);
});
await T('FN-06', 'kwadraty 5×5: 25 SQ, Yard 9, Übersquadrat 5', async () => {
  const u = await newUser('sq'); const o = tileOf(51.0, 19.0, 14); const pts = [];
  for (let y = 0; y < 5; y++) for (let i = 0; i < 5; i++) { const x = y % 2 ? 4 - i : i; pts.push(tileCenter(o.x + x, o.y + y, 14)); }
  const r = await u.post('/api/gpx/import', { gpxText: gpxOf(pts) });
  assert.equal(r.json.totalSQ, 25);
  const all = (await u.get('/api/tiles/all')).json;
  assert.equal(all.stats.sq, 25); assert.equal(all.stats.yard.size, 9); assert.equal(all.stats.uber.size, 5);
  assert.equal((await u.get('/api/tiles/yard')).json.size, 9); assert.equal((await u.get('/api/tiles/uber')).json.size, 5);
  const again = await u.post('/api/gpx/import', { gpxText: gpxOf(pts) });
  assert.equal(again.json.totalSQ, 25, 'ponowny import nie dubluje');
  assert.equal(again.json.newSQ, 0, `ponowny import zgłasza „nowe”: ${again.json.newSQ}`);
}, { sev: 3 });
await T('FN-07', 'kwadraty w prostokącie (bbox) = filtr pełnej listy', async () => {
  const all = (await A.get('/api/tiles/sqi')).json; const tl = tileOf(pA.lat, pA.lng, 17);
  const box = (await A.get(`/api/tiles/sqi?x0=${tl.x}&x1=${tl.x + 3}&y0=${tl.y - 3}&y1=${tl.y}`)).json;
  const exp = all.filter(s => s.tx >= tl.x && s.tx <= tl.x + 3 && s.ty >= tl.y - 3 && s.ty <= tl.y);
  assert.equal(box.length, exp.length); assert.ok(box.length > 0);
});
await T('FN-08', 'zablokowany SQI: nie liczy się jako nowy; zdobytego nie da się zablokować (409)', async () => {
  const u = await newUser('blk'); const a = { lat: 51.2, lng: 19.5 }, b = { lat: 51.2, lng: 19.51 };
  const before = (await u.post('/api/route/preview-tiles', { coords: [a, b] })).json;
  const tl = before.newSQI[0];
  assert.equal((await u.post('/api/tiles/blocked/toggle', tl)).json.blocked, true);
  const after = (await u.post('/api/route/preview-tiles', { coords: [a, b] })).json;
  assert.equal(after.countSQI, before.countSQI - 1);
  await u.post('/api/gpx/import', { gpxText: gpxOf([a, b]) });
  assert.equal((await u.post('/api/tiles/blocked/toggle', before.newSQI[1])).status, 409);
  assert.equal((await u.get('/api/tiles/all')).json.blockedSqi.length, 0, 'po zdobyciu kafelek przestaje być zablokowany');
  const bulk = await u.post('/api/tiles/blocked/bulk', { tiles: [[1, 1], [1, 2], [1, 1], [before.newSQI[1].tx, before.newSQI[1].ty]] });
  assert.equal(bulk.json.added, 2);
});
await T('FN-09', 'priorytety i statystyka zasięgu odpowiadają dla konta z domem i bez', async () => {
  for (const u of [A, B]) {
    const p = await u.get('/api/tiles/priority'); assert.equal(p.status, 200); assert.ok(Array.isArray(p.json.tiles));
    const s = await u.get(`/api/tiles/reach-stats?lat=${AREA.lat}&lng=${AREA.lng}&r=5`); assert.equal(s.status, 200);
  }
});
await T('FN-09b', 'statystyka zasięgu: wynik zapamiętany, ale po zebraniu nowych kwadratów liczony od nowa i osobno dla każdego konta', async () => {
  const u = await newUser('reach'), v = await newUser('reach');
  const q = `/api/tiles/reach-stats?lat=${AREA.lat + 0.3}&lng=${AREA.lng + 0.3}&r=5`;
  const s1 = (await u.get(q)).json, s2 = (await u.get(q)).json;
  assert.deepEqual(s1, s2, 'drugi raz ten sam wynik');
  if (!s1.available) return;
  const p = { lat: AREA.lat + 0.3, lng: AREA.lng + 0.3 };
  const imp = await u.post('/api/gpx/import', { gpxText: gpxOf([p, { lat: p.lat + 0.004, lng: p.lng }]) });
  assert.equal(imp.status, 200);
  const s3 = (await u.get(q)).json;
  assert.ok(s3.owned > s1.owned, `po imporcie przybywa zebranych: ${s1.owned} → ${s3.owned}`);
  assert.equal(s3.owned + s3.open + s3.noRoad + s3.blocked + s3.unknown, s1.owned + s1.open + s1.noRoad + s1.blocked + s1.unknown, 'suma kwadratów w kole bez zmian');
  const other = (await v.get(q)).json;
  assert.equal(other.owned, 0, 'drugie konto nie widzi cudzych kwadratów');
  // different radius → different answer, not the remembered one
  const wide = (await u.get(q.replace('r=5', 'r=8'))).json;
  assert.ok(wide.r === 8 && wide.owned + wide.open + wide.noRoad + wide.unknown > s3.owned + s3.open + s3.noRoad + s3.unknown);
});
await T('MU-17', 'więcej aktywnych kont niż mieści pamięć podręczna (40): dane każdego nadal poprawne i osobne', async () => {
  const us = [];
  for (let i = 0; i < 46; i++) {
    const u = await newUser('lru');
    const p = { lat: AREA.lat - 0.5 - i * 0.02, lng: AREA.lng + 0.5 };
    const r = await u.post('/api/gpx/import', { gpxText: gpxOf([p, { lat: p.lat + 0.0005 * (i + 1), lng: p.lng }]) });
    assert.equal(r.status, 200);
    us.push({ u, sqi: (await u.get('/api/stats')).json.sqi });
  }
  // the first accounts were pushed out of memory by the later ones
  for (const { u, sqi } of us) {
    const all = (await u.get('/api/tiles/all')).json;
    assert.equal(all.stats.sqi, sqi, `${u.username}: liczba kwadratów po ponownym wczytaniu`);
    assert.equal(all.sqi.length, sqi);
  }
  assert.ok(new Set(us.map(x => x.sqi)).size > 5, 'konta mają różne liczby kwadratów (test rozróżnia konta)');
});
let brouter = true;
await T('FN-10', 'odcinek rysowany (/route/leg): geometria po drogach, sensowna długość', async () => {
  const a = { lat: 52.135, lng: 21.225 }, b = { lat: 52.145, lng: 21.235 };
  const r = await A.post('/api/route/leg', { from: a, to: b, bikeProfile: 'gravel' });
  if (r.status === 502) { brouter = false; throw new Error('BRouter niedostępny: ' + r.text.slice(0, 100)); }
  assert.equal(r.status, 200);
  const c = r.json.routes[0].geometry.coordinates; assert.ok(c.length > 5);
  const km = r.json.routes[0].distance / 1000; assert.ok(km > 1.2 && km < 4, 'km=' + km);
  assert.ok(Math.abs(c[0][1] - a.lat) < 0.003 && Math.abs(c.at(-1)[1] - b.lat) < 0.003, 'końce przy punktach');
});
await T('FN-11', 'trasa A→B „najkrótsza” oraz z celem km (objazd po nowe kwadraty)', async () => {
  if (!brouter) throw new Error('BRouter niedostępny');
  const w = [{ lat: 52.135, lng: 21.225 }, { lat: 52.150, lng: 21.250 }];
  const s = await A.post('/api/route/detour', { waypoints: w, mode: 'shortest' }); assert.equal(s.status, 200);
  const base = s.json.routes[0].distance / 1000;
  const d = await A.post('/api/route/detour', { waypoints: w, mode: 'sqi', targetKm: Math.round(base * 2.5) }, { timeout: 120000 });
  assert.equal(d.status, 200); const km = d.json.routes[0].distance / 1000;
  assert.ok(km > base * 1.3, `objazd ${km.toFixed(1)} km przy bazie ${base.toFixed(1)} i celu ${Math.round(base * 2.5)}`);
  return `baza ${base.toFixed(1)} km, z celem ${Math.round(base * 2.5)} → ${km.toFixed(1)} km`;
});
await T('FN-12', 'pętla z jednego punktu na ~20 km: wraca na start, długość ±25%', async () => {
  if (!brouter) throw new Error('BRouter niedostępny');
  const r = await A.post('/api/route/detour', { waypoints: [{ lat: 52.14, lng: 21.23 }], loop: true, targetKm: 20, mode: 'sqi' }, { timeout: 180000 });
  assert.equal(r.status, 200, r.text.slice(0, 120));
  const c = r.json.routes[0].geometry.coordinates, km = r.json.routes[0].distance / 1000;
  assert.ok(Math.hypot(c[0][0] - c.at(-1)[0], c[0][1] - c.at(-1)[1]) < 0.003, 'pętla się nie zamyka');
  assert.ok(km > 15 && km < 25, 'km=' + km.toFixed(1));
  return `${km.toFixed(1)} km`;
});
await T('FN-13', 'POI wzdłuż trasy z lokalnej bazy', async () => {
  const coords = line({ lat: 52.13, lng: 21.22 }, { lat: 52.15, lng: 21.26 }, 30).map(c => ({ lat: c[0], lng: c[1] }));
  const r = await A.post('/api/route/pois', { coords, radiusM: 400 });
  if (r.status === 503) return 'brak lokalnej bazy POI w tym środowisku';
  assert.equal(r.status, 200); assert.ok(r.json.elements.length > 0); assert.ok(r.json.elements.every(e => e.tags && Number.isFinite(e.lat)));
  return `${r.json.elements.length} miejsc`;
});

// ═════════════════════════ VAL: bad input ═══════════════════════════════════
const junk = [null, 'tekst', 12, [], {}, [null], [[null, null]], [{ lat: 'a', lng: 'b' }], [{ lat: 1e400, lng: 5 }], { lat: 52, lng: 21 }];
async function fuzz(id, title, method, url, mk, o) {
  await T(id, title, async () => {
    const bad = [];
    for (const j of junk) {
      const body = mk(j);
      const r = await survives(() => A.req(method, url, body, { timeout: 20000 }));
      if (r.status >= 500) bad.push(`${JSON.stringify(j)} → ${r.status} ${r.text.slice(0, 60)}`);
    }
    assert.ok(!bad.length, bad.slice(0, 4).join(' ; '));
  }, o);
}
await fuzz('VAL-01', 'zapis trasy: śmieciowe współrzędne nie dają błędu 500', 'POST', '/api/routes', j => routeBody('fuzz', { coords: Array.isArray(j) && j.length ? [...j, ...j] : j }));
await fuzz('VAL-02', 'zapis trasy: śmieciowe punkty trasy nie dają błędu 500', 'POST', '/api/routes', j => routeBody('fuzz', { waypoints: j }));
await T('VAL-03', 'trasa ze śmieciowymi punktami nie psuje potem listy ani GPX', async () => {
  const u = await newUser('junk');
  for (const wp of [[null], ['a'], [{ name: 5 }], [{ name: 'x' }], [{ name: 'x', lat: 'a', lng: {} }]]) await u.post('/api/routes', routeBody('j', { waypoints: wp }));
  await u.post('/api/routes', routeBody('j', { coords: [['a', 'b'], [null, null]] }));
  const l = await u.get('/api/routes'); no5xx(l, 'lista');
  for (const r of l.json || []) {
    const gx = await u.get(`/api/routes/${r.id}/gpx`); no5xx(gx, `gpx ${r.id}`);
    if (gx.status === 200) assert.ok(!/NaN/.test(gx.text), 'GPX z NaN');
    assert.ok(!/NaN/.test(r.thumb), 'miniatura z NaN');
  }
});
await T('VAL-04', 'zapis trasy: limity (nazwa, >50 tys. punktów, wielkość dodatków, liczba punktów trasy)', async () => {
  assert.equal((await A.post('/api/routes', routeBody(''))).status, 400);
  assert.equal((await A.post('/api/routes', routeBody('x', { coords: [[1, 1, 0]] }))).status, 400);
  assert.equal((await A.post('/api/routes', routeBody('x', { coords: Array.from({ length: 50001 }, () => [52, 21, 0]) }))).status, 400);
  const big = 'x'.repeat(300000);
  const r = await A.post('/api/routes', routeBody('wielka', { waypoints: [{ type: 'start', lat: 52, lng: 21, name: big, extra: big }], elevProfile: { junk: big } }));
  if (r.status === 200) {
    const g = (await A.get(`/api/routes/${r.json.id}`)); await A.del(`/api/routes/${r.json.id}`);
    assert.ok(g.text.length < 100000, `konto może zapisać w trasie dowolne dane: ${Math.round(g.text.length / 1024)} kB w jednej trasie`);
  }
}, { sev: 3 });
await fuzz('VAL-05', 'odcinek (/route/leg): złe punkty → 4xx', 'POST', '/api/route/leg', j => ({ from: j, to: j }));
await T('VAL-06', 'odcinek: brak punktów, szerokość 999, >300 km → 400', async () => {
  assert.equal((await A.post('/api/route/leg', {})).status, 400);
  assert.equal((await A.post('/api/route/leg', { from: { lat: 999, lng: 21 }, to: AREA })).status, 400);
  assert.equal((await A.post('/api/route/leg', { from: { lat: 50, lng: 19 }, to: { lat: 54, lng: 19 } })).status, 400);
});
await fuzz('VAL-07', 'planowanie (/route/detour): złe punkty → 4xx, nie 500', 'POST', '/api/route/detour', j => ({ waypoints: j, mode: 'shortest' }), { sev: 3 });
await T('VAL-08', 'planowanie: absurdalny cel km i setki punktów są odrzucane od razu', async () => {
  const t0 = Date.now();
  const r1 = await A.post('/api/route/detour', { waypoints: [AREA], loop: true, targetKm: 1e7, mode: 'sqi' }, { timeout: 60000 }).catch(e => ({ status: 0, text: e.message }));
  const r2 = await A.post('/api/route/detour', { waypoints: Array.from({ length: 500 }, (_, i) => ({ lat: 52 + i * 1e-4, lng: 21 })), mode: 'shortest' }, { timeout: 60000 }).catch(e => ({ status: 0, text: e.message }));
  await ensureUp();
  assert.ok(r1.status === 400 || r1.status === 422, `cel 10 mln km → ${r1.status} po ${Date.now() - t0} ms`);
  assert.equal(r2.status, 400, '500 punktów → ' + r2.status);
}, { sev: 3 });
await fuzz('VAL-09', 'blokowanie SQI: złe dane → 4xx', 'POST', '/api/tiles/blocked/toggle', j => ({ tx: j, ty: j }));
await fuzz('VAL-10', 'blokowanie hurtowe: złe dane → 4xx', 'POST', '/api/tiles/blocked/bulk', j => ({ tiles: j }));
await T('VAL-11', 'blokowanie hurtowe: 0 i >20 000 → 400; kafelek spoza świata odrzucony', async () => {
  assert.equal((await A.post('/api/tiles/blocked/bulk', { tiles: [] })).status, 400);
  assert.equal((await A.post('/api/tiles/blocked/bulk', { tiles: Array.from({ length: 20001 }, (_, i) => [i, 1]) })).status, 400);
  const r = await A.post('/api/tiles/blocked/toggle', { tx: -5, ty: 1e12 });
  if (r.status === 200) await A.post('/api/tiles/blocked/toggle', { tx: -5, ty: 1e12 });
  assert.equal(r.status, 400, 'kafelek tx=-5, ty=1e12 przyjęty');
}, { sev: 4 });
await T('VAL-12', 'dom: tekst, brak długości, poza zakresem → 400; null czyści', async () => {
  assert.equal((await A.put('/api/profile/home', { lat: '52', lng: '21' })).status, 400);
  assert.equal((await A.put('/api/profile/home', { lat: 52 })).status, 400);
  const far = await A.put('/api/profile/home', { lat: 5000, lng: -9000 });
  assert.equal((await A.put('/api/profile/home', { lat: null, lng: null })).json.user.home_lat, null);
  assert.equal(far.status, 400, 'lat=5000 przyjęte');
}, { sev: 4 });
await T('VAL-13', 'warstwy: tylko {nazwa: true/false}; reszta odfiltrowana lub 400', async () => {
  assert.equal((await A.put('/api/profile/layers', { layers: [1] })).status, 400);
  assert.equal((await A.put('/api/profile/layers', {})).status, 400);
  await A.put('/api/profile/layers', { layers: { ok: true, 'Zła Nazwa': true, x: 'tak', '<b>': false } });
  assert.deepEqual((await A.get('/api/auth/me')).json.layers, { ok: true });
});
await T('VAL-14', 'import GPX: brak treści, brak punktów, złe liczby → 400 (nie 500)', async () => {
  assert.equal((await A.post('/api/gpx/import', {})).status, 400);
  assert.equal((await A.post('/api/gpx/import', { gpxText: '<gpx></gpx>' })).status, 400);
  const before = (await A.get('/api/stats')).json;
  for (const g of ['<trkpt lat="abc" lon="def"></trkpt><trkpt lat="x" lon="y"></trkpt>', '<trkpt lat="999" lon="999"></trkpt><trkpt lat="-999" lon="5"></trkpt>', { a: 1 }, 12345]) {
    const r = await survives(() => A.post('/api/gpx/import', { gpxText: g }, { timeout: 20000 }));
    is4xx(r, JSON.stringify(g).slice(0, 40));
  }
  assert.deepEqual((await A.get('/api/stats')).json, before, 'zły plik zmienił statystyki');
}, { sev: 3 });
await T('VAL-15', 'import KML: pusty i śmieciowy plik → 4xx', async () => {
  assert.equal((await A.post('/api/squadrats/import-kml', '', { raw: true, headers: { 'Content-Type': 'text/plain' } })).status, 400);
  const r = await survives(() => A.post('/api/squadrats/import-kml', '<kml>' + 'x'.repeat(200) + '</kml>', { raw: true, headers: { 'Content-Type': 'text/plain' } }));
  is4xx(r, 'śmieciowy KML');
}, { sev: 4 });
await fuzz('VAL-16', 'podgląd kwadratów trasy: złe dane → 4xx', 'POST', '/api/route/preview-tiles', j => ({ coords: j }));
await fuzz('VAL-17', 'POI: złe dane → 4xx', 'POST', '/api/route/pois', j => ({ coords: Array.isArray(j) && j.length ? [...j, ...j] : j }));
await fuzz('VAL-18', 'zdjęcia (pamięć wspólna): złe dane → bez 500', 'POST', '/api/photos/route', j => ({ cells: j, samples: j }));
await T('VAL-19', 'parametry w adresie: brak/śmieci → 400 (noroad, reach-stats, bbox)', async () => {
  assert.equal((await A.get('/api/tiles/noroad')).status, 400);
  assert.equal((await A.get('/api/tiles/noroad?x0=0&y0=0&x1=9999&y1=9999')).status, 400);
  assert.equal((await A.get('/api/tiles/reach-stats')).status, 400);
  no5xx(await A.get('/api/tiles/sq?x0=a&x1=b&y0=c&y1=d'), 'bbox');
  no5xx(await A.get('/api/routes/abc'), 'id trasy'); no5xx(await A.get('/api/routes/1e99/gpx'), 'id trasy');
  no5xx(await A.get('/api/mapy/tile/outdoor/1/2/x'), 'kafel mapy');
});
await T('VAL-20', 'błędny JSON → 400 bez śladu stosu i ścieżek serwera', async () => {
  const r = await A.post('/api/routes', '{"name": ', { raw: true, headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 400); noStack(r);
}, { sev: 3 });
await T('VAL-21', 'nieistniejący adres /api/... → 404 JSON, a nie strona aplikacji', async () => {
  const r = await A.get('/api/nie-ma-takiego');
  assert.equal(r.status, 404, `HTTP ${r.status}, typ ${r.headers.get('content-type')}`);
}, { sev: 4 });
await T('VAL-22', 'dziennik przeglądarki: śmieci nie wywracają serwera', async () => {
  for (const b of [null, 'x', { msg: { a: 1 }, data: 'x'.repeat(5000), level: {} }, { level: 'error', msg: 'x'.repeat(10000) }]) no5xx(await survives(() => A.post('/api/log', b)));
});

// ═════════════════════════ SEC: hardening ═══════════════════════════════════
await T('SEC-01', 'każdy endpoint danych wymaga logowania', async () => {
  const open = [];
  const list = [['GET', '/api/routes'], ['GET', '/api/tiles/all'], ['GET', '/api/tiles/sq'], ['GET', '/api/tiles/priority'], ['GET', '/api/stats'], ['GET', '/api/sync/status'], ['POST', '/api/sync'],
    ['POST', '/api/routes'], ['POST', '/api/route/detour'], ['POST', '/api/route/leg'], ['POST', '/api/gpx/import'], ['POST', '/api/squadrats/import-kml'], ['POST', '/api/route/preview-tiles'],
    ['POST', '/api/route/overpass'], ['POST', '/api/route/pois'], ['POST', '/api/route/wiki-poi'], ['POST', '/api/route/photos'], ['POST', '/api/photos/cell'], ['POST', '/api/photos/info'], ['POST', '/api/photos/route'],
    ['GET', '/api/mapy/status'], ['GET', '/api/mapy/tile/outdoor/10/1/1'], ['GET', '/api/mapillary/image/1'], ['GET', '/api/poi/gplace?name=a&lat=1&lng=1'], ['PUT', '/api/profile/home'], ['PUT', '/api/profile/layers'],
    ['PUT', '/api/profile/strava'], ['PUT', '/api/profile/password'], ['PUT', '/api/profile/set-password'], ['DELETE', '/api/profile'], ['GET', '/api/profile/garmin-key'], ['POST', '/api/profile/garmin-key'],
    ['POST', '/api/tiles/blocked/toggle'], ['POST', '/api/tiles/blocked/bulk'], ['GET', '/api/tiles/noroad'], ['GET', '/api/tiles/reach-stats'], ['POST', '/api/log'], ['GET', '/api/log'], ['GET', '/auth/strava'],
    ['GET', '/api/streetview/embed-url?lat=52&lng=21'], ['GET', '/api/streetview/viewer?lat=52&lng=21'], ['POST', '/api/streetview/coverage']];
  for (const [m, u] of list) { const r = await anon.req(m, u, m === 'GET' ? undefined : { points: [{ lat: 52, lng: 21 }] }); if (r.status !== 401) open.push(`${m} ${u.split('?')[0]} → ${r.status}`); }
  assert.ok(!open.length, 'bez logowania odpowiada: ' + open.join('; '));
}, { sev: 2 });
await T('SEC-02', 'nagłówki bezpieczeństwa (nosniff, ramki, referrer) i brak X-Powered-By', async () => {
  const miss = [];
  for (const u of ['/', '/api/health']) {
    const h = (await anon.get(u)).headers;
    if (h.get('x-content-type-options') !== 'nosniff') miss.push(`${u}: X-Content-Type-Options`);
    if (!h.get('x-frame-options') && !/frame-ancestors/.test(h.get('content-security-policy') || '')) miss.push(`${u}: ochrona przed ramką`);
    if (!h.get('referrer-policy')) miss.push(`${u}: Referrer-Policy`);
    if (h.get('x-powered-by')) miss.push(`${u}: X-Powered-By=${h.get('x-powered-by')}`);
  }
  assert.ok(!miss.length, miss.join('; '));
}, { sev: 3 });
await T('SEC-03', 'duże żądanie bez logowania jest odrzucane (413), nie parsowane', async () => {
  const r = await new Client().post('/api/auth/login', { username: 'x', password: 'y'.repeat(3 * 1024 * 1024) });
  assert.equal(r.status, 413, 'HTTP ' + r.status + ' dla 3 MB na /api/auth/login');
}, { sev: 3 });
await T('SEC-04', 'żądanie formularzowe (cross-site) nie zmienia danych', async () => {
  const before = (await A.get('/api/tiles/all')).json.blockedSqi.length;
  const r = await A.req('POST', '/api/tiles/blocked/toggle', 'tx=123&ty=456', { raw: true, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example' } });
  const after = (await A.get('/api/tiles/all')).json.blockedSqi.length;
  if (after !== before) await A.post('/api/tiles/blocked/toggle', { tx: 123, ty: 456 });
  assert.equal(after, before, `formularz z obcej strony zablokował kafelek (HTTP ${r.status})`);
}, { sev: 3 });
await T('SEC-05', 'health nie zdradza liczby kont', async () => {
  const r = await anon.get('/api/health'); assert.ok(!('users' in r.json), JSON.stringify(r.json));
}, { sev: 4 });
await T('SEC-06', 'pokrycie Street View: lista punktów ograniczona i sprawdzana', async () => {
  const pts = Array.from({ length: 5000 }, () => ({ lat: '52&key=X', lng: 21 }));
  const r = await A.post('/api/streetview/coverage', { points: pts });
  assert.ok(r.status === 400 || (r.status === 200 && r.json.coverage === null), 'HTTP ' + r.status);
  const src = (await import('node:fs')).readFileSync(new URL('../backend/src/index.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf("app.post('/api/streetview/coverage'"), src.indexOf('// ── Google place lookup'));
  assert.ok(/slice\(0,|length\s*>/.test(fn) && /isFinite|parseFloat|Number\(|okPt\b/.test(fn), 'brak limitu liczby punktów / walidacji liczb w kodzie (każdy punkt = płatne zapytanie do Google)');
}, { sev: 2 });
await T('SEC-07', 'token stanu OAuth nie działa jako sesja, a sesja jako stan', async () => {
  const c = new Client(); c.cookie = signJwt({ t: Date.now() });
  assert.equal((await c.get('/api/auth/me')).status, 401);
  const r = await anon.get(`/auth/callback?code=abc&state=${A.cookie}`);
  assert.match(r.headers.get('location') || '', /invalid_state/, 'token sesji przyjęty jako state: ' + r.headers.get('location'));
}, { sev: 4 });
await T('SEC-08', 'kod nie zawiera domyślnego sekretu JWT ani logowania haseł', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../backend/src/index.js', import.meta.url), 'utf8') + fs.readFileSync(new URL('../backend/src/db.js', import.meta.url), 'utf8');
  const m = src.match(/JWT_SECRET\s*=\s*process\.env\.JWT_SECRET\s*\|\|\s*\(\(\)\s*=>\s*\{[^}]*return\s+'[^']+'/);
  assert.ok(!m, 'index.js ma wpisany na stałe zapasowy sekret JWT (repo jest publiczne) — bez JWT_SECRET w środowisku każdy może podpisać sesję dowolnego konta');
}, { sev: 1 });

// ═════════════════════════ STR: Strava with one click ═══════════════════════
// Strava is played by tests/strava-mock.mjs; the shared application is 424242.
const MOCK = ENV.SQ_TEST_STRAVA;
const mock = async (patch) => (await fetch(MOCK + '/__state', patch ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) } : {})).json();
// The whole round trip a browser makes: our start address → Strava's screen → our callback
async function stravaFlow(c, start, o = {}) {
  await mock({ athlete: o.athlete ?? 7001, scope: o.scope ?? 'read,activity:read,activity:read_all', deny: !!o.deny, limit: !!o.limit });
  const r1 = await c.get(start);
  const loc = r1.headers.get('location') || '';
  if (!loc.startsWith(MOCK)) return { r1, loc, to: '' };
  const nonce = (r1.headers.getSetCookie?.() || []).find(x => x.startsWith('oauth_n=')) || '';
  const r2 = await fetch(loc, { redirect: 'manual' });
  const back = new URL(r2.headers.get('location'));
  const who = o.as || c;   // whose browser comes back
  const cookies = [who.cookie && `token=${who.cookie}`, o.nonce === false ? null : (o.nonce || nonce.split(';')[0])].filter(Boolean).join('; ');
  const r3 = await fetch(BASE + back.pathname + back.search, { headers: { 'X-Forwarded-For': who.ip, ...(cookies ? { Cookie: cookies } : {}) }, redirect: 'manual' });
  const set = r3.headers.getSetCookie?.().find(x => x.startsWith('token='));
  if (set) who.cookie = set.split(';')[0].slice(6) || null;
  return { r1, loc, nonce, back, status: r3.status, to: decodeURIComponent(r3.headers.get('location') || '') };
}
async function syncDone(c) {
  for (let i = 0; i < 60; i++) {
    const st = (await c.get('/api/sync/status')).json;
    if (st.last && !st.running) return st;
    await sleep(250);
  }
  throw new Error('pierwsza synchronizacja się nie skończyła');
}
// athlete numbers of this run (the suite can be repeated on the same database)
const RUN = 1e5 + Math.floor(Math.random() * 9e6);
const ath = (n) => RUN * 100 + n;
const OWN_A = String(500000 + RUN % 200000), OWN_B = String(700000 + RUN % 200000);   // riders' own applications
const me = async (c) => (await c.get('/api/auth/me')).json;
const userCount = async () => (await admin.get('/api/admin/users')).json.users.length;

const S1 = new Client();   // the rider who arrives with nothing but a Strava account
await T('STR-01', 'ekran logowania: przycisk Stravy włączony, start ustawia jednorazowe ciasteczko', async () => {
  assert.equal((await anon.get('/api/auth/providers')).json.strava, true);
  const r = await new Client().get('/auth/strava/login');
  assert.equal(r.status, 302);
  const u = new URL(r.headers.get('location'));
  assert.equal(u.origin + u.pathname, MOCK + '/oauth/authorize');
  assert.equal(u.searchParams.get('client_id'), '424242');
  assert.match(u.searchParams.get('scope'), /activity:read_all/);
  assert.equal(u.searchParams.get('redirect_uri'), BASE + '/auth/callback');
  const n = r.headers.getSetCookie().find(x => x.startsWith('oauth_n='));
  assert.ok(n, 'brak ciasteczka oauth_n'); assert.match(n, /HttpOnly/i); assert.match(n, /SameSite=Lax/i); assert.match(n, /Path=\/auth/i);
});
await T('STR-02', '„Kontynuuj ze Stravą”: nowe konto, sesja i kwadraty bez żadnej konfiguracji', async () => {
  const before = await userCount();
  const f = await stravaFlow(S1, '/auth/strava/login', { athlete: ath(1) });
  assert.equal(f.to, '/?auth=strava-new', f.to);
  assert.equal(await userCount(), before + 1);
  const u = await me(S1);
  assert.equal(u.username, `Test Rider${ath(1)}`); assert.equal(u.role, 'user');
  assert.equal(u.strava_connected, true); assert.equal(u.strava_shared, true); assert.equal(u.strava_own_keys, false); assert.equal(u.strava_configured, true);
  const st = await syncDone(S1);
  assert.equal(st.last.error, null, st.last.error); assert.equal(st.last.source, 'auto');
  assert.equal(st.last.result.processed, 2); assert.ok(st.last.result.newSQI > 10, 'kwadraty z jazd: ' + JSON.stringify(st.last.result));
  assert.ok((await S1.get('/api/stats')).json.sqi > 10);
  S1.id = u.id;
}, { sev: 1 });
await T('STR-03', 'ponowne logowanie Stravą: to samo konto, nic się nie dubluje', async () => {
  const before = await userCount();
  const c = new Client();
  const f = await stravaFlow(c, '/auth/strava/login', { athlete: ath(1) });
  assert.equal(f.to, '/?auth=ok', f.to);
  assert.equal((await me(c)).id, S1.id); assert.equal(await userCount(), before);
  // the squares are counted once
  const r = await c.post('/api/sync'); assert.match(r.text, /"phase":"done"/); assert.match(r.text, /"newSQI":0/);
});
await T('STR-04', 'logowanie Stravą: obcy lub brakujący jednorazowy kod → brak sesji', async () => {
  for (const nonce of [false, 'oauth_n=' + 'a'.repeat(32)]) {
    const c = new Client();
    const f = await stravaFlow(c, '/auth/strava/login', { athlete: ath(1), nonce });
    assert.match(f.to, /auth=error&msg=invalid_state/, String(nonce) + ' → ' + f.to);
    assert.equal(c.cookie, null, 'sesja wydana mimo złego kodu');
  }
  // the state of a login cannot be replayed as "connect to my account" and the other way round
  const c = new Client(); const f = await stravaFlow(c, '/auth/strava/login', { athlete: ath(1), nonce: false });
  const st = f.back.searchParams.get('state');
  const r = await A.get(`/auth/callback?code=ath-${ath(1)}&scope=read,activity:read&state=${st}`);
  assert.match(r.headers.get('location'), /invalid_state/);
  assert.equal((await me(A)).strava_connected, false);
}, { sev: 1 });
await T('STR-05', 'istniejące konto: „Połącz ze Stravą” jednym kliknięciem, potem logowanie Stravą trafia na to konto', async () => {
  const u = await newUser('con');
  assert.equal(u.user.strava_configured, true, 'wspólna aplikacja = nic do konfigurowania'); assert.equal(u.user.strava_connected, false);
  const f = await stravaFlow(u, '/auth/strava', { athlete: ath(2) });
  assert.equal(f.to, '/?auth=strava-ok', f.to);
  const st = await syncDone(u); assert.equal(st.last.error, null); assert.equal(st.connected, true); assert.ok(st.everyMin > 0);
  assert.equal((await me(u)).strava_connected, true);
  const c = new Client(); const g = await stravaFlow(c, '/auth/strava/login', { athlete: ath(2) });
  assert.equal(g.to, '/?auth=ok'); assert.equal((await me(c)).id, u.id);
});
await T('STR-06', 'połączenie zaczęte na jednym koncie nie podepnie Stravy do innego', async () => {
  const u = await newUser('own'), v = await newUser('oth');
  const f = await stravaFlow(u, '/auth/strava', { athlete: ath(3), as: v });
  assert.match(f.to, /invalid_state/, f.to);
  assert.equal((await me(u)).strava_connected, false); assert.equal((await me(v)).strava_connected, false);
  assert.match((await anon.get('/auth/strava')).status + '', /401|302/);
}, { sev: 1 });
await T('STR-07', 'odmowa albo brak zgody na aktywności → czytelny komunikat, konto nie powstaje', async () => {
  const before = await userCount();
  let f = await stravaFlow(new Client(), '/auth/strava/login', { athlete: ath(4), deny: true });
  assert.match(f.to, /auth=error/); assert.match(f.to, /Nie udzielono dostępu do Stravy/);
  f = await stravaFlow(new Client(), '/auth/strava/login', { athlete: ath(4), scope: 'read' });
  assert.match(f.to, /auth=error/); assert.match(f.to, /Bez dostępu do aktywności/);
  f = await stravaFlow(new Client(), '/auth/strava/login', { athlete: ath(4), scope: 'read,activity:read' });
  assert.equal(f.to, '/?auth=strava-new', 'same publiczne aktywności wystarczą: ' + f.to);
  assert.equal(await userCount(), before + 1);
});
await T('STR-08', 'limit kont aplikacji Strava → komunikat dla użytkownika, bez konta i bez 5xx', async () => {
  const before = await userCount();
  const c = new Client();
  const f = await survives(() => stravaFlow(c, '/auth/strava/login', { athlete: ath(5), limit: true }));
  assert.match(f.to, /auth=error/); assert.match(f.to, /limit kont Stravy/);
  assert.equal(c.cookie, null); assert.equal(await userCount(), before);
  await mock({ limit: false });
});
await T('STR-09', 'odłączenie: Strava cofa autoryzację, tokeny znikają, kwadraty zostają', async () => {
  const u = await newUser('dis');
  await stravaFlow(u, '/auth/strava', { athlete: ath(6) }); await syncDone(u);
  const sqi = (await u.get('/api/stats')).json.sqi; assert.ok(sqi > 0);
  const d0 = (await mock()).calls.deauthorize;
  const r = await u.post('/api/profile/strava/disconnect');
  assert.equal(r.status, 200); assert.equal(r.json.user.strava_connected, false); assert.equal(r.json.user.strava_configured, true);
  assert.equal((await mock()).calls.deauthorize, d0 + 1);
  assert.equal(sql('SELECT COUNT(*) n FROM strava_tokens WHERE user_id=?', [u.id])[0].n, 0);
  assert.equal((await u.get('/api/stats')).json.sqi, sqi);
  assert.equal((await u.get('/api/sync/status')).json.connected, false);
  assert.match((await u.post('/api/sync')).text, /Brak autoryzacji Strava/);
  assert.equal((await u.post('/api/profile/strava/disconnect')).status, 200, 'drugie odłączenie nie jest błędem');
  assert.equal((await anon.post('/api/profile/strava/disconnect')).status, 401);
});
await T('STR-10', 'dwa konta z tym samym sportowcem: odłączenie jednego nie psuje drugiego', async () => {
  const u = await newUser('twa'), v = await newUser('twb');
  await stravaFlow(u, '/auth/strava', { athlete: ath(7) }); await stravaFlow(v, '/auth/strava', { athlete: ath(7) });
  await syncDone(u); await syncDone(v);
  const d0 = (await mock()).calls.deauthorize;
  await u.post('/api/profile/strava/disconnect');
  assert.equal((await mock()).calls.deauthorize, d0, 'autoryzacja cofnięta, choć drugie konto jej używa');
  assert.match((await v.post('/api/sync')).text, /"phase":"done"/);
});
await T('STR-11', 'własne klucze API: zasady zapisu, sekret zostaje przy pustym polu, puste pola = wspólna aplikacja', async () => {
  const u = await newUser('key');
  const put = (b) => u.put('/api/profile/strava', b);
  assert.equal((await put({ strava_client_id: 'abc', strava_client_secret: 'x' })).status, 400);
  assert.equal((await put({ strava_client_id: OWN_A })).status, 400, 'ID bez sekretu');
  assert.equal((await put({ strava_client_secret: 'test-secret' })).status, 400, 'sekret bez ID');
  let r = await put({ strava_client_id: OWN_A, strava_client_secret: 'test-secret' });
  assert.equal(r.json.user.strava_own_keys, true);
  r = await put({ strava_client_id: OWN_A, strava_client_secret: '' });
  assert.equal(r.status, 200); assert.equal(r.json.user.strava_own_keys, true);
  // connecting now goes through the rider's own application
  const f = await stravaFlow(u, '/auth/strava', { athlete: ath(8) });
  assert.equal(new URL(f.loc).searchParams.get('client_id'), OWN_A); assert.equal(f.to, '/?auth=strava-ok');
  await syncDone(u);
  assert.equal(sql('SELECT client_id FROM strava_tokens WHERE user_id=?', [u.id])[0].client_id, OWN_A);
  r = await put({});
  assert.equal(r.json.user.strava_own_keys, false); assert.equal(r.json.user.strava_configured, true);
});
await T('STR-12', 'limit zapytań (429) jednej aplikacji wstrzymuje tylko ją', async () => {
  const u = await newUser('lim');
  await u.put('/api/profile/strava', { strava_client_id: OWN_B, strava_client_secret: 'test-secret' });
  await stravaFlow(u, '/auth/strava', { athlete: ath(9) }); await syncDone(u);
  await mock({ rate429: OWN_B });
  const r = await survives(() => u.post('/api/sync'));
  assert.match(r.text, /"phase":"error"/); assert.match(r.text, /ogranicza liczbę zapytań/);
  const st = (await u.get('/api/sync/status')).json;
  assert.ok(st.pausedUntil && new Date(st.pausedUntil) > new Date(), 'brak pausedUntil: ' + JSON.stringify(st));
  await mock({ rate429: '' });
  const a0 = (await mock()).calls.activities;
  assert.match((await u.post('/api/sync')).text, /ogranicza liczbę zapytań/);
  assert.equal((await mock()).calls.activities, a0, 'zapytanie do Stravy mimo pauzy');
  // a rider can still connect while the application waits; their first sync reports the pause
  const w = await newUser('lw');
  await w.put('/api/profile/strava', { strava_client_id: OWN_B, strava_client_secret: 'test-secret' });
  assert.equal((await stravaFlow(w, '/auth/strava', { athlete: ath(12) })).to, '/?auth=strava-ok');
  assert.match((await syncDone(w)).last.error, /ogranicza liczbę zapytań/);
  // the shared application carries on
  const c = new Client(); await stravaFlow(c, '/auth/strava/login', { athlete: ath(1) });
  assert.match((await c.post('/api/sync')).text, /"phase":"done"/);
  assert.equal((await c.get('/api/sync/status')).json.pausedUntil, null);
}, { sev: 2 });
await T('STR-13', 'wygasły token odświeża się sam; cofnięty na strava.com → prośba o ponowne połączenie', async () => {
  const u = await newUser('ref');
  await stravaFlow(u, '/auth/strava', { athlete: ath(10) }); await syncDone(u);
  sql('UPDATE strava_tokens SET expires_at=? WHERE user_id=?', [Math.floor(Date.now() / 1000) - 10, u.id]);
  const r0 = (await mock()).calls.refresh;
  assert.match((await u.post('/api/sync')).text, /"phase":"done"/);
  assert.equal((await mock()).calls.refresh, r0 + 1);
  await mock({ revoked: [ath(10)] });
  sql('UPDATE strava_tokens SET expires_at=? WHERE user_id=?', [Math.floor(Date.now() / 1000) - 10, u.id]);
  const r = await survives(() => u.post('/api/sync'));
  assert.match(r.text, /połącz Stravę ponownie w Profilu/);
  await mock({ revoked: [] });
});
await T('STR-14', 'tokeny i sekret aplikacji nie wracają w żadnej odpowiedzi', async () => {
  const tok = sql('SELECT access_token a, refresh_token r FROM strava_tokens WHERE user_id=?', [S1.id])[0];
  assert.ok(tok?.a);
  for (const x of [await S1.get('/api/auth/me'), await admin.get('/api/admin/users'), await S1.get('/api/sync/status'), await anon.get('/api/auth/providers')]) {
    assert.ok(!x.text.includes(tok.a) && !x.text.includes('test-secret') && !x.text.includes('"refresh_token"'), 'token/sekret w odpowiedzi');
  }
}, { sev: 1 });
await T('STR-15', 'usunięcie konta założonego Stravą: potwierdzenie nazwą, autoryzacja cofnięta', async () => {
  const c = new Client();
  await stravaFlow(c, '/auth/strava/login', { athlete: ath(11) }); await syncDone(c);
  const u = await me(c);
  const d0 = (await mock()).calls.deauthorize;
  assert.equal((await c.del('/api/profile', { confirm: 'nie ta nazwa' })).status, 403);
  assert.equal((await c.del('/api/profile', { confirm: u.username })).status, 200);
  assert.equal((await mock()).calls.deauthorize, d0 + 1);
  assert.equal(sql('SELECT COUNT(*) n FROM users WHERE id=?', [u.id])[0].n, 0);
  // the same rider can come back: a fresh account
  const d = new Client(); const f = await stravaFlow(d, '/auth/strava/login', { athlete: ath(11) });
  assert.equal(f.to, '/?auth=strava-new'); assert.notEqual((await me(d)).id, u.id);
});

// ═════════════════════════ COV: where routes can be planned ═════════════════
await T('COV-01', 'zasięg: publiczna lista obszarów tras i regionów OSM', async () => {
  const r = await anon.get('/api/coverage');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.routing.tiles) && r.json.routing.tiles.length >= 50, 'kafle tras: ' + r.json.routing.tiles?.length);
  for (const t of ['E20_N50', 'E5_N50', 'E0_N45', 'W5_N50']) assert.ok(r.json.routing.tiles.includes(t), 'brak ' + t);
  assert.equal(r.json.routing.step, 5); assert.ok(r.json.routing.bbox.west < -5 && r.json.routing.bbox.east > 25 && r.json.routing.bbox.south <= 35 && r.json.routing.bbox.north >= 70);
  assert.ok(r.json.osm.regions.includes('poland'));
});
await T('COV-02', 'trasa poza Polską: Holandia, Francja, Hiszpania', async () => {
  for (const [name, a, b] of [['Utrecht', { lat: 52.09, lng: 5.12 }, { lat: 52.12, lng: 5.18 }], ['Lyon', { lat: 45.76, lng: 4.83 }, { lat: 45.79, lng: 4.88 }], ['Girona', { lat: 41.98, lng: 2.82 }, { lat: 42.01, lng: 2.86 }]]) {
    const r = await A.post('/api/route/leg', { from: a, to: b, bikeProfile: 'gravel' });
    assert.equal(r.status, 200, `${name}: HTTP ${r.status} ${r.text.slice(0, 120)}`);
    const km = r.json.routes[0].distance / 1000;
    assert.ok(r.json.routes[0].geometry.coordinates.length > 20 && km > 3 && km < 15, `${name}: ${km} km`);
  }
}, { sev: 1 });
await T('COV-03', 'poza zasięgiem: 422 z kodem i komunikatem zamiast błędu serwera', async () => {
  const ny = { lat: 40.75, lng: -73.98 }, ny2 = { lat: 40.78, lng: -73.96 };
  for (const [what, r] of [
    ['odcinek', await A.post('/api/route/leg', { from: ny, to: ny2, bikeProfile: 'gravel' })],
    ['trasa', await A.post('/api/route/detour', { waypoints: [ny, ny2], mode: 'shortest', bikeProfile: 'gravel' })],
    ['pętla', await A.post('/api/route/detour', { waypoints: [ny], loop: true, targetKm: 20, mode: 'sqi' })],
    ['jeden punkt poza', await A.post('/api/route/detour', { waypoints: [AREA, ny], mode: 'shortest', bikeProfile: 'gravel' })]]) {
    assert.equal(r.status, 422, `${what}: HTTP ${r.status} ${r.text.slice(0, 120)}`);
    assert.equal(r.json.code, 'no-routing-data'); assert.match(r.json.error, /poza zasięgiem planowania tras/);
  }
});
await T('COV-04', 'punkt na środku morza: 422, nie 5xx', async () => {
  // Mediterranean (nothing near) and Baltic (a ferry line 25 km away, which BRouter would happily snap to)
  for (const [from, to] of [[{ lat: 38.5, lng: 5.5 }, { lat: 38.6, lng: 5.7 }], [{ lat: 55.6, lng: 18.2 }, { lat: 55.7, lng: 18.4 }], [{ lat: 54.45, lng: 18.6 }, { lat: 55.6, lng: 18.2 }]]) {
    const r = await survives(() => A.post('/api/route/leg', { from, to, bikeProfile: 'gravel' }));
    assert.equal(r.status, 422, `${JSON.stringify(from)}: HTTP ${r.status} ${r.text.slice(0, 120)}`);
    assert.equal(r.json.code, 'no-road-near'); assert.match(r.json.error, /nie ma drogi/);
  }
});

// ═════════════════════ ACC: password by e-mail, e-mail in the profile ══════════
const SVC = ENV.SQ_TEST_SERVICES;
const svc = async (patch) => (await fetch(SVC + '/__state', patch ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) } : {})).json();
const mailsTo = async (addr) => (await (await fetch(SVC + '/__mails')).json()).filter(m => m.to.includes(addr));
async function mailTo(addr, n = 1) {
  for (let i = 0; i < 40; i++) { const m = await mailsTo(addr); if (m.length >= n) return m; await sleep(150); }
  throw new Error(`list do ${addr} nie dotarł`);
}
const resetToken = (m) => /#reset=([A-Za-z0-9_-]+)/.exec(m.text)?.[1];

await T('ACC-01', 'zapomniane hasło: list z linkiem, nowe hasło loguje, stare sesje i stare hasło przestają działać', async () => {
  assert.equal((await anon.get('/api/auth/providers')).json.reset, true);
  const em = uniq('rst') + '@example.org';
  const u = await newUser('rst', { email: em });
  const r = await new Client().post('/api/auth/forgot', { email: em.toUpperCase(), lang: 'en' });
  assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true });
  const [m] = await mailTo(em);
  assert.match(m.subject, /New password/); assert.match(m.text, /valid for 1 hour/);
  const tok = resetToken(m); assert.ok(tok && tok.length >= 40, 'brak tokenu w liście');
  assert.ok(m.text.includes(`/#reset=${tok}`), 'token ma być we fragmencie adresu');
  assert.ok(!m.text.includes(u.username) && !/password_hash/.test(m.text));
  // the token is stored hashed
  assert.equal(sql('select count(*) c from password_resets where token_hash = ?', [tok])[0].c, 0);
  const c = new Client();
  assert.equal((await c.post('/api/auth/reset', { token: tok, password: 'slabe' })).status, 400);
  const ok = await c.post('/api/auth/reset', { token: tok, password: 'Nowe-haslo-22' });
  assert.equal(ok.status, 200, ok.text.slice(0, 120)); assert.equal(ok.json.user.username, u.username);
  assert.ok(!('password_hash' in ok.json.user));
  assert.equal((await c.get('/api/auth/me')).status, 200, 'po zmianie hasła jest sesja');
  assert.equal((await u.get('/api/auth/me')).status, 401, 'stara sesja powinna wygasnąć');
  assert.equal((await new Client().post('/api/auth/login', { username: u.username, password: PASSWORD })).status, 401);
  assert.equal((await new Client().post('/api/auth/login', { username: u.username, password: 'Nowe-haslo-22' })).status, 200);
  assert.equal((await new Client().post('/api/auth/reset', { token: tok, password: 'Jeszcze-raz-33' })).status, 400, 'link działa raz');
}, { sev: 1 });
await T('ACC-02', 'zapomniane hasło: nieznany adres dostaje tę samą odpowiedź i żadnego listu', async () => {
  const ghost = uniq('ghost') + '@example.org';
  const r = await new Client().post('/api/auth/forgot', { email: ghost });
  assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true });
  await sleep(500);
  assert.equal((await mailsTo(ghost)).length, 0);
  for (const bad of ['', 'nie-adres', { a: 1 }, 'a'.repeat(300) + '@example.org']) assert.equal((await new Client().post('/api/auth/forgot', { email: bad })).status, 400);
});
await T('ACC-03', 'zapomniane hasło: najwyżej 3 listy na godzinę na konto, 6 próśb z jednego adresu IP', async () => {
  const em = uniq('lim') + '@example.org';
  await newUser('lim', { email: em });
  for (let i = 0; i < 5; i++) assert.equal((await new Client().post('/api/auth/forgot', { email: em })).status, 200);
  await sleep(1200);
  assert.equal((await mailsTo(em)).length, 3);
  const one = new Client();
  let last;
  for (let i = 0; i < 7; i++) last = await one.post('/api/auth/forgot', { email: uniq('x') + '@example.org' });
  assert.equal(last.status, 429);
});
await T('ACC-04', 'zapomniane hasło: język listu (de, cs), nieznany język → polski; nowy link nie kasuje starszego, użycie kasuje wszystkie', async () => {
  const em = uniq('lng') + '@example.org';
  await newUser('lng', { email: em });
  await new Client().post('/api/auth/forgot', { email: em, lang: 'de' });
  const [a] = await mailTo(em, 1);
  await new Client().post('/api/auth/forgot', { email: em, lang: 'cs' });
  const [, b] = await mailTo(em, 2);
  await new Client().post('/api/auth/forgot', { email: em, lang: 'xx' });
  const [, , c] = await mailTo(em, 3);
  assert.match(a.subject, /Neues Passwort/); assert.match(b.subject, /Nov.? heslo|=\?UTF-8/i); assert.match(c.text, /Ktoś poprosił/);
  const [ta, tb] = [resetToken(a), resetToken(b)];
  assert.notEqual(ta, tb);
  assert.equal((await new Client().post('/api/auth/reset', { token: ta, password: 'Haslo-nowe-44' })).status, 200);
  assert.equal((await new Client().post('/api/auth/reset', { token: tb, password: 'Haslo-nowe-55' })).status, 400, 'po użyciu jednego linku pozostałe gasną');
});
await T('ACC-05', 'reset: śmieciowe tokeny → 400, bez 5xx; token nie trafia do dziennika', async () => {
  for (const tok of ['', 'x', 'a'.repeat(43), "' or 1=1 --", { a: 1 }, ['a'], 'a'.repeat(5000)]) {
    const r = await survives(() => new Client().post('/api/auth/reset', { token: tok, password: 'Dobre-haslo-1' }));
    assert.equal(r.status, 400, JSON.stringify(tok).slice(0, 30) + ' → ' + r.status);
  }
});
await T('ACC-06', 'adres e-mail w profilu: wymaga obecnego hasła, zajęty → 409, zmiana unieważnia wysłane linki', async () => {
  const em1 = uniq('e1') + '@example.org', em2 = uniq('e2') + '@example.org';
  const u = await newUser('eml'), other = await newUser('oth', { email: em2 });
  assert.equal((await u.put('/api/profile/email', { email: em1 })).status, 400, 'bez hasła');
  assert.equal((await u.put('/api/profile/email', { email: em1, current_password: 'zle-haslo-9' })).status, 403);
  assert.equal((await u.put('/api/profile/email', { email: 'nie-adres', current_password: PASSWORD })).status, 400);
  assert.equal((await u.put('/api/profile/email', { email: em2.toUpperCase(), current_password: PASSWORD })).status, 409);
  assert.equal((await u.put('/api/profile/email', { email: other.username, current_password: PASSWORD })).status, 400, 'nazwa cudzego konta nie jest adresem');
  const ok = await u.put('/api/profile/email', { email: em1, current_password: PASSWORD });
  assert.equal(ok.status, 200); assert.equal(ok.json.user.email, em1);
  await new Client().post('/api/auth/forgot', { email: em1 });
  const tok = resetToken((await mailTo(em1))[0]);
  const em3 = uniq('e3') + '@example.org';
  assert.equal((await u.put('/api/profile/email', { email: em3, current_password: PASSWORD })).status, 200);
  assert.equal((await new Client().post('/api/auth/reset', { token: tok, password: 'Haslo-nowe-66' })).status, 400, 'link wysłany na stary adres');
  // removing the address
  const off = await u.put('/api/profile/email', { email: '', current_password: PASSWORD });
  assert.equal(off.status, 200); assert.ok(!off.json.user.email);
  assert.equal((await new Client().put('/api/profile/email', { email: em1 })).status, 401);
});

// ═════════════════════════════ APL: Sign in with Apple ═════════════════════════
async function appleFlow(c, o = {}) {
  await svc({ appleSub: o.sub ?? 'apple-' + uniq('s'), appleEmail: o.email ?? null, appleVerified: o.verified ?? true, appleDeny: !!o.deny });
  const r1 = await c.get('/auth/apple');
  const loc = r1.headers.get('location') || '';
  const nonce = ((r1.headers.getSetCookie?.() || []).find(x => x.startsWith('oauth_n=')) || '').split(';')[0];
  const page = await (await fetch(loc)).text();
  const fields = Object.fromEntries([...page.matchAll(/name="(\w+)" value="([^"]*)"/g)].map(m => [m[1], m[2].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))]));
  const action = /action="([^"]+)"/.exec(page)[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
  if (o.fields) Object.assign(fields, o.fields);
  // Apple's form post arrives cross-site: no cookies of ours, a foreign Origin
  const r2 = await fetch(action, { method: 'POST', redirect: 'manual', body: new URLSearchParams(fields),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://appleid.apple.com', 'Sec-Fetch-Site': 'cross-site', 'X-Forwarded-For': c.ip } });
  const back = r2.headers.get('location') || '';
  const cookies = [c.cookie && `token=${c.cookie}`, o.nonce === false ? null : (o.nonce || nonce)].filter(Boolean).join('; ');
  const r3 = await fetch(BASE + back, { headers: { 'X-Forwarded-For': c.ip, ...(cookies ? { Cookie: cookies } : {}) }, redirect: 'manual' });
  const set = r3.headers.getSetCookie?.().find(x => x.startsWith('token='));
  if (set) c.cookie = set.split(';')[0].slice(6) || null;
  return { r1, loc, r2, back, status: r3.status, to: decodeURIComponent(r3.headers.get('location') || '') };
}
await T('APL-01', 'Apple: start prowadzi do Apple z właściwymi parametrami i jednorazowym ciasteczkiem', async () => {
  assert.equal((await anon.get('/api/auth/providers')).json.apple, true);
  const r = await new Client().get('/auth/apple');
  assert.equal(r.status, 302);
  const u = new URL(r.headers.get('location'));
  assert.equal(u.origin + u.pathname, SVC + '/auth/authorize');
  assert.equal(u.searchParams.get('response_mode'), 'form_post'); assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('redirect_uri'), BASE + '/auth/apple/callback');
  assert.match(u.searchParams.get('scope'), /email/);
  const n = r.headers.getSetCookie().find(x => x.startsWith('oauth_n='));
  assert.ok(n); assert.match(n, /HttpOnly/i); assert.match(n, /SameSite=Lax/i); assert.match(n, /Path=\/auth/i);
});
const AP = new Client(), AP_SUB = 'sub-' + uniq('a');
await T('APL-02', 'Apple: pierwsze logowanie zakłada konto, kolejne trafia na to samo', async () => {
  const before = await userCount();
  const f = await appleFlow(AP, { sub: AP_SUB, email: uniq('ap') + '@example.org' });
  assert.equal(f.r2.status, 303, 'formularz Apple: ' + f.r2.status); assert.match(f.back, /^\/auth\/apple\/finish\?/);
  assert.equal(f.status, 302); assert.match(f.to, /^\/\?auth=(ok|new)/, f.to);
  assert.equal(await userCount(), before + 1);
  const u = await me(AP); assert.equal(u.role, 'user'); AP.id = u.id;
  const again = new Client();
  const g = await appleFlow(again, { sub: AP_SUB });   // Apple sends the address only the first time
  assert.match(g.to, /^\/\?auth=ok/, g.to);
  assert.equal((await me(again)).id, AP.id); assert.equal(await userCount(), before + 1);
}, { sev: 1 });
await T('APL-03', 'Apple: odpowiedź bez ciasteczka tej przeglądarki, z cudzym lub przerobionym stanem → brak sesji', async () => {
  const before = await userCount();
  for (const [why, o] of [['bez ciasteczka', { nonce: false }], ['cudze ciasteczko', { nonce: 'oauth_n=' + '0'.repeat(32) }],
    ['stan ze Stravy', { fields: { state: signJwt({ p: 'strava-login', n: 'x', exp: Math.floor(Date.now() / 1000) + 300 }) } }],
    ['stan śmieciowy', { fields: { state: 'abc' } }], ['bez kodu', { fields: { code: '' } }]]) {
    const c = new Client();
    const f = await appleFlow(c, { sub: 'sub-' + uniq('x'), ...o });
    assert.match(f.to, /auth=error/, `${why}: ${f.to}`); assert.equal(c.cookie, null, why);
  }
  assert.equal(await userCount(), before);
}, { sev: 1 });
await T('APL-04', 'Apple: rezygnacja i zły kod → komunikat, konto nie powstaje, bez 5xx', async () => {
  const before = await userCount();
  const c = new Client();
  const f = await appleFlow(c, { deny: true });
  assert.match(f.to, /auth=error/, f.to); assert.equal(c.cookie, null);
  const g = await appleFlow(new Client(), { fields: { code: 'zly-kod' } });
  assert.equal(g.status, 302); assert.match(g.to, /auth=error/, g.to);
  assert.equal(await userCount(), before);
  await svc({ appleDeny: false });
});
await T('APL-05', 'Apple: formularz zwrotny przyjmuje tylko code/state/error i niczego sam nie rozstrzyga', async () => {
  const r = await fetch(BASE + '/auth/apple/callback', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example' },
    body: new URLSearchParams({ code: 'x', state: 'y', user: '{"name":"z"}', id_token: 'aaa', next: 'https://evil.example' }) });
  assert.equal(r.status, 303);
  const loc = r.headers.get('location');
  assert.match(loc, /^\/auth\/apple\/finish\?/); assert.ok(!/id_token|user=|next=|evil/.test(loc), loc);
  assert.ok(!r.headers.getSetCookie().some(x => x.startsWith('token=')), 'formularz nie może dawać sesji');
  // the same form post to any other address is still refused
  const x = await fetch(BASE + '/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }, body: 'a=1' });
  assert.ok(x.status >= 400, 'cross-site POST na /api: ' + x.status);
});

// ═══════════════════════ SHR: a public link to a saved route ═══════════════════
const metres = (a, b) => { const r = Math.PI / 180, x = (b[1] - a[1]) * r * Math.cos(a[0] * r), y = (b[0] - a[0]) * r; return Math.hypot(x, y) * 6371000; };
let SH = null;
await T('SHR-01', 'link do trasy: widoczny bez konta, bez danych autora, końce ucięte', async () => {
  const body = routeBody('Pętla <b>testowa</b> & spółka');
  const id = (await A.post('/api/routes', body)).json.id;
  const s = await A.post(`/api/routes/${id}/share`, {});
  assert.equal(s.status, 200); assert.match(s.json.token, /^[A-Za-z0-9_-]{12,40}$/); assert.equal(s.json.trim_m, 300);
  SH = { id, token: s.json.token, body };
  const r = await new Client().get('/api/shared/' + SH.token);
  assert.equal(r.status, 200); assert.equal(r.json.name, body.name);
  for (const k of ['user_id', 'username', 'email', 'id', 'waypoints', 'share_token']) assert.ok(!(k in r.json), `link zdradza ${k}`);
  assert.ok(!r.text.includes(A.username), 'nazwa autora w odpowiedzi');
  const c = r.json.coords, full = body.coords;
  assert.ok(c.length >= 2 && c.length < full.length);
  assert.ok(r.json.trimmed_m > 100, 'ucięto ' + r.json.trimmed_m);
  assert.ok(metres(full[0], c[0]) >= r.json.trimmed_m - 1, 'początek nieucięty'); assert.ok(metres(full.at(-1), c.at(-1)) >= r.json.trimmed_m - 1, 'koniec nieucięty');
  return `ucięte ${r.json.trimmed_m} m z każdej strony, ${c.length}/${full.length} punktów`;
}, { sev: 1 });
await T('SHR-02', 'link do trasy: strona /s/, GPX i nazwa z HTML-em są bezpieczne', async () => {
  const pg = await new Client().get('/s/' + SH.token);
  assert.equal(pg.status, 200); assert.match(pg.headers.get('content-type'), /text\/html/);
  assert.ok(!pg.text.includes('<b>testowa</b>'), 'nazwa trasy wstawiona jako HTML'); assert.ok(pg.text.includes('&lt;b&gt;testowa'), 'brak nazwy w tytule');
  assert.ok(!/__OG_|__APP_NAME__/.test(pg.text), 'niewypełnione pola szablonu');
  const g = await new Client().get(`/api/shared/${SH.token}/gpx`);
  assert.equal(g.status, 200); assert.match(g.headers.get('content-type'), /gpx\+xml/); assert.match(g.headers.get('content-disposition'), /attachment; filename="[\w.-]+\.gpx"/);
  xmlWellFormed(g.text);
  const pts = [...g.text.matchAll(/<trkpt lat="([\d.]+)" lon="([\d.]+)"/g)];
  const shown = (await new Client().get('/api/shared/' + SH.token)).json.coords;
  assert.equal(pts.length, shown.length, 'GPX ma te same (ucięte) punkty co strona');
  assert.ok(!g.text.includes(A.username));
});
await T('SHR-03', 'link do trasy: „pokaż całą” zachowuje adres, cudzej trasy nie da się udostępnić', async () => {
  const s = await A.post(`/api/routes/${SH.id}/share`, { hideEnds: false });
  assert.equal(s.json.token, SH.token); assert.equal(s.json.trim_m, 0);
  const r = await new Client().get('/api/shared/' + SH.token);
  assert.equal(r.json.coords.length, SH.body.coords.length); assert.equal(r.json.trimmed_m, 0);
  assert.equal((await B.post(`/api/routes/${SH.id}/share`, {})).status, 404);
  assert.equal((await B.del(`/api/routes/${SH.id}/share`)).status, 404);
  assert.equal((await new Client().post(`/api/routes/${SH.id}/share`, {})).status, 401);
  assert.equal((await new Client().get('/api/shared/' + SH.token)).status, 200, 'cudza próba nie może wyłączyć linku');
  const mine = (await A.get('/api/routes/' + SH.id)).json;
  assert.equal(mine.share_token, SH.token, 'właściciel widzi, że trasa jest udostępniona');
}, { sev: 1 });
await T('SHR-04', 'link do trasy: wyłączony, śmieciowy i po usunięciu trasy → 404 wszędzie', async () => {
  assert.equal((await A.del(`/api/routes/${SH.id}/share`)).status, 200);
  for (const u of ['/api/shared/' + SH.token, `/api/shared/${SH.token}/gpx`, '/s/' + SH.token]) assert.equal((await new Client().get(u)).status, 404, u);
  for (const tok of ['x', 'a'.repeat(12), '..%2F..%2Fetc%2Fpasswd', '%27%20or%201=1', 'a'.repeat(300)]) {
    const r = await survives(() => new Client().get('/api/shared/' + tok)); assert.equal(r.status, 404, tok.slice(0, 20));
  }
  const again = await A.post(`/api/routes/${SH.id}/share`, {});
  assert.notEqual(again.json.token, SH.token, 'po wyłączeniu nowy link ma nowy adres');
  await A.del('/api/routes/' + SH.id);
  assert.equal((await new Client().get('/api/shared/' + again.json.token)).status, 404);
});

// ═════════════════════════════ WX: weather on the route ════════════════════════
await T('WX-01', 'pogoda: prognoza godzinowa z wiatrem, źródło podane, wymaga logowania', async () => {
  await svc({ windDir: 270, windSpeed: 6, weatherFail: false });
  assert.equal((await new Client().get('/api/weather?lat=50.31&lng=19.12')).status, 401);
  const r = await A.get('/api/weather?lat=50.31&lng=19.12');
  assert.equal(r.status, 200, r.text.slice(0, 120)); assert.equal(r.json.source, 'MET Norway');
  assert.ok(r.json.hours.length >= 48, 'godzin: ' + r.json.hours.length);
  const h = r.json.hours[0];
  assert.equal(h.wind, 6); assert.equal(h.dir, 270); assert.ok(typeof h.temp === 'number' && typeof h.t === 'string' && 'rain' in h && 'sym' in h);
  for (const q of ['', '?lat=abc&lng=1', '?lat=99&lng=19', '?lat=50']) assert.equal((await A.get('/api/weather' + q)).status, 400, q);
});
let WX_CELL = [50.7, 19.5];
await T('WX-02', 'pogoda: jedno zapytanie na komórkę 0,1° (pamięć podręczna), bez adresu e-mail w User-Agent', async () => {
  const before = (await svc()).calls.weather;
  // a cell of this run's own (the backend keeps forecasts between runs)
  const la0 = 44 + Math.floor(Math.random() * 60) / 10, lo0 = 5 + Math.floor(Math.random() * 100) / 10;
  WX_CELL = [la0, lo0];
  for (const [a, o] of [[0.01, 0.02], [0.04, 0.03], [-0.02, -0.02], [0.01, 0.02]]) assert.equal((await A.get(`/api/weather?lat=${(la0 + a).toFixed(3)}&lng=${(lo0 + o).toFixed(3)}`)).status, 200);
  const st = await svc();
  assert.equal(st.calls.weather - before, 1, 'zapytań do MET: ' + (st.calls.weather - before));
  assert.equal(st.lastWeatherQuery, `?lat=${la0.toFixed(1)}&lon=${lo0.toFixed(1)}`);
  assert.ok(st.lastUA.weather.length > 5 && !/@/.test(st.lastUA.weather) && !/axios|node/i.test(st.lastUA.weather), 'User-Agent: ' + st.lastUA.weather);
});
await T('WX-03', 'pogoda: awaria MET → 502 z komunikatem dla nowego miejsca, zapamiętana prognoza nadal działa', async () => {
  await svc({ weatherFail: true });
  try {
    const fresh = await survives(() => A.get(`/api/weather?lat=${(60 + Math.random() * 5).toFixed(2)}&lng=${(10 + Math.random() * 10).toFixed(2)}`));
    assert.equal(fresh.status, 502); assert.match(fresh.json.error, /Prognoza/); noStack(fresh);
    assert.equal((await A.get(`/api/weather?lat=${WX_CELL[0]}&lng=${WX_CELL[1]}`)).status, 200);
  } finally { await svc({ weatherFail: false }); }
});

// ═══════════════════ IMP: squares from StatsHunters and VeloViewer ═════════════
await T('IMP-01', 'StatsHunters: link udostępniania → kwadraty ze wszystkich stron listy, drugi import nic nie dubluje', async () => {
  const u = await newUser('sh');
  const r = await u.post('/api/import/statshunters', { link: 'https://www.statshunters.com/share/sharegood1' });
  assert.equal(r.status, 200, r.text.slice(0, 160));
  assert.equal(r.json.addedSQ, 6, JSON.stringify(r.json)); assert.equal(r.json.parsedSQ, 6); assert.equal(r.json.totalSQ, 6);
  assert.ok(r.json.activities >= 3);
  const again = await u.post('/api/import/statshunters', { link: 'statshunters.com/share/sharegood1?x=1' });
  assert.equal(again.json.addedSQ, 0); assert.equal(again.json.totalSQ, 6);
  assert.equal((await u.get('/api/stats')).json.sq, 6);
  assert.equal((await B.get('/api/tiles/all')).json.sq.some(t => t.tx === 8950 && t.ty === 5400), false, 'kwadraty trafiły na cudze konto');
  assert.ok(!/@/.test((await svc()).lastUA.statshunters));
}, { sev: 1 });
await T('IMP-02', 'StatsHunters: pusty link, nieistniejący kod i cudze adresy → 400, serwer nie pyta nikogo innego', async () => {
  const u = await newUser('sh2');
  assert.equal((await u.post('/api/import/statshunters', { link: 'https://www.statshunters.com/share/shareempty' })).status, 400);
  assert.equal((await u.post('/api/import/statshunters', { link: 'https://www.statshunters.com/share/nieistnieje' })).status, 400);
  const before = (await svc()).calls.statshunters;
  for (const link of ['', 'https://evil.example/share/sharegood1', 'http://169.254.169.254/latest/meta-data', 'https://www.statshunters.com.evil.example/share/sharegood1',
    'https://www.statshunters.com/share/../../admin', 'file:///etc/passwd', { a: 1 }, 'a'.repeat(400)]) {
    const r = await survives(() => u.post('/api/import/statshunters', { link }));
    assert.equal(r.status, 400, JSON.stringify(link).slice(0, 50) + ' → ' + r.status);
  }
  assert.equal((await svc()).calls.statshunters, before, 'serwer zapytał o cudzy adres');
  assert.equal((await new Client().post('/api/import/statshunters', { link: 'sharegood1' })).status, 401);
}, { sev: 1 });
const tileRing = (x, y, z = 14) => {
  const lon = (X) => X / 2 ** z * 360 - 180, lat = (Y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * Y / 2 ** z))) * 180 / Math.PI;
  return [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]].map(([X, Y]) => `${lon(X)},${lat(Y)},0`).join(' ');
};
const tileKml = (tiles) => `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>explorer</name>${
  tiles.map(([x, y]) => `<Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>${tileRing(x, y)}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`).join('')}</Document></kml>`;
await T('IMP-03', 'VeloViewer: KML z kafelkami Explorer → te same kwadraty z14, ponowny import bez duplikatów', async () => {
  const u = await newUser('vv');
  const tiles = [[9100, 5500], [9101, 5500], [9101, 5501], [9105, 5510]];
  const r = await u.req('POST', '/api/import/veloviewer-kml', tileKml(tiles), { raw: true, headers: { 'Content-Type': 'text/plain' } });
  assert.equal(r.status, 200, r.text.slice(0, 160)); assert.equal(r.json.addedSQ, 4, JSON.stringify(r.json)); assert.equal(r.json.polygons, 4);
  const got = (await u.get('/api/tiles/all')).json.sq.map(t => `${t.tx},${t.ty}`).sort();
  assert.deepEqual(got, tiles.map(t => t.join(',')).sort());
  const again = await u.req('POST', '/api/import/veloviewer-kml', tileKml(tiles), { raw: true, headers: { 'Content-Type': 'text/plain' } });
  assert.equal(again.json.addedSQ, 0);
});
await T('IMP-04', 'VeloViewer: pusty, śmieciowy plik i plik bez wielokątów → 400 (nie 5xx)', async () => {
  const u = await newUser('vv2');
  for (const body of ['', 'x'.repeat(200), '<kml><Document></Document></kml>' + ' '.repeat(60), '<kml><Polygon><coordinates>a,b c,d</coordinates></Polygon></kml>' + ' '.repeat(40),
    '<kml>' + '<Polygon>'.repeat(5000) + '</kml>']) {
    const r = await survives(() => u.req('POST', '/api/import/veloviewer-kml', body, { raw: true, headers: { 'Content-Type': 'text/plain' } }));
    assert.equal(r.status, 400, body.slice(0, 30) + ' → ' + r.status); noStack(r);
  }
  assert.equal((await new Client().req('POST', '/api/import/veloviewer-kml', tileKml([[1, 1]]), { raw: true, headers: { 'Content-Type': 'text/plain' } })).status, 401);
});

// ═══════════════ FOOT: walking and running, turn hints for the voice ═══════════
await T('FOOT-01', 'profil pieszy i biegowy: trasa po ścieżkach, wskazówki skrętów wskazują punkty trasy', async () => {
  if (!brouter) throw new Error('BRouter niedostępny');
  const a = { lat: 52.135, lng: 21.225 }, b = { lat: 52.150, lng: 21.250 };
  const out = [];
  for (const p of ['foot', 'run', 'gravel']) {
    const r = await A.post('/api/route/detour', { waypoints: [a, b], mode: 'shortest', bikeProfile: p });
    assert.equal(r.status, 200, `${p}: ${r.text.slice(0, 120)}`);
    const rt = r.json.routes[0], c = rt.geometry.coordinates;
    assert.ok(c.length > 10 && rt.distance > 1500 && rt.distance < 9000, `${p}: ${rt.distance} m`);
    assert.ok(Array.isArray(rt.hints) && rt.hints.length > 0, `${p}: brak wskazówek skrętów`);
    let prev = -1;
    for (const h of rt.hints) {
      assert.equal(h.length, 5); assert.ok(Number.isInteger(h[0]) && h[0] >= prev && h[0] < c.length, `${p}: indeks ${h[0]} poza trasą (${c.length})`);
      assert.ok(Number.isInteger(h[1]) && h[1] > 0, 'komenda'); prev = h[0];
    }
    out.push(`${p} ${(rt.distance / 1000).toFixed(1)} km/${rt.hints.length} wsk.`);
  }
  // a turn hint sits where the line really bends
  const r = await A.post('/api/route/detour', { waypoints: [a, b], mode: 'shortest', bikeProfile: 'foot' });
  const c = r.json.routes[0].geometry.coordinates, turns = r.json.routes[0].hints.filter(h => Math.abs(h[4]) >= 60 && h[0] > 0 && h[0] < c.length - 1);
  const brg = (p, q) => Math.atan2((q[0] - p[0]) * Math.cos(p[1] * Math.PI / 180), q[1] - p[1]) * 180 / Math.PI;
  let okTurns = 0;
  for (const h of turns) {
    const i = h[0], d = Math.abs(((brg(c[i], c[Math.min(c.length - 1, i + 2)]) - brg(c[Math.max(0, i - 2)], c[i]) + 540) % 360) - 180);
    if (d > 25) okTurns++;
  }
  assert.ok(!turns.length || okTurns >= turns.length * 0.7, `tylko ${okTurns}/${turns.length} ostrych skrętów leży na zakręcie linii`);
  return out.join(', ') + ` · zakręty ${okTurns}/${turns.length}`;
}, { sev: 1 });
await T('FOOT-02', 'zapisana trasa przechowuje wskazówki i profil; błędne wskazówki są odrzucane, nie psują zapisu', async () => {
  const body = routeBody('Bieg ze wskazówkami', { profile: 'run', hints: [[2, 2, 0, 150, -88], [9, 5, 0, 300, 91], [15, 13, 2, 80, 0]] });
  const id = (await A.post('/api/routes', body)).json.id;
  const got = (await A.get('/api/routes/' + id)).json;
  assert.deepEqual(got.hints, body.hints); assert.equal(got.profile, 'run');
  for (const bad of [[[99999, 2, 0, 1, 1]], [[-1, 2]], [['a', 2]], 'tekst', [[1.5, 2]], Array.from({ length: 6000 }, () => [1, 2, 0, 1, 1])]) {
    const r = await survives(() => A.post('/api/routes', routeBody('Złe wskazówki', { hints: bad })));
    assert.equal(r.status, 200, JSON.stringify(bad).slice(0, 40) + ' → ' + r.status);
    assert.equal((await A.get('/api/routes/' + r.json.id)).json.hints, null);
    await A.del('/api/routes/' + r.json.id);
  }
  const g = await A.get(`/api/routes/${id}/gpx`);
  if (g.status === 200) assert.match(g.text, /<type>running<\/type>/, 'typ aktywności w GPX');
  await A.del('/api/routes/' + id);
});

// ═════════════════════════ PWA: install and offline shell ══════════════════════
await T('PWA-01', 'manifest, ikony i service worker są serwowane poprawnie', async () => {
  const m = await anon.get('/api/manifest.webmanifest');
  assert.equal(m.status, 200); assert.match(m.headers.get('content-type'), /manifest\+json/);
  assert.equal(m.json.name, (await anon.get('/api/auth/providers')).json.appName); assert.equal(m.json.display, 'standalone'); assert.equal(m.json.start_url, '/');
  assert.ok(m.json.icons.some(i => i.purpose === 'maskable') && m.json.icons.some(i => i.sizes === '192x192'));
  for (const i of m.json.icons) {
    const r = await fetch(BASE + i.src); assert.equal(r.status, 200, i.src); assert.match(r.headers.get('content-type'), /image\/png/);
    const b = Buffer.from(await r.arrayBuffer()); assert.equal(b.readUInt32BE(16), +i.sizes.split('x')[0], i.src + ' ma inną szerokość niż w manifeście');
  }
  const sw = await anon.get('/sw.js');
  assert.equal(sw.status, 200); assert.match(sw.headers.get('content-type'), /javascript/);
  assert.ok(!/max-age=[1-9]\d{3,}/.test(sw.headers.get('cache-control') || ''), 'sw.js nie może być długo buforowany: ' + sw.headers.get('cache-control'));
  const idx = await anon.get('/');
  assert.match(idx.text, /rel="manifest"/); assert.match(idx.text, /apple-touch-icon/);
});

// ═══════════════════════════ WND: a loop into the wind ═════════════════════════
await T('WND-01', 'pętla „pod wiatr na początek”: leży po stronie, z której wieje', async () => {
  if (!brouter) throw new Error('BRouter niedostępny');
  const start = { lat: 52.14, lng: 21.23 }, out = [];
  for (const [from, name] of [[0, 'N'], [180, 'S']]) {
    const r = await A.post('/api/route/detour', { waypoints: [start], loop: true, targetKm: 20, mode: 'sqi', windFrom: from }, { timeout: 180000 });
    assert.equal(r.status, 200, `${name}: ${r.text.slice(0, 140)}`);
    const c = r.json.routes[0].geometry.coordinates, km = r.json.routes[0].distance / 1000;
    const dLat = c.reduce((s, p) => s + p[1], 0) / c.length - start.lat;
    assert.ok(from === 0 ? dLat > 0.004 : dLat < -0.004, `wiatr z ${name}: środek pętli ${dLat.toFixed(4)}° od startu`);
    assert.ok(km > 14 && km < 26, 'km=' + km.toFixed(1));
    out.push(`${name}: ${km.toFixed(1)} km, środek ${(dLat * 111).toFixed(1)} km`);
  }
  for (const bad of ['abc', null, {}, 1e99]) {
    const r = await survives(() => A.post('/api/route/detour', { waypoints: [start], loop: true, targetKm: 12, mode: 'sqi', windFrom: bad }, { timeout: 180000 }));
    no5xx(r, 'windFrom=' + JSON.stringify(bad));
  }
  return out.join(' · ');
});

// ═════════════════════ I18N: language files are complete ═══════════════════════
const PACKS = ['de', 'nl', 'fr', 'cs'];
const holes = (s) => [...String(s).matchAll(/\$\d|\{\w+\}|<\/?[a-z]+>/g)].map(m => m[0]).sort().join(' ');
await T('I18N-01', 'każdy plik języka (de, nl, fr, cs) ma wszystkie teksty interfejsu, z tymi samymi polami i znacznikami', async () => {
  const src = loadI18n('en').sqI18nSource, out = [];
  const pairs = codePairs().filter(([pl]) => pl !== 'pl');
  for (const code of PACKS) {
    const p = readPack(code);
    assert.equal(p.code, code);
    const rx = new Map(p.rx), sub = new Map(p.sub), bad = [];
    for (const [pl, en] of Object.entries(src.map)) { const v = p.map[pl]; if (typeof v !== 'string' || !v.trim()) bad.push('brak: ' + pl); else if (holes(v) !== holes(en)) bad.push('pola: ' + pl); }
    for (const [pl, en] of src.rx) { const v = rx.get(pl); if (!v) bad.push('brak wzorca: ' + pl); else if (holes(v) !== holes(en)) bad.push('pola wzorca: ' + pl); }
    for (const [pl] of src.sub) if (!sub.get(pl)) bad.push('brak fragmentu: ' + pl);
    for (const [pl, en] of pairs) { const v = p.map[pl]; if (typeof v !== 'string') bad.push('brak tekstu z kodu: ' + pl); else if (holes(v) !== holes(en)) bad.push('pola tekstu z kodu: ' + pl); }
    assert.equal(bad.length, 0, `${code}: ${bad.length} braków, np. ${bad.slice(0, 4).join(' | ')}`);
    // nothing left in Polish by mistake
    const same = Object.entries(p.map).filter(([pl, v]) => v === pl && /[ąćęłńóśźż]/.test(pl));
    assert.equal(same.length, 0, `${code}: nieprzetłumaczone ${same.slice(0, 3).map(x => x[0]).join(' | ')}`);
    out.push(`${code} ${Object.keys(p.map).length}+${p.rx.length}`);
  }
  return out.join(', ');
}, { sev: 2 });
await T('I18N-02', 'teksty składane w kodzie (ze zmiennymi) i komunikaty serwera wychodzą w wybranym języku', async () => {
  const front = ['index.html', 'extras.js'].map(f => fs.readFileSync(path.join(HERE, '..', 'frontend', f), 'utf8')).join('\n');
  // tl(`… ${x} …`, `…`): the Polish template as the page would build it, with sample values
  const tpl = [...front.matchAll(/\btl\(`((?:[^`\\]|\\.)*\$\{(?:[^`\\]|\\.)*)`,\s*`((?:[^`\\]|\\.)*)`\)/g)].map(m => [m[1], m[2]]);
  assert.ok(tpl.length >= 6, 'nie znaleziono tekstów ze zmiennymi');
  const enOf = loadI18n('en'), polish = serverTexts().filter(s => enOf.t(s) !== s);
  assert.ok(polish.length > 80, 'komunikatów serwera: ' + polish.length);
  const fill = (s) => { let i = 0; return s.replace(/\$\{[^}]*\}/g, () => String(3 + i++)); };
  for (const code of PACKS) {
    const w = loadI18n(code, [code]);
    for (const [pl, en] of tpl) {
      const got = w.tl(fill(pl), fill(en));
      assert.ok(got !== fill(en) && got !== fill(pl), `${code}: „${pl}” zostaje po angielsku/polsku`);
      assert.ok(/3/.test(got), `${code}: zgubiona wartość w „${got}”`);
    }
    // a message the pack lacks comes out in English: allow only the few that read the same in both
    const missing = polish.filter(s => w.t(s) === s || w.t(s) === enOf.t(s));
    assert.ok(missing.length <= 3, `${code}: komunikaty serwera bez tłumaczenia (${missing.length}): ${missing.slice(0, 4).join(' | ')}`);
    assert.equal(w.tl('nowych SQ', 'new SQ') === 'new SQ', false);
  }
  const noEn = serverTexts().filter(s => /[ąćęłńóśźż]/.test(s) && !/: $/.test(s) && enOf.t(s) === s);   // "…: " is a prefix of a longer message
  assert.equal(noEn.length, 0, `komunikaty serwera bez angielskiego: ${noEn.slice(0, 3).join(' | ')}`);
});
await T('I18N-03', 'pliki języków są serwowane', async () => {
  for (const code of PACKS) {
    const r = await anon.get(`/i18n/${code}.js`);
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /javascript/); assert.ok(r.text.startsWith('//') && r.text.includes(`sqLangPack("${code}"`));
  }
});

const fails = S.done();
process.exit(fails ? 1 : 0);
