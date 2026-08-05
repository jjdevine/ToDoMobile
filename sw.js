'use strict';

importScripts('./sw-version.js');

const CACHE_NAME = 'task-planner-' + CACHE_VERSION;
const CDN_SCRIPT = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
const REQUEST_TIMEOUT_MS = 10000;
const CACHEABLE_URLS = new Set(CACHE_FILES.map((path) => new URL(path, self.location.href).href).concat(CDN_SCRIPT));

function isCacheableRequest(request) {
  return request.method === 'GET' &&
    !request.headers.has('authorization') &&
    CACHEABLE_URLS.has(request.url);
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(CACHE_FILES);
    try { await cache.add(CDN_SCRIPT); } catch {
      // The app shell remains usable when the optional CDN asset is unavailable.
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(event.request, { signal: controller.signal });
        clearTimeout(timeoutId);
        return response;
      } catch {
        clearTimeout(timeoutId);
        const shell = await caches.match('./index.html');
        return shell || new Response('Offline - application shell not cached.', { status: 503 });
      }
    })());
    return;
  }

  if (!isCacheableRequest(event.request)) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith((async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(event.request, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (response.ok && isCacheableRequest(event.request)) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(event.request, response.clone());
      }
      return response;
    } catch {
      clearTimeout(timeoutId);
      const cached = await caches.match(event.request);
      if (cached) return cached;

      const cachedIgnoringSearch = await caches.match(event.request, { ignoreSearch: true });
      if (cachedIgnoringSearch) return cachedIgnoringSearch;

      return new Response('Offline - resource not cached.', { status: 503 });
    }
  })());
});
