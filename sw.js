/* 瞬間英作文 — オフライン用の最小サービスワーカー
   方針: アプリ本体は cache-first（電波が無くても開ける）、
         更新は裏で取り直して次回起動時に反映する stale-while-revalidate。 */
'use strict';

var CACHE = 'sunkan-v1';

var ASSETS = [
  './',
  './index.html',
  './assets/style.css',
  './assets/app.js',
  './assets/data.js',
  './assets/icon.svg',
  './manifest.webmanifest'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // 1 つでも失敗するとインストール全体が落ちるので個別に握りつぶす
      return Promise.all(ASSETS.map(function (url) {
        return cache.add(url).catch(function () { return null; });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        return key === CACHE ? null : caches.delete(key);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;

  // GET 以外と別オリジンには触らない
  if (req.method !== 'GET') { return; }
  if (new URL(req.url).origin !== self.location.origin) { return; }

  event.respondWith(
    caches.match(req).then(function (cached) {
      var network = fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () {
        // オフライン。ページ遷移なら index.html を返す
        if (req.mode === 'navigate') { return caches.match('./index.html'); }
        return cached;
      });

      return cached || network;
    })
  );
});
