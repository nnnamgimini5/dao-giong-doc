/* Giọng đọc Đạo Pro: lưu vỏ app để mở được khi mất mạng.
   Trang, JS, CSS luôn lấy bản mới từ mạng trước; mất mạng mới dùng bản đã lưu.
   Không đụng tới /co-tuong/ (game có service worker riêng) và mô hình giọng (app tự lưu). */
const V = 'gd-2.3.0';
const CORE = ['/', '/index.html', '/app.js', '/clone.js', '/sync.js', '/pwa.js', '/style.css', '/extra.css',
  '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('gd-') && k !== V).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== location.origin) return;
  if (u.pathname.startsWith('/co-tuong')) return;
  if (u.pathname.endsWith('version.json') || u.pathname.endsWith('sw.js')) return;

  const page = r.mode === 'navigate';
  const key = page ? '/' : r;
  e.respondWith(
    fetch(r, page ? { cache: 'no-store' } : undefined)
      .then(res => {
        if (res.ok) { const cp = res.clone(); caches.open(V).then(c => c.put(key, cp)); }
        return res;
      })
      .catch(() => caches.match(key).then(m => m || caches.match('/')))
  );
});
