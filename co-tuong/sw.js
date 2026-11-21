/* Cờ Tướng Đạo Pro: lưu bản game để mở được khi mất mạng (chơi với máy). Trang chính luôn lấy bản mới từ mạng trước. */
const V='xq-2.8.0';
const HOME='/co-tuong/';
const CORE=[HOME,HOME+'manifest.webmanifest',HOME+'icon-192.png',HOME+'icon-512.png',HOME+'apple-touch-icon.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith('xq-')&&k!==V).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const r=e.request;if(r.method!=='GET')return;const u=new URL(r.url);
 if(u.origin!==location.origin||!u.pathname.startsWith(HOME))return;
 if(u.pathname.endsWith('version.json')||u.pathname.endsWith('sw.js')||/\.nnue/.test(u.pathname))return; /* mạng NNUE 50 MB do app tự lưu riêng */
 const page=r.mode==='navigate'||u.pathname===HOME||u.pathname.endsWith('/index.html');
 if(page){e.respondWith(fetch(r,{cache:'no-store'}).then(res=>{if(res.ok){const cp=res.clone();caches.open(V).then(c=>c.put(HOME,cp))}return res}).catch(()=>caches.match(HOME)));return}
 e.respondWith(caches.match(r).then(m=>m||fetch(r).then(res=>{if(res.ok){const cp=res.clone();caches.open(V).then(c=>c.put(r,cp))}return res})))});
