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
  var LS_ERR = 'sunkan:sync:error';   // 最後に失敗した理由。黙って止まらないよう残す
  var LS_TOMBS = 'sunkan:sync:tombs';

  var GIST_FILE = 'sunkan-data.json';   // My Dictionary と同じ Gist に同居できるよう名前を分ける
  /* My Dictionary が送ったカードの置き場。本体とは別ファイルにして、
     互いの書き込みを踏まないようにしてある。向こうは足すだけ、
     取り込み済みを間引くのはこちらだけ。 */
  var INBOX_FILE = 'sunkan-inbox.json';
  var API = 'https://api.github.com/gists';

  var TOMB_MAX_AGE = 90 * 24 * 60 * 60 * 1000;  // 消した記録は 90 日で捨てる
  var MAX_INBOX = 500;    // 受信箱は取り込めば減る。際限なく持たない
  var MAX_TOMBS = 3000;   // 消した記録も溜め続けない（古いものから捨てる）
  var REQ_TIMEOUT_MS = 20000;  // 返事が来ないまま固まらせない
  var BUSY_MAX_MS = 60000;     // 「同期中」が居座ったら諦めて次を受け付ける
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
    if (out.length > MAX_TOMBS) {
      out.sort(function (a, b) { return Math.max(b.t || 0, b.a || 0) - Math.max(a.t || 0, a.a || 0); });
      out = out.slice(0, MAX_TOMBS);
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
    return out.length > MAX_INBOX ? out.slice(out.length - MAX_INBOX) : out;
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

    setStatus('リンクとして読めませんでした。もう片方の端末で作ったリンクを、そのまま貼り付けてください。', true);
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
    if (elAuto) elAuto.checked = true;
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

  /** GitHub が返した理由も添える。番号だけでは何を直せばよいか分からない */
  function errorText(status, body) {
    var base =
      status === 401 ? 'トークンが違うようです' :
      status === 404 ? 'Gist ID が見つかりません' :
      status === 403 ? '断られました（権限に gist が無いか、回数制限）' :
      status === 422 ? '送った中身を GitHub が受け付けませんでした' :
      '通信できませんでした（' + status + '）';

    var detail = [];
    if (isObject(body)) {
      if (trim(body.message)) detail.push(trim(body.message));
      if (isArray(body.errors)) {
        for (var i = 0; i < body.errors.length && i < 3; i++) {
          var e = body.errors[i];
          if (!isObject(e)) continue;
          // message がいちばん役に立つ。code だけ出して落とすと何も分からない
          var part = trim(e.field || e.resource) + ' ' + trim(e.code);
          if (trim(e.message)) part += '「' + trim(e.message) + '」';
          detail.push(trim(part));
        }
      }
    }
    return detail.length ? base + '：' + detail.join(' / ') : base + '（' + status + '）';
  }

  /** 返事が来ないと約束が永久に決まらず、次の同期が素通りしてしまう */
  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = window.setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('返事がありませんでした（電波が弱いかもしれません）'));
      }, ms);
      promise.then(function (v) {
        if (settled) return;
        settled = true; window.clearTimeout(timer); resolve(v);
      }, function (e) {
        if (settled) return;
        settled = true; window.clearTimeout(timer); reject(e);
      });
    });
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
    return withTimeout(window.fetch(url, opts), REQ_TIMEOUT_MS).then(function (res) {
      if (res.ok) return res.json();
      // GitHub は理由を本文で返す。捨てずに読む
      return res.json().then(function (body) { throw new Error(errorText(res.status, body)); },
                             function () { throw new Error(errorText(res.status, null)); });
    }, function (e) {
      // ここで「オフラインかも」と決めつけると本当の理由が消える。そのまま出す。
      throw new Error('GitHub に届きませんでした（' + ((e && e.message) || '理由不明') + '）');
    });
  }

  var FILE_MAX = 900 * 1024;   // Gist の 1 ファイルの上限（1MB）に少し余裕を持たせる

  function kb(n) { return Math.round(n / 1024) + 'KB'; }

  function sizeOf(v) {
    try { return JSON.stringify(v).length; } catch (e) { return 0; }
  }

  /** いちばん重いセット / いちばん重い「足した文」の置き場を名指しする */
  function heaviest(key, data) {
    var best = null, i, n, name;
    if (key === 'decks') {
      for (i = 0; i < data.decks.length; i++) {
        n = sizeOf(data.decks[i]);
        name = trim(data.decks[i] && data.decks[i].name) || '名前なし';
        if (!best || n > best.n) best = { name: name, n: n };
      }
    } else if (key === 'added' || key === 'stars') {
      for (var id in data[key]) {
        if (!Object.prototype.hasOwnProperty.call(data[key], id)) continue;
        n = sizeOf(data[key][id]);
        name = deckNameById(data, id);
        if (!best || n > best.n) best = { name: name, n: n };
      }
    } else if (key === 'para') {
      return null;
    }
    return (best && best.n > 1024) ? best : null;
  }

  function deckNameById(data, id) {
    for (var i = 0; i < data.decks.length; i++) {
      if (trim(data.decks[i].id) === id) return trim(data.decks[i].name) || id;
    }
    return id;   // 収録セットなど、こちらに実体が無いもの
  }

  /** どこが膨らんでいるのかを名指しする。合計だけ言われても手の打ちようがない */
  function breakdown(data) {
    var parts = [], k;
    for (k in data) {
      if (Object.prototype.hasOwnProperty.call(data, k)) parts.push({ k: k, n: sizeOf(data[k]) });
    }
    parts.sort(function (a, b) { return b.n - a.n; });

    var out = [], i, top;
    for (i = 0; i < parts.length && i < 4; i++) {
      if (parts[i].n < 1024) break;
      var line = parts[i].k + ' ' + kb(parts[i].n);
      if (i === 0) {
        top = heaviest(parts[i].k, data);
        if (top) line += '（うち「' + top.name + '」が ' + kb(top.n) + '）';
      }
      out.push(line);
    }
    return out.join(' / ');
  }

  function gistFiles(data) {
    var text = JSON.stringify(data, null, 2);
    if (!trim(text)) throw new Error('送る中身が空でした');
    if (text.length > FILE_MAX) {
      throw new Error('中身が大きすぎます（' + kb(text.length) + '）。Gist の上限は 1MB です。'
        + '内訳: ' + breakdown(data));
    }
    var files = {};
    files[GIST_FILE] = { content: text };
    return files;
  }

  function gistCreate(token) {
    // description と public は「作るとき」だけ使える項目
    var body = JSON.stringify({
      description: '瞬間英作文 の同期データ',
      public: false,
      files: gistFiles(snapshot())
    });
    return ghFetch(API, 'POST', token, body).then(function (json) {
      return trim(json && json.id);
    });
  }

  function gistGet(gistId, token) {
    return ghFetch(API + '/' + encodeURIComponent(gistId), 'GET', token).then(function (json) {
      var handed = readGistInbox(json);   // My Dictionary が置いていったカード
      var f = json && json.files && json.files[GIST_FILE];
      if (!f) {
        var empty = clean(null);
        empty.inbox = handed;
        return empty;   // まだこのアプリのぶんが無い Gist（＝作りたて）
      }

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
        var out = clean(parsed);
        out.inbox = out.inbox.concat(handed);   // 置いていかれたカードも受信箱へ
        out.handed = handed.length;
        return out;
      });
    });
  }

  /**
   * 更新は files だけ送る。
   * public は作成専用の項目で、更新に混ぜると GitHub が 422 で弾く（これで同期が止まっていた）。
   * description を毎回送ると、Gist を共有している My Dictionary 側の名前まで書き換えてしまう。
   */
  function gistUpdate(gistId, token, data) {
    var body;
    try { body = JSON.stringify({ files: gistFiles(data) }); }
    catch (e) { return Promise.reject(e); }
    return ghFetch(API + '/' + encodeURIComponent(gistId), 'PATCH', token, body);
  }

  /** My Dictionary が置いていったカードを読む。無ければ空 */
  function readGistInbox(json) {
    var f = json && json.files && json.files[INBOX_FILE];
    if (!f || !f.content) return [];
    var parsed;
    try { parsed = JSON.parse(f.content); } catch (e) { return []; }
    return (isObject(parsed) && isArray(parsed.cards)) ? parsed.cards : [];
  }

  /** 取り込み済みを間引いて書き戻す。中身が変わらないなら触らない */
  function writeGistInbox(gistId, token, cards, before) {
    if (cards.length === before) return Promise.resolve();
    var files = {};
    files[INBOX_FILE] = { content: JSON.stringify({ app: 'sunkan-inbox', v: 1, cards: cards }, null, 2) };
    return ghFetch(API + '/' + encodeURIComponent(gistId), 'PATCH', token, JSON.stringify({ files: files }))
      .then(function () {}, function () {});   // ここが失敗しても取り込みは済んでいる
  }

  /**
   * どこで止まっているのかを 1 つずつ確かめる。
   * 「つながりません」だけでは、電波・トークン・保存先のどれが悪いのか分からない。
   */
  function diagnose() {
    var tk = token(), id = gistId(), lines = [];

    function head() {
      return { 'Authorization': 'token ' + tk, 'Accept': 'application/vnd.github+json' };
    }
    function why(e) { return (e && e.message) ? e.message : '理由不明'; }

    setStatus('調べています…', false);

    // 貼り付けで改行や空白が混じると fetch が値を作れずに落ちる。よくある原因なので先に見る
    if (tk && /[^\x21-\x7e]/.test(tk)) {
      lines.push('⚠ トークンに使えない文字（空白や改行）が混じっています。貼り付け直してください。');
    }

    return window.fetch(API.replace('/gists', '/'), { cache: 'no-store' }).then(
      function (r) { lines.push('① GitHub に届く … ' + (r.ok ? 'はい' : 'いいえ（' + r.status + '）')); },
      function (e) { lines.push('① GitHub に届く … いいえ（' + why(e) + '）'); }
    ).then(function () {
      if (!tk) { lines.push('② トークン … 未入力'); return; }
      return window.fetch(API, { headers: head() }).then(
        function (r) {
          lines.push('② トークン … ' + (r.ok ? '通りました'
            : r.status === 401 ? '通りません（無効か期限切れ）'
            : r.status === 403 ? '通りません（権限に gist が無いか、回数制限）'
            : '通りません（' + r.status + '）'));
        },
        function (e) { lines.push('② トークン … 試せません（' + why(e) + '）'); }
      );
    }).then(function () {
      if (!tk || !id) { lines.push('③ 保存先 … 未設定'); return null; }
      return window.fetch(API + '/' + encodeURIComponent(id), { headers: head() }).then(
        function (r) {
          lines.push('③ 保存先 … ' + (r.ok ? '読めました'
            : r.status === 404 ? '見つかりません（Gist ID を確かめてください）'
            : '読めません（' + r.status + '）'));
          return r.ok ? r.json() : null;
        },
        function (e) { lines.push('③ 保存先 … 試せません（' + why(e) + '）'); return null; }
      );
    }).then(function (json) {
      // 読めても書けないことがある（書き込みだけ別の許可・別の通信になるため）。
      // 中身を変えない書き込みを 1 回だけ試す。
      if (!json) { lines.push('④ 書き込み … 試せません'); return; }
      var body = JSON.stringify({ description: str(json.description) });
      var h = head();
      h['Content-Type'] = 'application/json';
      return window.fetch(API + '/' + encodeURIComponent(id), { method: 'PATCH', headers: h, body: body }).then(
        function (r) {
          lines.push('④ 書き込み … ' + (r.ok ? 'できました'
            : r.status === 403 ? 'できません（権限に gist が無いかもしれません）'
            : 'できません（' + r.status + '）'));
        },
        function (e) { lines.push('④ 書き込み … できません（' + why(e) + '）'); }
      );
    }).then(function () {
      lines.push('この端末 … ' + (window.navigator.onLine === false ? 'オフライン' : 'オンライン')
        + ' / トークン ' + tk.length + ' 文字 / Gist ID ' + id.length + ' 文字');
      setStatus(lines.join('\n'), false);
    });
  }

  /* ============================================================
   * 7. 同期そのもの
   * ========================================================== */

  var state = { busy: false, busyAt: 0, timer: null, fingerprint: '', repairNote: '', handedNote: '' };

  /** 同期中かどうか。居座っているだけなら空けてやる */
  function isBusy() {
    if (!state.busy) return false;
    if (Date.now() - state.busyAt > BUSY_MAX_MS) { state.busy = false; return false; }
    return true;
  }

  function token() { return trim(lsGet(LS_TOKEN)); }
  function gistId() { return trim(lsGet(LS_GIST)); }
  function autoOn() { return lsGet(LS_AUTO) === '1'; }
  function ready() { return !!(token() && gistId()); }

  /** 画面を作り直す。app.js / paraphrase.js がそれぞれ開けている口 */
  function refreshViews() {
    var drill = window.SUNKAN_DRILL, para = window.SUNKAN_PARA, inbox = window.SUNKAN_INBOX;
    if (drill && typeof drill.reload === 'function') drill.reload();
    if (para && typeof para.reload === 'function') para.reload();
    if (inbox && typeof inbox.refresh === 'function') inbox.refresh();
  }

  function sync(silent) {
    if (!ready()) {
      if (!silent) setStatus('トークンと Gist ID を入れてください。', true);
      return Promise.resolve(false);
    }
    if (isBusy()) {
      // 黙って何もしないと「押しても反応しない」ように見える
      if (!silent) setStatus('いま同期しています。少し待ってからもう一度押してください。', false);
      return Promise.resolve(false);
    }
    if (window.navigator.onLine === false) {
      if (!silent) setStatus('オフラインなので同期できません。', true);
      return Promise.resolve(false);
    }

    state.busy = true;
    state.busyAt = Date.now();
    if (!silent) setStatus('同期しています…', false);

    var id = gistId(), tk = token();
    return gistGet(id, tk).then(function (theirs) {
      var handedCount = theirs.handed || 0;
      state.handedNote = handedCount
        ? 'My Dictionary から ' + handedCount + ' 件受け取りました。'
        : '';
      var merged = merge(snapshot(), theirs);
      var changed = apply(merged);
      if (changed) refreshViews();

      // 受け渡しファイルは、まだ取り込んでいないぶんだけ残す
      var keepKeys = {};
      merged.inbox.forEach(function (c) { keepKeys[inboxKey(c)] = true; });
      var restHanded = [];
      if (handedCount) {
        theirs.inbox.slice(theirs.inbox.length - handedCount).forEach(function (c) {
          if (keepKeys[inboxKey(c)]) restHanded.push(c);
        });
      }
      var pruneHanded = handedCount
        ? writeGistInbox(id, tk, restHanded, handedCount)
        : Promise.resolve();
      return pruneHanded.then(function () {
        return pushWithRepair(id, tk, merged);
      }).then(function () { return changed; });
    }).then(function (changed) {
      lsSet(LS_LAST, String(Date.now()));
      lsRemove(LS_ERR);
      state.fingerprint = fingerprint();
      var msg = changed ? '同期しました。ほかの端末のぶんも取り込みました。' : '同期しました。';
      if (state.handedNote) { msg += '\n' + state.handedNote; state.handedNote = ''; }
      if (state.repairNote) { msg += '\n' + state.repairNote; state.repairNote = ''; }
      if (!silent || changed) setStatus(msg, false);
      renderState();
      return true;
    }, function (err) {
      // 失敗しても手元のデータには手を付けていない。
      // 自動同期は黙って走るので、理由を残しておかないと止まったことに気付けない。
      var why = (err && err.message) ? err.message : '通信エラー';
      lsSet(LS_ERR, why + '\n' + Date.now());
      renderState();
      if (!silent) setStatus('同期できませんでした: ' + why, true);
      return false;
    }).then(function (ok) {
      state.busy = false;
      return ok;
    });
  }

  var REPAIR_KEEP_INBOX = 50;   // 切り詰めるときも、新しいカードはこれだけ残す

  /**
   * 送る。大きすぎて弾かれたら、失って困らない所から順に落として送り直す。
   * ここで諦めると同期そのものが行き止まりになり、直す手立てが無くなる。
   *
   * 落とす順は「消した記録 → 古いカード → カード全部」。
   * **取り込み待ちのカードは利用者がまだ見ていないもの**なので、消した記録より後に回す。
   * セットと足した文には最後まで触らない。
   */
  var REPAIR_STEPS = [
    { note: '' },
    { note: '大きすぎたので、削除の記録を整理して送りました。' },
    { note: '大きすぎたので、削除の記録と古い取り込み待ちを整理して送りました。' },
    { note: '大きすぎたので、削除の記録と取り込み待ちを整理して送りました。' }
  ];

  function pushWithRepair(id, token, merged) {
    var used = 0;

    function inboxFor(step) {
      if (step <= 1) return merged.inbox;
      if (step === 2) {
        return merged.inbox.length > REPAIR_KEEP_INBOX
          ? merged.inbox.slice(merged.inbox.length - REPAIR_KEEP_INBOX)
          : merged.inbox;
      }
      return [];
    }

    function payload(step) {
      return {
        app: 'sunkan', v: 1, at: Date.now(),
        decks: merged.decks, added: merged.added, stars: merged.stars, para: merged.para,
        inbox: inboxFor(step),
        tombs: step >= 1 ? [] : merged.tombs
      };
    }

    function tooBig(e) { return !!(e && e.message && e.message.indexOf('大きすぎます') >= 0); }

    function attempt(step) {
      return gistUpdate(id, token, payload(step)).then(function (r) {
        used = step;
        if (step >= 1) {
          // 送れた形に手元も合わせる。次の同期でまた膨らませないため
          lsRemove(LS_TOMBS);
          var keep = inboxFor(step);
          if (keep.length) writeJSON(LS_INBOX, keep); else lsRemove(LS_INBOX);
          var box = window.SUNKAN_INBOX;
          if (box && typeof box.refresh === 'function') box.refresh();
        }
        return r;
      }, function (e) {
        if (!tooBig(e) || step >= REPAIR_STEPS.length - 1) throw e;
        return attempt(step + 1);
      });
    }

    return attempt(0).then(function (r) {
      if (used) state.repairNote = REPAIR_STEPS[used].note;
      return r;
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

  function stamp(ms) {
    var d = new Date(ms), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /** 最後に失敗した理由。{ why, at } か null */
  function lastError() {
    var raw = lsGet(LS_ERR);
    if (!raw) return null;
    var cut = raw.lastIndexOf('\n');
    if (cut < 0) return { why: raw, at: 0 };
    return { why: raw.slice(0, cut), at: parseInt(raw.slice(cut + 1), 10) || 0 };
  }

  function whenText() {
    var last = parseInt(lsGet(LS_LAST), 10);
    var err = lastError();
    var snap = snapshot();
    var total = sizeOf(snap);
    var text = last ? '最後の同期 ' + stamp(last) : 'まだ同期していません';
    text += ' ・ ' + snap.decks.length + ' セット ・ 同期データ ' + kb(total);
    // 上限に近づいたら、どこが重いのかもその場で見せる
    if (total > FILE_MAX / 2) text += '\n内訳: ' + breakdown(snap);
    if (err) {
      text += '\n⚠ ' + (err.at ? stamp(err.at) + ' に' : '') + '同期できませんでした: ' + err.why;
    }
    return text;
  }

  function renderState() {
    if (!elStateLabel) return;
    if (!ready()) { elStateLabel.textContent = '未設定'; elStateLabel.classList.remove('is-error'); return; }
    var err = lastError();
    elStateLabel.textContent = err ? '⚠ エラー' : (autoOn() ? '自動' : '手動');
    elStateLabel.classList.toggle('is-error', !!err);
  }

  function openSync() {
    if (elToken) elToken.value = token();
    if (elGist) elGist.value = gistId();
    if (elAuto) elAuto.checked = autoOn();
    setStatus(whenText(), !!lastError());
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

    var check = $('btn-sync-check');
    if (check) check.addEventListener('click', function () { saveFields(); diagnose(); });

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
        // ここで自動を入れておかないと、作っただけで何も送られない
        lsSet(LS_AUTO, '1');
        if (elAuto) elAuto.checked = true;
        renderState();
        state.fingerprint = fingerprint();
        setStatus('用意ができました。あとは「つなぐリンクをコピー」して、もう片方のアプリに貼り付けてください。', false);
      }, function (err) {
        setStatus('作れませんでした: ' + (err && err.message ? err.message : '通信エラー'), true);
      });
    });

    if (elAuto) elAuto.addEventListener('change', function () {
      lsSet(LS_AUTO, elAuto.checked ? '1' : '0');
      renderState();
      if (elAuto.checked) sync(true);
    });

    var pair = $('btn-pair-copy');
    if (pair) pair.addEventListener('click', function () {
      saveFields();
      if (!ready()) { setStatus('先にこの端末の設定を済ませてください。', true); return; }
      var url = pairLink();
      var api = window.SUNKAN_DRILL;
      var done = function (ok) {
        setStatus(ok
          ? 'つなぐリンクをコピーしました。もう片方のアプリの、この画面の「貼り付けて受け取る」に貼ってください。'
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
      lsRemove(LS_ERR);
      lsSet(LS_AUTO, '0');
      if (elToken) elToken.value = '';
      if (elGist) elGist.value = '';
      if (elAuto) elAuto.checked = false;
      renderState();
      setStatus('同期をやめました。', false);
    });

    // すでにこのアプリを開いたままリンクを叩くと、ページは読み込み直されず
    // ハッシュだけが変わる。起動時だけ見ていると、そのとき何も起きない。
    window.addEventListener('hashchange', drainHandoffHash);
    window.addEventListener('pageshow', drainHandoffHash);

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
