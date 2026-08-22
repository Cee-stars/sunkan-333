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
  var LS_INBOX = 'sunkan:inbox';   // 受信箱も揃える（別の入れ物で受けた分が届くように）

  var LS_TOKEN = 'sunkan:sync:token';
  var LS_GIST = 'sunkan:sync:gistId';
  var LS_AUTO = 'sunkan:sync:auto';
  var LS_LAST = 'sunkan:sync:last';
  var LS_TOMBS = 'sunkan:sync:tombs';
  var LS_FP = 'sunkan:sync:fp';   // 送れたときの指紋。読み込み直しても「まだ送っていない」が分かる

  var GIST_FILE = 'sunkan-data.json';   // My Dictionary と同じ Gist に同居できるよう名前を分ける
  var MYDICT_FILE = 'mydict-data.json'; // 置き場を探すとき、My Dictionary のぶんに相乗りする
  var API = 'https://api.github.com/gists';

  var TOMB_MAX_AGE = 90 * 24 * 60 * 60 * 1000;  // 消した記録は 90 日で捨てる
  var WATCH_MS = 3000;    // 変更を見に行く間隔
  var DEBOUNCE_MS = 1200; // 変更が止まってから送るまで
  var PULL_MS = 45000;    // 開いたままでも、向こうの変更を取りに行く間隔
  var RETRY_MS = [15000, 60000, 300000];  // 失敗したときに待つ時間（だんだん延ばす）

  var TOKEN_RE = /^(gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{20,})$/;
  var GIST_ID_RE = /^[0-9a-f]{20,}$/i;

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
    var out = [], index = {}, i, rec, cur;
    for (i = 0; i < list.length; i++) {
      rec = list[i];
      if (!rec || !rec.k) continue;
      if (Math.max(rec.t || 0, rec.a || 0) < cutoff) continue;
      cur = index[rec.k];
      if (cur) {
        // 同じ鍵は 1 件にまとめ、新しいほうの時刻を採る。
        // 手元と向こうの記録をつなげて渡してくるので、まとめないと同期のたびに倍に増える。
        if ((rec.t || 0) > cur.t) cur.t = rec.t || 0;
        if ((rec.a || 0) > cur.a) cur.a = rec.a || 0;
        continue;
      }
      cur = { k: rec.k, t: rec.t || 0, a: rec.a || 0 };
      index[rec.k] = cur;
      out.push(cur);
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

  // 鍵の作り方。app.js / paraphrase.js / inbox.js もこれと同じ形で渡す
  function addedKey(deckId, ja, en) { return 'added:' + deckId + '\n' + ja + '\n' + en; }

  /** 受信箱の 1 件を見分ける鍵。id が無ければ中身から作る（inbox.js と同じ形） */
  function inboxKey(card) {
    if (!isObject(card)) return '';
    var id = trim(card.id);
    if (id) return 'inbox:id\n' + id;
    return 'inbox:c\n' + trim(card.source) + '\n' + trim(card.en) + '\n' + trim(card.ja);
  }

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
      inbox: isArray(readJSON(LS_INBOX, [])) ? readJSON(LS_INBOX, []) : [],
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
      inbox: isArray(d.inbox) ? d.inbox : [],
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
    put(LS_INBOX, merged.inbox, []);
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

  /** 取り込み待ちのカード。取り込み済み（消した記録あり）のものは戻さない */
  function mergeInbox(mine, theirs, tombs) {
    var out = [], seen = {}, both = mine.concat(theirs), i, key;
    for (i = 0; i < both.length; i++) {
      key = inboxKey(both[i]);
      if (!key || seen[key]) continue;
      if (isDeleted(tombs, key)) continue;
      seen[key] = true;
      out.push(both[i]);
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
      inbox: mergeInbox(mine.inbox, theirs.inbox, map),
      tombs: tombs
    };
  }

  /* ============================================================
   * 5.5 トークンなしで渡す（リンク / ファイル）
   *
   * サーバーを持たない以上、アカウントなしで裏から勝手に揃える方法は無い。
   * 代わりに「片方で作ったものを、もう片方で開く」形にする。
   * 中身は同じ突き合わせに通すので、どちらのぶんも消えない。
   * ========================================================== */

  var HANDOFF_URL_MAX = 30000;   // これ以上長いリンクは開けない端末がある

  function toBase64Url(bytes) {
    var bin = '', i;
    for (i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return window.btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(text) {
    var b64 = String(text).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var bin = window.atob(b64), bytes = new Uint8Array(bin.length), i;
    for (i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  /** ブラウザに入っている圧縮を使う。無ければそのまま（リンクが長くなるだけ） */
  function deflate(bytes) {
    if (!window.CompressionStream) return Promise.resolve(null);
    try {
      var stream = new window.Blob([bytes]).stream()
        .pipeThrough(new window.CompressionStream('deflate-raw'));
      return new window.Response(stream).arrayBuffer()
        .then(function (buf) { return new Uint8Array(buf); }, function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  function inflate(bytes) {
    if (!window.DecompressionStream) return Promise.reject(new Error('この端末では開けません'));
    var stream = new window.Blob([bytes]).stream()
      .pipeThrough(new window.DecompressionStream('deflate-raw'));
    return new window.Response(stream).arrayBuffer().then(function (buf) {
      return new Uint8Array(buf);
    });
  }

  /** いまの中身を、リンクに載せられる文字列にする。z. は圧縮あり、p. は生 */
  function packPayload() {
    var bytes = new TextEncoder().encode(JSON.stringify(snapshot()));
    return deflate(bytes).then(function (small) {
      return (small && small.length < bytes.length)
        ? 'z.' + toBase64Url(small)
        : 'p.' + toBase64Url(bytes);
    });
  }

  function unpackPayload(text) {
    var body = String(text);
    var packed = body.indexOf('z.') === 0;
    if (packed || body.indexOf('p.') === 0) body = body.slice(2);
    var bytes;
    try { bytes = fromBase64Url(body); }
    catch (e) { return Promise.reject(new Error('中身を読めませんでした')); }

    return (packed ? inflate(bytes) : Promise.resolve(bytes)).then(function (raw) {
      var parsed;
      try { parsed = JSON.parse(new TextDecoder().decode(raw)); }
      catch (e) { throw new Error('中身を読めませんでした'); }
      if (!isObject(parsed) || parsed.app !== 'sunkan') throw new Error('瞬間英作文のデータではないようです');
      return clean(parsed);
    });
  }

  /** 受け取ったものを手元と突き合わせて入れる。足したぶんの数を返す */
  function takeIn(theirs) {
    var before = snapshot();
    var merged = merge(before, theirs);
    var changed = apply(merged);
    if (changed) refreshViews();
    return changed;
  }

  function handoffLink() {
    return packPayload().then(function (payload) {
      var base = window.location.href.split('#')[0];
      return base + '#data=' + payload;
    });
  }

  /** URL に載って届いたぶんを取り込む */
  function drainHandoffHash() {
    var hash = String(window.location.hash || '');

    var pair = hash.match(/[#&]pair=([^&]+)/);
    if (pair) {
      clearHash();
      takePair(pair[1]);
      if (elDialog && !elDialog.open) elDialog.showModal();
      return;
    }

    var m = hash.match(/[#&]data=([^&]+)/);
    if (!m) return;
    var payload = m[1];
    clearHash();   // 読み込み直しで二重に入らないよう先に消す
    unpackPayload(payload).then(function (theirs) {
      var changed = takeIn(theirs);
      setStatus(changed ? 'もう片方の端末のぶんを取り込みました。' : '取り込みました（新しいものはありませんでした）。', false);
      if (elDialog && !elDialog.open) elDialog.showModal();
    }, function (err) {
      setStatus('取り込めませんでした: ' + (err && err.message ? err.message : '中身を読めませんでした'), true);
      if (elDialog && !elDialog.open) elDialog.showModal();
    });
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

  function downloadFile(name, text) {
    var url = window.URL.createObjectURL(new window.Blob([text], { type: 'application/json' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    window.setTimeout(function () {
      window.URL.revokeObjectURL(url);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 1000);
  }

  function stamp() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
  }

  /**
   * 貼り付けられた文字列から受け取る。
   *
   * ホーム画面から開いたアプリにはアドレス欄が無く、リンクを開かせられない。
   * その端末にデータを届ける道がこれしか無いので、受け口を広くとってある：
   * 渡すリンク（#data=）、My Dictionary からのリンク（#inbox=）、
   * 生のひとかたまり、書き出しファイルの中身、のどれでも受け取る。
   */
  function takeFromText(text) {
    var raw = trim(text);
    if (!raw) {
      setStatus('リンクを貼り付けてください。', true);
      return;
    }

    // トークンをそのまま貼られたら、それだけでつなぐ（置き場は自分で見つける）
    if (TOKEN_RE.test(raw)) { connect(raw); return; }

    // 置き場だけ入れ替えたいとき（1 台目の Gist ID を貼った場合）
    if (GIST_ID_RE.test(raw) && token()) {
      lsSet(LS_GIST, raw);
      if (elGist) elGist.value = raw;
      renderState();
      setStatus('置き場をつなぎました。いま揃えています…', false);
      sync(false);
      return;
    }

    var m = raw.match(/[#&]pair=([^&\s]+)/);
    if (m) { takePair(m[1]); return; }

    m = raw.match(/[#&]data=([^&\s]+)/);
    if (m) { takeDataPayload(m[1]); return; }

    m = raw.match(/[#&]inbox=([^&\s]+)/);
    if (m) { takeInboxPayload(m[1]); return; }

    if (/^[zp]\./.test(raw)) { takeDataPayload(raw); return; }

    if (raw.charAt(0) === '{' || raw.charAt(0) === '[') {
      var parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
      if (isArray(parsed)) { takeInboxList(parsed); return; }
      if (isObject(parsed) && parsed.app === 'sunkan') {
        report(takeIn(clean(parsed)));
        return;
      }
    }

    setStatus('読めませんでした。GitHub のトークン（ghp_… で始まる文字列）か、もう片方の端末で作ったリンクを、そのまま貼り付けてください。', true);
  }

  /**
   * この端末の同期設定（トークンと置き場）を、そのままリンクに載せる。
   * ホーム画面のアプリにはアドレス欄が無く、貼り付けしか道が無い。
   * これを 1 回貼ってもらえば、あとはその端末も自動で揃う。
   *
   * リンクにはトークンが入っているので、人に渡すものではない。
   */
  function pairLink() {
    var conf = { t: token(), g: gistId() };
    var payload = toBase64Url(new TextEncoder().encode(JSON.stringify(conf)));
    return window.location.href.split('#')[0] + '#pair=' + payload;
  }

  function takePair(payload) {
    var conf = null;
    try { conf = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))); }
    catch (e) { conf = null; }
    if (!isObject(conf) || !trim(conf.t) || !trim(conf.g)) {
      setStatus('つなぐリンクとして読めませんでした。', true);
      return;
    }
    lsSet(LS_TOKEN, trim(conf.t));
    lsSet(LS_GIST, trim(conf.g));
    lsSet(LS_AUTO, '1');
    if (elToken) elToken.value = trim(conf.t);
    if (elGist) elGist.value = trim(conf.g);
    renderState();
    setStatus('つながりました。いま揃えています…', false);
    sync(false);
  }

  function report(changed) {
    setStatus(changed
      ? 'もう片方の端末のぶんを取り込みました。'
      : '取り込みました（新しいものはありませんでした）。', false);
  }

  function takeDataPayload(payload) {
    setStatus('取り込んでいます…', false);
    unpackPayload(payload).then(function (theirs) {
      report(takeIn(theirs));
    }, function (err) {
      setStatus('取り込めませんでした: ' + (err && err.message ? err.message : '中身を読めませんでした'), true);
    });
  }

  /** My Dictionary から渡されたカード。受信箱に入れて、帯から取り込んでもらう */
  function takeInboxPayload(payload) {
    var list;
    try { list = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))); }
    catch (e) {
      setStatus('取り込めませんでした（中身を読めませんでした）。', true);
      return;
    }
    takeInboxList(list);
  }

  function takeInboxList(list) {
    var api = window.SUNKAN_INBOX;
    if (!api || typeof api.add !== 'function') {
      setStatus('受信箱が読み込めていないので受け取れませんでした。', true);
      return;
    }
    var n = api.add(list);
    setStatus(n
      ? n + ' 件届きました。上の「取り込む」を押すとセットに入ります。'
      : '受け取れるカードがありませんでした（英文と日本語の両方が要ります）。', !n);
    if (n) closeSync();
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
      if (!res.ok) {
        var err = new Error(errorText(res.status));
        err.status = res.status;   // 404（置き場が消えた）だけは自分で作り直したい
        throw err;
      }
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

  /**
   * トークンだけで置き場を見つける。
   *
   * 2 台目に Gist ID を打たせないための肝。同じトークンなら同じ置き場に行き着く。
   * My Dictionary のぶん（mydict-data.json）しか無いときはそこに相乗りする
   * （PATCH は指定したファイルしか触らないので、互いを壊さない）。
   */
  function gistFind(token) {
    return ghFetch(API + '?per_page=100', 'GET', token).then(function (list) {
      if (!isArray(list)) return '';
      var mine = '', shared = '', i, files;
      for (i = 0; i < list.length; i++) {
        files = list[i] && list[i].files;
        if (!files) continue;
        if (!mine && files[GIST_FILE]) mine = trim(list[i].id);
        if (!shared && files[MYDICT_FILE]) shared = trim(list[i].id);
      }
      return mine || shared;
    }, function () { return ''; });   // 一覧を読めなくても、作るほうへ進める
  }

  /** 置き場を用意する（あれば探し、無ければ作る）。ID を返す */
  function ensureGist(token) {
    var have = gistId();
    if (have) return Promise.resolve(have);
    return gistFind(token).then(function (id) {
      return id || gistCreate(token);
    }).then(function (id) {
      id = trim(id);
      if (!id) throw new Error('置き場を用意できませんでした');
      lsSet(LS_GIST, id);
      if (elGist) elGist.value = id;
      return id;
    });
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

  var state = { busy: false, timer: null, retry: null, fails: 0, fingerprint: '', lastPull: 0 };

  function token() { return trim(lsGet(LS_TOKEN)); }
  function gistId() { return trim(lsGet(LS_GIST)); }
  /** トークンさえあれば置き場は自分で見つけられる（Gist ID は打たせない） */
  function connected() { return !!token(); }
  /**
   * つないである＝自動で揃える。
   * 「あとで自分で押す」形は無くした。押し忘れたぶんだけ端末がずれるため。
   */
  function autoOn() { return connected(); }
  function ready() { return !!(token() && gistId()); }

  /** まだ送れていない変更があるか（読み込み直しても分かるよう指紋を残してある） */
  function dirty() { return fingerprint() !== trim(lsGet(LS_FP)); }

  /** 画面を作り直す。app.js / paraphrase.js がそれぞれ開けている口 */
  function refreshViews() {
    var drill = window.SUNKAN_DRILL, para = window.SUNKAN_PARA, inbox = window.SUNKAN_INBOX;
    if (drill && typeof drill.reload === 'function') drill.reload();
    if (para && typeof para.reload === 'function') para.reload();
    if (inbox && typeof inbox.refresh === 'function') inbox.refresh();
  }

  /** 送る中身の見分け。同じなら PATCH しない（置き場の履歴を無駄に増やさない） */
  function payloadOf(d) {
    return JSON.stringify([d.decks, d.added, d.stars,
      d.para.genres, d.para.cards, d.para.stars, d.inbox, d.tombs]);
  }

  /** 1 往復ぶん。読んで、突き合わせて、変わっていたら書き戻す */
  function round(id, tk) {
    return gistGet(id, tk).then(function (theirs) {
      var merged = merge(snapshot(), theirs);
      var changed = apply(merged);
      if (changed) refreshViews();
      if (payloadOf(theirs) === payloadOf(merged)) return changed;   // 送る必要なし
      return gistUpdate(id, tk, {
        app: 'sunkan', v: 1, at: Date.now(),
        decks: merged.decks, added: merged.added, stars: merged.stars,
        para: merged.para, inbox: merged.inbox, tombs: merged.tombs
      }).then(function () { return changed; });
    });
  }

  function sync(silent) {
    if (!connected()) {
      if (!silent) setStatus('先に「つなぐ」を済ませてください。', true);
      return Promise.resolve(false);
    }
    if (state.busy) return Promise.resolve(false);
    if (window.navigator.onLine === false) {
      if (!silent) setStatus('オフラインなので同期できません。つながったら自動でやり直します。', true);
      return Promise.resolve(false);
    }

    state.busy = true;
    if (!silent) setStatus('同期しています…', false);

    var tk = token();
    return ensureGist(tk).then(function (id) {
      return round(id, tk).then(null, function (err) {
        // 置き場ごと消えていた。作り直して 1 回だけやり直す
        if (!err || err.status !== 404) throw err;
        lsRemove(LS_GIST);
        return ensureGist(tk).then(function (again) { return round(again, tk); });
      });
    }).then(function (changed) {
      lsSet(LS_LAST, String(Date.now()));
      state.fingerprint = fingerprint();
      lsSet(LS_FP, state.fingerprint);
      state.lastPull = Date.now();
      state.fails = 0;
      if (state.retry) { window.clearTimeout(state.retry); state.retry = null; }
      if (!silent || changed) {
        setStatus(changed ? '揃えました。もう片方の端末のぶんも入りました。' : whenText(), false);
      }
      renderState();
      return true;
    }, function (err) {
      // 失敗しても手元のデータには手を付けていない
      state.fails++;
      if (!silent) setStatus('同期できませんでした: ' + (err && err.message ? err.message : '通信エラー'), true);
      scheduleRetry();
      return false;
    }).then(function (ok) {
      state.busy = false;
      return ok;
    });
  }

  /** 失敗したら、だんだん間を空けてやり直す（電波が戻れば勝手に揃うように） */
  function scheduleRetry() {
    if (!autoOn()) return;
    if (state.retry) window.clearTimeout(state.retry);
    var wait = RETRY_MS[Math.min(state.fails - 1, RETRY_MS.length - 1)];
    state.retry = window.setTimeout(function () {
      state.retry = null;
      sync(true);
    }, wait);
  }

  /* --- つなぐ（トークンを 1 つ受け取るだけ） --- */

  /**
   * トークンを受け取って、置き場まで用意して、そのまま揃える。
   * 2 台目も同じトークンを貼るだけでよい（置き場は gistFind が見つける）。
   */
  function connect(raw) {
    var tk = trim(raw);
    if (!tk) {
      setStatus('トークンを貼り付けてください。', true);
      return Promise.resolve(false);
    }
    lsSet(LS_TOKEN, tk);
    lsSet(LS_AUTO, '1');   // 古い版がこの端末を読んだときのため
    if (elToken) elToken.value = tk;
    setStatus('つないでいます…', false);
    return ensureGist(tk).then(function () {
      renderState();
      return sync(false);
    }).then(function (ok) {
      if (ok) {
        setStatus('つながりました。これからは開いている間ずっと自動で揃います。', false);
        renderState();
      }
      return ok;
    }, function (err) {
      setStatus('つなげませんでした: ' + (err && err.message ? err.message : '通信エラー'), true);
      renderState();
      return false;
    });
  }

  /* --- 変更を見張る（app.js の保存に手を入れずに済ませる） --- */

  function fingerprint() {
    return [LS_DECKS, LS_ADDED, LS_STARS, LS_PARA_GENRES, LS_PARA_CARDS, LS_PARA_STARS,
            LS_INBOX, LS_TOMBS]
      .map(function (k) { var v = lsGet(k); return v ? v.length + ':' + hash(v) : '0'; }).join('|');
  }

  function hash(s) {
    var h = 5381, i;
    for (i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function scheduleAuto() {
    if (!autoOn()) return;
    if (state.timer) window.clearTimeout(state.timer);
    state.timer = window.setTimeout(function () {
      state.timer = null;
      sync(true);
    }, DEBOUNCE_MS);
  }

  /**
   * 3 秒ごと。手元が動いていれば送り、落ち着いていれば向こうを取りに行く。
   * 開いたまま放っておいても、もう片方で足したぶんが出てくるようにするため。
   */
  function watch() {
    if (document.hidden || !autoOn() || state.busy) return;
    var now = fingerprint();
    if (now !== state.fingerprint) {
      state.fingerprint = now;
      scheduleAuto();
      return;
    }
    if (!state.timer && Date.now() - state.lastPull >= PULL_MS) sync(true);
  }

  /** 閉じる・裏に回るときに、送り残しを片付ける */
  function flush() {
    if (!autoOn() || state.busy || !dirty()) return;
    if (state.timer) { window.clearTimeout(state.timer); state.timer = null; }
    sync(true);
  }

  /* ============================================================
   * 8. 画面
   * ========================================================== */

  var elDialog = $('sync-dialog');
  var elOpen = $('btn-sync-open');
  var elStateLabel = $('sync-state');
  var elToken = $('sync-token');
  var elGist = $('sync-gist');
  var elStatus = $('sync-status');
  var elSetup = $('sync-setup');
  var elLive = $('sync-live');
  var elSettingsDialog = $('settings-dialog');

  function setStatus(msg, bad) {
    if (!elStatus) return;
    elStatus.textContent = msg;
    elStatus.classList.toggle('is-error', !!bad);
  }

  function whenText() {
    var last = parseInt(lsGet(LS_LAST), 10);
    if (!last) return connected() ? 'つながっています。' : 'まだつないでいません。';
    var d = new Date(last), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return '最後の同期 ' + d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function renderState() {
    var on = connected();
    if (elStateLabel) elStateLabel.textContent = on ? '自動' : '未設定';
    if (elSetup) elSetup.hidden = on;
    if (elLive) elLive.hidden = !on;
  }

  function openSync() {
    if (elToken) elToken.value = token();
    if (elGist) elGist.value = gistId();
    renderState();
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

  function bindHandoff() {
    var link = $('btn-handoff-link');
    var save = $('btn-handoff-save');
    var load = $('btn-handoff-load');
    var file = $('handoff-file');

    if (link) link.addEventListener('click', function () {
      setStatus('リンクを作っています…', false);
      handoffLink().then(function (url) {
        if (url.length > HANDOFF_URL_MAX) {
          setStatus('中身が多くてリンクにできませんでした。「ファイルに書き出す」を使ってください。', true);
          return;
        }
        var api = window.SUNKAN_DRILL;
        if (api && typeof api.copyText === 'function') {
          api.copyText(url, function (ok) {
            setStatus(ok
              ? 'リンクをコピーしました。メモや AirDrop で自分に送って、もう片方の端末で開いてください。'
              : 'コピーできませんでした。この欄のリンクを選んでコピーしてください: ' + url, !ok);
          });
        } else {
          setStatus('このリンクをもう片方の端末で開いてください: ' + url, false);
        }
      }, function () {
        setStatus('リンクを作れませんでした。', true);
      });
    });

    if (save) save.addEventListener('click', function () {
      try {
        downloadFile('sunkan-' + stamp() + '.json', JSON.stringify(snapshot(), null, 2));
        setStatus('書き出しました。AirDrop などでもう片方の端末へ送り、そちらで「ファイルを読み込む」を押してください。', false);
      } catch (e) {
        setStatus('書き出せませんでした。', true);
      }
    });

    if (load && file) {
      load.addEventListener('click', function () { file.click(); });
      file.addEventListener('change', function () {
        var f = file.files && file.files[0];
        file.value = '';
        if (!f) return;
        var reader = new window.FileReader();
        reader.onload = function () {
          var parsed;
          try { parsed = JSON.parse(reader.result); }
          catch (e) { setStatus('このファイルは読めませんでした。', true); return; }
          if (!isObject(parsed) || parsed.app !== 'sunkan') {
            setStatus('瞬間英作文の書き出しファイルではないようです。', true);
            return;
          }
          var changed = takeIn(clean(parsed));
          setStatus(changed ? 'もう片方の端末のぶんを取り込みました。' : '取り込みました（新しいものはありませんでした）。', false);
        };
        reader.onerror = function () { setStatus('このファイルは読めませんでした。', true); };
        reader.readAsText(f, 'utf-8');
      });
    }
  }

  function bindPaste() {
    var box = $('paste-in');
    var take = $('btn-paste-take');
    var read = $('btn-paste-read');

    if (take && box) take.addEventListener('click', function () {
      takeFromText(box.value);
      box.value = '';
    });

    if (read && box) read.addEventListener('click', function () {
      var cb = window.navigator.clipboard;
      if (!cb || typeof cb.readText !== 'function') {
        setStatus('この端末では自動で貼れません。上の欄に手で貼り付けてください。', true);
        box.focus();
        return;
      }
      cb.readText().then(function (text) {
        box.value = text;
        takeFromText(text);
        box.value = '';
      }, function () {
        setStatus('クリップボードを読めませんでした。上の欄に手で貼り付けてください。', true);
        box.focus();
      });
    });
  }

  function bindEvents() {
    bindHandoff();
    bindPaste();
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
      if (!token()) { setStatus('先にトークンを貼り付けてください。', true); return; }
      if (gistId() && !window.confirm('新しい置き場を作ります。いまの置き場にあるぶんは読みに行かなくなりますが、\nこの端末の中身はそのまま残り、新しい置き場に入ります。よろしいですか？')) return;
      setStatus('置き場を作っています…', false);
      gistCreate(token()).then(function (id) {
        if (!id) throw new Error('置き場を作れませんでした');
        lsSet(LS_GIST, id);
        lsSet(LS_AUTO, '1');
        if (elGist) elGist.value = id;
        renderState();
        return sync(false);
      }).then(null, function (err) {
        setStatus('作れませんでした: ' + (err && err.message ? err.message : '通信エラー'), true);
      });
    });

    var pair = $('btn-pair-copy');
    if (pair) pair.addEventListener('click', function () {
      saveFields();
      if (!ready()) { setStatus('先にこの端末をつないでください。', true); return; }
      var url = pairLink();
      var api = window.SUNKAN_DRILL;
      var done = function (ok) {
        setStatus(ok
          ? 'コピーしました。もう片方の端末でこのリンクを開くか、同じ画面の「貼り付ける」に貼ってください。'
          : 'コピーできませんでした: ' + url, !ok);
      };
      if (api && typeof api.copyText === 'function') api.copyText(url, done);
      else done(false);
    });

    var off = $('btn-sync-off');
    if (off) off.addEventListener('click', function () {
      if (!window.confirm('同期をやめます。この端末からトークンと Gist ID を消しますが、\n覚えた文はそのまま残ります。よろしいですか？')) return;
      lsRemove(LS_TOKEN);
      lsRemove(LS_GIST);
      lsRemove(LS_FP);
      lsSet(LS_AUTO, '0');
      if (state.retry) { window.clearTimeout(state.retry); state.retry = null; }
      if (elToken) elToken.value = '';
      if (elGist) elGist.value = '';
      renderState();
      setStatus('同期をやめました。', false);
    });

    // すでにこのアプリを開いたままリンクを叩くと、ページは読み込み直されず
    // ハッシュだけが変わる。起動時だけ見ていると、そのとき何も起きない。
    window.addEventListener('hashchange', drainHandoffHash);
    window.addEventListener('pageshow', drainHandoffHash);

    // 戻ってきたら取りに行き、裏に回るときは送り残しを片付ける
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) flush();
      else if (autoOn()) sync(true);
    });
    window.addEventListener('pagehide', flush);

    // 電波が戻ったらやり直す（オフラインのあいだの変更を置き去りにしない）
    window.addEventListener('online', function () {
      if (autoOn()) sync(true);
    });

    // 同じ端末の別のタブで直したぶんも拾う
    window.addEventListener('storage', function (e) {
      if (!e || !e.key || e.key.indexOf('sunkan:') !== 0) return;
      if (e.key.indexOf('sunkan:sync:') === 0) return;
      refreshViews();
      if (autoOn()) scheduleAuto();
    });

    window.setInterval(watch, WATCH_MS);
  }

  /* ============================================================
   * 9. 起動
   * ========================================================== */

  window.SUNKAN_SYNC = {
    /** app.js / paraphrase.js が消したときに呼ぶ（同期で戻ってこないように） */
    recordDelete: recordDelete,
    /** 受信箱の 1 件の鍵。inbox.js と作り方をそろえるためここで配る */
    inboxKey: inboxKey,
    /** 同じものを足し直したときに呼ぶ（消した記録を忘れる） */
    clearDelete: clearDelete,
    /** 足した 1 文の鍵。呼ぶ側と作り方をそろえるためここで配る */
    addedKey: addedKey
  };

  function init() {
    if (!elDialog) return;   // DOM が想定と違うときは何もしない
    bindEvents();
    renderState();
    drainHandoffHash();   // リンクで届いたぶんを取り込む
    state.fingerprint = fingerprint();
    if (autoOn()) {
      // 前回送れなかったぶんがあれば、それも含めてここで片付く
      window.setTimeout(function () { sync(true); }, 800);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
