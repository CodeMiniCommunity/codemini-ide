// Static app-shell cache. Matches the app version (package.json / Settings > About); bump it on every release
// that changes a precached file so installed copies refresh (old caches are deleted on activate).
const CACHE_NAME = 'codemini-static-v1.0.0';
// Deliberately NOT bumped with CACHE_NAME: everything already in here is a valid
// (non-opaque) CDN response, and bumping would force every user to re-download
// Pyodide/Monaco for no reason.
const DYNAMIC_CACHE = 'codemini-dynamic-v1.10.000.9';

// index.html loads Monaco, sql.js, Pyodide, Remix Icon and Font Awesome with plain
// <script>/<link> tags (no crossorigin attribute). The browser sends those as
// "no-cors" requests, so the response is opaque (status 0) and the cache-first
// branch below refused to store it - meaning those assets were never available
// offline. All of these CDNs send CORS headers, so re-request them in CORS mode:
// the response is then readable and cacheable, and is still usable by the
// original <script>/<link> tag. If a host has no CORS headers, fall back to the
// original request so the page still loads (just uncached, as before).
function fetchCrossOrigin(request) {
    if (request.mode === 'no-cors') {
        return fetch(request.url, { mode: 'cors', credentials: 'omit' })
            .catch(() => fetch(request));
    }
    return fetch(request);
}


const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/css/style.css',
    '/css/themes.css',
    '/js/core/app.js',
    '/js/core/up-down.js',
    '/js/viewers/media.js',
    '/js/viewers/archive.js',
    '/js/viewers/docs.js',
    '/js/core/editor.js',
    '/js/core/search.js',
    '/js/git/stacks.js',
    '/js/git/git.js',
    '/js/core/now-island.js',
    '/js/notebook/notebook-kernels.js',
    '/js/notebook/notebook-ui.js',
    '/js/notebook/environments.js',
    '/js/viewers/preview.js',
    '/js/viewers/pdf-viewer.js',
    '/js/core/script.js',
    '/js/core/workspace-trust.js',
    '/js/core/help-feedback.js',
    '/js/core/app-info.js',
    '/js/core/settings-profile.js',
    '/js/terminal/terminal-commands.js',
    '/js/terminal/terminal-window.js',
    '/js/terminal/console.js',
    '/js/core/preloader.js',
    '/manifest.json'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS);
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.map((key) => {
                    if (key !== CACHE_NAME && key !== DYNAMIC_CACHE) {
                        return caches.delete(key);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    // Only GET responses can be cached. Everything else (POST/PUT/PATCH/DELETE -
    // e.g. GitHub Contents/Issues/PR writes) goes straight to the network, and
    // returning without respondWith() leaves the browser's own handling untouched.
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);

    // Live, authenticated API traffic must NEVER be served from cache. The
    // cross-origin branch below is cache-first, which is right for versioned CDN
    // libraries but wrong for GitHub's REST API: it returned the FIRST response
    // to any URL forever (Cache.match ignores the Authorization header), so Pull
    // kept reading a stale branch SHA, Push kept sending a stale file SHA (409),
    // the repository list never updated after creating a repo, and a revoked
    // token still "verified". Matching on the Authorization header as well as the
    // host keeps this correct for any other token-bearing API added later.
    if (url.hostname === 'api.github.com' || event.request.headers.has('Authorization')) return;

    // 1. External CDNs (Monaco, Pyodide, Fonts, Icons) -> CACHE FIRST, fallback to network
    if (url.origin !== location.origin) {
        event.respondWith(
            caches.match(event.request).then((cachedResponse) => {
                if (cachedResponse) return cachedResponse;
                
                return fetchCrossOrigin(event.request).then((networkResponse) => {
                    // Only cache valid, successful responses
                    if (!networkResponse || networkResponse.status !== 200 || networkResponse.type === 'opaque') {
                        return networkResponse;
                    }
                    const responseToCache = networkResponse.clone();
                    caches.open(DYNAMIC_CACHE).then((cache) => {
                        return cache.put(event.request, responseToCache);
                    }).catch(() => {});
                    return networkResponse;
                }).catch(() => {
                    // Offline and not cached: resolve with a real network error.
                    // (Returning undefined here made respondWith() throw a TypeError.)
                    return Response.error();
                });
            })
        );
        return;
    }

    // 2. Local Files -> NETWORK FIRST (cache: 'no-cache' forces revalidation with
    // the server on every request - a 304 lets the browser serve its own cached
    // copy efficiently if unchanged, a 200 delivers the fresh file if it has
    // changed. Deliberately NOT 'no-store', which is more aggressive than needed
    // here and more likely to cause edge-case failures on requests this same
    // origin-wide handler also intercepts.
    event.respondWith(
        fetch(event.request, { cache: 'no-cache' }).then((networkResponse) => {
            if (networkResponse && networkResponse.ok) {
                const responseToCache = networkResponse.clone();
                caches.open(CACHE_NAME).then((cache) => {
                    cache.put(event.request, responseToCache).catch(() => {});
                }).catch(() => {});
            }
            return networkResponse;
        }).catch(() => {
            return caches.match(event.request).then((cached) => {
                return cached || Response.error();
            });
        })
    );
});