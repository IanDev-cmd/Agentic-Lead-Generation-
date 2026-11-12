const VERSION = 'v4';
const SHELL = `lead-shell-${VERSION}`;
const RUNTIME = `lead-runtime-${VERSION}`;
const PRECACHE = [
  '/',
  '/offline.html',
  '/manifest.webmanifest',
  '/pwa.js',
  '/bg.jpg',
  '/orbs.js',
  '/icons/alpha.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== SHELL && key !== RUNTIME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

function sameOrigin(url) {
  return url.origin === self.location.origin;
}

async function fromCache(cacheName, request) {
  const cache = await caches.open(cacheName);
  return cache.match(request);
}

async function cacheFirst(request) {
  const cached = await fromCache(SHELL, request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh.ok) {
    const cache = await caches.open(SHELL);
    try { await cache.put(request, fresh.clone()); } catch { /* a no-store response cannot be stored */ }
  }
  return fresh;
}

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) {
      try { await cache.put(request, fresh.clone()); } catch { /* keep the network response anyway */ }
    }
    return fresh;
  } catch (error) {
    const cached = await cache.match(request) || await caches.match(request);
    if (cached) return cached;
    throw error;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME);
  const cached = await cache.match(request) || await caches.match(request);
  const refresh = fetch(request).then(async (response) => {
    if (response && response.ok) {
      try { await cache.put(request, response.clone()); } catch { /* keep the previous copy */ }
    }
    return response;
  }).catch(() => null);
  if (cached) return cached;
  const response = await refresh;
  if (response) return response;
  throw new Error('offline');
}

async function route(request) {
  const url = new URL(request.url);
  if (request.mode === 'navigate') {
    try {
      return await networkFirst(request);
    } catch {
      const offline = await caches.match('/offline.html');
      if (offline) return offline;
      return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  }
  if (!sameOrigin(url)) {
    if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return cacheFirst(request);
    return fetch(request);
  }
  if (url.pathname.startsWith('/api/')) return networkFirst(request);
  if (/\.(png|jpg|jpeg|svg|webp|ico|webmanifest)$/i.test(url.pathname) || url.pathname.startsWith('/icons/')) {
    return cacheFirst(request);
  }
  return staleWhileRevalidate(request);
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(route(event.request).catch(() => new Response('Offline', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })));
});

self.addEventListener('push', (event) => {
  let payload = {
    title: 'Lead desk',
    body: 'You have an update.',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: '/' },
  };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch { /* show the fallback copy */ }
  const url = typeof payload.data?.url === 'string' && payload.data.url.startsWith('/') && !payload.data.url.startsWith('//')
    ? payload.data.url
    : '/';
  event.waitUntil(self.registration.showNotification(String(payload.title || 'Lead desk'), {
    body: String(payload.body || ''),
    icon: payload.icon || '/icons/icon-192.png',
    badge: payload.badge || '/icons/icon-192.png',
    data: { url },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = event.notification.data?.url || '/';
  const path = typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
  const target = new URL(path, self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      if ('navigate' in client) {
        try { await client.navigate(target); } catch { /* focus the open window anyway */ }
      }
      if ('focus' in client) await client.focus();
      return;
    }
    await self.clients.openWindow(target);
  })());
});
