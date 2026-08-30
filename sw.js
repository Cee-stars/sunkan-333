/* 瞬間英作文 — オフライン用の最小サービスワーカー
   方針: 同一オリジンの GET はネットワーク優先。つながるときは必ず最新を出し、
         失敗したときだけキャッシュに逃がす（電波が無くても開ける）。 */
'use strict';

// 名前を変えると activate で古いキャッシュを丸ごと捨てられる。
// 配信方法を変えたときは必ず上げること。
var CACHE = 'sunkan-v28';

var ASSETS = [
  './',
  './index.html',
  './assets/style.css',
  './assets/app.js',
  './assets/speech.js',
  './assets/data.js',
  './assets/paraphrase.js',
  './assets/inbox.js',
  './assets/sync.js',
  './assets/update.js',
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
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) { return; }

  // 版の突き合わせ先には触らない。ここを溜めると、古い答えを見て
  // 「最新です」と言ってしまい、版ずれを知らせる仕組みごと死ぬ。
  if (url.pathname.indexOf('version.json') >= 0) { return; }

  // ネットワーク優先。つながるときは必ず最新を出し、
  // 落ちたときだけキャッシュに逃がす。
  //
  // 以前はキャッシュ優先にしていたが、それだと更新を出しても
  // 古い一式が返り続けて「何も変わらない」状態になる。
  // オフライン対応より、更新が確実に届くことを優先する。
  // ブラウザ自身のキャッシュを素通りさせない。
  // ネットワーク優先にしていても、fetch(req) はブラウザの持っている一式を
  // そのまま返すことがある。実際それで index.html だけが古いまま残り、
  // 本体（app.js）は新しい、という半端な状態になった。
  // no-cache は「毎回サーバーに確かめる」であって「毎回落とし直す」ではないので、
  // 変わっていなければ 304 で済む。
  function freshFetch(request) {
    try {
      return fetch(request, { cache: 'no-cache' });
    } catch (e) {
      return fetch(request);   // 受け付けない実装のために元の道も残す
    }
  }

  event.respondWith(
    freshFetch(req).then(function (res) {
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
