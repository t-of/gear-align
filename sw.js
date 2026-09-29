// オフラインでも遊べるようにするサービスワーカー。
//
// 同じサイトのファイルは「ネットを先に見て、つながらなければ保存しておいた版」を返す。
// つながっていれば常に最新が出るので、更新のたびに版を上げ忘れても古い画面が残らない。
// 字体（Google Fonts）は変わらないので「保存した版を先に返し、裏で取り直す」。
// ブラウザの HTTP キャッシュを通さない（install は reload、fetch は no-cache）。古い main.js と新しい index.html が混ざって動かなくなるのを防ぐ。

// 同じサイト（t-of.github.io）の別アプリのキャッシュを消さないよう、名前は必ずこの接頭辞で始める
const PREFIX = 'gear-align-';
const CACHE = PREFIX + 'v1';
const SHELL = [
  './', './index.html', './manifest.json', './css/style.css',
  './src/main.js', './src/puzzle.js', './src/modes.js', './src/layout.js', './src/gear.js',
  './src/solve.js', './src/lattice.js', './src/rng.js', './src/sound.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
  './icons/maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) e.respondWith(networkFirst(req));
  else if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) e.respondWith(staleWhileRevalidate(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req, { cache: 'no-cache' });
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') return cache.match('./index.html');
    throw new Error('offline');
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const fresh = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; })
    .catch(() => hit);
  return hit || fresh;
}
