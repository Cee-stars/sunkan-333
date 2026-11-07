/* Duo — リスニング（かたまりごとに出していく）
 *
 * 英語を ` / ` で割ったかたまりの並びとしてしまい、行を押すたびに
 * **1 かたまりずつ**出す。まだ出していないぶんはぼかしてあるので、
 * 「どこまで聞き取れたか」を自分で区切りながら確かめられる。
 *
 * 行の作りは、ほかのモードと**左右が逆**。
 *   左に 🔈（その文をまるごと読み上げる）／右に英文
 * 日本語を見て英語を言う練習（瞬間英作文・場面）と向きが反対で、
 * ここでは音が先・文字が後なので、先に押すものを左に置いてある。
 *
 * 手触りは場面（phrase.js）とそろえる — 隠す / 開く / ↻ / 検索 / 現在行。
 * **段階（％）と忘却曲線は持たない。** 聞き取りは「言えたか」の自己採点と
 * 噛み合わないので、印は ↻「もう一度」だけにしてある。
 *
 * app.js / paraphrase.js / cards.js / phrase.js とは状態も保存先も共有しない。
 * 触れ合うのは <html data-mode> と window.SUNKAN_LISTEN だけ。
 *
 * DOM の定義は index.html、取り決めは CONTRACT.md を参照。
 * **要素が無くても落ちない**ように書く（画面がまだ無い版でも、
 * 読み込めるだけで害が無い）。
 */
(function () {
  'use strict';

  /* ============================================================
   * 1. 小物（phrase.js と同じものを自分で持つ。状態は共有しない）
   * ========================================================== */

  var docEl = document.documentElement;

  function $(id) { return document.getElementById(id); }

  function str(v) {
    if (v === null || v === undefined) return '';
    return typeof v === 'string' ? v : String(v);
  }

  /** 前後の空白と BOM を落とす（取り込んだ文には BOM が付いてくることがある） */
  function trim(v) {
    return str(v).replace(/^[﻿\s]+|\s+$/g, '');
  }

  function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
  function isObj(v) { return !!v && typeof v === 'object' && !isArr(v); }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function lsGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }

  // 保存が届かなかったときの言い分。空き容量切れ・プライベートモード・
  // 保存を禁じた設定など理由はいろいろだが、利用者にとっては同じ
  //「足したはずのものが読み込み直すと消える」なので、まとめて知らせる。
  var STORAGE_MSG = 'この端末に保存できませんでした（空き容量が足りないか、保存が禁じられています）。'
    + '読み込み直すと元に戻ります。';
  var storageNoticeTimer = null;

  /** 黙って落とさない。1 つの操作で複数のキーを書くので、同じ回のぶんは 1 度にまとめる。
      成功のしらせを上書きできるよう、その操作が済んだあとに回す。 */
  function flagStorageProblem() {
    if (storageNoticeTimer) return;
    storageNoticeTimer = window.setTimeout(function () {
      storageNoticeTimer = null;
      // ダイアログが開いていると知らせの行は見えない。開いている所へ出す
      if (elEditDialog && elEditDialog.open) setEditStatus(STORAGE_MSG, true);
      else flashStatus(STORAGE_MSG);
    }, 0);
  }

  function lsSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (e) {
      flagStorageProblem();
      return false;
    }
  }

  function readJSON(key) {
    var raw = lsGet(key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function writeJSON(key, value) {
    var text;
    try { text = JSON.stringify(value); } catch (e) { return false; }
    return lsSet(key, text);
  }

  /** 一意な id。phrase.js / cards.js と同じ作り（同じミリ秒に 2 件作っても当たらない） */
  function makeId(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(function () { timer = null; fn(); }, wait);
    };
  }

  /** speech.js が開けている口。読み込まれていなければ null */
  function speechPort() {
    return (window.SUNKAN_SPEECH && typeof window.SUNKAN_SPEECH.speak === 'function')
      ? window.SUNKAN_SPEECH : null;
  }

  /** 消したことを同期に覚えさせる。sync.js が無ければ何もしない。
      突き合わせが足し算だけだと、消したものが相手の端末から戻ってくる。 */
  function noteDelete(key) {
    var sync = window.SUNKAN_SYNC;
    if (sync && typeof sync.recordDelete === 'function') sync.recordDelete(key);
  }

  /** 同じものを足し直したことを覚えさせる（★を付け直したときに使う） */
  function noteAdd(key) {
    var sync = window.SUNKAN_SYNC;
    if (sync && typeof sync.clearDelete === 'function') sync.clearDelete(key);
  }

  /* ============================================================
   * 2. 定数
   * ========================================================== */

  var LS_ITEMS = 'sunkan:listen:items';
  var LS_STARS = 'sunkan:listen:stars';
  // 端末ごとの好み（検索語・速さ）。**同期しない**
  var LS_UI = 'sunkan:listen:ui';

  /** 「英語を表示したら自動で読み上げる」は瞬間英作文の設定を借りる。
   *  **読むだけで書かない**（あちらの持ち物なので、こちらから触らない）。
   *  毎回読み直すのは、設定を変えたのに読み込み直すまで効かない、を避けるため。 */
  var LS_SETTINGS = 'sunkan:settings';

  /** 選べる速さ。**既定は 0.9（少しゆっくり）** —
   *  ふつうの速さだと、かたまりが短いぶん聞き取る前に終わってしまう。 */
  var RATES = [0.75, 0.9, 1];
  var RATE_LABELS = ['0.75 倍', '0.9 倍', '1 倍'];
  var DEFAULT_RATE = 0.9;

  /** かたまりの区切り。入れた人が決めた所でだけ割る（機械で切ると、
   *  聞き取りの区切りとずれて練習にならない）。 */
  var CHUNK_SEP = '/';

  var SEARCH_DEBOUNCE = 120;   // 検索のデバウンス（ミリ秒）
  var FLASH_MS = 4000;         // 知らせを出しておく時間（ミリ秒）

  /* ============================================================
   * 3. 保存データの検証（localStorage の中身は信用しない）
   * ========================================================== */

  /** スラッシュで割って、空のかたまりを落とす。前後の空白もここで落とす */
  function chunksOf(text) {
    var raw = str(text).split(CHUNK_SEP), out = [], i, v;
    for (i = 0; i < raw.length; i++) {
      v = trim(raw[i]);
      if (v) out.push(v);
    }
    return out;
  }

  /** 読み上げに渡す文字列。**` / ` は外す**（スラッシュを読み上げさせない） */
  function speechText(chunks) {
    return isArr(chunks) ? chunks.join(' ') : '';
  }

  /** 同じ文かどうかの鍵。英語で見る（区切り方の違いは同じ文とみなす） */
  function dupKey(en) {
    return speechText(chunksOf(en)).toLowerCase();
  }

  /**
   * [{id, en, ja, note, created}] の形に均す。
   * **`en` が無いものは落とす** — 聞くものが無いので練習にならない。
   * `en` も `ja` もスラッシュ入りのまま持つ（割るのは出すときだけ）。
   */
  function sanitizeItems(raw) {
    if (!isArr(raw)) return [];
    var out = [], seen = {};
    for (var i = 0; i < raw.length; i++) {
      var it = raw[i];
      if (!isObj(it)) continue;
      var en = trim(it.en);
      if (!chunksOf(en).length) continue;
      // id が無い / ぶつかっているものには振り直す。id は★の拠り所なので、
      // 同じ id が 2 件あると片方の印がもう片方に見えてしまう。
      var id = trim(it.id);
      if (!id || seen[id]) id = makeId('listen');
      seen[id] = 1;
      out.push({
        id: id,
        en: en,
        ja: trim(it.ja),
        note: trim(it.note),
        created: Number(it.created) || 0
      });
    }
    return out;
  }

  function sanitizeStars(raw) {
    if (!isArr(raw)) return [];
    var out = [], seen = {};
    for (var i = 0; i < raw.length; i++) {
      var id = typeof raw[i] === 'string' ? raw[i] : '';
      if (!id || seen[id]) continue;
      seen[id] = 1;
      out.push(id);
    }
    return out;
  }

  /** 端末ごとの好み。検索語・速さ・AI の音声を使うか（同期しない） */
  function sanitizeUI(raw) {
    var o = isObj(raw) ? raw : {};
    var rate = Number(o.rate);
    if (RATES.indexOf(rate) < 0) rate = DEFAULT_RATE;
    return { query: trim(o.query), rate: rate, ai: o.ai === true };
  }

  /** 「英語を表示したら自動で読み上げる」が入っているか。
      入っていなければ鳴らさない（押していないのに音は出さない）。 */
  function autoSpeakOn() {
    var s = readJSON(LS_SETTINGS);
    return !!(isObj(s) && s.autoSpeak === true);
  }

  /* ============================================================
   * 4. 状態
   * ========================================================== */

  var state = {
    items: [],
    stars: [],

    query: '',          // 検索語（小文字に潰したもの）
    rate: DEFAULT_RATE, // 読み上げの速さ
    ai: false,          // AI の音声を使うか（置き場が要る）
    holdUntil: 0,       // この時刻まで、知らせを上書きさせない
    making: {},         // いま作らせている鍵。同じ文を二重に作らせない

    rows: [],           // 画面に出ている行 [{id, item, el, shown, ...}]
    byId: {},
    visibleCount: 0,
    currentId: null,    // キーボード・ポインタの現在行

    speechOK: false,
    speakingId: null,
    editingId: null,    // 直している行の id（新しく足すときは null）
    started: false,     // いちどでも画面を開いたか（開くまで行を作らない）
    flashTimer: null,
    lastFocus: null
  };

  /* ============================================================
   * 5. DOM 参照（無くても落ちない）
   * ========================================================== */

  var elView = $('listen-view');
  var elSearch = $('listen-search');
  var elToggleAll = $('listen-toggle-all');
  var elToggleAllLabel = $('listen-toggle-all-label');
  var elRateRow = $('listen-rates');
  var elAiBtn = $('btn-listen-ai');
  var elRows = $('listen-rows');
  var elRowTemplate = $('listen-row-template');
  var elEmpty = $('listen-empty');
  var elStatus = $('listen-status');
  var elAddBtn = $('btn-listen-add');
  var elAddRowBtn = $('btn-listen-add-row');

  var elEditDialog = $('listen-edit-dialog');
  var elFieldEn = $('listen-en');
  var elFieldJa = $('listen-ja');
  var elFieldNote = $('listen-note');
  var elEditStatus = $('listen-edit-status');
  var elSaveBtn = $('btn-listen-save');
  var elCloseBtn = $('btn-listen-close');
  var elDeleteBtn = $('btn-listen-delete');

  /* ============================================================
   * 6. 保存
   * ========================================================== */

  function saveItems() { return writeJSON(LS_ITEMS, state.items); }
  function saveStars() { return writeJSON(LS_STARS, state.stars); }

  function saveUI() {
    return writeJSON(LS_UI, { query: state.query, rate: state.rate, ai: state.ai });
  }

  // 1 文字打つたびに書くほどのものではないので、落ち着いてから書く
  var saveUISoon = debounce(saveUI, 400);

  function loadAll() {
    state.items = sanitizeItems(readJSON(LS_ITEMS));
    state.stars = sanitizeStars(readJSON(LS_STARS));
    var ui = sanitizeUI(readJSON(LS_UI));
    state.query = ui.query.toLowerCase();
    state.rate = ui.rate;
    state.ai = ui.ai;
  }

  /* ============================================================
   * 7. 問い合わせ（文・★）
   * ========================================================== */

  function findItem(id) {
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].id === id) return state.items[i];
    }
    return null;
  }

  function isStarred(id) {
    return state.stars.indexOf(id) >= 0;
  }

  function setStar(id, on) {
    var idx = state.stars.indexOf(id);
    if (on && idx < 0) state.stars.push(id);
    if (!on && idx >= 0) state.stars.splice(idx, 1);
    saveStars();
    // 外したことを伝えないと、同期の足し算で相手側の★が戻ってくる
    var key = 'listenstar:' + id;
    if (on) noteAdd(key); else noteDelete(key);
  }

  /* ============================================================
   * 8. 行の生成と描画
   * ========================================================== */

  /** items から行の入れ物を作る。要素はまだ作らない */
  function buildRows() {
    state.rows = [];
    state.byId = {};
    for (var i = 0; i < state.items.length; i++) {
      var it = state.items[i];
      var en = chunksOf(it.en);
      var ja = chunksOf(it.ja);
      var row = {
        id: it.id,
        item: it,
        en: en,
        ja: ja,
        // 日本語のかたまりの数が英語とそろっていれば、**かたまりごと**に出せる。
        // 数が違う・空なら、ぜんぶ出し終わったときに 1 行だけ出す。
        // どちらでも成り立つようにしてあるので、割り方で悩ませない。
        perChunk: ja.length > 0 && ja.length === en.length,
        enLower: speechText(en).toLowerCase(),
        jaLower: it.ja.toLowerCase(),
        noteLower: it.note.toLowerCase(),
        shown: 0,          // 何かたまりまで出しているか
        el: null,
        mainEl: null,
        starEl: null,
        speakEl: null,
        chunkEls: [],      // かたまりの外枠
        chunkJaEls: [],     // かたまりごとの日本語
        wholeJaEl: null     // まとめて 1 行の日本語
      };
      state.rows.push(row);
      state.byId[row.id] = row;
    }
  }

  /** テンプレートから 1 行つくる。データは必ず textContent で入れる */
  function createRowElement(row) {
    if (!elRowTemplate || !elRowTemplate.content) return null;
    var frag = elRowTemplate.content.cloneNode(true);
    var li = frag.querySelector('.row');
    if (!li) return null;
    var item = row.item;

    li.setAttribute('data-id', row.id);

    row.el = li;
    row.mainEl = li.querySelector('.row-main');
    row.starEl = li.querySelector('.row-star');
    row.speakEl = li.querySelector('.listen-speak');
    row.wholeJaEl = li.querySelector('.listen-ja');

    renderChunkElements(row, li.querySelector('.listen-chunks'));

    // メモは「どこが聞き取りにくいか」のヒント。開いた行だけ見えるように
    // するのは CSS の仕事（ほかのモードの .note と同じ扱い）。
    // 行に title は付けない（ホバーで中身が割れる）。
    var cell = li.querySelector('.listen-cell');
    if (cell && item.note) {
      var note = document.createElement('small');
      note.className = 'note';
      note.textContent = item.note;
      cell.appendChild(note);
    }

    // 読み上げが使えない端末ではボタンごと隠す（押しても鳴らないものを出さない）
    if (row.speakEl && !state.speechOK) row.speakEl.hidden = true;

    renderStar(row);
    renderShown(row);
    return li;
  }

  /** かたまりを並べる。区切りの ` / ` は飾りなので読み上げには出さない */
  function renderChunkElements(row, box) {
    row.chunkEls = [];
    row.chunkJaEls = [];
    if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);

    for (var i = 0; i < row.en.length; i++) {
      if (i > 0) {
        var sep = document.createElement('span');
        sep.className = 'listen-sep';
        sep.setAttribute('aria-hidden', 'true');
        sep.textContent = CHUNK_SEP;
        box.appendChild(sep);
      }

      var chunk = document.createElement('span');
      chunk.className = 'listen-chunk';

      var en = document.createElement('span');
      en.className = 'listen-chunk-en';
      en.textContent = row.en[i];
      chunk.appendChild(en);

      // かたまりごとの日本語。**英文の真下**に小さく出す。
      // 数がそろっていないときは使わないので、作るだけ作って畳んでおく。
      var ja = document.createElement('small');
      ja.className = 'listen-chunk-ja';
      ja.textContent = row.perChunk ? row.ja[i] : '';
      ja.hidden = true;
      chunk.appendChild(ja);

      box.appendChild(chunk);
      row.chunkEls.push(chunk);
      row.chunkJaEls.push(ja);
    }

    // まとめて 1 行の日本語（かたまりの数が合わないとき）
    if (row.wholeJaEl) {
      row.wholeJaEl.textContent = row.perChunk ? '' : row.ja.join(' ' + CHUNK_SEP + ' ');
      row.wholeJaEl.hidden = true;
    }
  }

  /**
   * いま何かたまりまで出しているかを画面に当てる。
   *
   * ・出したぶんは `.is-shown`（ぼかしを外す）
   * ・**出したばかりのかたまりだけ** `.is-fresh`（色を変えて目立たせる）
   * ・行に `.is-revealed` を付けるのは 1 つでも出したとき。
   *   ほかのモードと同じクラスなので、✎・🗑・メモの出し方をそのまま使える。
   */
  function renderShown(row) {
    if (!row || !row.el) return;
    var total = row.en.length;
    var shown = row.shown;

    for (var i = 0; i < row.chunkEls.length; i++) {
      var on = i < shown;
      var cls = row.chunkEls[i].classList;
      if (on) cls.add('is-shown'); else cls.remove('is-shown');
      if (on && i === shown - 1) cls.add('is-fresh'); else cls.remove('is-fresh');
      if (row.chunkJaEls[i]) {
        row.chunkJaEls[i].hidden = !(on && row.perChunk && row.ja[i]);
      }
    }

    // かたまりの数が合わないときの 1 行は、**ぜんぶ出し終わってから**出す。
    // 途中で出すと、まだぼかしている所の答えが先に見えてしまう。
    if (row.wholeJaEl) {
      row.wholeJaEl.hidden = !(!row.perChunk && row.ja.length && total > 0 && shown >= total);
    }

    if (shown > 0) {
      row.el.classList.add('is-revealed');
      if (row.mainEl) row.mainEl.setAttribute('aria-expanded', 'true');
    } else {
      row.el.classList.remove('is-revealed');
      if (row.mainEl) row.mainEl.setAttribute('aria-expanded', 'false');
    }
  }

  function renderStar(row) {
    if (!row) return;
    var on = isStarred(row.id);
    if (row.el) {
      if (on) row.el.classList.add('is-starred');
      else row.el.classList.remove('is-starred');
    }
    if (row.starEl) {
      row.starEl.setAttribute('aria-pressed', on ? 'true' : 'false');
      row.starEl.setAttribute('aria-label', on ? '「もう一度」から外す' : '「もう一度」に入れる');
    }
  }

  /** #listen-rows を作り直す（DocumentFragment で 1 回だけ挿入） */
  function renderRows() {
    if (!elRows) return;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < state.rows.length; i++) {
      var row = state.rows[i];
      if (!row.el) createRowElement(row);
      if (row.el) frag.appendChild(row.el);
    }
    while (elRows.firstChild) elRows.removeChild(elRows.firstChild);
    elRows.appendChild(frag);
  }

  /** 速さの札。選んだものだけ `.is-on`。中身は JS が作る（選べる値を 1 か所に集めるため） */
  function renderRates() {
    if (!elRateRow) return;
    while (elRateRow.firstChild) elRateRow.removeChild(elRateRow.firstChild);
    for (var i = 0; i < RATES.length; i++) {
      (function (v, label) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'listen-chip' + (v === state.rate ? ' is-on' : '');
        b.textContent = label;
        b.setAttribute('aria-pressed', v === state.rate ? 'true' : 'false');
        b.addEventListener('click', function () {
          state.rate = v;
          saveUI();
          renderRates();
        });
        elRateRow.appendChild(b);
      })(RATES[i], RATE_LABELS[i] || String(RATES[i]));
    }
  }

  /* ============================================================
   * 9. 出す / 隠す
   * ========================================================== */

  function setShown(row, n) {
    if (!row) return;
    var total = row.en.length;
    if (n < 0) n = 0;
    if (n > total) n = total;
    if (row.shown === n) return;
    row.shown = n;
    renderShown(row);
    // ぜんぶ隠したら、その行の音も残さない
    if (!n && state.speakingId === row.id) stopSpeech();
  }

  /**
   * 行を押したとき。**1 かたまりずつ**出し、ぜんぶ出したあともう一度押すと
   * 最初（ぜんぶぼかし）に戻る。戻すときは鳴らさない
   *（隠す操作で音が出るのは、押した意図と合わない）。
   */
  function advanceRow(row) {
    if (!row) return;
    var total = row.en.length;
    if (total) {
      if (row.shown >= total) {
        setShown(row, 0);
      } else {
        var next = row.shown + 1;
        setShown(row, next);
        // 「英語を表示したら自動で読み上げる」のときだけ、**出したかたまりだけ**鳴らす。
        // ここは行のクリックから**同期で**呼ばれている（あいだに setTimeout を
        // 挟むと iOS では鳴らない）。
        if (autoSpeakOn()) speakText(row.en[next - 1], row.id);
      }
    }
    setCurrent(row);
    syncToggleAllButton();
  }

  /** 「ぜんぶ出す / ぜんぶ隠す」は**いま見えている行にだけ**効かせる。
      検索で 3 件に絞ったのに全部開いてしまうと、検索を消したときに
      答えが全部見えている状態になる（phrase.js と同じ）。 */
  function setAllShown(on) {
    var list = visibleRows();
    for (var i = 0; i < list.length; i++) {
      setShown(list[i], on ? list[i].en.length : 0);
    }
    syncToggleAllButton();
  }

  /** 見えている行の中に 1 かたまりでも出しているものがあるか。
      隠れている行まで数えると、押しても何も起きないのにボタンだけ
      「ぜんぶ隠す」と言う状態になる。 */
  function anyShown() {
    var list = visibleRows();
    for (var i = 0; i < list.length; i++) {
      if (list[i].shown > 0) return true;
    }
    return false;
  }

  /** aria-pressed="true" は「いまぜんぶ隠れている」。ラベルは次にやる操作を書く */
  function syncToggleAllButton() {
    if (!elToggleAll) return;
    var allHidden = !anyShown();
    elToggleAll.setAttribute('aria-pressed', allHidden ? 'true' : 'false');
    if (elToggleAllLabel) {
      elToggleAllLabel.textContent = allHidden ? 'ぜんぶ出す' : 'ぜんぶ隠す';
    }
  }

  function visibleRows() {
    var out = [];
    for (var i = 0; i < state.rows.length; i++) {
      var row = state.rows[i];
      if (row.el && !row.el.hidden) out.push(row);
    }
    return out;
  }

  /** 現在行（押した行・キーボードの行）。デスクトップでどこを見ているか分かるように */
  function setCurrent(row) {
    if (state.currentId && state.byId[state.currentId] && state.byId[state.currentId] !== row) {
      var prev = state.byId[state.currentId];
      if (prev.el) prev.el.classList.remove('is-current');
    }
    if (!row || !row.el) { state.currentId = null; return; }
    row.el.classList.add('is-current');
    state.currentId = row.id;
  }

  /* ============================================================
   * 10. 読み上げ
   * ========================================================== */

  function initSpeech() {
    var port = speechPort();
    state.speechOK = !!(port && port.supported());
    if (!port || typeof port.onProblem !== 'function') return;
    // 黙って失敗しない。ただしほかのモードを開いている間は向こうの知らせが
    // 出ているので、こちらは黙る。
    port.onProblem(function (info) {
      if (docEl.getAttribute('data-mode') !== 'listen') return;
      state.speakingId = null;
      flashStatus('読み上げ: ' + (info && info.message ? info.message : 'うまくいきませんでした。'));
    });
  }

  /**
   * 読み上げる。**タップから同期で呼ぶこと**（あいだに setTimeout を挟むと
   * iOS では鳴らない）。速さは操作列で選んだものを使う。
   */
  function speakText(text, id) {
    var say = trim(text);
    if (!say) return;
    var port = speechPort();
    if (!port) return;
    if (!state.speechOK) {
      flashStatus('読み上げ: この端末では読み上げが使えません。');
      return;
    }
    state.speakingId = port.speak(say, { rate: state.rate }) ? (id || null) : null;
  }

  /* --- AI の音声 -------------------------------------------------
   * 置き場（Cloudflare）に作らせて、**端末にしまう**。同じ文は 2 度作らせない。
   * しまってあるぶんは、すぐ・オフラインでも鳴り、無料枠も減らない。
   * 置き場が無い／つながらない／枠切れのときは、黙って端末の声に戻る
   * （鳴らないのがいちばん困るので、ここでは止めない）。
   */

  function audioStore() {
    var a = window.SUNKAN_AUDIO;
    return (a && typeof a.supported === 'function' && a.supported()) ? a : null;
  }

  /** 置き場に音を作らせる口。合言葉は sync.js の中にあるので、こちらは持たない */
  function ttsPort() {
    var s = window.SUNKAN_SYNC;
    if (!s || typeof s.tts !== 'function' || typeof s.cfReady !== 'function') return null;
    return s.cfReady() ? s : null;
  }

  /** AI の音を使うか。入れていても、しまう所が無ければ使えない */
  function aiOn() { return !!(state.ai && audioStore()); }

  /**
   * 鳴らすための <audio> は**1 つだけ**使い回す。
   * iOS は「タップの中で一度 play() したことのある要素」でないと、
   * あとから src を替えて鳴らせない。だから押された瞬間に目を覚まさせる。
   */
  var audioEl = null;
  var audioAwake = false;
  var SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';

  function wakeAudio() {
    if (!window.Audio) return null;
    if (!audioEl) {
      audioEl = new window.Audio();
      audioEl.preload = 'auto';
    }
    if (!audioAwake) {
      audioAwake = true;
      try {
        audioEl.src = SILENT;
        var p = audioEl.play();
        if (p && typeof p.catch === 'function') p.catch(function () { /* 鳴らなくても害は無い */ });
      } catch (e) { /* 使えない端末ではこのあと端末の声に戻る */ }
    }
    return audioEl;
  }

  function playUrl(url, id) {
    var el = wakeAudio();
    if (!el || !url) return false;
    try {
      stopSpeech();
      el.src = url;
      el.playbackRate = state.rate;
      el.currentTime = 0;
      var p = el.play();
      if (p && typeof p.catch === 'function') {
        p.catch(function () { state.speakingId = null; });
      }
      state.speakingId = id || null;
      return true;
    } catch (e) { return false; }
  }

  /** その行の英文を**まるごと**鳴らす（🔈）。` / ` は外して渡す */
  function speakRow(row) {
    if (!row) return;
    var text = speechText(row.en);
    if (!trim(text)) return;
    if (!aiOn()) { speakText(text, row.id); return; }

    wakeAudio();   // **タップの中で**呼ぶ（あとからでは iOS で鳴らない）
    var store = audioStore();
    var key = store.keyFor(text, 'ai');
    store.url(key).then(function (url) {
      if (url) { playUrl(url, row.id); return; }
      makeAudio(row, text, key);
    }, function () { speakText(text, row.id); });
  }

  /** 置き場に作らせて、しまって、鳴らす */
  function makeAudio(row, text, key) {
    var port = ttsPort();
    if (!port) {
      speakText(text, row.id);
      flashStatus('AI の音声には置き場が要ります。設定 → 同期 で URL と合言葉を入れてください。いまは端末の声で鳴らします。', true);
      return;
    }
    if (state.making[key]) return;   // 連打されても 1 回だけ
    state.making[key] = true;
    flashStatus('AI の音声を作っています…（できたら鳴ります。次からはすぐです）');

    port.tts(text).then(function (res) {
      delete state.making[key];
      if (!res || !res.ok || !res.blob) {
        var why = (res && res.message) || 'うまくいきませんでした';
        speakText(text, row.id);
        flashStatus('AI の音声: ' + why + '。端末の声で鳴らします。', true);
        return;
      }
      var store = audioStore();
      if (!store) { speakText(text, row.id); return; }
      store.put(key, res.blob).then(function () {
        markAudio(row, true);
        return store.url(key);
      }).then(function (url) {
        if (!url || !playUrl(url, row.id)) speakText(text, row.id);
        flashStatus('AI の音声ができました。次からはすぐ鳴ります。');
      }, function (e) {
        flashStatus('AI の音声: しまえませんでした（' + ((e && e.message) || '') + '）');
        speakText(text, row.id);
      });
    }, function (e) {
      delete state.making[key];
      speakText(text, row.id);
      flashStatus('AI の音声: ' + ((e && e.message) || '作れませんでした') + '。端末の声で鳴らします。', true);
    });
  }

  /** その行に AI の音があるか、🔈 の見た目に出す（催促ではなく、ただの目印） */
  function markAudio(row, on) {
    if (!row || !row.speakEl) return;
    if (on) row.speakEl.classList.add('has-audio');
    else row.speakEl.classList.remove('has-audio');
  }

  /** 画面に出ている行ぶんだけ、しまってある音があるか見て印を付ける */
  function refreshAudioMarks() {
    var store = audioStore();
    if (!store || !aiOn()) {
      for (var j = 0; j < state.rows.length; j++) markAudio(state.rows[j], false);
      return;
    }
    for (var i = 0; i < state.rows.length; i++) {
      (function (row) {
        var text = speechText(row.en);
        if (!trim(text)) return;
        store.get(store.keyFor(text, 'ai')).then(function (rec) { markAudio(row, !!rec); });
      })(state.rows[i]);
    }
  }

  /** AI の音声の入／切 */
  function renderAiChip() {
    if (!elAiBtn) return;
    elAiBtn.setAttribute('aria-pressed', state.ai ? 'true' : 'false');
    elAiBtn.classList.toggle('is-on', !!state.ai);
  }

  function toggleAi() {
    state.ai = !state.ai;
    saveUI();
    renderAiChip();
    refreshAudioMarks();
    if (!state.ai) { flashStatus('端末の声に戻しました。'); return; }
    if (!audioStore()) {
      flashStatus('この端末では音をしまえないので、AI の音声は使えません。');
      state.ai = false;
      saveUI();
      renderAiChip();
      return;
    }
    if (!ttsPort()) {
      flashStatus('AI の音声には置き場が要ります。設定 → 同期 で URL と合言葉を入れ、置き場に AI をつないでください。');
      return;
    }
    flashStatus('AI の音声にしました。🔈 を押すと、その文の音を 1 回だけ作ってしまいます。');
  }

  function stopSpeech() {
    var port = speechPort();
    state.speakingId = null;
    if (port) port.cancel();
    // AI の音も止める。端末の声だけ止めても、こちらが鳴り続ける
    if (audioEl) { try { audioEl.pause(); } catch (e) { /* もう止まっている */ } }
  }

  /* ============================================================
   * 11. 絞り込みと知らせ
   * ========================================================== */

  function applyFilter() {
    var q = state.query;
    var visible = 0;

    for (var i = 0; i < state.rows.length; i++) {
      var row = state.rows[i];
      if (!row.el) continue;
      var ok = true;
      if (q) {
        // 英語はスラッシュを外したほうで見る（区切りを打たせない）
        ok = row.enLower.indexOf(q) >= 0
          || row.jaLower.indexOf(q) >= 0
          || row.noteLower.indexOf(q) >= 0;
      }
      row.el.hidden = !ok;
      if (ok) visible++;
    }

    state.visibleCount = visible;

    if (elEmpty) {
      if (!state.items.length) {
        // 作りたてのときは空。何をすればいいか書いておく
        elEmpty.textContent = 'まだ文がありません。「＋ 文を追加」から足せます。';
        elEmpty.hidden = false;
      } else if (!visible) {
        elEmpty.textContent = '該当する文がありません。';
        elEmpty.hidden = false;
      } else {
        elEmpty.hidden = true;
      }
    }

    // 現在行が隠れたら外す（見えない行に印だけ残らないように）
    if (state.currentId) {
      var cur = state.byId[state.currentId];
      if (cur && cur.el && cur.el.hidden) {
        cur.el.classList.remove('is-current');
        state.currentId = null;
      }
    }

    // 見えている行が変わるとボタンの意味も変わる（隠れた行は数えない）
    syncToggleAllButton();
    updateStatus();
  }

  var runSearch = debounce(function () {
    state.query = trim(elSearch ? elSearch.value : '').toLowerCase();
    saveUISoon();
    applyFilter();
  }, SEARCH_DEBOUNCE);

  function updateStatus() {
    if (!elStatus) return;
    if (state.flashTimer) {
      window.clearTimeout(state.flashTimer);
      state.flashTimer = null;
    }
    if (!state.items.length) {
      elStatus.textContent = '';
      return;
    }
    var parts = ['全 ' + state.items.length + ' 文'];
    if (state.visibleCount !== state.items.length) {
      parts.push('表示中 ' + state.visibleCount + ' 文');
    }
    elStatus.textContent = parts.join(' ・ ');
  }

  /** 知らせを少しのあいだ出す。次の描画でふつうの件数に戻る */
  /**
   * 知らせを出す。`hold` を付けると、**2 秒間ほかの知らせに上書きされない**。
   * AI の音声が使えないときは、まず端末の声に戻してから理由を出す。読み上げの
   * ほうも失敗する端末では、あとから来るその知らせが理由を消してしまい、
   * 「読み上げが止まりました」だけが残って直しようが無くなる。
   */
  function flashStatus(message, hold) {
    if (!elStatus) return;
    if (!hold && state.holdUntil && Date.now() < state.holdUntil) return;
    state.holdUntil = hold ? (Date.now() + 2000) : 0;
    if (state.flashTimer) {
      window.clearTimeout(state.flashTimer);
      state.flashTimer = null;
    }
    elStatus.textContent = str(message);
    state.flashTimer = window.setTimeout(function () {
      state.flashTimer = null;
      updateStatus();
    }, FLASH_MS);
  }

  /** いま隠している理由を短く言う。無ければ空文字 */
  function whyHidden() {
    if (state.query) {
      return 'いまの検索「' + (elSearch ? trim(elSearch.value) : state.query)
        + '」に当てはまらないので、一覧には出ていません。';
    }
    return '絞り込みに当てはまらないので、一覧には出ていません。';
  }

  /* ============================================================
   * 12. 作り直し（見ていた所は元に戻す）
   * ========================================================== */

  function render() {
    buildRows();
    renderRows();
    applyFilter();
  }

  /**
   * 作り直しても、**出していたかたまりの数・現在行・見ている位置**は元に戻す
   * （phrase.js の rebuildKeepingView と同じ）。同期も編集も読んでいる最中に
   * 割り込むので、ここを捨てると読んでいた所が勝手に閉じる。
   *
   * 文を直しても id は変えないので、★の付け替えは要らない。
   */
  function rebuildKeepingView(rebuild) {
    var open = {}, i, row;
    for (i = 0; i < state.rows.length; i++) {
      if (state.rows[i].shown > 0) open[state.rows[i].id] = state.rows[i].shown;
    }
    var wasCurrent = state.currentId;
    var scrollY = window.pageYOffset;

    rebuild();

    for (i = 0; i < state.rows.length; i++) {
      row = state.rows[i];
      if (!hasOwn(open, row.id)) continue;
      setShown(row, open[row.id]);
    }
    if (wasCurrent && state.byId[wasCurrent]) setCurrent(state.byId[wasCurrent]);

    syncToggleAllButton();
    updateStatus();
    window.scrollTo(0, scrollY);   // 読んでいた位置に戻す
  }

  /* ============================================================
   * 13. 足す / 直す / 消す
   * ========================================================== */

  function setEditStatus(message, isError) {
    if (!elEditStatus) return;
    elEditStatus.textContent = str(message);
    if (isError) elEditStatus.setAttribute('data-error', 'true');
    else elEditStatus.removeAttribute('data-error');
  }

  function openDialog(dialog, invoker) {
    if (!dialog) return;
    state.lastFocus = invoker || document.activeElement;
    if (typeof dialog.showModal === 'function') {
      try {
        if (!dialog.open) dialog.showModal();
        return;
      } catch (e) { /* すでに open のときなど */ }
    }
    dialog.setAttribute('open', 'open');
  }

  function closeDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.close === 'function' && dialog.open) {
      try { dialog.close(); } catch (e) { dialog.removeAttribute('open'); }
    } else {
      dialog.removeAttribute('open');
    }
    restoreFocus();
  }

  function restoreFocus() {
    var el = state.lastFocus;
    state.lastFocus = null;
    if (el && el.focus && document.contains(el)) {
      try { el.focus(); } catch (e) { /* 無視 */ }
    }
  }

  /** 足す / 直すダイアログを開く。row が null なら「足す」 */
  function openEditDialog(row, invoker) {
    state.editingId = row ? row.id : null;
    var item = row ? row.item : null;

    if (elFieldEn) elFieldEn.value = item ? item.en : '';
    if (elFieldJa) elFieldJa.value = item ? item.ja : '';
    if (elFieldNote) elFieldNote.value = item ? item.note : '';
    if (elSaveBtn) elSaveBtn.textContent = item ? '保存する' : '追加する';
    // 消すのは「直す」ときだけ。足す前の空の行は消せない
    if (elDeleteBtn) elDeleteBtn.hidden = !item;
    setEditStatus('', false);

    openDialog(elEditDialog, invoker);
    if (elFieldEn) elFieldEn.focus();
  }

  /** 同じ英文がすでにあるか（直している自分は除く） */
  function hasSame(exceptId, en) {
    var key = dupKey(en);
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].id === exceptId) continue;
      if (dupKey(state.items[i].en) === key) return true;
    }
    return false;
  }

  function submitEdit() {
    var en = elFieldEn ? trim(elFieldEn.value) : '';
    var ja = elFieldJa ? trim(elFieldJa.value) : '';
    var note = elFieldNote ? trim(elFieldNote.value) : '';

    // **英語だけは要る。** 聞くものが無いと練習にならない
    if (!chunksOf(en).length) {
      setEditStatus('英語を入れてください。/ で区切ると、そのかたまりずつ出ます。', true);
      if (elFieldEn) elFieldEn.focus();
      return;
    }
    if (hasSame(state.editingId, en)) {
      setEditStatus('同じ英文がすでにあります。', true);
      return;
    }

    if (state.editingId) {
      var item = findItem(state.editingId);
      if (!item) {   // 直している最中に同期で消えた
        setEditStatus('この文は見つかりませんでした。', true);
        return;
      }
      // 本文を直しても **id は変えない**。★はこの id に付いているので、
      // 直したとたんに外れたように見えてしまう。
      item.en = en;
      item.ja = ja;
      item.note = note;
      saveItems();
      closeDialog(elEditDialog);
      state.editingId = null;
      rebuildKeepingView(render);
      var hiddenNote = isFilteredOut(item.id) ? ' ' + whyHidden() : '';
      flashStatus('直しました。' + hiddenNote);
      return;
    }

    var fresh = {
      id: makeId('listen'),
      en: en, ja: ja, note: note,
      created: Date.now()
    };
    state.items.push(fresh);
    saveItems();
    rebuildKeepingView(render);

    // 欄を空にして、そのまま次の 1 文を入れられるようにする
    if (elFieldEn) elFieldEn.value = '';
    if (elFieldJa) elFieldJa.value = '';
    if (elFieldNote) elFieldNote.value = '';
    if (elFieldEn) elFieldEn.focus();

    // 足したものが絞り込みで隠れているなら、そう言う。黙っていると
    //「追加したのに出てこない」＝足せていないように見える。
    var note2 = isFilteredOut(fresh.id) ? ' ' + whyHidden() : '';
    setEditStatus('追加しました。続けて入力できます。' + note2, false);
  }

  /** その文が、いまの絞り込みで隠れているか */
  function isFilteredOut(id) {
    var row = state.byId[id];
    return !!(row && row.el && row.el.hidden);
  }

  function deleteItem(id) {
    var item = findItem(id);
    if (!item) return;
    var label = speechText(chunksOf(item.en));
    if (label.length > 24) label = label.slice(0, 24) + '…';
    if (!window.confirm('「' + label + '」を削除します。よろしいですか？')) return;

    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].id === id) { state.items.splice(i, 1); break; }
    }
    // 消したことを同期に覚えさせないと、もう片方の端末から戻ってくる
    noteDelete('listenitem:' + id);
    saveItems();
    if (isStarred(id)) setStar(id, false);   // 指す先の無い印は残さない

    if (state.editingId === id) {
      closeDialog(elEditDialog);
      state.editingId = null;
    }
    rebuildKeepingView(render);
    flashStatus('消しました。');
  }

  /* ============================================================
   * 14. 行の操作（#listen-rows へのイベント委譲）
   * ========================================================== */

  function rowFromEvent(target) {
    var li = target && target.closest ? target.closest('.row') : null;
    if (!li) return null;
    return state.byId[li.getAttribute('data-id')] || null;
  }

  function onRowsClick(e) {
    var target = e.target;
    if (!target || !target.closest || !elRows) return;

    var speakBtn = target.closest('.listen-speak');
    if (speakBtn && elRows.contains(speakBtn)) {
      speakRow(rowFromEvent(speakBtn));
      return;
    }

    var starBtn = target.closest('.row-star');
    if (starBtn && elRows.contains(starBtn)) {
      toggleStar(rowFromEvent(starBtn));
      return;
    }

    var editBtn = target.closest('.row-edit');
    if (editBtn && elRows.contains(editBtn)) {
      var rowE = rowFromEvent(editBtn);
      if (rowE) openEditDialog(rowE, editBtn);
      return;
    }

    var delBtn = target.closest('.row-delete');
    if (delBtn && elRows.contains(delBtn)) {
      var rowD = rowFromEvent(delBtn);
      if (rowD) deleteItem(rowD.id);
      return;
    }

    var mainBtn = target.closest('.row-main');
    if (mainBtn && elRows.contains(mainBtn)) {
      advanceRow(rowFromEvent(mainBtn));
    }
  }

  function toggleStar(row) {
    if (!row) return;
    setStar(row.id, !isStarred(row.id));
    renderStar(row);
  }

  /* ============================================================
   * 15. イベント
   * ========================================================== */

  function isTypingTarget(el) {
    if (!el || !el.tagName) return false;
    var tag = el.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
  }

  /**
   * 入力欄の Enter を止める。
   * **Enter では追加も保存もしない。** 日本語を変換して確定するときの Enter で
   * 勝手に追加されるのが、入れている途中でいちばん邪魔だったため。
   * preventDefault だけは残す（ダイアログの中は <form method="dialog"> なので、
   * そのままだと Enter で黙って閉じて、書いたものが消える）。
   */
  function blockEnter(input) {
    if (!input || !input.addEventListener) return;
    input.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
    });
  }

  function bindEvents() {
    if (elRows) elRows.addEventListener('click', onRowsClick);

    // AI の音声の入／切。**押した指の中で**音を目覚めさせておく（iOS 対策）
    if (elAiBtn) {
      elAiBtn.addEventListener('click', function () { wakeAudio(); toggleAi(); });
    }

    if (elSearch) {
      elSearch.addEventListener('input', runSearch);
      elSearch.addEventListener('search', runSearch);   // type="search" の × ボタン
      elSearch.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        // 検索欄で Escape は「検索を消す」。ダイアログと違って閉じる先が無い
        if (!trim(elSearch.value)) return;
        e.preventDefault();
        e.stopPropagation();
        elSearch.value = '';
        state.query = '';
        saveUISoon();
        applyFilter();
      });
    }

    if (elToggleAll) {
      elToggleAll.addEventListener('click', function () {
        setAllShown(!anyShown());
      });
    }

    if (elAddBtn) {
      elAddBtn.addEventListener('click', function () {
        openEditDialog(null, elAddBtn);
      });
    }
    if (elAddRowBtn) {
      elAddRowBtn.addEventListener('click', function () {
        openEditDialog(null, elAddRowBtn);
      });
    }

    if (elSaveBtn) elSaveBtn.addEventListener('click', submitEdit);
    if (elCloseBtn) {
      elCloseBtn.addEventListener('click', function () {
        state.editingId = null;
        closeDialog(elEditDialog);
      });
    }
    if (elDeleteBtn) {
      elDeleteBtn.addEventListener('click', function () {
        if (state.editingId) deleteItem(state.editingId);
      });
    }
    if (elEditDialog) {
      // Escape で閉じたときも、直していた行を覚えっぱなしにしない
      elEditDialog.addEventListener('close', function () { state.editingId = null; });
    }

    blockEnter(elFieldEn);
    blockEnter(elFieldJa);
    blockEnter(elFieldNote);

    // 行の操作はキーボードからも。ほかのモードを開いている間は
    // この一覧が画面に無いので、キー操作はそちらに任せる。
    document.addEventListener('keydown', onKeyDown);

    // 画面を離れたら黙らせる。読み上げを鳴らしたまま裏に回さない
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopSpeech();
    });
  }

  function onKeyDown(e) {
    if (e.defaultPrevented) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (docEl.getAttribute('data-mode') !== 'listen') return;
    if (isTypingTarget(e.target)) return;
    if (elEditDialog && elEditDialog.open) return;

    // 「ぜんぶ出す / ぜんぶ隠す」だけを受ける。1 かたまりずつ出すほうは
    // .row-main がふつうのボタンなので、Enter / Space はブラウザが面倒を見てくれる。
    if (e.key === 'h' || e.key === 'H') {
      e.preventDefault();
      setAllShown(!anyShown());
    }
  }

  /* ============================================================
   * 16. 外に出す口
   * ========================================================== */

  /**
   * 取り込みから足す口。**取り込み側に直に保存させない**（鍵の形も
   * 均し方もここにしか無いので、外から書くと形がずれる）。
   * list は `[{en, ja, note}]`。英語はスラッシュ入りのまま渡してよい。
   * 同じ英文は飛ばす。
   *
   * **この名前と引数は変えない**（取り込みの担当が合わせている）。
   * @returns {number} 足せた件数
   */
  function addItems(list) {
    var items = isArr(list) ? list : [];
    var seen = {}, i;
    for (i = 0; i < state.items.length; i++) {
      seen[dupKey(state.items[i].en)] = 1;
    }

    var added = 0, now = Date.now(), lastId = '';
    for (i = 0; i < items.length; i++) {
      var raw = isObj(items[i]) ? items[i] : {};
      var en = trim(raw.en);
      // 英語が無いと聞くものが無い。日本語とメモは無くてよい
      if (!chunksOf(en).length) continue;
      var key = dupKey(en);
      if (seen[key]) continue;
      seen[key] = 1;
      lastId = makeId('listen');
      state.items.push({
        id: lastId,
        en: en,
        ja: trim(raw.ja),
        note: trim(raw.note),
        created: now + i      // 取り込んだ順を保つ
      });
      added++;
    }

    if (added) {
      saveItems();
      // まだ画面を開いていなければ、作るのは開いたとき（裏で組むと無駄になる）
      if (state.started) {
        rebuildKeepingView(render);
        // 足したものが絞り込みで隠れていたら言う。黙って増えると
        //「取り込んだのに出てこない」に見える。
        if (lastId && isFilteredOut(lastId)) {
          flashStatus(added + ' 文を足しました。' + whyHidden());
        }
      }
    }
    return added;
  }

  /** 画面を開いたとき（paraphrase.js の setMode から） */
  function onShow() {
    var first = !state.started;
    state.started = true;
    // 検索欄は、開いたときだけ保存してあるものに合わせる。
    // 作り直しのたびに書き戻すと、打っている文字が勝手に変わる。
    if (first && elSearch && state.query) elSearch.value = state.query;
    renderRates();
    renderAiChip();
    render();
    refreshAudioMarks();
  }

  /** ほかの画面へ移るとき。鳴らしっぱなしにしない */
  function onHide() {
    stopSpeech();
  }

  /** localStorage を読み直して作り直す（同期のあとに呼ばれる） */
  function reloadFromStorage() {
    if (!state.started) {        // まだ開いていないなら、読み直すだけでよい
      loadAll();
      renderRates();
      return;
    }
    // 同期は裏で走る。出していたかたまり・現在行・見ている位置は戻す。
    // 検索欄には触らない（打っている最中に書き換わらないように）。
    rebuildKeepingView(function () {
      loadAll();
      renderRates();
      renderAiChip();
      render();
      refreshAudioMarks();
    });
  }

  window.SUNKAN_LISTEN = {
    onShow: onShow,
    onHide: onHide,
    reload: reloadFromStorage,
    addItems: addItems
  };

  /* ============================================================
   * 17. 起動
   * ========================================================== */

  function init() {
    // 画面がまだ無い版の index.html でも、読み込めるだけで害が無いようにする
    if (!elView && !elRows) return;

    initSpeech();
    loadAll();
    bindEvents();
    renderRates();
    renderAiChip();

    // **自分で data-mode を見る。** paraphrase.js の init が setMode を呼ぶ時点では
    // window.SUNKAN_LISTEN がまだ無いので、見ないとリスニングを最後に開いた
    // 状態で起動したとき画面が空になる（phrase.js / cards.js と同じ）。
    if (docEl.getAttribute('data-mode') === 'listen') onShow();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
