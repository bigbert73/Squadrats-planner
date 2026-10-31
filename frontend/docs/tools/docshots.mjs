// Screenshot runner for the Squadrats docs: node docshots.mjs <token> <steps.mjs> <outdir> [only1,only2]
// DOCS_LANG=en takes the shots in the English UI and lists texts it left untranslated.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [token, stepsFile, outDir, only] = process.argv.slice(2);
const { steps, helper } = await import(pathToFileURL(path.resolve(stepsFile)).href);
const want = only ? new Set(only.split(',')) : null;
fs.mkdirSync(outDir, { recursive: true });

const PORT = 9334;
const ch = spawn('/snap/bin/chromium', ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws;
for (let i = 0; i < 60; i++) { await sleep(500); try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = l.find(x => x.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; } } catch {} }
await new Promise(r => ws.onopen = r);
let id = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr, timeout = 240000) => {
  const r = await Promise.race([send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }), sleep(timeout).then(() => ({ timeout: true }))]);
  if (r.timeout) return 'EVAL TIMEOUT';
  return r.result?.exceptionDetails ? 'ERR ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text) : r.result?.result?.value;
};

const DEV = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1.5, mobile: false },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2.5, mobile: true },
};
await send('Network.enable');
await send('Page.enable');
const LANG = process.env.DOCS_LANG || 'pl';
await send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('sq-lang','${LANG}');${LANG === 'en' ? "localStorage.setItem('sq-i18n-debug','1')" : "localStorage.removeItem('sq-i18n-debug')"}}catch(e){}` });
await send('Network.setCookie', { name: 'token', value: token, domain: 'localhost', path: '/' });
await send('Browser.grantPermissions', { origin: 'http://localhost:8081', permissions: ['geolocation'] });

let cur = null;
async function load(device) {
  await send('Emulation.setDeviceMetricsOverride', DEV[device]);
  await send('Emulation.setTouchEmulationEnabled', { enabled: device === 'mobile' });
  await send('Emulation.setUserAgentOverride', { userAgent: device === 'mobile'
    ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
    : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' });
  await send('Page.navigate', { url: 'http://localhost:8081/' });
  await sleep(4000);
  console.log('  ready:', await evaluate(helper + ';D.ready()'));
  cur = device;
}

for (const s of steps) {
  if (want && !want.has(s.name)) continue;
  const t = Date.now();
  if (s.geo) await send('Emulation.setGeolocationOverride', { latitude: s.geo[0], longitude: s.geo[1], accuracy: 8 });
  if (cur !== s.device || s.reload) await load(s.device);
  const r = await evaluate(helper + ';(async()=>{' + s.js + '})()');
  await sleep(s.wait ?? 1500);
  const shot = await send('Page.captureScreenshot', { format: 'webp', quality: 82, ...(s.clip ? { clip: { ...s.clip, scale: 1 } } : {}) });
  fs.writeFileSync(path.join(outDir, s.name + '.webp'), Buffer.from(shot.result.data, 'base64'));
  if (LANG === 'en') { const miss = await evaluate('window.i18nMiss?[...i18nMiss].splice(0):[]'); await evaluate('window.i18nMiss?.clear()'); if (miss?.length) console.log('  untranslated:', JSON.stringify(miss)); }
  console.log(`${s.name} (${s.device}) ${((Date.now() - t) / 1000).toFixed(1)}s →`, JSON.stringify(r)?.slice(0, 200));
}
ch.kill(); process.exit(0);
