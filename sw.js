/**
 * Service worker for the hosted web app.
 *
 * The app shell is precached so the app opens with no network at all; the
 * dictionaries live in IndexedDB and never go through here. Assets are
 * served from the cache and refreshed in the background, and page loads try
 * the network first, so a new deployment is picked up without bumping a
 * version by hand.
 */

const CACHE = 'mdict-shell-v1';

const SHELL = [
  './',
  './index.html',
  './app.webmanifest',
  './src/app.js',
  './src/sidepanel.js',
  './src/sidepanel.css',
  './src/viewer.html',
  './src/lib/library.js',
  './src/lib/lzo1x.js',
  './src/lib/mdict.js',
  './src/lib/platform.js',
  './src/lib/render.js',
  './src/lib/ripemd128.js',
  './src/lib/shell.js',
  './src/lib/storage.js',
  './src/worker/indexer.js',
  './icons/icon32.png',
  './icons/icon192.png',
  './icons/icon512.png',
  './icons/icon-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // One missing file should not fail the whole install.
      .then((cache) => Promise.all(SHELL.map((path) => cache.add(path).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== location.origin) return;

  event.respondWith(request.mode === 'navigate' ? loadPage(request) : loadAsset(request));
});

/** Pages: newest version when online, cached shell when not. */
async function loadPage(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put('./index.html', response.clone());
    return response;
  } catch {
    return (
      (await cache.match('./index.html')) ||
      (await cache.match('./')) ||
      new Response('Offline, and this page is not in the cache yet.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' },
      })
    );
  }
}

/** Everything else: cached copy right away, refreshed for next time. */
async function loadAsset(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  const fromNetwork = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return cached || (await fromNetwork) || Response.error();
}
