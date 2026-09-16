/* Duo — カード（フラッシュカード）
 *
 * 1 枚のカードに 3 つの面を持たせ、育ち具合で順に開放する。
 *
 *   読 … 英語の例文を読んで、意味を言う      （受容・リーディング）いつもある
 *   聞 … 音だけ聞いて、英文を思い浮かべる    （受容・リスニング）  読ができた次の日から
 *   言 … 日本語を見て、英語を声に出す        （産出・スピーキング）聞ができた次の日から
 *
 * **その日の予定は、始めた時点で決まる。** 途中で面が開いても、出すのは次の日から。
 * 答えている最中に予定が増えると「のこり」が戻り、やめ時が分からなくなる。
 *
 * なぜ 3 つに分けて、しかも順に開放するのか:
 *   研究では「日本語→英語（産出）」がいちばん話す力を伸ばすが、時間がかかる。
 *   逆向きの「英語→日本語（受容）」は 1 分あたりの習得語数が多い。
 *   つまりどちらか片方を選ぶ話ではない。受容から入れて、育った札だけ産出に回すのが
 *   いちばん取りこぼしがない。最初から 3 面ぜんぶ出すと枚数が 3 倍になって続かないので、
 *   新しい札は「読」1 枚ぶんの負担しかかけない。
 *
 * 画面に出すものは、表は 1 行、ボタンは最大 3 つ。フラッシュカードは見やすさがすべて。
 *
 * app.js / paraphrase.js とは状態も保存先も共有しない。触れ合うのは <html data-mode> と
 * window.SUNKAN_CARDS だけ。予定の計算は srs.js（window.SUNKAN_SRS）に投げる。
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

  function mediaPort() { return window.SUNKAN_MEDIA || null; }
  function srsPort() { return window.SUNKAN_SRS || null; }
  function speechPort() { return window.SUNKAN_SPEECH || null; }

  /**
   * 消したものを同期に覚えさせる。これを忘れると、もう片方の端末から
   * 消したはずのカードが戻ってくる（向こうはまだ持っているので「足りないぶん」として送り返す）。
   * 鍵の頭は sync.js の merge と揃えること。
   */
  function recordDelete(prefix, id) {
    var sync = window.SUNKAN_SYNC;
    if (sync && typeof sync.recordDelete === 'function') sync.recordDelete(prefix + id);
  }

  /**
   * 取り込みで「同じカード」と見なすための鍵。
   * 区切りに \u0000 を使うのは、英文にも例文にも絶対に出てこない字だから
   * （空白で区切ると「a b」＋「c」と「a」＋「b c」が同じ鍵になってしまう）。
   */
  function dupKey(en, exEn) {
    return (trim(en) + '\u0000' + trim(exEn)).toLowerCase();
  }

  /** 一意な id。時刻＋乱数で十分（同じミリ秒に 2 枚作っても当たらない） */
  function makeId(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /** その時刻の日付を YYYY-MM-DD で。日付の変わり目は端末の真夜中 */
  function dayOf(ms) {
    var d = new Date(ms);
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }

  /** ローカルの「今日」 */
  function today() { return dayOf(Date.now()); }

  /** 配列をその場でシャッフルする（Fisher-Yates） */
  function shuffle(list) {
    for (var i = list.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = list[i]; list[i] = list[j]; list[j] = tmp;
    }
    return list;
  }

  /* ============================================================
   * 2. 定数
   * ========================================================== */

  var LS_DECKS = 'sunkan:cards:decks';
  var LS_ITEMS = 'sunkan:cards:items';
  var LS_SRS = 'sunkan:cards:srs';
  var LS_STARS = 'sunkan:cards:stars';
  var LS_UI = 'sunkan:cards:ui';
  var LS_DAY = 'sunkan:cards:day';

  /** 面。順番がそのまま開放の順番になる */
  var FACES = ['r', 'l', 's'];

  var FACE_INFO = {
    r: { badge: '読', desc: '英文を読んで、意味を言う' },
    l: { badge: '聞', desc: '音をきいて、英語を思い浮かべる' },
    s: { badge: '言', desc: '声に出して英語にする' }
  };

  /**
   * 次の面が開くまでに、ひとつ前の面で続けて思い出せた回数。
   *
   * 開いた面が出るのは**次の日から**（その日の予定は始めた時点で決まる）。
   * 同じ札の「読」を答えた直後に「聞」を出すと、30 秒前に見た答えを聞き返すだけで
   * 記憶を試したことにならない。日をまたいで初めて本当の聞き取りになる。
   */
  var UNLOCK_STREAK = 1;

  /** 一覧に出す上限。数千枚あっても画面が固まらないように */
  var LIST_LIMIT = 300;

  /** 覚えたての札を、あと何分以内ならこの場で出し直すか */
  var SAME_SESSION_MIN = 20;

  /** ゆっくり読み上げの速さ */
  var SLOW_RATE = 0.7;

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
      // 英語が無い札は出しようがないので落とす（意味だけの札は問題にしかならない）
      if (!id || seen[id] || !trim(c.en)) continue;
      seen[id] = 1;
      out.push({
        id: id,
        deckId: trim(c.deckId),
        en: trim(c.en),
        ja: trim(c.ja),
        exEn: trim(c.exEn),
        exJa: trim(c.exJa),
        note: trim(c.note),
        img: trim(c.img),        // 写真の id。中身は media.js（IndexedDB）にある
        created: Number(c.created) || 0
      });
    }
    return out;
  }

  /** { itemId: { r:状態, l:状態, s:状態 } } */
  function sanitizeSrs(raw) {
    var srs = srsPort();
    var out = {};
    if (!raw || typeof raw !== 'object' || !srs) return out;
    for (var id in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, id)) continue;
      var per = raw[id];
      if (!per || typeof per !== 'object') continue;
      var keep = {};
      for (var f = 0; f < FACES.length; f++) {
        var face = FACES[f];
        if (per[face]) keep[face] = srs.sanitize(per[face]);
      }
      out[id] = keep;
    }
    return out;
  }

  function sanitizeStars(raw) {
    if (!raw || Object.prototype.toString.call(raw) !== '[object Array]') return [];
    var out = [], seen = {};
    for (var i = 0; i < raw.length; i++) {
      var id = trim(raw[i]);
      if (!id || seen[id]) continue;
      seen[id] = 1;
      out.push(id);
    }
    return out;
  }

  function sanitizeUI(raw) {
    var o = (raw && typeof raw === 'object') ? raw : {};
    var faces = (o.faces && typeof o.faces === 'object') ? o.faces : {};
    var newPerDay = Number(o.newPerDay);
    var retention = Number(o.retention);
    return {
      deckId: trim(o.deckId),
      faces: {
        r: true,                                   // 「読」は外せない。全部消えると復習が成り立たない
        l: faces.l !== false,
        s: faces.s !== false
      },
      newPerDay: (isFinite(newPerDay) && newPerDay >= 0) ? Math.min(200, Math.round(newPerDay)) : 20,
      retention: (isFinite(retention) && retention >= 0.7 && retention <= 0.99) ? retention : 0.9,
      autoSpeak: o.autoSpeak !== false
    };
  }

  /**
   * 今日ぶんの数え。日が変わっていたら 0 に戻す。
   *
   * `done` … 今日カタが付いた面の数（日をまたぐ予定に送れたもの）。
   *          これを持っておくと、閉じて開き直しても「今日 4 / 10 枚」が続きから出る。
   */
  function sanitizeDay(raw) {
    var o = (raw && typeof raw === 'object') ? raw : {};
    if (trim(o.day) !== today()) {
      return { day: today(), introduced: {}, answered: 0, done: 0 };
    }
    // introduced はセットごとの数え。古い版は 1 つの数だったので、そのときは捨てる
    // （捨てても today ぶんの上限が緩むだけで、失われて困る記録ではない）
    var introduced = {};
    if (o.introduced && typeof o.introduced === 'object') {
      for (var id in o.introduced) {
        if (!Object.prototype.hasOwnProperty.call(o.introduced, id)) continue;
        var n = Math.max(0, Number(o.introduced[id]) || 0);
        if (n) introduced[trim(id)] = n;
      }
    }
    return {
      day: today(),
      introduced: introduced,
      answered: Math.max(0, Number(o.answered) || 0),
      done: Math.max(0, Number(o.done) || 0)
    };
  }

  /* ============================================================
   * 4. 状態
   * ========================================================== */

  var state = {
    decks: [],
    items: [],
    srs: {},
    stars: [],
    ui: sanitizeUI(null),
    day: sanitizeDay(null),

    deckId: '',          // 表示中のセット（'' はすべて）
    queue: [],           // これから出す [{itemId, face}]
    current: null,       // いま出している {itemId, face}
    flipped: false,      // 裏を出しているか
    editingId: null,     // 編集中のカード id（新規は null）
    editingImg: '',      // 編集中に選んでいる写真の id
    editingImgWas: '',   // 開いたときに付いていた写真の id（捨てるかの判断に使う）
    listQuery: '',
    speechOK: false,
    started: false,      // 一度でも画面を作ったか
    flashTimer: null
  };

  /* ============================================================
   * 5. DOM 参照
   * ========================================================== */

  var elDeckSelect = $('card-deck-select');
  var elAddBtn = $('btn-card-add');
  var elImportBtn = $('btn-card-import');
  var elListBtn = $('btn-card-list');
  var elSettingsBtn = $('btn-card-settings');

  var elProgress = $('card-progress');
  var elProgressLeft = $('progress-left');
  var elProgressCount = $('progress-count');
  var elProgressTrack = $('progress-track');
  var elProgressFill = $('progress-fill');
  var elStatus = $('card-status');

  var elStage = $('card-stage');
  var elEmpty = $('card-empty');
  var elFaceBadge = $('card-face-badge');
  var elFaceDesc = $('card-face-desc');
  var elFlashcard = $('flashcard');
  var elFrontText = $('card-front-text');
  var elTargetTag = $('card-target-tag');
  var elPlayBtn = $('btn-card-play');
  var elBack = $('card-back');
  var elAnswer = $('card-answer');
  var elSub = $('card-sub');
  var elNote = $('card-note');

  var elFlipRow = $('card-actions-flip');
  var elFlipBtn = $('btn-card-flip');
  var elGradeRow = $('card-actions-grade');
  var elAgain = $('btn-grade-again');
  var elGood = $('btn-grade-good');
  var elEasy = $('btn-grade-easy');
  var elWhenAgain = $('when-again');
  var elWhenGood = $('when-good');
  var elWhenEasy = $('when-easy');

  var elRecall = $('card-recall');
  var elSpeakBtn = $('btn-card-speak');
  var elSlowBtn = $('btn-card-slow');
  var elStarBtn = $('btn-card-star');
  var elEditBtn = $('btn-card-edit');

  var elDialog = $('card-dialog');
  var elDialogTitle = $('card-dialog-title');
  var elDialogStatus = $('card-dialog-status');
  var elFieldEn = $('card-en');
  var elFieldJa = $('card-ja');
  var elFieldExEn = $('card-ex-en');
  var elFieldExJa = $('card-ex-ja');
  var elFieldNote = $('card-note-input');
  var elSaveBtn = $('btn-card-save');
  var elCancelBtn = $('btn-card-cancel');
  var elDeleteBtn = $('btn-card-delete');
  var elPhotoField = $('card-photo-field');
  var elPhotoBtn = $('btn-card-photo');
  var elPhotoClear = $('btn-card-photo-clear');
  var elPhotoFile = $('card-photo-file');
  var elPhotoPreview = $('card-photo-preview');
  var elPhotoImg = $('card-photo-img');
  var elPhotoStatus = $('card-photo-status');
  var elPhotoFront = $('card-photo-front');
  var elPhotoBack = $('card-photo-back');
  var elNewDeckInput = $('card-new-deck');
  var elNewDeckBtn = $('btn-card-new-deck');

  var elListDialog = $('card-list-dialog');
  var elListDesc = $('card-list-desc');
  var elListSearch = $('card-list-search');
  var elList = $('card-list');
  var elListMore = $('card-list-more');
  var elListClose = $('btn-card-list-close');
  var elDeckManageList = $('card-deck-manage-list');

  var elSettingsDialog = $('card-settings-dialog');
  var elFaceL = $('opt-face-l');
  var elFaceS = $('opt-face-s');
  var elNewPerDay = $('opt-new-per-day');
  var elNewPerDayOut = $('opt-new-per-day-out');
  var elRetention = $('opt-retention');
  var elRetentionOut = $('opt-retention-out');
  var elAutoSpeak = $('opt-card-auto-speak');
  var elSpeakNote = $('opt-card-speak-note');
  var elSettingsClose = $('btn-card-settings-close');
  var elStats = $('card-stats');
  var elResetBtn = $('btn-card-reset');
  var elResetStatus = $('card-reset-status');

  /* ============================================================
   * 6. 保存
   * ========================================================== */

  function saveDecks() { return writeJSON(LS_DECKS, state.decks); }
  function saveItems() { return writeJSON(LS_ITEMS, state.items); }
  function saveSrs() { return writeJSON(LS_SRS, state.srs); }
  function saveStars() { return writeJSON(LS_STARS, state.stars); }
  function saveDay() { return writeJSON(LS_DAY, state.day); }

  function saveUI() {
    return writeJSON(LS_UI, {
      deckId: state.deckId,
      faces: state.ui.faces,
      newPerDay: state.ui.newPerDay,
      retention: state.ui.retention,
      autoSpeak: state.ui.autoSpeak
    });
  }

  function flashStatus(message) {
    if (!elStatus) return;
    elStatus.textContent = str(message);
    if (state.flashTimer) window.clearTimeout(state.flashTimer);
    state.flashTimer = window.setTimeout(function () {
      if (elStatus) elStatus.textContent = '';
      state.flashTimer = null;
    }, 3000);
  }

  /* ============================================================
   * 7. カードと面
   * ========================================================== */

  function findItem(id) {
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].id === id) return state.items[i];
    }
    return null;
  }

  function findDeck(id) {
    for (var i = 0; i < state.decks.length; i++) {
      if (state.decks[i].id === id) return state.decks[i];
    }
    return null;
  }

  /** そのセットに入っているカード */
  function itemsOfDeck(deckId) {
    var out = [];
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].deckId === deckId) out.push(state.items[i]);
    }
    return out;
  }

  /** いま表示するセットに入っているカード（'' なら全部） */
  function itemsInDeck() {
    return state.deckId ? itemsOfDeck(state.deckId) : state.items.slice();
  }

  /** 1 枚 1 面の記憶の状態。無ければ新品を返す（保存はしない） */
  function faceState(itemId, face) {
    var srs = srsPort();
    var per = state.srs[itemId];
    if (per && per[face]) return per[face];
    return srs ? srs.newState() : null;
  }

  function setFaceState(itemId, face, next) {
    if (!state.srs[itemId]) state.srs[itemId] = {};
    state.srs[itemId][face] = next;
  }

  /** 「聞」が使えるか。読み上げが無い端末では音の面は出せない */
  function faceUsable(face) {
    if (face === 'r') return true;
    if (face === 'l') return state.ui.faces.l && state.speechOK;
    if (face === 's') return state.ui.faces.s;
    return false;
  }

  /** その面を開く条件になっている、ひとつ前の面（読には無い） */
  function gateFor(itemId, face) {
    if (face === 'l') return faceState(itemId, 'r');
    // 言 … 聞が育ってから。聞を使わない設定なら読から直接
    return faceUsable('l') ? faceState(itemId, 'l') : faceState(itemId, 'r');
  }

  /**
   * その面を開く条件を満たしたか（日は見ない）。
   * 「明日はどれだけ出るか」を数えるときは、今日はまだ出せないぶんも入れたいのでこちらを使う。
   */
  function faceReady(itemId, face) {
    if (!faceUsable(face)) return false;
    if (face === 'r') return true;
    var gate = gateFor(itemId, face);
    return gate.streak >= UNLOCK_STREAK && gate.last !== null;
  }

  /**
   * その面を、**今日**出してよいか。
   *
   * 条件を満たしても、満たした当日は出さない。ここを見ないと、いったん閉じて
   * 開き直しただけで予定が組み直されて新しい面が湧き、「のこり」が増える
   * （やめ時が分からなくなる）。30 秒前に見た答えを聞き返すのは記憶を試した
   * ことにもならないので、どのみち日をまたがせるのが正しい。
   */
  function faceUnlocked(itemId, face) {
    if (!faceReady(itemId, face)) return false;
    if (face === 'r') return true;
    return dayOf(gateFor(itemId, face).last) !== today();
  }

  /** その面で読み上げる英語。例文があれば例文、無ければ語そのもの */
  function audioText(item) {
    return item.exEn || item.en;
  }

  /* ============================================================
   * 8. 今日の予定を組む
   * ========================================================== */

  /**
   * まだ 1 面も答えていないカードか。
   *
   * 1 日の上限は「**今日から始める新しいカード**」の数にかける。
   * すでに始めたカードの「聞」「言」は、そのカードの予定に沿って出てきたものなので、
   * 上限で止めない。止めると忘却曲線の言うとおりに出せなくなり、曲線の意味が無くなる。
   */
  function isNewCard(itemId) {
    var per = state.srs[itemId];
    if (!per) return true;
    for (var face in per) {
      if (!Object.prototype.hasOwnProperty.call(per, face)) continue;
      if (per[face] && per[face].state !== 'new') return false;
    }
    return true;
  }

  /**
   * そのセットで、今日あと何枚まで新しいカードを始めてよいか。
   *
   * **上限はセットごとに別々。** ひとつにまとめると、先に開いたセットで使い切って
   * ほかのセットが 1 枚も始められなくなる（3 セット 45 枚あっても 20 枚で打ち止めだった）。
   */
  function newAllowance(deckId) {
    state.day = sanitizeDay(state.day);
    var used = state.day.introduced[trim(deckId)] || 0;
    return Math.max(0, state.ui.newPerDay - used);
  }

  /**
   * 出す順に並べた [{itemId, face}] を作る。
   *
   *   1. 今日のうちに出し直す札（覚えたて・覚え直し）… 予定の早い順
   *   2. 日をまたいで戻ってきた札 … ばらして出す（同じ順で覚えてしまうのを防ぐ）
   *   3. 新しい札 … 1 日の上限まで
   *
   * 新しい札は最後にまとめず、復習のあいだに散らす。頭に固めると
   * 「新しいのばかり 20 枚」で疲れて終わる。
   */
  /** 今日ここまでに始めたカードの合計（セットぶんを足す） */
  function introducedTotal() {
    state.day = sanitizeDay(state.day);
    var n = 0;
    for (var id in state.day.introduced) {
      if (Object.prototype.hasOwnProperty.call(state.day.introduced, id)) n += state.day.introduced[id];
    }
    return n;
  }

  /** いま見ているセットで、1 日の上限に引っかかって今日は出さなかったぶんの数 */
  function heldByLimit() {
    var parts = collectUnits(itemsInDeck());
    var all = parts.ladder.length + parts.fresh.length;
    return Math.max(0, all - capNew(parts.ladder, parts.fresh).length);
  }

  /**
   * カードの並びから、今日出すぶんを 3 つに仕分ける。
   *
   *   learning … 今日のうちに出し直す札
   *   due      … 日をまたいで戻ってきた札。**上限をかけない**（忘却曲線の言うとおりに出す）
   *   fresh    … 今日から始めるカード。ここだけセットごとの上限にかける
   *   ladder   … すでに始めたカードで、新しく開いた「聞」「言」。上限をかけない
   */
  function collectUnits(list) {
    var now = Date.now();
    var learning = [], due = [], fresh = [], ladder = [];

    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var brandNew = isNewCard(item.id);

      for (var f = 0; f < FACES.length; f++) {
        var face = FACES[f];
        if (!faceUnlocked(item.id, face)) continue;

        var st = faceState(item.id, face);
        var entry = { itemId: item.id, face: face, due: st.due };

        if (st.state === 'new') {
          (brandNew ? fresh : ladder).push(entry);
        } else if (st.due !== null && st.due <= now) {
          if (st.state === 'learning' || st.state === 'relearning') learning.push(entry);
          else due.push(entry);
        }
      }
    }
    return { learning: learning, due: due, fresh: fresh, ladder: ladder };
  }

  /**
   * 今日「新しく出す」ぶんを、セットごとの上限まで残す。
   *
   * **育って開いた面（ladder）を、今日から始めるカード（fresh）より先に通す。**
   * 始めたものを終わらせるほうが先で、逆にすると新しいカードに押されて
   * 「聞」「言」がいつまでも出てこない。
   *
   * 上限をかけても忘却曲線は壊れない。どちらもまだ一度も答えていない面で、
   * 覚え具合の記録がまだ無いから、あとの日に回しても失うものが無い。
   * 止めてはいけないのは「予定が来た復習」のほうで、そちらには一切かけない。
   */
  function capNew(ladder, fresh) {
    var byOrder = fresh.slice().sort(function (a, b) {
      var ia = findItem(a.itemId), ib = findItem(b.itemId);
      return ((ia && ia.created) || 0) - ((ib && ib.created) || 0);
    });

    var order = ladder.concat(byOrder);
    var room = {}, kept = [];
    for (var i = 0; i < order.length; i++) {
      var item = findItem(order[i].itemId);
      var deckId = item ? trim(item.deckId) : '';
      if (room[deckId] === undefined) room[deckId] = newAllowance(deckId);
      if (room[deckId] <= 0) continue;
      room[deckId]--;
      kept.push(order[i]);
    }
    return kept;
  }

  function buildQueue() {
    var srs = srsPort();
    if (!srs) return [];

    var parts = collectUnits(itemsInDeck());
    var learning = parts.learning;
    var due = parts.due;
    var fresh = capNew(parts.ladder, parts.fresh);

    learning.sort(function (a, b) { return (a.due || 0) - (b.due || 0); });
    shuffle(due);

    // 復習のあいだに新しい札を散らす
    var mixed = learning.concat(due);
    if (!fresh.length) return mixed;
    if (!mixed.length) return fresh;

    var out = [];
    var gap = Math.max(1, Math.floor(mixed.length / fresh.length));
    var fi = 0;
    for (var k = 0; k < mixed.length; k++) {
      out.push(mixed[k]);
      if (fi < fresh.length && (k + 1) % gap === 0) out.push(fresh[fi++]);
    }
    while (fi < fresh.length) out.push(fresh[fi++]);
    return out;
  }

  /**
   * のこりの面の数。予定に入っているもの＋いま出している 1 枚。
   *
   * 覚えたての札は答えても予定に戻るので、ここはすぐには減らない。それでいい。
   * **大事なのは決して増えないこと。** 増えると終わりが見えなくなる。
   */
  function remainingUnits() {
    return state.queue.length + (state.current ? 1 : 0);
  }

  /** その日の終わり（ミリ秒） */
  function endOfDay(ms) {
    var d = new Date(ms);
    d.setHours(23, 59, 59, 999);
    return d.getTime();
  }

  /**
   * 次に出番が来るのはいつで、だいたい何枚か。
   *
   * 「今日はここまで」と言い切るには、**いつ戻ってくればいいか**まで言う必要がある。
   * ここを出さないと、終わったあとに「もう来なくていいのか」が分からない。
   *
   * @returns {{days:number, count:number}|null} 出番が無ければ null
   */
  function nextSession() {
    var list = itemsInDeck();
    var todayEnd = endOfDay(Date.now());

    var fresh = 0;     // まだ一度も出していない面（今日はもう出せないぶんを含む）
    var dues = [];     // 日をまたぐ予定に乗っている面

    for (var i = 0; i < list.length; i++) {
      for (var f = 0; f < FACES.length; f++) {
        var face = FACES[f];
        if (!faceReady(list[i].id, face)) continue;
        var st = faceState(list[i].id, face);
        if (st.state === 'new') fresh++;
        else if (st.due !== null) dues.push(st.due);
      }
    }

    // 次に開く日の候補 … 新しい札が残っていれば明日、予定の札はいちばん早い日
    var when = null;
    if (fresh > 0) when = todayEnd + 1;                    // 明日のはじまり
    for (var k = 0; k < dues.length; k++) {
      if (dues[k] <= todayEnd) continue;                   // 今日ぶんはもう終わっている
      if (when === null || dues[k] < when) when = dues[k];
    }
    if (when === null) return null;

    // その日の終わりまでに出るぶんを数える
    var limit = endOfDay(when);
    var count = 0;
    for (var m = 0; m < dues.length; m++) {
      if (dues[m] > todayEnd && dues[m] <= limit) count++;
    }
    if (fresh > 0) count += Math.min(fresh, state.ui.newPerDay);

    var days = Math.round((endOfDay(when) - todayEnd) / 86400000);
    return { days: Math.max(1, days), count: count };
  }

  /** 「次は明日」「次は 3 日後」。数の前後に空白を置く書き方に合わせる */
  function nextLabel(days) {
    return days <= 1 ? '次は明日' : '次は ' + days + ' 日後';
  }

  /* ============================================================
   * 9. 描画
   * ========================================================== */

  /**
   * セット名のうしろに付ける「今日ぶん」の札。
   * セットごとに何枚やればいいかが、選ぶ前から分かるように。
   */
  function todayTag(list) {
    if (!list.length) return '（0）';
    var parts = collectUnits(list);
    var n = parts.learning.length + parts.due.length +
      capNew(parts.ladder, parts.fresh).length;
    return n ? '（今日 ' + n + '）' : '（済）';
  }

  function renderDeckSelect() {
    if (!elDeckSelect) return;
    var keep = state.deckId;
    elDeckSelect.textContent = '';

    var all = document.createElement('option');
    all.value = '';
    all.textContent = 'すべてのセット' + todayTag(state.items);
    elDeckSelect.appendChild(all);

    for (var i = 0; i < state.decks.length; i++) {
      var d = state.decks[i];
      var opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.name + todayTag(itemsOfDeck(d.id));
      elDeckSelect.appendChild(opt);
    }
    elDeckSelect.value = findDeck(keep) ? keep : '';
    state.deckId = elDeckSelect.value;
  }

  /**
   * 今日の進み具合。
   *
   * 分母は「今日カタが付いた数＋のこり」。予定は途中で増えないので、
   * のこりは減る一方になり、**いつ終わるかが最初から見える**。
   */
  function renderProgress() {
    state.day = sanitizeDay(state.day);
    var left = remainingUnits();
    var done = state.day.done;
    var total = done + left;

    if (elProgress) elProgress.hidden = !total;
    if (!total) return;

    if (elProgressLeft) {
      elProgressLeft.textContent = left ? 'のこり ' + left + ' 枚' : 'おしまい';
    }
    if (elProgressCount) elProgressCount.textContent = done + ' / ' + total;
    if (elProgressFill) {
      elProgressFill.style.width = Math.round(done / total * 100) + '%';
    }
    if (elProgressTrack) {
      elProgressTrack.setAttribute('aria-valuemax', String(total));
      elProgressTrack.setAttribute('aria-valuenow', String(done));
    }
  }

  function escapeRe(w) { return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /** 1 語ぶんの当て方。活用しているぶんを許す（take → takes / taking / took は別扱い） */
  function wordPattern(w) {
    if (/y$/i.test(w) && w.length > 1) {
      return escapeRe(w.slice(0, -1)) + '(?:y|ies|ied|ying)';
    }
    return escapeRe(w) + '(?:s|es|ed|d|ing)?';
  }

  /**
   * 例文の中から、覚える語がどこにあるかを探す。
   *
   * 見出しは原形（take after）なのに、例文では活用している（takes after）ことが多い。
   * そのままの文字で探すと見つからず、どの語の話なのか分からない札になる。
   *
   * @returns {{at:number, len:number}|null}
   */
  function findTarget(sentence, target) {
    var words = trim(target).split(/\s+/);
    var clean = [];
    for (var i = 0; i < words.length; i++) {
      if (words[i]) clean.push(words[i]);
    }
    if (!clean.length) return null;

    var parts = [];
    for (var k = 0; k < clean.length; k++) parts.push(wordPattern(clean[k]));

    // 1) 語形の揺れだけを許して当てる
    var hit = sentence.match(new RegExp('\\b' + parts.join('\\s+') + '\\b', 'i'));
    if (hit) return { at: hit.index, len: hit[0].length };

    // 2) 先頭が不規則変化（come up with → came up with）。
    //    2 語目から当てて、左へ 1 語ぶん伸ばす。
    if (clean.length >= 2) {
      var tail = sentence.match(new RegExp('\\b' + parts.slice(1).join('\\s+') + '\\b', 'i'));
      if (tail) {
        var before = sentence.slice(0, tail.index).replace(/\s+$/, '');
        var space = before.lastIndexOf(' ');
        var start = space < 0 ? 0 : space + 1;
        return { at: start, len: tail.index + tail[0].length - start };
      }
    }
    return null;
  }

  /**
   * 例文の中の覚える語を目立たせる。
   * 見つからなければそのまま返し、見つかったかどうかを呼び出し側に返す
   * （見つからなかったときは、どの語の話かを別に添える必要がある）。
   */
  function highlight(sentence, target) {
    var out = document.createDocumentFragment();
    var found = findTarget(sentence, target);

    if (!found) {
      out.appendChild(document.createTextNode(sentence));
      return { node: out, matched: false };
    }
    out.appendChild(document.createTextNode(sentence.slice(0, found.at)));
    var strong = document.createElement('strong');
    strong.className = 'card-target';
    strong.textContent = sentence.slice(found.at, found.at + found.len);
    out.appendChild(strong);
    out.appendChild(document.createTextNode(sentence.slice(found.at + found.len)));
    return { node: out, matched: true };
  }

  /**
   * 写真を出す。
   *
   *   読 … 裏だけ（表に出すと意味が割れる）
   *   聞 … 裏だけ
   *   言 … **表にも小さく出す**。写真を見て英語を口に出すのがいちばん強い練習になる
   */
  function renderPhoto(item, face) {
    var media = mediaPort();
    var id = trim(item.img);

    function put(el, show) {
      if (!el) return;
      if (!show || !id || !media) {
        el.hidden = true;
        el.removeAttribute('src');
        return;
      }
      media.url(id).then(function (url) {
        // 待っているあいだに次の札へ進んでいたら貼らない
        if (!state.current || state.current.itemId !== item.id) return;
        if (!url) { el.hidden = true; return; }
        el.src = url;
        el.hidden = false;
      });
    }

    put(elPhotoFront, face === 's');
    put(elPhotoBack, true);
  }

  /** 「どの語の話か」を表に添える。空文字なら消す */
  function showTargetTag(text) {
    if (!elTargetTag) return;
    var value = trim(text);
    elTargetTag.textContent = value ? value + ' ＝ ？' : '';
    elTargetTag.hidden = !value;
  }

  function setText(el, text) {
    if (!el) return;
    var value = trim(text);
    el.textContent = value;
    el.hidden = !value;
  }

  /** いま出ている 1 枚を描く */
  function renderCard() {
    if (!state.current) return;
    var item = findItem(state.current.itemId);
    if (!item) { next(); return; }

    var face = state.current.face;
    var info = FACE_INFO[face];

    if (elFaceBadge) {
      elFaceBadge.textContent = info.badge;
      elFaceBadge.setAttribute('data-face', face);
    }
    if (elFaceDesc) elFaceDesc.textContent = info.desc;
    if (elFlashcard) elFlashcard.setAttribute('data-face', face);

    // --- 表 ---
    if (elFrontText) {
      elFrontText.textContent = '';
      elFrontText.className = 'card-text';
      if (face === 'r') {
        if (item.exEn) {
          var marked = highlight(item.exEn, item.en);
          elFrontText.appendChild(marked.node);
          elFrontText.classList.add('card-text--en');
          // 例文の中に見つからなかったときだけ、どの語の話かを添える。
          // 見つかっているときに出すと、同じものが 2 回出るだけで邪魔になる。
          showTargetTag(marked.matched ? '' : item.en);
        } else {
          elFrontText.textContent = item.en;
          elFrontText.classList.add('card-text--en', 'card-text--big');
          showTargetTag('');
        }
      } else if (face === 'l') {
        // 音だけ。文字を出したらリスニングにならない
        elFrontText.textContent = '🔈';
        elFrontText.classList.add('card-text--audio');
        showTargetTag('');
      } else {
        elFrontText.textContent = item.exJa || item.ja || item.en;
        elFrontText.classList.add('card-text--ja');
        showTargetTag('');
      }
    }
    if (elPlayBtn) elPlayBtn.hidden = (face !== 'l');

    // --- 裏 ---
    if (face === 'r') {
      setText(elAnswer, item.ja || item.en);
      setText(elSub, item.exJa);
    } else if (face === 'l') {
      setText(elAnswer, item.exEn || item.en);
      setText(elSub, [item.ja, item.exJa].filter(Boolean).join(' / '));
    } else {
      setText(elAnswer, item.exEn || item.en);
      setText(elSub, item.exEn ? item.en : item.ja);
    }
    setText(elNote, item.note);
    renderPhoto(item, face);

    if (elStarBtn) {
      var starred = state.stars.indexOf(item.id) >= 0;
      elStarBtn.setAttribute('aria-pressed', starred ? 'true' : 'false');
      elStarBtn.classList.toggle('is-on', starred);
    }

    // いま思い出せる確率。忘却曲線が効いているのが見えるように
    if (elRecall) {
      var srs = srsPort();
      var st = faceState(item.id, face);
      if (st.state === 'new') {
        elRecall.textContent = '新しい札';
      } else {
        var pct = Math.round(srs.recallChance(st, Date.now()) * 100);
        elRecall.textContent = '記憶 ' + pct + '%';
      }
    }

    showFront();
  }

  function showFront() {
    state.flipped = false;
    if (elBack) elBack.hidden = true;
    if (elFlipRow) elFlipRow.hidden = false;
    if (elGradeRow) elGradeRow.hidden = true;
    if (elFlashcard) elFlashcard.classList.remove('is-flipped');
  }

  /** ボタンごとの「次はいつ出るか」を添える。押す前に分かるほうが迷わない */
  function renderWhen() {
    var srs = srsPort();
    if (!srs || !state.current) return;
    var st = faceState(state.current.itemId, state.current.face);
    var days = srs.preview(st, { retention: state.ui.retention });
    if (elWhenAgain) elWhenAgain.textContent = srs.humanInterval(days[1]);
    if (elWhenGood) elWhenGood.textContent = srs.humanInterval(days[3]);
    if (elWhenEasy) elWhenEasy.textContent = srs.humanInterval(days[4]);
  }

  function renderEmpty() {
    if (elStage) elStage.hidden = true;
    if (!elEmpty) return;

    elEmpty.hidden = false;
    elEmpty.textContent = '';
    var total = itemsInDeck().length;

    if (!state.items.length) {
      elEmpty.textContent = 'まだカードがありません。「PDF から」か「＋追加」で作ってください。';
      return;
    }
    if (!total) {
      elEmpty.textContent = 'このセットにはカードがありません。';
      return;
    }

    // 終わったことをはっきり言う。「まだ何か残っているのでは」と思わせない
    state.day = sanitizeDay(state.day);
    var head = document.createElement('strong');
    head.className = 'card-empty-head';
    head.textContent = state.day.done
      ? '今日はここまで。' + state.day.done + ' 枚やりました。'
      : '今日出す札はありません。';
    elEmpty.appendChild(head);

    var next = nextSession();
    var line = document.createElement('span');
    line.className = 'card-empty-sub';
    line.textContent = next
      ? nextLabel(next.days) + '、およそ ' + next.count + ' 枚です。'
      : 'いまのカードはひととおり終わりました。新しいカードを足すと、また始まります。';
    elEmpty.appendChild(line);

    // まだ入れていない新しい札があるなら、増やせることだけ伝える（勝手には増やさない）
    // 上限で止めているぶんがあるときだけ、そう言う（黙って減らさない）
    var held = heldByLimit();
    if (held > 0) {
      var note = document.createElement('span');
      note.className = 'card-empty-note';
      note.textContent = 'このほかに、まだ始めていないカードが ' + held + ' 枚あります。' +
        '新しいカードは 1 セットにつき 1 日 ' + state.ui.newPerDay + ' 枚までにしてあります（⚙ で変えられます）。';
      elEmpty.appendChild(note);
    }
  }

  /** 画面ぜんぶを作り直す */
  function render() {
    renderDeckSelect();
    state.queue = buildQueue();
    state.current = null;
    next();
  }

  /* ============================================================
   * 10. めくる・答える
   * ========================================================== */

  /** 次の 1 枚を出す。もう無ければ終わりの画面 */
  function next() {
    state.current = state.queue.shift() || null;

    if (!state.current) {
      renderProgress();
      renderEmpty();
      return;
    }
    if (elStage) elStage.hidden = false;
    if (elEmpty) elEmpty.hidden = true;

    renderCard();
    renderProgress();

    // 「聞」は表に出た時点で鳴らす。タップの中から同期で呼ぶこと（iOS で無音になる）
    if (state.current.face === 'l') playAudio(1);
  }

  function flip() {
    if (!state.current || state.flipped) return;
    state.flipped = true;

    if (elBack) elBack.hidden = false;
    if (elFlipRow) elFlipRow.hidden = true;
    if (elGradeRow) elGradeRow.hidden = false;
    if (elFlashcard) elFlashcard.classList.add('is-flipped');

    renderWhen();

    // 「聞」は表ですでに鳴らしているので、めくり直しでは鳴らさない
    if (state.ui.autoSpeak && state.current.face !== 'l') playAudio(1);
  }

  /**
   * 答える。1=もう一度 3=できた 4=かんたん
   * （2=むずかしい はボタンを出していないが、srs.js の式には残してある）
   */
  function answer(grade) {
    var srs = srsPort();
    if (!srs || !state.current || !state.flipped) return;

    var itemId = state.current.itemId;
    var face = state.current.face;
    var before = faceState(itemId, face);
    // 今日「新しく出した」ものは、今日から始めたカードでも、育って開いた面でも、
    // どちらも 1 つぶん上限を使う（capNew が数えているのと同じ単位にそろえる）。
    var startedCard = (before.state === 'new');

    var after = srs.review(before, grade, { retention: state.ui.retention });
    setFaceState(itemId, face, after);
    saveSrs();

    state.day = sanitizeDay(state.day);
    if (startedCard) {
      var item = findItem(itemId);
      var deckId = item ? trim(item.deckId) : '';
      state.day.introduced[deckId] = (state.day.introduced[deckId] || 0) + 1;
    }
    state.day.answered++;
    saveDay();

    // 今日のうちにまた出す札は、この場のならびに戻す。
    // すぐ後ろに入れると答えを覚えたまま出るので、何枚か先へ置く。
    var again = (after.due !== null && after.due - Date.now() <= SAME_SESSION_MIN * 60000);
    if (again) {
      var at = Math.min(state.queue.length, grade === 1 ? 3 : 8);
      state.queue.splice(at, 0, { itemId: itemId, face: face, due: after.due });
    } else {
      // 戻さなかった＝この 1 面は今日ぶん終わり。「のこり」はこれで必ず減る
      state.day.done++;
    }
    saveDay();

    // 開いたばかりの面は、その場では足さない。
    // 途中で予定が増えると「のこり」が戻って、終わりが見えなくなる。
    // 始めた時点の予定を最後まで動かさないのが、やめ時が分かるということ。

    var port = speechPort();
    if (port) port.cancel();

    next();
  }

  /* ============================================================
   * 11. 音
   * ========================================================== */

  function playAudio(rate) {
    var port = speechPort();
    if (!port || !state.speechOK || !state.current) return;
    var item = findItem(state.current.itemId);
    if (!item) return;
    port.speak(audioText(item), { rate: rate || 1 });
  }

  /* ============================================================
   * 12. 追加・編集・削除
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

  /* ---- 写真 ---- */

  /** ダイアログの写真の見た目を、いまの state.editingImg に合わせる */
  function renderPhotoField() {
    var media = mediaPort();
    if (elPhotoField) elPhotoField.hidden = !(media && media.supported());

    var has = !!trim(state.editingImg);
    if (elPhotoClear) elPhotoClear.hidden = !has;
    if (elPhotoBtn) elPhotoBtn.textContent = has ? '写真を替える' : '写真を選ぶ';
    if (elPhotoPreview) elPhotoPreview.hidden = !has;

    if (!has) {
      if (elPhotoImg) elPhotoImg.removeAttribute('src');
      return;
    }
    if (!media || !elPhotoImg) return;
    var want = state.editingImg;
    media.url(want).then(function (url) {
      // 待っているあいだに別の写真へ替わっていたら、古いほうを貼らない
      if (state.editingImg !== want || !elPhotoImg) return;
      if (url) elPhotoImg.src = url;
    });
  }

  function photoStatus(message) {
    if (elPhotoStatus) elPhotoStatus.textContent = str(message);
  }

  /**
   * 選ばれたファイルを、縮めてしまう。
   *
   * **入れ替えたぶんはすぐには消さない。** 「閉じる」で取り消すかもしれないので、
   * 保存するときに要らなくなったほうを捨てる（closeCardDialog / submitCard）。
   */
  function takePhoto(file) {
    var media = mediaPort();
    if (!media || !file) return;

    photoStatus('写真を取り込んでいます…');
    if (elPhotoBtn) elPhotoBtn.disabled = true;

    media.add(file).then(function (info) {
      if (elPhotoBtn) elPhotoBtn.disabled = false;
      state.editingImg = info.id;
      renderPhotoField();
      photoStatus('取り込みました（' + media.humanBytes(info.bytes) + '）。');
    }).catch(function (err) {
      if (elPhotoBtn) elPhotoBtn.disabled = false;
      photoStatus('取り込めませんでした（' + ((err && err.message) || '理由は分かりません') + '）。');
    });
  }

  /** 使われなくなった写真を捨てる。いま使っている id は残す */
  function dropPhotoIfUnused(id, keepId) {
    var media = mediaPort();
    var target = trim(id);
    if (!media || !target || target === trim(keepId)) return;

    // ほかのカードが使っていれば消さない
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].img === target) return;
    }
    media.remove(target);
  }

  function openCardDialog(itemId) {
    state.editingId = itemId || null;
    var item = itemId ? findItem(itemId) : null;

    if (elDialogTitle) elDialogTitle.textContent = item ? 'カードを編集' : 'カードを追加';
    if (elSaveBtn) elSaveBtn.textContent = item ? '保存する' : '追加する';
    if (elDeleteBtn) elDeleteBtn.hidden = !item;
    if (elDialogStatus) elDialogStatus.textContent = '';

    if (elFieldEn) elFieldEn.value = item ? item.en : '';
    if (elFieldJa) elFieldJa.value = item ? item.ja : '';
    if (elFieldExEn) elFieldExEn.value = item ? item.exEn : '';
    if (elFieldExJa) elFieldExJa.value = item ? item.exJa : '';
    if (elFieldNote) elFieldNote.value = item ? item.note : '';

    state.editingImg = item ? trim(item.img) : '';
    state.editingImgWas = state.editingImg;
    photoStatus('');
    renderPhotoField();

    openDialog(elDialog);
    if (elFieldEn) elFieldEn.focus();
  }

  /**
   * ダイアログを閉じる（取り消し）。
   * 取り込んだだけで保存しなかった写真は、ここで捨てる。溜めると保存領域を食う。
   */
  function closeCardDialog() {
    dropPhotoIfUnused(state.editingImg, state.editingImgWas);
    state.editingImg = '';
    state.editingImgWas = '';
    closeDialog(elDialog);
    state.editingId = null;
  }

  /** 追加先のセット。選んでいなければ作る（「すべて」のまま足せないと不便） */
  function targetDeckId() {
    if (state.deckId && findDeck(state.deckId)) return state.deckId;
    if (state.decks.length) return state.decks[0].id;
    var deck = { id: makeId('deck'), name: '自分のカード', created: Date.now() };
    state.decks.push(deck);
    saveDecks();
    state.deckId = deck.id;
    saveUI();
    return deck.id;
  }

  function submitCard() {
    var en = trim(elFieldEn && elFieldEn.value);
    var ja = trim(elFieldJa && elFieldJa.value);
    var exEn = trim(elFieldExEn && elFieldExEn.value);
    var exJa = trim(elFieldExJa && elFieldExJa.value);
    var note = trim(elFieldNote && elFieldNote.value);

    if (!en) {
      if (elDialogStatus) elDialogStatus.textContent = '英語を入れてください。';
      if (elFieldEn) elFieldEn.focus();
      return;
    }
    if (!ja && !exJa) {
      if (elDialogStatus) elDialogStatus.textContent = '日本語の意味か、例文の訳のどちらかは要ります。';
      if (elFieldJa) elFieldJa.focus();
      return;
    }

    if (state.editingId) {
      var item = findItem(state.editingId);
      if (item) {
        var oldImg = trim(item.img);
        item.en = en; item.ja = ja; item.exEn = exEn; item.exJa = exJa; item.note = note;
        item.img = trim(state.editingImg);
        saveItems();
        dropPhotoIfUnused(oldImg, item.img);   // 替えたなら、古いほうは要らない
      }
      state.editingImg = '';
      state.editingImgWas = '';
      closeDialog(elDialog);
      state.editingId = null;
      render();
      flashStatus('直しました。');
      return;
    }

    state.items.push({
      id: makeId('card'),
      deckId: targetDeckId(),
      en: en, ja: ja, exEn: exEn, exJa: exJa, note: note,
      img: trim(state.editingImg),
      created: Date.now()
    });
    saveItems();
    // 続けて次の 1 枚を入れられるように、写真も外す（同じ写真が全部に付かないように）
    state.editingImg = '';
    state.editingImgWas = '';
    renderPhotoField();
    photoStatus('');

    // 欄を空にして、続けて次の 1 枚を入れられるようにする
    if (elFieldEn) elFieldEn.value = '';
    if (elFieldJa) elFieldJa.value = '';
    if (elFieldExEn) elFieldExEn.value = '';
    if (elFieldExJa) elFieldExJa.value = '';
    if (elFieldNote) elFieldNote.value = '';
    if (elFieldEn) elFieldEn.focus();
    if (elDialogStatus) elDialogStatus.textContent = '足しました。続けて入れられます。';

    renderDeckSelect();
    renderProgress();
  }

  function deleteCard(itemId) {
    var item = findItem(itemId);
    if (!item) return;
    var label = item.en.length > 24 ? item.en.slice(0, 24) + '…' : item.en;
    if (!window.confirm('「' + label + '」を消します。覚えた記録もいっしょに消えます。')) return;

    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].id === itemId) { state.items.splice(i, 1); break; }
    }
    delete state.srs[itemId];
    var at = state.stars.indexOf(itemId);
    if (at >= 0) state.stars.splice(at, 1);
    recordDelete('carditem:', itemId);
    dropPhotoIfUnused(item.img, '');   // この 1 枚しか使っていなければ写真も捨てる

    saveItems(); saveSrs(); saveStars();
    state.editingImg = '';
    state.editingImgWas = '';
    closeDialog(elDialog);
    state.editingId = null;
    render();
    renderList();
    flashStatus('消しました。');
  }

  function toggleStar() {
    if (!state.current) return;
    var id = state.current.itemId;
    var at = state.stars.indexOf(id);
    if (at >= 0) state.stars.splice(at, 1); else state.stars.push(id);
    saveStars();
    renderCard();
    if (state.flipped) flip();
  }

  /* ============================================================
   * 13. 一覧
   * ========================================================== */

  function renderList() {
    if (!elList) return;
    elList.textContent = '';

    var all = itemsInDeck();
    var q = state.listQuery.toLowerCase();
    var hits = [];
    for (var i = 0; i < all.length; i++) {
      var c = all[i];
      if (q && (c.en + ' ' + c.ja + ' ' + c.exEn + ' ' + c.exJa).toLowerCase().indexOf(q) < 0) continue;
      hits.push(c);
    }

    if (elListDesc) {
      elListDesc.textContent = hits.length
        ? hits.length + ' 枚。行を押すと直せます。'
        : (all.length ? '見つかりませんでした。' : 'このセットにはカードがありません。');
    }

    var shown = hits.slice(0, LIST_LIMIT);
    for (var k = 0; k < shown.length; k++) {
      elList.appendChild(listRow(shown[k]));
    }
    if (elListMore) {
      elListMore.hidden = hits.length <= LIST_LIMIT;
      elListMore.textContent = hits.length > LIST_LIMIT
        ? 'ほかに ' + (hits.length - LIST_LIMIT) + ' 枚あります。上の欄で絞り込んでください。' : '';
    }
    renderDeckManageList();
  }

  function listRow(item) {
    var li = document.createElement('li');
    li.className = 'card-list-item';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'card-list-main';

    var en = document.createElement('span');
    en.className = 'card-list-en';
    en.textContent = item.en;
    btn.appendChild(en);

    var ja = document.createElement('small');
    ja.className = 'card-list-ja';
    ja.textContent = item.ja || item.exJa;
    btn.appendChild(ja);

    // 3 つの面がどこまで開いているか。育ち具合が見えると続けやすい
    var marks = document.createElement('span');
    marks.className = 'card-list-faces';
    for (var f = 0; f < FACES.length; f++) {
      var face = FACES[f];
      if (!faceUsable(face)) continue;
      var dot = document.createElement('span');
      dot.className = 'face-dot';
      dot.setAttribute('data-face', face);
      var st = faceState(item.id, face);
      if (!faceUnlocked(item.id, face)) dot.classList.add('is-locked');
      else if (st.state === 'new') dot.classList.add('is-new');
      else dot.classList.add('is-live');
      dot.textContent = FACE_INFO[face].badge;
      marks.appendChild(dot);
    }
    btn.appendChild(marks);

    btn.addEventListener('click', function () {
      closeDialog(elListDialog);
      openCardDialog(item.id);
    });

    li.appendChild(btn);
    return li;
  }

  function renderDeckManageList() {
    if (!elDeckManageList) return;
    elDeckManageList.textContent = '';

    if (!state.decks.length) {
      var none = document.createElement('li');
      none.className = 'deck-manage-empty';
      none.textContent = 'まだセットがありません。';
      elDeckManageList.appendChild(none);
      return;
    }

    for (var i = 0; i < state.decks.length; i++) {
      (function (deck) {
        var n = 0;
        for (var j = 0; j < state.items.length; j++) {
          if (state.items[j].deckId === deck.id) n++;
        }
        var li = document.createElement('li');
        li.className = 'deck-manage-item';

        var name = document.createElement('span');
        name.className = 'deck-manage-name';
        name.textContent = deck.name + '（' + n + ' 枚）';
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

  function deleteDeck(deckId) {
    var deck = findDeck(deckId);
    if (!deck) return;
    var n = 0;
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].deckId === deckId) n++;
    }
    if (!window.confirm('「' + deck.name + '」を、中のカード ' + n + ' 枚ごと消します。よろしいですか。')) return;

    for (var d = state.decks.length - 1; d >= 0; d--) {
      if (state.decks[d].id === deckId) state.decks.splice(d, 1);
    }
    recordDelete('carddeck:', deckId);
    for (var k = state.items.length - 1; k >= 0; k--) {
      if (state.items[k].deckId !== deckId) continue;
      delete state.srs[state.items[k].id];
      var at = state.stars.indexOf(state.items[k].id);
      if (at >= 0) state.stars.splice(at, 1);
      recordDelete('carditem:', state.items[k].id);
      state.items.splice(k, 1);
    }
    if (state.deckId === deckId) state.deckId = '';

    saveDecks(); saveItems(); saveSrs(); saveStars(); saveUI();
    render();
    renderList();
    flashStatus('「' + deck.name + '」を消しました。');
  }

  /* ============================================================
   * 14. 設定
   * ========================================================== */

  function renderSettings() {
    if (elFaceL) {
      elFaceL.checked = state.ui.faces.l;
      elFaceL.disabled = !state.speechOK;
    }
    if (elFaceS) elFaceS.checked = state.ui.faces.s;
    if (elSpeakNote) elSpeakNote.hidden = state.speechOK;
    if (elAutoSpeak) {
      elAutoSpeak.checked = state.ui.autoSpeak;
      elAutoSpeak.disabled = !state.speechOK;
    }
    if (elNewPerDay) {
      elNewPerDay.value = String(state.ui.newPerDay);
      if (elNewPerDayOut) elNewPerDayOut.textContent = state.ui.newPerDay + ' 枚';
    }
    if (elRetention) {
      elRetention.value = String(Math.round(state.ui.retention * 100));
      if (elRetentionOut) elRetentionOut.textContent = Math.round(state.ui.retention * 100) + '%';
    }
    renderStats();
  }

  function renderStats() {
    if (!elStats) return;
    var list = itemsInDeck();
    var live = 0, fresh = 0, faces = 0;
    for (var i = 0; i < list.length; i++) {
      for (var f = 0; f < FACES.length; f++) {
        var face = FACES[f];
        if (!faceUnlocked(list[i].id, face)) continue;
        faces++;
        if (faceState(list[i].id, face).state === 'new') fresh++; else live++;
      }
    }
    state.day = sanitizeDay(state.day);
    var base = 'カード ' + list.length + ' 枚 / 開いている面 ' + faces +
      '（覚えかけ ' + live + '・未学習 ' + fresh + '）。' +
      '今日答えたのは ' + state.day.answered + ' 回、新しく始めたのは ' + introducedTotal() + ' 枚です。';
    elStats.textContent = base;

    // 写真がどれだけ場所を取っているかも出す（取れたら言い足す）
    var media = mediaPort();
    if (media && media.supported()) {
      media.usage().then(function (u) {
        if (!elStats || !u.count) return;
        elStats.textContent = base + ' 写真は ' + u.count + ' 枚（' + media.humanBytes(u.bytes) + '）です。';
      });
    }
  }

  function resetProgress() {
    var list = itemsInDeck();
    if (!list.length) return;
    var label = state.deckId ? '「' + (findDeck(state.deckId) || {}).name + '」' : 'すべてのセット';
    if (!window.confirm(label + ' の覚えた記録を消して、新品に戻します。カードは残ります。よろしいですか。')) return;

    for (var i = 0; i < list.length; i++) delete state.srs[list[i].id];
    saveSrs();
    state.day = { day: today(), introduced: {}, answered: 0, done: 0 };
    saveDay();
    render();
    renderSettings();
    if (elResetStatus) elResetStatus.textContent = '記録を消しました。';
  }

  /* ============================================================
   * 15. キー操作
   * ========================================================== */

  function isTypingTarget(el) {
    if (!el) return false;
    var tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
  }

  function onKeyDown(e) {
    if (e.defaultPrevented) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (docEl.getAttribute('data-mode') !== 'cards') return;
    if (isTypingTarget(e.target)) return;
    if (!state.current) return;
    // ダイアログが開いている間は、そちらにキーを渡す
    if (document.querySelector('dialog[open]')) return;

    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (state.flipped) answer(3); else flip();
      return;
    }
    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      playAudio(1);
      return;
    }
    if (!state.flipped) return;
    if (e.key === '1') { e.preventDefault(); answer(1); }
    else if (e.key === '2') { e.preventDefault(); answer(3); }
    else if (e.key === '3') { e.preventDefault(); answer(4); }
  }

  /* ============================================================
   * 16. つなぎ込み
   * ========================================================== */

  function bindEvents() {
    if (elDeckSelect) {
      elDeckSelect.addEventListener('change', function () {
        state.deckId = elDeckSelect.value;
        saveUI();
        render();
      });
    }

    if (elFlipBtn) elFlipBtn.addEventListener('click', flip);
    if (elFlashcard) {
      elFlashcard.addEventListener('click', function (e) {
        // 「もう一度きく」を押したときはめくらない
        if (e.target.closest && e.target.closest('.card-play')) return;
        if (!state.flipped) flip();
      });
    }
    if (elAgain) elAgain.addEventListener('click', function () { answer(1); });
    if (elGood) elGood.addEventListener('click', function () { answer(3); });
    if (elEasy) elEasy.addEventListener('click', function () { answer(4); });

    if (elPlayBtn) elPlayBtn.addEventListener('click', function () { playAudio(1); });
    if (elSpeakBtn) elSpeakBtn.addEventListener('click', function () { playAudio(1); });
    if (elSlowBtn) elSlowBtn.addEventListener('click', function () { playAudio(SLOW_RATE); });
    if (elStarBtn) elStarBtn.addEventListener('click', toggleStar);
    if (elEditBtn) {
      elEditBtn.addEventListener('click', function () {
        if (state.current) openCardDialog(state.current.itemId);
      });
    }

    if (elAddBtn) elAddBtn.addEventListener('click', function () { openCardDialog(null); });
    if (elSaveBtn) elSaveBtn.addEventListener('click', submitCard);
    if (elCancelBtn) {
      elCancelBtn.addEventListener('click', function () {
        closeCardDialog();
        render();
      });
    }
    if (elPhotoBtn) {
      elPhotoBtn.addEventListener('click', function () {
        if (elPhotoFile) elPhotoFile.click();
      });
    }
    if (elPhotoFile) {
      elPhotoFile.addEventListener('change', function () {
        var f = elPhotoFile.files && elPhotoFile.files[0];
        elPhotoFile.value = '';        // 同じ写真を選び直せるように
        if (f) takePhoto(f);
      });
    }
    if (elPhotoClear) {
      elPhotoClear.addEventListener('click', function () {
        dropPhotoIfUnused(state.editingImg, state.editingImgWas);
        state.editingImg = '';
        renderPhotoField();
        photoStatus('');
      });
    }
    // 貼り付けでも入れられるようにする（MacBook では選ぶより速い）
    if (elDialog) {
      elDialog.addEventListener('paste', function (e) {
        var items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        for (var i = 0; i < items.length; i++) {
          if (items[i].kind !== 'file') continue;
          var f = items[i].getAsFile();
          if (f && /^image\//.test(str(f.type))) { e.preventDefault(); takePhoto(f); return; }
        }
      });
    }
    if (elDeleteBtn) {
      elDeleteBtn.addEventListener('click', function () {
        if (state.editingId) deleteCard(state.editingId);
      });
    }
    bindEnterToSave(elFieldEn);
    bindEnterToSave(elFieldJa);
    bindEnterToSave(elFieldExEn);
    bindEnterToSave(elFieldExJa);
    bindEnterToSave(elFieldNote);

    if (elNewDeckBtn) elNewDeckBtn.addEventListener('click', createDeck);
    if (elNewDeckInput) {
      elNewDeckInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); createDeck(); }
      });
    }

    if (elListBtn) {
      elListBtn.addEventListener('click', function () {
        state.listQuery = '';
        if (elListSearch) elListSearch.value = '';
        renderList();
        openDialog(elListDialog);
      });
    }
    if (elListSearch) {
      elListSearch.addEventListener('input', function () {
        state.listQuery = trim(elListSearch.value);
        renderList();
      });
    }
    if (elListClose) {
      elListClose.addEventListener('click', function () {
        closeDialog(elListDialog);
        render();
      });
    }

    if (elSettingsBtn) {
      elSettingsBtn.addEventListener('click', function () {
        if (elResetStatus) elResetStatus.textContent = '';
        renderSettings();
        openDialog(elSettingsDialog);
      });
    }
    if (elSettingsClose) {
      elSettingsClose.addEventListener('click', function () {
        closeDialog(elSettingsDialog);
        render();
      });
    }
    if (elFaceL) {
      elFaceL.addEventListener('change', function () {
        state.ui.faces.l = !!elFaceL.checked;
        saveUI();
      });
    }
    if (elFaceS) {
      elFaceS.addEventListener('change', function () {
        state.ui.faces.s = !!elFaceS.checked;
        saveUI();
      });
    }
    if (elAutoSpeak) {
      elAutoSpeak.addEventListener('change', function () {
        state.ui.autoSpeak = !!elAutoSpeak.checked;
        saveUI();
      });
    }
    if (elNewPerDay) {
      elNewPerDay.addEventListener('input', function () {
        state.ui.newPerDay = Math.max(0, Number(elNewPerDay.value) || 0);
        if (elNewPerDayOut) elNewPerDayOut.textContent = state.ui.newPerDay + ' 枚';
        saveUI();
      });
    }
    if (elRetention) {
      elRetention.addEventListener('input', function () {
        var pct = Math.min(95, Math.max(80, Number(elRetention.value) || 90));
        state.ui.retention = pct / 100;
        if (elRetentionOut) elRetentionOut.textContent = pct + '%';
        saveUI();
      });
    }
    if (elResetBtn) elResetBtn.addEventListener('click', resetProgress);

    document.addEventListener('keydown', onKeyDown);
  }

  function bindEnterToSave(input) {
    if (!input) return;
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submitCard(); }
    });
  }

  function createDeck() {
    var name = trim(elNewDeckInput && elNewDeckInput.value);
    if (!name) {
      if (elDialogStatus) elDialogStatus.textContent = 'セットの名前を入れてください。';
      return;
    }
    var deck = { id: makeId('deck'), name: name, created: Date.now() };
    state.decks.push(deck);
    state.deckId = deck.id;
    saveDecks(); saveUI();
    if (elNewDeckInput) elNewDeckInput.value = '';
    renderDeckSelect();
    if (elDialogStatus) elDialogStatus.textContent = '「' + name + '」を作りました。ここに足していけます。';
  }

  /* ============================================================
   * 17. 起動
   * ========================================================== */

  function loadAll() {
    state.decks = sanitizeDecks(readJSON(LS_DECKS));
    state.items = sanitizeItems(readJSON(LS_ITEMS));
    state.srs = sanitizeSrs(readJSON(LS_SRS));
    state.stars = sanitizeStars(readJSON(LS_STARS));
    state.day = sanitizeDay(readJSON(LS_DAY));

    var ui = sanitizeUI(readJSON(LS_UI));
    state.ui = ui;
    state.deckId = findDeck(ui.deckId) ? ui.deckId : '';
  }

  function init() {
    var port = speechPort();
    state.speechOK = !!(port && port.supported());

    loadAll();
    bindEvents();
    renderSettings();

    // 開いているのがカードなら、この場で作る。ほかのモードなら開いたときに作る
    if (docEl.getAttribute('data-mode') === 'cards') onShow();
    else renderDeckSelect();
  }

  /** カードの画面を開いたときに呼ばれる（paraphrase.js の setMode から） */
  function onShow() {
    if (!state.started) {
      state.started = true;
      // 読み上げの有無は声が届いてから確かめ直す（起動直後は false のことがある）
      var port = speechPort();
      state.speechOK = !!(port && port.supported());
    }
    state.day = sanitizeDay(state.day);
    render();
  }

  /**
   * localStorage を読み直して作り直す（同期で中身が入れ替わったとき用）。
   * 同期は裏で走る。めくっている最中に答えが消えないよう、
   * いま出している 1 枚がまだ在ればそのまま残す。
   */
  function reloadFromStorage() {
    var keep = state.current;
    var wasFlipped = state.flipped;

    loadAll();
    renderDeckSelect();
    state.queue = buildQueue();

    if (keep && findItem(keep.itemId)) {
      // いま出していた 1 枚は予定から外し、手元に残す
      for (var i = state.queue.length - 1; i >= 0; i--) {
        if (state.queue[i].itemId === keep.itemId && state.queue[i].face === keep.face) {
          state.queue.splice(i, 1);
        }
      }
      state.current = keep;
      if (elStage) elStage.hidden = false;
      if (elEmpty) elEmpty.hidden = true;
      renderCard();
      if (wasFlipped) flip();
      renderProgress();
      return;
    }

    state.current = null;
    next();
  }

  window.SUNKAN_CARDS = {
    /** カードの画面を開いたとき（paraphrase.js の setMode から） */
    onShow: onShow,

    /** 同期が中身を入れ替えたあとに呼ぶ */
    reload: reloadFromStorage,

    /** 取り込みの「入れ先」を作るための一覧。`[{id, name, count}]` */
    decks: function () {
      var out = [];
      for (var i = 0; i < state.decks.length; i++) {
        out.push({
          id: state.decks[i].id,
          name: state.decks[i].name,
          count: itemsOfDeck(state.decks[i].id).length
        });
      }
      return out;
    },

    /** いま開いているセットの id（'' は「すべてのセット」） */
    currentDeckId: function () { return state.deckId; },

    /**
     * 取り込みから使う口。セットを名前で探し（無ければ作って開き）、カードを足す。
     * items は {en, ja, exEn, exJa, note} の配列。
     * 同じ (en, exEn) の組がすでにあるものは飛ばす。
     * @returns {{added:number, skipped:number, deckId:string, deckName:string}}
     */
    addCards: function (deckName, items, deckId) {
      // 入れ先が id で指定されていればそれに足す（画面で選んだセット）。
      // 指定が無ければ名前で探し、無ければ作る。
      var deck = trim(deckId) ? findDeck(trim(deckId)) : null;

      if (!deck) {
        var name = trim(deckName) || '取り込んだカード';
        for (var i = 0; i < state.decks.length; i++) {
          if (state.decks[i].name.toLowerCase() === name.toLowerCase()) { deck = state.decks[i]; break; }
        }
        if (!deck) {
          deck = { id: makeId('deck'), name: name, created: Date.now() };
          state.decks.push(deck);
          saveDecks();
        }
      }

      // すでに入っているものの見分けに使う鍵
      var seen = {};
      for (var j = 0; j < state.items.length; j++) {
        if (state.items[j].deckId !== deck.id) continue;
        seen[dupKey(state.items[j].en, state.items[j].exEn)] = 1;
      }

      var added = 0, skipped = 0;
      var list = items || [];
      for (var k = 0; k < list.length; k++) {
        var raw = list[k] || {};
        var en = trim(raw.en);
        var ja = trim(raw.ja);
        var exEn = trim(raw.exEn);
        var exJa = trim(raw.exJa);
        if (!en || (!ja && !exJa)) { skipped++; continue; }

        var key = dupKey(en, exEn);
        if (seen[key]) { skipped++; continue; }
        seen[key] = 1;

        state.items.push({
          id: makeId('card'),
          deckId: deck.id,
          en: en, ja: ja, exEn: exEn, exJa: exJa, note: trim(raw.note),
          created: Date.now() + k    // 取り込んだ順を保つ
        });
        added++;
      }

      if (added) saveItems();
      state.deckId = deck.id;
      saveUI();
      render();

      return { added: added, skipped: skipped, deckId: deck.id, deckName: deck.name };
    },

    /** 取り込みの結果を上の帯に出す */
    flash: flashStatus
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
