/* CDRAMA 서비스 워커
 * - 앱 셸: 캐시 우선(오프라인에서도 화면은 열림)
 * - 데이터(dramas.json): 네트워크 우선 + 캐시 백업
 */
const VERSION = 'cdrama-v5';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // YouTube 플레이어·썸네일 등 외부 리소스는 그대로 통과
  if (url.origin !== self.location.origin) return;

  // 데이터 파일: 네트워크 우선
  if (url.pathname.endsWith('/data/dramas.json')) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // 화면 이동: 네트워크 우선, 실패하면 index.html
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('./index.html').then((hit) => hit || caches.match('./')))
    );
    return;
  }

  // 정적 자원: 네트워크 우선(업데이트 즉시 반영), 실패 시 캐시
  event.respondWith(
    fetch(request).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(request))
  );
});
