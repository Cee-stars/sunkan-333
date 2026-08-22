/*!
 * 瞬間英作文 — 端末どうしの同期（GitHub のシークレット Gist 経由）
 *
 * iPhone と MacBook で、自作セット・足した文・★・パラフレ帳を揃える。
 * サーバーは持たない。GitHub の Gist を 1 枚の置き場として使うだけ。
 *
 * app.js / paraphrase.js の中身には触らない。localStorage を読み書きしたあと、
 * それぞれが開けている reload() を呼んで画面を追いつかせる。
 * 消したものが同期で戻ってこないよう、削除は SUNKAN_SYNC.recordDelete で覚える。
 * 取り決めは CONTRACT.md を参照。
 */
(function () {
  'use strict';

  /* ============================================================
   * 1. 定数
   * ========================================================== */

  var LS_DECKS = 'sunkan:decks';
  var LS_ADDED = 'sunkan:added';
  var LS_STARS = 'sunkan:stars';
  var LS_PARA_GENRES = 'sunkan:para:genres';
  var LS_PARA_CARDS = 'sunkan:para:cards';
  var LS_PARA_STARS = 'sunkan:para:stars';

  var LS_TOKEN = 'sunkan:sync:token';
  var LS_GIST = 'sunkan:sync:gistId';
  var LS_AUTO = 'sunkan:sync:auto';
  var LS_LAST = 'sunkan:sync:last';
  var LS_TOMBS = 'sunkan:sync:tombs';

  var GIST_FILE = 'sunkan-data.json';   // My Dictionary と同じ Gist に同居できるよう名前を分ける
  var API = 'https://api.github.com/gists';

  var TOMB_MAX_AGE = 90 * 24 * 60 * 60 * 1000;  // 消した記録は 90 日で捨てる
  var WATCH_MS = 3000;    // 変更を見に行く間隔
  var DEBOUNCE_MS = 2000; // 変更が止まってから送るまで

  /* ============================================================
   * 2. localStorage（プライベートモードでは例外が飛ぶ）
   * ========================================================== */

  function $(id) { return document.getElementById(id); }

  function lsGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function lsSet(key, value) {
    try { window.localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }
  function lsRemove(key) {
    try { window.localStorage.removeItem(key); return true; } catch (e) { return false; }
  }
  function readJSON(key, fallback) {
    var raw = lsGet(key);
    if (!raw) return fallback;
    try {
      var v = JSON.parse(raw);
      return (v === null || v === undefined) ? fallback : v;
    } catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    try { return lsSet(key, JSON.stringify(value)); } catch (e) { return false; }
  }

  function isArray(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
  function isObject(v) { return !!v && typeof v === 'object' && !isArray(v); }
  function str(v) { return (v === null || v === undefined) ? '' : String(v); }
  function trim(v) { return str(v).replace(/^\s+|\s+$/g, ''); }

  /* ============================================================
   * 3. 消したものの記録（同期で戻ってこないように）
   *
   * app.js / paraphrase.js が消したときに呼ぶ。足し直したら忘れる。
   * ========================================================== */

  function readTombs() {
    var list = readJSON(LS_TOMBS, []);
    return isArray(list) ? list : [];
  }

  /**
   * 1 件は { k: 鍵, t: 消した時刻, a: 足し直した時刻 }。
   * a を消さずに残すのが肝で、消した記録は向こうの端末にも渡っている。
   * こちらで消しただけでは向こうから戻ってくるので、
   * 「消したあとに足し直した」ことも時刻で残して勝ち負けを決める。
   */
  function writeTombs(list) {
    var cutoff = Date.now() - TOMB_MAX_AGE;
    var out = [], i, rec;
    for (i = 0; i < list.length; i++) {
      rec = list[i];
      if (!rec || !rec.k) continue;
      if (Math.max(rec.t || 0, rec.a || 0) < cutoff) continue;
      out.push(rec);
    }
    if (!out.length) { lsRemove(LS_TOMBS); return out; }
    writeJSON(LS_TOMBS, out);
    return out;
  }

  function recordDelete(key) {
    key = trim(key);
    if (!key) return;
    var list = readTombs(), i;
    for (i = 0; i < list.length; i++) {
      if (list[i].k === key) { list[i].t = Date.now(); writeTombs(list); return; }
    }
    list.push({ k: key, t: Date.now() });
    writeTombs(list);
  }

  /**
   * 足し直した印。記録そのものは消さない——消してしまうと、
   * 向こうの端末に残っている「消した記録」が同期でまた勝ってしまう。
   * 消した覚えがない鍵には何も足さない（記録がむやみに増えないように）。
   */
  function clearDelete(key) {
    key = trim(key);
    if (!key) return;
    var list = readTombs(), i;
    for (i = 0; i < list.length; i++) {
      if (list[i].k === key) { list[i].a = Date.now(); writeTombs(list); return; }
    }
  }

  /** 鍵ごとに、消した時刻と足し直した時刻の新しいほうを集める */
  function tombMap(list) {
    var map = {}, i, rec, cur;
    for (i = 0; i < list.length; i++) {
      rec = list[i];
      if (!rec || !rec.k) continue;
      cur = map[rec.k] || (map[rec.k] = { t: 0, a: 0 });
      if ((rec.t || 0) > cur.t) cur.t = rec.t || 0;
      if ((rec.a || 0) > cur.a) cur.a = rec.a || 0;
    }
    return map;
  }

  /** 消したままか（足し直しのほうが新しければ生かす） */
  function isDeleted(map, key) {
    var rec = map[key];
    return !!rec && rec.t > rec.a;
  }

  // 鍵の作り方。app.js / paraphrase.js もこれと同じ形で渡す
  function addedKey(deckId, ja, en) { return 'added:' + deckId + '\n' + ja + '\n' + en; }

  /* ============================================================
   * 4. いまの中身を取り出す / 書き戻す
   * ========================================================== */

  function snapshot() {
    return {
      app: 'sunkan',
      v: 1,
      at: Date.now(),
      decks: isArray(readJSON(LS_DECKS, [])) ? readJSON(LS_DECKS, []) : [],
      added: isObject(readJSON(LS_ADDED, {})) ? readJSON(LS_ADDED, {}) : {},
      stars: isObject(readJSON(LS_STARS, {})) ? readJSON(LS_STARS, {}) : {},
      para: {
        genres: isArray(readJSON(LS_PARA_GENRES, [])) ? readJSON(LS_PARA_GENRES, []) : [],
        cards: isArray(readJSON(LS_PARA_CARDS, [])) ? readJSON(LS_PARA_CARDS, []) : [],
        stars: isArray(readJSON(LS_PARA_STARS, [])) ? readJSON(LS_PARA_STARS, []) : []
      },
      tombs: readTombs()
    };
  }

  /** 受け取った中身を均す。向こうが壊れていても落ちないように */
  function clean(data) {
    var d = isObject(data) ? data : {};
    var para = isObject(d.para) ? d.para : {};
    return {
      decks: isArray(d.decks) ? d.decks : [],
      added: isObject(d.added) ? d.added : {},
      stars: isObject(d.stars) ? d.stars : {},
      para: {
        genres: isArray(para.genres) ? para.genres : [],
        cards: isArray(para.cards) ? para.cards : [],
        stars: isArray(para.stars) ? para.stars : []
      },
      tombs: isArray(d.tombs) ? d.tombs : []
    };
  }

  /** 書き戻す。中身が変わったかどうかを返す（変わったときだけ画面を作り直す） */
  function apply(merged) {
    var changed = false;

    function put(key, value, empty) {
      var next = JSON.stringify(value);
      if ((lsGet(key) || JSON.stringify(empty)) === next) return;
      if (next === JSON.stringify(empty)) lsRemove(key); else lsSet(key, next);
      changed = true;
    }

    put(LS_DECKS, merged.decks, []);
    put(LS_ADDED, merged.added, {});
    put(LS_STARS, merged.stars, {});
    put(LS_PARA_GENRES, merged.para.genres, []);
    put(LS_PARA_CARDS, merged.para.cards, []);
    put(LS_PARA_STARS, merged.para.stars, []);
    writeTombs(merged.tombs);
    return changed;
  }

  /* ============================================================
   * 5. 突き合わせ
   *
   * 足したものは両方から拾う（どちらの端末の追加も消さない）。
   * 消したものだけ、記録を頼りに落とす。
   * ========================================================== */

  function mergeById(mine, theirs, tombs, prefix) {
    var out = [], seen = {}, i, item, id;
    var both = mine.concat(theirs);
    for (i = 0; i < both.length; i++) {
      item = both[i];
      if (!isObject(item)) continue;
      id = trim(item.id);
      if (!id || seen[id]) continue;              // 先に出たほう（＝手元）を残す
      if (isDeleted(tombs, prefix + id)) continue; // 消したものは戻さない
      seen[id] = true;
      out.push(item);
    }
    return out;
  }

  function mergeStrings(mine, theirs, keep) {
    var out = [], seen = {}, i, v;
    var both = mine.concat(theirs);
    for (i = 0; i < both.length; i++) {
      v = trim(both[i]);
      if (!v || seen[v]) continue;
      if (keep && !keep(v)) continue;
      seen[v] = true;
      out.push(v);
    }
    return out;
  }

  /** { deckId: [{ja,en,note}] } を突き合わせる */
  function mergeAdded(mine, theirs, tombs, liveDecks) {
    var out = {}, deckId;

    function take(src) {
      for (var id in src) {
        if (!Object.prototype.hasOwnProperty.call(src, id)) continue;
        if (!isArray(src[id])) continue;
        if (isDeleted(tombs, 'deck:' + id)) continue;   // セットごと消してある
        if (liveDecks && !liveDecks[id]) continue;      // 収録セットか、生きている自作セットだけ
        var list = out[id] || (out[id] = []);
        for (var i = 0; i < src[id].length; i++) {
          var it = src[id][i];
          if (!isObject(it)) continue;
          var ja = trim(it.ja), en = trim(it.en);
          if (!ja || !en) continue;
          if (isDeleted(tombs, addedKey(id, ja, en))) continue;  // その 1 文だけ消してある
          var dup = false;
          for (var j = 0; j < list.length; j++) {
            if (list[j].ja === ja && list[j].en === en) { dup = true; break; }
          }
          if (dup) continue;
          list.push({ ja: ja, en: en, note: trim(it.note) });
        }
      }
    }

    take(mine);
    take(theirs);

    for (deckId in out) {
      if (Object.prototype.hasOwnProperty.call(out, deckId) && !out[deckId].length) delete out[deckId];
    }
    return out;
  }

  /** { deckId: [itemId] } を突き合わせる */
  function mergeStars(mine, theirs, tombs) {
    var out = {};
    function take(src) {
      for (var id in src) {
        if (!Object.prototype.hasOwnProperty.call(src, id)) continue;
        if (!isArray(src[id])) continue;
        if (isDeleted(tombs, 'deck:' + id)) continue;
        out[id] = mergeStrings(out[id] || [], src[id]);
      }
    }
    take(mine);
    take(theirs);
    for (var k in out) {
      if (Object.prototype.hasOwnProperty.call(out, k) && !out[k].length) delete out[k];
    }
    return out;
  }

  function merge(mine, theirs) {
    var tombs = writeTombs(mine.tombs.concat(theirs.tombs));
    var map = tombMap(tombs);

    var decks = mergeById(mine.decks, theirs.decks, map, 'deck:');
    var cards = mergeById(mine.para.cards, theirs.para.cards, map, 'card:');
    var genres = mergeById(mine.para.genres, theirs.para.genres, map, 'genre:');

    // 足した文と★は「生きているセット」のぶんだけ持つ。
    // 収録セット（id が自作でない）は手元にあるので、そのまま通す。
    var live = {}, i;
    for (i = 0; i < decks.length; i++) live[trim(decks[i].id)] = true;
    function liveDeck(id) { return live[id] || id.indexOf('user-') !== 0; }
    var liveMap = {};
    function collectDeckIds(src) {
      for (var id in src) {
        if (Object.prototype.hasOwnProperty.call(src, id)) liveMap[id] = liveDeck(id);
      }
    }
    collectDeckIds(mine.added); collectDeckIds(theirs.added);
    collectDeckIds(mine.stars); collectDeckIds(theirs.stars);

    var cardIds = {};
    for (i = 0; i < cards.length; i++) cardIds[trim(cards[i].id)] = true;

    return {
      decks: decks,
      added: mergeAdded(mine.added, theirs.added, map, liveMap),
      stars: mergeStars(mine.stars, theirs.stars, map),
      para: {
        genres: genres,
        cards: cards,
        stars: mergeStrings(mine.para.stars, theirs.para.stars, function (id) { return !!cardIds[id]; })
      },
      tombs: tombs
    };
  }

  /* ============================================================
   * 6. GitHub
   * ========================================================== */

  function errorText(status) {
    if (status === 401) return 'トークンが違うようです';
    if (status === 404) return 'Gist ID が見つかりません';
    if (status === 403) return 'GitHub 側で回数制限に掛かりました（少し待ってください）';
    return '通信できませんでした（' + status + '）';
  }

  function ghFetch(url, method, token, body) {
    var opts = {
      method: method,
      headers: { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github+json' }
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = body;
    }
    return window.fetch(url, opts).then(function (res) {
      if (!res.ok) throw new Error(errorText(res.status));
      return res.json();
    }, function () {
      throw new Error('つながりませんでした（オフラインかもしれません）');
    });
  }

  function gistBody(data) {
    var files = {};
    files[GIST_FILE] = { content: JSON.stringify(data, null, 2) };
    return JSON.stringify({ description: '瞬間英作文 の同期データ', public: false, files: files });
  }

  function gistCreate(token) {
    return ghFetch(API, 'POST', token, gistBody(snapshot())).then(function (json) {
      return trim(json && json.id);
    });
  }

  function gistGet(gistId, token) {
    return ghFetch(API + '/' + encodeURIComponent(gistId), 'GET', token).then(function (json) {
      var f = json && json.files && json.files[GIST_FILE];
      if (!f) return clean(null);   // まだこのアプリのぶんが無い Gist（＝作りたて）

      // 1MB を超えると content は途中で切られる。切れたまま読むと「向こうは空」と
      // 誤解して相手を消してしまうので、全文を取り直す。
      var body = (f.truncated && f.raw_url)
        ? window.fetch(f.raw_url).then(function (r) {
            if (!r.ok) throw new Error('同期データを読み込めませんでした');
            return r.text();
          }, function () { throw new Error('同期データを読み込めませんでした'); })
        : Promise.resolve(str(f.content));

      return body.then(function (text) {
        if (!trim(text)) {
          if (f.truncated) throw new Error('同期データを読み込めませんでした');
          return clean(null);
        }
        var parsed;
        try { parsed = JSON.parse(text); }
        catch (e) { throw new Error('同期データが読めません（上書きせずに止めました）'); }
        return clean(parsed);
      });
    });
  }

  function gistUpdate(gistId, token, data) {
    return ghFetch(API + '/' + encodeURIComponent(gistId), 'PATCH', token, gistBody(data));
  }

  /* ============================================================
   * 7. 同期そのもの
   * ========================================================== */

  var state = { busy: false, timer: null, fingerprint: '' };

  function token() { return trim(lsGet(LS_TOKEN)); }
  function gistId() { return trim(lsGet(LS_GIST)); }
  function autoOn() { return lsGet(LS_AUTO) === '1'; }
  function ready() { return !!(token() && gistId()); }

  /** 画面を作り直す。app.js / paraphrase.js がそれぞれ開けている口 */
  function refreshViews() {
    var drill = window.SUNKAN_DRILL, para = window.SUNKAN_PARA;
    if (drill && typeof drill.reload === 'function') drill.reload();
    if (para && typeof para.reload === 'function') para.reload();
  }

  function sync(silent) {
    if (!ready()) {
      if (!silent) setStatus('トークンと Gist ID を入れてください。', true);
      return Promise.resolve(false);
    }
    if (state.busy) return Promise.resolve(false);
    if (window.navigator.onLine === false) {
      if (!silent) setStatus('オフラインなので同期できません。', true);
      return Promise.resolve(false);
    }

    state.busy = true;
    if (!silent) setStatus('同期しています…', false);

    var id = gistId(), tk = token();
    return gistGet(id, tk).then(function (theirs) {
      var merged = merge(snapshot(), theirs);
      var changed = apply(merged);
      if (changed) refreshViews();
      return gistUpdate(id, tk, {
        app: 'sunkan', v: 1, at: Date.now(),
        decks: merged.decks, added: merged.added, stars: merged.stars,
        para: merged.para, tombs: merged.tombs
      }).then(function () { return changed; });
    }).then(function (changed) {
      lsSet(LS_LAST, String(Date.now()));
      state.fingerprint = fingerprint();
      if (!silent || changed) {
        setStatus(changed ? '同期しました。ほかの端末のぶんも取り込みました。' : '同期しました。', false);
      }
      renderState();
      return true;
    }, function (err) {
      // 失敗しても手元のデータには手を付けていない
      if (!silent) setStatus('同期できませんでした: ' + (err && err.message ? err.message : '通信エラー'), true);
      return false;
    }).then(function (ok) {
      state.busy = false;
      return ok;
    });
  }

  /* --- 変更を見張る（app.js の保存に手を入れずに済ませる） --- */

  function fingerprint() {
    return [LS_DECKS, LS_ADDED, LS_STARS, LS_PARA_GENRES, LS_PARA_CARDS, LS_PARA_STARS, LS_TOMBS]
      .map(function (k) { var v = lsGet(k); return v ? v.length + ':' + hash(v) : '0'; }).join('|');
  }

  function hash(s) {
    var h = 5381, i;
    for (i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function scheduleAuto() {
    if (!autoOn() || !ready()) return;
    if (state.timer) window.clearTimeout(state.timer);
    state.timer = window.setTimeout(function () {
      state.timer = null;
      sync(true);
    }, DEBOUNCE_MS);
  }

  function watch() {
    if (document.hidden || !autoOn() || !ready() || state.busy) return;
    var now = fingerprint();
    if (now === state.fingerprint) return;
    state.fingerprint = now;
    scheduleAuto();
  }

  /* ============================================================
   * 8. 画面
   * ========================================================== */

  var elDialog = $('sync-dialog');
  var elOpen = $('btn-sync-open');
  var elStateLabel = $('sync-state');
  var elToken = $('sync-token');
  var elGist = $('sync-gist');
  var elAuto = $('opt-sync-auto');
  var elStatus = $('sync-status');
  var elSettingsDialog = $('settings-dialog');

  function setStatus(msg, bad) {
    if (!elStatus) return;
    elStatus.textContent = msg;
    elStatus.classList.toggle('is-error', !!bad);
  }

  function whenText() {
    var last = parseInt(lsGet(LS_LAST), 10);
    if (!last) return 'まだ同期していません';
    var d = new Date(last), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return '最後の同期 ' + d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function renderState() {
    if (elStateLabel) {
      elStateLabel.textContent = !ready() ? '未設定' : (autoOn() ? '自動' : '手動');
    }
  }

  function openSync() {
    if (elToken) elToken.value = token();
    if (elGist) elGist.value = gistId();
    if (elAuto) elAuto.checked = autoOn();
    setStatus(whenText(), false);
    if (elSettingsDialog && elSettingsDialog.open) elSettingsDialog.close();
    if (elDialog && !elDialog.open) elDialog.showModal();
  }

  function closeSync() {
    if (elDialog && elDialog.open) elDialog.close();
  }

  function saveFields() {
    if (elToken) lsSet(LS_TOKEN, trim(elToken.value));
    if (elGist) lsSet(LS_GIST, trim(elGist.value));
    renderState();
  }

  function bindEvents() {
    if (elOpen) elOpen.addEventListener('click', openSync);
    if (elToken) elToken.addEventListener('change', saveFields);
    if (elGist) elGist.addEventListener('change', saveFields);

    var close = $('btn-sync-close');
    if (close) close.addEventListener('click', closeSync);

    var now = $('btn-sync-now');
    if (now) now.addEventListener('click', function () { saveFields(); sync(false); });

    var create = $('btn-sync-create');
    if (create) create.addEventListener('click', function () {
      saveFields();
      if (!token()) { setStatus('先にトークンを入れてください。', true); return; }
      if (gistId()) { setStatus('すでに Gist ID が入っています。作り直すなら空にしてください。', true); return; }
      setStatus('保存先を作っています…', false);
      gistCreate(token()).then(function (id) {
        if (!id) throw new Error('保存先を作れませんでした');
        lsSet(LS_GIST, id);
        if (elGist) elGist.value = id;
        lsSet(LS_LAST, String(Date.now()));
        renderState();
        setStatus('保存先を作りました。この Gist ID をもう 1 台に貼り付けてください。', false);
      }, function (err) {
        setStatus('作れませんでした: ' + (err && err.message ? err.message : '通信エラー'), true);
      });
    });

    if (elAuto) elAuto.addEventListener('change', function () {
      lsSet(LS_AUTO, elAuto.checked ? '1' : '0');
      renderState();
      if (elAuto.checked) sync(true);
    });

    var off = $('btn-sync-off');
    if (off) off.addEventListener('click', function () {
      if (!window.confirm('同期をやめます。この端末からトークンと Gist ID を消しますが、\n覚えた文はそのまま残ります。よろしいですか？')) return;
      lsRemove(LS_TOKEN);
      lsRemove(LS_GIST);
      lsSet(LS_AUTO, '0');
      if (elToken) elToken.value = '';
      if (elGist) elGist.value = '';
      if (elAuto) elAuto.checked = false;
      renderState();
      setStatus('同期をやめました。', false);
    });

    // 開いたとき・戻ってきたときに拾う
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && autoOn() && ready()) sync(true);
    });
    window.setInterval(watch, WATCH_MS);
  }

  /* ============================================================
   * 9. 起動
   * ========================================================== */

  window.SUNKAN_SYNC = {
    /** app.js / paraphrase.js が消したときに呼ぶ（同期で戻ってこないように） */
    recordDelete: recordDelete,
    /** 同じものを足し直したときに呼ぶ（消した記録を忘れる） */
    clearDelete: clearDelete,
    /** 足した 1 文の鍵。呼ぶ側と作り方をそろえるためここで配る */
    addedKey: addedKey
  };

  function init() {
    if (!elDialog) return;   // DOM が想定と違うときは何もしない
    bindEvents();
    renderState();
    state.fingerprint = fingerprint();
    if (autoOn() && ready()) {
      window.setTimeout(function () { sync(true); }, 1200);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
