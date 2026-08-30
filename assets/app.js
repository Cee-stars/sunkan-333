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
  // 収録・取り込みの文への上書き。元データ（data.js / sunkan:decks）は書き換えず、
  // 表を組み立てるときに当てる。sunkan:added が「後ろへ足す」のと同じ考え方。
  var LS_EDITS = 'sunkan:edits';

  var MASK_STYLES = ['blur', 'block', 'hidden'];
  var DIRECTIONS = ['ja-en', 'en-ja'];
  var FONT_LABELS = ['最小', '小', '標準', '大', '最大'];

  // 配信のたびに上げる。設定ダイアログに出して、
  // 「更新が届いているのか」を推測せず確認できるようにするためのもの。
  var APP_VERSION = 'build 30 (2026-08-30)';

  var SEARCH_DEBOUNCE = 120;   // 検索のデバウンス（ミリ秒）
  var PREVIEW_DEBOUNCE = 150;  // 取り込みプレビューのデバウンス（ミリ秒）
  var FLASH_MS = 4000;         // 知らせを status に出しておく時間（ミリ秒）

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

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  /** キーが 1 つでもあるか（空になった上書き表を捨てる判定に使う） */
  function hasKeys(obj) {
    for (var k in obj) {
      if (hasOwn(obj, k)) return true;
    }
    return false;
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

  // 保存が届かなかったときの言い分。空き容量切れ・プライベートモード・
  // 保存を禁じた設定など、理由はいろいろだが、利用者にとっては同じ
  //「足したはずのものが読み込み直すと消える」なので、まとめて知らせる。
  var STORAGE_MSG = 'この端末に保存できませんでした（空き容量が足りないか、保存が禁じられています）。'
    + '読み込み直すと元に戻ります。';
  var storageNoticeTimer = null;

  /** 保存できなかったことを、いま見えている所に出す（黙って落とさない）。
      成功のしらせを上書きできるよう、同じ処理が済んだあとに回す。
      1 つの操作で複数のキーを書くことがあるので、同じ回のぶんは 1 度にまとめる。 */
  function flagStorageProblem() {
    if (storageNoticeTimer) return;
    storageNoticeTimer = window.setTimeout(function () {
      storageNoticeTimer = null;
      showStorageProblem();
    }, 0);
  }

  /** ダイアログが開いていると status バーは見えない。開いている所へ出す */
  function showStorageProblem() {
    if (elAddDialog && elAddDialog.open) { setAddStatus(STORAGE_MSG, true); return; }
    if (elEditDialog && elEditDialog.open) { setEditStatus(STORAGE_MSG, true); return; }
    if (elDataDialog && elDataDialog.open && elImportPreview) {
      elImportPreview.textContent = STORAGE_MSG;
      return;
    }
    flashStatus(STORAGE_MSG);
  }

  function lsSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (e) {
      // 保存できなくてもアプリは動き続けるが、黙って続けると
      //「追加したのに読み込み直したら消えていた」になる
      flagStorageProblem();
      return false;
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

  /** { deckId: { itemId: {ja,en,note} } } の形に整える。壊れた項目は落とす */
  function sanitizeEdits(raw) {
    var out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (var key in raw) {
      if (!hasOwn(raw, key)) continue;
      var table = raw[key];
      if (!table || typeof table !== 'object' || Array.isArray(table)) continue;
      var kept = {};
      for (var itemId in table) {
        if (!hasOwn(table, itemId)) continue;
        var it = table[itemId];
        if (!it || typeof it !== 'object') continue;
        var ja = trim(it.ja), en = trim(it.en);
        // 片方だけの上書きは出題できない。元の文をそのまま見せるほうが安全
        if (!ja || !en) continue;
        kept[itemId] = { ja: ja, en: en, note: trim(it.note) };
      }
      if (hasKeys(kept)) out[key] = kept;
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
    edits: {},        // { deckId: { itemId: {ja,en,note} } } 収録の文への上書き
    settings: sanitizeSettings(readJSON(LS_SETTINGS)),
    currentId: null,
    lastRevealed: null,
    visibleCount: 0,
    speechOK: false,
    speakingId: null,   // いま読み上げている行の id（行を閉じたら止めるため）
    flashTimer: null,   // status に出した知らせを消すタイマー
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
    return writeJSON(LS_SETTINGS, state.settings);
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

  var elEditDialog = $('edit-dialog');
  var elEditJa = $('edit-ja');
  var elEditEn = $('edit-en');
  var elEditNote = $('edit-note');
  var elEditOrigin = $('edit-origin');
  var elEditStatus = $('edit-status');
  var elEditSave = $('btn-edit-save');
  var elEditRevert = $('btn-edit-revert');
  var elEditClose = $('btn-edit-close');

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
  var elOptAutoSpeakNote = $('opt-auto-speak-note');
  var elAppVersion = $('app-version');
  var elForceUpdate = $('btn-force-update');
  var elMenuOpen = $('btn-menu');
  var elMenuDialog = $('menu-dialog');
  var elMenuClose = $('btn-menu-close');
  var elMenuSync = $('btn-menu-sync');
  var elMenuSyncHint = $('menu-sync-hint');
  var elBackupOut = $('btn-backup-out');
  var elBackupIn = $('btn-backup-in');
  var elBackupFile = $('backup-file');
  var elCsvOut = $('btn-csv-out');
  var elCsvHint = $('csv-hint');
  var elDataStatus = $('data-status');
  var elVoiceOpen = $('btn-voice');
  var elVoiceNow = $('voice-now');
  var elVoiceDialog = $('voice-dialog');
  var elVoiceSelect = $('voice-select');
  var elVoiceStatus = $('voice-status');
  var elVoiceTest = $('btn-voice-test');
  var elVoiceClose = $('btn-voice-close');
  var elForceUpdateStatus = $('force-update-status');
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
    return writeJSON(LS_ADDED, state.added);
  }

  function addedFor(deckId) {
    if (!deckId) return [];
    return state.added[deckId] || [];
  }

  /* 同期に「消した」「足し直した」を伝える。sync.js が読み込まれていなければ何もしない。
     ここを通しておかないと、消したものが同期でまた戻ってくる。 */
  function noteDelete(key) {
    var s = window.SUNKAN_SYNC;
    if (s && typeof s.recordDelete === 'function') s.recordDelete(key);
  }
  function noteAdd(key) {
    var s = window.SUNKAN_SYNC;
    if (s && typeof s.clearDelete === 'function') s.clearDelete(key);
  }
  function addedSyncKey(deckId, ja, en) {
    var s = window.SUNKAN_SYNC;
    return (s && typeof s.addedKey === 'function') ? s.addedKey(deckId, ja, en) : '';
  }
  function editSyncKey(deckId, itemId) {
    var s = window.SUNKAN_SYNC;
    return (s && typeof s.editKey === 'function') ? s.editKey(deckId, itemId) : '';
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
    noteAdd(addedSyncKey(deckId, ja, en));   // 前に消していても、足し直したなら生かす
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
        noteDelete(addedSyncKey(deckId, ja, en));
        return true;
      }
    }
    return false;
  }

  /**
   * 足した文の中身を書き換える。
   * この 1 文の同一性は (ja, en) で決まっている（★の id も同期の記録もそこから作る）ので、
   * 本文を直すと鍵ごと変わる。古い鍵を消したことにして、新しい鍵を生かし直す。
   */
  function updateAddedSentence(deckId, oldJa, oldEn, ja, en, note) {
    var list = state.added[deckId];
    if (!list) return false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].ja !== oldJa || list[i].en !== oldEn) continue;
      list[i] = { ja: ja, en: en, note: note || '' };
      saveAdded();
      if (oldJa !== ja || oldEn !== en) {
        noteDelete(addedSyncKey(deckId, oldJa, oldEn));  // 古い文が同期で戻ってこないように
        noteAdd(addedSyncKey(deckId, ja, en));
      }
      return true;
    }
    return false;
  }

  /* --- 収録・取り込みの文への上書き ---------------------------- */

  function loadEdits() {
    state.edits = sanitizeEdits(readJSON(LS_EDITS));
  }

  function saveEdits() {
    return writeJSON(LS_EDITS, state.edits);
  }

  function editsFor(deckId) {
    if (!deckId) return {};
    return state.edits[deckId] || {};
  }

  /** 1 文ぶんの上書きを覚える。元データ（data.js / 取り込んだ表）には触らない */
  function setEdit(deckId, itemId, ja, en, note) {
    if (!deckId || !itemId) return false;
    var table = state.edits[deckId] || (state.edits[deckId] = {});
    table[itemId] = { ja: ja, en: en, note: note || '' };
    saveEdits();
    noteAdd(editSyncKey(deckId, itemId));   // 前に元へ戻していても、直したならこちらを生かす
    return true;
  }

  /** 上書きを捨てて収録の文へ戻す。取り消しなので、記録に残さないと同期で復活する */
  function clearEdit(deckId, itemId) {
    var table = state.edits[deckId];
    if (!table || !table[itemId]) return false;
    delete table[itemId];
    if (!hasKeys(table)) delete state.edits[deckId];
    saveEdits();
    noteDelete(editSyncKey(deckId, itemId));
    return true;
  }

  function loadStars() {
    state.stars = sanitizeStars(readJSON(LS_STARS));
  }

  function saveStars() {
    return writeJSON(LS_STARS, state.stars);
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
    // 外したことを伝えないと、同期の足し算で相手側の★が戻ってくる
    var key = 'star:' + deckId + ':' + itemId;
    if (on) noteAdd(key); else noteDelete(key);
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
    var edits = editsFor(deck && deck.id);
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
      var isAdded = i >= firstAdded;
      var ja = it.ja, en = it.en, note = it.note || '';
      // 上書きは元の文の上に当てるだけ。id は元の (ja, en) から作ったままなので、
      // 文を書き換えても★・並び順・同期の記録がずれない。
      // 足した文だけは上書き表を使わず、sunkan:added の本体を直接直す。
      var edit = isAdded ? null : edits[id];
      if (edit) { ja = edit.ja; en = edit.en; note = edit.note; }
      records.push({
        id: id,
        ja: ja,
        en: en,
        note: note,
        jaLower: ja.toLowerCase(),
        enLower: en.toLowerCase(),
        noteLower: note.toLowerCase(),
        added: isAdded,
        edited: !!edit,
        srcJa: it.ja,             // 「元に戻す」で見せる収録のままの文
        srcEn: it.en,
        srcNote: it.note || '',
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
    // 別のセットへ移るなら、前のセットの行を読んでいた音は止める。
    // 同じセットを作り直しただけ（裏の同期・編集）のときは止めない。
    if (state.speakingId && (!state.deck || !deck || state.deck.id !== deck.id)) stopSpeech();

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
      // 閉じた行の音は残さない。「全部隠す」でも「1行だけ開く」でも同じ
      if (state.speakingId === rec.id) stopSpeech();
    }
  }

  function toggleRow(rec) {
    if (!rec) return;
    var next = !rec.revealed;
    if (next && state.settings.autoHide) {
      // 1 行だけ開く。直前の 1 行だけでなく、開いているものは全部閉じる
      //（「全部表示」のあとや、同期の作り直しで開いた行が戻ったあとでも効かせる）
      for (var i = 0; i < state.records.length; i++) {
        if (state.records[i] !== rec) setRevealed(state.records[i], false);
      }
    }
    setRevealed(rec, next);
    state.lastRevealed = next ? rec : null;
    setCurrent(rec, false);
    syncToggleAllButton();
    if (next) maybeAutoSpeak(rec);   // 閉じたときは setRevealed が音も止める
  }

  /** 「表示したら自動で読み上げる」設定のときだけ喋る。
      逆向き（英語→日本語）のときは英語が最初から見えているので読み上げない。 */
  function maybeAutoSpeak(rec) {
    if (!rec || !state.settings.autoSpeak) return;
    if (state.settings.direction === 'en-ja') return;
    speakRecord(rec);
  }

  /** 「全部表示 / 全部隠す」は、いま表示されている行にだけ効かせる。
      検索で 3 件に絞ったのに 360 文ぜんぶ開いてしまうと、
      検索を消したときに答えが全部見えている状態になる。 */
  function setAllRevealed(on) {
    var list = visibleRecords();
    for (var i = 0; i < list.length; i++) {
      setRevealed(list[i], on);
    }
    state.lastRevealed = null;
    syncToggleAllButton();
  }

  /** 表示されている行の中に開いているものがあるか。
      隠れている行まで数えると、押しても何も起きないのに
      ボタンだけ「隠す」と言っている状態になる。 */
  function anyRevealed() {
    var list = visibleRecords();
    for (var i = 0; i < list.length; i++) {
      if (list[i].revealed) return true;
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

    // 表示される行が変わるとボタンの意味も変わる（隠れた行は数えない）
    syncToggleAllButton();
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

  /**
   * 作り直したあと、前の表示順（id の並び）に戻す。
   * 前に無かった行（足したばかりの文・同期で届いた文）は末尾に置く。
   */
  function restoreOrder(idOrder) {
    var rank = {}, known = [], fresh = [], i, rec;
    for (i = 0; i < idOrder.length; i++) {
      if (!hasOwn(rank, idOrder[i])) rank[idOrder[i]] = i;
    }
    for (i = 0; i < state.records.length; i++) {
      rec = state.records[i];
      if (hasOwn(rank, rec.id)) known.push(rec);
      else fresh.push(rec);
    }
    known.sort(function (a, b) { return rank[a.id] - rank[b.id]; });
    state.order = known.concat(fresh);
    state.shuffled = true;
    updateShuffleButton();
    reorderDom();
  }

  function updateShuffleButton() {
    if (!elShuffle) return;
    elShuffle.setAttribute('aria-pressed', state.shuffled ? 'true' : 'false');
    elShuffle.setAttribute('aria-label', state.shuffled ? '元の順番に戻す' : '順番をシャッフル');
  }

  /* ============================================================
   * 17. 読み上げ
   * ========================================================== */

  /** speech.js が開けている口。読み込まれていなければ null */
  function speechPort() {
    return (window.SUNKAN_SPEECH && typeof window.SUNKAN_SPEECH.speak === 'function')
      ? window.SUNKAN_SPEECH : null;
  }

  function initSpeech() {
    var port = speechPort();
    state.speechOK = !!(port && port.supported());
    if (!port) return;
    // 黙って失敗しないよう、理由は status に出す。
    // パラフレ帳を開いている間は向こうの status が出るので、こちらは黙る。
    port.onProblem(function (info) {
      if (docEl.getAttribute('data-mode') === 'para') return;
      state.speakingId = null;
      flashStatus('読み上げ: ' + (info && info.message ? info.message : 'うまくいきませんでした。'));
    });
  }

  /** 読み上げる。タップから同期で呼ぶこと（あいだに setTimeout を挟むと iOS で鳴らない） */
  function speak(text) {
    var port = speechPort();
    if (!port) return false;
    if (!state.speechOK) {
      flashStatus('読み上げ: この端末では読み上げが使えません。');
      return false;
    }
    return port.speak(text);
  }

  function speakRecord(rec) {
    if (!rec || !rec.en) return;
    state.speakingId = speak(rec.en) ? rec.id : null;
  }

  function stopSpeech() {
    var port = speechPort();
    state.speakingId = null;
    if (port) port.cancel();
  }

  /* ============================================================
   * 17b. 1 文ずつ追加する
   * ========================================================== */

  /** いま開いているセットを保ったまま、行を作り直して表示を更新する */
  function refreshCurrentDeck() {
    if (!state.deck) return;
    var keepCurrent = state.currentId;
    // state.query も検索欄もそのまま。selectDeck の中の applyFilter がそのまま効く。
    // ここで検索欄へ state.query（小文字に潰した検索語）を書き戻すと、
    // 打った文字が勝手に変わる。
    selectDeck(state.deck.id, { persist: false });
    if (keepCurrent && state.byId[keepCurrent]) setCurrent(state.byId[keepCurrent], false);
  }

  /**
   * 表を作り直しても、開いていた行・見ている行・並べ方・見ている位置は元に戻す。
   * 同期も編集も読んでいる最中に割り込むので、ここを捨てると答えが勝手に消える。
   *
   * moved は「書き換えで id が変わる行」{ id, ja, en }。足した文の id は (ja, en) から
   * 作るため、本文を直すと別の行に見えてしまう。作り直したあとに新しい id を引き当てて
   * 開き具合と現在行を引き継ぎ、その id を返す（★の付け替えに使う）。
   */
  function rebuildKeepingView(rebuild, moved) {
    var open = {}, i, rec;
    for (i = 0; i < state.records.length; i++) {
      if (state.records[i].revealed) open[state.records[i].id] = true;
    }
    var wasCurrent = state.currentId;
    var wasShuffled = state.shuffled;
    var wasOrder = [];
    for (i = 0; i < state.order.length; i++) wasOrder.push(state.order[i].id);
    var scrollY = window.pageYOffset;

    rebuild();

    var newId = null;
    if (moved) {
      rec = findRecordByText(moved.ja, moved.en);
      newId = rec ? rec.id : null;
      if (open[moved.id]) {
        delete open[moved.id];
        if (newId) open[newId] = true;
      }
      if (wasCurrent === moved.id) wasCurrent = newId;
      if (newId && newId !== moved.id) {
        for (i = 0; i < wasOrder.length; i++) {
          if (wasOrder[i] === moved.id) wasOrder[i] = newId;
        }
      }
    }

    var lastOpen = null;
    for (i = 0; i < state.records.length; i++) {
      rec = state.records[i];
      if (!open[rec.id]) continue;
      setRevealed(rec, true);
      lastOpen = rec;
    }
    // 覚え直さないと「次の行を開いたら前の行を隠す」が効かなくなる
    state.lastRevealed = lastOpen;
    if (wasCurrent && state.byId[wasCurrent]) setCurrent(state.byId[wasCurrent], false);
    // シャッフル中に作り直したときは、シャッフルし直さずに元の並びへ戻す。
    // 引き直すと読んでいた場所ごと飛んでしまう（1 文足しただけで全部並び替わる）。
    if (wasShuffled && state.records.length) restoreOrder(wasOrder);

    syncToggleAllButton();
    updateStatusBar();
    window.scrollTo(0, scrollY);   // 読んでいた位置に戻す
    return newId;
  }

  /** その文が、いまの検索・絞り込みで隠れているか */
  function isFilteredOut(ja, en) {
    var rec = findRecordByText(ja, en);
    return !!(rec && rec.el && rec.el.hidden);
  }

  /** いま隠している理由を短く言う。無ければ空文字 */
  function whyHidden() {
    if (state.query) {
      return 'いまの検索「' + (elSearch ? trim(elSearch.value) : state.query) + '」に当てはまらないので、表には出ていません。';
    }
    if (state.settings.starredOnly) return '「★だけ表示」なので、表には出ていません。';
    return '絞り込みに当てはまらないので、表には出ていません。';
  }

  function findRecordByText(ja, en) {
    for (var i = 0; i < state.records.length; i++) {
      if (state.records[i].ja === ja && state.records[i].en === en) return state.records[i];
    }
    return null;
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

    rebuildKeepingView(refreshCurrentDeck);
    renderAddedList();
    // 足した文が検索で隠れているなら、そう言う。黙っていると
    //「追加したのに表に出てこない」＝足せていないように見える。
    var hiddenNote = isFilteredOut(ja, en) ? ' ' + whyHidden() : '';
    setAddStatus('「' + ja + '」を追加しました。続けて入力できます。' + hiddenNote, false);
    if (elAddJa) elAddJa.focus();
  }

  /** 行の 🗑 から呼ばれる。自分で足した文だけ消せる */
  function deleteAddedRecord(rec) {
    if (!rec || !rec.added) return;
    if (!window.confirm('「' + rec.ja + '」を削除します。よろしいですか？')) return;
    removeAddedSentence(currentDeckId(), rec.ja, rec.en);
    rebuildKeepingView(refreshCurrentDeck);
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
   * 17c. 1 文ずつ編集する
   *
   * 収録の 360 文は書き換えない。上書き（sunkan:edits）を別に持ち、
   * 表を組み立てるときに当てる。アプリ内で足した文だけは本体を直接直す。
   * ========================================================== */

  var editingId = null;   // 編集中の行の id（開いているセットの中でだけ通じる）

  function setEditStatus(msg, isError) {
    if (!elEditStatus) return;
    elEditStatus.textContent = msg || '';
    if (isError) elEditStatus.setAttribute('data-error', 'true');
    else elEditStatus.removeAttribute('data-error');
  }

  function openEditDialog(rec, invoker) {
    if (!rec) return;
    editingId = rec.id;
    if (elEditJa) elEditJa.value = rec.ja;
    if (elEditEn) elEditEn.value = rec.en;
    if (elEditNote) elEditNote.value = rec.note;

    // 「元に戻す」は上書きを捨てる操作。上書きしていない文と、
    // アプリ内で足した文（戻す先の元データが無い）には出さない。
    if (elEditRevert) elEditRevert.hidden = !rec.edited;
    if (elEditOrigin) {
      elEditOrigin.hidden = !rec.edited;
      elEditOrigin.textContent = rec.edited
        ? '収録の文：' + rec.srcJa + ' / ' + rec.srcEn
        : '';
    }
    setEditStatus('', false);
    openDialog(elEditDialog, invoker);
    if (elEditJa) elEditJa.focus();
  }

  /** 同じ (ja, en) が別の行にもあるか。二つ並ぶとどちらを直したのか分からなくなる */
  function hasSameSentence(exceptId, ja, en) {
    for (var i = 0; i < state.records.length; i++) {
      var rec = state.records[i];
      if (rec.id === exceptId) continue;
      if (rec.ja === ja && rec.en === en) return true;
    }
    return false;
  }

  function submitEditSentence() {
    var rec = editingId ? state.byId[editingId] : null;
    if (!rec) {
      setEditStatus('編集する文が見つかりません。', true);
      return;
    }
    var deckId = currentDeckId();
    var ja = elEditJa ? trim(elEditJa.value) : '';
    var en = elEditEn ? trim(elEditEn.value) : '';
    var note = elEditNote ? trim(elEditNote.value) : '';

    if (!ja || !en) {
      setEditStatus('日本語と英語の両方を入れてください。', true);
      (!ja && elEditJa ? elEditJa : elEditEn).focus();
      return;
    }
    if (hasSameSentence(rec.id, ja, en)) {
      setEditStatus('同じ文がすでにあります。', true);
      return;
    }

    if (rec.added) {
      var oldId = rec.id;
      var wasStarred = isStarred(deckId, oldId);
      if (!updateAddedSentence(deckId, rec.ja, rec.en, ja, en, note)) {
        setEditStatus('編集する文が見つかりません。', true);
        return;
      }
      var newId = rebuildKeepingView(refreshCurrentDeck, { id: oldId, ja: ja, en: en });
      // ★は id に付いている。本文を直すと id ごと変わるので、付け替えないと外れて見える
      if (wasStarred && newId && newId !== oldId) {
        setStar(deckId, oldId, false);
        if (state.byId[newId]) toggleStar(state.byId[newId]);
      }
    } else if (ja === rec.srcJa && en === rec.srcEn && note === rec.srcNote) {
      // 元と同じ中身に戻した＝上書きを持つ意味がない。「元に戻す」と同じ扱いにする
      clearEdit(deckId, rec.id);
      rebuildKeepingView(refreshCurrentDeck);
    } else {
      setEdit(deckId, rec.id, ja, en, note);
      rebuildKeepingView(refreshCurrentDeck);
    }

    renderAddedList();   // 追加ダイアログの一覧にも直した文を出す
    editingId = null;
    var vanished = isFilteredOut(ja, en);
    closeDialog(elEditDialog);
    // 直した文が検索から外れると、表からすっと消える。理由を言わないと
    //「編集したら文が消えた」に見える。
    if (vanished) flashStatus('直しました。' + whyHidden());
  }

  /** 上書きを捨てて収録の文へ戻す */
  function revertEdit() {
    var rec = editingId ? state.byId[editingId] : null;
    if (!rec || rec.added || !rec.edited) return;
    clearEdit(currentDeckId(), rec.id);
    rebuildKeepingView(refreshCurrentDeck);
    editingId = null;
    closeDialog(elEditDialog);
  }

  /* ============================================================
   * 17d. データの持ち出し（バックアップ・CSV）
   *
   * 機種変更のときに手ぶらで移れるようにするための出口。
   * バックアップ（JSON）は同期と同じ形なので、読み込めば★も上書きも戻る。
   * CSV は Excel などで開くためのもので、いま開いているセットの文だけ。
   * ========================================================== */

  function setDataStatus(msg, isError) {
    if (!elDataStatus) return;
    elDataStatus.textContent = msg || '';
    if (isError) elDataStatus.setAttribute('data-error', 'true');
    else elDataStatus.removeAttribute('data-error');
  }

  /** 中身をファイルとして落とす。押しても何も起きない、を作らないため戻り値で返す */
  function downloadText(name, text, mime) {
    try {
      var blob = new window.Blob([text], { type: mime || 'text/plain;charset=utf-8' });
      var url = window.URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      // click() の直後に外すと、ブラウザが download 属性を拾う前に消えてしまい、
      // ファイル名が "download" になる。片付けは少し置いてから。
      window.setTimeout(function () {
        window.URL.revokeObjectURL(url);
        if (a.parentNode) a.parentNode.removeChild(a);
      }, 1000);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** CSV の 1 マス。区切り・引用符・改行が入っていても壊れないように包む */
  function csvCell(v) {
    var t = str(v);
    if (/[",\r\n]/.test(t)) return '"' + t.replace(/"/g, '""') + '"';
    return t;
  }

  /**
   * いま開いているセットを CSV に。
   * 先頭に BOM を付ける。付けないと Excel が UTF-8 と見てくれず、
   * 日本語が文字化けして「開ける」と言った意味がなくなる。
   * 改行も CRLF にしておく（Excel はそちらを好む）。
   */
  function deckToCSV(records) {
    var rows = ['日本語,英語,メモ'];
    for (var i = 0; i < records.length; i++) {
      rows.push(csvCell(records[i].ja) + ',' + csvCell(records[i].en) + ',' + csvCell(records[i].note));
    }
    return '\uFEFF' + rows.join('\r\n') + '\r\n';
  }

  /**
   * ファイル名に使う部分。
   * 日本語のままだと、ブラウザによっては名前ごと捨てられて「download」という
   * 拡張子なしのファイルになる（Excel で開けなくなる）。確実に開けるほうを取り、
   * 英数字だけ残す。どのセットを書き出したかは、画面のほうで名指しする。
   */
  function safeName(name) {
    var t = str(name).replace(/[^A-Za-z0-9 _-]+/g, ' ').replace(/\s+/g, ' ').replace(/^ | $/g, '');
    return t ? t.replace(/ /g, '-') : 'sunkan';
  }

  function todayStamp() {
    var d = new Date();
    function two(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate());
  }

  function exportBackup() {
    var sync = window.SUNKAN_SYNC;
    if (!sync || typeof sync.backupText !== 'function') {
      setDataStatus('この画面では書き出せません。', true);
      return;
    }
    var text, name;
    try {
      text = sync.backupText();
      name = sync.backupName();
    } catch (e) {
      setDataStatus('書き出せませんでした（' + (e && e.message ? e.message : '理由不明') + '）。', true);
      return;
    }
    if (downloadText(name, text, 'application/json')) {
      setDataStatus(name + ' を書き出しました。新しい端末で「バックアップを読み込む」を押してください。', false);
    } else {
      setDataStatus('書き出せませんでした。', true);
    }
  }

  /**
   * 読み込んだファイルを取り込む。
   * バックアップ（JSON）と、書き出した CSV / TSV の両方を受ける。
   * 見分けは中身でする。名前だけで決めると、拡張子の付かない端末で読めなくなる。
   */
  function importBackup(file) {
    var reader = new window.FileReader();
    reader.onload = function () {
      var text = str(reader.result);
      var head = text.replace(/^\uFEFF/, '').replace(/^\s+/, '');
      if (head.charAt(0) === '{' || head.charAt(0) === '[') importBackupJSON(text);
      else importTableFile(file.name, text);
    };
    reader.onerror = function () { setDataStatus('このファイルは読めませんでした。', true); };
    try {
      reader.readAsText(file, 'utf-8');
    } catch (e) {
      setDataStatus('このファイルは読めませんでした。', true);
    }
  }

  function importBackupJSON(text) {
    var sync = window.SUNKAN_SYNC;
    if (!sync || typeof sync.takeBackupText !== 'function') {
      setDataStatus('この画面では読み込めません。', true);
      return;
    }
    var r = sync.takeBackupText(text);
    setDataStatus(r.message, !r.ok);
  }

  /**
   * ファイル名からセット名を作る。拡張子と、こちらが付けた sunkan- と日付を落とす。
   * 端末によっては元の名前ではなく、中身のない id を渡してくることがある
   * （そのままだと 8f3a-… という名前のセットができる）。使えない名前は諦める。
   */
  function deckNameFromFile(fileName) {
    var n = str(fileName).replace(/\.[A-Za-z0-9]+$/, '');
    n = n.replace(/^sunkan-/, '').replace(/-\d{8}$/, '');
    n = trim(n);
    if (!n) return '読み込んだ表';
    if (/^[0-9a-fA-F-]{16,}$/.test(n)) return '読み込んだ表';   // id を渡された
    if (/^(download|untitled|file|document)$/i.test(n)) return '読み込んだ表';
    return n;
  }

  /**
   * 書き出した CSV / TSV を読み戻す。
   * 貼り付けの取り込みと同じ道（parseImportText）を通すので、
   * 引用符も改行もそこの決まりのまま扱える。
   */
  function importTableFile(fileName, text) {
    var clean = str(text).replace(/^\uFEFF/, '');
    var parsed = parseImportText(clean);
    if (!parsed.items.length) {
      setDataStatus('読み込める行がありませんでした。1 列目に日本語、2 列目に英語（カンマまたはタブ区切り）になっているか確かめてください。', true);
      return;
    }
    var name = deckNameFromFile(fileName);
    var result = addSentencesToNamedDeck(name, parsed.items);
    var msg = '「' + result.deckName + '」に ' + result.added + ' 文を読み込みました。';
    if (result.skipped) msg += '（同じ文 ' + result.skipped + ' 件は飛ばしました）';
    setDataStatus(msg, false);
  }

  /** メニューを開くたびに、右側の補足をいまの状態に合わせる */
  function refreshMenuHints() {
    renderVoiceNow();
    if (elCsvHint) {
      elCsvHint.textContent = state.deck ? '「' + state.deck.name + '」' : 'Excel などで開ける';
    }
    if (elMenuSyncHint) {
      var on = false, set = false;
      try {
        set = !!window.localStorage.getItem('sunkan:sync:gistId');
        on = window.localStorage.getItem('sunkan:sync:auto') === '1';
      } catch (e) { set = false; on = false; }
      elMenuSyncHint.textContent = !set ? 'まだ設定していません' : (on ? '自動 ON' : '自動 OFF');
    }
    setDataStatus('', false);
  }

  function exportCSV() {
    if (!state.deck || !state.records.length) {
      setDataStatus('書き出せるセットがありません。', true);
      return;
    }
    var name = 'sunkan-' + safeName(state.deck.name) + '-' + todayStamp() + '.csv';
    if (downloadText(name, deckToCSV(state.records), 'text/csv;charset=utf-8')) {
      setDataStatus('「' + state.deck.name + '」を ' + state.records.length + ' 行、'
        + name + ' に書き出しました。', false);
    } else {
      setDataStatus('書き出せませんでした。', true);
    }
  }

  /* ============================================================
   * 17e. 音声の設定（声を選ぶ）
   *
   * 入っている声は端末ごとに違うので、この設定は同期しない。
   * 覚えておくのは speech.js（声のことは 1 か所に閉じ込める約束）。
   * ========================================================== */

  function speechPortOrNull() {
    var p = window.SUNKAN_SPEECH;
    return (p && typeof p.voices === 'function') ? p : null;
  }

  /** 設定の「音声の設定」の右に、いま使っている声を出す */
  function renderVoiceNow() {
    if (!elVoiceNow) return;
    var port = speechPortOrNull();
    if (!port || !port.supported()) { elVoiceNow.textContent = '使えません'; return; }
    var name = port.voiceName();
    if (!name) { elVoiceNow.textContent = port.chosenVoice() ? '選んだ声が見つかりません' : 'おまかせ'; return; }
    var lang = port.voiceLang();
    elVoiceNow.textContent = port.chosenVoice() ? (name + (lang ? '（' + lang + '）' : '')) : (name + '（おまかせ）');
  }

  function renderVoiceList() {
    if (!elVoiceSelect) return;
    var port = speechPortOrNull();
    elVoiceSelect.innerHTML = '';

    var auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'おまかせ（英語の声を自動で選ぶ）';
    elVoiceSelect.appendChild(auto);

    var list = port ? port.voices() : [];
    for (var i = 0; i < list.length; i++) {
      var opt = document.createElement('option');
      opt.value = list[i].id;
      opt.textContent = list[i].name + (list[i].lang ? '（' + list[i].lang + '）' : '');
      elVoiceSelect.appendChild(opt);
    }
    elVoiceSelect.value = port ? port.chosenVoice() : '';
    // 選んだ声が入っていない端末では value が空に落ちる。おまかせに戻して見せる
    if (elVoiceSelect.value !== (port ? port.chosenVoice() : '')) elVoiceSelect.value = '';

    if (!port || !port.supported()) {
      elVoiceSelect.disabled = true;
      setVoiceStatus('この端末（このブラウザ）は読み上げに対応していません。', true);
    } else if (!list.length) {
      elVoiceSelect.disabled = true;
      setVoiceStatus('英語の声が見つかりません。端末の設定で英語の音声を入れると選べます。', true);
    } else {
      elVoiceSelect.disabled = false;
      setVoiceStatus('', false);
    }
  }

  function setVoiceStatus(msg, isError) {
    if (!elVoiceStatus) return;
    elVoiceStatus.textContent = msg || '';
    if (isError) elVoiceStatus.setAttribute('data-error', 'true');
    else elVoiceStatus.removeAttribute('data-error');
  }

  /* ============================================================
   * 18. ステータスバー
   * ========================================================== */

  function updateStatusBar() {
    if (!elStatusBar) return;
    if (state.flashTimer) {
      window.clearTimeout(state.flashTimer);
      state.flashTimer = null;
    }
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

  /** 知らせを status に少しのあいだ出す。次の描画でふつうの件数に戻る */
  function flashStatus(msg) {
    if (!elStatusBar) return;
    if (state.flashTimer) {
      window.clearTimeout(state.flashTimer);
      state.flashTimer = null;
    }
    elStatusBar.textContent = msg;
    state.flashTimer = window.setTimeout(function () {
      state.flashTimer = null;
      updateStatusBar();
    }, FLASH_MS);
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
      if (recS) speakRecord(recS);
      return;
    }

    var starBtn = target.closest('.row-star');
    if (starBtn && elRows.contains(starBtn)) {
      var recT = recordFromEvent(starBtn);
      if (recT) toggleStar(recT);
      return;
    }

    var editBtn = target.closest('.row-edit');
    if (editBtn && elRows.contains(editBtn)) {
      var recE = recordFromEvent(editBtn);
      if (recE) openEditDialog(recE, editBtn);
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
      // 名前**だけ**入れて「読み込む」を押した＝空のセットを作りたい、と受け取る。
      // ここで何も作らずに終わると、名前を付けたのに何も起きない行き止まりになる。
      if (typedName && !trim(text)) {
        createEmptyDeck(typedName);
        if (elImportName) elImportName.value = '';
        if (elImportPreview) elImportPreview.textContent = '';
        closeDialog(elDataDialog);
        return;
      }
      // 貼った中身があるのに 1 行も読めなかったときは、空のセットを作って
      // 閉じてはいけない。貼ったものが黙って捨てられたように見える。
      if (elImportPreview) {
        elImportPreview.textContent =
          '読み込める行がありません。1 列目に日本語、2 列目に英語（タブまたはカンマ区切り）になっているか確認してください。'
          + ' 空のセットを作りたいときは、貼り付けた文字を消してから、上の「セット名」に名前を入れて「読み込む」を押してください。';
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
    noteDelete('deck:' + deckId);

    // ★のデータも一緒に片付ける
    if (state.stars[deckId]) {
      delete state.stars[deckId];
      saveStars();
    }

    // このセットに足した文も、書き換えた文の上書きも一緒に片付ける
    if (state.added[deckId]) {
      delete state.added[deckId];
      saveAdded();
    }
    if (state.edits[deckId]) {
      delete state.edits[deckId];
      saveEdits();
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
      // 読み上げできない環境では触らせない。押せないだけだと理由が分からないので、下に書く
      elOptAutoSpeak.disabled = !state.speechOK;
    }
    if (elOptAutoSpeakNote) elOptAutoSpeakNote.hidden = state.speechOK;

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
        rebuildKeepingView(refreshCurrentDeck);
        renderAddedList();
        setAddStatus('削除しました。', false);
      });
    }

    // --- 編集ダイアログ ---
    if (elEditSave) elEditSave.addEventListener('click', submitEditSentence);
    if (elEditRevert) elEditRevert.addEventListener('click', revertEdit);
    if (elEditClose) {
      elEditClose.addEventListener('click', function () { closeDialog(elEditDialog); });
    }
    // Enter で次の欄へ／保存する（フォーム送信で黙って閉じてしまうのを防ぐ）
    if (elEditJa) {
      elEditJa.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); if (elEditEn) elEditEn.focus(); }
      });
    }
    if (elEditEn) {
      elEditEn.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submitEditSentence(); }
      });
    }
    if (elEditNote) {
      elEditNote.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submitEditSentence(); }
      });
    }
    if (elEditDialog) {
      // Esc で閉じたときに編集中の行を残さない（次に開いた行と取り違える）。
      // close は少し遅れて届くので、その間に別の行の ✎ を押されていたら消さない
      // （消すと開いたばかりの行を見失って「見つかりません」になる）。
      elEditDialog.addEventListener('close', function () {
        if (!elEditDialog.open) editingId = null;
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

    // --- メニュー ---
    if (elMenuOpen) {
      elMenuOpen.addEventListener('click', function () {
        refreshMenuHints();
        openDialog(elMenuDialog, elMenuOpen);
      });
    }
    if (elMenuClose) {
      elMenuClose.addEventListener('click', function () { closeDialog(elMenuDialog); });
    }
    if (elMenuSync) {
      elMenuSync.addEventListener('click', function () {
        // 同期の設定はもともと ⚙ の中にある。同じ扉をここからも開けるようにする
        var open = $('btn-sync-open');
        closeDialog(elMenuDialog);
        if (open) open.click();
        else setDataStatus('同期の設定を開けませんでした。', true);
      });
    }

    // --- データの持ち出し ---
    if (elBackupOut) elBackupOut.addEventListener('click', exportBackup);
    if (elBackupIn && elBackupFile) {
      elBackupIn.addEventListener('click', function () { elBackupFile.click(); });
      elBackupFile.addEventListener('change', function () {
        var f = elBackupFile.files && elBackupFile.files[0];
        elBackupFile.value = '';   // 同じファイルを選び直せるように
        if (f) importBackup(f);
      });
    }
    if (elCsvOut) elCsvOut.addEventListener('click', exportCSV);

    // --- 音声の設定 ---
    if (elVoiceOpen) {
      elVoiceOpen.addEventListener('click', function () {
        renderVoiceList();
        closeDialog(elMenuDialog);   // シートを重ねない
        openDialog(elVoiceDialog, elMenuOpen);
      });
    }
    if (elVoiceSelect) {
      elVoiceSelect.addEventListener('change', function () {
        var port = speechPortOrNull();
        if (!port) return;
        port.setVoice(elVoiceSelect.value);
        renderVoiceNow();
        setVoiceStatus(elVoiceSelect.value ? 'この声にしました。「聞いてみる」で確かめられます。'
                                           : 'おまかせに戻しました。', false);
      });
    }
    if (elVoiceTest) {
      // タップから同期で呼ぶ（あいだに何か挟むと iOS で鳴らない）
      elVoiceTest.addEventListener('click', function () {
        var port = speechPortOrNull();
        if (!port || !port.supported()) { setVoiceStatus('この端末では読み上げが使えません。', true); return; }
        port.speak('This is how the English will sound.');
        setVoiceStatus('鳴らしています…', false);
      });
    }
    if (elVoiceClose) {
      elVoiceClose.addEventListener('click', function () {
        var port = speechPortOrNull();
        if (port) port.cancel();   // 試し聞きを持ち越さない
        closeDialog(elVoiceDialog);
      });
    }

    // 古い一式が居座って更新が届かないときの逃げ道。update.js が実際の始末をする
    if (elForceUpdate) {
      elForceUpdate.addEventListener('click', function () {
        var u = window.SUNKAN_UPDATE;
        if (!u || typeof u.force !== 'function') {
          if (elForceUpdateStatus) elForceUpdateStatus.textContent = 'この画面では使えません。';
          return;
        }
        elForceUpdate.disabled = true;
        if (elForceUpdateStatus) elForceUpdateStatus.textContent = '新しくしています…';
        u.force();
      });
    }

    // Esc などで閉じたときもフォーカスを戻す
    [elDataDialog, elSettingsDialog, elEditDialog, elVoiceDialog, elMenuDialog].forEach(function (d) {
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
      rebuildKeepingView(refreshCurrentDeck);
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

  /**
   * localStorage を読み直して画面を作り直す（同期で中身が入れ替わったとき用）。
   * 開いているセットは、まだ在れば開いたままにする。
   */
  function reloadFromStorage() {
    // 同期は裏で走る。表を作り直すと、開いていた行の答えが読んでいる最中に
    // 消えてしまうので、開いている行・見ている行・並べ方・見ている位置は
    // rebuildKeepingView に預けて元に戻す。
    rebuildKeepingView(function () {
      loadStars();
      loadAdded();
      loadEdits();
      state.userDecks = loadUserDecks();

      renderDeckSelect();
      renderDeckManageList();
      renderAddedList();

      var keep = state.deck ? state.deck.id : state.settings.deckId;
      selectDeck(keep, { persist: false });
    });
  }

  window.SUNKAN_DRILL = {
    addSentences: addSentencesToNamedDeck,
    splitTable: splitTable,
    /** 同期が中身を入れ替えたあとに呼ぶ */
    reload: reloadFromStorage,
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
    loadEdits();

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
