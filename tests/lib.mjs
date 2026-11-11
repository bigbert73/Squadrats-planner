// Shared helpers for the test suites: result recording, an HTTP client with a
// cookie jar, test-stack access (database, restart) and a small Chrome
// DevTools Protocol driver. No npm dependencies — Node 22+ and Chromium only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export { assert };
export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Test stack ───────────────────────────────────────────────────────────────
const envFile = path.join(HERE, '.stack.env');
if (!fs.existsSync(envFile)) { console.error('Brak tests/.stack.env — uruchom najpierw: tests/stack.sh up'); process.exit(2); }
export const ENV = Object.fromEntries(fs.readFileSync(envFile, 'utf8').trim().split('\n').map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
export const BASE = ENV.SQ_TEST_URL;
export const CONTAINER = 'sq-test-backend';
// The suites create and delete accounts: never let them run against real data.
if (!/^http:\/\/localhost:31\d\d$/.test(BASE)) { console.error('Testy działają tylko na stosie testowym (localhost:31xx)'); process.exit(2); }

export async function health() {
  try { const r = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(3000) }); return r.ok; } catch { return false; }
}
// Bring the backend back if a test crashed it; true when it had to be started.
export async function ensureUp() {
  if (await health()) return false;
  try { execFileSync('docker', ['start', CONTAINER], { stdio: 'ignore' }); } catch {}
  for (let i = 0; i < 40; i++) { if (await health()) return true; await sleep(500); }
  throw new Error('backend testowy nie wstaje');
}
export function restartBackend() {
  execFileSync('docker', ['restart', '-t', '2', CONTAINER], { stdio: 'ignore' });
  return ensureUp();
}
// Run SQL in the test database (separate connection inside the container).
export function sql(query, params = []) {
  const js = `const D=require('better-sqlite3');const d=new D(process.env.DB_PATH);const q=d.prepare(process.argv[1]);const p=JSON.parse(process.argv[2]);
    const a=/\\?\\d/.test(process.argv[1])?[Object.fromEntries(p.map((v,i)=>[i+1,v]))]:p;
    console.log(JSON.stringify(q.reader?q.all(...a):q.run(...a)));`;
  return JSON.parse(execFileSync('docker', ['exec', CONTAINER, 'node', '-e', js, query, JSON.stringify(params)], { encoding: 'utf8' }));
}
export function backendLog(n = 200) {
  return execFileSync('docker', ['logs', '--tail', String(n), CONTAINER], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// ── Results ──────────────────────────────────────────────────────────────────
export function suite(name) {
  const results = [];
  const t0 = Date.now();
  const rec = (r) => {
    results.push(r);
    const tag = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP', info: 'INFO' }[r.status];
    console.log(`${tag} ${r.id} ${r.title}${r.detail ? ' — ' + String(r.detail).replace(/\s+/g, ' ').slice(0, 300) : ''}`);
  };
  return {
    results,
    // sev: how bad a failure is (1 critical … 4 cosmetic); area: plan chapter
    async t(id, title, fn, { sev = 3 } = {}) {
      const s = Date.now();
      try { const d = await fn(); rec({ id, title, status: 'pass', ms: Date.now() - s, detail: d || '' }); }
      catch (e) { rec({ id, title, status: 'fail', sev, ms: Date.now() - s, detail: e.message }); }
    },
    skip(id, title, why) { rec({ id, title, status: 'skip', detail: why }); },
    info(id, title, detail) { rec({ id, title, status: 'info', detail }); },
    done() {
      fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
      fs.writeFileSync(path.join(HERE, 'results', name + '.json'), JSON.stringify({ suite: name, ms: Date.now() - t0, results }, null, 1));
      const n = s => results.filter(r => r.status === s).length;
      console.log(`== ${name}: ${n('pass')} pass, ${n('fail')} fail, ${n('skip')} skip (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      return n('fail');
    },
  };
}

// ── HTTP client ──────────────────────────────────────────────────────────────
let ipSeq = 0;
const runId = crypto.randomBytes(3).toString('hex');
export const uniq = (p = 'u') => `${p}_${runId}_${(++ipSeq).toString(36)}`;
export class Client {
  // Every client is its own "address", so per-address rate limits don't couple tests.
  constructor(ip) { this.ip = ip || `10.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}`; this.cookie = null; }
  async req(method, url, body, { headers = {}, raw = false, timeout = 60000 } = {}) {
    const h = { 'X-Forwarded-For': this.ip, ...headers };
    if (this.cookie) h.Cookie = `token=${this.cookie}`;
    let payload;
    if (body !== undefined) {
      if (raw) payload = body; else { payload = JSON.stringify(body); h['Content-Type'] ??= 'application/json'; }
    }
    const r = await fetch(BASE + url, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    const set = r.headers.getSetCookie?.().find(c => c.startsWith('token='));
    if (set) { const v = set.split(';')[0].slice(6); this.cookie = v || null; this.setCookie = set; }
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text, headers: r.headers };
  }
  get(u, o) { return this.req('GET', u, undefined, o); }
  post(u, b, o) { return this.req('POST', u, b ?? {}, o); }
  put(u, b, o) { return this.req('PUT', u, b ?? {}, o); }
  patch(u, b, o) { return this.req('PATCH', u, b ?? {}, o); }
  del(u, b, o) { return this.req('DELETE', u, b, o); }
}
export const PASSWORD = 'Test-haslo-1';
export async function newUser(prefix = 'u', extra = {}) {
  const c = new Client();
  const username = uniq(prefix);
  const r = await c.post('/api/auth/register', { username, password: PASSWORD, ...extra });
  assert.equal(r.status, 200, `rejestracja ${username}: ${r.status} ${r.text.slice(0, 120)}`);
  return Object.assign(c, { username, user: r.json.user, id: r.json.user.id });
}
export async function adminClient() {
  const c = new Client();
  const r = await c.post('/api/auth/login', { username: ENV.SQ_TEST_ADMIN, password: ENV.SQ_TEST_ADMIN_PASSWORD });
  assert.equal(r.status, 200, 'logowanie admina testowego');
  return Object.assign(c, { username: ENV.SQ_TEST_ADMIN, user: r.json.user, id: r.json.user.id });
}
// Hand-made HS256 token, to test what the server accepts.
export function signJwt(payload, secret = ENV.SQ_TEST_JWT_SECRET, header = { alg: 'HS256', typ: 'JWT' }) {
  const b = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${b(header)}.${b({ iat: Math.floor(Date.now() / 1000), ...payload })}`;
  const sig = header.alg === 'none' ? '' : crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

// ── Geometry used by several suites (area with routing data: Józefów/Otwock) ─
export const AREA = { lat: 52.14, lng: 21.23 };
export const tileOf = (lat, lng, z) => {
  const n = 2 ** z, x = Math.floor((lng + 180) / 360 * n);
  const r = lat * Math.PI / 180, y = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
  return { x, y };
};
export const tileCenter = (x, y, z) => {
  const n = 2 ** z, lng = (x + 0.5) / n * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / n))) * 180 / Math.PI;
  return { lat, lng };
};
export const gpxOf = (pts) => `<?xml version="1.0"?><gpx><trk><trkseg>${pts.map(p => `<trkpt lat="${p.lat}" lon="${p.lng}"></trkpt>`).join('')}</trkseg></trk></gpx>`;
// Straight test "route" (not routed): n points from a to b.
export const line = (a, b, n = 20) => Array.from({ length: n }, (_, i) => [a.lat + (b.lat - a.lat) * i / (n - 1), a.lng + (b.lng - a.lng) * i / (n - 1), 100 + i]);
export const routeBody = (name, o = {}) => ({
  name, distanceKm: 3.2, newSQ: 1, newSQI: 7, mode: 'sqi', profile: 'standard', loop: false,
  waypoints: [{ type: 'start', lat: AREA.lat, lng: AREA.lng, label: 'Start' }, { type: 'end', lat: AREA.lat + 0.02, lng: AREA.lng + 0.02, label: 'Meta' }],
  coords: line(AREA, { lat: AREA.lat + 0.02, lng: AREA.lng + 0.02 }), ...o,
});
// Minimal XML well-formedness check (tags balanced, no stray < or &).
export function xmlWellFormed(xml) {
  const stack = [];
  const body = xml.replace(/<\?xml[^>]*\?>/, '');
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>/g;
  let m, last = 0;
  while ((m = re.exec(body))) {
    const between = body.slice(last, m.index);
    if (/</.test(between) || /&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(between)) return `zły tekst przed <${m[2]}>: ${between.slice(0, 60)}`;
    last = re.lastIndex;
    if (m[4]) continue;
    if (m[1]) { if (stack.pop() !== m[2]) return `niedomknięty znacznik przy </${m[2]}>`; } else stack.push(m[2]);
  }
  if (/[<]/.test(body.slice(last))) return 'śmieci na końcu';
  return stack.length ? `niezamknięte: ${stack.join(',')}` : null;
}

// ── Chromium over CDP ────────────────────────────────────────────────────────
const CHROME = process.env.CHROME_BIN || ['/snap/bin/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(p => fs.existsSync(p));
export const VIEWPORTS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  laptop: { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true },
  mobile: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },   // iPhone 14/15
  small: { width: 360, height: 640, deviceScaleFactor: 3, mobile: true },   // small Android
};
export class Browser {
  static async launch(port = 9340 + crypto.randomInt(0, 400)) {
    const b = new Browser();
    b.proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, '--no-first-run', '--hide-scrollbars', '--disable-gpu', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
    let url;
    for (let i = 0; i < 80 && !url; i++) { await sleep(400); try { url = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; } catch {} }
    if (!url) throw new Error('Chromium nie wystartował');
    b.ws = new WebSocket(url);
    await new Promise((res, rej) => { b.ws.onopen = res; b.ws.onerror = rej; });
    b.id = 0; b.pending = new Map(); b.pages = new Map();
    b.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && b.pending.has(m.id)) { const p = b.pending.get(m.id); b.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return; }
      if (m.sessionId && b.pages.has(m.sessionId)) b.pages.get(m.sessionId)._event(m.method, m.params);
    };
    return b;
  }
  send(method, params = {}, sessionId) {
    return new Promise((res, rej) => { const id = ++this.id; this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params, sessionId })); });
  }
  // A page in its own browser context = its own cookies/storage (a separate person).
  async newPage(viewport = 'desktop') {
    const { browserContextId } = await this.send('Target.createBrowserContext');
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const p = new Page(this, sessionId, targetId);
    this.pages.set(sessionId, p);
    for (const d of ['Runtime', 'Network', 'Page', 'Log']) await p.send(d + '.enable');
    await p.setViewport(viewport);
    await p.newAddress();
    return p;
  }
  close() { try { this.proc.kill(); } catch {} }
}
export class Page {
  constructor(b, sessionId, targetId) {
    Object.assign(this, { b, sessionId, targetId, errors: [], console: [], failed: [], dialogs: [], requests: [], _req: new Map() });
  }
  send(m, p) { return this.b.send(m, p, this.sessionId); }
  _event(method, p) {
    if (method === 'Runtime.exceptionThrown') this.errors.push((p.exceptionDetails.exception?.description || p.exceptionDetails.text || '').slice(0, 300));
    else if (method === 'Runtime.consoleAPICalled' && p.type === 'error') this.console.push(p.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300));
    else if (method === 'Log.entryAdded' && p.entry.level === 'error') this.console.push(`${p.entry.text} ${p.entry.url || ''}`.slice(0, 300));
    else if (method === 'Network.requestWillBeSent') { this._req.set(p.requestId, { url: p.request.url, method: p.request.method, t: p.timestamp }); }
    else if (method === 'Network.responseReceived') {
      const r = this._req.get(p.requestId); if (r) { r.status = p.response.status; r.mime = p.response.mimeType; }
      if (p.response.status >= 500) this.failed.push(`${p.response.status} ${p.response.url}`);
    }
    else if (method === 'Network.loadingFinished') { const r = this._req.get(p.requestId); if (r) { r.bytes = p.encodedDataLength; r.ms = (p.timestamp - r.t) * 1000; this.requests.push(r); } }
    else if (method === 'Network.loadingFailed' && !p.canceled) { const r = this._req.get(p.requestId); this.failed.push(`${p.errorText} ${r?.url || ''}`); }
    else if (method === 'Fetch.requestPaused') {
      const headers = Object.entries(p.request.headers).filter(([k]) => k.toLowerCase() !== 'x-forwarded-for').map(([name, value]) => ({ name, value }));
      headers.push({ name: 'X-Forwarded-For', value: this.ip });
      this.send('Fetch.continueRequest', { requestId: p.requestId, headers }).catch(() => {});
    }
    else if (method === 'Page.javascriptDialogOpening') {
      this.dialogs.push({ type: p.type, message: p.message });
      this.send('Page.handleJavaScriptDialog', { accept: this.acceptDialogs !== false, promptText: this.promptText ?? '' }).catch(() => {});
    }
  }
  async setViewport(name) {
    const v = VIEWPORTS[name]; this.viewport = name; this.touch = v.mobile;
    await this.send('Emulation.setDeviceMetricsOverride', v);
    await this.send('Emulation.setTouchEmulationEnabled', v.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    if (v.mobile) await this.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  }
  async ev(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text || expression).slice(0, 400));
    return r.result.value;
  }
  async goto(url = BASE + '/') { await this.send('Page.navigate', { url }); await this.waitFor(`document.readyState==='complete'`, 30000); }
  async waitFor(expr, timeout = 15000, step = 150) {
    const end = Date.now() + timeout;
    for (;;) {
      let v; try { v = await this.ev(expr); } catch {}
      if (v) return v;
      if (Date.now() > end) throw new Error(`timeout: ${expr.slice(0, 120)}`);
      await sleep(step);
    }
  }
  // The page becomes a new client address (per-address rate limits of the
  // backend), like a person on another network.
  // Only requests to the app carry the address (an extra header on requests to
  // other hosts would trip their CORS checks).
  async newAddress() {
    this.ip = `10.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}`;
    if (!this._fetchOn) { this._fetchOn = true; await this.send('Fetch.enable', { patterns: [{ urlPattern: BASE + '/*' }] }); }
  }
  // Cut the network of this page (and restore it).
  async offline(on) {
    await this.send('Network.emulateNetworkConditions', { offline: !!on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  }
  // The same for the page's service worker too (its requests come from a target of its own).
  async offlineAll(on) {
    await this.offline(on);
    const cond = { offline: !!on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
    this._sw ??= new Map();
    const { targetInfos } = await this.b.send('Target.getTargets');
    const ctx = targetInfos.find(t => t.targetId === this.targetId)?.browserContextId;
    for (const t of targetInfos.filter(t => t.type === 'service_worker' && t.browserContextId === ctx)) {
      if (!this._sw.has(t.targetId)) {
        const { sessionId } = await this.b.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        await this.b.send('Network.enable', {}, sessionId);
        this._sw.set(t.targetId, sessionId);
      }
      await this.b.send('Network.emulateNetworkConditions', cond, this._sw.get(t.targetId)).catch(() => {});
    }
    return this._sw.size;
  }
  async setFile(sel, file) {
    const { root } = await this.send('DOM.getDocument');
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
    if (!nodeId) throw new Error(`brak elementu ${sel}`);
    await this.send('DOM.setFileInputFiles', { nodeId, files: [file] });
  }
  async setCookie(token) { await this.send('Network.setCookie', { name: 'token', value: token, domain: 'localhost', path: '/', httpOnly: true }); }
  async clearCookies() { await this.send('Network.clearBrowserCookies'); }
  // Centre of the element, and what the browser would actually hit there.
  async locate(sel) {
    const r = await this.ev(`(()=>{const e=typeof ${JSON.stringify(sel)}==='string'?document.querySelector(${JSON.stringify(sel)}):null;if(!e)return null;
      e.scrollIntoView({block:'center',inline:'center'});const b=e.getBoundingClientRect();const x=b.left+b.width/2,y=b.top+b.height/2;
      const h=document.elementFromPoint(x,y);return{x,y,w:b.width,h:b.height,hit:!!h&&(h===e||e.contains(h)||h.contains(e)),top:h?(h.id||h.className||h.tagName):null};})()`);
    if (!r) throw new Error(`brak elementu ${sel}`);
    return r;
  }
  // Real pointer input (mouse on desktop, touch on mobile): fails if the element is covered.
  async click(sel, { force = false } = {}) {
    const p = await this.locate(sel);
    if (!p.w || !p.h) throw new Error(`element ${sel} niewidoczny`);
    if (!p.hit && !force) throw new Error(`element ${sel} zasłonięty przez ${String(p.top).slice(0, 60)}`);
    await this.pointAt(p.x, p.y);
  }
  async pointAt(x, y) {
    if (this.touch) {
      await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    }
    await sleep(60);
  }
  async drag(x0, y0, x1, y1, steps = 8) {
    const pt = i => ({ x: x0 + (x1 - x0) * i / steps, y: y0 + (y1 - y0) * i / steps });
    if (this.touch) {
      await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(0)] });
      for (let i = 1; i <= steps; i++) { await this.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pt(i)] }); await sleep(25); }
      await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pt(0) });
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...pt(0), button: 'left', clickCount: 1 });
      for (let i = 1; i <= steps; i++) { await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pt(i), button: 'left', buttons: 1 }); await sleep(25); }
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pt(steps), button: 'left', clickCount: 1 });
    }
    await sleep(80);
  }
  async type(sel, text) {
    await this.ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.focus();e.select&&e.select();})()`);
    await this.send('Input.insertText', { text });
  }
  async key(key, code = key, keyCode = { Enter: 13, Escape: 27, Tab: 9 }[key] || 0) {
    for (const type of ['keyDown', 'keyUp']) await this.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, text: type === 'keyDown' && key === 'Enter' ? '\r' : undefined });
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
  // Problems seen since the last call (exceptions, console errors, failed requests).
  takeProblems() {
    const p = [...this.errors.map(e => 'wyjątek: ' + e), ...this.console.map(e => 'konsola: ' + e), ...this.failed.map(e => 'sieć: ' + e)];
    this.errors = []; this.console = []; this.failed = [];
    return p;
  }
  async close() { try { await this.b.send('Target.closeTarget', { targetId: this.targetId }); } catch {} this.b.pages.delete(this.sessionId); }
}
