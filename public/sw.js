const CACHE_NAME = 'asu-cal-v10';
const OFFLINE_CHANNEL = 'asu-offline';

// JS and CSS files are loaded with versioned query params (e.g. live.js?v=22).
// caches.match does exact URL matching (ignoreSearch:false by default), so bare
// paths like /live.js never match a request for /live.js?v=22. Only include
// resources that are requested without query params.
const SHELL_URLS = [
  '/',
  '/manifest.json',
  '/sparky.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

const CDN_ORIGINS = [
  'cdn.jsdelivr.net',
  'unpkg.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

const NETWORK_FIRST_PATHS = ['/api/events', '/api/sports', '/api/locations', '/api/standings', '/api/h2h', '/api/news', '/api/roster'];

const NETWORK_ONLY_PATHS = [
  '/api/live',
  '/api/game',
  '/api/refresh',
  '/api/geocode',
  '/api/subscribe',
  '/api/unsubscribe',
];

// ── Install: pre-cache shell ──────────────────────────────────────────────────

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting()),
  );
});

// ── Activate: prune old caches ────────────────────────────────────────────────

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Never intercept non-GET
  if (request.method !== 'GET') return;

  // Network-only paths
  if (NETWORK_ONLY_PATHS.some(p => url.pathname.startsWith(p))) return;

  // Network-first: API data endpoints
  if (NETWORK_FIRST_PATHS.some(p => url.pathname.startsWith(p))) {
    event.respondWith(networkFirstWithFallback(request));
    return;
  }

  // Cache-first: shell + CDN
  if (url.origin === self.location.origin || CDN_ORIGINS.includes(url.hostname)) {
    event.respondWith(cacheFirst(request));
    return;
  }
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

async function networkFirstWithFallback(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
      return response;
    }
    throw new Error(`HTTP ${response.status}`);
  } catch {
    clearTimeout(timer);
    const cached = await caches.match(request);
    if (cached) {
      _notifyOffline();
      return cached;
    }
    _notifyOffline();
    return new Response(JSON.stringify({ offline: true, events: [] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

function _notifyOffline() {
  self.clients.matchAll({ type: 'window' }).then(clients => {
    for (const client of clients) {
      client.postMessage({ type: 'offline' });
    }
  });
}

// ── Push ──────────────────────────────────────────────────────────────────────

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() ?? {}; } catch {}

  const n = data.notification || {};
  const title = n.title || 'ASU Sun Devil Athletics';
  const options = {
    body:    n.body || '',
    icon:    n.icon || '/icons/icon-192.png',
    badge:   '/icons/icon-192.png',
    data:    { navigate: n.navigate || '/' },
    tag:     'asu-game-alert',
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const navigate = event.notification.data?.navigate || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const client of clients) {
        if (new URL(client.url).origin === self.location.origin) {
          client.focus();
          return;
        }
      }
      return self.clients.openWindow(navigate);
    }),
  );
});
