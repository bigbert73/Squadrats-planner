// End-to-end tests in a real (headless) Chromium, driven with real pointer
// input: mouse on desktop, touch on a phone-sized screen.
//   node tests/e2e.mjs desktop      node tests/e2e.mjs mobile
import path from 'node:path';
import fs from 'node:fs';
import { suite, assert, Browser, Client, routeBody, newUser, sql, ensureUp, sleep, uniq, PASSWORD, ENV, BASE, HERE, AREA, gpxOf, tileOf, tileCenter, VIEWPORTS } from './lib.mjs';

const vp = process.argv[2] || 'desktop';
const only = process.argv[3];
const mobile = VIEWPORTS[vp].mobile;
const S = suite('e2e-' + vp);
const T = (id, title, fn, o) => (!only || id.startsWith(only)) ? S.t(id, title, fn, o) : null;
const SHOTS = path.join(HERE, 'shots');
await ensureUp();
const browser = await Browser.launch();
const p = await browser.newPage(vp);
const shot = (pg, name) => pg.shot(path.join(SHOTS, `${vp}-${name}.png`));
const J = v => JSON.stringify(v);

// ── Page helpers ─────────────────────────────────────────────────────────────
const gateOn = `(document.getElementById('auth-gate').style.display==='flex')`;
async function open(pg) {
  await pg.goto(BASE + '/');
  await pg.waitFor(`typeof checkAuth==='function'&&typeof map!=='undefined'&&(${gateOn}||(typeof currentUser!=='undefined'&&!!currentUser))`, 30000);
  await sleep(400);
}
async function uiLogin(pg, user, pass = PASSWORD) {
  await pg.newAddress();
  await pg.click('#atp-login');
  await pg.type('#login-user', user); await pg.type('#login-pass', pass);
  await pg.click('#form-login .auth-submit');
}
async function loggedIn(pg, user) {
  await pg.waitFor(`!${gateOn}&&currentUser&&currentUser.username===${J(user)}`, 15000);
  await sleep(700);
}
async function uiRegister(pg, user, pass = PASSWORD, pass2 = pass) {
  await pg.newAddress();
  await pg.click('#atp-reg');
  await pg.type('#reg-user', user); await pg.type('#reg-pass', pass); await pg.type('#reg-pass2', pass2);
  await pg.click('#form-reg .auth-submit');
}
async function uiLogout(pg) {
  await pg.click('#user-menu-btn'); await sleep(250);
  await pg.click('#user-dropdown .udrop-danger');
  // logging out reloads the page
  await pg.waitFor(`document.readyState==='complete'&&typeof checkAuth==='function'&&typeof currentUser!=='undefined'&&!currentUser&&${gateOn}`, 12000); await sleep(400);
}
async function closeSheets(pg) { await pg.ev(`(typeof closeMobileMenu==='function'&&closeMobileMenu(),document.querySelectorAll('#routes-modal,#profile-modal,#admin-modal').forEach(m=>{if(!m.hidden&&m.style.display!=='none'){m.hidden=true}}),1)`); await sleep(350); }
// On a phone the planning form lives in a bottom sheet.
async function showPanel(pg) { if (mobile && !(await pg.ev(`document.body.classList.contains('mob-open')||!!document.querySelector('#sb.open,#sb.mob-open,.sb-open')`))) { await pg.ev(`openPlanSheet()`); await sleep(500); } }
// Tap the map at a coordinate with a real pointer event.
async function tapMap(pg, lat, lng) {
  const pt = await pg.ev(`(()=>{const c=map.latLngToContainerPoint([${lat},${lng}]),r=map.getContainer().getBoundingClientRect();const x=r.left+c.x,y=r.top+c.y;
    const h=document.elementFromPoint(x,y);return{x,y,onMap:!!h&&map.getContainer().contains(h)&&!h.closest('#mode-toolbar,#draw-bar,.leaflet-control,#map-toolbar,.leaflet-marker-icon'),top:h?(h.id||String(h.className)):null}})()`);
  if (!pt.onMap) throw new Error(`punkt mapy zasłonięty przez ${pt.top}`);
  await pg.pointAt(pt.x, pt.y); await sleep(350);
}
const routeReady = `routeCoords.length>10&&document.getElementById('loading').classList.contains('h')`;
const state = pg => pg.ev(`({wpts:wpts.length,coords:routeCoords.length,routes:typeof _routes!=='undefined'?_routes.length:-1,sqi:ownedSQI.size,sq:ownedSQ.size,blocked:blockedSQI.size,
  rows:document.querySelectorAll('#wl .wr, #wl .wrow, #wl [data-i]').length,card:(()=>{const c=document.getElementById('rc')||document.querySelector('.route-card');return c?getComputedStyle(c).display!=='none'&&c.offsetHeight>0:null})(),
  adminBtn:getComputedStyle(document.getElementById('admin-menu-btn')).display!=='none',name:document.getElementById('user-name-btn').textContent,mode})`);
// Controls a finger would have trouble hitting (smaller than 40 px in either direction).
const smallTargets = `(()=>{const out=[];document.querySelectorAll('button,a.udrop-btn,select,input[type=radio],input[type=checkbox],.loop-opt,[onclick]').forEach(e=>{const b=e.getBoundingClientRect();if(!b.width||!b.height||e.matches('.sheet-handle'))return;
  const h=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);if(!h||!(h===e||e.contains(h)||h.contains(e)))return;
  const lab=e.closest('label');const bb=lab?lab.getBoundingClientRect():b;if(Math.min(bb.width,bb.height)<40)out.push((e.id||(e.title||e.textContent||e.className).trim().slice(0,22))+' '+Math.round(bb.width)+'×'+Math.round(bb.height));});return out})()`;
const problems = (pg, allow = []) => pg.takeProblems().filter(x => !/favicon|tile\.openstreetmap|basemaps|ERR_ABORTED|nominatim|net::ERR_FAILED https?:\/\/(?!localhost)/.test(x) && !allow.some(a => a.test(x)));

// ── Accounts used below ──────────────────────────────────────────────────────
const uA = uniq('ewa'), uB = (await newUser('jan')).username;
const P1 = { lat: 52.1352, lng: 21.2262 }, P2 = { lat: 52.1432, lng: 21.2371 }, P3 = { lat: 52.1461, lng: 21.2255 };

await T('E-01', 'bez logowania: widać tylko okno logowania, aplikacja pod spodem jest niedostępna', async () => {
  await open(p);
  assert.ok(await p.ev(gateOn), 'brak okna logowania');
  const hit = await p.ev(`(()=>{const pts=[[innerWidth/2,innerHeight/2],[30,30],[innerWidth-30,30],[innerWidth/2,innerHeight-30]];return pts.every(([x,y])=>{const e=document.elementFromPoint(x,y);return e&&!!e.closest('#auth-gate')})})()`);
  assert.ok(hit, 'elementy aplikacji są klikalne obok okna logowania');
  assert.equal(await p.ev(`fetch('/api/routes').then(r=>r.status)`), 401);
  await shot(p, '01-logowanie');
  if (mobile) {
    const small = [...await p.ev(smallTargets)]; await p.click('#atp-reg'); await sleep(250); small.push(...await p.ev(smallTargets)); await p.click('#atp-login'); await sleep(200);
    assert.ok(!small.length, 'za małe przyciski w oknie logowania: ' + [...new Set(small)].join(' | '));
  }
  const pr = problems(p, [/401/]); assert.ok(!pr.length, pr.join(' | '));
});
await T('E-02', 'rejestracja: niezgodne hasła → komunikat, konto nie powstaje', async () => {
  await uiRegister(p, uA, PASSWORD, 'Inne-haslo-9'); await sleep(600);
  assert.ok((await p.ev(`document.getElementById('reg-err').textContent`)).length > 3, 'brak komunikatu');
  assert.ok(await p.ev(gateOn)); assert.equal(sql('SELECT count(*) n FROM users WHERE username=?', [uA])[0].n, 0);
});
await T('E-03', 'rejestracja przez formularz: wejście do aplikacji, nazwa w nagłówku, brak przycisku admina', async () => {
  await p.type('#reg-pass2', PASSWORD); await p.click('#form-reg .auth-submit');
  await loggedIn(p, uA);
  const s = await state(p); assert.equal(s.name, uA); assert.equal(s.adminBtn, false);
  await shot(p, '02-po-rejestracji');
  const pr = problems(p, [/401/]); assert.ok(!pr.length, pr.join(' | '));
});
await T('E-04', 'logowanie: złe hasło → komunikat; dobre → wejście (po wylogowaniu z menu)', async () => {
  await uiLogout(p);
  await uiLogin(p, uA, 'zle-haslo-1'); await sleep(700);
  assert.ok((await p.ev(`document.getElementById('login-err').textContent`)).length > 3, 'brak komunikatu o złym haśle');
  await uiLogin(p, uA); await loggedIn(p, uA);
  problems(p);
});
await T('E-05', 'trasa A→B: start i meta wskazane na mapie, „Wyznacz trasę”, kilometry przy punktach', async () => {
  await p.ev(`map.setView([52.1405,21.231],14,{animate:false});1`); await sleep(600);
  await showPanel(p);
  await p.click('label.loop-opt:has(input[value="ab"])'); await sleep(200);
  assert.ok(await p.ev(`document.querySelector('input[name="loop"][value="ab"]').checked`), 'wybór „A→B” nie zaznaczył się');
  if (mobile) await closeSheets(p);
  await p.click('#mb-start'); await tapMap(p, P1.lat, P1.lng);
  await p.click('#mb-end'); await tapMap(p, P2.lat, P2.lng);
  const s0 = await state(p); assert.equal(s0.wpts, 2, 'punkty po dwóch stuknięciach: ' + s0.wpts);
  await showPanel(p);
  await p.click('.calc-btn');
  await p.waitFor(routeReady, 60000); await sleep(1200);
  const km = await p.ev(`[...document.querySelectorAll('#wl .wkm')].map(e=>e.textContent)`);
  assert.equal(km.length, 2); assert.equal(km[0], '0.0 km'); assert.ok(parseFloat(km[1]) > 1, 'km mety: ' + km[1]);
  assert.ok(Math.abs(parseFloat(km[1]) - await p.ev(`_planKm`)) < 0.06);
  await shot(p, '03-trasa-ab');
  const pr = problems(p); assert.ok(!pr.length, pr.join(' | '));
}, { sev: 2 });
await T('E-06', 'zapis trasy z karty trasy i lista „Moje trasy”', async () => {
  await showPanel(p);
  await p.click('#rc-save'); await sleep(250);
  await p.type('#rc-save-name', 'Do Świdra & <b>z powrotem</b>');
  await p.click('#rc-save-form button[type="submit"]');
  await p.waitFor(`_routes.length===1`, 8000);
  await closeSheets(p);
  await p.click('#routes-btn'); await sleep(500);
  const card = await p.ev(`(()=>{const c=document.querySelector('#rt-list .rt-card');return c?{name:c.querySelector('.rt-name b').textContent,html:c.querySelector('.rt-name b').innerHTML,km:c.querySelector('.km').textContent}:null})()`);
  assert.equal(card.name, 'Do Świdra & <b>z powrotem</b>'); assert.ok(!/<b>z/.test(card.html), 'nazwa trasy wstawiona jako HTML');
  await shot(p, '04-moje-trasy');
}, { sev: 2 });
await T('E-07', '„Moje trasy”: zmiana nazwy, otwarcie na mapie, usunięcie z potwierdzeniem', async () => {
  await p.click('#rt-list .rt-ren'); await sleep(200);
  await p.type('#rt-list .rt-name input', 'Świder wieczorem'); await p.key('Enter');
  await p.waitFor(`_routes[0]&&_routes[0].name==='Świder wieczorem'`, 6000);
  await p.ev(`resetRoute();1`);
  await p.click('#rt-list .op'); await p.waitFor(`routeCoords.length>10&&document.getElementById('routes-modal').hidden`, 10000); await sleep(600);
  const s = await state(p); assert.equal(s.wpts, 2, 'punkty po otwarciu zapisanej trasy');
  await p.click('#routes-btn'); await sleep(400);
  await p.click('#rt-list .del'); await sleep(250);
  assert.equal(await p.ev(`_routes.length`), 1, 'pierwsze kliknięcie tylko uzbraja przycisk');
  await p.click('#rt-list .del'); await p.waitFor(`_routes.length===0`, 6000);
  assert.equal(sql('SELECT count(*) n FROM saved_routes s JOIN users u ON u.id=s.user_id WHERE u.username=?', [uA])[0].n, 0);
  await closeSheets(p);
  const pr = problems(p); assert.ok(!pr.length, pr.join(' | '));
}, { sev: 2 });
await T('E-08', 'rysowanie: trzy punkty, cofnij, ponów, „Gotowe” — trasa po drogach', async () => {
  await closeSheets(p);
  await p.ev(`resetRoute();map.setView([52.1405,21.231],14,{animate:false});1`); await sleep(500);
  await p.click('#mb-draw'); await sleep(300);
  assert.ok(await p.ev(`getComputedStyle(document.getElementById('draw-bar')).display!=='none'`), 'pasek rysowania');
  for (const q of [P1, P2, P3]) { await tapMap(p, q.lat, q.lng); await p.waitFor(`!_drawBusy`, 30000); }
  await p.waitFor(`routeSegments.length===2&&!_drawBusy`, 30000);
  await shot(p, '05-rysowanie');
  await p.click('#db-undo'); await sleep(400);
  assert.equal(await p.ev(`wpts.length`), 2, 'cofnij usuwa ostatni punkt');
  await p.click('#db-redo'); await p.waitFor(`wpts.length===3&&routeSegments.length===2&&!_drawBusy`, 30000);
  await p.click('#draw-bar .db-ok');
  await p.waitFor(`mode==='view'&&${routeReady}`, 60000); await sleep(1000);
  const km = await p.ev(`[...document.querySelectorAll('#wl .wkm')].map(e=>parseFloat(e.textContent))`);
  assert.equal(km.length, 3); assert.ok(km[0] === 0 && km[1] > 0 && km[2] > km[1], 'km: ' + km);
  assert.ok(await p.ev(`getComputedStyle(document.getElementById('draw-bar')).display==='none'`), 'pasek rysowania znika po „Gotowe”');
  const pr = problems(p); assert.ok(!pr.length, pr.join(' | '));
}, { sev: 2 });
await T('E-09', 'import GPX z pliku: kwadraty pojawiają się na koncie', async () => {
  const f = path.join(SHOTS, `import-${vp}.gpx`); fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(f, gpxOf([{ lat: 52.3, lng: 20.9 }, { lat: 52.31, lng: 20.91 }]));
  const { root } = await p.send('DOM.getDocument');
  const { nodeId } = await p.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#gpx-in' });
  await p.send('DOM.setFileInputFiles', { nodeId, files: [f] });
  await p.waitFor(`ownedSQI.size>0`, 15000);
  fs.unlinkSync(f);
  const vis = await p.ev(`(()=>{const b=document.getElementById('tab-sq-btn');return getComputedStyle(b).display!=='none'})()`);
  assert.ok(vis, 'konto bez Stravy ma kwadraty (import GPX/KML), ale zakładka „Kwadraty” z warstwami i importem jest ukryta');
}, { sev: 3 });
await T('E-10', 'wygasła sesja: zapis trasy prowadzi do ponownego logowania, a nie do cichego błędu', async () => {
  await p.clearCookies();
  await showPanel(p);
  await p.click('#rc-save'); await sleep(200); await p.click('#rc-save-form button[type="submit"]'); await sleep(1500);
  const gate = await p.ev(gateOn), toastTxt = await p.ev(`document.getElementById('toast').textContent`);
  await shot(p, '06-wygasla-sesja');
  assert.ok(gate, `po wygaśnięciu sesji użytkownik widzi tylko: „${toastTxt}” — bez okna logowania`);
  assert.ok(await p.ev(`!document.getElementById('auth-note').hidden&&document.getElementById('auth-note').textContent.length>10`), 'okno logowania nie mówi, dlaczego wróciło');
  // the same person logs in again: the route is still there and can be saved
  const before = await state(p);
  await uiLogin(p, uA); await loggedIn(p, uA);
  const after = await state(p);
  assert.ok(before.coords > 10 && after.coords === before.coords && after.wpts === before.wpts, `trasa po ponownym zalogowaniu: ${before.coords} → ${after.coords} pkt`);
  await showPanel(p);
  await p.click('#rc-save'); await sleep(200); await p.type('#rc-save-name', 'Po ponownym logowaniu'); await p.click('#rc-save-form button[type="submit"]');
  await p.waitFor(`_routes.some(r=>r.name==='Po ponownym logowaniu')`, 8000);
  await closeSheets(p);
  await p.clearCookies(); await p.ev(`loadSavedRoutes();1`); await p.waitFor(gateOn, 6000);
}, { sev: 3 });
await T('E-11', 'zmiana konta w tej samej przeglądarce: nic po poprzedniej osobie (trasa, punkty, kwadraty)', async () => {
  assert.ok(await p.ev(gateOn), 'okno logowania po wygaśnięciu sesji');
  await uiLogin(p, uB); await loggedIn(p, uB); await sleep(1200);
  await closeSheets(p);
  const s = await state(p);
  await shot(p, '07-po-zmianie-konta');
  assert.equal(s.name, uB);
  assert.equal(s.sqi, 0, `kwadraty poprzedniego konta: ${s.sqi}`);
  assert.equal(s.routes, 0, 'trasy poprzedniego konta na liście');
  assert.ok(s.wpts === 0 && s.coords === 0, `na mapie została trasa poprzedniej osoby (punkty: ${s.wpts}, geometria: ${s.coords} pkt)`);
}, { sev: 2 });
await T('E-12', 'panel admina: lista kont; złośliwa nazwa użytkownika nie uruchamia kodu', async () => {
  const evil1 = `x');window.__xss=1;//${uniq('')}`.slice(0, 40), evil2 = `<img src=x onerror="window.__xss=2">${uniq('')}`;
  for (const n of [evil1, evil2]) sql("INSERT INTO users (username,password_hash,role) VALUES (?,'x','user')", [n]);
  await uiLogout(p);
  await uiLogin(p, ENV.SQ_TEST_ADMIN, ENV.SQ_TEST_ADMIN_PASSWORD); await loggedIn(p, ENV.SQ_TEST_ADMIN);
  assert.equal((await state(p)).adminBtn, true);
  await p.click('#user-menu-btn'); await sleep(250); await p.click('#admin-menu-btn');
  await p.waitFor(`document.querySelectorAll('#admin-users-list button').length>2`, 8000); await sleep(400);
  await shot(p, '08-panel-admina');
  p.acceptDialogs = false; // answer "Cancel" to every confirm()
  const n = await p.ev(`(()=>{const bs=[...document.querySelectorAll('#admin-users-list [onclick*="adminDeleteUser"]')];bs.forEach(b=>{try{b.click()}catch(e){}});return bs.length})()`);
  await sleep(500); p.acceptDialogs = true;
  const xss = await p.ev(`window.__xss||0`);
  for (const nme of [evil1, evil2]) sql('DELETE FROM users WHERE username=?', [nme]);
  assert.ok(n >= 2, 'brak przycisków usuwania');
  assert.equal(xss, 0, `kod z nazwy użytkownika wykonał się w sesji administratora (wariant ${xss})`);
  assert.ok(sql('SELECT count(*) n FROM users WHERE username=?', [uB])[0].n === 1, 'anulowanie potwierdzenia nie usuwa konta');
  problems(p);
}, { sev: 1 });
await T('E-13', 'po wylogowaniu admina zwykły użytkownik nie widzi „Panelu admina”', async () => {
  await closeSheets(p); await p.ev(`typeof closeAdmin==='function'&&closeAdmin();1`);
  await uiLogout(p); await uiLogin(p, uB); await loggedIn(p, uB);
  const s = await state(p);
  assert.equal(s.adminBtn, false, 'przycisk „Panel admina” został po poprzednim koncie');
}, { sev: 3 });
await T('E-14', 'warstwy zapamiętane na koncie: po odświeżeniu zostają, na innym koncie są domyślne', async () => {
  const before = await p.ev(`JSON.stringify(currentUser.layers)`);
  await p.ev(`togLyr('grid14',document.getElementById('lb-grid14'),'p');1`);
  await p.waitFor(`fetch('/api/auth/me').then(r=>r.json()).then(u=>JSON.stringify(u.layers)!==${J(before)})`, 6000);
  const mine = await p.ev(`fetch('/api/auth/me').then(r=>r.json()).then(u=>u.layers)`);
  await open(p); await loggedIn(p, uB);
  assert.equal(await p.ev(`document.getElementById('lb-grid14').classList.contains('on')`), !!mine.grid14, 'stan przycisku po odświeżeniu');
  const other = sql('SELECT map_layers m FROM users WHERE username=?', [uA])[0].m;
  assert.ok(!other || !/grid14":true/.test(other), 'ustawienie przeniosło się na inne konto');
});
await T('E-15', 'profil: zmiana hasła i usunięcie konta z poziomu aplikacji', async () => {
  await p.click('#user-menu-btn'); await sleep(250);
  await p.click('#user-dropdown button[onclick^="openProfile"]'); await sleep(600);
  await shot(p, '09-profil');
  await p.type('#prof-pass-cur', PASSWORD); await p.type('#prof-pass-new', 'Nowe-haslo-7'); await p.type('#prof-pass-new2', 'Nowe-haslo-7');
  await p.click('#prof-pass-section button[onclick="changePassword()"]'); await sleep(900);
  assert.equal(await p.ev(`fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-For':'10.9.9.9'},body:JSON.stringify({username:${J(uB)},password:'Nowe-haslo-7'})}).then(r=>r.status)`), 200, 'nowe hasło nie działa');
  await p.click('#prof-del-btn'); await sleep(200);
  await p.type('#prof-del-in', 'Nowe-haslo-7');
  await p.click('#prof-del-box button[onclick^="deleteAccount"]');
  await p.waitFor(`document.readyState==='complete'&&typeof checkAuth==='function'&&${gateOn}`, 15000);
  assert.equal(sql('SELECT count(*) n FROM users WHERE username=?', [uB])[0].n, 0);
  assert.ok(p.dialogs.some(d => d.type === 'alert'), 'potwierdzenie usunięcia');
  problems(p);
}, { sev: 2 });
await T('E-16', 'błąd serwera przy wyznaczaniu trasy: komunikat i odblokowany ekran', async () => {
  await uiLogin(p, uA); await loggedIn(p, uA);
  await p.ev(`resetRoute();map.setView([52.1405,21.231],14,{animate:false});window.__f=window.fetch;
    window.fetch=(u,o)=>String(u).includes('/api/route/detour')?Promise.resolve(new Response('{"error":"awaria testowa"}',{status:500,headers:{'Content-Type':'application/json'}})):window.__f(u,o);1`);
  await p.click('#mb-start'); await tapMap(p, P1.lat, P1.lng);
  await showPanel(p); await p.click('.calc-btn'); await sleep(2500);
  const r1 = await p.ev(`({load:document.getElementById('loading').classList.contains('h'),toast:document.getElementById('toast').textContent})`);
  // no network at all: the real request fails inside the browser
  await p.ev(`window.fetch=window.__f;1`);
  await p.offline(true);
  let r2;
  try {
    await p.click('.calc-btn'); await sleep(2500);
    r2 = await p.ev(`({load:document.getElementById('loading').classList.contains('h'),toast:document.getElementById('toast').textContent})`);
  } finally { await p.offline(false); }
  assert.ok(r1.load && r2.load, 'ekran „Ładowanie…” został na stałe');
  assert.ok(/awaria testowa|błąd|Błąd|nie udało/i.test(r1.toast), 'brak komunikatu przy HTTP 500: ' + r1.toast);
  assert.ok(/Brak połączenia z serwerem/.test(r2.toast) && !/Failed to fetch|NetworkError|TypeError/.test(r2.toast), 'przy braku sieci użytkownik widzi: „' + r2.toast + '”');
  assert.ok(!(await p.ev(gateOn)) && await p.ev(`!!currentUser`), 'brak sieci nie może wylogować');
  await sleep(600); p.takeProblems();
}, { sev: 3 });
await T('E-17', 'język EN: brak polskich napisów w widocznym interfejsie', async () => {
  await closeSheets(p);
  await p.ev(`setLang('en');1`); await sleep(900); await showPanel(p);
  const left = await p.ev(`(()=>{const out=new Set();const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;
    while(n=w.nextNode()){const e=n.parentElement;if(!e||e.closest('script,style,.notranslate,#auth-gate,.leaflet-control-attribution'))continue;const t=n.textContent.trim();
      const names=/GDOŚ|GUGiK|Wiślan\\w*|Jarosław\\w*|Świd\\w*|Józef\\w*|Otwock\\w*|Świerk\\w*|Michalin\\w*|Wisł\\w*/g; /* proper names stay Polish */
      const u=t.replace(names,'');
      if(u.length>2&&/[ąćęłńóśźż]|\\b(trasa|trasy|kwadraty|zapisz|usuń|wyznacz|punkt|mapa|pokaż|ustawienia)\\b/i.test(u))out.add(t.slice(0,50));}
    document.querySelectorAll('[title],[placeholder]').forEach(e=>{if(e.closest('.notranslate,#auth-gate'))return;for(const a of['title','placeholder']){const t=(e.getAttribute(a)||'').replace(/GDOŚ|GUGiK/g,'');if(/[ąćęłńóśźż]/i.test(t))out.add(a+': '+t.slice(0,50));}});
    return [...out]})()`);
  await shot(p, '10-en');
  await p.ev(`setLang('pl');1`); await sleep(500);
  assert.ok(left.length === 0, `${left.length} nieprzetłumaczonych: ${left.slice(0, 8).join(' | ')}`);
}, { sev: 4 });
await T('E-18', 'układ: brak poziomego przewijania i przycisków poza ekranem', async () => {
  await closeSheets(p);
  const bad = [];
  for (const name of (mobile ? ['small', 'mobile'] : ['tablet', 'laptop', 'desktop'])) {
    await p.setViewport(name); await sleep(500);
    for (const stateName of ['mapa', 'panel']) {
      if (stateName === 'panel' && VIEWPORTS[name].mobile) { await p.ev(`openPlanSheet();1`); await sleep(500); }
      const r = await p.ev(`(()=>{const W=innerWidth,H=innerHeight;const out=[];if(document.documentElement.scrollWidth>W+1)out.push('strona szersza niż ekran o '+(document.documentElement.scrollWidth-W)+'px');
        document.querySelectorAll('button,a.udrop-btn,input,select').forEach(e=>{const b=e.getBoundingClientRect();if(!b.width||!b.height||getComputedStyle(e).visibility==='hidden')return;
          const h=document.elementFromPoint(Math.min(W-1,Math.max(0,b.left+b.width/2)),Math.min(H-1,Math.max(0,b.top+b.height/2)));if(!h||!(h===e||e.contains(h)))return;
          if(b.right>W+2||b.left<-2)out.push((e.id||e.className||e.tagName)+' wystaje w poziomie');
          if(e.scrollWidth>e.clientWidth+2&&e.tagName==='BUTTON')out.push((e.id||e.className)+' — tekst się nie mieści');});return out})()`);
      r.forEach(x => bad.push(`${name}/${stateName}: ${x}`));
      await p.shot(path.join(SHOTS, `uklad-${name}-${stateName}.png`));
      if (stateName === 'panel') await closeSheets(p);
    }
  }
  // Floating map controls must not cover one another (draw bar vs. the column
  // of map buttons vs. the mode switch): every button reachable over its whole width.
  for (const name of (mobile ? ['small', 'mobile'] : ['tablet', 'laptop', 'desktop'])) {
    await p.setViewport(name); await p.ev(`setMode('draw');1`); await sleep(500);
    const r = await p.ev(`(()=>{const out=[];document.querySelectorAll('#draw-bar button,#mode-toolbar button,#mtools>button,#mtools .mtb').forEach(e=>{const b=e.getBoundingClientRect();if(!b.width||!b.height)return;
      for(const fx of [.12,.5,.88]){const h=document.elementFromPoint(b.left+b.width*fx,b.top+b.height/2);
        if(!h||!(h===e||e.contains(h))){out.push((e.id||e.className||e.textContent.trim()||'przycisk')+' zasłonięty przez '+(h?(h.id||h.className||h.tagName):'nic'));break;}}});return out})()`);
    r.forEach(x => bad.push(`${name}/rysowanie: ${x}`));
    await p.shot(path.join(SHOTS, `uklad-${name}-rysowanie.png`));
    await p.ev(`setMode('view');1`);
  }
  await p.setViewport(vp);
  assert.ok(!bad.length, bad.slice(0, 8).join(' | '));
}, { sev: 3 });
await T('E-19', 'dotyk: przyciski mają co najmniej 40 px (tylko ekran telefonu)', async () => {
  if (!mobile) return 'dotyczy telefonu';
  const small = [];
  const tab = id => `openPlanSheet();swTab('${id}',document.querySelector('#sbt .tb[onclick*="${id}"]'))`;
  const states = { mapa: '1', panel: 'openPlanSheet()', kwadraty: tab('sq'), nakladki: tab('hm'), opcje: tab('cfg'), menu: `document.getElementById('user-menu-btn').click()`, trasy: 'openRoutes()', profil: 'openProfile()', rysowanie: `setMode('draw')` };
  for (const [st, js] of Object.entries(states)) {
    await closeSheets(p); await p.ev(`closeRoutes();closeProfile();1`);
    await p.ev(js + ';1'); await sleep(600);
    (await p.ev(smallTargets)).forEach(x => small.push(`${st}: ${x}`));
    if (st === 'menu') await p.ev(`document.getElementById('user-menu-btn').click();1`);
    if (st === 'rysowanie') await p.ev(`setMode('view');1`);
  }
  await closeSheets(p); await p.ev(`closeRoutes();closeProfile();1`);
  assert.ok(small.length === 0, `${small.length} za małych: ${[...new Set(small)].slice(0, 14).join(' | ')}`);
}, { sev: 4 });
await T('E-20', 'ładowanie strony: wielkość i czas (pomiar)', async () => {
  const pg = await browser.newPage(vp);
  await pg.send('Network.setCacheDisabled', { cacheDisabled: true });
  await open(pg); await sleep(1500);
  const t = await pg.ev(`(()=>{const n=performance.getEntriesByType('navigation')[0];return{dcl:Math.round(n.domContentLoadedEventEnd),load:Math.round(n.loadEventEnd),html:n.encodedBodySize,htmlRaw:n.decodedBodySize}})()`);
  const own = pg.requests.filter(r => r.url.startsWith(BASE)), ext = pg.requests.filter(r => !r.url.startsWith(BASE) && !r.url.startsWith('data:'));
  const hosts = [...new Set(ext.map(r => new URL(r.url).host))];
  const kb = a => Math.round(a.reduce((s, r) => s + (r.bytes || 0), 0) / 1024);
  await pg.close();
  return `DOMContentLoaded ${t.dcl} ms, load ${t.load} ms; własne: ${own.length} żądań ${kb(own)} kB (HTML ${Math.round(t.html / 1024)} kB / ${Math.round(t.htmlRaw / 1024)} kB po rozpakowaniu); zewnętrzne: ${ext.length} żądań ${kb(ext)} kB z ${hosts.length} hostów (${hosts.join(', ')})`;
});

// ── Two people at the same time (separate browser profiles) ──────────────────
await T('E-21', 'dwie osoby naraz (komputer + telefon): każda widzi tylko swoje trasy i kwadraty', async () => {
  const u1 = await newUser('ola'), u2 = await newUser('piotr');
  const a = await browser.newPage('desktop'), b = await browser.newPage('mobile');
  try {
    await a.setCookie(u1.cookie); await b.setCookie(u2.cookie);
    await Promise.all([open(a), open(b)]);
    await Promise.all([loggedIn(a, u1.username), loggedIn(b, u2.username)]);
    const imp = (pg, lat) => pg.ev(`fetch('/api/gpx/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({gpxText:${J(gpxOf([{ lat, lng: 21 }, { lat: lat + 0.01, lng: 21.01 }]))}})}).then(()=>loadTilesFromDB())`);
    await Promise.all([imp(a, 52.5), imp(b, 51.5)]);
    await a.ev(`map.setView([52.1405,21.231],14,{animate:false});1`); await sleep(300);
    await a.click('label.loop-opt:has(input[value="ab"])'); await sleep(300);
    await a.click('#mb-start'); await tapMap(a, P1.lat, P1.lng); await a.click('#mb-end'); await tapMap(a, P2.lat, P2.lng);
    await a.click('.calc-btn'); await a.waitFor(routeReady, 60000);
    await a.click('#rc-save'); await sleep(200); await a.type('#rc-save-name', 'Trasa Oli'); await a.click('#rc-save-form button[type="submit"]');
    await a.waitFor(`_routes.length===1`, 8000);
    await b.click('#routes-btn'); await sleep(300); await b.ev(`loadSavedRoutes()`); await sleep(600);
    const sa = await state(a), sb = await state(b);
    assert.equal(sb.routes, 0, 'druga osoba widzi cudzą trasę'); assert.equal(sb.name, u2.username); assert.equal(sa.name, u1.username);
    assert.ok(sa.sqi > 0 && sb.sqi > 0);
    const own = (pg, lat) => pg.ev(`[...ownedSQI].every(k=>{const [x,y]=k.split('|').map(Number);const la=Math.atan(Math.sinh(Math.PI*(1-2*(y+.5)/131072)))*180/Math.PI;return Math.abs(la-${lat})<0.1})`);
    assert.ok(await own(a, 52.5) && await own(b, 51.5), 'kwadraty wymieszane między kontami');
    assert.equal(await b.ev(`document.querySelectorAll('#rt-list .rt-card').length`), 0);
    await b.shot(path.join(SHOTS, 'dwie-osoby-telefon.png')); await a.shot(path.join(SHOTS, 'dwie-osoby-komputer.png'));
    // the same account on a second device sees the route right away
    const c = await browser.newPage('mobile'); await c.setCookie(u1.cookie); await open(c); await loggedIn(c, u1.username);
    assert.equal(await c.ev(`_routes.length`), 1, 'to samo konto na drugim urządzeniu');
    await c.close();
    const pr = [...problems(a), ...problems(b)]; assert.ok(!pr.length, pr.join(' | '));
  } finally { await a.close(); await b.close(); }
}, { sev: 1 });
await T('E-22', 'usunięcie konta przez admina w trakcie sesji: użytkownik trafia do logowania', async () => {
  const u = await newUser('tmp'); const pg = await browser.newPage(vp);
  try {
    await pg.setCookie(u.cookie); await open(pg); await loggedIn(pg, u.username);
    sql('DELETE FROM users WHERE id=?', [u.id]);
    await pg.ev(`loadSavedRoutes&&loadSavedRoutes();loadTilesFromDB&&loadTilesFromDB();1`); await sleep(1500);
    await pg.ev(`openRoutes();1`); await sleep(1200);
    assert.ok(await pg.ev(gateOn), 'usunięty użytkownik dalej pracuje w aplikacji');
  } finally { await pg.close(); }
}, { sev: 3 });

await T('E-23', 'Strava jednym kliknięciem: przycisk na ekranie logowania → konto, kwadraty i mapa na miejscu jazd; odłączenie i ponowne połączenie w Profilu', async () => {
  const athlete = 8e8 + Math.floor(Math.random() * 1e8);
  const mockSet = (b) => fetch(ENV.SQ_TEST_STRAVA + '/__state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  await mockSet({ athlete, scope: 'read,activity:read,activity:read_all', deny: false, limit: false });
  const pg = await browser.newPage(vp);
  try {
    await open(pg); await pg.newAddress();
    await pg.waitFor(`document.getElementById('btn-strava').getBoundingClientRect().width>150`, 8000).catch(() => { throw new Error('brak przycisku „Kontynuuj ze Stravą”'); });
    const bs = await pg.ev(`(()=>{const b=document.getElementById('btn-strava'),r=b.getBoundingClientRect(),c=getComputedStyle(b);return{h:r.height,bg:c.backgroundColor,img:c.backgroundImage,fg:c.color}})()`);
    assert.ok(bs.h >= (mobile ? 40 : 36) && bs.bg === 'rgb(252, 76, 2)' && bs.fg === 'rgb(255, 255, 255)', 'przycisk Stravy nie w barwach Stravy: ' + J(bs));
    assert.ok(await pg.ev(`document.getElementById('btn-strava').getBoundingClientRect().top<document.getElementById('atp-login').getBoundingClientRect().top`), 'przycisk Stravy ma być pierwszą opcją');
    await shot(pg, '10-logowanie-strava');
    await pg.click('#btn-strava');
    await loggedIn(pg, 'Test Rider' + athlete);
    // the first sync runs by itself; the squares arrive without a click
    await pg.waitFor(`ownedSQI.size>10&&ownedSQ.size>0`, 25000);
    await sleep(1200);
    const v = await pg.ev(`({lat:map.getCenter().lat,lng:map.getCenter().lng,z:map.getZoom(),url:location.pathname+location.search,pills:getComputedStyle(document.getElementById('strava-pills')).display})`);
    const lat0 = 52.14 + (athlete % 7) * 0.05, lng0 = 21.23 + (athlete % 5) * 0.05;
    assert.ok(Math.abs(v.lat - lat0) < 0.08 && Math.abs(v.lng - lng0) < 0.12, `mapa nie pokazuje miejsca jazd: ${J(v)}`);
    assert.equal(v.url, '/', 'parametry logowania zostały w adresie');
    await shot(pg, '11-po-logowaniu-strava');
    const sqi = await pg.ev(`ownedSQI.size`);
    // Profile: connected, own keys tucked away, disconnect
    await closeSheets(pg);
    await pg.click('#user-menu-btn'); await sleep(250);
    await pg.click('#user-dropdown button[onclick^="openProfile"]'); await sleep(600);
    const pr1 = await pg.ev(`({st:document.getElementById('prof-strava-status').textContent,dis:getComputedStyle(document.getElementById('prof-disconnect-btn')).display,adv:document.getElementById('prof-strava-adv').open,pass:getComputedStyle(document.getElementById('prof-pass-section')).display})`);
    assert.match(pr1.st, /Połączona jako/); assert.notEqual(pr1.dis, 'none'); assert.equal(pr1.adv, false, 'klucze API mają być schowane');
    await shot(pg, '12-profil-strava');
    await pg.click('#prof-disconnect-btn');
    await pg.waitFor(`/Niepołączona/.test(document.getElementById('prof-strava-status').textContent)`, 8000);
    assert.ok(pg.dialogs.some(d => d.type === 'confirm' && /kwadraty zostają/.test(d.message)), 'brak pytania przed odłączeniem');
    assert.equal(await pg.ev(`getComputedStyle(document.getElementById('prof-disconnect-btn')).display`), 'none');
    assert.equal(await pg.ev(`ownedSQI.size`), sqi, 'kwadraty zniknęły po odłączeniu');
    assert.equal(sql('SELECT COUNT(*) n FROM strava_tokens t JOIN users u ON u.id=t.user_id WHERE u.username=?', ['Test Rider' + athlete])[0].n, 0);
    if (mobile) { const small = await pg.ev(smallTargets); assert.ok(!small.length, 'za małe przyciski w profilu: ' + small.join(' | ')); }
    // …and one click connects again
    await pg.click('#prof-connect-btn');
    await loggedIn(pg, 'Test Rider' + athlete);
    await pg.waitFor(`currentUser.strava_connected===true`, 8000);
    assert.equal(sql('SELECT COUNT(*) n FROM strava_tokens t JOIN users u ON u.id=t.user_id WHERE u.username=?', ['Test Rider' + athlete])[0].n, 1);
    const pr = problems(pg, [/401/]); assert.ok(!pr.length, pr.join(' | '));
  } finally { await pg.close(); }
}, { sev: 1 });
await T('E-24', 'Strava: odmowa na ekranie Stravy → komunikat na ekranie logowania, bez konta', async () => {
  const athlete = 7e8 + Math.floor(Math.random() * 1e8);
  await fetch(ENV.SQ_TEST_STRAVA + '/__state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ athlete, deny: true }) });
  const pg = await browser.newPage(vp);
  try {
    await open(pg); await pg.newAddress();
    await pg.click('#btn-strava');
    await pg.waitFor(`document.readyState==='complete'&&typeof checkAuth==='function'&&${gateOn}&&!location.search`, 15000); await sleep(600);
    const msg = await pg.ev(`document.getElementById('auth-gate').innerText`);
    assert.match(msg, /Nie udzielono dostępu do Stravy/, 'brak komunikatu: ' + msg.slice(0, 200));
    assert.equal(sql('SELECT COUNT(*) n FROM users WHERE oauth_id=?', [String(athlete)])[0].n, 0);
  } finally { await pg.close(); await fetch(ENV.SQ_TEST_STRAVA + '/__state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deny: false }) }); }
});

// ═════════════ N: account by e-mail, Apple, link, files, weather, offline, voice, languages ═════════════
const SVC = ENV.SQ_TEST_SERVICES;
const svc = (patch) => fetch(SVC + '/__state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).then(r => r.json());
const toastTxt = pg => pg.ev(`document.getElementById('toast').textContent`);
// A fresh person on a fresh page
async function fresh(prefix, extra, fn) {
  const u = await newUser(prefix, extra); const pg = await browser.newPage(vp);
  try { await pg.setCookie(u.cookie); await open(pg); await loggedIn(pg, u.username); return await fn(pg, u); }
  finally { await pg.close(); }
}
// Record what the page asks the planner for
const spyPlan = `(window.__plans=[],window.__f0=window.__f0||window.fetch,window.fetch=(u,o)=>{if(String(u).includes('/api/route/detour'))try{window.__plans.push(JSON.parse(o.body))}catch(e){};return window.__f0(u,o)},1)`;
// A turn with nothing announced just before it (the one ahead is always the nearest)
const lonelyTurn = (turns) => turns.find((x, i) => x.km > 0.25 && x.km - (turns[i - 1]?.km ?? 0) > 0.2) || turns.find(x => x.km > 0.25) || turns[0];
const setPts = (pts) => `(map.setView([${pts[0].lat},${pts[0].lng}],14),${pts.map((q, i) => `addWpt(L.latLng(${q.lat},${q.lng}),'${i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'via'}')`).join(',')},relabelWpts(),renderWL(),1)`;

await T('N-01', 'zapomniane hasło: prośba z ekranu logowania, link z listu, nowe hasło i od razu zalogowany', async () => {
  const em = uniq('n1') + '@example.org';
  const u = await newUser('n1', { email: em });
  const pg = await browser.newPage(vp);
  try {
    await open(pg); await pg.newAddress();
    await pg.click('#atp-login'); await pg.click('#forgot-link'); await sleep(200);
    await pg.type('#forgot-email', em);
    await pg.click('#form-forgot .auth-submit');
    await pg.waitFor(`!document.getElementById('forgot-ok').hidden`, 8000);
    assert.match(await pg.ev(`document.getElementById('forgot-ok').textContent`), /wysłaliśmy/i);
    await shot(pg, 'n01-forgot');
    let mail;
    for (let i = 0; i < 40 && !mail; i++) { mail = (await (await fetch(SVC + '/__mails')).json()).find(m => m.to.includes(em)); if (!mail) await sleep(150); }
    assert.ok(mail, 'list nie dotarł');
    const link = /https?:\/\/\S+#reset=[\w-]+/.exec(mail.text)[0];
    await pg.goto(BASE + '/' + link.slice(link.indexOf('#')));
    await pg.waitFor(`typeof checkAuth==='function'&&getComputedStyle(document.getElementById('form-reset')).display!=='none'`, 15000);
    assert.ok(!(await pg.ev(`location.href`)).includes('reset='), 'token został w pasku adresu');
    await pg.type('#reset-pass', 'Nowe-haslo-77'); await pg.type('#reset-pass2', 'Inne-haslo-77');
    await pg.click('#form-reset .auth-submit'); await sleep(500);
    assert.ok((await pg.ev(`document.getElementById('reset-err').textContent`)).length > 3, 'różne hasła przeszły bez komunikatu');
    await pg.ev(`(document.getElementById('reset-pass2').value='',1)`); await pg.type('#reset-pass2', 'Nowe-haslo-77');
    await pg.click('#form-reset .auth-submit');
    await loggedIn(pg, u.username);
    assert.equal((await new Client().post('/api/auth/login', { username: u.username, password: 'Nowe-haslo-77' })).status, 200);
    const pr = problems(pg, [/401/]); assert.ok(!pr.length, pr.join(' | '));
  } finally { await pg.close(); }
}, { sev: 1 });
await T('N-02', 'Apple: przycisk na ekranie logowania → konto i wejście do aplikacji', async () => {
  const sub = 'e2e-' + uniq('ap');
  await svc({ appleSub: sub, appleEmail: null, appleDeny: false });
  const pg = await browser.newPage(vp);
  try {
    await open(pg); await pg.newAddress();
    assert.ok(await pg.ev(`getComputedStyle(document.getElementById('btn-apple')).display!=='none'`), 'brak przycisku Apple');
    await pg.click('#btn-apple');
    await pg.waitFor(`location.origin===${J(BASE)}&&document.readyState==='complete'&&typeof currentUser!=='undefined'&&!!currentUser&&!${gateOn}`, 20000);
    assert.equal(sql('SELECT COUNT(*) n FROM users WHERE oauth_provider=? AND oauth_id=?', ['apple', sub])[0].n, 1);
    assert.ok(!(await pg.ev(`location.search`)).includes('auth='), 'parametr auth został w adresie');
  } finally { await pg.close(); }
}, { sev: 1 });
await T('N-03', 'profil: zmiana adresu e-mail wymaga hasła i od razu widać nowy adres', async () => {
  await fresh('n3', {}, async (pg, u) => {
    const em = uniq('n3') + '@example.org';
    await pg.ev(`(openProfile(),1)`); await sleep(700);
    await pg.click('#prof-email-btn'); await sleep(200);
    await pg.type('#prof-email-new', em); await pg.type('#prof-email-pass', 'zle-haslo-1');
    await pg.click('#prof-email-box button'); await sleep(900);
    assert.match(await pg.ev(`document.getElementById('prof-email-err').textContent`), /hasło/i);
    await pg.ev(`(document.getElementById('prof-email-pass').value='',1)`); await pg.type('#prof-email-pass', PASSWORD);
    await pg.click('#prof-email-box button');
    await pg.waitFor(`document.getElementById('prof-email').textContent===${J(em)}`, 8000);
    assert.equal(sql('SELECT email FROM users WHERE id=?', [u.id])[0].email, em);
    await shot(pg, 'n03-email');
    const pr = problems(pg, [/403/]); assert.ok(!pr.length, pr.join(' | '));
  });
});
await T('N-04', 'profil pieszy: trasa liczona dla pieszych, tempo i zakres km przestawione; wskazówki skrętów i komunikaty głosowe w jeździe', async () => {
  await fresh('n4', {}, async (pg) => {
    await pg.ev(spyPlan); await pg.ev(setPts([P1, P2]));
    await showPanel(pg);
    await pg.click('#bp-foot'); await sleep(300);
    const ui = await pg.ev(`({max:+document.getElementById('dist-r').max,speed:+document.getElementById('avg-speed').value})`);
    assert.ok(ui.max <= 60 && ui.speed <= 8, 'zakres/tempo dla pieszych: ' + J(ui));
    await pg.click('.calc-btn'); await pg.waitFor(routeReady, 90000); await sleep(1200);
    const plan = (await pg.ev(`window.__plans`)).at(-1);
    assert.equal(plan.bikeProfile, 'foot');
    const turns = await pg.ev(`routeTurns().map(t=>({k:t.k,km:t.km}))`);
    assert.ok(turns.length > 2, 'brak skrętów na trasie');
    // ride it: 250 m before the first turn, then at it
    const t = lonelyTurn(turns);
    await pg.ev(`(window._spoken.length=0,navStart(),navUpdate(${t.km - 0.1},4,{speed:5}),1)`);
    const far = await pg.ev(`({said:[...window._spoken],hid:document.getElementById('ride-turn').hidden,txt:document.getElementById('ride-turn').textContent,title:document.getElementById('ride-turn').title})`);
    assert.ok(far.said.some(s => /Nawigacja głosowa włączona/.test(s)), 'brak powitania: ' + J(far.said));
    assert.ok(far.said.some(s => /^Za \d+ metrów /.test(s)), 'brak zapowiedzi skrętu: ' + J(far.said));
    assert.ok(!far.hid && /\d+ m/.test(far.txt) && far.title.length > 3, 'strzałka skrętu: ' + J(far));
    await pg.ev(`(navUpdate(${t.km - 0.01},3,{speed:5}),1)`);
    const near = await pg.ev(`[...window._spoken]`);
    assert.ok(near.length > far.said.length && /^[A-ZŁŚŻ]/.test(near.at(-1)) && !/^Za /.test(near.at(-1)), 'brak komendy przy skręcie: ' + J(near));
    await pg.ev(`(navUpdate(null,500),navUpdate(null,500),navUpdate(null,500),navUpdate(${t.km},5,{speed:3}),1)`);
    const off = await pg.ev(`[...window._spoken]`);
    assert.ok(off.includes('Jesteś poza trasą') && off.includes('Wracasz na trasę'), J(off.slice(-4)));
    await pg.ev(`(navStop(),1)`);
    const pr = problems(pg); assert.ok(!pr.length, pr.join(' | '));
    return `${turns.length} skrętów, m.in. „${near.at(-1)}”`;
  });
}, { sev: 1 });
await T('N-05', 'link do trasy: tworzenie w „Moje trasy”, strona dla odbiorcy bez konta, otwarcie w planerze, wyłączenie', async () => {
  const owner = await newUser('n5');
  const a = { lat: P1.lat, lng: P1.lng }, b = { lat: P2.lat, lng: P2.lng };
  const rt = await owner.post('/api/route/detour', { waypoints: [a, b], mode: 'shortest', bikeProfile: 'gravel' });
  const c = rt.json.routes[0].geometry.coordinates.map(q => [q[1], q[0], q[2] || 0]);
  await owner.post('/api/routes', routeBody('Trasa do pokazania', { coords: c, distanceKm: rt.json.routes[0].distance / 1000 }));
  const pg = await browser.newPage(vp), guest = await browser.newPage(vp);
  try {
    await pg.setCookie(owner.cookie); await open(pg); await loggedIn(pg, owner.username);
    await pg.ev(`(openRoutes(),1)`); await pg.waitFor(`!!document.querySelector('#routes-modal .lnk')`, 8000); await sleep(400);
    await pg.click('#routes-modal .lnk'); await sleep(300);
    assert.ok(await pg.ev(`document.querySelector('.rt-share .hide').checked`), 'ukrywanie końców ma być domyślnie włączone');
    await pg.click('.rt-share .mk');
    await pg.waitFor(`!!document.querySelector('.rt-share .url')`, 8000);
    const url = await pg.ev(`document.querySelector('.rt-share .url').value`);
    assert.match(url, new RegExp('^' + BASE + '/s/[\\w-]{12,}$'));
    await shot(pg, 'n05-share');
    // the recipient, not signed in
    await guest.goto(url);
    await guest.waitFor(`document.getElementById('name').textContent==='Trasa do pokazania'&&!!document.querySelector('#map .leaflet-overlay-pane path')`, 20000); await sleep(600);
    const seen = await guest.ev(`({stats:document.getElementById('stats').innerText,trim:!document.getElementById('trim').hidden,gpx:document.getElementById('gpx').getAttribute('href'),w:[document.documentElement.scrollWidth,innerWidth],title:document.title})`);
    assert.match(seen.stats, /km/); assert.ok(seen.trim, 'brak informacji o ukrytych końcach'); assert.match(seen.gpx, /\/api\/shared\/.+\/gpx/);
    assert.ok(seen.w[0] <= seen.w[1] + 1, 'strona linku przewija się w poziomie: ' + seen.w); assert.match(seen.title, /Trasa do pokazania/);
    assert.ok(!(await guest.ev(`document.body.innerText`)).includes(owner.username), 'strona linku pokazuje autora');
    await shot(guest, 'n05-shared-page');
    let pr = problems(guest); assert.ok(!pr.length, pr.join(' | '));
    // "open in the planner" as another rider
    const other = await newUser('n5b');
    await guest.setCookie(other.cookie);
    await guest.click(mobile ? '#open' : '#open-top');
    await guest.waitFor(`typeof routeCoords!=='undefined'&&routeCoords.length>10&&typeof currentUser!=='undefined'&&!!currentUser`, 30000); await sleep(800);
    assert.equal(await guest.ev(`planName()`), 'Trasa do pokazania');
    assert.ok(!(await guest.ev(`location.search`)).includes('shared='), 'parametr shared został w adresie');
    // switched off: the address stops working
    await pg.click('.rt-share .off'); await pg.waitFor(`!!document.querySelector('.rt-share .mk')`, 8000);
    assert.equal((await new Client().get(new URL(url).pathname)).status, 404);
    pr = [...problems(pg), ...problems(guest)]; assert.ok(!pr.length, pr.join(' | '));
  } finally { await pg.close(); await guest.close(); }
}, { sev: 1 });
await T('N-06', 'cudzy GPX jako trasa: plik wczytuje się do planera z długością i profilem wysokości', async () => {
  await fresh('n6', {}, async (pg) => {
    const f = path.join(SHOTS, `route-${vp}.gpx`); fs.mkdirSync(SHOTS, { recursive: true });
    const pts = Array.from({ length: 60 }, (_, i) => ({ lat: P1.lat + (P2.lat - P1.lat) * i / 59, lng: P1.lng + (P2.lng - P1.lng) * i / 59 }));
    fs.writeFileSync(f, `<?xml version="1.0"?><gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Trasa kolegi</name><trkseg>${pts.map((q, i) => `<trkpt lat="${q.lat}" lon="${q.lng}"><ele>${100 + i}</ele></trkpt>`).join('')}</trkseg></trk></gpx>`);
    await pg.ev(`(openRoutes(),1)`); await sleep(800);
    assert.ok(await pg.ev(`(()=>{const b=document.getElementById('rt-imp');return !!b&&b.offsetHeight>0})()`), 'brak przycisku „Z pliku GPX”');
    await pg.setFile('#route-gpx-in', f);
    await pg.waitFor(`routeCoords.length>=50&&document.getElementById('loading').classList.contains('h')`, 20000); await sleep(800);
    fs.unlinkSync(f);
    assert.match(await toastTxt(pg), /Wczytano z pliku: Trasa kolegi · \d/);
    const st = await state(pg); assert.ok(st.card !== false, 'karta trasy niewidoczna');
    // a broken file says so and changes nothing
    const bad = path.join(SHOTS, `bad-${vp}.gpx`); fs.writeFileSync(bad, '<gpx><trk><trkseg>');
    await pg.ev(`(openRoutes(),1)`); await sleep(500);
    await pg.setFile('#route-gpx-in', bad); await sleep(900); fs.unlinkSync(bad);
    assert.match(await toastTxt(pg), /nie jest poprawny plik GPX|nie ma trasy/);
    assert.ok((await pg.ev(`routeCoords.length`)) >= 50);
    const pr = problems(pg); assert.ok(!pr.length, pr.join(' | '));
  });
});
await T('N-07', 'pogoda na trasie i pętla pod wiatr: wiersz z wiatrem na karcie trasy, planer dostaje kierunek wiatru', async () => {
  await svc({ windDir: 270, windSpeed: 6, weatherFail: false });
  await fresh('n7', {}, async (pg) => {
    await pg.ev(spyPlan); await pg.ev(setPts([P1]));
    await showPanel(pg);
    await pg.ev(`(document.querySelector('input[name="loop"][value="loop"]').click(),document.getElementById('dist-r').value=20,document.getElementById('dist-r').dispatchEvent(new Event('input')),1)`);
    const box = await pg.locate('#wind-loop');
    assert.ok(box.w > 0, 'opcja „pętla pod wiatr” niewidoczna');
    if (!(await pg.ev(`document.getElementById('wind-loop').checked`))) await pg.click('#wind-loop');
    assert.ok(await pg.ev(`document.getElementById('wind-loop').checked`));
    await pg.click('.calc-btn'); await pg.waitFor(routeReady, 180000);
    const plan = (await pg.ev(`window.__plans`)).at(-1);
    assert.equal(plan.windFrom, 270, 'planer nie dostał kierunku wiatru: ' + J(plan.windFrom));
    await pg.waitFor(`!document.getElementById('rc-wx').hidden`, 15000);
    const wx = await pg.ev(`(()=>{const b=document.getElementById('rc-wx');return{d:{...b.dataset},txt:b.innerText,opts:b.querySelectorAll('select option').length}})()`);
    assert.equal(wx.d.wind, '22'); assert.equal(wx.d.dir, '270');
    assert.match(wx.txt, /MET Norway/); assert.match(wx.txt, /pod wiatr \d+%/); assert.ok(wx.opts >= 40, 'godziny startu: ' + wx.opts);
    const lngMean = await pg.ev(`routeCoords.reduce((s,c)=>s+c.lng,0)/routeCoords.length`);
    assert.ok(lngMean < P1.lng - 0.004, `pętla nie leży na zachód od startu (${(lngMean - P1.lng).toFixed(4)}°)`);
    assert.ok(['good', 'side'].includes(wx.d.verdict), 'ocena pętli: ' + wx.d.verdict);
    await showPanel(pg); await shot(pg, 'n07-weather');
    const pr = problems(pg); assert.ok(!pr.length, pr.join(' | '));
    return `wiatr ${wx.d.wind} km/h z ${wx.d.dir}°, pod wiatr ${wx.d.head}%, z wiatrem ${wx.d.tail}%, ocena ${wx.d.verdict}`;
  });
}, { sev: 2 });
await T('N-08', 'import kwadratów: StatsHunters z linku i VeloViewer z pliku KML', async () => {
  await fresh('n8', {}, async (pg) => {
    await pg.ev(`(typeof openPlanSheet==='function'&&${mobile}&&openPlanSheet(),swTab('sq',document.querySelector('#sbt .tb[onclick*="sq"]')),toggleSHForm(),1)`); await sleep(400);
    await pg.ev(`(document.getElementById('sh-link').value='https://www.statshunters.com/share/sharegood1',1)`);
    await pg.click('#sh-go');
    await pg.waitFor(`ownedSQ.size===6`, 15000);
    assert.match(await toastTxt(pg), /StatsHunters: \+6 nowych SQ/);
    const lon = X => X / 16384 * 360 - 180, lat = Y => Math.atan(Math.sinh(Math.PI * (1 - 2 * Y / 16384))) * 180 / Math.PI;
    const ring = (x, y) => [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]].map(([X, Y]) => `${lon(X)},${lat(Y)},0`).join(' ');
    const f = path.join(SHOTS, `vv-${vp}.kml`);
    fs.writeFileSync(f, `<?xml version="1.0"?><kml><Document>${[[9200, 5600], [9201, 5600]].map(([x, y]) => `<Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>${ring(x, y)}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`).join('')}</Document></kml>`);
    await pg.setFile('#vv-kml-in', f);
    await pg.waitFor(`ownedSQ.size===8`, 15000); fs.unlinkSync(f);
    assert.match(await toastTxt(pg), /VeloViewer: \+2 nowych SQ/);
    const pr = problems(pg); assert.ok(!pr.length, pr.join(' | '));
  });
});
await T('N-09', 'bez sieci: aplikacja otwiera się z kopii, pokazuje konto, kwadraty i zapisaną trasę; planowanie mówi, że potrzebuje sieci', async () => {
  const u = await newUser('n9');
  await u.post('/api/gpx/import', { gpxText: gpxOf([{ lat: 52.3, lng: 20.9 }, { lat: 52.31, lng: 20.91 }]) });
  await u.post('/api/routes', routeBody('Trasa na wyjazd'));
  const pg = await browser.newPage(vp);
  try {
    await pg.setCookie(u.cookie); await open(pg); await loggedIn(pg, u.username);
    await pg.waitFor(`navigator.serviceWorker.ready.then(()=>true)`, 15000);
    // second visit: the worker controls the page and fills its stores
    await open(pg); await loggedIn(pg, u.username);
    await pg.waitFor(`!!navigator.serviceWorker.controller`, 10000);
    const sqi = await pg.ev(`ownedSQI.size`); assert.ok(sqi > 0, 'konto bez kwadratów — import testowy nie zadziałał');
    await pg.ev(`(openRoutes(),1)`); await sleep(2500); await closeSheets(pg);
    const n = await pg.offlineAll(true);
    assert.ok(n >= 1, 'nie znaleziono service workera');
    try {
      await pg.goto(BASE + '/');
      await pg.waitFor(`typeof checkAuth==='function'&&typeof currentUser!=='undefined'&&!!currentUser&&!${gateOn}`, 20000); await sleep(1500);
      const off = await pg.ev(`({user:currentUser.username,sqi:ownedSQI.size,pill:!document.getElementById('offline-pill').hidden,online:navigator.onLine,routes:_routes.length,css:getComputedStyle(document.getElementById('sb')).display})`);
      assert.equal(off.user, u.username); assert.equal(off.sqi, sqi, 'kwadraty offline');
      assert.ok(off.pill, 'brak znacznika „Offline”: ' + J(off));
      await pg.ev(`(openRoutes(),1)`); await sleep(1200);
      assert.ok(await pg.ev(`_routes.length===1&&!!document.querySelector('#routes-modal .rt-card, #routes-modal [data-id], #routes-list > *')`), 'lista tras offline pusta');
      await shot(pg, 'n09-offline');
      await pg.ev(`(openSavedRoute(_routes[0].id),1)`);
      await pg.waitFor(`routeCoords.length>=10`, 10000);
      await closeSheets(pg);
      await pg.ev(`(calcRoute(),1)`); await sleep(2500);   // with a route on screen the form is folded away
      const t = await toastTxt(pg);
      assert.ok(/Brak połączenia|bez sieci|offline/i.test(t) && !/Failed to fetch|TypeError/.test(t), 'komunikat przy planowaniu offline: „' + t + '”');
    } finally { await pg.offlineAll(false); }
    await pg.goto(BASE + '/'); await loggedIn(pg, u.username);
    assert.ok(await pg.ev(`document.getElementById('offline-pill').hidden`), 'znacznik „Offline” został po powrocie sieci');
    // signing out wipes the copies of this person's data
    await uiLogout(pg); await sleep(800);
    const left = await pg.ev(`caches.open('sq-api-v1').then(c=>c.keys()).then(k=>k.map(r=>new URL(r.url).pathname).filter(p=>/routes|tiles|auth\\/me/.test(p)))`);
    assert.equal(left.length, 0, 'po wylogowaniu w pamięci zostały: ' + left.join(', '));
  } finally { await pg.close(); }
}, { sev: 1 });
await T('N-10', 'języki: wybór z listy (niemiecki, czeski…), napisy i komunikaty w tym języku, po odświeżeniu zostaje', async () => {
  await fresh('n10', {}, async (pg) => {
    const res = {};
    for (const [code, calc, said] of [['de', /Route/, /^In \d+ Metern /], ['nl', /Route|route/, /^Over \d+ meter /], ['fr', /parcours|itinéraire/i, /^Dans \d+ mètres, /], ['cs', /tras/i, /^Za \d+ metrů /]]) {
      await pg.ev(`(()=>{const s=document.querySelector('#user-dropdown [data-lang-sel]');s.value='${code}';s.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`);
      await pg.waitFor(`window.LANG==='${code}'&&document.documentElement.lang==='${code}'`, 10000); await sleep(600);
      await showPanel(pg);
      const ui = await pg.ev(`(()=>{const pl=/[ąęłńśźż]|\\b(trasa|trasy|kwadraty|zapisz|usuń|wyznacz|pokaż|ustawienia)\\b/i,out=[];const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;
        while(n=w.nextNode()){const e=n.parentElement;if(!e||!e.offsetParent||e.closest('script,style,.notranslate,#auth-gate,.leaflet-control-attribution'))continue;const t=n.textContent.trim();
          if(t.length>2&&pl.test(t.replace(/GDOŚ|GUGiK/g,''))&&!(${code === 'cs'}&&!/[ąęłńśźż]/.test(t)))out.push(t.slice(0,40));}
        return{calc:document.querySelector('.calc-btn').innerText.trim(),left:${code === 'cs'}?out.filter(t=>/[ąęłńśźż]/.test(t)&&!/[ěščřůýáíé]/.test(t)):out,sel:[...document.querySelectorAll('[data-lang-sel]')].map(s=>s.value),tl:tl('nowych SQ','new SQ'),num:tl(\`\${3} nowych SQI\`,\`\${3} new SQI\`)}})()`);
      assert.match(ui.calc, calc, `${code}: przycisk „${ui.calc}”`);
      assert.ok(ui.left.length === 0, `${code}: polskie napisy: ${ui.left.slice(0, 6).join(' | ')}`);
      assert.ok(ui.sel.every(v => v === code), `${code}: lista języków pokazuje ${ui.sel}`);
      assert.ok(ui.tl !== 'new SQ' && ui.num !== '3 new SQI', `${code}: teksty z kodu po angielsku (${ui.tl}, ${ui.num})`);
      res[code] = ui.calc;
      if (code === 'de') await shot(pg, 'n10-de');
      if (code === 'cs') {
        // stays after a reload, and the first paint is already Czech
        await open(pg); await sleep(800); await showPanel(pg);
        assert.equal(await pg.ev(`window.LANG`), 'cs'); assert.match(await pg.ev(`document.querySelector('.calc-btn').innerText`), calc);
      }
    }
    // spoken turns follow the language
    await pg.ev(setPts([P1, P2])); await showPanel(pg); await pg.click('.calc-btn'); await pg.waitFor(routeReady, 90000); await sleep(800);
    const t = lonelyTurn(await pg.ev(`routeTurns().map(t=>({km:t.km}))`)).km;
    await pg.ev(`(window._spoken.length=0,navStart(),navUpdate(${t - 0.1},4,{speed:5}),navStop(),1)`);
    const said = await pg.ev(`[...window._spoken]`);
    assert.ok(said.some(s => /^Za \d+ metrů /.test(s)), 'czeski komunikat: ' + J(said));
    await pg.ev(`setLang('pl').then(()=>1)`);
    const pr = problems(pg); assert.ok(!pr.length, pr.join(' | '));
    return Object.entries(res).map(([k, v]) => `${k}: ${v}`).join(' · ');
  });
}, { sev: 2 });

const fails = S.done();
browser.close();
process.exit(fails ? 1 : 0);
