const SHELL_CACHE = 'eta-shell-v2';   // bump on every SW change — v2 fixes B11 stale Library
const SHELL_URLS = ['/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE).then((c) =>
      Promise.all(SHELL_URLS.map((u) => c.add(u).catch(() => {})))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    Promise.all([
      // Drop ALL caches not on the current version — heals any prior broken state
      caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))),
      // Kill switch: if /sw-killswitch.txt returns body "killed", unregister this SW
      fetch('/sw-killswitch.txt', { cache: 'no-store' }).then(async (r) => {
        if (r.ok) {
          const t = (await r.text()).trim();
          if (t === 'killed') {
            const regs = await self.registration;
            await regs.unregister();
            const all = await self.clients.matchAll();
            all.forEach((c) => c.navigate(c.url)); // reload all clients without SW
          }
        }
      }).catch(() => {}),
      self.clients.claim(),
    ])
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // NEVER intercept the killswitch or the SW itself
  if (url.pathname === '/sw-killswitch.txt' || url.pathname === '/sw.js') {
    return; // let the browser handle it normally
  }
  // Network-first for navigations (page loads). If network fails, fall back to cache.
  // This means a broken cached response can never permanently block the page.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then((resp) => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(e.request, clone).catch(() => {}));
        }
        return resp;
      }).catch(() => caches.match(e.request).then((cached) => cached || new Response('Offline', { status: 503 })))
    );
    return;
  }
  // Network-first for ANY API path — including doctor-scoped /<slug>/api/*.
  // B11 root cause: prior code used url.pathname.startsWith('/api/'), which
  // does NOT match /dr-vinay-bhardwaj-cjzs/api/encounters. Those GET responses
  // fell through to the cache-first static-asset branch below and were
  // permanently pinned in the SHELL cache — the doctor's Library never showed
  // new encounters even after switching tabs or hard-refreshing.
  if (url.pathname.includes('/api/')) {
    e.respondWith(
      fetch(e.request).catch(() => new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } }))
    );
    return;
  }
  // Static assets — cache-first, fall through to network. Only cache the
  // hashed Next build output to avoid pinning anything else by accident.
  if (e.request.method === 'GET') {
    const cacheable =
      url.pathname.startsWith('/_next/static/') ||
      url.pathname.startsWith('/icons/') ||
      url.pathname.endsWith('.webmanifest') ||
      url.pathname.endsWith('.svg') ||
      url.pathname.endsWith('.png') ||
      url.pathname.endsWith('.ico');
    if (!cacheable) {
      // Anything else: pure network, no caching. Safer default than the prior
      // catch-all that cached every GET on the origin.
      return;
    }
    e.respondWith(
      caches.match(e.request).then((cached) =>
        cached || fetch(e.request).then((resp) => {
          if (resp.ok && resp.type !== 'opaque') {
            const clone = resp.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(e.request, clone).catch(() => {}));
          }
          return resp;
        }).catch(() => cached)
      )
    );
  }
});
