/*!
 * 瞬間英作文 — 動作すべて（描画・隠す/表示・検索・取り込み・保存）
 * 素の ES2019 ブラウザ JavaScript。モジュール・外部ライブラリ・ビルド不要。
 * DOM の定義は index.html、取り決めは CONTRACT.md を参照（どちらも変更しない）。
 */
(function () {
  'use strict';

  /* ============================================================
   * 1. 定数
   * ========================================================== */

  var LS_SETTINGS = 'sunkan:settings';
  var LS_DECKS = 'sunkan:decks';
  var LS_STARS = 'sunkan:stars';
  var LS_ADDED = 'sunkan:added';   // アプリ内で 1 文ずつ足した分（デッキ id ごと）

  var MASK_STYLES = ['blur', 'block', 'hidden'];
  var DIRECTIONS = ['ja-en', 'en-ja'];
  var FONT_LABELS = ['最小', '小', '標準', '大', '最大'];

  // 配信のたびに上げる。設定ダイアログに出して、
  // 「更新が届いているのか」を推測せず確認できるようにするためのもの。
  var APP_VERSION = 'build 5 (2026-08-16)';

  var SEARCH_DEBOUNCE = 120;   // 検索のデバウンス（ミリ秒）
  var PREVIEW_DEBOUNCE = 150;  // 取り込みプレビューのデバウンス（ミリ秒）

  var DEFAULT_SETTINGS = {
    maskStyle: 'blur',
    fontSize: 2,
    autoHide: false,
    direction: 'ja-en',
    starredOnly: false,
    autoSpeak: false,
    deckId: ''
  };

  /* ============================================================
   * 2. 小さなユーティリティ
   * ========================================================== */

  var docEl = document.documentElement;

  function $(id) { return document.getElementById(id); }

  /** 文字列として安全に取り出す（null/undefined/数値もOK） */
  function str(v) {
    if (v === null || v === undefined) return '';
    return typeof v === 'string' ? v : String(v);
  }

  /** 前後の空白と BOM を落とす */
  function trim(v) {
    return str(v).replace(/^[\uFEFF\s]+|\s+$/g, '');
  }

  function isBool(v) { return v === true || v === false; }

  function clampInt(v, min, max, fallback) {
    var n = parseInt(v, 10);
    if (isNaN(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function inList(v, list, fallback) {
    return list.indexOf(v) >= 0 ? v : fallback;
  }

  /** 安定した短いハッシュ（項目 id の生成に使う） */
  function hashString(s) {
    var h = 5381, i;
    for (i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments, self = this;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        fn.apply(self, args);
      }, wait);
    };
  }

  /** 入力中かどうか（キーボードショートカットを無効にする判定） */
  function isTypingTarget(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    var tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'option';
  }

  function anyDialogOpen() {
    return !!document.querySelector('dialog[open]');
  }

  /* ============================================================
   * 3. localStorage（Safari のプライベートモードは例外を投げる）
   * ========================================================== */

  function lsGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function lsSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (e) {
      return false; // 保存できなくてもアプリは動き続ける
    }
  }

  function readJSON(key) {
    var raw = lsGet(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function writeJSON(key, value) {
    var text;
    try {
      text = JSON.stringify(value);
    } catch (e) {
      return false;
    }
    return lsSet(key, text);
  }

  /* ============================================================
   * 4. 保存データの検証（localStorage の中身は信用しない）
   * ========================================================== */

  function sanitizeSettings(raw) {
    var s = {
      maskStyle: DEFAULT_SETTINGS.maskStyle,
      fontSize: DEFAULT_SETTINGS.fontSize,
      autoHide: DEFAULT_SETTINGS.autoHide,
      direction: DEFAULT_SETTINGS.direction,
      starredOnly: DEFAULT_SETTINGS.starredOnly,
      autoSpeak: DEFAULT_SETTINGS.autoSpeak,
      deckId: DEFAULT_SETTINGS.deckId
    };
    if (!raw || typeof raw !== 'object') return s;
    s.maskStyle = inList(str(raw.maskStyle), MASK_STYLES, s.maskStyle);
    s.fontSize = clampInt(raw.fontSize, 0, 4, s.fontSize);
    s.direction = inList(str(raw.direction), DIRECTIONS, s.direction);
    if (isBool(raw.autoHide)) s.autoHide = raw.autoHide;
    if (isBool(raw.starredOnly)) s.starredOnly = raw.starredOnly;
    if (isBool(raw.autoSpeak)) s.autoSpeak = raw.autoSpeak;
    if (typeof raw.deckId === 'string') s.deckId = raw.deckId;
    return s;
  }

  /** デッキ 1 件を検証。だめなら null */
  function sanitizeDeck(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var id = trim(raw.id);
    var name = trim(raw.name);
    if (!id) return null;
    if (!name) name = id;
    var items = [];
    var srcItems = Array.isArray(raw.items) ? raw.items : [];
    for (var i = 0; i < srcItems.length; i++) {
      var it = srcItems[i];
      if (!it || typeof it !== 'object') continue;
      var ja = trim(it.ja);
      var en = trim(it.en);
      if (!ja || !en) continue;
      items.push({ ja: ja, en: en, note: trim(it.note), id: typeof it.id === 'string' ? it.id : '' });
    }
    return {
      id: id,
      name: name,
      description: trim(raw.description),
      items: items
    };
  }

  function sanitizeDeckList(raw) {
    var out = [];
    var seen = {};
    if (!Array.isArray(raw)) return out;
    for (var i = 0; i < raw.length; i++) {
      var d = sanitizeDeck(raw[i]);
      if (!d) continue;
      if (seen[d.id]) continue; // id 重複は先勝ち
      seen[d.id] = true;
      out.push(d);
    }
    return out;
  }

  /** { deckId: [itemId, ...] } の形に整える */
  function sanitizeStars(raw) {
    var out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (var key in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
      var arr = raw[key];
      if (!Array.isArray(arr)) continue;
      var ids = [];
      for (var i = 0; i < arr.length; i++) {
        if (typeof arr[i] === 'string' && arr[i]) ids.push(arr[i]);
      }
      out[key] = ids;
    }
    return out;
  }

  /** { deckId: [{ja,en,note}, ...] } の形に整える。壊れた項目は落とす */
  function sanitizeAdded(raw) {
    var out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (var key in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
      var arr = raw[key];
      if (!Array.isArray(arr)) continue;
      var items = [];
      for (var i = 0; i < arr.length; i++) {
        var it = arr[i];
        if (!it || typeof it !== 'object') continue;
        var ja = trim(it.ja), en = trim(it.en);
        if (!ja || !en) continue;
        items.push({ ja: ja, en: en, note: trim(it.note) });
      }
      if (items.length) out[key] = items;
    }
    return out;
  }

  /* ============================================================
   * 5. 取り込みパーサ（TSV / CSV）
   *    ここは DOM に依存しない純粋関数（テストしやすいように分離）
   * ========================================================== */
  /* --- parse:begin --- */

  /**
   * 区切り文字の自動判定。
   * 引用符の外側だけを見て「タブを含む行」「カンマを含む行」を数え、
   * タブが過半数の行にあればタブ、なければカンマ。
   */
  function detectDelimiter(text) {
    var inQuotes = false;
    var lineHasTab = false, lineHasComma = false, lineHasContent = false;
    var lines = 0, tabLines = 0, commaLines = 0;
    var i, c;

    function endLine() {
      if (!lineHasContent) return;
      lines++;
      if (lineHasTab) tabLines++;
      if (lineHasComma) commaLines++;
    }

    for (i = 0; i < text.length; i++) {
      c = text.charAt(i);
      if (inQuotes) {
        if (c === '"') {
          if (text.charAt(i + 1) === '"') { i++; } else { inQuotes = false; }
        }
        continue; // 引用符の中の改行・区切り文字は数えない
      }
      if (c === '"') { inQuotes = true; lineHasContent = true; continue; }
      if (c === '\t') { lineHasTab = true; lineHasContent = true; continue; }
      if (c === ',') { lineHasComma = true; lineHasContent = true; continue; }
      if (c === '\r' || c === '\n') {
        if (c === '\r' && text.charAt(i + 1) === '\n') i++;
        endLine();
        lineHasTab = false; lineHasComma = false; lineHasContent = false;
        continue;
      }
      if (c !== ' ' && c !== '\uFEFF') lineHasContent = true;
    }
    endLine();

    if (lines === 0) return '\t';
    if (tabLines > 0 && tabLines * 2 >= lines) return '\t';
    if (commaLines > 0) return ',';
    return '\t';
  }

  /**
   * RFC 4180 風のパーサ。CRLF / CR / LF、"" によるエスケープ、
   * 引用符内の改行とカンマに対応する。
   */
  function parseDelimited(text, delim) {
    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    var i = 0;
    var n = text.length;
    var c;

    while (i < n) {
      c = text.charAt(i);

      if (inQuotes) {
        if (c === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }

      if (c === '"' && field === '') { inQuotes = true; i++; continue; }

      if (c === delim) { row.push(field); field = ''; i++; continue; }

      if (c === '\r' || c === '\n') {
        if (c === '\r' && text.charAt(i + 1) === '\n') i++;
        row.push(field); rows.push(row);
        row = []; field = ''; i++;
        continue;
      }

      field += c; i++;
    }

    row.push(field);
    rows.push(row);
    return rows;
  }

  /** 見出し行っぽいか（日本語/英語 などの語が並んでいる） */
  function looksLikeHeader(cells) {
    if (!cells || cells.length < 2) return false;
    var reJa = /^(日本語|和文|和訳|japanese|ja|jp|jpn)$/i;
    var reEn = /^(英語|英文|english|en|eng)$/i;
    var a = trim(cells[0]).toLowerCase();
    var b = trim(cells[1]).toLowerCase();
    return reJa.test(a) || reEn.test(b) || reEn.test(a) || reJa.test(b);
  }

  /**
   * 貼り付けテキストを { items, rowCount, delimiter, skipped, headerDropped } に変換。
   * 2 列目までが必須、3 列目があれば note。
   */
  function parseImportText(text) {
    var result = {
      items: [],
      delimiter: '\t',
      skipped: 0,
      headerDropped: false
    };
    var src = str(text).replace(/^\uFEFF/, '');
    if (!trim(src)) return result;

    var delim = detectDelimiter(src);
    result.delimiter = delim;

    var rows = parseDelimited(src, delim);
    var cleaned = [];
    var i, j, cells, row;

    for (i = 0; i < rows.length; i++) {
      row = rows[i];
      cells = [];
      var nonEmpty = 0;
      for (j = 0; j < row.length; j++) {
        var cell = trim(row[j]);
        cells.push(cell);
        if (cell) nonEmpty++;
      }
      if (nonEmpty === 0) continue;      // 空行はスキップ
      cells._nonEmpty = nonEmpty;
      cleaned.push(cells);
    }

    if (cleaned.length && looksLikeHeader(cleaned[0])) {
      cleaned.shift();
      result.headerDropped = true;
    }

    for (i = 0; i < cleaned.length; i++) {
      cells = cleaned[i];
      // 有効なセルが 2 つ未満、または 1・2 列目が欠けている行は捨てる
      if (cells._nonEmpty < 2 || !cells[0] || !cells[1]) {
        result.skipped++;
        continue;
      }
      result.items.push({
        ja: cells[0],
        en: cells[1],
        note: cells.length > 2 ? cells[2] : ''
      });
    }

    return result;
  }

  /** {ja,en,note} の配列を TSV 文字列に（タブ・改行はスペースに潰す） */
  function itemsToTSV(items) {
    var lines = [];
    items = items || [];
    var hasNote = false;
    var i;
    for (i = 0; i < items.length; i++) {
      if (trim(items[i].note)) { hasNote = true; break; }
    }
    function flat(v) {
      return str(v).replace(/[\t\r\n]+/g, ' ');
    }
    for (i = 0; i < items.length; i++) {
      var cols = [flat(items[i].ja), flat(items[i].en)];
      if (hasNote) cols.push(flat(items[i].note));
      lines.push(cols.join('\t'));
    }
    return lines.join('\n');
  }

  /* --- parse:end --- */

  /* ============================================================
   * 6. アプリ状態
   * ========================================================== */

  var state = {
    builtinDecks: [],
    userDecks: [],
    deck: null,
    records: [],      // 元の並び（{ id, ja, en, note, jaLower, enLower, el, numEl, mainEl, starEl }）
    order: [],        // 表示順（records の参照の配列）
    byId: {},
    shuffled: false,
    query: '',
    stars: {},        // { deckId: [itemId...] }
    added: {},        // { deckId: [{ja,en,note}...] } アプリ内で足した文
    settings: sanitizeSettings(readJSON(LS_SETTINGS)),
    currentId: null,
    lastRevealed: null,
    visibleCount: 0,
    speechOK: false,
    lastFocus: null
  };

  /* ============================================================
   * 7. 設定の適用と保存
   * ========================================================== */

  /** <html> に設定を反映（ちらつき防止のため最初に一度呼ぶ） */
  function applySettingsToRoot() {
    docEl.setAttribute('data-mask', state.settings.maskStyle);
    docEl.setAttribute('data-font', String(state.settings.fontSize));
    docEl.setAttribute('data-direction', state.settings.direction);
  }

  function saveSettings() {
    writeJSON(LS_SETTINGS, state.settings);
  }

  applySettingsToRoot(); // ← DOM 参照より前に実行

  /* ============================================================
   * 8. DOM 参照
   * ========================================================== */

  var elRows = $('rows');
  var elRowTemplate = $('row-template');
  var elEmptyState = $('empty-state');
  var elStatusBar = $('status-bar');
  var elDeckSelect = $('deck-select');
  var elSearch = $('search');
  var elSearchClear = $('btn-search-clear');
  var elToggleAll = $('btn-toggle-all');
  var elToggleAllLabel = $('btn-toggle-all-label');
  var elShuffle = $('btn-shuffle');
  var elBtnData = $('btn-data');
  var elBtnSettings = $('btn-settings');

  var elBtnAdd = $('btn-add');
  var elBtnAddRow = $('btn-add-row');
  var elAddDialog = $('add-dialog');
  var elAddDeckName = $('add-deck-name');
  var elAddJa = $('add-ja');
  var elAddEn = $('add-en');
  var elAddNote = $('add-note');
  var elAddStatus = $('add-status');
  var elAddSave = $('btn-add-save');
  var elAddClose = $('btn-add-close');
  var elAddedList = $('added-list');
  var elNewDeckName = $('new-deck-name');
  var elNewDeck = $('btn-new-deck');

  var elDataDialog = $('data-dialog');
  var elImportName = $('import-name');
  var elImportText = $('import-text');
  var elImportPreview = $('import-preview');
  var elImportCancel = $('btn-import-cancel');
  var elImportSave = $('btn-import-save');
  var elDeckManageList = $('deck-manage-list');
  var elExport = $('btn-export');

  var elSettingsDialog = $('settings-dialog');
  var elSettingsClose = $('btn-settings-close');
  var elOptAutoHide = $('opt-auto-hide');
  var elOptHideJa = $('opt-hide-ja');
  var elOptStarredOnly = $('opt-starred-only');
  var elOptAutoSpeak = $('opt-auto-speak');
  var elAppVersion = $('app-version');
  var elOptFontSize = $('opt-font-size');
  var elOptFontOut = $('opt-font-size-out');

  /* ============================================================
   * 9. デッキの読み込み
   * ========================================================== */

  function loadBuiltinDecks() {
    var raw = window.SUNKAN_DECKS;
    // data.js が無い / 空 / 形が違う場合もそのまま動かす
    return sanitizeDeckList(Array.isArray(raw) ? raw : []);
  }

  function loadUserDecks() {
    return sanitizeDeckList(readJSON(LS_DECKS));
  }

  function saveUserDecks() {
    return writeJSON(LS_DECKS, state.userDecks);
  }

  function allDecks() {
    return state.builtinDecks.concat(state.userDecks);
  }

  function findDeck(id) {
    var list = allDecks();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  function makeUserDeckId() {
    var base = 'user-' + Date.now().toString(36);
    var id = base;
    var n = 1;
    while (findDeck(id)) { n++; id = base + '-' + n; }
    return id;
  }

  /** <select> にデッキを並べる（収録セット / 自作セット） */
  function renderDeckSelect() {
    if (!elDeckSelect) return;
    while (elDeckSelect.firstChild) elDeckSelect.removeChild(elDeckSelect.firstChild);

    function addGroup(label, decks) {
      if (!decks.length) return;
      var group = document.createElement('optgroup');
      group.label = label;
      for (var i = 0; i < decks.length; i++) {
        var opt = document.createElement('option');
        opt.value = decks[i].id;
        opt.textContent = decks[i].name; // textContent で XSS を避ける
        group.appendChild(opt);
      }
      elDeckSelect.appendChild(group);
    }

    addGroup('収録セット', state.builtinDecks);
    addGroup('自作セット', state.userDecks);

    if (!allDecks().length) {
      var opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'セットがありません';
      elDeckSelect.appendChild(opt);
      elDeckSelect.disabled = true;
    } else {
      elDeckSelect.disabled = false;
      if (state.deck) elDeckSelect.value = state.deck.id;
    }
  }

  /* ============================================================
   * 10. ★（チェック）の保存
   * ========================================================== */

  /* --- アプリ内で足した文 ------------------------------------- */

  function loadAdded() {
    state.added = sanitizeAdded(readJSON(LS_ADDED));
  }

  function saveAdded() {
    writeJSON(LS_ADDED, state.added);
  }

  function addedFor(deckId) {
    if (!deckId) return [];
    return state.added[deckId] || [];
  }

  /** 1 文足す。同じ内容が既にあれば false を返す */
  function addSentence(deckId, ja, en, note) {
    if (!deckId || !ja || !en) return false;
    var list = state.added[deckId] || (state.added[deckId] = []);
    for (var i = 0; i < list.length; i++) {
      if (list[i].ja === ja && list[i].en === en) return false;
    }
    list.push({ ja: ja, en: en, note: note || '' });
    saveAdded();
    return true;
  }

  /** 足した文を 1 件消す（deck の元データには触らない） */
  function removeAddedSentence(deckId, ja, en) {
    var list = state.added[deckId];
    if (!list) return false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].ja === ja && list[i].en === en) {
        list.splice(i, 1);
        if (!list.length) delete state.added[deckId];
        saveAdded();
        return true;
      }
    }
    return false;
  }

  function loadStars() {
    state.stars = sanitizeStars(readJSON(LS_STARS));
  }

  function saveStars() {
    writeJSON(LS_STARS, state.stars);
  }

  function starListFor(deckId) {
    if (!state.stars[deckId]) state.stars[deckId] = [];
    return state.stars[deckId];
  }

  function isStarred(deckId, itemId) {
    var list = state.stars[deckId];
    return !!list && list.indexOf(itemId) >= 0;
  }

  function setStar(deckId, itemId, on) {
    var list = starListFor(deckId);
    var idx = list.indexOf(itemId);
    if (on && idx < 0) list.push(itemId);
    if (!on && idx >= 0) list.splice(idx, 1);
    saveStars();
  }

  /* ============================================================
   * 11. 行の生成と描画
   * ========================================================== */

  /** デッキの items から表示用レコードを作る（id は内容から安定生成） */
  function buildRecords(deck) {
    var records = [];
    var used = {};
    var base = (deck && deck.items) || [];
    var extra = addedFor(deck && deck.id);
    // 収録データの後ろに、アプリ内で足した分をつなげる。
    // 元のデッキ（data.js やユーザーの取り込み）は書き換えない。
    var items = base.concat(extra);
    var firstAdded = base.length;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var id = trim(it.id);
      if (!id) {
        id = hashString(it.ja + '\u0001' + it.en);
      }
      if (used[id]) {
        var n = 2;
        while (used[id + '-' + n]) n++;
        id = id + '-' + n;
      }
      used[id] = true;
      records.push({
        id: id,
        ja: it.ja,
        en: it.en,
        note: it.note || '',
        jaLower: it.ja.toLowerCase(),
        enLower: it.en.toLowerCase(),
        noteLower: (it.note || '').toLowerCase(),
        added: i >= firstAdded,
        el: null,
        numEl: null,
        mainEl: null,
        starEl: null,
        revealed: false
      });
    }
    return records;
  }

  /** テンプレートから 1 行つくる。データは必ず textContent で入れる */
  function createRowElement(record) {
    var frag = elRowTemplate.content.cloneNode(true);
    var li = frag.querySelector('.row');
    var main = li.querySelector('.row-main');
    var numEl = li.querySelector('.cell--num');
    var jaEl = li.querySelector('.cell--ja');
    var enTextEl = li.querySelector('.en-text');
    var starEl = li.querySelector('.row-star');
    var speakEl = li.querySelector('.row-speak');

    li.setAttribute('data-id', record.id);
    jaEl.textContent = record.ja;
    enTextEl.textContent = record.en;

    // note は日本語側（＝出題側）に小さく添える。
    // <small> なので CSS が無くても小さめの文字として自然に崩れない。
    if (record.note) {
      var note = document.createElement('small');
      note.className = 'note';
      note.textContent = record.note;
      jaEl.appendChild(note);
      // title 属性は付けない。行にカーソルを置いただけでツールチップが出て、
      // 答えを考えている最中にヒントが見えてしまうため。
    }

    if (starEl) {
      var starred = isStarred(state.deck ? state.deck.id : '', record.id);
      if (starred) {
        li.classList.add('is-starred');
        starEl.setAttribute('aria-pressed', 'true');
        starEl.setAttribute('aria-label', 'チェックを外す');
      }
    }

    // 読み上げ API が無い環境ではボタンごと隠す
    if (speakEl && !state.speechOK) speakEl.hidden = true;

    // 自分で足した文だけ、その場で消せるようにする。
    // 収録データや取り込んだ表は、行単位では消せない（セットごと削除する）。
    if (record.added) {
      li.classList.add('is-added');
      var delEl = li.querySelector('.row-delete');
      if (delEl) delEl.hidden = false;
    }

    record.el = li;
    record.numEl = numEl;
    record.mainEl = main;
    record.starEl = starEl;
    return li;
  }

  /** #rows を order の順に組み立て直す（DocumentFragment で 1 回だけ挿入） */
  function renderRows() {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < state.order.length; i++) {
      var rec = state.order[i];
      if (!rec.el) createRowElement(rec);
      frag.appendChild(rec.el);
    }
    while (elRows.firstChild) elRows.removeChild(elRows.firstChild);
    elRows.appendChild(frag);
    renumber();
  }

  /** .cell--num を表示順で振り直す */
  function renumber() {
    for (var i = 0; i < state.order.length; i++) {
      var rec = state.order[i];
      if (rec.numEl) rec.numEl.textContent = String(i + 1);
    }
  }

  /* ============================================================
   * 12. デッキの切り替え
   * ========================================================== */

  function selectDeck(deckId, opts) {
    opts = opts || {};
    var deck = findDeck(deckId);
    if (!deck) {
      var list = allDecks();
      deck = list.length ? list[0] : null;
    }
    state.deck = deck;
    state.records = deck ? buildRecords(deck) : [];
    state.byId = {};
    for (var i = 0; i < state.records.length; i++) {
      state.byId[state.records[i].id] = state.records[i];
    }
    state.order = state.records.slice();
    state.shuffled = false;
    state.currentId = null;
    state.lastRevealed = null;

    if (deck) {
      state.settings.deckId = deck.id;
      if (opts.persist !== false) saveSettings();
    }

    updateShuffleButton();
    renderRows();
    applyFilter();
    syncToggleAllButton();
    if (elDeckSelect && deck) elDeckSelect.value = deck.id;
  }

  /* ============================================================
   * 13. 隠す / 表示する
   * ========================================================== */

  function directionWord() {
    return state.settings.direction === 'en-ja' ? '日本語' : '英語';
  }

  function setRevealed(rec, on) {
    if (!rec || !rec.el) return;
    if (rec.revealed === on) return;
    rec.revealed = on;
    if (on) {
      rec.el.classList.add('is-revealed');
      if (rec.mainEl) rec.mainEl.setAttribute('aria-expanded', 'true');
    } else {
      rec.el.classList.remove('is-revealed');
      if (rec.mainEl) rec.mainEl.setAttribute('aria-expanded', 'false');
    }
  }

  function toggleRow(rec) {
    if (!rec) return;
    var next = !rec.revealed;
    if (next && state.settings.autoHide && state.lastRevealed && state.lastRevealed !== rec) {
      setRevealed(state.lastRevealed, false); // 1 行だけ開く
    }
    setRevealed(rec, next);
    state.lastRevealed = next ? rec : null;
    setCurrent(rec, false);
    syncToggleAllButton();
    if (next) maybeAutoSpeak(rec);
  }

  /** 「表示したら自動で読み上げる」設定のときだけ喋る。
      逆向き（英語→日本語）のときは英語が最初から見えているので読み上げない。 */
  function maybeAutoSpeak(rec) {
    if (!rec || !state.settings.autoSpeak) return;
    if (state.settings.direction === 'en-ja') return;
    speak(rec.en);
  }

  function setAllRevealed(on) {
    for (var i = 0; i < state.records.length; i++) {
      setRevealed(state.records[i], on);
    }
    state.lastRevealed = null;
    syncToggleAllButton();
  }

  function anyRevealed() {
    for (var i = 0; i < state.records.length; i++) {
      if (state.records[i].revealed) return true;
    }
    return false;
  }

  /** aria-pressed="true" は「今ぜんぶ隠れている」。ラベルは次にやる操作を書く */
  function syncToggleAllButton() {
    if (!elToggleAll) return;
    var allHidden = !anyRevealed();
    elToggleAll.setAttribute('aria-pressed', allHidden ? 'true' : 'false');
    if (elToggleAllLabel) {
      elToggleAllLabel.textContent = directionWord() + (allHidden ? 'を表示' : 'を隠す');
    }
  }

  /* ============================================================
   * 14. 現在行（キーボード操作）
   * ========================================================== */

  function setCurrent(rec, doFocus) {
    if (state.currentId && state.byId[state.currentId] && state.byId[state.currentId] !== rec) {
      var prev = state.byId[state.currentId];
      if (prev.el) prev.el.classList.remove('is-current');
    }
    if (!rec || !rec.el) { state.currentId = null; return; }
    rec.el.classList.add('is-current');
    state.currentId = rec.id;
    if (doFocus) {
      if (rec.el.scrollIntoView) rec.el.scrollIntoView({ block: 'nearest' });
      if (rec.mainEl) {
        try {
          rec.mainEl.focus({ preventScroll: true });
        } catch (e) {
          rec.mainEl.focus();
        }
      }
    }
  }

  function visibleRecords() {
    var out = [];
    for (var i = 0; i < state.order.length; i++) {
      if (!state.order[i].el.hidden) out.push(state.order[i]);
    }
    return out;
  }

  function moveCurrent(delta) {
    var vis = visibleRecords();
    if (!vis.length) return;
    var idx = -1;
    if (state.currentId) {
      for (var i = 0; i < vis.length; i++) {
        if (vis[i].id === state.currentId) { idx = i; break; }
      }
    }
    if (idx < 0) {
      idx = delta > 0 ? 0 : vis.length - 1;
    } else {
      idx = idx + delta;
      if (idx < 0) idx = 0;
      if (idx > vis.length - 1) idx = vis.length - 1;
    }
    setCurrent(vis[idx], true);
  }

  function currentRecord() {
    if (!state.currentId) return null;
    var rec = state.byId[state.currentId];
    if (!rec || !rec.el || rec.el.hidden) return null;
    return rec;
  }

  /* ============================================================
   * 15. 検索・絞り込み
   * ========================================================== */

  function applyFilter() {
    var q = state.query;
    var starredOnly = state.settings.starredOnly;
    var deckId = state.deck ? state.deck.id : '';
    var visible = 0;

    for (var i = 0; i < state.records.length; i++) {
      var rec = state.records[i];
      if (!rec.el) continue;
      var ok = true;
      if (q) {
        ok = rec.jaLower.indexOf(q) >= 0 || rec.enLower.indexOf(q) >= 0 || rec.noteLower.indexOf(q) >= 0;
      }
      if (ok && starredOnly) {
        ok = isStarred(deckId, rec.id);
      }
      rec.el.hidden = !ok;
      if (ok) visible++;
    }

    state.visibleCount = visible;

    if (elEmptyState) {
      if (state.records.length === 0) {
        // 作りたてのセットは 1 文も無い。何をすればいいか書いておく
        elEmptyState.textContent = 'このセットにはまだ文がありません。下の「＋ 文を追加」から足せます。';
        elEmptyState.hidden = false;
      } else if (visible === 0) {
        elEmptyState.textContent = '該当する文がありません。';
        elEmptyState.hidden = false;
      } else {
        elEmptyState.hidden = true;
      }
    }
    if (elSearchClear) {
      elSearchClear.hidden = !state.query;
    }

    // 現在行が隠れたら外す
    if (state.currentId) {
      var cur = state.byId[state.currentId];
      if (cur && cur.el && cur.el.hidden) {
        cur.el.classList.remove('is-current');
        state.currentId = null;
      }
    }

    updateStatusBar();
  }

  var runSearch = debounce(function () {
    state.query = trim(elSearch ? elSearch.value : '').toLowerCase();
    applyFilter();
  }, SEARCH_DEBOUNCE);

  function clearSearch(blur) {
    if (elSearch) elSearch.value = '';
    state.query = '';
    applyFilter();
    if (blur && elSearch) elSearch.blur();
  }

  /* ============================================================
   * 16. シャッフル（Fisher–Yates）
   * ========================================================== */

  function shuffleArray(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function toggleShuffle() {
    if (!state.records.length) return;
    if (state.shuffled) {
      state.order = state.records.slice(); // 元の順に戻す
      state.shuffled = false;
    } else {
      state.order = shuffleArray(state.records.slice());
      state.shuffled = true;
    }
    updateShuffleButton();
    reorderDom();
  }

  /** 既存の要素を order の順に並べ替える（1 回の挿入で済ませる） */
  function reorderDom() {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < state.order.length; i++) {
      frag.appendChild(state.order[i].el);
    }
    elRows.appendChild(frag);
    renumber();
  }

  function updateShuffleButton() {
    if (!elShuffle) return;
    elShuffle.setAttribute('aria-pressed', state.shuffled ? 'true' : 'false');
    elShuffle.setAttribute('aria-label', state.shuffled ? '元の順番に戻す' : '順番をシャッフル');
  }

  /* ============================================================
   * 17. 読み上げ
   * ========================================================== */

  var speechVoice = null;

  function initSpeech() {
    state.speechOK = !!(window.speechSynthesis && typeof window.SpeechSynthesisUtterance === 'function');
    if (!state.speechOK) return;
    pickVoice();
    try {
      window.speechSynthesis.onvoiceschanged = pickVoice; // 声は遅れて読み込まれることがある
    } catch (e) { /* 無視 */ }
  }

  function pickVoice() {
    try {
      var voices = window.speechSynthesis.getVoices() || [];
      var fallback = null;
      for (var i = 0; i < voices.length; i++) {
        var lang = (voices[i].lang || '').toLowerCase();
        if (lang === 'en-us' || lang === 'en_us') { speechVoice = voices[i]; return; }
        if (!fallback && lang.indexOf('en') === 0) fallback = voices[i];
      }
      speechVoice = fallback;
    } catch (e) {
      speechVoice = null;
    }
  }

  function speak(text) {
    if (!state.speechOK || !text) return;
    try {
      window.speechSynthesis.cancel(); // 再生中のものは止める
      var u = new window.SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      if (speechVoice) u.voice = speechVoice;
      u.rate = 1;
      window.speechSynthesis.speak(u);
    } catch (e) { /* 読み上げできなくても致命的ではない */ }
  }

  /* ============================================================
   * 17b. 1 文ずつ追加する
   * ========================================================== */

  /** いま開いているセットを保ったまま、行を作り直して表示を更新する */
  function refreshCurrentDeck() {
    if (!state.deck) return;
    var keepQuery = state.query;
    var keepCurrent = state.currentId;
    selectDeck(state.deck.id, { persist: false });
    if (keepQuery && elSearch) {
      elSearch.value = keepQuery;
      state.query = keepQuery;
      applyFilter();
    }
    if (keepCurrent && state.byId[keepCurrent]) setCurrent(state.byId[keepCurrent], false);
  }

  function currentDeckId() {
    return state.deck ? state.deck.id : '';
  }

  function setAddStatus(msg, isError) {
    if (!elAddStatus) return;
    elAddStatus.textContent = msg || '';
    if (isError) elAddStatus.setAttribute('data-error', 'true');
    else elAddStatus.removeAttribute('data-error');
  }

  /** 入力欄の内容を 1 文として足す。連続で足せるよう、欄を空にして日本語へ戻す */
  function submitAddSentence() {
    var deckId = currentDeckId();
    if (!deckId) {
      setAddStatus('先にセットを選んでください。', true);
      return;
    }
    var ja = elAddJa ? trim(elAddJa.value) : '';
    var en = elAddEn ? trim(elAddEn.value) : '';
    var note = elAddNote ? trim(elAddNote.value) : '';

    if (!ja || !en) {
      setAddStatus('日本語と英語の両方を入れてください。', true);
      (!ja && elAddJa ? elAddJa : elAddEn).focus();
      return;
    }

    if (!addSentence(deckId, ja, en, note)) {
      setAddStatus('同じ文がすでにあります。', true);
      return;
    }

    if (elAddJa) elAddJa.value = '';
    if (elAddEn) elAddEn.value = '';
    if (elAddNote) elAddNote.value = '';

    refreshCurrentDeck();
    renderAddedList();
    setAddStatus('「' + ja + '」を追加しました。続けて入力できます。', false);
    if (elAddJa) elAddJa.focus();
  }

  /** 行の 🗑 から呼ばれる。自分で足した文だけ消せる */
  function deleteAddedRecord(rec) {
    if (!rec || !rec.added) return;
    if (!window.confirm('「' + rec.ja + '」を削除します。よろしいですか？')) return;
    removeAddedSentence(currentDeckId(), rec.ja, rec.en);
    refreshCurrentDeck();
    renderAddedList();
  }

  function renderAddedList() {
    if (!elAddedList) return;
    while (elAddedList.firstChild) elAddedList.removeChild(elAddedList.firstChild);

    var list = addedFor(currentDeckId());
    if (!list.length) {
      var li0 = document.createElement('li');
      li0.className = 'added-empty';
      li0.textContent = 'まだありません。';
      elAddedList.appendChild(li0);
      return;
    }

    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var li = document.createElement('li');
      li.className = 'added-item';

      var textSpan = document.createElement('span');
      textSpan.className = 'added-text';
      textSpan.textContent = item.ja + ' / ' + item.en;

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn--ghost added-delete';
      del.textContent = '削除';
      del.setAttribute('data-ja', item.ja);
      del.setAttribute('data-en', item.en);
      del.setAttribute('aria-label', item.ja + ' を削除');

      li.appendChild(textSpan);
      li.appendChild(del);
      elAddedList.appendChild(li);
    }
  }

  /** 空の自作セットを作って、そのまま開く */
  function createEmptyDeck(name) {
    var deck = {
      id: makeUserDeckId(),
      name: name || ('自作セット ' + (state.userDecks.length + 1)),
      description: '',
      items: []
    };
    state.userDecks.push(deck);
    saveUserDecks();
    renderDeckSelect();
    renderDeckManageList();
    selectDeck(deck.id);
    return deck;
  }

  function submitNewDeck() {
    var name = elNewDeckName ? trim(elNewDeckName.value) : '';
    if (!name) {
      setAddStatus('セットの名前を入れてください。', true);
      if (elNewDeckName) elNewDeckName.focus();
      return;
    }
    for (var i = 0; i < state.userDecks.length; i++) {
      if (state.userDecks[i].name === name) {
        setAddStatus('同じ名前のセットがすでにあります。', true);
        return;
      }
    }
    createEmptyDeck(name);
    if (elNewDeckName) elNewDeckName.value = '';
    prepareAddDialog();
    setAddStatus('「' + name + '」を作りました。さっそく1文目を入れてください。', false);
    if (elAddJa) elAddJa.focus();
  }

  /** ダイアログを開くたびに、対象セット名と一覧を今の状態に合わせる */
  function prepareAddDialog() {
    if (elAddDeckName) {
      elAddDeckName.textContent = state.deck ? '「' + state.deck.name + '」' : '';
    }
    setAddStatus('', false);
    renderAddedList();
  }

  /* ============================================================
   * 18. ステータスバー
   * ========================================================== */

  function updateStatusBar() {
    if (!elStatusBar) return;
    if (!allDecks().length) {
      elStatusBar.textContent = 'セットがありません。「＋追加」から新しいセットを作れます。';
      return;
    }
    if (!state.deck || !state.records.length) {
      elStatusBar.textContent = (state.deck ? state.deck.name + ' ・ ' : '') + '文がありません。';
      return;
    }
    var parts = [state.deck.name];
    parts.push('全 ' + state.records.length + ' 文');
    if (state.visibleCount !== state.records.length) {
      parts.push('表示中 ' + state.visibleCount + ' 文');
    }
    if (state.settings.starredOnly) parts.push('★のみ');
    if (state.shuffled) parts.push('シャッフル中');
    elStatusBar.textContent = parts.join(' ・ ');
  }

  /* ============================================================
   * 19. 行のイベント（#rows へのイベント委譲）
   * ========================================================== */

  function recordFromEvent(target) {
    var li = target.closest ? target.closest('.row') : null;
    if (!li) return null;
    return state.byId[li.getAttribute('data-id')] || null;
  }

  function onRowsClick(e) {
    var target = e.target;
    if (!target || !target.closest) return;

    var speakBtn = target.closest('.row-speak');
    if (speakBtn && elRows.contains(speakBtn)) {
      var recS = recordFromEvent(speakBtn);
      if (recS) speak(recS.en);
      return;
    }

    var starBtn = target.closest('.row-star');
    if (starBtn && elRows.contains(starBtn)) {
      var recT = recordFromEvent(starBtn);
      if (recT) toggleStar(recT);
      return;
    }

    var delBtn = target.closest('.row-delete');
    if (delBtn && elRows.contains(delBtn)) {
      var recD = recordFromEvent(delBtn);
      if (recD) deleteAddedRecord(recD);
      return;
    }

    var mainBtn = target.closest('.row-main');
    if (mainBtn && elRows.contains(mainBtn)) {
      var recM = recordFromEvent(mainBtn);
      if (recM) toggleRow(recM);
    }
  }

  function toggleStar(rec) {
    var deckId = state.deck ? state.deck.id : '';
    var on = !isStarred(deckId, rec.id);
    setStar(deckId, rec.id, on);
    if (rec.el) {
      if (on) rec.el.classList.add('is-starred');
      else rec.el.classList.remove('is-starred');
    }
    if (rec.starEl) {
      rec.starEl.setAttribute('aria-pressed', on ? 'true' : 'false');
      rec.starEl.setAttribute('aria-label', on ? 'チェックを外す' : 'チェックを付ける');
    }
    if (state.settings.starredOnly) applyFilter();
  }

  /* ============================================================
   * 20. キーボード（MacBook）
   * ========================================================== */

  function onKeyDown(e) {
    if (e.defaultPrevented) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // パラフレ帳を開いている間は表が画面に無い。キー操作はそちらに任せる。
    if (docEl.getAttribute('data-mode') === 'para') return;

    var target = e.target;
    var typing = isTypingTarget(target);

    // Escape: 検索を消して外す
    if (e.key === 'Escape') {
      if (elSearch && (target === elSearch || (!anyDialogOpen() && state.query))) {
        e.preventDefault();
        clearSearch(true);
      }
      return;
    }

    // '/' で検索へ（入力中は無視）
    if (e.key === '/' && !typing && !anyDialogOpen()) {
      e.preventDefault();
      if (elSearch) { elSearch.focus(); elSearch.select(); }
      return;
    }

    if (typing || anyDialogOpen()) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveCurrent(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveCurrent(-1);
        break;
      case ' ':
      case 'Spacebar':
      case 'Enter': {
        // 行ボタン・モードタブにフォーカスがあるときはブラウザの click に任せる（二重発火を防ぐ）
        var active = document.activeElement;
        if (active && active.closest) {
          if (active.closest('.row-main') && elRows.contains(active)) return;
          if (active.closest('.mode-tabs')) return;
        }
        var rec = currentRecord();
        if (rec) {
          e.preventDefault();
          toggleRow(rec);
        }
        break;
      }
      case 'a':
      case 'A':
        e.preventDefault();
        setAllRevealed(!anyRevealed());
        break;
      case 's':
      case 'S': {
        var recS = currentRecord();
        if (recS) {
          e.preventDefault();
          toggleStar(recS);
        }
        break;
      }
      default:
        break;
    }
  }

  /* ============================================================
   * 21. ダイアログ（<dialog> が無い環境でも壊れない）
   * ========================================================== */

  function openDialog(dialog, invoker) {
    if (!dialog) return;
    state.lastFocus = invoker || document.activeElement;
    if (typeof dialog.showModal === 'function') {
      try {
        dialog.showModal();
        return;
      } catch (e) { /* すでに open のときなど */ }
    }
    dialog.setAttribute('open', '');
  }

  function closeDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.close === 'function' && dialog.open) {
      try {
        dialog.close();
      } catch (e) {
        dialog.removeAttribute('open');
      }
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

  /* ============================================================
   * 22. 取り込みダイアログ
   * ========================================================== */

  var lastParsed = null;

  function updateImportPreview() {
    if (!elImportPreview) return;
    var text = elImportText ? elImportText.value : '';
    if (!trim(text)) {
      lastParsed = null;
      elImportPreview.textContent = '';
      return;
    }
    var parsed = parseImportText(text);
    lastParsed = parsed;

    if (!parsed.items.length) {
      elImportPreview.textContent =
        '読み込める行がありません。1 列目に日本語、2 列目に英語（タブまたはカンマ区切り）になっているか確認してください。';
      return;
    }

    var first = parsed.items[0];
    var head = first.ja + ' / ' + first.en;
    if (head.length > 40) head = head.slice(0, 40) + '…';

    var msg = parsed.items.length + ' 行を読み込めます（最初の1行: ' + head + '）';
    var extra = [];
    extra.push(parsed.delimiter === '\t' ? 'タブ区切り' : 'カンマ区切り');
    if (parsed.headerDropped) extra.push('見出し行は除外');
    if (parsed.skipped) extra.push(parsed.skipped + ' 行は列が足りないため除外');
    msg += '［' + extra.join(' / ') + '］';
    elImportPreview.textContent = msg;
  }

  var runImportPreview = debounce(updateImportPreview, PREVIEW_DEBOUNCE);

  function defaultDeckName() {
    return '自作セット ' + (state.userDecks.length + 1);
  }

  function saveImportedDeck() {
    var text = elImportText ? elImportText.value : '';
    var parsed = parseImportText(text);
    var typedName = trim(elImportName ? elImportName.value : '');

    if (!parsed.items.length) {
      // 名前だけ入れて「読み込む」を押した＝空のセットを作りたい、と受け取る。
      // ここで何も作らずに終わると、名前を付けたのに何も起きない行き止まりになる。
      if (typedName) {
        createEmptyDeck(typedName);
        if (elImportName) elImportName.value = '';
        if (elImportPreview) elImportPreview.textContent = '';
        closeDialog(elDataDialog);
        return;
      }
      if (elImportPreview) {
        elImportPreview.textContent =
          '読み込める行がありません。1 列目に日本語、2 列目に英語（タブまたはカンマ区切り）になっているか確認してください。'
          + ' 空のセットを作りたいときは、上の「セット名」に名前を入れて「読み込む」を押してください。';
      }
      return;
    }
    var name = typedName;
    if (!name) name = defaultDeckName();

    var deck = {
      id: makeUserDeckId(),
      name: name,
      description: '',
      items: parsed.items.map(function (it) {
        return { ja: it.ja, en: it.en, note: it.note || '' };
      })
    };

    state.userDecks.push(deck);
    var ok = saveUserDecks();

    renderDeckSelect();
    renderDeckManageList();
    selectDeck(deck.id);

    if (elImportText) elImportText.value = '';
    if (elImportName) elImportName.value = '';
    if (elImportPreview) {
      elImportPreview.textContent = ok === false
        ? '読み込みました（この端末には保存できませんでした）。'
        : '';
    }
    closeDialog(elDataDialog);
  }

  /** 自作セットの一覧（名前・件数・削除ボタン） */
  function renderDeckManageList() {
    if (!elDeckManageList) return;
    while (elDeckManageList.firstChild) elDeckManageList.removeChild(elDeckManageList.firstChild);

    if (!state.userDecks.length) {
      var li0 = document.createElement('li');
      li0.className = 'deck-manage-empty';
      li0.textContent = 'まだありません。';
      elDeckManageList.appendChild(li0);
      return;
    }

    for (var i = 0; i < state.userDecks.length; i++) {
      var deck = state.userDecks[i];
      var li = document.createElement('li');
      li.className = 'deck-manage-item';
      li.setAttribute('data-deck-id', deck.id);

      var nameSpan = document.createElement('span');
      nameSpan.className = 'deck-manage-name';
      nameSpan.textContent = deck.name;

      var countSpan = document.createElement('span');
      countSpan.className = 'deck-manage-count';
      countSpan.textContent = deck.items.length + ' 文';

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn--ghost deck-manage-delete';
      del.textContent = '削除';
      del.setAttribute('data-deck-id', deck.id);
      del.setAttribute('aria-label', deck.name + ' を削除');

      li.appendChild(nameSpan);
      li.appendChild(countSpan);
      li.appendChild(del);
      elDeckManageList.appendChild(li);
    }
  }

  function deleteUserDeck(deckId) {
    var idx = -1, i;
    for (i = 0; i < state.userDecks.length; i++) {
      if (state.userDecks[i].id === deckId) { idx = i; break; }
    }
    if (idx < 0) return;

    var name = state.userDecks[idx].name;
    if (!window.confirm('「' + name + '」を削除します。よろしいですか？')) return;

    state.userDecks.splice(idx, 1);
    saveUserDecks();

    // ★のデータも一緒に片付ける
    if (state.stars[deckId]) {
      delete state.stars[deckId];
      saveStars();
    }

    // このセットに足した文も一緒に片付ける
    if (state.added[deckId]) {
      delete state.added[deckId];
      saveAdded();
    }

    renderDeckSelect();
    renderDeckManageList();

    if (state.deck && state.deck.id === deckId) {
      // 消したのが今のセットなら、収録セットの先頭に戻る
      var fallback = state.builtinDecks.length ? state.builtinDecks[0]
        : (state.userDecks.length ? state.userDecks[0] : null);
      selectDeck(fallback ? fallback.id : '');
      if (!fallback) {
        state.deck = null;
        state.records = [];
        state.order = [];
        state.byId = {};
        renderRows();
        applyFilter();
      }
    }
    updateStatusBar();
  }

  /** 今のセットを TSV でクリップボードへ */
  function exportCurrentDeck() {
    if (!state.deck || !state.records.length) {
      if (elImportPreview) elImportPreview.textContent = 'コピーできるセットがありません。';
      return;
    }
    // 表示されている全行（＝収録分＋自分で足した分）をそのまま書き出す
    var tsv = itemsToTSV(state.records);
    var rowCount = state.records.length;

    function done(ok) {
      if (!elImportPreview) return;
      elImportPreview.textContent = ok
        ? state.deck.name + ' を TSV でコピーしました（' + rowCount + ' 行）。'
        : 'コピーできませんでした。テキストを手動で選択してコピーしてください。';
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(tsv).then(function () {
        done(true);
      }, function () {
        done(legacyCopy(tsv));
      });
      return;
    }
    done(legacyCopy(tsv));
  }

  /** execCommand('copy') による古い環境向けのコピー */
  function legacyCopy(text) {
    var host = document.querySelector('dialog[open]') || document.body;
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    host.appendChild(ta);
    var ok = false;
    try {
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    if (ta.parentNode) ta.parentNode.removeChild(ta);
    return ok;
  }

  /* ============================================================
   * 23. 設定ダイアログ
   * ========================================================== */

  function syncSettingsForm() {
    var radios = document.querySelectorAll('input[name="mask-style"]');
    for (var i = 0; i < radios.length; i++) {
      radios[i].checked = (radios[i].value === state.settings.maskStyle);
    }
    if (elOptAutoHide) elOptAutoHide.checked = state.settings.autoHide;
    if (elOptHideJa) elOptHideJa.checked = (state.settings.direction === 'en-ja');
    if (elOptStarredOnly) elOptStarredOnly.checked = state.settings.starredOnly;
    if (elOptAutoSpeak) {
      elOptAutoSpeak.checked = state.settings.autoSpeak;
      // 読み上げできない環境では触らせない
      elOptAutoSpeak.disabled = !state.speechOK;
    }
    if (elOptFontSize) elOptFontSize.value = String(state.settings.fontSize);
    if (elOptFontOut) elOptFontOut.textContent = FONT_LABELS[state.settings.fontSize] || '標準';
  }

  function onMaskChange(e) {
    var v = inList(e.target.value, MASK_STYLES, null);
    if (!v) return;
    state.settings.maskStyle = v;
    docEl.setAttribute('data-mask', v);
    saveSettings();
  }

  function onFontChange() {
    var v = clampInt(elOptFontSize.value, 0, 4, 2);
    state.settings.fontSize = v;
    docEl.setAttribute('data-font', String(v));
    if (elOptFontOut) elOptFontOut.textContent = FONT_LABELS[v] || '標準';
    saveSettings();
  }

  function onAutoHideChange() {
    state.settings.autoHide = !!elOptAutoHide.checked;
    saveSettings();
  }

  function onHideJaChange() {
    state.settings.direction = elOptHideJa.checked ? 'en-ja' : 'ja-en';
    docEl.setAttribute('data-direction', state.settings.direction);
    syncToggleAllButton();
    saveSettings();
  }

  function onStarredOnlyChange() {
    state.settings.starredOnly = !!elOptStarredOnly.checked;
    saveSettings();
    applyFilter();
  }

  function onAutoSpeakChange() {
    state.settings.autoSpeak = !!elOptAutoSpeak.checked;
    saveSettings();
  }

  /* ============================================================
   * 24. イベント登録
   * ========================================================== */

  function bindEvents() {
    if (elRows) elRows.addEventListener('click', onRowsClick);

    if (elToggleAll) {
      elToggleAll.addEventListener('click', function () {
        setAllRevealed(!anyRevealed());
      });
    }

    if (elShuffle) elShuffle.addEventListener('click', toggleShuffle);

    if (elSearch) {
      elSearch.addEventListener('input', runSearch);
      elSearch.addEventListener('search', runSearch); // type="search" の × ボタン
    }
    if (elSearchClear) {
      elSearchClear.addEventListener('click', function () {
        clearSearch(false);
        if (elSearch) elSearch.focus();
      });
    }

    if (elDeckSelect) {
      elDeckSelect.addEventListener('change', function () {
        if (!elDeckSelect.value) return;
        selectDeck(elDeckSelect.value);
      });
    }

    document.addEventListener('keydown', onKeyDown);

    // --- 追加ダイアログ ---
    function openAddDialog(invoker) {
      prepareAddDialog();
      openDialog(elAddDialog, invoker);
      if (elAddJa) elAddJa.focus();
    }
    if (elBtnAdd) {
      elBtnAdd.addEventListener('click', function () { openAddDialog(elBtnAdd); });
    }
    if (elBtnAddRow) {
      elBtnAddRow.addEventListener('click', function () { openAddDialog(elBtnAddRow); });
    }
    if (elAddSave) elAddSave.addEventListener('click', submitAddSentence);
    if (elAddClose) elAddClose.addEventListener('click', function () { closeDialog(elAddDialog); });

    // 入力欄で Enter を押したら次へ／追加する（フォーム送信で閉じてしまうのを防ぐ）
    if (elAddJa) {
      elAddJa.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); if (elAddEn) elAddEn.focus(); }
      });
    }
    if (elAddEn) {
      elAddEn.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submitAddSentence(); }
      });
    }
    if (elAddNote) {
      elAddNote.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submitAddSentence(); }
      });
    }
    if (elNewDeck) elNewDeck.addEventListener('click', submitNewDeck);
    if (elNewDeckName) {
      elNewDeckName.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submitNewDeck(); }
      });
    }
    if (elAddedList) {
      elAddedList.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.added-delete') : null;
        if (!btn) return;
        var ja = btn.getAttribute('data-ja');
        var en = btn.getAttribute('data-en');
        if (!window.confirm('「' + ja + '」を削除します。よろしいですか？')) return;
        removeAddedSentence(currentDeckId(), ja, en);
        refreshCurrentDeck();
        renderAddedList();
        setAddStatus('削除しました。', false);
      });
    }

    // --- データダイアログ ---
    if (elBtnData) {
      elBtnData.addEventListener('click', function () {
        closeDialog(elAddDialog);   // 追加ダイアログの中から開くので、先に閉じる
        renderDeckManageList();
        updateImportPreview();
        openDialog(elDataDialog, elBtnData);
        if (elImportText) elImportText.focus();
      });
    }
    if (elImportCancel) {
      elImportCancel.addEventListener('click', function () { closeDialog(elDataDialog); });
    }
    if (elImportSave) {
      elImportSave.addEventListener('click', saveImportedDeck);
    }
    if (elImportText) {
      elImportText.addEventListener('input', runImportPreview);
      elImportText.addEventListener('paste', function () { setTimeout(updateImportPreview, 0); });
    }
    if (elExport) {
      elExport.addEventListener('click', exportCurrentDeck);
    }
    if (elDeckManageList) {
      elDeckManageList.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.deck-manage-delete') : null;
        if (!btn) return;
        e.preventDefault();
        deleteUserDeck(btn.getAttribute('data-deck-id'));
      });
    }

    // --- 設定ダイアログ ---
    if (elBtnSettings) {
      elBtnSettings.addEventListener('click', function () {
        syncSettingsForm();
        openDialog(elSettingsDialog, elBtnSettings);
      });
    }
    if (elSettingsClose) {
      elSettingsClose.addEventListener('click', function () { closeDialog(elSettingsDialog); });
    }

    var radios = document.querySelectorAll('input[name="mask-style"]');
    for (var i = 0; i < radios.length; i++) {
      radios[i].addEventListener('change', onMaskChange);
    }
    if (elOptFontSize) {
      elOptFontSize.addEventListener('input', onFontChange);
      elOptFontSize.addEventListener('change', onFontChange);
    }
    if (elOptAutoHide) elOptAutoHide.addEventListener('change', onAutoHideChange);
    if (elOptHideJa) elOptHideJa.addEventListener('change', onHideJaChange);
    if (elOptStarredOnly) elOptStarredOnly.addEventListener('change', onStarredOnlyChange);
    if (elOptAutoSpeak) elOptAutoSpeak.addEventListener('change', onAutoSpeakChange);

    // Esc などで閉じたときもフォーカスを戻す
    [elDataDialog, elSettingsDialog].forEach(function (d) {
      if (!d) return;
      d.addEventListener('close', restoreFocus);
      d.addEventListener('cancel', function () { /* 既定の閉じる動作に任せる */ });
    });
  }

  /* ============================================================
   * 25. 外から使う口（パラフレ帳のためだけに開けてある）
   *     ここ以外から app.js の中身は触らせない。
   * ========================================================== */

  /**
   * 名前でセットを探し（無ければ作って開き）、{ja,en,note} を足す。
   * 足し方は「＋追加」と同じ（sunkan:added 行き）なので、元データは無傷のまま。
   */
  function addSentencesToNamedDeck(deckName, items) {
    var result = { added: 0, skipped: 0, deckId: '', deckName: '' };
    var name = trim(deckName) || 'パラフレ帳';
    var deck = null, i;

    for (i = 0; i < state.userDecks.length; i++) {
      if (state.userDecks[i].name === name) { deck = state.userDecks[i]; break; }
    }
    if (!deck) deck = createEmptyDeck(name);   // 作ったセットはそのまま開く
    result.deckId = deck.id;
    result.deckName = deck.name;

    items = items || [];
    for (i = 0; i < items.length; i++) {
      var ja = trim(items[i].ja);
      var en = trim(items[i].en);
      if (!ja || !en) { result.skipped++; continue; }
      if (addSentence(deck.id, ja, en, trim(items[i].note))) result.added++;
      else result.skipped++;   // 同じ文がすでにある
    }

    if (result.added) {
      refreshCurrentDeck();
      renderAddedList();
      renderDeckManageList();
      updateStatusBar();
    }
    return result;
  }

  /** 貼り付けテキストを行×列に割る（TSV / CSV 自動判定。空行は落とす） */
  function splitTable(text) {
    var src = str(text).replace(/^\uFEFF/, '');
    var out = { rows: [], delimiter: '\t' };
    if (!trim(src)) return out;

    out.delimiter = detectDelimiter(src);
    var rows = parseDelimited(src, out.delimiter);
    for (var i = 0; i < rows.length; i++) {
      var cells = [], nonEmpty = 0;
      for (var j = 0; j < rows[i].length; j++) {
        var cell = trim(rows[i][j]);
        cells.push(cell);
        if (cell) nonEmpty++;
      }
      if (!nonEmpty) continue;
      out.rows.push(cells);
    }
    return out;
  }

  window.SUNKAN_DRILL = {
    addSentences: addSentencesToNamedDeck,
    splitTable: splitTable,
    /** クリップボードへ。非同期なので結果は done(ok) で返す */
    copyText: function (text, done) {
      done = done || function () {};
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          done(true);
        }, function () {
          done(legacyCopy(text));
        });
        return;
      }
      done(legacyCopy(text));
    }
  };

  /* ============================================================
   * 26. 起動
   * ========================================================== */

  function init() {
    if (!elRows || !elRowTemplate) return; // DOM が想定と違うときは何もしない

    if (elAppVersion) elAppVersion.textContent = APP_VERSION;

    initSpeech();
    loadStars();
    loadAdded();

    state.builtinDecks = loadBuiltinDecks();
    state.userDecks = loadUserDecks();

    renderDeckSelect();
    renderDeckManageList();
    syncSettingsForm();

    selectDeck(state.settings.deckId, { persist: false });
    syncToggleAllButton();
    updateStatusBar();

    bindEvents();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
