/* Duo — シャドーイング
 *
 * 英文を続けて読み上げ、**少し遅れて自分も声に出す**練習。
 * 聞いてから言うのではなく、聞きながら言う。だから音は止めない。
 *
 * ここで大事なのは 3 つだけ。
 *
 *   1. **止まらないこと。** 1 文ずつ「次へ」を押す作りにすると、押すたびに
 *      追いかけが切れて、シャドーイングにならない。最後まで勝手に流す
 *   2. **速さを落とせること。** 等速で追えないうちは 0.7 倍から入る
 *      （ゆっくりでも「聞きながら言う」形が保てれば練習になる）
 *   3. **文字を消せること。** 目で読める間は耳を使わない。慣れたら隠す
 *
 * 文は 1 文ずつ足せる（瞬間英作文と同じやり方）。
 * すでに作ってある瞬間英作文のセットから、まとめて持ってくることもできる。
 *
 * app.js / paraphrase.js / cards.js とは状態も保存先も共有しない。
 * 触れ合うのは <html data-mode> と window.SUNKAN_SHADOW だけ。
 */
'use strict';

(function () {

  /* ============================================================
   * 1. 小物
   * ========================================================== */

  function $(id) { return document.getElementById(id); }
  function str(v) { return (v === null || v === undefined) ? '' : String(v); }
  function trim(v) { return str(v).trim(); }

  var docEl = document.documentElement;

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
    try { return lsSet(key, JSON.stringify(value)); } catch (e) { return false; }
  }

  function speechPort() { return window.SUNKAN_SPEECH || null; }

  function makeId(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /** 消したものを同期に覚えさせる（鍵の頭は sync.js の merge と揃える） */
  function recordDelete(prefix, id) {
    var sync = window.SUNKAN_SYNC;
    if (sync && typeof sync.recordDelete === 'function') sync.recordDelete(prefix + id);
  }

  /* ============================================================
   * 2. 定数
   * ========================================================== */

  var LS_DECKS = 'sunkan:shadow:decks';
  var LS_ITEMS = 'sunkan:shadow:items';
  var LS_UI = 'sunkan:shadow:ui';

  /** 選べる速さ。0.7 は「ゆっくりだが不自然ではない」あたり */
  var RATES = [0.7, 0.85, 1];

  /** 1 文を続けて何回読むか */
  var REPEATS = [1, 2, 3];

  /** 文と文のあいだの間（ミリ秒）。息を継いで追いつくための間 */
  var GAP_MS = 700;

  /** 同じ文をくり返すときの間。続けて追いかけるので短く */
  var REPEAT_GAP_MS = 350;

  /* ============================================================
   * 3. 読み込みと均し
   * ========================================================== */

  function sanitizeDecks(raw) {
    if (!raw || Object.prototype.toString.call(raw) !== '[object Array]') return [];
    var out = [], seen = {};
    for (var i = 0; i < raw.length; i++) {
      var d = raw[i];
      if (!d || typeof d !== 'object') continue;
      var id = trim(d.id), name = trim(d.name);
      if (!id || !name || seen[id]) continue;
      seen[id] = 1;
      out.push({ id: id, name: name, created: Number(d.created) || 0 });
    }
    return out;
  }

  function sanitizeItems(raw) {
    if (!raw || Object.prototype.toString.call(raw) !== '[object Array]') return [];
    var out = [], seen = {};
    for (var i = 0; i < raw.length; i++) {
      var c = raw[i];
      if (!c || typeof c !== 'object') continue;
      var id = trim(c.id);
      // 英文が無いものは読み上げようがないので落とす
      if (!id || seen[id] || !trim(c.en)) continue;
      seen[id] = 1;
      out.push({
        id: id,
        deckId: trim(c.deckId),
        en: trim(c.en),
        ja: trim(c.ja),
        created: Number(c.created) || 0
      });
    }
    return out;
  }

  function sanitizeUI(raw) {
    var o = (raw && typeof raw === 'object') ? raw : {};
    var rate = Number(o.rate);
    var repeat = Number(o.repeat);
    return {
      deckId: trim(o.deckId),
      rate: (RATES.indexOf(rate) >= 0) ? rate : 0.85,
      repeat: (REPEATS.indexOf(repeat) >= 0) ? repeat : 2,
      hideText: o.hideText === true,        // 既定は出す（最初から隠すと続かない）
      loop: o.loop === true
    };
  }

  /* ============================================================
   * 4. 状態
   * ========================================================== */

  var state = {
    decks: [],
    items: [],
    ui: sanitizeUI(null),
    deckId: '',

    playing: false,
    single: false,  // いまの 1 文だけ流している（次へ進まない）
    at: 0,          // いま読んでいる文の位置
    round: 0,       // その文を何回読んだか
    timer: null,
    editingId: null,
    started: false
  };

  /* ============================================================
   * 5. DOM 参照
   * ========================================================== */

  var elDeckSelect = $('shadow-deck-select');
  var elAddBtn = $('btn-shadow-add');
  var elPullBtn = $('btn-shadow-pull');
  var elListBtn = $('btn-shadow-list');
  var elSettingsBtn = $('btn-shadow-settings');
  var elStatus = $('shadow-status');

  var elStage = $('shadow-stage');
  var elEmpty = $('shadow-empty');
  var elCount = $('shadow-count');
  var elTrack = $('shadow-track');
  var elFill = $('shadow-fill');
  var elEn = $('shadow-en');
  var elJa = $('shadow-ja');
  var elPlayBtn = $('btn-shadow-play');
  var elPlayLabel = $('shadow-play-label');
  var elOneBtn = $('btn-shadow-one');
  var elAgainBtn = $('btn-shadow-again');

  var elRateRow = $('shadow-rates');
  var elRepeatRow = $('shadow-repeats');
  var elHideText = $('opt-shadow-hide');
  var elLoop = $('opt-shadow-loop');

  var elDialog = $('shadow-dialog');
  var elDialogTitle = $('shadow-dialog-title');
  var elDialogStatus = $('shadow-dialog-status');
  var elFieldEn = $('shadow-en-input');
  var elFieldJa = $('shadow-ja-input');
  var elSaveBtn = $('btn-shadow-save');
  var elCancelBtn = $('btn-shadow-cancel');
  var elDeleteBtn = $('btn-shadow-delete');
  var elNewDeckInput = $('shadow-new-deck');
  var elNewDeckBtn = $('btn-shadow-new-deck');

  var elListDialog = $('shadow-list-dialog');
  var elListDesc = $('shadow-list-desc');
  var elList = $('shadow-list');
  var elListClose = $('btn-shadow-list-close');
  var elDeckManageList = $('shadow-deck-manage-list');

  var elPullDialog = $('shadow-pull-dialog');
  var elPullSelect = $('shadow-pull-select');
  var elPullStatus = $('shadow-pull-status');
  var elPullDo = $('btn-shadow-pull-do');
  var elPullCancel = $('btn-shadow-pull-cancel');

  /* ============================================================
   * 6. 保存
   * ========================================================== */

  function saveDecks() { return writeJSON(LS_DECKS, state.decks); }
  function saveItems() { return writeJSON(LS_ITEMS, state.items); }
  function saveUI() {
    return writeJSON(LS_UI, {
      deckId: state.deckId,
      rate: state.ui.rate,
      repeat: state.ui.repeat,
      hideText: state.ui.hideText,
      loop: state.ui.loop
    });
  }

  var flashTimer = null;
  function flashStatus(message) {
    if (!elStatus) return;
    elStatus.textContent = str(message);
    if (flashTimer) window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(function () {
      if (elStatus) elStatus.textContent = '';
      flashTimer = null;
    }, 3000);
  }

  /* ============================================================
   * 7. 並び
   * ========================================================== */

  function findDeck(id) {
    for (var i = 0; i < state.decks.length; i++) {
      if (state.decks[i].id === id) return state.decks[i];
    }
    return null;
  }

  function findItem(id) {
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].id === id) return state.items[i];
    }
    return null;
  }

  function itemsOfDeck(deckId) {
    var out = [];
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].deckId === deckId) out.push(state.items[i]);
    }
    return out;
  }

  /** いま流す並び */
  function playlist() {
    return state.deckId ? itemsOfDeck(state.deckId) : state.items.slice();
  }

  /* ============================================================
   * 8. 流す
   * ========================================================== */

  function speechOK() {
    var port = speechPort();
    return !!(port && port.supported());
  }

  function clearTimer() {
    if (state.timer) { window.clearTimeout(state.timer); state.timer = null; }
  }

  /**
   * いまの文を読み上げ、鳴り終わったら次へつなぐ。
   *
   * **1 文ごとにボタンを押させない。** 押すたびに追いかけが切れて、
   * シャドーイングにならない。最後まで勝手に流す。
   */
  function playCurrent() {
    var port = speechPort();
    var list = playlist();
    if (!state.playing || !port || !list.length) return;

    if (state.at >= list.length) {
      if (state.ui.loop) { state.at = 0; state.round = 0; }
      else { finish(); return; }
    }

    var item = list[state.at];
    renderNow(item, list.length);

    port.speak(item.en, {
      rate: state.ui.rate,
      onend: function () {
        if (!state.playing) return;        // 止めたあとに来たぶんは捨てる
        state.round++;
        if (state.round < state.ui.repeat) {
          clearTimer();                    // 同じ文をもう一度（くり返しの設定ぶん）
          state.timer = window.setTimeout(playCurrent, REPEAT_GAP_MS);
          return;
        }
        state.round = 0;
        if (state.single) { stopOne(); return; }   // 1 文だけ。次へは進まない
        state.at++;
        clearTimer();
        state.timer = window.setTimeout(playCurrent, GAP_MS);   // 次の文へ。息を継ぐ間を置く
      },
      onerror: function (info) {
        stop();
        flashStatus('読み上げ: ' + ((info && info.message) || 'うまくいきませんでした。'));
      }
    });
  }

  /** はじめる。**タップの中から同期で呼ぶこと**（iOS はそうしないと鳴らない） */
  function start(fromTop) {
    if (!speechOK()) {
      flashStatus('この端末では読み上げが使えないので、シャドーイングはできません。');
      return;
    }
    var list = playlist();
    if (!list.length) return;

    if (fromTop || state.at >= list.length) { state.at = 0; state.round = 0; }
    state.single = false;
    state.playing = true;
    renderControls();
    playCurrent();
  }

  /**
   * いま出ている 1 文だけ流す。
   *
   * 聞き取れなかった文をその場で確かめたいときに、頭から流し直させない。
   * 速さもくり返しの回数も、通しで流すときと同じ設定をそのまま使う。
   * 終わっても次へは進まないので、続けて押せば同じ文を何度でも聞ける。
   */
  function startOne() {
    if (!speechOK()) {
      flashStatus('この端末では読み上げが使えないので、読み上げられません。');
      return;
    }
    var list = playlist();
    if (!list.length) return;

    // 流している最中だけ止める。鳴っていないのに cancel() を挟むと、
    // 次の speak() が「空くのを待つ」道に入り、iOS ではタップから離れて無音になる
    if (state.playing) stop(); else clearTimer();

    if (state.at >= list.length) state.at = 0;
    state.round = 0;
    state.single = true;
    state.playing = true;
    renderControls();
    playCurrent();
  }

  /** 1 文だけのぶんが鳴り終わった。位置はそのまま（同じ文をまた押せる） */
  function stopOne() {
    stop();
    renderNow(playlist()[state.at] || null, playlist().length);
  }

  function stop() {
    state.playing = false;
    state.single = false;
    clearTimer();
    var port = speechPort();
    if (port) port.cancel();
    renderControls();
  }

  function finish() {
    state.playing = false;
    clearTimer();
    state.at = 0;
    state.round = 0;
    renderControls();
    renderNow(null, playlist().length);
    flashStatus('ひととおり終わりました。');
  }

  function toggle() {
    if (state.playing) stop(); else start(false);
  }

  /* ============================================================
   * 9. 描画
   * ========================================================== */

  function renderDeckSelect() {
    if (!elDeckSelect) return;
    var keep = state.deckId;
    while (elDeckSelect.firstChild) elDeckSelect.removeChild(elDeckSelect.firstChild);

    var all = document.createElement('option');
    all.value = '';
    all.textContent = 'すべて（' + state.items.length + '）';
    elDeckSelect.appendChild(all);

    for (var i = 0; i < state.decks.length; i++) {
      var d = state.decks[i];
      var opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.name + '（' + itemsOfDeck(d.id).length + '）';
      elDeckSelect.appendChild(opt);
    }
    elDeckSelect.value = findDeck(keep) ? keep : '';
    state.deckId = elDeckSelect.value;
  }

  /** いま読んでいる文を出す。item が null なら待ちの見た目に戻す */
  function renderNow(item, total) {
    if (elCount) {
      elCount.textContent = item ? ((state.at + 1) + ' / ' + total + ' 文') : (total + ' 文');
    }
    if (elFill) {
      var pct = (item && total) ? Math.round((state.at + 1) / total * 100) : 0;
      elFill.style.width = pct + '%';
    }
    if (elTrack) {
      elTrack.setAttribute('aria-valuemax', String(total || 0));
      elTrack.setAttribute('aria-valuenow', String(item ? state.at + 1 : 0));
    }

    var list = playlist();
    var show = item || list[0] || null;
    if (elEn) elEn.textContent = show ? show.en : '';
    if (elJa) {
      var ja = show ? trim(show.ja) : '';
      elJa.textContent = ja;
      elJa.hidden = !ja;
    }
  }

  function renderControls() {
    var empty = !playlist().length;
    if (elPlayLabel) elPlayLabel.textContent = state.playing ? '■ とめる' : '▶ はじめる';
    if (elAgainBtn) elAgainBtn.disabled = empty;
    if (elOneBtn) elOneBtn.disabled = empty;

    // 流している間は文字を隠せる。目で読める間は耳を使わないので、慣れたら隠す。
    // **1 文だけのときは隠さない** — 聞き取れなかった文を確かめるための再生なので、
    // そこで字が消えると用を成さない。
    var mask = state.ui.hideText && state.playing && !state.single;
    if (elEn) elEn.classList.toggle('is-masked', mask);
    if (elJa) elJa.classList.toggle('is-masked', mask);
  }

  function renderChoices() {
    function fill(row, values, current, suffix) {
      if (!row) return;
      while (row.firstChild) row.removeChild(row.firstChild);
      for (var i = 0; i < values.length; i++) {
        (function (v) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'chip' + (v === current ? ' is-on' : '');
          b.textContent = v + suffix;
          b.setAttribute('aria-pressed', v === current ? 'true' : 'false');
          b.addEventListener('click', function () {
            if (row === elRateRow) state.ui.rate = v; else state.ui.repeat = v;
            saveUI();
            renderChoices();
            // 流している最中に変えたら、いまの文から新しい速さでやり直す
            if (state.playing) { clearTimer(); state.round = 0; playCurrent(); }
          });
          row.appendChild(b);
        })(values[i]);
      }
    }
    fill(elRateRow, RATES, state.ui.rate, ' 倍');
    fill(elRepeatRow, REPEATS, state.ui.repeat, ' 回');

    if (elHideText) elHideText.checked = state.ui.hideText;
    if (elLoop) elLoop.checked = state.ui.loop;
  }

  function render() {
    renderDeckSelect();
    var list = playlist();

    // 読み上げが無い端末では、そもそも成り立たない。黙って空にせず理由を言う
    if (!speechOK()) {
      if (elStage) elStage.hidden = true;
      if (elEmpty) {
        elEmpty.hidden = false;
        elEmpty.textContent = 'この端末（このブラウザ）は読み上げに対応していないので、'
          + 'シャドーイングはできません。文を足しておくことはできます。';
      }
      return;
    }

    if (elStage) elStage.hidden = !list.length;
    if (elEmpty) {
      elEmpty.hidden = !!list.length;
      if (!list.length) {
        elEmpty.textContent = state.items.length
          ? 'このセットには文がありません。'
          : 'まだ文がありません。「＋追加」で 1 文ずつ入れるか、「瞬間英作文から」でまとめて持ってこられます。';
      }
    }

    renderNow(null, list.length);
    renderControls();
    renderChoices();
  }

  /* ============================================================
   * 10. 足す・直す・消す
   * ========================================================== */

  function openDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', 'open');
    }
  }

  function closeDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.close === 'function') {
      if (dialog.open) dialog.close();
    } else {
      dialog.removeAttribute('open');
    }
  }

  function openItemDialog(itemId) {
    stop();                        // 入力中に鳴り続けると邪魔
    state.editingId = itemId || null;
    var item = itemId ? findItem(itemId) : null;

    if (elDialogTitle) elDialogTitle.textContent = item ? '文を編集' : '文を追加';
    if (elSaveBtn) elSaveBtn.textContent = item ? '保存する' : '追加する';
    if (elDeleteBtn) elDeleteBtn.hidden = !item;
    if (elDialogStatus) elDialogStatus.textContent = '';
    if (elFieldEn) elFieldEn.value = item ? item.en : '';
    if (elFieldJa) elFieldJa.value = item ? item.ja : '';

    openDialog(elDialog);
    if (elFieldEn) elFieldEn.focus();
  }

  /** 足す先。選んでいなければ作る */
  function targetDeckId() {
    if (state.deckId && findDeck(state.deckId)) return state.deckId;
    if (state.decks.length) return state.decks[0].id;
    var deck = { id: makeId('sdeck'), name: 'シャドーイング', created: Date.now() };
    state.decks.push(deck);
    saveDecks();
    state.deckId = deck.id;
    saveUI();
    return deck.id;
  }

  function submitItem() {
    var en = trim(elFieldEn && elFieldEn.value);
    var ja = trim(elFieldJa && elFieldJa.value);

    if (!en) {
      if (elDialogStatus) elDialogStatus.textContent = '英文を入れてください。';
      if (elFieldEn) elFieldEn.focus();
      return;
    }

    if (state.editingId) {
      var item = findItem(state.editingId);
      if (item) { item.en = en; item.ja = ja; saveItems(); }
      closeDialog(elDialog);
      state.editingId = null;
      render();
      flashStatus('直しました。');
      return;
    }

    state.items.push({
      id: makeId('sline'),
      deckId: targetDeckId(),
      en: en, ja: ja,
      created: Date.now()
    });
    saveItems();

    // 欄を空にして、そのまま次の 1 文を入れられるようにする
    if (elFieldEn) elFieldEn.value = '';
    if (elFieldJa) elFieldJa.value = '';
    if (elFieldEn) elFieldEn.focus();
    if (elDialogStatus) elDialogStatus.textContent = '足しました。続けて入れられます。';
    render();
  }

  function deleteItem(itemId) {
    var item = findItem(itemId);
    if (!item) return;
    var label = item.en.length > 24 ? item.en.slice(0, 24) + '…' : item.en;
    if (!window.confirm('「' + label + '」を消します。よろしいですか。')) return;

    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].id === itemId) { state.items.splice(i, 1); break; }
    }
    recordDelete('shadowline:', itemId);
    saveItems();
    closeDialog(elDialog);
    state.editingId = null;
    render();
    renderList();
    flashStatus('消しました。');
  }

  function createDeck() {
    var name = trim(elNewDeckInput && elNewDeckInput.value);
    if (!name) {
      if (elDialogStatus) elDialogStatus.textContent = 'セットの名前を入れてください。';
      return;
    }
    var deck = { id: makeId('sdeck'), name: name, created: Date.now() };
    state.decks.push(deck);
    state.deckId = deck.id;
    saveDecks(); saveUI();
    if (elNewDeckInput) elNewDeckInput.value = '';
    renderDeckSelect();
    if (elDialogStatus) elDialogStatus.textContent = '「' + name + '」を作りました。ここに足していけます。';
  }

  function deleteDeck(deckId) {
    var deck = findDeck(deckId);
    if (!deck) return;
    var n = itemsOfDeck(deckId).length;
    if (!window.confirm('「' + deck.name + '」を、中の ' + n + ' 文ごと消します。よろしいですか。')) return;

    for (var d = state.decks.length - 1; d >= 0; d--) {
      if (state.decks[d].id === deckId) state.decks.splice(d, 1);
    }
    recordDelete('shadowdeck:', deckId);
    for (var k = state.items.length - 1; k >= 0; k--) {
      if (state.items[k].deckId !== deckId) continue;
      recordDelete('shadowline:', state.items[k].id);
      state.items.splice(k, 1);
    }
    if (state.deckId === deckId) state.deckId = '';

    saveDecks(); saveItems(); saveUI();
    render();
    renderList();
    flashStatus('「' + deck.name + '」を消しました。');
  }

  /* ============================================================
   * 11. 一覧
   * ========================================================== */

  function renderList() {
    if (!elList) return;
    while (elList.firstChild) elList.removeChild(elList.firstChild);

    var list = playlist();
    if (elListDesc) {
      elListDesc.textContent = list.length
        ? list.length + ' 文。行を押すと直せます。'
        : 'この並びには文がありません。';
    }

    for (var i = 0; i < list.length; i++) {
      (function (item, at) {
        var li = document.createElement('li');
        li.className = 'card-list-item';

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'card-list-main';

        var num = document.createElement('span');
        num.className = 'shadow-list-num';
        num.textContent = String(at + 1);
        btn.appendChild(num);

        var en = document.createElement('span');
        en.className = 'card-list-en';
        en.textContent = item.en;
        btn.appendChild(en);

        var ja = document.createElement('small');
        ja.className = 'card-list-ja';
        ja.textContent = item.ja;
        btn.appendChild(ja);

        btn.addEventListener('click', function () {
          closeDialog(elListDialog);
          openItemDialog(item.id);
        });
        li.appendChild(btn);
        elList.appendChild(li);
      })(list[i], i);
    }
    renderDeckManageList();
  }

  function renderDeckManageList() {
    if (!elDeckManageList) return;
    while (elDeckManageList.firstChild) elDeckManageList.removeChild(elDeckManageList.firstChild);

    if (!state.decks.length) {
      var none = document.createElement('li');
      none.className = 'deck-manage-empty';
      none.textContent = 'まだセットがありません。';
      elDeckManageList.appendChild(none);
      return;
    }
    for (var i = 0; i < state.decks.length; i++) {
      (function (deck) {
        var li = document.createElement('li');
        li.className = 'deck-manage-item';

        var name = document.createElement('span');
        name.className = 'deck-manage-name';
        name.textContent = deck.name + '（' + itemsOfDeck(deck.id).length + ' 文）';
        li.appendChild(name);

        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn btn--icon';
        del.setAttribute('aria-label', deck.name + ' を削除する');
        del.textContent = '🗑';
        del.addEventListener('click', function () { deleteDeck(deck.id); });
        li.appendChild(del);

        elDeckManageList.appendChild(li);
      })(state.decks[i]);
    }
  }

  /* ============================================================
   * 12. 瞬間英作文から持ってくる
   *
   * PDF から作った英文が、すでに向こうに溜まっている。
   * もう一度入れ直させる理由が無いので、そのまま持ってこられるようにする。
   * ========================================================== */

  function drillPort() {
    var api = window.SUNKAN_DRILL;
    return (api && typeof api.decks === 'function') ? api : null;
  }

  function openPullDialog() {
    stop();
    var api = drillPort();
    if (!elPullSelect) return;

    while (elPullSelect.firstChild) elPullSelect.removeChild(elPullSelect.firstChild);
    var decks = api ? api.decks() : [];
    for (var i = 0; i < decks.length; i++) {
      var opt = document.createElement('option');
      opt.value = decks[i].id;
      opt.textContent = decks[i].name + '（' + decks[i].count + ' 文）';
      elPullSelect.appendChild(opt);
    }
    if (elPullStatus) {
      elPullStatus.textContent = decks.length ? '' : '瞬間英作文にセットがありません。';
    }
    if (elPullDo) elPullDo.disabled = !decks.length;
    openDialog(elPullDialog);
  }

  function doPull() {
    var api = drillPort();
    if (!api || !elPullSelect || !elPullSelect.value) return;

    var picked = api.sentencesOf(elPullSelect.value);
    if (!picked || !picked.items.length) {
      if (elPullStatus) elPullStatus.textContent = 'そのセットには文がありません。';
      return;
    }

    // 同じ名前のセットがあればそこへ、無ければ作る
    var deck = null;
    for (var i = 0; i < state.decks.length; i++) {
      if (state.decks[i].name === picked.name) { deck = state.decks[i]; break; }
    }
    if (!deck) {
      deck = { id: makeId('sdeck'), name: picked.name, created: Date.now() };
      state.decks.push(deck);
      saveDecks();
    }

    var have = {};
    var mine = itemsOfDeck(deck.id);
    for (var h = 0; h < mine.length; h++) have[mine[h].en.toLowerCase()] = 1;

    var added = 0, skipped = 0;
    for (var k = 0; k < picked.items.length; k++) {
      var en = trim(picked.items[k].en);
      if (!en) { skipped++; continue; }
      if (have[en.toLowerCase()]) { skipped++; continue; }
      have[en.toLowerCase()] = 1;
      state.items.push({
        id: makeId('sline'),
        deckId: deck.id,
        en: en,
        ja: trim(picked.items[k].ja),
        created: Date.now() + k
      });
      added++;
    }
    if (added) saveItems();

    state.deckId = deck.id;
    saveUI();
    closeDialog(elPullDialog);
    render();
    flashStatus('「' + deck.name + '」に ' + added + ' 文入れました' +
      (skipped ? '（' + skipped + ' 文は同じものなので飛ばしました）' : '') + '。');
  }

  /* ============================================================
   * 13. キー操作
   * ========================================================== */

  function isTypingTarget(el) {
    if (!el) return false;
    var tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
  }

  function onKeyDown(e) {
    if (e.defaultPrevented) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (docEl.getAttribute('data-mode') !== 'shadow') return;
    if (isTypingTarget(e.target)) return;
    if (document.querySelector('dialog[open]')) return;

    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }
    else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); stop(); start(true); }
    else if (e.key === '1') { e.preventDefault(); startOne(); }
  }

  /* ============================================================
   * 14. つなぎ込み
   * ========================================================== */

  function bindEvents() {
    if (elDeckSelect) {
      elDeckSelect.addEventListener('change', function () {
        stop();
        state.deckId = elDeckSelect.value;
        state.at = 0; state.round = 0;
        saveUI();
        render();
      });
    }

    if (elPlayBtn) elPlayBtn.addEventListener('click', toggle);
    if (elOneBtn) elOneBtn.addEventListener('click', startOne);
    if (elAgainBtn) {
      elAgainBtn.addEventListener('click', function () { stop(); start(true); });
    }

    if (elHideText) {
      elHideText.addEventListener('change', function () {
        state.ui.hideText = !!elHideText.checked;
        saveUI();
        renderControls();
      });
    }
    if (elLoop) {
      elLoop.addEventListener('change', function () {
        state.ui.loop = !!elLoop.checked;
        saveUI();
      });
    }

    if (elAddBtn) elAddBtn.addEventListener('click', function () { openItemDialog(null); });
    if (elSaveBtn) elSaveBtn.addEventListener('click', submitItem);
    if (elCancelBtn) {
      elCancelBtn.addEventListener('click', function () {
        closeDialog(elDialog);
        state.editingId = null;
        render();
      });
    }
    if (elDeleteBtn) {
      elDeleteBtn.addEventListener('click', function () {
        if (state.editingId) deleteItem(state.editingId);
      });
    }
    bindEnter(elFieldEn);
    bindEnter(elFieldJa);

    if (elNewDeckBtn) elNewDeckBtn.addEventListener('click', createDeck);
    if (elNewDeckInput) {
      elNewDeckInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); createDeck(); }
      });
    }

    if (elListBtn) {
      elListBtn.addEventListener('click', function () {
        stop();
        renderList();
        openDialog(elListDialog);
      });
    }
    if (elListClose) {
      elListClose.addEventListener('click', function () {
        closeDialog(elListDialog);
        render();
      });
    }

    if (elPullBtn) elPullBtn.addEventListener('click', openPullDialog);
    if (elPullDo) elPullDo.addEventListener('click', doPull);
    if (elPullCancel) {
      elPullCancel.addEventListener('click', function () { closeDialog(elPullDialog); });
    }

    if (elSettingsBtn) {
      elSettingsBtn.addEventListener('click', function () {
        stop();
        var menu = $('btn-menu');
        if (menu) menu.click();     // 音声の設定はメニューに置いてある
      });
    }

    document.addEventListener('keydown', onKeyDown);

    // 画面を離れたら黙らせる（裏で鳴り続けない）
    window.addEventListener('pagehide', stop);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop();
    });
  }

  function bindEnter(input) {
    if (!input) return;
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submitItem(); }
    });
  }

  /* ============================================================
   * 15. 起動
   * ========================================================== */

  function loadAll() {
    state.decks = sanitizeDecks(readJSON(LS_DECKS));
    state.items = sanitizeItems(readJSON(LS_ITEMS));
    var ui = sanitizeUI(readJSON(LS_UI));
    state.ui = ui;
    state.deckId = findDeck(ui.deckId) ? ui.deckId : '';
  }

  function init() {
    loadAll();
    bindEvents();
    if (docEl.getAttribute('data-mode') === 'shadow') onShow();
    else renderDeckSelect();
  }

  /** シャドーイングの画面を開いたとき（paraphrase.js の setMode から） */
  function onShow() {
    state.started = true;
    render();
  }

  /** ほかの画面へ移ったとき。鳴らしっぱなしにしない */
  function onHide() { stop(); }

  function reloadFromStorage() {
    stop();
    loadAll();
    render();
  }

  window.SUNKAN_SHADOW = {
    onShow: onShow,
    onHide: onHide,
    /** 同期が中身を入れ替えたあとに呼ぶ */
    reload: reloadFromStorage
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
