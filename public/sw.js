// Service Worker: оболочка и медиа из кэша (первая отрисовка < 2 с, работа без интернета).
const V = 'sb-v8';
const SHELL = ['/', '/tv', '/index.html', '/tv.html', '/style.css', '/tv.css', '/common.js', '/tv.js', '/fonts/sb-sans-400.ttf', '/fonts/sb-sans-700.ttf'];

self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Safari/tvOS запрашивает видео через Range — отдаём срез из кэша.
async function rangeFromCache(req, cached) {
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  if (!m) return cached;
  const buf = await cached.arrayBuffer();
  const start = m[1] ? +m[1] : 0, end = m[2] ? Math.min(+m[2], buf.byteLength - 1) : buf.byteLength - 1;
  return new Response(buf.slice(start, end + 1), { status: 206, headers: {
    'Content-Type': cached.headers.get('Content-Type') || 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${buf.byteLength}`, 'Content-Length': end - start + 1 } });
}

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || (url.pathname.startsWith('/api/') && url.pathname !== '/api/state') || url.pathname.startsWith('/admin')) return;

  if (url.pathname.startsWith('/media/')) { // cache-first
    e.respondWith((async () => {
      const c = await caches.open(V);
      const hit = await c.match(url.pathname);
      if (hit) return rangeFromCache(req, hit);
      const res = await fetch(url.pathname).catch(() => null); // всегда полный файл, чтобы можно было положить в кэш
      if (!res || !res.ok) return res || Response.error();
      c.put(url.pathname, res.clone());
      return rangeFromCache(req, res);
    })());
    return;
  }

  // остальное: network-first с откатом на кэш
  e.respondWith((async () => {
    const c = await caches.open(V);
    try {
      const res = await fetch(req);
      if (res.ok && !url.pathname.startsWith('/api/')) c.put(req, res.clone());
      return res;
    } catch {
      return (await c.match(req, { ignoreSearch: true })) || (await c.match(url.pathname === '/tv' ? '/tv.html' : '/index.html')) || Response.error();
    }
  })());
});
