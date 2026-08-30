/* 瞬間英作文 — 版ずれの検知と、確実に新しくする道
 *
 * 画面が古いままだと「直したはずの不具合がまだある」「入れたはずの機能が無い」に
 * 見える。原因が版ずれなのか作りの問題なのかを利用者に推測させないため、
 * ここで**動いている版**と**公開されている版**を突き合わせて、違えば知らせる。
 *
 * 突き合わせ先は version.json。ブラウザにもサービスワーカーにも溜めさせない
 * （cache: 'no-store'）ので、古い答えを見て「最新です」と言うことはない。
 *
 * 「更新する」はサービスワーカーとキャッシュを捨ててから読み直す。ふつうの
 * 再読み込みで直らない状態（古い一式が居座る）を、押すだけで抜けられるようにする。
 */
(function () {
  'use strict';

  var VERSION_URL = 'version.json';
  var CHECK_MIN_GAP = 60 * 1000;   // 開くたびに叩かない
  var TIMEOUT_MS = 8000;

  var elBar = document.getElementById('update-bar');
  var elText = document.getElementById('update-text');
  var elGo = document.getElementById('btn-update-now');
  var elLater = document.getElementById('btn-update-later');

  var lastCheck = 0;
  var dismissed = '';   // 「あとで」と言われた版
  var latest = '';

  function trim(v) { return (v === null || v === undefined ? '' : String(v)).replace(/^\s+|\s+$/g, ''); }

  /**
   * いま動いている版。
   * 見るのは **index.html 自身の版**（meta[name=sunkan-build]）。
   * app.js の中の数字を見ていたせいで、index.html だけが古いまま
   * （本体は新しい）のときに「最新です」と言ってしまい、
   * 画面に何も新しいものが無いのに帯も出ない、という状態を作っていた。
   */
  function running() {
    var m = document.querySelector('meta[name="sunkan-build"]');
    var page = m ? trim(m.getAttribute('content')) : '';
    if (page) return page;
    var el = document.getElementById('app-version');   // 古い版には meta が無い
    return el ? trim(el.textContent) : '';
  }

  /** index.html と app.js の版が食い違っていないか（途中まで新しくなっている） */
  function halfUpdated() {
    var el = document.getElementById('app-version');
    if (!el) return '';
    var app = trim(el.getAttribute('data-app-build'));
    var page = trim(el.getAttribute('data-page-build'));
    if (!app || !page) return '';
    return app === page ? '' : page;
  }

  function withTimeout(p) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var t = window.setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error('時間内に返事がありませんでした'));
      }, TIMEOUT_MS);
      p.then(function (v) {
        if (done) return;
        done = true; window.clearTimeout(t); resolve(v);
      }, function (e) {
        if (done) return;
        done = true; window.clearTimeout(t); reject(e);
      });
    });
  }

  /** 公開されている版を、どこにも溜めずに読む */
  function fetchLatest() {
    if (typeof window.fetch !== 'function') return Promise.reject(new Error('fetch がありません'));
    var url = VERSION_URL + '?t=' + Date.now();   // 途中の中継にも溜めさせない
    return withTimeout(window.fetch(url, { cache: 'no-store' })).then(function (res) {
      if (!res || !res.ok) throw new Error('版を読めませんでした');
      return res.json();
    }).then(function (data) {
      var b = trim(data && data.build);
      if (!b) throw new Error('版が空でした');
      return b;
    });
  }

  function show(text) {
    if (!elBar || !elText) return;
    elText.textContent = text;
    elBar.hidden = false;
  }

  function hide() {
    if (elBar) elBar.hidden = true;
  }

  function check() {
    var now = Date.now();
    if (now - lastCheck < CHECK_MIN_GAP) return;
    lastCheck = now;

    var mine = running();
    if (!mine || mine === '-') return;   // まだ出ていない

    // 相手に聞くまでもなく、手元だけで分かる食い違い
    var half = halfUpdated();
    if (half) {
      latest = 'mixed';
      if (dismissed !== 'mixed') {
        show('画面の一部が古いままです（ページは ' + half + '）。「更新する」で揃います。');
      }
      return;
    }

    fetchLatest().then(function (theirs) {
      latest = theirs;
      if (theirs === mine) { hide(); return; }
      if (theirs === dismissed) return;   // 同じ版を何度も催促しない
      show('新しい版があります（' + theirs + '）。いまは ' + mine + ' で動いています。');
    }, function () {
      // 読めないのは電波が無いときにも起きる。黙って見送る
      // （ここで警告を出すと、オフラインのたびに邪魔になる）
    });
  }

  /** 溜まっているものを全部捨ててから読み直す */
  function forceUpdate() {
    if (elGo) { elGo.disabled = true; }
    if (elText) { elText.textContent = '新しくしています…'; }

    var jobs = [];

    if (window.caches && typeof window.caches.keys === 'function') {
      jobs.push(window.caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (k) { return window.caches.delete(k); }));
      }).catch(function () { return null; }));
    }

    if (navigator.serviceWorker && typeof navigator.serviceWorker.getRegistrations === 'function') {
      jobs.push(navigator.serviceWorker.getRegistrations().then(function (regs) {
        return Promise.all(regs.map(function (r) { return r.unregister(); }));
      }).catch(function () { return null; }));
    }

    Promise.all(jobs).then(function () {
      // ？を足して、ブラウザ自身が溜めている一式も避けて取りに行かせる
      var base = window.location.href.split('#')[0].split('?')[0];
      window.location.replace(base + '?v=' + Date.now());
    }, function () {
      window.location.reload();
    });
  }

  function init() {
    if (elGo) elGo.addEventListener('click', forceUpdate);
    if (elLater) {
      elLater.addEventListener('click', function () {
        dismissed = latest;
        hide();
      });
    }

    // 開いたとき・表に戻ったときに見る。裏では見ない
    window.setTimeout(check, 1500);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) check();
    });
    window.addEventListener('focus', check);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.SUNKAN_UPDATE = {
    /** いま公開されている版を見に行き、違えば帯を出す */
    check: function () { lastCheck = 0; check(); },
    /** 溜まっているものを捨てて読み直す（設定の「最新にする」から） */
    force: forceUpdate,
    /** 動いている版 */
    running: running
  };
})();
