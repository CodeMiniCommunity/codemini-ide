// Static app-shell cache. Matches the app version (package.json / Settings > About); bump it on every release
// that changes a precached file so installed copies refresh (old caches are deleted on activate).
const CACHE_NAME = 'codemini-static-v1.3.1';
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
    '/js/core/app-alerts.js',
    '/js/notebook/notebook-kernels.js',
    '/js/notebook/notebook-ui.js',
    '/js/notebook/environments.js',
    '/js/viewers/preview.js',
    '/js/viewers/pdf-viewer.js',
    '/js/core/script.js',
    '/js/core/workspace-trust.js',
    '/js/core/help-feedback.js',
    '/js/core/app-info.js',
    '/js/core/shield.js',
    '/js/core/html-escape.js',
    '/js/viewers/runner-client.js',
    '/js/core/my-keys.js',
    '/js/core/file-lock.js',
    '/js/core/settings-profile.js',
    '/js/terminal/terminal-commands.js',
    '/js/terminal/terminal-window.js',
    '/js/terminal/console.js',
    '/js/core/preloader.js',
    '/js/core/pwa.js',
    '/manifest.json',
    '/icons/icon.png',
    '/icons/icon-192.png',
    '/icons/icon-maskable-192.png',
    '/icons/icon-maskable-512.png',
    '/icons/apple-touch-icon.png',
    '/icons/favicon-32.png',
    '/icons/favicon-16.png',
    '/icons/favicon.ico'
];

// How long a same-origin request may wait for the network before the cached copy is served instead.
// Without this, a flaky ("lie-fi") connection - connected but barely moving data - hangs the app shell until the
// browser's own timeout, even though a perfectly good cached copy is sitting right there. The network request
// keeps going after the timeout, so the cache is still refreshed for next time.
const NETWORK_TIMEOUT_MS = 4000;

// Network-first for the app's own files, with a timeout and an offline fallback.
//  - navigations ignore the query string when matching the cache (so /?foo still finds the cached shell)
//  - a navigation that can't be served from network OR cache falls back to the cached app shell
function networkFirst(request) {
    const isNavigation = request.mode === 'navigate';
    const fromCache = () => caches.match(request, { ignoreSearch: isNavigation })
        .then((hit) => hit || (isNavigation ? caches.match('/index.html') : undefined));

    return new Promise((resolve) => {
        let settled = false;
        const finish = (response) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(response);
        };
        const timer = setTimeout(() => {
            fromCache().then((hit) => { if (hit) finish(hit); }).catch(() => {});
        }, NETWORK_TIMEOUT_MS);

        // cache: 'no-cache' forces revalidation with the server on every request - a 304 lets the browser serve its
        // own cached copy efficiently if unchanged, a 200 delivers the fresh file if it has changed. Deliberately NOT
        // 'no-store', which is more aggressive than needed here and more likely to cause edge-case failures on
        // requests this same origin-wide handler also intercepts.
        fetch(request, { cache: 'no-cache' }).then((networkResponse) => {
            if (networkResponse && networkResponse.ok) {
                const responseToCache = networkResponse.clone();
                caches.open(CACHE_NAME).then((cache) => {
                    cache.put(request, responseToCache).catch(() => {});
                }).catch(() => {});
            }
            finish(networkResponse);
        }).catch(() => {
            fromCache()
                .then((hit) => finish(hit || Response.error()))
                .catch(() => finish(Response.error()));
        });
    });
}

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

    // 2. Local Files -> NETWORK FIRST (with timeout + offline fallback, see networkFirst above)
    event.respondWith(networkFirst(event.request));
});
