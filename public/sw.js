const CACHE_NAME = 'asu-cal-v26';
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

// Every /api/ GET not listed here is network-first (cached copy only as an
// offline fallback). APIs must NEVER be cache-first: that froze /api/seasons,
// /api/releases, etc. at their first response until a CACHE_NAME bump.
const NETWORK_ONLY_PATHS = [
  '/api/live',
  '/api/game',
  '/api/refresh',
  '/api/geocode',
  '/api/subscribe',
  '/api/unsubscribe',
  '/api/admin',   // auth'd + must never be served stale from cache
  '/admin/',      // admin portal page: unversioned HTML, online-only tool
  '/stats',       // stats page + /stats.html: same
];

// APIs whose responses are JSON arrays — the offline fallback shape must
// match or callers like fetchEvents() throw on `.filter` while offline.
const ARRAY_APIS = new Set(['/api/events', '/api/sports', '/api/locations', '/api/seasons']);

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

  // All other API GETs: network-first, cached copy only as offline fallback
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirstWithFallback(request));
    return;
  }

  // Cache-first: shell (versioned ?v= assets) + CDN
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
  // 4s: through CF Access + tunnel a cold request can exceed 2s — aborting
  // that early showed the offline banner to users who were never offline.
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
      _notifyOnline();
      return response;
    }
    throw new Error(`HTTP ${response.status}`);
  } catch {
    clearTimeout(timer);
    const cached = await caches.match(request);
    _notifyOffline();
    if (cached) return cached;
    // Nothing cached: array endpoints get an empty array (callers .filter/.map
    // the body without checking status); everything else gets a JSON 503.
    if (ARRAY_APIS.has(new URL(request.url).pathname)) {
      return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ offline: true }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

function _notifyOffline() {
  _postToClients('offline');
}

// Recovery signal: the window 'online' event never fires when the "offline"
// state came from a slow/failed fetch rather than real connectivity loss —
// the banner used to stick around forever. Any successful network-first
// response clears it.
function _notifyOnline() {
  _postToClients('online');
}

function _postToClients(type) {
  self.clients.matchAll({ type: 'window' }).then(clients => {
    for (const client of clients) {
      client.postMessage({ type });
    }
  });
}

// ── Push ──────────────────────────────────────────────────────────────────────

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() ?? {}; } catch {}

  const n = data.notification || {};
  const title = n.title || 'ASU Sun Devil Athletics';

  // Game-start payloads carry startTime as a raw epoch (seconds) so the time
  // renders in the DEVICE's local timezone — the server's TZ is meaningless
  // to a traveling user. Computed here at display time, so the lead minutes
  // are exact. Old payloads without startTime just show n.body unchanged.
  let body = n.body || '';
  if (data.startTime) {
    const t = new Date(data.startTime * 1000);
    const timeStr = t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const mins = Math.round((t.getTime() - Date.now()) / 60000);
    const lead = mins > 0 ? `Starts in ${mins} min (${timeStr})` : `Started at ${timeStr}`;
    body = [lead, body].filter(Boolean).join(' · ');
  }

  const options = {
    body,
    icon:    n.icon || '/icons/icon-192.png',
    badge:   '/icons/icon-192.png',
    data:    { navigate: n.navigate || '/' },
    // Per-game tags from the server let score updates replace each other;
    // the constant fallback keeps old payload shapes working.
    tag:     n.tag || 'asu-game-alert',
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
