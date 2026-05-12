/* Customer Portal Service Worker
 *
 * CACHE_VERSION is automatically replaced at build time with the current git
 * commit hash by the `famous-build-id-injection` Vite plugin (see
 * vite.config.ts). DO NOT hand-edit CACHE_VERSION below — every deploy gets a
 * unique value so old caches are invalidated automatically.
 *
 * Strategy:
 *  - App shell (HTML): network-first, fall back to cached shell when offline.
 *  - Static assets (JS/CSS/fonts/images from same origin): stale-while-revalidate.
 *  - Supabase API + auth requests: network-only (never cache sensitive data).
 *  - Navigation requests offline: serve cached index.html so the SPA can boot.
 */

const CACHE_VERSION = '__BUILD_ID__';
const STATIC_CACHE = `portal-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `portal-runtime-${CACHE_VERSION}`;

// Minimal app shell — Vite hashes JS/CSS, so we only precache stable URLs.
const APP_SHELL = [
  '/',
  '/index.html',
  `/manifest.json?v=__BUILD_ID__`,
  `/app-icon.png?v=__BUILD_ID__`,
];

// ---------- Install ----------
self.addEventListener('install', (event) => {
  // Activate this new SW immediately instead of waiting for all tabs using
  // the old SW to close. Combined with `clients.claim()` in `activate` and
  // the `controllerchange` listener in index.html, this means new deploys
  // automatically take over on the next page load — users never get stuck
  // on a stale build. Trade-off: a mid-session reload may occur once when
  // a new deploy is detected.
  self.skipWaiting();

  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) =>
        // Use addAll with individual catches so one failed asset doesn't abort install.
        Promise.all(
          APP_SHELL.map((url) =>
            cache.add(new Request(url, { cache: 'reload' })).catch((err) => {
              console.warn('[sw] precache failed for', url, err);
            })
          )
        )
      )
  );
});


// ---------- Activate ----------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Aggressively delete EVERY cache that isn't ours — this includes old
      // versioned caches from prior deploys and any leftover caches from
      // previous SW implementations.
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== STATIC_CACHE && key !== RUNTIME_CACHE)
          .map((key) => {
            console.log('[sw] deleting old cache:', key);
            return caches.delete(key);
          })
      );

      // Enable navigation preload if available (faster first paint).
      if (self.registration.navigationPreload) {
        try {
          await self.registration.navigationPreload.enable();
        } catch (_) {
          /* noop */
        }
      }

      await self.clients.claim();

      // Notify all open clients that a new version is now active. They can
      // use this to refresh in-memory caches or display a "Updated" toast.
      const clients = await self.clients.matchAll({ includeUncontrolled: true });
      clients.forEach((client) => {
        client.postMessage({
          type: 'SW_ACTIVATED',
          buildId: CACHE_VERSION,
        });
      });
    })()
  );
});

// ---------- Message: allow page to trigger immediate activation ----------
self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data.type === 'GET_BUILD_ID') {
    event.source &&
      event.source.postMessage({
        type: 'BUILD_ID',
        buildId: CACHE_VERSION,
      });
  }
  if (event.data.type === 'CLEAR_CACHES') {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
    );
  }
});

// ---------- Helpers ----------
const isSupabaseRequest = (url) =>
  url.hostname.endsWith('.supabase.co') ||
  url.hostname.endsWith('.supabase.in');

const isApiRequest = (url) =>
  url.pathname.startsWith('/api/') || url.pathname.startsWith('/functions/');

const isStaticAsset = (request, url) => {
  if (url.origin !== self.location.origin) return false;
  const dest = request.destination;
  return (
    dest === 'script' ||
    dest === 'style' ||
    dest === 'font' ||
    dest === 'image' ||
    /\.(?:js|mjs|css|woff2?|ttf|otf|png|jpg|jpeg|svg|webp|ico)$/i.test(
      url.pathname
    )
  );
};

// Stale-while-revalidate: return cached copy immediately, update in background.
async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((response) => {
      if (response && response.status === 200 && response.type === 'basic') {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => cached);
  return cached || networkPromise;
}

// Network-first for navigations: serve fresh HTML, fall back to cached shell.
async function networkFirstNavigation(event) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const preload = await event.preloadResponse;
    if (preload) {
      cache.put('/index.html', preload.clone()).catch(() => {});
      return preload;
    }
    const network = await fetch(event.request);
    if (network && network.status === 200) {
      cache.put('/index.html', network.clone()).catch(() => {});
    }
    return network;
  } catch (_) {
    const cached =
      (await cache.match('/index.html')) || (await cache.match('/'));
    if (cached) return cached;
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Offline</title><h1>Offline</h1><p>Please reconnect and try again.</p>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 }
    );
  }
}

// ---------- Fetch ----------
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET; let the browser handle POST/PUT/DELETE/etc.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache Supabase or our API/edge-function calls — these contain
  // user-specific, auth-gated data.
  if (isSupabaseRequest(url) || isApiRequest(url)) {
    return; // default network handling
  }

  // SPA navigations: network-first with offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(event));
    return;
  }

  // Same-origin static assets: stale-while-revalidate.
  if (isStaticAsset(request, url)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // Everything else: try network, fall back to cache if available.
  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});
