/*!
 * 瞬間英作文 — 受信箱（同じドメインの別アプリから届いたカードを取り込む）
 *
 * My Dictionary（別リポジトリの単一 HTML）と瞬間英作文は、同じ GitHub Pages の
 * ドメインにパス違いで置かれる。localStorage はオリジン単位なので、
 * 両方から同じキーが読み書きできる。そこを 1 本の受け渡し場所として使う。
 *
 * 送り手は shunkan:inbox に足すだけ。取り込みと後始末はここだけが行う。
 * app.js / paraphrase.js の中身には触らず、window.SUNKAN_DRILL 越しに足す。
 * 取り決めは CONTRACT.md を参照。
 */
(function () {
  'use strict';

  /* ============================================================
   * 1. 定数
   * ========================================================== */

  var LS_INBOX = 'sunkan:inbox';   // 送り手も読み手もこのキーだけを見る

  var HASH_PARAM = 'inbox'; // localStorage が分かれている端末は URL で受け取る

  var MAX_PENDING = 500;    // 取り込まないまま溜まり続けないよう頭を打つ
  var MAX_TEXT = 400;       // 1 文としてありえない長さは弾く
  var FLASH_MS = 5000;      // 取り込み結果を出しておく時間
  var DEFAULT_SOURCE = 'My Dictionary';

  /* ============================================================
   * 2. 小さなユーティリティ
   * ========================================================== */

  function $(id) { return document.getElementById(id); }

  function str(v) {
    if (v === null || v === undefined) return '';
    return typeof v === 'string' ? v : String(v);
  }

  /** 前後の空白と BOM を落とす。1 文として扱うので途中の改行も空白に潰す */
  function trim(v) {
    return str(v).replace(/[\s\uFEFF]+/g, ' ').replace(/^ | $/g, '');
  }

  function lsGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }

  function lsSet(key, value) {
    try { window.localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }

  function lsRemove(key) {
    try { window.localStorage.removeItem(key); return true; } catch (e) { return false; }
  }

  /* ============================================================
   * 3. 受信箱の読み書き（中身は他アプリが書くので一切信用しない）
   * ========================================================== */

  /** 保存されている生の配列。壊れていれば空配列 */
  function readRaw() {
    var text = lsGet(LS_INBOX);
    if (!text) return [];
    var list;
    try { list = JSON.parse(text); } catch (e) { return []; }
    return Object.prototype.toString.call(list) === '[object Array]' ? list : [];
  }

  function writeRaw(list) {
    if (!list.length) return lsRemove(LS_INBOX);
    if (list.length > MAX_PENDING) list = list.slice(list.length - MAX_PENDING);
    return lsSet(LS_INBOX, JSON.stringify(list));
  }

  /**
   * 1 件を {ja,en,pattern,source} に均す。
   * 日本語と英文が揃っていないものは出題できないので null（＝捨てる）。
   */
  function sanitize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var ja = trim(raw.ja), en = trim(raw.en);
    if (!ja || !en) return null;
    if (ja.length > MAX_TEXT || en.length > MAX_TEXT) return null;
    return {
      ja: ja,
      en: en,
      pattern: trim(raw.pattern).slice(0, MAX_TEXT),
      source: trim(raw.source).slice(0, 60) || DEFAULT_SOURCE
    };
  }

  /**
   * 後始末で「取り込んだのはどれか」を照合するための鍵。
   * id があればそれ、無ければ中身から作る（送り手が id を付けなくても動く）。
   */
  function keyOf(raw) {
    if (!raw || typeof raw !== 'object') return '';
    var id = trim(raw.id);
    if (id) return 'id\n' + id;
    return 'c\n' + trim(raw.source) + '\n' + trim(raw.en) + '\n' + trim(raw.ja);
  }

  /** 取り込める形のものだけを、鍵付きで返す */
  function readPending() {
    var raw = readRaw(), out = [], i, item;
    for (i = 0; i < raw.length; i++) {
      item = sanitize(raw[i]);
      if (!item) continue;
      item.key = keyOf(raw[i]);
      out.push(item);
    }
    return out;
  }

  /**
   * 取り込んだぶんを受信箱から抜く。
   * 読んでから抜くまでの間に足された分は残したいので、書き戻す直前に読み直す。
   * 出題できない壊れた行も、ここでまとめて落とす。
   */
  function consume(taken) {
    var done = {}, i;
    for (i = 0; i < taken.length; i++) done[taken[i].key] = true;

    var raw = readRaw(), rest = [];
    for (i = 0; i < raw.length; i++) {
      if (done[keyOf(raw[i])]) continue;
      if (!sanitize(raw[i])) continue;
      rest.push(raw[i]);
    }
    writeRaw(rest);
  }

  /* ============================================================
   * 3.5 URL で届いたぶん
   *
   * iOS ではホーム画面に追加したアプリとブラウザで保存領域が分かれる。
   * 片方から書いた localStorage をもう片方は読めないので、
   * それだけを頼りにすると「送ったのに何も出てこない」ことになる。
   * URL に載せて渡す道なら、どちらの箱から開いても必ず届く。
   * ========================================================== */

  /** base64url を UTF-8 の文字列に戻す */
  function fromBase64Url(text) {
    var b64 = String(text).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var bin = window.atob(b64);
    var bytes = new Uint8Array(bin.length), i;
    for (i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /** URL に載っていたカードの配列。読めなければ空 */
  function decodePayload(text) {
    var list;
    try {
      list = JSON.parse(fromBase64Url(text));
    } catch (e) {
      return [];   // 途中で切れた URL などは黙って捨てる
    }
    if (Object.prototype.toString.call(list) !== '[object Array]') return [];
    var out = [], i;
    for (i = 0; i < list.length && out.length < MAX_PENDING; i++) {
      if (sanitize(list[i])) out.push(list[i]);   // 生のまま入れる（id を残すため）
    }
    return out;
  }

  /** 読んだあとの URL は消す。再読み込みで二重に入るのを防ぐ */
  function clearHash() {
    try {
      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
        return;
      }
    } catch (e) { /* 古いブラウザでは下に落とす */ }
    window.location.hash = '';
  }

  /** #inbox=… で届いたぶんを受信箱へ移す */
  function drainHash() {
    var m = String(window.location.hash || '').match(/[#&]inbox=([^&]+)/);
    if (!m) return;
    clearHash();
    var list = decodePayload(m[1]);
    if (!list.length) return;
    writeRaw(readRaw().concat(list));
  }

  /* ============================================================
   * 4. 画面
   * ========================================================== */

  var elBar = $('inbox-bar');
  var elText = $('inbox-text');
  var elActions = $('inbox-actions');
  var elTake = $('btn-inbox-take');
  var elLater = $('btn-inbox-later');
  var elTabDrill = $('tab-drill');

  var state = {
    dismissed: '',    // 「あとで」で見送った中身の指紋
    flashTimer: null
  };

  /** いま届いているものの指紋。中身が変われば「あとで」は解ける */
  function signature(pending) {
    var keys = [], i;
    for (i = 0; i < pending.length; i++) keys.push(pending[i].key);
    return keys.sort().join(' ');
  }

  function hide() {
    if (elBar) elBar.hidden = true;
  }

  function clearFlash() {
    if (!state.flashTimer) return;
    window.clearTimeout(state.flashTimer);
    state.flashTimer = null;
  }

  /** 取り込み結果などを帯に出す。そのあとは通常の表示に戻す */
  function flash(msg) {
    if (!elBar || !elText) return;
    clearFlash();
    elText.textContent = msg;
    elBar.hidden = false;
    if (elActions) elActions.hidden = true;
    state.flashTimer = window.setTimeout(function () {
      state.flashTimer = null;
      refresh();
    }, FLASH_MS);
  }

  function pendingLabel(pending) {
    var names = [], i;
    for (i = 0; i < pending.length; i++) {
      if (names.indexOf(pending[i].source) < 0) names.push(pending[i].source);
    }
    var from = names.length === 1 ? '「' + names[0] + '」' : 'ほかのアプリ';
    return from + 'から ' + pending.length + ' 件届いています。';
  }

  /** 受信箱を見て帯を出し入れする */
  function refresh() {
    if (!elBar || !elText) return;
    if (state.flashTimer) return;   // 結果を出している間は上書きしない

    var pending = readPending();
    if (!pending.length) { state.dismissed = ''; hide(); return; }

    var sig = signature(pending);
    if (sig === state.dismissed) { hide(); return; }

    elText.textContent = pendingLabel(pending);
    if (elActions) elActions.hidden = false;
    elBar.hidden = false;
  }

  /* ============================================================
   * 5. 取り込み
   * ========================================================== */

  /** app.js が開けている口。読み込まれていなければ null */
  function drillAPI() {
    var api = window.SUNKAN_DRILL;
    return (api && typeof api.addSentences === 'function') ? api : null;
  }

  /** パラフレ帳を開いている最中に取り込んだら、表のほうへ連れて行く */
  function showDrill() {
    if (document.documentElement.getAttribute('data-mode') === 'drill') return;
    if (elTabDrill) elTabDrill.click();
  }

  function takeAll() {
    var pending = readPending();
    if (!pending.length) { hide(); return; }

    var api = drillAPI();
    if (!api) {
      flash('瞬間英作文側が読み込めていないので取り込めませんでした。');
      return;
    }

    // 送り元ごとにセットを分ける。セット名はそのまま送り元の名前になる。
    var groups = {}, order = [], i, key;
    for (i = 0; i < pending.length; i++) {
      key = pending[i].source;
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push({ ja: pending[i].ja, en: pending[i].en, note: pending[i].pattern });
    }

    var added = 0, skipped = 0, names = [], res;
    for (i = 0; i < order.length; i++) {
      res = api.addSentences(order[i], groups[order[i]]);
      added += res.added;
      skipped += res.skipped;
      if (names.indexOf(res.deckName) < 0) names.push(res.deckName);
    }

    consume(pending);
    showDrill();

    var msg;
    if (!added) {
      msg = '同じ文がすでにあったので、' + skipped + ' 件とも省きました。';
    } else {
      msg = names.length === 1
        ? '「' + names[0] + '」に ' + added + ' 文取り込みました。'
        : added + ' 文を ' + names.length + ' つのセットに取り込みました。';
      if (skipped) msg += '（' + skipped + ' 件は同じ文があったので省きました）';
    }
    flash(msg);
  }

  function dismiss() {
    clearFlash();
    state.dismissed = signature(readPending());
    hide();
  }

  /* ============================================================
   * 6. 起動
   * ========================================================== */

  function bindEvents() {
    if (elTake) elTake.addEventListener('click', takeAll);
    if (elLater) elLater.addEventListener('click', dismiss);

    // 別タブ（＝ My Dictionary）で送られた分をその場で拾う。
    // 同じタブでの書き込みでは飛ばないが、送り手は別ページなので問題ない。
    window.addEventListener('storage', function (e) {
      if (e.key && e.key !== LS_INBOX) return;
      clearFlash();
      refresh();
    });

    // 送ってから戻ってきたとき（同じタブ・ホーム画面のアプリ間）に拾う
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refresh();
    });
    window.addEventListener('pageshow', function () { drainHash(); refresh(); });

    // 同じページのまま #inbox=… が付いたときも拾う
    window.addEventListener('hashchange', function () { drainHash(); refresh(); });
  }

  /**
   * 外から受信箱へ足す（sync.js が「貼り付けて受け取る」で使う）。
   * ホーム画面から開いたアプリにはアドレス欄が無く、リンクを開かせられない。
   * その端末へ届ける唯一の道が貼り付けなので、ここを開けてある。
   * 足せた件数を返す。
   */
  function addFromOutside(list) {
    if (Object.prototype.toString.call(list) !== '[object Array]') return 0;
    var raw = readRaw(), added = 0, i;
    for (i = 0; i < list.length; i++) {
      if (!sanitize(list[i])) continue;   // 出題できないものは受け取らない
      raw.push(list[i]);
      added++;
    }
    if (!added) return 0;
    writeRaw(raw);
    state.dismissed = '';   // 「あとで」で畳んでいても、新しく届いたので出す
    clearFlash();
    refresh();
    return added;
  }

  window.SUNKAN_INBOX = {
    add: addFromOutside,
    refresh: refresh
  };

  function init() {
    if (!elBar) return;   // DOM が想定と違うときは何もしない
    drainHash();          // URL で届いたぶんを先に受信箱へ入れてから見る
    bindEvents();
    refresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
