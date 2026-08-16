/*!
 * パラフレ帳 — モード切り替えと、言い換えの管理（ジャンル・追加・編集・削除）
 * 素の ES2019 ブラウザ JavaScript。モジュール・外部ライブラリ・ビルド不要。
 * 瞬間英作文（app.js）とは状態も保存先も共有しない。触れ合うのは <html data-mode> だけ。
 * DOM の定義は index.html、取り決めは CONTRACT.md を参照。
 */
(function () {
  'use strict';

  /* ============================================================
   * 1. 定数
   * ========================================================== */

  var LS_MODE = 'sunkan:mode';            // 'drill' | 'para'
  var LS_GENRES = 'sunkan:para:genres';
  var LS_CARDS = 'sunkan:para:cards';
  var LS_UI = 'sunkan:para:ui';           // { genreId, mask }

  var MODES = ['drill', 'para'];

  var LINE_COUNT = 4;        // 見出しの下に置ける言い換えの数
  var ALL = '';              // ジャンル絞り込み: すべて
  var NONE = 'none';         // ジャンル絞り込み: ジャンルなし（作るジャンルの id は 'g…' なので衝突しない）

  var FILTER_DEBOUNCE = 120;

  /* ============================================================
   * 2. 小さなユーティリティ（app.js とは独立に持つ）
   * ========================================================== */

  var docEl = document.documentElement;

  function $(id) { return document.getElementById(id); }

  function str(v) {
    if (v === null || v === undefined) return '';
    return typeof v === 'string' ? v : String(v);
  }

  function trim(v) {
    return str(v).replace(/^[\uFEFF\s]+|\s+$/g, '');
  }

  function lsGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }

  function lsSet(key, value) {
    try { window.localStorage.setItem(key, value); return true; } catch (e) { return false; }
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

  /** 一意な id。先頭の文字で種類が分かるようにしておく */
  function uid(prefix) {
    return prefix + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments, self = this;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(function () {
        timer = null;
        fn.apply(self, args);
      }, wait);
    };
  }

  function clearChildren(el) {
    while (el && el.firstChild) el.removeChild(el.firstChild);
  }

  /* ============================================================
   * 3. 保存データの検証（localStorage の中身は信用しない）
   * ========================================================== */

  function sanitizeGenres(raw) {
    var out = [], seen = {}, i;
    if (!Array.isArray(raw)) return out;
    for (i = 0; i < raw.length; i++) {
      var g = raw[i];
      if (!g || typeof g !== 'object') continue;
      var id = trim(g.id);
      var name = trim(g.name);
      if (!id || !name) continue;
      if (id === NONE || seen[id]) continue;
      seen[id] = true;
      out.push({ id: id, name: name });
    }
    return out;
  }

  function sanitizeLines(raw) {
    var out = [], i;
    if (!Array.isArray(raw)) return out;
    for (i = 0; i < raw.length && out.length < LINE_COUNT; i++) {
      var line = raw[i];
      if (!line || typeof line !== 'object') continue;
      var en = trim(line.en);
      var ja = trim(line.ja);
      if (!en && !ja) continue;   // 空の行は持たない
      out.push({ en: en, ja: ja });
    }
    return out;
  }

  function sanitizeCards(raw) {
    var out = [], seen = {}, i;
    if (!Array.isArray(raw)) return out;
    for (i = 0; i < raw.length; i++) {
      var c = raw[i];
      if (!c || typeof c !== 'object') continue;
      var headEn = trim(c.headEn);
      var headJa = trim(c.headJa);
      if (!headEn && !headJa) continue;   // 見出しが無いものは表示できない
      var id = trim(c.id) || uid('p');
      if (seen[id]) id = uid('p');
      seen[id] = true;
      out.push({
        id: id,
        genreId: trim(c.genreId),
        headEn: headEn,
        headJa: headJa,
        lines: sanitizeLines(c.lines)
      });
    }
    return out;
  }

  function sanitizeUI(raw) {
    var ui = { genreId: ALL, mask: false };
    if (!raw || typeof raw !== 'object') return ui;
    if (typeof raw.genreId === 'string') ui.genreId = raw.genreId;
    if (raw.mask === true) ui.mask = true;
    return ui;
  }

  function sanitizeMode(raw) {
    return MODES.indexOf(str(raw)) >= 0 ? str(raw) : 'drill';
  }

  /* ============================================================
   * 4. 状態
   * ========================================================== */

  var state = {
    mode: sanitizeMode(lsGet(LS_MODE)),
    genres: [],
    cards: [],
    genreId: ALL,     // 表示中のジャンル（'' すべて / 'none' ジャンルなし / ジャンル id）
    mask: false,      // 言い換えを伏せているか
    filter: '',       // ジャンル欄に打った文字（ジャンルの絞り込みに使う）
    editingId: null,  // 編集中のパラフレ id（新規は null）
    speechOK: false,
    lastFocus: null
  };

  /* ============================================================
   * 5. DOM 参照
   * ========================================================== */

  var elTabs = $('mode-tabs');
  var elTabDrill = $('tab-drill');
  var elTabPara = $('tab-para');

  var elGenreInput = $('genre-input');
  var elGenreAdd = $('btn-genre-add');
  var elGenreChips = $('genre-chips');
  var elGenreTitle = $('para-genre-title');
  var elMaskBtn = $('btn-para-mask');
  var elMaskLabel = $('btn-para-mask-label');

  var elList = $('para-list');
  var elEmpty = $('para-empty');
  var elStatus = $('para-status');
  var elAddBtn = $('btn-para-add');

  var elCardTemplate = $('para-template');
  var elLineTemplate = $('para-line-template');

  var elDialog = $('para-dialog');
  var elDialogTitle = $('para-dialog-title');
  var elDialogStatus = $('para-dialog-status');
  var elGenreSelect = $('para-genre-select');
  var elHeadEn = $('para-head-en');
  var elHeadJa = $('para-head-ja');
  var elSave = $('btn-para-save');
  var elCancel = $('btn-para-cancel');
  var elNewGenre = $('para-new-genre');
  var elNewGenreBtn = $('btn-para-new-genre');
  var elGenreManageList = $('genre-manage-list');

  /** 言い換え 4 行分の入力欄（英文・意味） */
  var lineInputs = [];
  (function collectLineInputs() {
    for (var i = 1; i <= LINE_COUNT; i++) {
      lineInputs.push({ en: $('para-line-en-' + i), ja: $('para-line-ja-' + i) });
    }
  })();

  /* ============================================================
   * 6. 保存
   * ========================================================== */

  function saveGenres() { return writeJSON(LS_GENRES, state.genres); }
  function saveCards() { return writeJSON(LS_CARDS, state.cards); }
  function saveUI() { return writeJSON(LS_UI, { genreId: state.genreId, mask: state.mask }); }
  function saveMode() { return lsSet(LS_MODE, state.mode); }

  /* ============================================================
   * 7. モード切り替え
   * ========================================================== */

  function setMode(mode, opts) {
    opts = opts || {};
    mode = sanitizeMode(mode);
    state.mode = mode;
    docEl.setAttribute('data-mode', mode);

    if (elTabDrill) {
      elTabDrill.setAttribute('aria-selected', mode === 'drill' ? 'true' : 'false');
      elTabDrill.tabIndex = mode === 'drill' ? 0 : -1;
    }
    if (elTabPara) {
      elTabPara.setAttribute('aria-selected', mode === 'para' ? 'true' : 'false');
      elTabPara.tabIndex = mode === 'para' ? 0 : -1;
    }

    if (opts.persist !== false) saveMode();
    if (opts.focusTab) {
      var tab = mode === 'para' ? elTabPara : elTabDrill;
      if (tab) tab.focus();
    }
  }

  /* ============================================================
   * 8. ジャンル
   * ========================================================== */

  function findGenre(id) {
    for (var i = 0; i < state.genres.length; i++) {
      if (state.genres[i].id === id) return state.genres[i];
    }
    return null;
  }

  function findGenreByName(name) {
    var key = trim(name).toLowerCase();
    if (!key) return null;
    for (var i = 0; i < state.genres.length; i++) {
      if (state.genres[i].name.toLowerCase() === key) return state.genres[i];
    }
    return null;
  }

  function genreName(id) {
    if (id === ALL) return 'すべて';
    if (id === NONE) return 'ジャンルなし';
    var g = findGenre(id);
    return g ? g.name : 'ジャンルなし';
  }

  /** 名前からジャンルを作る。同じ名前があればそれを返す */
  function addGenre(name) {
    name = trim(name);
    if (!name) return null;
    var exist = findGenreByName(name);
    if (exist) return exist;
    var genre = { id: uid('g'), name: name };
    state.genres.push(genre);
    saveGenres();
    return genre;
  }

  /** ジャンルを消す。そこに入っていたパラフレは「ジャンルなし」へ移す */
  function deleteGenre(id) {
    var idx = -1, i;
    for (i = 0; i < state.genres.length; i++) {
      if (state.genres[i].id === id) { idx = i; break; }
    }
    if (idx < 0) return;

    var name = state.genres[idx].name;
    var count = 0;
    for (i = 0; i < state.cards.length; i++) {
      if (state.cards[i].genreId === id) count++;
    }
    var msg = '「' + name + '」を削除します。よろしいですか？';
    if (count) msg += '\n（' + count + ' 枚のパラフレは「ジャンルなし」に移ります）';
    if (!window.confirm(msg)) return;

    state.genres.splice(idx, 1);
    saveGenres();

    if (count) {
      for (i = 0; i < state.cards.length; i++) {
        if (state.cards[i].genreId === id) state.cards[i].genreId = '';
      }
      saveCards();
    }

    if (state.genreId === id) selectGenre(ALL);
    renderGenreChips();
    renderGenreSelect();
    renderGenreManageList();
    renderCards();
  }

  function selectGenre(id) {
    state.genreId = id;
    saveUI();
    renderGenreChips();
    renderGenreTitle();
    renderCards();
  }

  /** いま「ジャンルなし」のパラフレがあるか（あるときだけチップを出す） */
  function hasUngrouped() {
    for (var i = 0; i < state.cards.length; i++) {
      if (!state.cards[i].genreId || !findGenre(state.cards[i].genreId)) return true;
    }
    return false;
  }

  function countInGenre(id) {
    var n = 0;
    for (var i = 0; i < state.cards.length; i++) {
      if (cardGenreKey(state.cards[i]) === id) n++;
    }
    return n;
  }

  /** カードの所属を絞り込み用のキーに直す（消えたジャンルは「ジャンルなし」扱い） */
  function cardGenreKey(card) {
    if (!card.genreId) return NONE;
    return findGenre(card.genreId) ? card.genreId : NONE;
  }

  function makeChip(id, label, count) {
    var li = document.createElement('li');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'genre-chip';
    btn.setAttribute('data-genre-id', id);
    btn.setAttribute('aria-pressed', state.genreId === id ? 'true' : 'false');

    var nameSpan = document.createElement('span');
    nameSpan.className = 'genre-chip-name';
    nameSpan.textContent = label;
    btn.appendChild(nameSpan);

    var countSpan = document.createElement('span');
    countSpan.className = 'genre-chip-count';
    countSpan.textContent = String(count);
    btn.appendChild(countSpan);

    li.appendChild(btn);
    return li;
  }

  function renderGenreChips() {
    if (!elGenreChips) return;
    clearChildren(elGenreChips);

    var filter = state.filter.toLowerCase();
    var frag = document.createDocumentFragment();

    // 「すべて」は絞り込み中でも残す（戻れなくならないように）
    frag.appendChild(makeChip(ALL, 'すべて', state.cards.length));

    var shown = 0, i;
    for (i = 0; i < state.genres.length; i++) {
      var g = state.genres[i];
      if (filter && g.name.toLowerCase().indexOf(filter) < 0) continue;
      frag.appendChild(makeChip(g.id, g.name, countInGenre(g.id)));
      shown++;
    }

    if (hasUngrouped() && (!filter || 'ジャンルなし'.indexOf(state.filter) >= 0)) {
      frag.appendChild(makeChip(NONE, 'ジャンルなし', countInGenre(NONE)));
      shown++;
    }

    elGenreChips.appendChild(frag);

    if (filter && !shown) {
      var li = document.createElement('li');
      li.className = 'genre-chips-empty';
      li.textContent = '「' + state.filter + '」というジャンルはまだありません。';
      elGenreChips.appendChild(li);
    }
  }

  function renderGenreTitle() {
    if (!elGenreTitle) return;
    elGenreTitle.textContent = genreName(state.genreId);
  }

  /** ジャンル欄の内容に合わせて「作る」ボタンの状態を決める */
  function syncGenreAddButton() {
    if (!elGenreAdd) return;
    var name = elGenreInput ? trim(elGenreInput.value) : '';
    elGenreAdd.disabled = !name || !!findGenreByName(name);
  }

  function submitGenreFromInput() {
    var name = elGenreInput ? trim(elGenreInput.value) : '';
    if (!name) {
      if (elGenreInput) elGenreInput.focus();
      return;
    }
    var exist = findGenreByName(name);
    var genre = exist || addGenre(name);
    if (!genre) return;

    if (elGenreInput) elGenreInput.value = '';
    state.filter = '';
    syncGenreAddButton();
    selectGenre(genre.id);
    renderGenreSelect();
    renderGenreManageList();
  }

  /* ============================================================
   * 9. パラフレの描画
   * ========================================================== */

  function visibleCards() {
    if (state.genreId === ALL) return state.cards.slice();
    var out = [];
    for (var i = 0; i < state.cards.length; i++) {
      if (cardGenreKey(state.cards[i]) === state.genreId) out.push(state.cards[i]);
    }
    return out;
  }

  function createCardElement(card) {
    var frag = elCardTemplate.content.cloneNode(true);
    var li = frag.querySelector('.para-card');
    var head = li.querySelector('.para-head');
    var headEn = li.querySelector('.para-head-en');
    var headJa = li.querySelector('.para-head-ja');
    var lines = li.querySelector('.para-lines');
    var tag = li.querySelector('.para-genre-tag');
    var speakBtn = li.querySelector('.para-speak');

    li.setAttribute('data-id', card.id);
    headEn.textContent = card.headEn;

    if (card.headJa) headJa.textContent = card.headJa;
    else headJa.hidden = true;

    for (var i = 0; i < card.lines.length; i++) {
      var lineFrag = elLineTemplate.content.cloneNode(true);
      var lineEl = lineFrag.querySelector('.para-line');
      var enEl = lineFrag.querySelector('.para-line-en');
      var jaEl = lineFrag.querySelector('.para-line-ja');
      enEl.textContent = card.lines[i].en;
      if (card.lines[i].ja) jaEl.textContent = card.lines[i].ja;
      else jaEl.hidden = true;
      lines.appendChild(lineEl);
    }

    if (!card.lines.length) {
      var note = document.createElement('li');
      note.className = 'para-line para-line--empty';
      note.textContent = '言い換えはまだ入っていません。✎ から足せます。';
      lines.appendChild(note);
    }

    tag.textContent = genreName(cardGenreKey(card));

    // 読み上げできない環境ではボタンごと隠す
    if (speakBtn && !state.speechOK) speakBtn.hidden = true;
    if (speakBtn && !card.headEn) speakBtn.hidden = true;

    // 伏せていないときは開いた状態から始める
    if (!state.mask) {
      li.classList.add('is-revealed');
      head.setAttribute('aria-expanded', 'true');
    } else {
      head.setAttribute('aria-expanded', 'false');
    }

    return li;
  }

  function renderCards() {
    if (!elList || !elCardTemplate || !elLineTemplate) return;

    var list = visibleCards();
    var frag = document.createDocumentFragment();
    for (var i = 0; i < list.length; i++) {
      frag.appendChild(createCardElement(list[i]));
    }
    clearChildren(elList);
    elList.appendChild(frag);

    if (elEmpty) {
      if (list.length) {
        elEmpty.hidden = true;
      } else {
        elEmpty.hidden = false;
        elEmpty.textContent = state.cards.length
          ? '「' + genreName(state.genreId) + '」にはまだパラフレがありません。'
          : 'まだパラフレがありません。下の「＋ パラフレを追加」から作れます。';
      }
    }

    updateStatus(list.length);
  }

  function updateStatus(shown) {
    if (!elStatus) return;
    if (!state.cards.length) {
      elStatus.textContent = '';
      return;
    }
    var text = '全 ' + state.cards.length + ' 枚';
    if (state.genreId !== ALL) {
      text += ' / ' + genreName(state.genreId) + ' ' + shown + ' 枚';
    }
    elStatus.textContent = text;
  }

  /* ============================================================
   * 10. 伏せる / めくる
   * ========================================================== */

  function setMask(on) {
    state.mask = !!on;
    docEl.setAttribute('data-para-mask', state.mask ? 'on' : 'off');
    var label = state.mask ? '言い換えを出す' : '言い換えを隠す';
    if (elMaskBtn) {
      elMaskBtn.setAttribute('aria-pressed', state.mask ? 'true' : 'false');
      // 狭幅では文字が畳まれて絵文字だけになるので、名前は属性でも持たせる
      elMaskBtn.setAttribute('aria-label', label);
    }
    if (elMaskLabel) elMaskLabel.textContent = label;
    saveUI();

    // 伏せ始めたら全部閉じ、やめたら全部開く
    var cards = elList ? elList.querySelectorAll('.para-card') : [];
    for (var i = 0; i < cards.length; i++) {
      var head = cards[i].querySelector('.para-head');
      if (state.mask) {
        cards[i].classList.remove('is-revealed');
        if (head) head.setAttribute('aria-expanded', 'false');
      } else {
        cards[i].classList.add('is-revealed');
        if (head) head.setAttribute('aria-expanded', 'true');
      }
    }
  }

  function toggleCard(li) {
    if (!state.mask) return;   // 伏せていないときは開閉しない
    var head = li.querySelector('.para-head');
    var on = !li.classList.contains('is-revealed');
    if (on) li.classList.add('is-revealed');
    else li.classList.remove('is-revealed');
    if (head) head.setAttribute('aria-expanded', on ? 'true' : 'false');
  }

  /* ============================================================
   * 11. 読み上げ
   * ========================================================== */

  var speechVoice = null;

  function initSpeech() {
    state.speechOK = !!(window.speechSynthesis && typeof window.SpeechSynthesisUtterance === 'function');
    if (!state.speechOK) return;
    pickVoice();
    try {
      window.speechSynthesis.onvoiceschanged = pickVoice;
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

  /** 見出しと言い換えを続けて読む（1 回の発話にまとめる） */
  function speakCard(card) {
    if (!state.speechOK || !card) return;
    var parts = [];
    if (card.headEn) parts.push(card.headEn);
    for (var i = 0; i < card.lines.length; i++) {
      if (card.lines[i].en) parts.push(card.lines[i].en);
    }
    if (!parts.length) return;
    try {
      window.speechSynthesis.cancel();
      var u = new window.SpeechSynthesisUtterance(parts.join(' … '));
      u.lang = 'en-US';
      if (speechVoice) u.voice = speechVoice;
      u.rate = 1;
      window.speechSynthesis.speak(u);
    } catch (e) { /* 読み上げできなくても致命的ではない */ }
  }

  /* ============================================================
   * 12. ダイアログ（<dialog> が無い環境でも壊れない）
   * ========================================================== */

  function openDialog(dialog, invoker) {
    if (!dialog) return;
    state.lastFocus = invoker || document.activeElement;
    if (typeof dialog.showModal === 'function') {
      try { dialog.showModal(); return; } catch (e) { /* すでに open のときなど */ }
    }
    dialog.setAttribute('open', '');
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

  function setDialogStatus(msg, isError) {
    if (!elDialogStatus) return;
    elDialogStatus.textContent = msg || '';
    if (isError) elDialogStatus.setAttribute('data-error', 'true');
    else elDialogStatus.removeAttribute('data-error');
  }

  /** ダイアログのジャンル欄（<select>）を作り直す */
  function renderGenreSelect() {
    if (!elGenreSelect) return;
    var keep = elGenreSelect.value;
    clearChildren(elGenreSelect);

    var none = document.createElement('option');
    none.value = '';
    none.textContent = 'ジャンルなし';
    elGenreSelect.appendChild(none);

    for (var i = 0; i < state.genres.length; i++) {
      var opt = document.createElement('option');
      opt.value = state.genres[i].id;
      opt.textContent = state.genres[i].name;
      elGenreSelect.appendChild(opt);
    }
    elGenreSelect.value = findGenre(keep) ? keep : '';
  }

  /** ダイアログ下部のジャンル一覧（名前・枚数・削除） */
  function renderGenreManageList() {
    if (!elGenreManageList) return;
    clearChildren(elGenreManageList);

    for (var i = 0; i < state.genres.length; i++) {
      var g = state.genres[i];
      var li = document.createElement('li');

      var nameSpan = document.createElement('span');
      nameSpan.textContent = g.name;

      var countSpan = document.createElement('span');
      countSpan.className = 'deck-manage-count';
      countSpan.textContent = countInGenre(g.id) + ' 枚';

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'genre-manage-delete';
      del.textContent = '削除';
      del.setAttribute('data-genre-id', g.id);
      del.setAttribute('aria-label', g.name + ' を削除');

      li.appendChild(nameSpan);
      li.appendChild(countSpan);
      li.appendChild(del);
      elGenreManageList.appendChild(li);
    }
  }

  function findCard(id) {
    for (var i = 0; i < state.cards.length; i++) {
      if (state.cards[i].id === id) return state.cards[i];
    }
    return null;
  }

  /** 入力欄を空にするか、編集するパラフレの内容で埋める */
  function fillDialog(card) {
    if (elHeadEn) elHeadEn.value = card ? card.headEn : '';
    if (elHeadJa) elHeadJa.value = card ? card.headJa : '';
    for (var i = 0; i < lineInputs.length; i++) {
      var line = card && card.lines[i] ? card.lines[i] : null;
      if (lineInputs[i].en) lineInputs[i].en.value = line ? line.en : '';
      if (lineInputs[i].ja) lineInputs[i].ja.value = line ? line.ja : '';
    }
    if (elGenreSelect) {
      var wanted = card ? card.genreId : (findGenre(state.genreId) ? state.genreId : '');
      elGenreSelect.value = findGenre(wanted) ? wanted : '';
    }
  }

  function openParaDialog(cardId, invoker) {
    var card = cardId ? findCard(cardId) : null;
    state.editingId = card ? card.id : null;

    renderGenreSelect();
    renderGenreManageList();
    fillDialog(card);
    setDialogStatus('', false);

    if (elDialogTitle) elDialogTitle.textContent = card ? 'パラフレを編集' : 'パラフレを追加';
    if (elSave) elSave.textContent = card ? '保存する' : '追加する';

    openDialog(elDialog, invoker);
    if (elHeadEn) elHeadEn.focus();
  }

  /** 入力欄から 1 枚分を組み立てて保存する */
  function submitParaCard() {
    var headEn = elHeadEn ? trim(elHeadEn.value) : '';
    var headJa = elHeadJa ? trim(elHeadJa.value) : '';

    if (!headEn) {
      setDialogStatus('見出しの英文を入れてください。', true);
      if (elHeadEn) elHeadEn.focus();
      return;
    }

    var lines = [];
    for (var i = 0; i < lineInputs.length; i++) {
      var en = lineInputs[i].en ? trim(lineInputs[i].en.value) : '';
      var ja = lineInputs[i].ja ? trim(lineInputs[i].ja.value) : '';
      if (!en && !ja) continue;
      lines.push({ en: en, ja: ja });
    }

    var genreId = elGenreSelect ? trim(elGenreSelect.value) : '';
    if (genreId && !findGenre(genreId)) genreId = '';

    var card = state.editingId ? findCard(state.editingId) : null;
    if (card) {
      card.genreId = genreId;
      card.headEn = headEn;
      card.headJa = headJa;
      card.lines = lines;
    } else {
      card = { id: uid('p'), genreId: genreId, headEn: headEn, headJa: headJa, lines: lines };
      state.cards.push(card);
    }
    var ok = saveCards();

    // 追加したものが見えないままにならないよう、別ジャンルを見ていたら移動する
    if (state.genreId !== ALL && cardGenreKey(card) !== state.genreId) {
      selectGenre(cardGenreKey(card));
    } else {
      renderGenreChips();
      renderCards();
    }
    renderGenreManageList();

    if (state.editingId) {
      state.editingId = null;
      closeDialog(elDialog);
      return;
    }

    // 続けて入れられるよう、欄を空にして見出しへ戻す
    fillDialog(null);
    setDialogStatus(
      ok === false
        ? '追加しました（この端末には保存できませんでした）。'
        : '「' + headEn + '」を追加しました。続けて入力できます。',
      false
    );
    if (elHeadEn) elHeadEn.focus();
  }

  function deleteCard(id) {
    var idx = -1;
    for (var i = 0; i < state.cards.length; i++) {
      if (state.cards[i].id === id) { idx = i; break; }
    }
    if (idx < 0) return;
    if (!window.confirm('「' + state.cards[idx].headEn + '」を削除します。よろしいですか？')) return;

    state.cards.splice(idx, 1);
    saveCards();
    renderGenreChips();
    renderGenreManageList();
    renderCards();
  }

  /* ============================================================
   * 13. イベント
   * ========================================================== */

  var runGenreFilter = debounce(function () {
    state.filter = elGenreInput ? trim(elGenreInput.value) : '';
    renderGenreChips();
  }, FILTER_DEBOUNCE);

  function onListClick(e) {
    var target = e.target;
    if (!target || !target.closest) return;

    var li = target.closest('.para-card');
    if (!li || !elList.contains(li)) return;
    var id = li.getAttribute('data-id');

    if (target.closest('.para-speak')) {
      speakCard(findCard(id));
      return;
    }
    if (target.closest('.para-edit')) {
      openParaDialog(id, target.closest('.para-edit'));
      return;
    }
    if (target.closest('.para-delete')) {
      deleteCard(id);
      return;
    }
    if (target.closest('.para-head')) {
      toggleCard(li);
    }
  }

  function onTabsKeyDown(e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setMode(state.mode === 'drill' ? 'para' : 'drill', { focusTab: true });
  }

  /** 言い換えの欄で Enter を押したら、そのまま保存する */
  function bindEnterToSave(input) {
    if (!input) return;
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submitParaCard(); }
    });
  }

  function bindEvents() {
    if (elTabDrill) elTabDrill.addEventListener('click', function () { setMode('drill'); });
    if (elTabPara) elTabPara.addEventListener('click', function () { setMode('para'); });
    if (elTabs) elTabs.addEventListener('keydown', onTabsKeyDown);

    if (elGenreInput) {
      elGenreInput.addEventListener('input', function () {
        runGenreFilter();
        syncGenreAddButton();
      });
      elGenreInput.addEventListener('search', function () {
        runGenreFilter();
        syncGenreAddButton();
      });
      elGenreInput.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        submitGenreFromInput();
      });
    }
    if (elGenreAdd) elGenreAdd.addEventListener('click', submitGenreFromInput);

    if (elGenreChips) {
      elGenreChips.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.genre-chip') : null;
        if (!btn) return;
        selectGenre(btn.getAttribute('data-genre-id') || ALL);
      });
    }

    if (elMaskBtn) {
      elMaskBtn.addEventListener('click', function () { setMask(!state.mask); });
    }

    if (elList) elList.addEventListener('click', onListClick);
    if (elAddBtn) {
      elAddBtn.addEventListener('click', function () { openParaDialog(null, elAddBtn); });
    }

    if (elSave) elSave.addEventListener('click', submitParaCard);
    if (elCancel) {
      elCancel.addEventListener('click', function () {
        state.editingId = null;
        closeDialog(elDialog);
      });
    }

    // 見出しの欄で Enter を押したら次へ、言い換えの欄では保存する
    if (elHeadEn) {
      elHeadEn.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); if (elHeadJa) elHeadJa.focus(); }
      });
    }
    if (elHeadJa) {
      elHeadJa.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (lineInputs[0] && lineInputs[0].en) lineInputs[0].en.focus();
      });
    }
    for (var i = 0; i < lineInputs.length; i++) {
      bindEnterToSave(lineInputs[i].en);
      bindEnterToSave(lineInputs[i].ja);
    }

    if (elNewGenreBtn) {
      elNewGenreBtn.addEventListener('click', function () {
        var name = elNewGenre ? trim(elNewGenre.value) : '';
        if (!name) {
          setDialogStatus('ジャンルの名前を入れてください。', true);
          if (elNewGenre) elNewGenre.focus();
          return;
        }
        if (findGenreByName(name)) {
          setDialogStatus('同じ名前のジャンルがすでにあります。', true);
          return;
        }
        var genre = addGenre(name);
        if (elNewGenre) elNewGenre.value = '';
        renderGenreSelect();
        renderGenreManageList();
        renderGenreChips();
        syncGenreAddButton();
        if (elGenreSelect && genre) elGenreSelect.value = genre.id;
        setDialogStatus('「' + name + '」を作りました。', false);
      });
    }
    if (elNewGenre) {
      elNewGenre.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); if (elNewGenreBtn) elNewGenreBtn.click(); }
      });
    }

    if (elGenreManageList) {
      elGenreManageList.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.genre-manage-delete') : null;
        if (!btn) return;
        e.preventDefault();
        deleteGenre(btn.getAttribute('data-genre-id'));
      });
    }

    if (elDialog) {
      elDialog.addEventListener('close', function () {
        state.editingId = null;
        restoreFocus();
      });
    }
  }

  /* ============================================================
   * 14. 起動
   * ========================================================== */

  function init() {
    if (!elList || !elCardTemplate || !elLineTemplate) return; // DOM が想定と違うときは何もしない

    initSpeech();

    state.genres = sanitizeGenres(readJSON(LS_GENRES));
    state.cards = sanitizeCards(readJSON(LS_CARDS));

    var ui = sanitizeUI(readJSON(LS_UI));
    state.genreId = (ui.genreId === ALL || ui.genreId === NONE || findGenre(ui.genreId)) ? ui.genreId : ALL;

    setMode(state.mode, { persist: false });
    setMask(ui.mask);

    renderGenreChips();
    renderGenreTitle();
    renderGenreSelect();
    renderGenreManageList();
    renderCards();
    syncGenreAddButton();

    bindEvents();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
