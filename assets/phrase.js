/* Duo — フレーズ
 *
 * 場面ごとの言い回しを溜めて、日本語を見て英語を言う練習。
 * 手触りは瞬間英作文（app.js）とそろえる — 隠す / 開く / ↻ / % / 検索 / 現在行。
 * 違うのは束ね方だけで、セットではなく**場面**（朝の支度・会議・病院…）で絞る。
 *
 * 場面を「セット」にしなかったのは、1 文が複数の入れ物を行き来しないため。
 * 入れ物を別に持つと「どの場面のセットに入れるか」を先に決めさせることになり、
 * 思いついた言い回しをその場で足せなくなる。場面は 1 文が持つ**ただの名前**で、
 * 絞り込みの欄はそれを数えて並べるだけ。名前を打ち替えれば場面も入れ替わる。
 *
 * app.js / paraphrase.js / cards.js / shadow.js とは状態も保存先も共有しない。
 * 触れ合うのは <html data-mode> と window.SUNKAN_PHRASE だけ。
 *
 * DOM の定義は index.html、取り決めは CONTRACT.md を参照（どちらも変更しない）。
 * 別の担当者が index.html を用意するので、**要素が無くても落ちない**ように書く
 * （この版の index.html にフレーズの画面がまだ無くても、読み込めるだけで害が無い）。
 */
(function () {
  'use strict';

  /* ============================================================
   * 1. 小物
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

  /** 一意な id。cards.js / shadow.js と同じ作り（同じミリ秒に 2 件作っても当たらない） */
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

  var LS_ITEMS = 'sunkan:phrase:items';
  var LS_STARS = 'sunkan:phrase:stars';
  var LS_LEVELS = 'sunkan:phrase:levels';
  var LS_SRS = 'sunkan:phrase:srs';
  // 端末ごとの好み（見ている場面・検索語）。**同期しない**
  var LS_UI = 'sunkan:phrase:ui';

  /** 選べる段階。0 は「まだ」 */
  var LEVELS = [0, 40, 80, 100];

  /** 段階を FSRS の 4 段階に読み替える表（app.js の build 51 と同じ）。
   *  覚えた記録のために新しいボタンを足さない。選ぶ操作がそのまま自己採点。
   *  1=もう一度 2=むずかしい 3=できた 4=かんたん */
  var LEVEL_GRADES = { 0: 1, 40: 2, 80: 3, 100: 4 };

  /** 「外した」印（v:0）を 90 日より古いぶんまで持ち続けない。残しても誰の役にも立たない */
  var LEVEL_ZERO_MAX_AGE = 90 * 24 * 60 * 60 * 1000;

  /** 場面の絞り込みの値。'' は「すべて」なので、「場面なし」には別の値が要る。
   *  制御文字を使うのは、場面の名前と絶対にぶつからないようにするため
   *  （sceneName() が制御文字を落とすので、名前側がこの値になることはない）。 */
  var SCENE_ALL = '';
  var SCENE_NONE = '\u0000none';

  var SEARCH_DEBOUNCE = 120;   // 検索のデバウンス（ミリ秒）
  var FLASH_MS = 4000;         // 知らせを出しておく時間（ミリ秒）

  /* ============================================================
   * 3. 保存データの検証（localStorage の中身は信用しない）
   * ========================================================== */

  /** 場面の名前を均す。改行や制御文字は札にも <option> にも出せないので落とす */
  function sceneName(v) {
    return trim(str(v).replace(/[\u0000-\u001f\u007f]/g, ' '));
  }

  /** 同じ文かどうかの鍵。(ja, en) の組で見る（大文字小文字は無視） */
  function dupKey(ja, en) {
    return (trim(ja) + '\u0001' + trim(en)).toLowerCase();
  }

  /**
   * [{id, ja, en, scene, note, created}] の形に均す。
   * 英語が無いものは練習にならないので落とす。日本語が空のものは残す
   *（取り込みの行き違いで落とすと、利用者から見れば「勝手に消えた」になる）。
   */
  function sanitizeItems(raw) {
    if (!isArr(raw)) return [];
    var out = [], seen = {};
    for (var i = 0; i < raw.length; i++) {
      var it = raw[i];
      if (!isObj(it)) continue;
      var en = trim(it.en);
      if (!en) continue;
      // id が無い / ぶつかっているものには振り直す。id は★・段階・予定の拠り所なので、
      // 同じ id が 2 件あると片方の記録がもう片方に見えてしまう。
      var id = trim(it.id);
      if (!id || seen[id]) id = makeId('phrase');
      seen[id] = 1;
      out.push({
        id: id,
        ja: trim(it.ja),
        en: en,
        scene: sceneName(it.scene),
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

  /**
   * { itemId: {v, at} }。v は 0/40/80/100 で、**0 は「外した」印**。
   * 0 を時刻つきで残すのは、同期で「下げた・外した」を伝えるため
   *（大きいほうを採る足し算だと、下げたことが相手に伝わらない）。
   */
  function sanitizeLevels(raw) {
    var out = {}, cutoff = Date.now() - LEVEL_ZERO_MAX_AGE;
    if (!isObj(raw)) return out;
    for (var id in raw) {
      if (!hasOwn(raw, id)) continue;
      var rec = raw[id];
      if (!isObj(rec)) continue;
      var v = Number(rec.v);
      if (LEVELS.indexOf(v) < 0) continue;
      var at = Number(rec.at) || 0;
      if (!v && at < cutoff) continue;
      out[id] = { v: v, at: at };
    }
    return out;
  }

  /**
   * { itemId: srs の状態 }。中身の形と計算は srs.js が正。
   * srs.js がまだ読めていないときは**均さずにそのまま持つ**（app.js の
   * sanitizeDrillSrs と同じ理由）。ここで {} を返すと、次の保存で
   * 利用者の予定がまるごと消える。
   */
  function sanitizeSrs(raw) {
    var out = {};
    if (!isObj(raw)) return out;
    var srs = window.SUNKAN_SRS;
    for (var id in raw) {
      if (!hasOwn(raw, id)) continue;
      if (!isObj(raw[id])) continue;
      out[id] = srs ? srs.sanitize(raw[id]) : raw[id];
    }
    return out;
  }

  /** 端末ごとの好み。見ている場面と検索語だけ（同期しない） */
  function sanitizeUI(raw) {
    var o = isObj(raw) ? raw : {};
    var scene = str(o.scene) === SCENE_NONE ? SCENE_NONE : sceneName(o.scene);
    return { scene: scene, query: trim(o.query) };
  }

  /* ============================================================
   * 4. 状態
   * ========================================================== */

  var state = {
    items: [],
    stars: [],
    levels: {},
    srs: {},

    scene: SCENE_ALL,   // いま絞り込んでいる場面（'' はすべて）
    query: '',          // 検索語（小文字に潰したもの）

    rows: [],           // 画面に出ている行 [{id, item, el, ...}]
    byId: {},
    visibleCount: 0,
    currentId: null,    // キーボード・ポインタの現在行
    lastRevealed: null,

    speechOK: false,
    speakingId: null,
    editingId: null,    // 直している行の id（新しく足すときは null）
    started: false,     // いちどでも画面を開いたか（開くまで行を作らない）
    flashTimer: null,
    lastFocus: null
  };

  /* ============================================================
   * 5. DOM 参照（別担当の index.html に合わせる。無くても落ちない）
   * ========================================================== */

  var elView = $('phrase-view');
  var elSceneSelect = $('phrase-scene');
  var elSearch = $('phrase-search');
  var elToggleAll = $('phrase-toggle-all');
  var elToggleAllLabel = $('phrase-toggle-all-label');
  var elRows = $('phrase-rows');
  var elRowTemplate = $('phrase-row-template');
  var elEmpty = $('phrase-empty');
  var elStatus = $('phrase-status');
  var elAddBtn = $('btn-phrase-add');

  var elEditDialog = $('phrase-edit-dialog');
  var elFieldJa = $('phrase-ja');
  var elFieldEn = $('phrase-en');
  var elFieldScene = $('phrase-scene-input');
  var elFieldNote = $('phrase-note');
  var elEditStatus = $('phrase-edit-status');
  var elSaveBtn = $('btn-phrase-save');
  var elCloseBtn = $('btn-phrase-close');
  var elDeleteBtn = $('btn-phrase-delete');

  /* ============================================================
   * 6. 保存
   * ========================================================== */

  function saveItems() { return writeJSON(LS_ITEMS, state.items); }
  function saveStars() { return writeJSON(LS_STARS, state.stars); }
  function saveLevels() { return writeJSON(LS_LEVELS, state.levels); }
  function saveSrs() { return writeJSON(LS_SRS, state.srs); }

  function saveUI() {
    return writeJSON(LS_UI, { scene: state.scene, query: state.query });
  }

  // 1 文字打つたびに書くほどのものではないので、落ち着いてから書く
  var saveUISoon = debounce(saveUI, 400);

  function loadAll() {
    state.items = sanitizeItems(readJSON(LS_ITEMS));
    state.stars = sanitizeStars(readJSON(LS_STARS));
    state.levels = sanitizeLevels(readJSON(LS_LEVELS));
    state.srs = sanitizeSrs(readJSON(LS_SRS));
    var ui = sanitizeUI(readJSON(LS_UI));
    state.scene = sceneExists(ui.scene) ? ui.scene : SCENE_ALL;
    state.query = ui.query.toLowerCase();
  }

  /* ============================================================
   * 7. 問い合わせ（文・場面・★・段階）
   * ========================================================== */

  function findItem(id) {
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].id === id) return state.items[i];
    }
    return null;
  }

  /** その文が属する場面の絞り込みの値（名前が空なら「場面なし」） */
  function sceneKeyOf(item) {
    return item && item.scene ? item.scene : SCENE_NONE;
  }

  /** その絞り込みの値に当たる文があるか。無くなった場面は「すべて」へ戻す */
  function sceneExists(key) {
    if (key === SCENE_ALL) return true;
    for (var i = 0; i < state.items.length; i++) {
      if (sceneKeyOf(state.items[i]) === key) return true;
    }
    return false;
  }

  /** 場面の一覧 [{name, count}]。名前の付いた場面だけを数えて並べる */
  function sceneList() {
    var names = [], counts = {}, i;
    for (i = 0; i < state.items.length; i++) {
      var name = state.items[i].scene;
      if (!name) continue;
      if (!hasOwn(counts, name)) { counts[name] = 0; names.push(name); }
      counts[name]++;
    }
    names.sort(function (a, b) {
      // 日本語の名前が並ぶので、使える環境では読み順にそろえる
      if (a.localeCompare) return a.localeCompare(b, 'ja');
      return a < b ? -1 : (a > b ? 1 : 0);
    });
    var out = [];
    for (i = 0; i < names.length; i++) {
      out.push({ name: names[i], count: counts[names[i]] });
    }
    return out;
  }

  /** 場面の名前が付いていない文の数（絞り込みに「場面なし」を出すかの判断） */
  function noSceneCount() {
    var n = 0;
    for (var i = 0; i < state.items.length; i++) {
      if (!state.items[i].scene) n++;
    }
    return n;
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
    var key = 'phrasestar:' + id;
    if (on) noteAdd(key); else noteDelete(key);
  }

  /** この文の段階。付けていなければ 0 */
  function levelOf(id) {
    var rec = state.levels[id];
    return (rec && Number(rec.v)) || 0;
  }

  /** 段階を付け替える。0 は「外す」。時刻を添えて、同期で新しいほうを勝たせる */
  function setLevel(id, v) {
    if (!id) return;
    if (LEVELS.indexOf(v) < 0) v = 0;
    state.levels[id] = { v: v, at: Date.now() };
    saveLevels();
  }

  /* ============================================================
   * 8. 忘却曲線（計算は srs.js に任せる）
   * ========================================================== */

  function srsOf(id) {
    return state.srs[id] || null;
  }

  function setSrs(id, next) {
    if (!id || !next) return;
    state.srs[id] = next;
    saveSrs();
  }

  /**
   * 「今日やるぶん」の締め＝**今日の終わり**。「いま」で切らない。
   * 「まだ」と採点した文は数分後に置き直されるので、「いま」で切ると
   * たったいま「まだ」にした文が目の前から消える（app.js の dueCutoff と同じ）。
   */
  function dueCutoff() {
    var d = new Date();
    d.setHours(23, 59, 59, 999);
    return d.getTime();
  }

  /** 今日やる番が来ているか。**一度も採点していない文は「やる番」** */
  function isDueItem(id, cutoff) {
    if (!window.SUNKAN_SRS) return true;
    var rec = srsOf(id);
    if (!rec) return true;
    return window.SUNKAN_SRS.isDue(rec, cutoff || dueCutoff());
  }

  function dueCount() {
    var cutoff = dueCutoff(), n = 0;
    for (var i = 0; i < state.items.length; i++) {
      if (isDueItem(state.items[i].id, cutoff)) n++;
    }
    return n;
  }

  /**
   * 段階を選んだら、それを自己採点として次に出す日を決める。
   * 戻り値は「次はいつか」の短い言い方。これを画面に出さないと、
   * 予定が動いたのかどうか利用者には分からない（忘却曲線が見えなくなる）。
   */
  function recordReview(id, v) {
    if (!window.SUNKAN_SRS || !id) return '';
    var g = LEVEL_GRADES[v] || 1;
    var cur = srsOf(id) || window.SUNKAN_SRS.newState();
    var next = window.SUNKAN_SRS.review(cur, g, { now: Date.now() });
    setSrs(id, next);
    return window.SUNKAN_SRS.humanInterval(next.intervalDays);
  }

  /** その文の記録をまとめて捨てる（文を消したとき）。残しても指す先が無い */
  function dropRecords(id) {
    if (hasOwn(state.levels, id)) { delete state.levels[id]; saveLevels(); }
    if (hasOwn(state.srs, id)) { delete state.srs[id]; saveSrs(); }
    if (isStarred(id)) setStar(id, false);
  }

  /* ============================================================
   * 9. 行の生成と描画
   * ========================================================== */

  /** items から行の入れ物を作る。要素はまだ作らない */
  function buildRows() {
    state.rows = [];
    state.byId = {};
    for (var i = 0; i < state.items.length; i++) {
      var it = state.items[i];
      var row = {
        id: it.id,
        item: it,
        jaLower: it.ja.toLowerCase(),
        enLower: it.en.toLowerCase(),
        noteLower: it.note.toLowerCase(),
        sceneLower: it.scene.toLowerCase(),
        el: null,
        numEl: null,
        mainEl: null,
        starEl: null,
        levelEl: null,
        lvTagEl: null,
        sceneTagEl: null,
        revealed: false
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

    var jaEl = li.querySelector('.cell--ja');
    var enTextEl = li.querySelector('.en-text');

    // 段階の札は**日本語側の先頭**に置く。# 列は iPhone の幅では畳まれるので、
    // そこに出すと肝心の端末で見えない（app.js と同じ置き方・同じクラス）。
    if (jaEl) {
      var tag = document.createElement('small');
      tag.className = 'lv-tag';
      tag.hidden = true;
      jaEl.appendChild(tag);
      jaEl.insertBefore(tag, jaEl.firstChild);
      row.lvTagEl = tag;

      var jaText = document.createElement('span');
      jaText.className = 'ja-text';
      jaText.textContent = item.ja;
      jaEl.appendChild(jaText);

      // メモは答えのヒントそのもの。<small class="note"> にして
      // 開いた行だけ見えるようにするのは CSS の仕事（app.js と同じ）。
      // 行に title は付けない（ホバーで答えが割れる）。
      if (item.note) {
        var note = document.createElement('small');
        note.className = 'note';
        note.textContent = item.note;
        jaEl.appendChild(note);
      }
    }

    if (enTextEl) enTextEl.textContent = item.en;

    row.el = li;
    row.numEl = li.querySelector('.cell--num');
    row.mainEl = li.querySelector('.row-main');
    row.starEl = li.querySelector('.row-star');
    row.levelEl = li.querySelector('.row-level');
    row.sceneTagEl = li.querySelector('.phrase-scene-tag');

    // 読み上げが使えない端末ではボタンごと隠す（押しても鳴らないものを出さない）
    var speakEl = li.querySelector('.row-speak');
    if (speakEl && !state.speechOK) speakEl.hidden = true;

    // フレーズはぜんぶ自分で入れた文なので、どの行も消せる。
    // テンプレート側で hidden になっていても外す。
    var delEl = li.querySelector('.row-delete');
    if (delEl) delEl.hidden = false;

    renderStar(row);
    renderLevel(row);
    renderSceneTag(row);
    return li;
  }

  /** いまの段階を、札とボタンの値に出す */
  function renderLevel(row) {
    if (!row) return;
    var v = levelOf(row.id);
    if (row.el) {
      if (v) row.el.setAttribute('data-level', String(v));
      else row.el.removeAttribute('data-level');
    }
    if (row.lvTagEl) {
      row.lvTagEl.textContent = v ? String(v) : '';
      row.lvTagEl.hidden = !v;
    }
    if (row.levelEl) row.levelEl.value = String(v);
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

  /** 場面の札。「すべて」で見ているときだけ意味があるので、名前が無ければ畳む */
  function renderSceneTag(row) {
    if (!row || !row.sceneTagEl) return;
    var name = row.item.scene;
    row.sceneTagEl.textContent = name;
    row.sceneTagEl.hidden = !name;
  }

  /** #phrase-rows を作り直す（DocumentFragment で 1 回だけ挿入） */
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

  /** 番号は**見えている行だけ**で振る。絞り込みで飛び番になると数が合わない */
  function renumber() {
    var n = 0;
    for (var i = 0; i < state.rows.length; i++) {
      var row = state.rows[i];
      if (!row.el || !row.numEl) continue;
      if (row.el.hidden) { row.numEl.textContent = ''; continue; }
      n++;
      row.numEl.textContent = String(n);
    }
  }

  /** 場面の絞り込みを作り直す。件数を添えて、選ぶ前に何件あるか分かるようにする */
  function renderSceneSelect() {
    if (!elSceneSelect) return;
    var keep = state.scene;
    while (elSceneSelect.firstChild) elSceneSelect.removeChild(elSceneSelect.firstChild);

    var all = document.createElement('option');
    all.value = SCENE_ALL;
    all.textContent = 'すべて（' + state.items.length + '）';
    elSceneSelect.appendChild(all);

    var list = sceneList();
    for (var i = 0; i < list.length; i++) {
      var opt = document.createElement('option');
      opt.value = list[i].name;
      opt.textContent = list[i].name + '（' + list[i].count + '）';
      elSceneSelect.appendChild(opt);
    }

    var none = noSceneCount();
    if (none) {
      var optNone = document.createElement('option');
      optNone.value = SCENE_NONE;
      optNone.textContent = '場面なし（' + none + '）';
      elSceneSelect.appendChild(optNone);
    }

    // 見ていた場面が無くなっていたら「すべて」へ戻す（SUNKAN_PARA の reload と同じ）
    elSceneSelect.value = sceneExists(keep) ? keep : SCENE_ALL;
    state.scene = elSceneSelect.value;
  }

  /* ============================================================
   * 10. 隠す / 開く
   * ========================================================== */

  function setRevealed(row, on) {
    if (!row || !row.el) return;
    if (row.revealed === on) return;
    row.revealed = on;
    if (on) {
      row.el.classList.add('is-revealed');
      if (row.mainEl) row.mainEl.setAttribute('aria-expanded', 'true');
    } else {
      row.el.classList.remove('is-revealed');
      if (row.mainEl) row.mainEl.setAttribute('aria-expanded', 'false');
      // 閉じた行の音は残さない。「全部隠す」でも「1 行だけ閉じる」でも同じ
      if (state.speakingId === row.id) stopSpeech();
    }
  }

  function toggleRow(row) {
    if (!row) return;
    setRevealed(row, !row.revealed);
    state.lastRevealed = row.revealed ? row : null;
    setCurrent(row);
    syncToggleAllButton();
  }

  /** 「表示 / 隠す」は**いま見えている行にだけ**効かせる。
      検索で 3 件に絞ったのに全部開いてしまうと、検索を消したときに
      答えが全部見えている状態になる（app.js と同じ）。 */
  function setAllRevealed(on) {
    var list = visibleRows();
    for (var i = 0; i < list.length; i++) setRevealed(list[i], on);
    state.lastRevealed = null;
    syncToggleAllButton();
  }

  /** 見えている行の中に開いているものがあるか。隠れている行まで数えると、
      押しても何も起きないのにボタンだけ「隠す」と言う状態になる */
  function anyRevealed() {
    var list = visibleRows();
    for (var i = 0; i < list.length; i++) {
      if (list[i].revealed) return true;
    }
    return false;
  }

  /** aria-pressed="true" は「いまぜんぶ隠れている」。ラベルは次にやる操作を書く */
  function syncToggleAllButton() {
    if (!elToggleAll) return;
    var allHidden = !anyRevealed();
    elToggleAll.setAttribute('aria-pressed', allHidden ? 'true' : 'false');
    if (elToggleAllLabel) {
      elToggleAllLabel.textContent = allHidden ? '英語を表示' : '英語を隠す';
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
   * 11. 読み上げ
   * ========================================================== */

  function initSpeech() {
    var port = speechPort();
    state.speechOK = !!(port && port.supported());
    if (!port || typeof port.onProblem !== 'function') return;
    // 黙って失敗しない。ただしほかのモードを開いている間は向こうの知らせが
    // 出ているので、こちらは黙る。
    port.onProblem(function (info) {
      if (docEl.getAttribute('data-mode') !== 'phrase') return;
      state.speakingId = null;
      flashStatus('読み上げ: ' + (info && info.message ? info.message : 'うまくいきませんでした。'));
    });
  }

  /** 読み上げる。タップから同期で呼ぶこと（あいだに setTimeout を挟むと iOS で鳴らない） */
  function speakRow(row) {
    if (!row || !row.item.en) return;
    var port = speechPort();
    if (!port) return;
    if (!state.speechOK) {
      flashStatus('読み上げ: この端末では読み上げが使えません。');
      return;
    }
    state.speakingId = port.speak(row.item.en) ? row.id : null;
  }

  function stopSpeech() {
    var port = speechPort();
    state.speakingId = null;
    if (port) port.cancel();
  }

  /* ============================================================
   * 12. 絞り込みと知らせ
   * ========================================================== */

  function applyFilter() {
    var q = state.query;
    var scene = state.scene;
    var visible = 0;

    for (var i = 0; i < state.rows.length; i++) {
      var row = state.rows[i];
      if (!row.el) continue;
      var ok = true;
      if (scene !== SCENE_ALL) ok = sceneKeyOf(row.item) === scene;
      if (ok && q) {
        // 場面の名前も検索に含める。「病院」と打ったら、その場面の文も出てほしい
        ok = row.jaLower.indexOf(q) >= 0
          || row.enLower.indexOf(q) >= 0
          || row.noteLower.indexOf(q) >= 0
          || row.sceneLower.indexOf(q) >= 0;
      }
      row.el.hidden = !ok;
      if (ok) visible++;
    }

    state.visibleCount = visible;

    if (elEmpty) {
      if (!state.items.length) {
        // 作りたてのときは空。何をすればいいか書いておく
        elEmpty.textContent = 'まだフレーズがありません。「＋ フレーズを追加」から足せます。';
        elEmpty.hidden = false;
      } else if (!visible) {
        elEmpty.textContent = '該当するフレーズがありません。';
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

    renumber();
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
    var parts = [];
    if (state.scene === SCENE_NONE) parts.push('場面なし');
    else if (state.scene) parts.push(state.scene);
    parts.push('全 ' + state.items.length + ' 文');
    if (state.visibleCount !== state.items.length) {
      parts.push('表示中 ' + state.visibleCount + ' 文');
    }
    // 今日やるぶんを出す。これが無いと、どこまでやれば終わりかが分からない
    var due = dueCount();
    if (due) parts.push('今日 ' + due + ' 文');
    elStatus.textContent = parts.join(' ・ ');
  }

  /** 知らせを少しのあいだ出す。次の描画でふつうの件数に戻る */
  function flashStatus(message) {
    if (!elStatus) return;
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
      return 'いまの検索「' + (elSearch ? trim(elSearch.value) : state.query) + '」に当てはまらないので、一覧には出ていません。';
    }
    if (state.scene === SCENE_NONE) return '「場面なし」で絞っているので、一覧には出ていません。';
    if (state.scene) return '「' + state.scene + '」で絞っているので、一覧には出ていません。';
    return '絞り込みに当てはまらないので、一覧には出ていません。';
  }

  /* ============================================================
   * 13. 作り直し（見ていた所は元に戻す）
   * ========================================================== */

  function render() {
    renderSceneSelect();
    buildRows();
    renderRows();
    applyFilter();
  }

  /**
   * 作り直しても、**開いていた行・現在行・見ている位置**は元に戻す
   * （app.js の rebuildKeepingView と同じ）。同期も編集も読んでいる最中に
   * 割り込むので、ここを捨てると答えが勝手に消える。
   *
   * 文を直しても id は変えないので、app.js の moved のような付け替えは要らない
   *（id は★・段階・予定の拠り所。文を直すたびに動くと記録が外れて見える）。
   */
  function rebuildKeepingView(rebuild) {
    var open = {}, i, row;
    for (i = 0; i < state.rows.length; i++) {
      if (state.rows[i].revealed) open[state.rows[i].id] = true;
    }
    var wasCurrent = state.currentId;
    var scrollY = window.pageYOffset;

    rebuild();

    var lastOpen = null;
    for (i = 0; i < state.rows.length; i++) {
      row = state.rows[i];
      if (!open[row.id]) continue;
      setRevealed(row, true);
      lastOpen = row;
    }
    state.lastRevealed = lastOpen;
    if (wasCurrent && state.byId[wasCurrent]) setCurrent(state.byId[wasCurrent]);

    syncToggleAllButton();
    updateStatus();
    window.scrollTo(0, scrollY);   // 読んでいた位置に戻す
  }

  /* ============================================================
   * 14. 足す / 直す / 消す
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

    if (elFieldJa) elFieldJa.value = item ? item.ja : '';
    if (elFieldEn) elFieldEn.value = item ? item.en : '';
    if (elFieldNote) elFieldNote.value = item ? item.note : '';
    if (elFieldScene) {
      // 新しく足すときは、いま見ている場面を入れておく。
      // 場面で絞って眺めているときに足すものは、まずその場面のものなので。
      elFieldScene.value = item ? item.scene
        : (state.scene && state.scene !== SCENE_NONE ? state.scene : '');
    }
    if (elSaveBtn) elSaveBtn.textContent = item ? '保存する' : '追加する';
    // 消すのは「直す」ときだけ。足す前の空の行は消せない
    if (elDeleteBtn) elDeleteBtn.hidden = !item;
    setEditStatus('', false);

    openDialog(elEditDialog, invoker);
    if (elFieldJa) elFieldJa.focus();
  }

  /** 同じ (ja, en) の文がすでにあるか（直している自分は除く） */
  function hasSame(exceptId, ja, en) {
    var key = dupKey(ja, en);
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].id === exceptId) continue;
      if (dupKey(state.items[i].ja, state.items[i].en) === key) return true;
    }
    return false;
  }

  function submitEdit() {
    var ja = elFieldJa ? trim(elFieldJa.value) : '';
    var en = elFieldEn ? trim(elFieldEn.value) : '';
    var scene = elFieldScene ? sceneName(elFieldScene.value) : '';
    var note = elFieldNote ? trim(elFieldNote.value) : '';

    if (!ja || !en) {
      setEditStatus('日本語と英語の両方を入れてください。', true);
      var focusEl = (!ja && elFieldJa) ? elFieldJa : elFieldEn;
      if (focusEl) focusEl.focus();
      return;
    }
    if (hasSame(state.editingId, ja, en)) {
      setEditStatus('同じフレーズがすでにあります。', true);
      return;
    }

    if (state.editingId) {
      var item = findItem(state.editingId);
      if (!item) {   // 直している最中に同期で消えた
        setEditStatus('このフレーズは見つかりませんでした。', true);
        return;
      }
      // 本文を直しても **id は変えない**。★・段階・予定はこの id に付いているので、
      // 直したとたんに「まだ」へ戻ったように見えてしまう。
      item.ja = ja;
      item.en = en;
      item.scene = scene;
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
      id: makeId('phrase'),
      ja: ja, en: en, scene: scene, note: note,
      created: Date.now()
    };
    state.items.push(fresh);
    saveItems();
    rebuildKeepingView(render);

    // 欄を空にして、そのまま次の 1 文を入れられるようにする。
    // 場面はそのまま残す（同じ場面の言い回しは続けて入れるもの）。
    if (elFieldJa) elFieldJa.value = '';
    if (elFieldEn) elFieldEn.value = '';
    if (elFieldNote) elFieldNote.value = '';
    if (elFieldJa) elFieldJa.focus();

    // 足したものが絞り込みで隠れているなら、そう言う。黙っていると
    //「追加したのに出てこない」＝足せていないように見える。
    var note2 = isFilteredOut(fresh.id) ? ' ' + whyHidden() : '';
    setEditStatus('「' + ja + '」を追加しました。続けて入力できます。' + note2, false);
  }

  /** その文が、いまの絞り込みで隠れているか */
  function isFilteredOut(id) {
    var row = state.byId[id];
    return !!(row && row.el && row.el.hidden);
  }

  function deleteItem(id) {
    var item = findItem(id);
    if (!item) return;
    var label = item.ja || item.en;
    if (label.length > 24) label = label.slice(0, 24) + '…';
    if (!window.confirm('「' + label + '」を削除します。よろしいですか？')) return;

    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].id === id) { state.items.splice(i, 1); break; }
    }
    // 消したことを同期に覚えさせないと、もう片方の端末から戻ってくる
    noteDelete('phraseitem:' + id);
    saveItems();
    dropRecords(id);

    if (state.editingId === id) {
      closeDialog(elEditDialog);
      state.editingId = null;
    }
    rebuildKeepingView(render);
    flashStatus('消しました。');
  }

  /* ============================================================
   * 15. 行の操作（#phrase-rows へのイベント委譲）
   * ========================================================== */

  function rowFromEvent(target) {
    var li = target && target.closest ? target.closest('.row') : null;
    if (!li) return null;
    return state.byId[li.getAttribute('data-id')] || null;
  }

  function onRowsClick(e) {
    var target = e.target;
    if (!target || !target.closest || !elRows) return;

    var speakBtn = target.closest('.row-speak');
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
      toggleRow(rowFromEvent(mainBtn));
    }
  }

  function onRowsChange(e) {
    var target = e.target;
    if (!target || !target.closest || !elRows) return;
    var sel = target.closest('.row-level');
    if (!sel || !elRows.contains(sel)) return;
    pickLevel(rowFromEvent(sel), Number(sel.value));
  }

  function toggleStar(row) {
    if (!row) return;
    var on = !isStarred(row.id);
    setStar(row.id, on);
    renderStar(row);
    if (on) {
      // ↻「もう一度」が、この画面での「言えなかった」。
      // 段階の欄は既定が「まだ」なので、**まだ の行では「まだ」を選べない**
      //（同じ値を選び直すことになり change が起きない）。言えなかったことを
      // 記録できる操作はここしか無いので、ここで採点する。
      // 外すときは採点しない（言えるようになった印なので、間隔を縮める話ではない）。
      // 知らせは出さない。↻ の答えはいつも「今日」で、言うことが無い。
      recordReview(row.id, 0);
      updateStatus();   // 「今日やるぶん」の数は増える
    }
  }

  /**
   * 一覧から段階を選んだとき。選ぶことがそのまま自己採点になる。
   * 予定が動いたことは必ず出す。出さないと、何が起きたのか分からないまま
   * 間隔だけが伸びていく（忘却曲線が利用者から見えなくなる）。
   */
  function pickLevel(row, v) {
    if (!row) return;
    if (LEVELS.indexOf(v) < 0) v = 0;
    if (v === levelOf(row.id)) return;
    setLevel(row.id, v);
    var when = recordReview(row.id, v);
    renderLevel(row);
    flashStatus((v ? v + '% にしました。' : 'まだ にしました。')
      + (when ? '次は ' + when + '。' : ''));
  }

  /* ============================================================
   * 16. イベント
   * ========================================================== */

  function isTypingTarget(el) {
    if (!el || !el.tagName) return false;
    var tag = el.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
  }

  /** 1 行の入力欄なら Enter でそのまま保存する（textarea では改行を優先する） */
  function bindEnterToSave(input) {
    if (!input || !input.tagName) return;
    if (input.tagName.toLowerCase() !== 'input') return;
    input.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      submitEdit();
    });
  }

  function bindEvents() {
    if (elRows) {
      elRows.addEventListener('click', onRowsClick);
      elRows.addEventListener('change', onRowsChange);
    }

    if (elSceneSelect) {
      elSceneSelect.addEventListener('change', function () {
        state.scene = elSceneSelect.value;
        saveUI();
        applyFilter();
      });
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
        setAllRevealed(!anyRevealed());
      });
    }

    if (elAddBtn) {
      elAddBtn.addEventListener('click', function () {
        openEditDialog(null, elAddBtn);
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

    bindEnterToSave(elFieldJa);
    bindEnterToSave(elFieldEn);
    bindEnterToSave(elFieldScene);
    bindEnterToSave(elFieldNote);

    // 行の開閉はキーボードからも。ほかのモードを開いている間は
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
    if (docEl.getAttribute('data-mode') !== 'phrase') return;
    if (isTypingTarget(e.target)) return;
    if (elEditDialog && elEditDialog.open) return;

    // 「英語を表示 / 隠す」だけを受ける。行の開閉は .row-main が
    // ふつうのボタンなので、Enter / Space はブラウザが面倒を見てくれる。
    if (e.key === 'h' || e.key === 'H') {
      e.preventDefault();
      setAllRevealed(!anyRevealed());
    }
  }

  /* ============================================================
   * 17. 外に出す口
   * ========================================================== */

  /**
   * 取り込みから足す口。**取り込み側に直に保存させない**（鍵の形も
   * 均し方もここにしか無いので、外から書くと形がずれる）。
   * items は {ja, en, scene, note} の配列。同じ (ja, en) は飛ばす。
   * @returns {{added:number, skipped:number}}
   */
  function addPhrases(items) {
    var list = isArr(items) ? items : [];
    var seen = {}, i;
    for (i = 0; i < state.items.length; i++) {
      seen[dupKey(state.items[i].ja, state.items[i].en)] = 1;
    }

    var added = 0, skipped = 0, now = Date.now(), lastId = '';
    for (i = 0; i < list.length; i++) {
      var raw = isObj(list[i]) ? list[i] : {};
      var ja = trim(raw.ja), en = trim(raw.en);
      // 日本語が無いと出題にならず、英語が無いと答えが無い。どちらも要る
      if (!ja || !en) { skipped++; continue; }
      var key = dupKey(ja, en);
      if (seen[key]) { skipped++; continue; }
      seen[key] = 1;
      lastId = makeId('phrase');
      state.items.push({
        id: lastId,
        ja: ja,
        en: en,
        scene: sceneName(raw.scene),
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
    return { added: added, skipped: skipped };
  }

  /** 画面を開いたとき（paraphrase.js の setMode から） */
  function onShow() {
    var first = !state.started;
    state.started = true;
    // 検索欄と場面の欄は、開いたときだけ保存してあるものに合わせる。
    // 作り直しのたびに書き戻すと、打っている文字が勝手に変わる。
    if (first && elSearch && state.query) elSearch.value = state.query;
    render();
  }

  /** ほかの画面へ移るとき。鳴らしっぱなしにしない */
  function onHide() {
    stopSpeech();
  }

  /** localStorage を読み直して作り直す（同期のあとに呼ばれる） */
  function reloadFromStorage() {
    if (!state.started) {        // まだ開いていないなら、読み直すだけでよい
      loadAll();
      renderSceneSelect();
      return;
    }
    // 同期は裏で走る。開いていた行・現在行・見ている位置は戻す。
    // 検索欄には触らない（打っている最中に書き換わらないように）。
    rebuildKeepingView(function () {
      loadAll();
      render();
    });
  }

  window.SUNKAN_PHRASE = {
    onShow: onShow,
    onHide: onHide,
    reload: reloadFromStorage,
    addPhrases: addPhrases,

    /** 場面の一覧 `[{name, count}]`（取り込みの入れ先を作るのに使う） */
    scenes: sceneList
  };

  /* ============================================================
   * 18. 起動
   * ========================================================== */

  function init() {
    // 画面がまだ無い版の index.html でも、読み込めるだけで害が無いようにする
    if (!elView && !elRows) return;

    initSpeech();
    loadAll();
    bindEvents();

    if (docEl.getAttribute('data-mode') === 'phrase') onShow();
    else renderSceneSelect();   // 件数つきの欄だけは先に用意しておく
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
