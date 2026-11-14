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
 * 文は**プレイリスト**で分けられる（瞬間英作文の「セット」と同じ考え方。
 * 画面に出す言葉は「プレイリスト」で、保存先は `sunkan:listen:decks`）。
 * 1 件の `deck` がその id で、`''` は「どこにも入れていない」＝未分類。
 * **プレイリストを消しても中の文は消さない**（`deck` を `''` に戻すだけ）。
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
  // プレイリスト（瞬間英作文の「セット」と同じ考え方。画面での言い方は
  // 「プレイリスト」）。1 件は {id, name, created}。
  var LS_DECKS = 'sunkan:listen:decks';
  // 端末ごとの好み（検索語・速さ・いま選んでいるプレイリスト）。**同期しない**
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

  /** プレイリストの絞り込みの値。`''` は「すべて」なので、「未分類」には別の値が要る。
   *  制御文字を使うのは、プレイリストの id と絶対にぶつからないようにするため
   *  （makeId が作るのは英数字とハイフンだけ）。phrase.js の場面と同じ作り。 */
  var DECK_ALL = '';
  var DECK_NONE = '\u0000none';
  /** 入れ先の `<select>` の「＋ 新しいプレイリスト」。これも id とぶつからない値 */
  var DECK_NEW = '\u0000new';

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

  /** プレイリストの名前を均す。改行や制御文字は <option> にも札にも出せないので落とす */
  function deckName(v) {
    return trim(str(v).replace(/[\u0000-\u001f\u007f]/g, ' '));
  }

  /**
   * プレイリストを [{id, name, created}] に均す。
   * **名前が無いものは落とす**（選びようがない）。id がぶつかっていたら振り直す。
   */
  function sanitizeDecks(raw) {
    if (!isArr(raw)) return [];
    var out = [], seen = {};
    for (var i = 0; i < raw.length; i++) {
      var d = raw[i];
      if (!isObj(d)) continue;
      var name = deckName(d.name);
      if (!name) continue;
      var id = trim(d.id);
      if (!id || seen[id]) id = makeId('listendeck');
      seen[id] = 1;
      out.push({ id: id, name: name, created: Number(d.created) || 0 });
    }
    return out;
  }

  /**
   * [{id, en, ja, note, deck, created}] の形に均す。
   * **`en` が無いものは落とす** — 聞くものが無いので練習にならない。
   * `en` も `ja` もスラッシュ入りのまま持つ（割るのは出すときだけ）。
   *
   * **`deck` を落とさないこと。** ここは知らない項目を落とす作りなので、
   * 書き忘れると入れたプレイリストが保存のたびに消える。
   * いま入っているデータには `deck` が無いので、`''`（未分類）に揃える
   * ——**消さない・勝手にどこかへ入れない**。
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
        // もう無いプレイリストの id でも、ここでは**そのまま持つ**。
        // ほかの端末で作ったプレイリストのこともあるので、消すと戻せない。
        // 画面では deckKeyOf() が「未分類」として扱う。
        deck: trim(it.deck),
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

  /** 端末ごとの好み。検索語・速さ・AI の音声を使うか・プレイリスト（同期しない） */
  function sanitizeUI(raw) {
    var o = isObj(raw) ? raw : {};
    var rate = Number(o.rate);
    if (RATES.indexOf(rate) < 0) rate = DEFAULT_RATE;
    var deck = str(o.deck) === DECK_NONE ? DECK_NONE : trim(o.deck);
    return { query: trim(o.query), rate: rate, ai: o.ai === true, deck: deck };
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
    decks: [],          // プレイリスト [{id, name, created}]

    deck: DECK_ALL,     // いま絞り込んでいるプレイリスト（'' はすべて）
    query: '',          // 検索語（小文字に潰したもの）
    rate: DEFAULT_RATE, // 読み上げの速さ
    ai: false,          // AI の音声を使うか（置き場が要る）
    holdUntil: 0,       // この時刻まで、知らせを上書きさせない
    prefetching: false, // いま先読みしている最中か（二重に走らせない）
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
  var elDeckSelect = $('listen-deck');
  var elDecksBtn = $('btn-listen-decks');
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
  var elFieldDeck = $('listen-deck-field');          // 入れ先（ダイアログのいちばん上）
  var elNewDeckField = $('listen-new-deck-field');   // 「＋ 新しいプレイリスト」のときだけ出す
  var elNewDeckName = $('listen-new-deck-name');
  var elFieldEn = $('listen-en');
  var elFieldJa = $('listen-ja');
  var elFieldNote = $('listen-note');
  var elEditStatus = $('listen-edit-status');
  var elSaveBtn = $('btn-listen-save');
  var elCloseBtn = $('btn-listen-close');
  var elDeleteBtn = $('btn-listen-delete');

  // プレイリストを作る・名前を変える・消すダイアログ
  var elDeckDialog = $('listen-deck-dialog');
  var elDeckList = $('listen-deck-manage-list');
  var elDeckNewName = $('listen-new-deck');
  var elDeckNewBtn = $('btn-listen-new-deck');
  var elDeckStatus = $('listen-deck-status');
  var elDeckCloseBtn = $('btn-listen-deck-close');

  /* ============================================================
   * 6. 保存
   * ========================================================== */

  function saveItems() { return writeJSON(LS_ITEMS, state.items); }
  function saveStars() { return writeJSON(LS_STARS, state.stars); }
  function saveDecks() { return writeJSON(LS_DECKS, state.decks); }

  function saveUI() {
    return writeJSON(LS_UI, {
      query: state.query, rate: state.rate, ai: state.ai, deck: state.deck
    });
  }

  // 1 文字打つたびに書くほどのものではないので、落ち着いてから書く
  var saveUISoon = debounce(saveUI, 400);

  function loadAll() {
    state.items = sanitizeItems(readJSON(LS_ITEMS));
    state.stars = sanitizeStars(readJSON(LS_STARS));
    state.decks = sanitizeDecks(readJSON(LS_DECKS));
    var ui = sanitizeUI(readJSON(LS_UI));
    state.query = ui.query.toLowerCase();
    state.rate = ui.rate;
    state.ai = ui.ai;
    // 前の版で listen:ui に入れていた人は、共通の設定へ引き継ぐ（1 回だけ）
    var dShare = sharedAi();
    if (dShare) {
      if (state.ai && !dShare.aiVoice()) dShare.setAiVoice(true);
      state.ai = dShare.aiVoice();
    }
    // 見ていたプレイリストが消えていたら「すべて」へ戻す
    state.deck = deckExists(ui.deck) ? ui.deck : DECK_ALL;
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

  /* --- プレイリスト ------------------------------------------- */

  function findDeck(id) {
    if (!id) return null;
    for (var i = 0; i < state.decks.length; i++) {
      if (state.decks[i].id === id) return state.decks[i];
    }
    return null;
  }

  /** 同じ名前のプレイリストを探す（大文字小文字は同じものとみなす） */
  function findDeckByName(name, exceptId) {
    var key = deckName(name).toLowerCase();
    if (!key) return null;
    for (var i = 0; i < state.decks.length; i++) {
      if (state.decks[i].id === exceptId) continue;
      if (state.decks[i].name.toLowerCase() === key) return state.decks[i];
    }
    return null;
  }

  /**
   * その文が入っているプレイリストの、絞り込みの値。
   * **もう無い id は「未分類」として扱う**（データは書き換えない）。
   * ほかの端末で作ったプレイリストの id が届くことがあるので、
   * ここで消してしまうと、その文がどの絞り込みにも出てこなくなる。
   */
  function deckKeyOf(item) {
    return (item && item.deck && findDeck(item.deck)) ? item.deck : DECK_NONE;
  }

  /** そのプレイリストに入っている文の数 */
  function deckCount(deckId) {
    var n = 0;
    for (var i = 0; i < state.items.length; i++) {
      if (deckKeyOf(state.items[i]) === deckId) n++;
    }
    return n;
  }

  /** どのプレイリストにも入っていない文の数（「未分類」を出すかの判断） */
  function noDeckCount() { return deckCount(DECK_NONE); }

  /** その絞り込みの値が選べるか。無くなったプレイリストは「すべて」へ戻す */
  function deckExists(key) {
    if (key === DECK_ALL) return true;
    if (key === DECK_NONE) return noDeckCount() > 0;
    return !!findDeck(key);
  }

  /** 知らせに出すための名前 */
  function deckLabel(key) {
    if (key === DECK_NONE) return '未分類';
    var d = findDeck(key);
    return d ? d.name : '';
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
    // 読み上げが使えない端末では 🔈 を出さない。**ただし AI の音声を使うなら出す**
    // （端末に声が入っていなくても、しまってある音なら鳴らせる）
    if (row.speakEl && !state.speechOK && !aiOn()) row.speakEl.hidden = true;

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

  /**
   * プレイリストの絞り込みを作り直す。**件数を添える** —
   * 選ぶ前に何件あるかが分かるように（瞬間英作文のセット選びと同じ見た目）。
   */
  function renderDeckSelect() {
    if (!elDeckSelect) return;
    var keep = state.deck;
    while (elDeckSelect.firstChild) elDeckSelect.removeChild(elDeckSelect.firstChild);

    var all = document.createElement('option');
    all.value = DECK_ALL;
    all.textContent = 'すべて（' + state.items.length + '）';
    elDeckSelect.appendChild(all);

    for (var i = 0; i < state.decks.length; i++) {
      var d = state.decks[i];
      var opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.name + '（' + deckCount(d.id) + '）';   // textContent で XSS を避ける
      elDeckSelect.appendChild(opt);
    }

    // 「未分類」は、そこに文があるときだけ出す（0 件の行は選ぶ意味がない）
    var none = noDeckCount();
    if (none) {
      var optNone = document.createElement('option');
      optNone.value = DECK_NONE;
      optNone.textContent = '未分類（' + none + '）';
      elDeckSelect.appendChild(optNone);
    }

    elDeckSelect.value = deckExists(keep) ? keep : DECK_ALL;
    state.deck = elDeckSelect.value;
  }

  /**
   * 追加・編集ダイアログの「入れ先」。**いちばん上に置く** —
   * どこに入るのかを、書き始める前に見せる（カードの取り込みと同じ考え方）。
   * 最後に「＋ 新しいプレイリスト」を出して、その場でも作れるようにする。
   */
  function renderDeckField(want) {
    if (!elFieldDeck) return;
    while (elFieldDeck.firstChild) elFieldDeck.removeChild(elFieldDeck.firstChild);

    for (var i = 0; i < state.decks.length; i++) {
      var opt = document.createElement('option');
      opt.value = state.decks[i].id;
      opt.textContent = state.decks[i].name;
      elFieldDeck.appendChild(opt);
    }

    var none = document.createElement('option');
    none.value = '';
    none.textContent = '未分類（どこにも入れない）';
    elFieldDeck.appendChild(none);

    var fresh = document.createElement('option');
    fresh.value = DECK_NEW;
    fresh.textContent = '＋ 新しいプレイリスト';
    elFieldDeck.appendChild(fresh);

    elFieldDeck.value = findDeck(want) ? want : '';
    syncNewDeckField();
  }

  /** 「＋ 新しいプレイリスト」を選んだときだけ、名前の欄を出す */
  function syncNewDeckField() {
    if (!elNewDeckField) return;
    elNewDeckField.hidden = !(elFieldDeck && elFieldDeck.value === DECK_NEW);
  }

  /** 新しく足すときの既定の入れ先。**いま選んでいるプレイリスト** */
  function defaultDeckId() {
    var cur = state.deck;
    return (cur && cur !== DECK_NONE && findDeck(cur)) ? cur : '';
  }

  /* --- プレイリストを作る・名前を変える・消す --------------------- */

  function setDeckStatus(message, isError) {
    if (!elDeckStatus) return;
    elDeckStatus.textContent = str(message);
    if (isError) elDeckStatus.setAttribute('data-error', 'true');
    else elDeckStatus.removeAttribute('data-error');
  }

  /**
   * プレイリストを作る。**名前だけ。** 空では作らず、同じ名前も作らない
   * （同じ名前が 2 つあると、どちらに入れたのか分からなくなる）。
   * @returns {?string} 作れたら id、作れなければ null
   */
  function createDeck(name, say) {
    var clean = deckName(name);
    if (!clean) {
      say('プレイリストの名前を入れてください。', true);
      return null;
    }
    var same = findDeckByName(clean);
    if (same) {
      say('「' + same.name + '」はもうあります。', true);
      return null;
    }
    var deck = { id: makeId('listendeck'), name: clean, created: Date.now() };
    state.decks.push(deck);
    saveDecks();
    renderDeckSelect();
    renderDeckManageList();
    say('「' + clean + '」を作りました。', false);
    return deck.id;
  }

  function renameDeck(deckId, name) {
    var deck = findDeck(deckId);
    if (!deck) return;
    var clean = deckName(name);
    if (!clean) {
      setDeckStatus('プレイリストの名前を入れてください。', true);
      renderDeckManageList();
      return;
    }
    if (clean === deck.name) { setDeckStatus('', false); return; }
    if (findDeckByName(clean, deckId)) {
      setDeckStatus('「' + clean + '」はもうあります。', true);
      renderDeckManageList();
      return;
    }
    var before = deck.name;
    deck.name = clean;
    saveDecks();
    renderDeckSelect();
    renderDeckManageList();
    setDeckStatus('「' + before + '」を「' + clean + '」にしました。', false);
  }

  /**
   * プレイリストを消す。**中の文は消さない** —
   * `deck` を `''` に戻して「未分類」にするだけ。
   * 聞く文そのものは本人の持ちもので、入れ物を片付けただけで消えては困る。
   */
  function deleteDeck(deckId) {
    var deck = findDeck(deckId);
    if (!deck) return;
    var n = deckCount(deckId);
    if (!window.confirm('プレイリスト「' + deck.name + '」を消します。'
      + '中の ' + n + ' 文は消えず、「未分類」に戻ります。よろしいですか？')) return;

    for (var i = state.decks.length - 1; i >= 0; i--) {
      if (state.decks[i].id === deckId) state.decks.splice(i, 1);
    }
    var moved = 0;
    for (var j = 0; j < state.items.length; j++) {
      if (state.items[j].deck !== deckId) continue;
      state.items[j].deck = '';
      moved++;
    }
    // 消したことを同期に覚えさせないと、もう片方の端末から戻ってくる
    noteDelete('listendeck:' + deckId);
    saveDecks();
    if (moved) saveItems();
    if (state.deck === deckId) state.deck = DECK_ALL;
    saveUI();

    if (state.started) rebuildKeepingView(render);
    else renderDeckSelect();
    renderDeckManageList();
    setDeckStatus('「' + deck.name + '」を消しました。'
      + (moved ? '中の ' + moved + ' 文は「未分類」に戻しました。' : ''), false);
    flashStatus('プレイリスト「' + deck.name + '」を消しました。中の文は残っています。');
  }

  /** プレイリストの一覧（名前を変える・消す）。件数も出す */
  function renderDeckManageList() {
    if (!elDeckList) return;
    while (elDeckList.firstChild) elDeckList.removeChild(elDeckList.firstChild);

    for (var i = 0; i < state.decks.length; i++) {
      (function (deck) {
        var li = document.createElement('li');
        li.setAttribute('data-deck-id', deck.id);

        // 名前は欄で直す。**Enter では保存しない**ので「変える」を押してもらう
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'field-input listen-deck-name';
        input.value = deck.name;
        input.autocomplete = 'off';
        input.setAttribute('aria-label', deck.name + ' の名前');
        blockEnter(input);
        li.appendChild(input);

        var count = document.createElement('span');
        count.className = 'listen-deck-count';
        count.textContent = deckCount(deck.id) + ' 文';
        li.appendChild(count);

        var ren = document.createElement('button');
        ren.type = 'button';
        ren.className = 'listen-deck-rename';
        ren.textContent = '変える';
        ren.setAttribute('aria-label', deck.name + ' の名前を変える');
        ren.addEventListener('click', function () { renameDeck(deck.id, input.value); });
        li.appendChild(ren);

        var del = document.createElement('button');
        del.type = 'button';
        del.textContent = '消す';
        del.setAttribute('aria-label', deck.name + ' を消す');
        del.addEventListener('click', function () { deleteDeck(deck.id); });
        li.appendChild(del);

        elDeckList.appendChild(li);
      })(state.decks[i]);
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

  /** 瞬間英作文（app.js）が持っている、AI の音声の入／切。
      **モードごとに別にしない** — 片方で入れたのにもう片方が切のままだと、
      同じ 🔈 を押しているのに声が変わる。 */
  function sharedAi() {
    var d = window.SUNKAN_DRILL;
    return (d && typeof d.aiVoice === 'function' && typeof d.setAiVoice === 'function') ? d : null;
  }

  /** AI の音を使うか。入れていても、しまう所が無ければ使えない */
  function aiOn() {
    var d = sharedAi();
    return !!((d ? d.aiVoice() : state.ai) && audioStore());
  }

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

  var PREFETCH_MAX = 20;    // 1 回に用意する上限。無料枠を知らないうちに使い切らない
  var PREFETCH_GAP = 400;   // 1 つ作るごとに置く間（置き場を叩き続けない）

  /**
   * **押される前に作っておく。**
   * 押してから作ると 2〜3 秒かかり、そのあいだ無音で「反応が遅い」ように見える。
   * 画面を開いたときに、**見えている行のぶんだけ**静かに用意しておく。
   * 無料枠を無駄にしないよう、上限つき・1 つずつ・1 回でも失敗したらそこで止める。
   */
  function prefetchAudio() {
    if (!aiOn() || !ttsPort()) return;
    if (window.navigator.onLine === false) return;
    if (state.prefetching) return;
    if (docEl.getAttribute('data-mode') !== 'listen') return;

    var queue = [], i, row;
    for (i = 0; i < state.rows.length && queue.length < PREFETCH_MAX; i++) {
      row = state.rows[i];
      if (!row.el || row.el.hidden) continue;            // 絞り込みで消えている行はしない
      if (!trim(speechText(row.en))) continue;
      queue.push(row);
    }
    if (!queue.length) return;
    state.prefetching = true;
    runPrefetch(queue, 0, 0);
  }

  function runPrefetch(queue, i, made) {
    var store = audioStore();
    var done = function () {
      state.prefetching = false;
      if (made) flashStatus('音を ' + made + ' 文ぶん用意しました。押すとすぐ鳴ります。');
    };
    if (!store || i >= queue.length) { done(); return; }

    var row = queue[i];
    var text = speechText(row.en);
    var key = store.keyFor(text, 'ai');

    store.get(key).then(function (rec) {
      if (rec) {                                   // もうある
        markAudio(row, true);
        runPrefetch(queue, i + 1, made);
        return;
      }
      var port = ttsPort();
      if (!port) { done(); return; }
      port.tts(text).then(function (res) {
        if (!res || !res.ok || !res.blob) {
          // 枠切れや設定違いのことがある。叩き続けず、ここで止める
          state.prefetching = false;
          return;
        }
        store.put(key, res.blob).then(function () {
          markAudio(row, true);
          window.setTimeout(function () { runPrefetch(queue, i + 1, made + 1); }, PREFETCH_GAP);
        }, function () { state.prefetching = false; });
      }, function () { state.prefetching = false; });
    }, function () { state.prefetching = false; });
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
    var d = sharedAi();
    if (d) state.ai = d.aiVoice();   // 設定で入れ替わっていることがある
    if (!elAiBtn) return;
    elAiBtn.setAttribute('aria-pressed', state.ai ? 'true' : 'false');
    elAiBtn.classList.toggle('is-on', !!state.ai);
  }

  function toggleAi() {
    var d = sharedAi();
    state.ai = !(d ? d.aiVoice() : state.ai);
    if (d) d.setAiVoice(state.ai);
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
    flashStatus('AI の音声にしました。見えている文のぶんを、いま用意します。');
    window.setTimeout(prefetchAudio, 300);
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
    var deck = state.deck;
    var visible = 0;

    for (var i = 0; i < state.rows.length; i++) {
      var row = state.rows[i];
      if (!row.el) continue;
      // プレイリストと検索は**両方**に当てはまったものだけ出す
      var ok = true;
      if (deck !== DECK_ALL) ok = deckKeyOf(row.item) === deck;
      if (ok && q) {
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
        // 空のプレイリストを選んだだけなのに「該当なし」だと、
        // 探し方が悪いのかデータが無いのかが分からない
        elEmpty.textContent = (!q && deck !== DECK_ALL)
          ? '「' + deckLabel(deck) + '」にはまだ文がありません。「＋ 追加」から足せます。'
          : '該当する文がありません。';
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
    var parts = [];
    // どのプレイリストを見ているかを先に出す（絞っていることを忘れさせない）
    if (state.deck !== DECK_ALL) parts.push(deckLabel(state.deck));
    parts.push('全 ' + state.items.length + ' 文');
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
    if (state.deck === DECK_NONE) return '「未分類」で絞っているので、一覧には出ていません。';
    if (state.deck) {
      return '「' + deckLabel(state.deck) + '」で絞っているので、一覧には出ていません。';
    }
    return '絞り込みに当てはまらないので、一覧には出ていません。';
  }

  /* ============================================================
   * 12. 作り直し（見ていた所は元に戻す）
   * ========================================================== */

  function render() {
    renderDeckSelect();   // 件数が変わるので、行より先に作り直す
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

    // 入れ先。直すときはその文の入っている所、**新しく足すときは
    // いま選んでいるプレイリスト**を既定にする（毎回選び直させない）。
    renderDeckField(item ? item.deck : defaultDeckId());
    if (elNewDeckName) elNewDeckName.value = '';

    if (elFieldEn) elFieldEn.value = item ? item.en : '';
    if (elFieldJa) elFieldJa.value = item ? item.ja : '';
    if (elFieldNote) elFieldNote.value = item ? item.note : '';
    if (elSaveBtn) elSaveBtn.textContent = item ? '保存する' : '追加する';
    // 消すのは「直す」ときだけ。足す前の空の行は消せない
    if (elDeleteBtn) elDeleteBtn.hidden = !item;
    setEditStatus('', false);

    openDialog(elEditDialog, invoker);
    if (elFieldEn) elFieldEn.focus();
    // 入れ先はいちばん上にある。中ほどまでスクロールした状態で開くと見落とす
    if (elEditDialog) elEditDialog.scrollTop = 0;
  }

  /**
   * ダイアログで選ばれている入れ先を決める。「＋ 新しいプレイリスト」なら
   * **その場で作る**（作れなければ null を返して、保存そのものを止める）。
   * @returns {?string} プレイリストの id（`''` は未分類）／作れなければ null
   */
  function pickDeckFromDialog() {
    if (!elFieldDeck) return '';
    var v = elFieldDeck.value;
    if (v !== DECK_NEW) return findDeck(v) ? v : '';

    var made = createDeck(elNewDeckName ? elNewDeckName.value : '', setEditStatus);
    if (!made) {
      if (elNewDeckName) elNewDeckName.focus();
      return null;
    }
    // 作ったプレイリストをそのまま入れ先にする
    renderDeckField(made);
    if (elNewDeckName) elNewDeckName.value = '';
    return made;
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

    // 入れ先を先に決める。新しいプレイリストが作れなかったときは、
    // 文のほうも保存しない（どこに入ったのか分からない状態を作らない）
    var deckId = pickDeckFromDialog();
    if (deckId === null) return;

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
      item.deck = deckId;
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
      deck: deckId,
      created: Date.now()
    };
    state.items.push(fresh);
    saveItems();
    rebuildKeepingView(render);

    // 欄を空にして、そのまま次の 1 文を入れられるようにする。
    // **入れ先はそのまま残す**（続けて同じプレイリストに入れることが多い）
    if (elFieldEn) elFieldEn.value = '';
    if (elFieldJa) elFieldJa.value = '';
    if (elFieldNote) elFieldNote.value = '';
    if (elFieldEn) elFieldEn.focus();

    // 足したものが絞り込みで隠れているなら、そう言う。黙っていると
    //「追加したのに出てこない」＝足せていないように見える。
    var note2 = isFilteredOut(fresh.id) ? ' ' + whyHidden() : '';
    var into = deckId ? '「' + deckLabel(deckId) + '」に' : '';
    setEditStatus(into + '追加しました。続けて入力できます。' + note2, false);
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

    // プレイリストで絞る。検索との組み合わせは applyFilter が両方見る
    if (elDeckSelect) {
      elDeckSelect.addEventListener('change', function () {
        state.deck = elDeckSelect.value;
        saveUI();
        applyFilter();
      });
    }

    if (elDecksBtn) {
      elDecksBtn.addEventListener('click', function () {
        renderDeckManageList();
        if (elDeckNewName) elDeckNewName.value = '';
        setDeckStatus('', false);
        openDialog(elDeckDialog, elDecksBtn);
        if (elDeckDialog) elDeckDialog.scrollTop = 0;
      });
    }
    if (elDeckNewBtn) {
      elDeckNewBtn.addEventListener('click', function () {
        var made = createDeck(elDeckNewName ? elDeckNewName.value : '', setDeckStatus);
        if (!made) { if (elDeckNewName) elDeckNewName.focus(); return; }
        if (elDeckNewName) elDeckNewName.value = '';
        if (elDeckNewName) elDeckNewName.focus();
      });
    }
    if (elDeckCloseBtn) {
      elDeckCloseBtn.addEventListener('click', function () { closeDialog(elDeckDialog); });
    }

    // 「＋ 新しいプレイリスト」を選んだときだけ名前の欄を出す
    if (elFieldDeck) {
      elFieldDeck.addEventListener('change', function () {
        syncNewDeckField();
        if (elFieldDeck.value === DECK_NEW && elNewDeckName) elNewDeckName.focus();
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
    // 新しい欄にも必ず付ける。<form method="dialog"> の中なので、
    // 素通しすると Enter で黙って閉じて、書いたものが消える
    blockEnter(elFieldDeck);
    blockEnter(elNewDeckName);
    blockEnter(elDeckNewName);

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
   * list は `[{en, ja, note, deck}]`。英語はスラッシュ入りのまま渡してよい。
   * 同じ英文は飛ばす。
   *
   * `deck` はプレイリストの id（`decks()` で取れる）。**無ければ `''`**＝未分類。
   * 知らない id が来たら `''` にする（指す先の無い所へは入れない）。
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
      var deck = trim(raw.deck);
      if (deck && !findDeck(deck)) deck = '';   // 知らない id は未分類にする
      lastId = makeId('listen');
      state.items.push({
        id: lastId,
        en: en,
        ja: trim(raw.ja),
        note: trim(raw.note),
        deck: deck,
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
    // 画面が出てから。先に描き切らないと、開いた瞬間がもたつく
    window.setTimeout(prefetchAudio, 600);
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
      renderDeckSelect();
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

  /**
   * プレイリストの一覧 `[{id, name, count}]`。取り込みの「入れ先」を
   * 作るためのもの（`SUNKAN_CARDS.decks()` と同じ役目）。
   * **取り込み側に直に保存させない**ための口なので、読むだけ。
   */
  function deckList() {
    var out = [];
    for (var i = 0; i < state.decks.length; i++) {
      out.push({
        id: state.decks[i].id,
        name: state.decks[i].name,
        count: deckCount(state.decks[i].id)
      });
    }
    return out;
  }

  /** いま絞り込んでいるプレイリストの id（`''` は「すべて」か「未分類」） */
  function currentDeckId() { return defaultDeckId(); }

  /**
   * 名前からプレイリストを用意する。同じ名前があればその id を返す
   * （**同じ名前は作らない**）。名前が空なら null。
   * @returns {?string} プレイリストの id
   */
  function ensureDeck(name) {
    var clean = deckName(name);
    if (!clean) return null;
    var same = findDeckByName(clean);
    if (same) return same.id;
    var deck = { id: makeId('listendeck'), name: clean, created: Date.now() };
    state.decks.push(deck);
    saveDecks();
    renderDeckSelect();
    renderDeckManageList();
    return deck.id;
  }

  window.SUNKAN_LISTEN = {
    onShow: onShow,
    onHide: onHide,
    reload: reloadFromStorage,
    addItems: addItems,
    decks: deckList,
    currentDeckId: currentDeckId,
    ensureDeck: ensureDeck
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
    renderDeckSelect();

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
