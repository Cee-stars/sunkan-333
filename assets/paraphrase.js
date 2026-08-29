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
  var LS_STARS = 'sunkan:para:stars';     // ★を付けたパラフレの id
  var LS_UI = 'sunkan:para:ui';           // { genreId, mask, sort, starredOnly }

  var MODES = ['drill', 'para'];
  var SORTS = ['added', 'newest', 'alpha', 'genre'];

  var LINE_COUNT = 4;        // 見出しの下に置ける言い換えの数
  var ALL = '';              // ジャンル絞り込み: すべて
  var NONE = 'none';         // ジャンル絞り込み: ジャンルなし（作るジャンルの id は 'g…' なので衝突しない）

  var SEND_DECK_PREFIX = 'パラフレ帳';   // 送り先の瞬間英作文セット名

  var FILTER_DEBOUNCE = 120;
  var SEARCH_DEBOUNCE = 120;
  var FLASH_MS = 4000;       // 送った結果などを status に出しておく時間

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

  function sanitizeStars(raw) {
    var out = [];
    if (!Array.isArray(raw)) return out;
    for (var i = 0; i < raw.length; i++) {
      if (typeof raw[i] === 'string' && raw[i] && out.indexOf(raw[i]) < 0) out.push(raw[i]);
    }
    return out;
  }

  function sanitizeUI(raw) {
    var ui = { genreId: ALL, mask: false, sort: 'added', starredOnly: false };
    if (!raw || typeof raw !== 'object') return ui;
    if (typeof raw.genreId === 'string') ui.genreId = raw.genreId;
    if (raw.mask === true) ui.mask = true;
    if (SORTS.indexOf(str(raw.sort)) >= 0) ui.sort = str(raw.sort);
    if (raw.starredOnly === true) ui.starredOnly = true;
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
    stars: [],        // ★を付けたパラフレの id
    genreId: ALL,     // 表示中のジャンル（'' すべて / 'none' ジャンルなし / ジャンル id）
    mask: false,      // 言い換えを伏せているか
    filter: '',       // ジャンル欄に打った文字（ジャンルの絞り込みに使う）
    query: '',        // 検索欄に打った文字（パラフレ本文の絞り込み）
    sort: 'added',    // 並べ替え
    starredOnly: false,
    shuffleOrder: null, // シャッフル中の並び（id の配列）。解除で null に戻す
    editingId: null,  // 編集中のパラフレ id（新規は null）
    speechOK: false,
    flashTimer: null,
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

  var elSearch = $('para-search');
  var elSearchClear = $('btn-para-search-clear');
  var elSort = $('para-sort');
  var elShuffle = $('btn-para-shuffle');
  var elStarredOnly = $('btn-para-starred');
  var elDataBtn = $('btn-para-data');

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

  var elDataDialog = $('para-data-dialog');
  var elImportText = $('para-import-text');
  var elImportPreview = $('para-import-preview');
  var elImportCancel = $('btn-para-import-cancel');
  var elImportSave = $('btn-para-import-save');
  var elExport = $('btn-para-export');
  var elSendAll = $('btn-para-send-all');

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
  function saveStars() { return writeJSON(LS_STARS, state.stars); }
  function saveMode() { return lsSet(LS_MODE, state.mode); }

  function saveUI() {
    return writeJSON(LS_UI, {
      genreId: state.genreId,
      mask: state.mask,
      sort: state.sort,
      starredOnly: state.starredOnly
    });
  }

  /* ============================================================
   * 7. モード切り替え
   * ========================================================== */

  function setMode(mode, opts) {
    opts = opts || {};
    mode = sanitizeMode(mode);
    var moved = state.mode !== mode;
    state.mode = mode;
    docEl.setAttribute('data-mode', mode);

    // 画面が入れ替わったら、鳴っている読み上げは持ち越さない
    if (moved) {
      var port = speechPort();
      if (port) port.cancel();
    }

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

  /* 同期に「消した」を伝える。sync.js が読み込まれていなければ何もしない。
     ここを通しておかないと、消したパラフレが同期でまた戻ってくる。
     足し直すときは必ず新しい id が付くので、消した記録と当たることはない。 */
  function noteDelete(key) {
    var s = window.SUNKAN_SYNC;
    if (s && typeof s.recordDelete === 'function') s.recordDelete(key);
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
    noteDelete('genre:' + id);

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

  /* --- ★ --- */

  function isStarred(id) {
    return state.stars.indexOf(id) >= 0;
  }

  function setStar(id, on) {
    var idx = state.stars.indexOf(id);
    if (on && idx < 0) state.stars.push(id);
    if (!on && idx >= 0) state.stars.splice(idx, 1);
    saveStars();
    // 外したことを伝えないと、同期の足し算で相手側の★が戻ってくる
    var sync = window.SUNKAN_SYNC;
    if (!sync) return;
    var key = 'parastar:' + id;
    if (on) { if (typeof sync.clearDelete === 'function') sync.clearDelete(key); }
    else { if (typeof sync.recordDelete === 'function') sync.recordDelete(key); }
  }

  /* --- 絞り込みと並べ替え --- */

  /** 検索に使う文字列（見出し・言い換え・ジャンル名をまとめて小文字で持つ） */
  function cardHaystack(card) {
    var parts = [card.headEn, card.headJa, genreName(cardGenreKey(card))];
    for (var i = 0; i < card.lines.length; i++) {
      parts.push(card.lines[i].en, card.lines[i].ja);
    }
    return parts.join('\n').toLowerCase();
  }

  function sortCards(list) {
    // シャッフル中は、そのときに決めた並びをそのまま使う（絞り込みを変えても崩れない）
    if (state.shuffleOrder) {
      var pos = {}, i;
      for (i = 0; i < state.shuffleOrder.length; i++) pos[state.shuffleOrder[i]] = i;
      list.sort(function (a, b) {
        var pa = pos[a.id] === undefined ? Infinity : pos[a.id];
        var pb = pos[b.id] === undefined ? Infinity : pos[b.id];
        return pa - pb;
      });
      return list;
    }

    if (state.sort === 'newest') {
      list.reverse();                       // 追加順の逆＝新しい順
    } else if (state.sort === 'alpha') {
      list.sort(function (a, b) {
        return a.headEn.toLowerCase().localeCompare(b.headEn.toLowerCase());
      });
    } else if (state.sort === 'genre') {
      list.sort(function (a, b) {
        var ga = genreName(cardGenreKey(a));
        var gb = genreName(cardGenreKey(b));
        if (ga !== gb) return ga.localeCompare(gb, 'ja');
        return a.headEn.toLowerCase().localeCompare(b.headEn.toLowerCase());
      });
    }
    return list;                            // 'added' は state.cards の順のまま
  }

  function visibleCards() {
    var out = [];
    var q = state.query;
    for (var i = 0; i < state.cards.length; i++) {
      var card = state.cards[i];
      if (state.genreId !== ALL && cardGenreKey(card) !== state.genreId) continue;
      if (state.starredOnly && !isStarred(card.id)) continue;
      if (q && cardHaystack(card).indexOf(q) < 0) continue;
      out.push(card);
    }
    return sortCards(out);
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
    var starBtn = li.querySelector('.para-star');
    var sendBtn = li.querySelector('.para-send');

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

    if (starBtn && isStarred(card.id)) {
      li.classList.add('is-starred');
      starBtn.setAttribute('aria-pressed', 'true');
      starBtn.setAttribute('aria-label', 'チェックを外す');
    }

    // 読み上げできない環境ではボタンごと隠す
    if (speakBtn && !state.speechOK) speakBtn.hidden = true;
    if (speakBtn && !card.headEn) speakBtn.hidden = true;

    // 瞬間英作文側が読み込まれていないときは送りようがない
    if (sendBtn && !drillAPI()) sendBtn.hidden = true;

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

    // 並べ替え・検索・同期のどれで作り直しても、めくってあった札は開いたままにする。
    // 閉じてしまうと、読んでいる最中に答えが消える。
    var open = {}, i;
    var shown = elList.querySelectorAll('.para-card.is-revealed');
    for (i = 0; i < shown.length; i++) open[shown[i].getAttribute('data-id')] = true;

    var list = visibleCards();
    var frag = document.createDocumentFragment();
    for (i = 0; i < list.length; i++) {
      var el = createCardElement(list[i]);
      if (state.mask && open[list[i].id]) {
        el.classList.add('is-revealed');
        var head = el.querySelector('.para-head');
        if (head) head.setAttribute('aria-expanded', 'true');
      }
      frag.appendChild(el);
    }
    clearChildren(elList);
    elList.appendChild(frag);

    if (elEmpty) {
      if (list.length) {
        elEmpty.hidden = true;
      } else {
        elEmpty.hidden = false;
        elEmpty.textContent = emptyMessage();
      }
    }
    if (elSearchClear) elSearchClear.hidden = !state.query;

    updateStatus(list.length);
  }

  function emptyMessage() {
    if (!state.cards.length) {
      return 'まだパラフレがありません。下の「＋ パラフレを追加」から作れます。';
    }
    if (state.query) return '「' + trim(elSearch ? elSearch.value : '') + '」に当てはまるパラフレがありません。';
    if (state.starredOnly) return '★を付けたパラフレがまだありません。';
    return '「' + genreName(state.genreId) + '」にはまだパラフレがありません。';
  }

  function updateStatus(shown) {
    if (!elStatus) return;
    // 知らせは出したあとに書くので、ここでは黙って上書きしてよい。
    // 次に何か操作すれば、そのときの描画でふつうの件数に戻る。
    if (state.flashTimer) {
      window.clearTimeout(state.flashTimer);
      state.flashTimer = null;
    }
    if (!state.cards.length) {
      elStatus.textContent = '';
      return;
    }
    var text = '全 ' + state.cards.length + ' 枚';
    if (shown !== state.cards.length) text += ' / 表示中 ' + shown + ' 枚';
    var marks = [];
    if (state.genreId !== ALL) marks.push(genreName(state.genreId));
    if (state.starredOnly) marks.push('★だけ');
    if (state.shuffleOrder) marks.push('シャッフル中');
    if (marks.length) text += '［' + marks.join(' / ') + '］';
    elStatus.textContent = text;
  }

  /** 送った結果などを status に少しのあいだ出す（次の描画までは残る） */
  function flash(msg) {
    if (!elStatus) return;
    if (state.flashTimer) {
      window.clearTimeout(state.flashTimer);
      state.flashTimer = null;
    }
    elStatus.textContent = msg;
    state.flashTimer = window.setTimeout(function () {
      state.flashTimer = null;
      updateStatus(visibleCards().length);
    }, FLASH_MS);
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

  /** speech.js が開けている口。読み込まれていなければ null */
  function speechPort() {
    return (window.SUNKAN_SPEECH && typeof window.SUNKAN_SPEECH.speak === 'function')
      ? window.SUNKAN_SPEECH : null;
  }

  function initSpeech() {
    var port = speechPort();
    state.speechOK = !!(port && port.supported());
    if (!port) return;
    // 黙って失敗しないよう理由を出す。表を開いている間は向こうが出すので、こちらは黙る。
    port.onProblem(function (info) {
      if (docEl.getAttribute('data-mode') !== 'para') return;
      flash('読み上げ: ' + (info && info.message ? info.message : 'うまくいきませんでした。'));
    });
  }

  /** 見出しと言い換えを続けて読む（タップから同期で呼ぶこと） */
  function speakCard(card) {
    var port = speechPort();
    if (!port || !card) return;
    if (!state.speechOK) {
      flash('読み上げ: この端末では読み上げが使えません。');
      return;
    }
    var parts = [];
    if (card.headEn) parts.push(card.headEn);
    for (var i = 0; i < card.lines.length; i++) {
      if (card.lines[i].en) parts.push(card.lines[i].en);
    }
    if (!parts.length) return;
    port.speak(parts.join(' … '));
  }

  /* ============================================================
   * 12. 瞬間英作文へ送る
   * ========================================================== */

  /** app.js が開けている口。読み込まれていなければ null */
  function drillAPI() {
    var api = window.SUNKAN_DRILL;
    return (api && typeof api.addSentences === 'function') ? api : null;
  }

  /**
   * パラフレ 1 枚を {ja,en,note} の並びに直す。
   * 同じ日本語に英文が何通りも付くので、瞬間英作文では
   * 「この意味を、別の言い方でも言えるか」を試す形になる。
   */
  function cardToItems(card) {
    var items = [];
    var meaning = card.headJa;
    if (card.headEn && meaning) items.push({ ja: meaning, en: card.headEn, note: '' });
    for (var i = 0; i < card.lines.length; i++) {
      var en = card.lines[i].en;
      var ja = card.lines[i].ja || meaning;
      if (!en || !ja) continue;
      items.push({ ja: ja, en: en, note: card.headEn ? '元の文: ' + card.headEn : '' });
    }
    return items;
  }

  function sendDeckName(genreKey) {
    if (genreKey === ALL || genreKey === NONE) return SEND_DECK_PREFIX;
    return SEND_DECK_PREFIX + '（' + genreName(genreKey) + '）';
  }

  /** 何枚かまとめて送る。ジャンルごとにセットを分ける */
  function sendCards(cards) {
    var api = drillAPI();
    if (!api) {
      flash('瞬間英作文側が読み込めていないので送れませんでした。');
      return;
    }

    var groups = {}, order = [], i;
    for (i = 0; i < cards.length; i++) {
      var key = cardGenreKey(cards[i]);
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key] = groups[key].concat(cardToItems(cards[i]));
    }

    var added = 0, skipped = 0, names = [];
    for (i = 0; i < order.length; i++) {
      var items = groups[order[i]];
      if (!items.length) continue;
      var res = api.addSentences(sendDeckName(order[i]), items);
      added += res.added;
      skipped += res.skipped;
      if (names.indexOf(res.deckName) < 0) names.push(res.deckName);
    }

    if (!added && !skipped) {
      flash('日本語の意味が入っていないので送れませんでした。');
      return;
    }
    var msg = names.length === 1
      ? '「' + names[0] + '」に ' + added + ' 文送りました。'
      : added + ' 文を ' + names.length + ' つのセットに送りました。';
    if (skipped) msg += '（' + skipped + ' 文は同じ文があったので省きました）';
    flash(msg);
  }

  /* ============================================================
   * 13. 表で出し入れする（TSV / CSV）
   *     列は ジャンル / 見出しの英文 / 見出しの意味 / 言い換え(英文,意味)×4
   * ========================================================== */

  var IMPORT_HEADER = ['ジャンル', '見出しの英文', '見出しの意味'];
  (function buildHeader() {
    for (var i = 1; i <= LINE_COUNT; i++) {
      IMPORT_HEADER.push('言い換え' + i + 'の英文', '言い換え' + i + 'の意味');
    }
  })();

  function looksLikeParaHeader(cells) {
    var a = trim(cells[0]).toLowerCase();
    var b = trim(cells[1] || '').toLowerCase();
    return /^(ジャンル|genre|分類|カテゴリ)$/.test(a) ||
           /^(見出し|見出しの英文|英文|英語|english|en)$/.test(b);
  }

  function parseParaTable(text) {
    var result = { cards: [], skipped: 0, headerDropped: false, delimiter: '\t' };
    var api = drillAPI();
    if (!api || typeof api.splitTable !== 'function') return result;

    var table = api.splitTable(text);
    result.delimiter = table.delimiter;

    var rows = table.rows.slice();

    for (var i = 0; i < rows.length; i++) {
      var cells = rows[i];
      // 見出し行は先頭とは限らない。書き出したものを何回分か続けて貼ると途中にも並ぶ。
      // どこにあっても外す（残すと「見出しの英文」という名前の札ができてしまう）
      if (looksLikeParaHeader(cells)) { result.headerDropped = true; continue; }

      var headEn = trim(cells[1] || '');
      if (!headEn) { result.skipped++; continue; }   // 2 列目（見出しの英文）は必須

      var lines = [];
      for (var j = 0; j < LINE_COUNT; j++) {
        var en = trim(cells[3 + j * 2] || '');
        var ja = trim(cells[4 + j * 2] || '');
        if (!en && !ja) continue;
        lines.push({ en: en, ja: ja });
      }

      result.cards.push({
        genreName: trim(cells[0] || ''),
        headEn: headEn,
        headJa: trim(cells[2] || ''),
        lines: lines
      });
    }
    return result;
  }

  function setImportPreview(msg) {
    if (elImportPreview) elImportPreview.textContent = msg || '';
  }

  var IMPORT_HELP = '読み込める行がありません。1 列目にジャンル、2 列目に見出しの英文を置いてください。';

  function updateImportPreview() {
    var text = elImportText ? elImportText.value : '';
    if (!trim(text)) { setImportPreview(''); return; }

    var parsed = parseParaTable(text);
    if (!parsed.cards.length) { setImportPreview(IMPORT_HELP); return; }

    var head = parsed.cards[0].headEn;
    if (head.length > 40) head = head.slice(0, 40) + '…';

    var extra = [parsed.delimiter === '\t' ? 'タブ区切り' : 'カンマ区切り'];
    if (parsed.headerDropped) extra.push('見出し行は除外');
    if (parsed.skipped) extra.push(parsed.skipped + ' 行は英文が無いため除外');
    setImportPreview(parsed.cards.length + ' 枚を読み込めます（最初の1枚: ' + head + '）［' + extra.join(' / ') + '］');
  }

  var runImportPreview = debounce(updateImportPreview, FILTER_DEBOUNCE);

  /** 同じ見出しがすでにあるか（読み込みの重複よけ） */
  function hasHeadEn(headEn) {
    var key = headEn.toLowerCase();
    for (var i = 0; i < state.cards.length; i++) {
      if (state.cards[i].headEn.toLowerCase() === key) return true;
    }
    return false;
  }

  function saveImportedCards() {
    var parsed = parseParaTable(elImportText ? elImportText.value : '');
    if (!parsed.cards.length) { setImportPreview(IMPORT_HELP); return; }

    var added = 0, dup = 0;
    for (var i = 0; i < parsed.cards.length; i++) {
      var row = parsed.cards[i];
      if (hasHeadEn(row.headEn)) { dup++; continue; }
      var genre = row.genreName ? addGenre(row.genreName) : null;
      state.cards.push({
        id: uid('p'),
        genreId: genre ? genre.id : '',
        headEn: row.headEn,
        headJa: row.headJa,
        lines: row.lines
      });
      added++;
    }
    var ok = saveCards();

    if (elImportText) elImportText.value = '';
    setImportPreview('');

    renderGenreChips();
    renderGenreSelect();
    renderGenreManageList();
    renderCards();
    closeDialog(elDataDialog);

    var msg = added + ' 枚を読み込みました。';
    if (dup) msg += '（' + dup + ' 枚は同じ見出しがあったので省きました）';
    if (ok === false) msg += 'この端末には保存できませんでした。';
    flash(msg);
  }

  /** タブと改行はセルを壊すのでスペースに潰す */
  function flat(v) {
    return str(v).replace(/[\t\r\n]+/g, ' ');
  }

  function cardToRow(card) {
    var cells = [flat(genreName(cardGenreKey(card))), flat(card.headEn), flat(card.headJa)];
    for (var i = 0; i < LINE_COUNT; i++) {
      var line = card.lines[i];
      cells.push(line ? flat(line.en) : '', line ? flat(line.ja) : '');
    }
    return cells.join('\t');
  }

  function exportVisibleCards() {
    var api = drillAPI();
    var list = visibleCards();
    if (!list.length) { setImportPreview('書き出せるパラフレがありません。'); return; }

    var rows = [IMPORT_HEADER.join('\t')];
    for (var i = 0; i < list.length; i++) rows.push(cardToRow(list[i]));
    var tsv = rows.join('\n');

    if (!api || typeof api.copyText !== 'function') {
      setImportPreview('コピーできませんでした。');
      return;
    }
    api.copyText(tsv, function (okCopy) {
      setImportPreview(okCopy
        ? list.length + ' 枚を TSV でコピーしました。'
        : 'コピーできませんでした。テキストを手動で選択してコピーしてください。');
    });
  }

  /* ============================================================
   * 14. ダイアログ（<dialog> が無い環境でも壊れない）
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
    noteDelete('card:' + id);
    renderGenreChips();
    renderGenreManageList();
    renderCards();
  }

  /* ============================================================
   * 15. イベント
   * ========================================================== */

  var runGenreFilter = debounce(function () {
    state.filter = elGenreInput ? trim(elGenreInput.value) : '';
    renderGenreChips();
  }, FILTER_DEBOUNCE);

  var runSearch = debounce(function () {
    state.query = trim(elSearch ? elSearch.value : '').toLowerCase();
    renderCards();
  }, SEARCH_DEBOUNCE);

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
    if (target.closest('.para-star')) {
      toggleStar(li, id);
      return;
    }
    if (target.closest('.para-send')) {
      var recS = findCard(id);
      if (recS) sendCards([recS]);
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

  function toggleStar(li, id) {
    var btn = li.querySelector('.para-star');
    var on = !isStarred(id);
    setStar(id, on);
    if (on) li.classList.add('is-starred');
    else li.classList.remove('is-starred');
    if (btn) {
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.setAttribute('aria-label', on ? 'チェックを外す' : 'チェックを付ける');
    }
    if (state.starredOnly) renderCards();   // ★だけ表示中なら、外した札は消える
  }

  function setStarredOnly(on) {
    state.starredOnly = !!on;
    if (elStarredOnly) elStarredOnly.setAttribute('aria-pressed', state.starredOnly ? 'true' : 'false');
    saveUI();
    renderCards();
  }

  function setSort(value) {
    state.sort = SORTS.indexOf(value) >= 0 ? value : 'added';
    if (elSort) elSort.value = state.sort;
    // 並べ替えを選んだらシャッフルは解く（両方は効かない）
    if (state.shuffleOrder) setShuffle(false, true);
    saveUI();
    renderCards();
  }

  function setShuffle(on, quiet) {
    if (on) {
      var ids = [];
      for (var i = 0; i < state.cards.length; i++) ids.push(state.cards[i].id);
      for (i = ids.length - 1; i > 0; i--) {          // Fisher–Yates
        var j = Math.floor(Math.random() * (i + 1));
        var t = ids[i]; ids[i] = ids[j]; ids[j] = t;
      }
      state.shuffleOrder = ids;
    } else {
      state.shuffleOrder = null;
    }
    if (elShuffle) {
      elShuffle.setAttribute('aria-pressed', state.shuffleOrder ? 'true' : 'false');
      elShuffle.setAttribute('aria-label', state.shuffleOrder ? '元の順番に戻す' : '順番をシャッフル');
    }
    if (!quiet) renderCards();
  }

  function clearSearch(blur) {
    if (elSearch) elSearch.value = '';
    state.query = '';
    renderCards();
    if (blur && elSearch) elSearch.blur();
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

    if (elSearch) {
      elSearch.addEventListener('input', runSearch);
      elSearch.addEventListener('search', runSearch);   // type="search" の × ボタン
    }
    if (elSearchClear) {
      elSearchClear.addEventListener('click', function () {
        clearSearch(false);
        if (elSearch) elSearch.focus();
      });
    }
    if (elSort) elSort.addEventListener('change', function () { setSort(elSort.value); });
    if (elShuffle) {
      elShuffle.addEventListener('click', function () { setShuffle(!state.shuffleOrder); });
    }
    if (elStarredOnly) {
      elStarredOnly.addEventListener('click', function () { setStarredOnly(!state.starredOnly); });
    }

    // --- 表で出し入れするダイアログ ---
    if (elDataBtn) {
      elDataBtn.addEventListener('click', function () {
        updateImportPreview();
        openDialog(elDataDialog, elDataBtn);
        if (elImportText) elImportText.focus();
      });
    }
    if (elImportText) {
      elImportText.addEventListener('input', runImportPreview);
      elImportText.addEventListener('paste', function () { window.setTimeout(updateImportPreview, 0); });
    }
    if (elImportSave) elImportSave.addEventListener('click', saveImportedCards);
    if (elImportCancel) {
      elImportCancel.addEventListener('click', function () { closeDialog(elDataDialog); });
    }
    if (elExport) elExport.addEventListener('click', exportVisibleCards);
    if (elSendAll) {
      elSendAll.addEventListener('click', function () {
        var list = visibleCards();
        if (!list.length) { setImportPreview('送れるパラフレがありません。'); return; }
        sendCards(list);
        closeDialog(elDataDialog);
      });
    }
    if (elDataDialog) elDataDialog.addEventListener('close', restoreFocus);

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
   * 16. 起動
   * ========================================================== */

  function init() {
    if (!elList || !elCardTemplate || !elLineTemplate) return; // DOM が想定と違うときは何もしない

    initSpeech();

    state.genres = sanitizeGenres(readJSON(LS_GENRES));
    state.cards = sanitizeCards(readJSON(LS_CARDS));
    state.stars = sanitizeStars(readJSON(LS_STARS));

    var ui = sanitizeUI(readJSON(LS_UI));
    state.genreId = (ui.genreId === ALL || ui.genreId === NONE || findGenre(ui.genreId)) ? ui.genreId : ALL;
    state.sort = ui.sort;
    state.starredOnly = ui.starredOnly;

    if (elSort) elSort.value = state.sort;
    if (elStarredOnly) elStarredOnly.setAttribute('aria-pressed', state.starredOnly ? 'true' : 'false');
    setShuffle(false, true);   // シャッフルは持ち越さない

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

  /**
   * localStorage を読み直して作り直す（同期で中身が入れ替わったとき用）。
   * 見ていたジャンルは、まだ在ればそのまま。並べ替えやシャッフルには手を付けない。
   */
  function reloadFromStorage() {
    // 同期は裏で走る。作り直すと、めくっていた札が読んでいる最中に閉じてしまう。
    // 開いていた札と見ている位置を覚えておいて戻す。
    var wasShuffled = !!state.shuffleOrder;
    var scrollY = window.pageYOffset;

    state.genres = sanitizeGenres(readJSON(LS_GENRES));
    state.cards = sanitizeCards(readJSON(LS_CARDS));
    state.stars = sanitizeStars(readJSON(LS_STARS));

    if (state.genreId !== ALL && state.genreId !== NONE && !findGenre(state.genreId)) {
      state.genreId = ALL;   // 見ていたジャンルが消えていたら「すべて」へ戻す
    }
    if (!wasShuffled) setShuffle(false, true);

    renderGenreChips();
    renderGenreTitle();
    renderGenreSelect();
    renderGenreManageList();
    renderCards();
    syncGenreAddButton();

    window.scrollTo(0, scrollY);   // 読んでいた位置に戻す（開いた札は renderCards が保つ）
  }

  window.SUNKAN_PARA = {
    /** 同期が中身を入れ替えたあとに呼ぶ */
    reload: reloadFromStorage
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
