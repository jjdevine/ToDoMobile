'use strict';

importScripts('./sw-version.js');

const CACHE_NAME = 'task-planner-' + CACHE_VERSION;
const CDN_SCRIPT = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(CACHE_FILES);
    try { await cache.add(CDN_SCRIPT); } catch {}
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

  event.respondWith((async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(event.request, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (response.ok) {
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

      if (event.request.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }

      return new Response('Offline - resource not cached.', { status: 503 });
    }
  })());
});
