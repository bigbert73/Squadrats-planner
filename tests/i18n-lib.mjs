// Loads frontend/i18n.js (and language files) outside a browser, for the
// tests and for checking a language file against the English texts.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const FRONT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend');

export function loadI18n(lang = 'en', packs = []) {
  const store = { 'sq-lang': lang };
  const window = { dispatchEvent() {}, addEventListener() {} };
  const ctx = vm.createContext({
    window, navigator: { language: 'pl' }, Event: class {}, console,
    localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
    MutationObserver: class { observe() {} },
    document: { documentElement: {}, readyState: 'complete', body: null, head: { appendChild() {} }, querySelectorAll: () => [], getElementById: () => null, addEventListener() {}, createElement: () => ({}), write() {} },
  });
  vm.runInContext(fs.readFileSync(path.join(FRONT, 'i18n.js'), 'utf8'), ctx);
  for (const p of packs) vm.runInContext(`var sqLangPack=window.sqLangPack;` + fs.readFileSync(path.join(FRONT, 'i18n', p + '.js'), 'utf8'), ctx);
  return window;
}
// What a language file was given, as it registered it
export function readPack(code) {
  let got = null;
  const ctx = vm.createContext({ window: { sqLangPack: (c, p) => { got = { code: c, ...p }; } } });
  vm.runInContext(`var sqLangPack=window.sqLangPack;` + fs.readFileSync(path.join(FRONT, 'i18n', code + '.js'), 'utf8'), ctx);
  return got;
}
// Texts built in code as tl('polski','english') / say('polski','english'): [pl, en]
export function codePairs() {
  const out = new Map();
  for (const f of ['index.html', 'extras.js']) {
    const src = fs.readFileSync(path.join(FRONT, f), 'utf8');
    const str = String.raw`(?:'((?:[^'\\\n]|\\.)*)'|` + '`((?:[^`\\\\$]|\\\\.)*)`)';
    const rx = new RegExp(String.raw`\b(?:tl|say)\(\s*${str}\s*,\s*${str}`, 'g');
    let m;
    while ((m = rx.exec(src))) {
      const un = s => s.replace(/\\n/g, '\n').replace(/\\(['"`\\])/g, '$1');
      out.set(un(m[1] ?? m[2]), un(m[3] ?? m[4]));
    }
  }
  return [...out];
}
// Polish messages the server can answer with (shown to the user as they are)
export function serverTexts() {
  const dir = path.join(FRONT, '..', 'backend', 'src'), out = new Set();
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/\b(?:error|message):\s*'((?:[^'\\\n]|\\.)*)'/g)) out.add(m[1].replace(/\\'/g, "'"));
    for (const m of src.matchAll(/\b(?:bad|fail|deny|new Error|new RoutingAreaError)\((?:res,\s*)?(?:\d+,\s*)?(?:'[A-Z_]+',\s*)?'((?:[^'\\\n]|\\.)*)'/g)) out.add(m[1].replace(/\\'/g, "'"));
  }
  return [...out].filter(s => /[ąćęłńóśźż]|[a-z]{4}/i.test(s));
}
