/* Instant English — 作った音をしまっておく所（IndexedDB）
 *
 * リスニングの「AI の音声」で作った音を、**同じ文につき 1 回だけ**作らせるための
 * 置き場。2 回目からはここから出すので、すぐ鳴るし、オフラインでも鳴るし、
 * 無料枠も減らない。
 *
 *  - 写真の media.js とは**別の入れ物**にしてある。あちらは画像専用（縮める処理が
 *    入っている）で、バックアップにも載る。音は作り直せるので載せない。
 *  - 鍵は「読ませた文そのもの」から作る。文を直せば鍵も変わるので、
 *    古い音が残って**直す前の文が鳴る**ことがない。
 *  - 使えない端末（プライベートモードなど）でも落ちない。supported() が偽になり、
 *    呼び出し側は端末の読み上げに戻るだけ。
 */
(function () {
  'use strict';

  var DB_NAME = 'duo-audio';
  var DB_VERSION = 1;
  var STORE = 'clips';

  var MAX_BYTES = 2 * 1024 * 1024;   // 1 つぶんの上限。これを超えるのは作り方がおかしい

  var supported = !!(window.indexedDB && window.Blob);
  var dbPromise = null;
  var urls = {};   // 鍵 → object URL（作りっぱなしにしないよう覚えておく）

  function str(v) { return v === null || v === undefined ? '' : String(v); }

  function open() {
    if (!supported) return Promise.reject(new Error('この端末では音をしまえません。'));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req;
      try { req = window.indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('音の置き場を開けませんでした。')); };
    });
    return dbPromise;
  }

  function tx(mode, run) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t, store, out;
        try {
          t = db.transaction(STORE, mode);
          store = t.objectStore(STORE);
        } catch (e) { reject(e); return; }
        out = run(store);
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error || new Error('音の出し入れに失敗しました。')); };
        t.onabort = function () { reject(t.error || new Error('音の出し入れが止まりました。')); };
      });
    });
  }

  /**
   * 文から鍵を作る。**声と速さが変われば別の音**なので、それも混ぜる。
   * 中身そのものは入れない（鍵が長くなるだけ）。
   */
  function keyFor(text, tag) {
    var src = str(tag) + '\n' + str(text).replace(/\s+/g, ' ').trim();
    var h1 = 5381, h2 = 52711, i;
    for (i = 0; i < src.length; i++) {
      h1 = ((h1 << 5) + h1 + src.charCodeAt(i)) | 0;
      h2 = ((h2 << 5) + h2 + src.charCodeAt(src.length - 1 - i)) | 0;
    }
    return (h1 >>> 0).toString(36) + '-' + (h2 >>> 0).toString(36) + '-' + src.length;
  }

  /** しまう。入れ替えもこれ（同じ鍵なら上書き） */
  function put(key, blob) {
    if (!supported) return Promise.reject(new Error('この端末では音をしまえません。'));
    if (!key || !blob) return Promise.reject(new Error('しまうものがありません。'));
    if (blob.size > MAX_BYTES) return Promise.reject(new Error('音が大きすぎます。'));
    dropURL(key);
    var rec = {
      key: str(key),
      blob: blob,
      type: str(blob.type) || 'audio/mpeg',
      bytes: blob.size,
      created: Date.now()
    };
    return tx('readwrite', function (store) { store.put(rec); })
      .then(function () { return { key: rec.key, bytes: rec.bytes }; });
  }

  /** 取り出す。無ければ null（失敗ではない） */
  function get(key) {
    if (!supported || !key) return Promise.resolve(null);
    return tx('readonly', function (store) { return store.get(str(key)); })
      .then(function (rec) { return rec && rec.blob ? rec : null; })
      .catch(function () { return null; });
  }

  /** 鳴らすための URL。無ければ空文字。**同じ鍵なら同じ URL を使い回す** */
  function urlFor(key) {
    if (!supported || !key) return Promise.resolve('');
    if (urls[key]) return Promise.resolve(urls[key]);
    return get(key).then(function (rec) {
      if (!rec) return '';
      try { urls[key] = window.URL.createObjectURL(rec.blob); } catch (e) { return ''; }
      return urls[key];
    });
  }

  function dropURL(key) {
    if (!key || !urls[key]) return;
    try { window.URL.revokeObjectURL(urls[key]); } catch (e) { /* もう無いだけ */ }
    delete urls[key];
  }

  function remove(key) {
    if (!supported || !key) return Promise.resolve();
    dropURL(key);
    return tx('readwrite', function (store) { store.delete(str(key)); }).catch(function () { });
  }

  /** いま何個・何バイト使っているか（設定に出す） */
  function usage() {
    if (!supported) return Promise.resolve({ count: 0, bytes: 0 });
    return tx('readonly', function (store) { return store.getAll(); })
      .then(function (list) {
        var n = 0, i;
        list = list || [];
        for (i = 0; i < list.length; i++) n += Number(list[i].bytes) || 0;
        return { count: list.length, bytes: n };
      })
      .catch(function () { return { count: 0, bytes: 0 }; });
  }

  /** ぜんぶ捨てる。作り直せるものなので、容量に困ったら消してよい */
  function clear() {
    if (!supported) return Promise.resolve();
    var k;
    for (k in urls) { if (Object.prototype.hasOwnProperty.call(urls, k)) dropURL(k); }
    return tx('readwrite', function (store) { store.clear(); }).catch(function () { });
  }

  function humanBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + 'B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + 'KB';
    return (n / 1024 / 1024).toFixed(1) + 'MB';
  }

  window.SUNKAN_AUDIO = {
    /** この端末で音をしまえるか */
    supported: function () { return supported; },
    /** 文から鍵を作る（声や速さが変われば別の鍵になる） */
    keyFor: keyFor,
    put: put,
    get: get,
    /** 鳴らすための URL。無ければ空文字 */
    url: urlFor,
    dropURL: dropURL,
    remove: remove,
    usage: usage,
    clear: clear,
    humanBytes: humanBytes
  };

})();
