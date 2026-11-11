/* Service worker: lets the planner open and show what was already seen when
 * there is no connection.
 *
 *   shell – the app's own files and the libraries it loads; network first, so
 *           a new version shows up at once, the copy only when offline
 *   api   – the last answer of a few read-only calls (who am I, my squares, my
 *           routes); network first; wiped on sign-out and on a 401
 *   tiles – map tiles that were looked at; copy first, refreshed after a week.
 *           Nothing is downloaded ahead: tile servers forbid bulk downloads.
 *
 * Planning a route always needs the server.
 */
const SHELL = 'sq-shell-v1', API = 'sq-api-v1', TILES = 'sq-tiles-v1';
const KEEP = new Set([SHELL, API, TILES]);
const TILE_MAX = 3000, TILE_AGE = 7 * 864e5;

const API_OK = [
  /^\/api\/auth\/me$/, /^\/api\/auth\/providers$/, /^\/api\/tiles\/all$/, /^\/api\/routes$/, /^\/api\/routes\/\d+$/,
  /^\/api\/coverage$/, /^\/api\/sync\/status$/, /^\/api\/manifest\.webmanifest$/,
];
const CDN = /^https:\/\/(unpkg\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;
const TILE = /^https:\/\/([a-z0-9-]+\.)*(tile\.openstreetmap\.org|basemaps\.cartocdn\.com|tile\.opentopomap\.org|tile-cyclosm\.openstreetmap\.fr|arcgisonline\.com)\//;
const PASS = /^\/(auth|s|docs)\//; // sign-in redirects, public route pages, the handbook: never from a copy

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('sq-') && !KEEP.has(k)) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'clear-api') e.waitUntil(caches.delete(API));
});

async function networkFirst(req, cacheName, key) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(key || req, res.clone()).catch(() => {});
    else if (res.status === 401 && cacheName === API) caches.delete(API); // signed out elsewhere: nothing of theirs stays
    return res;
  } catch (err) {
    const hit = await cache.match(key || req);
    if (hit) return hit;
    throw err;
  }
}
async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone()).catch(() => {});
  return res;
}
let tilePuts = 0;
async function tile(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req);
  if (hit) {
    const at = Number(hit.headers.get('x-sq-at')) || 0;
    if (Date.now() - at > TILE_AGE) fetchTile(req, cache).catch(() => {});
    return hit;
  }
  return fetchTile(req, cache);
}
async function fetchTile(req, cache) {
  const res = await fetch(req);
  // an opaque answer (no CORS) can't be told from an error page and counts megabytes against the quota
  if (res.ok && res.type !== 'opaque') {
    const h = new Headers(res.headers);
    h.set('x-sq-at', String(Date.now()));
    const copy = new Response(await res.clone().blob(), { status: 200, headers: h });
    cache.put(req, copy).then(() => { if (++tilePuts % 200 === 0) trim(cache); }).catch(() => {});
  }
  return res;
}
async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - TILE_MAX; i++) await cache.delete(keys[i]); // oldest first
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (PASS.test(url.pathname)) return;
    if (url.pathname.startsWith('/api/')) {
      if (API_OK.some((rx) => rx.test(url.pathname)) && !url.search) e.respondWith(networkFirst(req, API));
      return;
    }
    // the app itself: whatever the address says after "?", it is the same page
    if (req.mode === 'navigate') { if (url.pathname === '/') e.respondWith(networkFirst(req, SHELL, '/')); return; }
    e.respondWith(networkFirst(req, SHELL));
    return;
  }
  if (TILE.test(req.url)) { e.respondWith(tile(req)); return; }
  if (CDN.test(req.url)) e.respondWith(cacheFirst(req, SHELL));
});
