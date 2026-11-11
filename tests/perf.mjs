#!/usr/bin/env node
// Performance pass on the isolated test stack.
//
//   node tests/perf.mjs            measure and write tests/results/perf.json
//
// A "heavy" account gets a realistic amount of data (like a rider with a few
// years of activities): 4 500 squadrats and 52 000 squadratinhos around
// Józefów. Only coordinates are seeded; no Strava data is involved. Then:
//   1. latency of every data endpoint, cold (first request after a restart)
//      and warm (median and p95 of N requests), with payload sizes,
//   2. how long the server is deaf to others while one heavy request runs
//      (Node is single-threaded: a slow synchronous handler blocks everyone),
//   3. many people at once: N accounts loading the map data together,
//   4. memory of the backend before and after N heavy accounts are cached,
//   5. page load in a real browser (desktop and throttled phone).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { BASE, CONTAINER, HERE, AREA, Client, newUser, restartBackend, tileOf, sleep, Browser, PASSWORD, line } from './lib.mjs';

const out = { at: new Date().toISOString(), endpoints: [], blocking: [], concurrency: [], memory: {}, page: [] };
const ms = t => Math.round((performance.now() - t) * 10) / 10;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const kb = n => Math.round(n / 102.4) / 10;

// Seed tiles straight into the test database, in one transaction.
function seed(userId, nSq, nSqi) {
  const c14 = tileOf(AREA.lat, AREA.lng, 14), c17 = tileOf(AREA.lat, AREA.lng, 17);
  const js = `
    const D=require('better-sqlite3');const d=new D(process.env.DB_PATH);
    const [uid,nSq,nSqi,x14,y14,x17,y17]=process.argv.slice(1).map(Number);
    // a filled disc with holes: every 7th tile missing, like a real, patchy map
    const disc=(n,cx,cy)=>{const o=[];const r=Math.ceil(Math.sqrt(n/Math.PI*1.2));
      for(let dy=-r;dy<=r&&o.length<n;dy++)for(let dx=-r;dx<=r&&o.length<n;dx++){
        if(dx*dx+dy*dy>r*r)continue;if(((dx*31+dy*17)%7+7)%7===0)continue;o.push([cx+dx,cy+dy]);}return o;};
    const a=d.prepare('INSERT OR IGNORE INTO tiles_sq(user_id,tx,ty) VALUES(?,?,?)');
    const b=d.prepare('INSERT OR IGNORE INTO tiles_sqi(user_id,tx,ty) VALUES(?,?,?)');
    const act=d.prepare("INSERT OR IGNORE INTO activities(user_id,strava_id,name,sport_type,start_date,distance_m) VALUES(?,?,?,?,?,?)");
    d.transaction(()=>{for(const t of disc(nSq,x14,y14))a.run(uid,t[0],t[1]);for(const t of disc(nSqi,x17,y17))b.run(uid,t[0],t[1]);
      for(let i=0;i<750;i++)act.run(uid,9e9+i,'Przejazd testowy '+i,'Ride','2024-01-01T10:00:00Z',25000+i);})();
    console.log(JSON.stringify({sq:d.prepare('select count(*) n from tiles_sq where user_id=?').get(uid).n,sqi:d.prepare('select count(*) n from tiles_sqi where user_id=?').get(uid).n}));`;
  return JSON.parse(execFileSync('docker', ['exec', CONTAINER, 'node', '-e', js, userId, nSq, nSqi, c14.x, c14.y, c17.x, c17.y].map(String), { encoding: 'utf8' }));
}
const rssMb = () => {
  const s = execFileSync('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', CONTAINER], { encoding: 'utf8' }).trim().split('/')[0].trim();
  const m = /([\d.]+)\s*(KiB|MiB|GiB)/.exec(s); return m ? Math.round(+m[1] * ({ KiB: 1 / 1024, MiB: 1, GiB: 1024 })[m[2]]) : null;
};
async function timed(c, method, url, body, o) {
  const t = performance.now();
  const r = await c.req(method, url, body, { timeout: 180000, ...o });
  return { ms: ms(t), status: r.status, bytes: Buffer.byteLength(r.text), text: r.text };
}

// ── 1. endpoints ─────────────────────────────────────────────────────────────
console.log('Zakładam konto z dużą liczbą kwadratów…');
const heavy = await newUser('perf');
console.log('  dane:', JSON.stringify(seed(heavy.id, 4500, 52000)));
await heavy.put('/api/profile/home', { lat: AREA.lat, lng: AREA.lng, label: 'Test' });
await restartBackend();

const c17 = tileOf(AREA.lat, AREA.lng, 17);
const routeArr = line(AREA, { lat: AREA.lat + 0.25, lng: AREA.lng + 0.35 }, 3000);   // ~35 km as the crow flies, dense
const routeCoords = routeArr.map(p => ({ lat: p[0], lng: p[1] }));
const END = { lat: AREA.lat + 0.03, lng: AREA.lng + 0.04 };
const ENDPOINTS = [
  ['GET', '/api/auth/me'],
  ['GET', '/api/tiles/all'],
  ['GET', '/api/stats'],
  ['GET', '/api/tiles/priority'],
  ['GET', `/api/tiles/sqi?x0=${c17.x - 40}&x1=${c17.x + 40}&y0=${c17.y - 40}&y1=${c17.y + 40}`, undefined, 'tiles/sqi (okno mapy)'],
  ['GET', `/api/tiles/noroad?x0=${c17.x - 200}&y0=${c17.y - 200}&x1=${c17.x + 200}&y1=${c17.y + 200}`, undefined, 'tiles/noroad (400×400)'],
  ['GET', `/api/tiles/reach-stats?lat=${AREA.lat}&lng=${AREA.lng}&r=10`, undefined, 'reach-stats r=10 km'],
  ['GET', `/api/tiles/reach-stats?lat=${AREA.lat}&lng=${AREA.lng}&r=50`, undefined, 'reach-stats r=50 km'],
  ['GET', `/api/tiles/reach-stats?lat=${AREA.lat}&lng=${AREA.lng}&r=100`, undefined, 'reach-stats r=100 km'],
  ['GET', '/api/routes'],
  ['POST', '/api/route/preview-tiles', { coords: routeCoords }, 'preview-tiles (3000 pkt)'],
  ['POST', '/api/route/pois', { coords: routeCoords.filter((_, i) => i % 3 === 0), radiusM: 400 }, 'route/pois (1000 pkt)'],
  ['POST', '/api/route/leg', { from: AREA, to: END, bikeProfile: 'gravel' }, 'route/leg (ok. 5 km)'],
  ['POST', '/api/route/detour', { waypoints: [AREA, END], mode: 'shortest' }, 'detour: A→B najkrócej'],
  ['POST', '/api/route/detour', { waypoints: [AREA, END], mode: 'sqi', targetKm: 15 }, 'detour: A→B po kwadraty 15 km'],
  ['POST', '/api/route/detour', { waypoints: [AREA], loop: true, targetKm: 30, mode: 'sqi' }, 'detour: pętla 30 km'],
  ['POST', '/api/route/detour', { waypoints: [AREA], loop: true, targetKm: 80, mode: 'sqi' }, 'detour: pętla 80 km'],
];
console.log('\n1. Czasy odpowiedzi (konto: 4 500 SQ, 52 000 SQI)');
for (const [method, url, body, label] of ENDPOINTS) {
  const name = label || url.replace(/^\/api\//, '').split('?')[0];
  const slow = /detour/.test(url);
  const cold = await timed(heavy, method, url, body);
  const runs = [];
  for (let i = 0; i < (slow ? 2 : 15); i++) runs.push((await timed(heavy, method, url, body)).ms);
  const gz = zlib.gzipSync(cold.text).length;
  const row = { name, method, status: cold.status, coldMs: cold.ms, medianMs: pct(runs, 0.5), p95Ms: pct(runs, 0.95), kB: kb(cold.bytes), gzipKB: kb(gz) };
  out.endpoints.push(row);
  console.log(`  ${String(cold.status).padEnd(4)} ${name.padEnd(34)} zimny ${String(row.coldMs).padStart(8)} ms  mediana ${String(row.medianMs).padStart(8)} ms  p95 ${String(row.p95Ms).padStart(8)} ms  ${String(row.kB).padStart(7)} kB (gzip ${row.gzipKB})`);
}

// ── 2. does one heavy request make the server deaf to everybody else? ────────
console.log('\n2. Blokowanie serwera przez jedno ciężkie żądanie (ping /api/health co 20 ms)');
async function blocking(label, fn) {
  const other = new Client();
  let stop = false; const lat = [];
  const pinger = (async () => { while (!stop) { const t = performance.now(); await other.get('/api/health'); lat.push(ms(t)); await sleep(20); } })();
  await sleep(200);
  const base = pct(lat, 0.5);
  const t = performance.now(); await fn(); const took = ms(t);
  stop = true; await pinger;
  const row = { name: label, requestMs: took, pingMedianMs: base, pingMaxMs: Math.max(...lat) };
  out.blocking.push(row);
  console.log(`  ${label.padEnd(34)} trwało ${String(took).padStart(8)} ms; inni czekali najdłużej ${row.pingMaxMs} ms (zwykle ${base} ms)`);
}
await blocking('reach-stats r=100 km', () => heavy.get(`/api/tiles/reach-stats?lat=${AREA.lat}&lng=${AREA.lng}&r=100`));
await blocking('tiles/noroad (400×400)', () => heavy.get(`/api/tiles/noroad?x0=${c17.x - 200}&y0=${c17.y - 200}&x1=${c17.x + 200}&y1=${c17.y + 200}`));
await blocking('preview-tiles (3000 pkt)', () => heavy.post('/api/route/preview-tiles', { coords: routeCoords }));
await blocking('detour: pętla 30 km', () => heavy.post('/api/route/detour', { waypoints: [AREA], loop: true, targetKm: 30, mode: 'sqi' }, { timeout: 180000 }));
await blocking('detour: pętla 80 km', () => heavy.post('/api/route/detour', { waypoints: [AREA], loop: true, targetKm: 80, mode: 'sqi' }, { timeout: 180000 }));
{
  const u = await newUser('perfc');
  seed(u.id, 4500, 52000);
  await blocking('pierwsze wczytanie mapy (zimny cache)', () => u.get('/api/tiles/all'));
  await blocking('priorytety (zimny cache)', () => u.get('/api/tiles/priority'));
}
{
  const u = await newUser('perfb');
  const pw = 'Inne-haslo-22';
  await blocking('zmiana hasła (bcrypt)', () => u.put('/api/profile/password', { currentPassword: PASSWORD, newPassword: pw }));
}

// ── 3. many people at once ───────────────────────────────────────────────────
console.log('\n3. Wiele osób naraz');
const N = 25;
const mem0 = rssMb();
const crowd = [];
for (let i = 0; i < N; i++) { const u = await newUser('tlum'); seed(u.id, 4500, 52000); crowd.push(u); }
async function wave(label, fn) {
  const t = performance.now();
  const each = await Promise.all(crowd.map(async u => { const t1 = performance.now(); const r = await fn(u); return { ms: ms(t1), status: r.status }; }));
  const all = each.map(e => e.ms), bad = each.filter(e => e.status !== 200).length;
  const row = { name: label, users: N, totalMs: ms(t), medianMs: pct(all, 0.5), maxMs: Math.max(...all), errors: bad };
  out.concurrency.push(row);
  console.log(`  ${label.padEnd(44)} ${N} osób: razem ${String(row.totalMs).padStart(7)} ms, mediana ${String(row.medianMs).padStart(7)} ms, najdłużej ${String(row.maxMs).padStart(7)} ms, błędy ${bad}`);
}
await wave('wczytanie mapy, pierwszy raz (zimny cache)', u => u.get('/api/tiles/all'));
await wave('wczytanie mapy, kolejny raz', u => u.get('/api/tiles/all'));
await wave('priorytety, pierwszy raz', u => u.get('/api/tiles/priority'));
await wave('trasa A→B najkrócej', u => u.post('/api/route/detour', { waypoints: [AREA, END], mode: 'shortest' }));
await wave('zapis trasy', u => u.post('/api/routes', { name: 'Perf', distanceKm: 35, newSQ: 3, newSQI: 40, mode: 'sqi', profile: 'standard', loop: false,
  waypoints: [{ type: 'start', lat: AREA.lat, lng: AREA.lng, label: 'S' }, { type: 'end', lat: END.lat, lng: END.lng, label: 'M' }], coords: routeArr }));
await wave('lista tras', u => u.get('/api/routes'));
await sleep(1500);
out.memory = { beforeMb: mem0, afterMb: rssMb(), cachedUsers: N + 2 };
console.log(`  pamięć backendu: ${out.memory.beforeMb} MB → ${out.memory.afterMb} MB po wczytaniu danych ${N} dużych kont (${Math.round((out.memory.afterMb - out.memory.beforeMb) / N * 10) / 10} MB na konto; w pamięci zostaje najwyżej 40 ostatnio aktywnych kont)`);

// ── 4. page load in a real browser ───────────────────────────────────────────
console.log('\n4. Ładowanie strony w przeglądarce');
const br = await Browser.launch();
try {
  for (const [label, vp, throttle] of [['komputer, szybkie łącze', 'desktop', null], ['telefon, 4G (9 Mb/s, 170 ms)', 'mobile', { down: 9e6 / 8, up: 1.5e6 / 8, rtt: 170, cpu: 4 }]]) {
    const pg = await br.newPage(vp);
    await pg.send('Network.enable');
    await pg.send('Network.setCacheDisabled', { cacheDisabled: true });
    if (throttle) {
      await pg.send('Network.emulateNetworkConditions', { offline: false, latency: throttle.rtt, downloadThroughput: throttle.down, uploadThroughput: throttle.up });
      await pg.send('Emulation.setCPUThrottlingRate', { rate: throttle.cpu });
    }
    await pg.setCookie(heavy.cookie);
    await pg.goto(BASE + '/');
    await pg.waitFor('typeof statsData!=="undefined" && statsData && statsData.sqi>0 && document.getElementById("loading").classList.contains("h")', 60000);
    await sleep(2500);
    const m = await pg.ev(`(()=>{const n=performance.getEntriesByType('navigation')[0];const res=performance.getEntriesByType('resource');
      const own=res.filter(r=>r.name.startsWith(location.origin));const ext=res.filter(r=>!r.name.startsWith(location.origin));
      const fcp=performance.getEntriesByName('first-contentful-paint')[0];
      const tiles=res.find(r=>r.name.includes('/api/tiles/all'));
      return {dcl:Math.round(n.domContentLoadedEventEnd),load:Math.round(n.loadEventEnd),fcp:fcp?Math.round(fcp.startTime):null,
        htmlKB:Math.round(n.transferSize/102.4)/10,htmlRawKB:Math.round(n.decodedBodySize/102.4)/10,
        ownReq:own.length+1,ownKB:Math.round((own.reduce((s,r)=>s+r.transferSize,0)+n.transferSize)/102.4)/10,
        extReq:ext.length,extKB:Math.round(ext.reduce((s,r)=>s+r.transferSize,0)/102.4)/10,extHosts:[...new Set(ext.map(r=>new URL(r.name).host))].length,
        tilesAllMs:tiles?Math.round(tiles.duration):null,tilesAllDoneAt:tiles?Math.round(tiles.responseEnd):null,
        domNodes:document.getElementsByTagName('*').length,heapMB:performance.memory?Math.round(performance.memory.usedJSHeapSize/1048576):null};})()`);
    // how long a pan of the map keeps the main thread busy with 52 000 squares loaded
    const pan = await pg.ev(`(async()=>{let worst=0,last=performance.now(),run=true;const tick=()=>{const n=performance.now();worst=Math.max(worst,n-last);last=n;if(run)requestAnimationFrame(tick);};requestAnimationFrame(tick);
      for(let i=0;i<12;i++){map.panBy([120,60],{animate:false});await new Promise(r=>setTimeout(r,120));}
      map.setZoom(map.getZoom()-2,{animate:false});await new Promise(r=>setTimeout(r,600));map.setZoom(map.getZoom()+3,{animate:false});await new Promise(r=>setTimeout(r,600));
      run=false;return Math.round(worst);})()`);
    const row = { name: label, ...m, worstFrameMs: pan };
    out.page.push(row);
    console.log(`  ${label}: pierwszy obraz ${m.fcp} ms, DOM ${m.dcl} ms, load ${m.load} ms, kwadraty na mapie po ${m.tilesAllDoneAt} ms`);
    console.log(`      własne: ${m.ownReq} żądań ${m.ownKB} kB (HTML ${m.htmlKB} kB / ${m.htmlRawKB} kB bez kompresji); zewnętrzne: ${m.extReq} żądań ${m.extKB} kB z ${m.extHosts} serwerów`);
    console.log(`      DOM ${m.domNodes} elementów, pamięć JS ${m.heapMB} MB, najdłuższe przycięcie przy przesuwaniu/zoomie mapy ${pan} ms`);
    await pg.close();
  }
} finally { await br.close(); }

fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'results', 'perf.json'), JSON.stringify(out, null, 1));
console.log('\nZapisano tests/results/perf.json');
