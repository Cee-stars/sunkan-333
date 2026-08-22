/* 瞬間英作文 — オフライン用の最小サービスワーカー
   方針: 同一オリジンの GET はネットワーク優先。つながるときは必ず最新を出し、
         失敗したときだけキャッシュに逃がす（電波が無くても開ける）。 */
'use strict';

// 名前を変えると activate で古いキャッシュを丸ごと捨てられる。
// 配信方法を変えたときは必ず上げること。
var CACHE = 'sunkan-v7';

var ASSETS = [
  './',
  './index.html',
  './assets/style.css',
  './assets/app.js',
  './assets/data.js',
  './assets/paraphrase.js',
  './assets/inbox.js',
  './assets/sync.js',
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

  // ネットワーク優先。つながるときは必ず最新を出し、
  // 落ちたときだけキャッシュに逃がす。
  //
  // 以前はキャッシュ優先にしていたが、それだと更新を出しても
  // 古い一式が返り続けて「何も変わらない」状態になる。
  // オフライン対応より、更新が確実に届くことを優先する。
  event.respondWith(
    fetch(req).then(function (res) {
      if (res && res.status === 200 && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (cached) {
        if (cached) { return cached; }
        // オフラインでのページ遷移は index.html に逃がす
        if (req.mode === 'navigate') { return caches.match('./index.html'); }
        return Response.error();
      });
    })
  );
});
