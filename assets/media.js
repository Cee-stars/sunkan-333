/* Duo — 写真（カードに付ける画像）
 *
 * 画像だけは localStorage に置けない。1 枚 100KB でも 50 枚で上限に当たり、
 * **溢れた瞬間にカードや覚えた記録まで保存できなくなる**。そこで IndexedDB に分ける。
 *
 * カード側（`sunkan:cards:items`）が持つのは `img` の **id だけ**。
 * 中身（Blob）はこちらにある。この分け方のおかげで、
 * 写真が無い端末に同期しても、カードそのものは普通に使える（写真が出ないだけ）。
 *
 * 取り込むときに必ず縮めて詰める。カメラの写真は 1 枚 3〜5MB あり、
 * そのまま溜めると端末の保存領域を食い潰す。長辺 1000px・WebP で 100KB 前後になる。
 *
 * 画面は触らない。DOM を作るのは cards.js の仕事。
 */
'use strict';

(function () {

  /* ============================================================
   * 1. 定数
   * ========================================================== */

  var DB_NAME = 'duo-media';
  var DB_VERSION = 1;
  var STORE = 'images';

  /** 縮めたあとの長辺（px）。カードに出すぶんにはこれで十分 */
  var MAX_SIDE = 1000;

  /** 詰めぐあい。0.82 くらいが、見た目と大きさの折り合いがいい */
  var QUALITY = 0.82;

  /** この大きさに収まるまで品質を落として詰め直す。ざらついた写真ほど効く */
  var TARGET_BYTES = 260 * 1024;

  /** 1 枚の上限。これを超えたら、詰め直してでも入れない */
  var MAX_BYTES = 2 * 1024 * 1024;

  /* ============================================================
   * 2. 小物
   * ========================================================== */

  function str(v) { return (v === null || v === undefined) ? '' : String(v); }
  function trim(v) { return str(v).trim(); }

  function makeId() {
    return 'img-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function supported() {
    try {
      return !!(window.indexedDB && window.Blob && window.URL && window.URL.createObjectURL);
    } catch (e) { return false; }
  }

  /* ============================================================
   * 3. IndexedDB
   * ========================================================== */

  var dbPromise = null;

  function openDB() {
    if (!supported()) return Promise.reject(new Error('この端末では写真を保存できません。'));
    if (dbPromise) return dbPromise;

    dbPromise = new Promise(function (resolve, reject) {
      var req;
      try { req = window.indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { reject(e); return; }

      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('写真の保存先を開けませんでした。')); };
      // プライベートモードなどで固まる場合に備える
      req.onblocked = function () { reject(new Error('写真の保存先を開けませんでした。')); };
    });

    // 失敗を覚え込ませない（次に呼ばれたらもう一度試す）
    dbPromise.catch(function () { dbPromise = null; });
    return dbPromise;
  }

  function tx(mode, run) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var store = t.objectStore(STORE);
        var out;
        try { out = run(store); } catch (e) { reject(e); return; }
        t.oncomplete = function () {
          // run が IDBRequest を返したら、その結果を渡す。
          // **`result !== undefined` で見分けてはいけない。** 見つからなかったときの
          // result は undefined で、そのとき request そのものを返してしまう。
          // request は truthy なので、呼んだ側からは「在った」ように見える
          // （実際それで、バックアップから写真が 1 枚も戻らなかった）。
          var isRequest = out && typeof out === 'object' && 'result' in out;
          resolve(isRequest ? out.result : out);
        };
        t.onerror = function () { reject(t.error || new Error('写真を読み書きできませんでした。')); };
        t.onabort = function () { reject(t.error || new Error('写真の読み書きが中断されました。')); };
      });
    });
  }

  function getRecord(id) {
    if (!trim(id)) return Promise.resolve(null);
    return tx('readonly', function (store) { return store.get(trim(id)); })
      .then(function (rec) { return rec || null; })
      .catch(function () { return null; });   // 読めないだけならカードは出す
  }

  /* ============================================================
   * 4. 縮めて詰める
   * ========================================================== */

  /**
   * ファイルを絵にする。
   * `createImageBitmap` を先に試すのは、**iPhone の写真は向きが EXIF に入っていて**、
   * `<img>` 経由で canvas に描くと横倒しになることがあるため。
   */
  function toImage(file) {
    if (window.createImageBitmap) {
      try {
        return window.createImageBitmap(file, { imageOrientation: 'from-image' })
          .catch(function () { return viaImgTag(file); });
      } catch (e) { /* 古い実装は options を受け付けない */ }
    }
    return viaImgTag(file);
  }

  function viaImgTag(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('画像として読めませんでした。'));
      };
      img.src = url;
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve) {
      if (canvas.toBlob) {
        canvas.toBlob(function (blob) { resolve(blob || null); }, type, quality);
        return;
      }
      try {
        var url = canvas.toDataURL(type, quality);
        resolve(dataURLToBlob(url));
      } catch (e) { resolve(null); }
    });
  }

  /**
   * 長辺 MAX_SIDE に縮めて詰める。
   * WebP が作れない端末（古い Safari）では JPEG に落ちる。
   */
  function shrink(file) {
    return toImage(file).then(function (img) {
      var w = img.naturalWidth || img.width;
      var h = img.naturalHeight || img.height;
      if (!w || !h) throw new Error('画像の大きさが取れませんでした。');

      var scale = Math.min(1, MAX_SIDE / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * scale));
      var ch = Math.max(1, Math.round(h * scale));

      var canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, cw, ch);
      if (img.close) { try { img.close(); } catch (e) { /* ImageBitmap だけ */ } }

      /**
       * まだ大きいようなら、品質を落としてもう一度詰める。
       * ざらついた写真は同じ品質でも何倍にもなるので、**枚数が増えたときに効く**。
       * 3 回試してもだめなら諦めてそのまま返す（入らないよりはまし）。
       */
      function pack(type, quality, tries) {
        return canvasToBlob(canvas, type, quality).then(function (blob) {
          if (!blob) return null;
          if (blob.size <= TARGET_BYTES || tries <= 1 || quality <= 0.4) return blob;
          return pack(type, Math.max(0.4, quality - 0.18), tries - 1).then(function (next) {
            return (next && next.size < blob.size) ? next : blob;
          });
        });
      }

      return pack('image/webp', QUALITY, 3).then(function (blob) {
        // WebP を作れない端末では null か、素通しの PNG が返る
        if (blob && blob.type === 'image/webp') return { blob: blob, w: cw, h: ch };
        return pack('image/jpeg', QUALITY, 3).then(function (jpeg) {
          if (!jpeg) throw new Error('画像を詰められませんでした。');
          return { blob: jpeg, w: cw, h: ch };
        });
      });
    });
  }

  /* ============================================================
   * 5. 出し入れ
   * ========================================================== */

  /**
   * 写真を 1 枚しまう。縮めるのはここでやる。
   * @returns {Promise<{id:string, w:number, h:number, bytes:number}>}
   */
  function add(file) {
    if (!file) return Promise.reject(new Error('ファイルがありません。'));
    if (!/^image\//.test(str(file.type)) && !/\.(jpe?g|png|gif|webp|heic|heif)$/i.test(str(file.name))) {
      return Promise.reject(new Error('画像ではないようです。'));
    }
    return shrink(file).then(function (small) {
      if (small.blob.size > MAX_BYTES) throw new Error('写真が大きすぎます。');
      var rec = {
        id: makeId(),
        blob: small.blob,
        w: small.w,
        h: small.h,
        type: small.blob.type,
        bytes: small.blob.size,
        created: Date.now()
      };
      return tx('readwrite', function (store) { store.put(rec); })
        .then(function () { return { id: rec.id, w: rec.w, h: rec.h, bytes: rec.bytes }; });
    });
  }

  /** しまってある写真を消す */
  function remove(id) {
    if (!trim(id)) return Promise.resolve(false);
    dropURL(id);
    return tx('readwrite', function (store) { store.delete(trim(id)); })
      .then(function () { return true; })
      .catch(function () { return false; });
  }

  /* --- 表示用の URL は作り直さず取り回す --- */

  var urlCache = {};

  function urlFor(id) {
    var key = trim(id);
    if (!key) return Promise.resolve('');
    if (urlCache[key]) return Promise.resolve(urlCache[key]);

    return getRecord(key).then(function (rec) {
      if (!rec || !rec.blob) return '';
      try {
        urlCache[key] = URL.createObjectURL(rec.blob);
        return urlCache[key];
      } catch (e) { return ''; }
    });
  }

  function dropURL(id) {
    var key = trim(id);
    if (!urlCache[key]) return;
    try { URL.revokeObjectURL(urlCache[key]); } catch (e) { /* 無視 */ }
    delete urlCache[key];
  }

  /* ============================================================
   * 6. 持ち出し（バックアップ）
   * ========================================================== */

  function blobToDataURL(blob) {
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onload = function () { resolve(str(reader.result)); };
      reader.onerror = function () { resolve(''); };
      reader.readAsDataURL(blob);
    });
  }

  function dataURLToBlob(url) {
    var hit = str(url).match(/^data:([^;,]+)?(;base64)?,(.*)$/);
    if (!hit) return null;
    var type = hit[1] || 'application/octet-stream';
    try {
      if (hit[2]) {
        var bin = window.atob(hit[3]);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: type });
      }
      return new Blob([decodeURIComponent(hit[3])], { type: type });
    } catch (e) { return null; }
  }

  /**
   * ぜんぶを data URL にして返す。バックアップに載せるため。
   * @returns {Promise<Object>} `{ id: 'data:image/webp;base64,...' }`
   */
  function dump() {
    if (!supported()) return Promise.resolve({});
    return tx('readonly', function (store) { return store.getAll ? store.getAll() : null; })
      .then(function (list) {
        if (!list || !list.length) return {};
        var out = {};
        var chain = Promise.resolve();
        list.forEach(function (rec) {
          if (!rec || !rec.blob) return;
          chain = chain.then(function () {
            return blobToDataURL(rec.blob).then(function (url) {
              if (url) out[rec.id] = url;
            });
          });
        });
        return chain.then(function () { return out; });
      })
      .catch(function () { return {}; });
  }

  /**
   * バックアップから戻す。**すでにある id は上書きしない**
   * （手元のほうが新しいこともあるので、足りないぶんだけ入れる）。
   * @returns {Promise<number>} 入れた枚数
   */
  function restore(bag) {
    if (!supported() || !bag || typeof bag !== 'object') return Promise.resolve(0);

    var ids = [];
    for (var id in bag) {
      if (Object.prototype.hasOwnProperty.call(bag, id) && trim(bag[id])) ids.push(id);
    }
    if (!ids.length) return Promise.resolve(0);

    var put = 0;
    var chain = Promise.resolve();
    ids.forEach(function (key) {
      chain = chain.then(function () {
        return getRecord(key).then(function (have) {
          if (have) return null;                       // すでにある
          var blob = dataURLToBlob(bag[key]);
          if (!blob) return null;
          return tx('readwrite', function (store) {
            store.put({
              id: key, blob: blob, w: 0, h: 0,
              type: blob.type, bytes: blob.size, created: Date.now()
            });
          }).then(function () { put++; });
        });
      }).catch(function () { /* 1 枚落ちても続ける */ });
    });
    return chain.then(function () { return put; });
  }

  /* ============================================================
   * 7. 掃除と目安
   * ========================================================== */

  /** いま何枚・何バイト使っているか */
  function usage() {
    if (!supported()) return Promise.resolve({ count: 0, bytes: 0 });
    return tx('readonly', function (store) { return store.getAll ? store.getAll() : null; })
      .then(function (list) {
        if (!list) return { count: 0, bytes: 0 };
        var bytes = 0;
        for (var i = 0; i < list.length; i++) bytes += Number(list[i].bytes) || 0;
        return { count: list.length, bytes: bytes };
      })
      .catch(function () { return { count: 0, bytes: 0 }; });
  }

  /**
   * どのカードからも指されていない写真を捨てる。
   * カードを消したときに取りこぼしても、ここで拾える。
   * @param {string[]} keepIds まだ使っている id
   */
  function sweep(keepIds) {
    if (!supported()) return Promise.resolve(0);
    var keep = {};
    for (var i = 0; i < (keepIds || []).length; i++) keep[trim(keepIds[i])] = true;

    return tx('readonly', function (store) { return store.getAll ? store.getAll() : null; })
      .then(function (list) {
        if (!list || !list.length) return 0;
        var gone = 0;
        var chain = Promise.resolve();
        list.forEach(function (rec) {
          if (!rec || keep[rec.id]) return;
          chain = chain.then(function () {
            return remove(rec.id).then(function () { gone++; });
          });
        });
        return chain.then(function () { return gone; });
      })
      .catch(function () { return 0; });
  }

  /** 「120 KB」「2.4 MB」 */
  function humanBytes(n) {
    var b = Number(n) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return Math.round(b / 1024) + ' KB';
    return (Math.round(b / 1024 / 1024 * 10) / 10) + ' MB';
  }

  /* ============================================================
   * 8. 外に出す口
   * ========================================================== */

  window.SUNKAN_MEDIA = {
    /** この端末で写真を扱えるか */
    supported: supported,
    /** 写真を 1 枚しまう（縮めるのはこの中）。{id, w, h, bytes} */
    add: add,
    /** しまってある写真を消す */
    remove: remove,
    /** 表示用の URL。無ければ空文字 */
    url: urlFor,
    /** 表示用の URL を捨てる（消したあとに呼ぶ） */
    dropURL: dropURL,
    /** ぜんぶを data URL にして返す（バックアップ用） */
    dump: dump,
    /** バックアップから戻す。足りないぶんだけ入れる */
    restore: restore,
    /** いま何枚・何バイト使っているか */
    usage: usage,
    /** 使われていない写真を捨てる */
    sweep: sweep,
    humanBytes: humanBytes
  };

})();
