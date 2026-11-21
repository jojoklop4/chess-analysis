/*
 * coi-serviceworker.js
 * Dual-purpose: when loaded as <script>, registers itself as a Service Worker
 * and reloads the page so it runs cross-origin-isolated (required for
 * SharedArrayBuffer / Stockfish multi-threading).
 * When running as the Service Worker, it injects COOP/COEP/CORP headers on
 * every same-origin response and caches assets for offline use.
 */

const CACHE = 'chess-v1';

const PRECACHE = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './engine.worker.js',
  './manifest.json',
  './icon.svg',
];

// ── SERVICE WORKER CONTEXT ───────────────────────────────────────────────────
if (typeof ServiceWorkerGlobalScope !== 'undefined') {

  self.addEventListener('install', event => {
    event.waitUntil(
      caches.open(CACHE)
        .then(cache => cache.addAll(PRECACHE))
        .then(() => self.skipWaiting())
    );
  });

  self.addEventListener('activate', event => {
    event.waitUntil(
      caches.keys()
        .then(keys => Promise.all(
          keys.filter(k => k !== CACHE).map(k => caches.delete(k))
        ))
        .then(() => self.clients.claim())
    );
  });

  self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);

    // Only intercept same-origin requests.
    // Cross-origin resources (piece images from lichess, chess.js from jsDelivr)
    // are passed through to the browser unchanged — they carry their own CORP
    // headers and must not be re-wrapped with our COI headers.
    if (url.origin !== self.location.origin) return;

    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (!response || response.status === 0) return response;

          // Cache successful same-origin responses for offline use
          if (response.ok) {
            caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
          }

          // Inject COOP/COEP/CORP so the page becomes cross-origin-isolated
          const headers = new Headers(response.headers);
          headers.set('Cross-Origin-Opener-Policy', 'same-origin');
          headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
          headers.set('Cross-Origin-Resource-Policy', 'cross-origin');

          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        })
        .catch(() => caches.match(event.request))
    );
  });

// ── MAIN PAGE CONTEXT (self-registration) ───────────────────────────────────
} else if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {

  if (!window.crossOriginIsolated) {
    navigator.serviceWorker
      .register(document.currentScript.src)
      .then(reg => {
        // If this is a fresh install, wait for activation then reload
        if (reg.installing) {
          reg.installing.addEventListener('statechange', e => {
            if (e.target.state === 'activated') location.reload();
          });
        } else if (reg.active) {
          // SW already active but page isn't isolated — reload
          location.reload();
        }
      })
      .catch(err => {
        console.warn('[COI-SW] Registration failed:', err);
      });
  }

}
