/* sw.js — 调试阶段：网络优先，不长期缓存旧版本（避免页面空白/改了不生效） */
const CACHE = 'qingjian-v2';
const SHELL = ['./', './index.html', './style.css', './app.js', './engine.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // 代理 POST 不走缓存
  // 网络优先：始终尝试最新文件，失败才回退缓存（离线可用）
  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match('./')))
  );
});
