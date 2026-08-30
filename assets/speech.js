/* 瞬間英作文 — 読み上げ（Web Speech API）
 *
 * app.js と paraphrase.js の共通の口。window.SUNKAN_SPEECH から使う。
 * この API は端末ごとの癖が強いので、面倒はぜんぶここに閉じ込める。
 *
 *  - 声は遅れて届く（iOS/Safari は初回 getVoices() が空）。届く前に押されても、
 *    lang だけ指定して喋れるので待たせない。声は届き次第、次の発話から使う。
 *  - iOS は「タップから同期で呼ばれた speak()」でないと鳴らない。だから
 *    何も鳴っていないときは setTimeout を挟まずその場で speak() する。
 *    最初のタップでは無音の発話を 1 回流して音を解錠しておく。
 *  - cancel() の直後の speak() は落ちることがある。連打されたら「最後の 1 つ」を
 *    覚えておき、キューが空くのを見てから流す。
 *  - 長い文の途中で止まる／勝手に paused になる実装がある。文を切って順に流し、
 *    鳴っている間だけ様子を見て resume() する（鳴り終わったら止める）。
 *  - 黙って失敗しない。始まらなかった・落ちたときは理由を onProblem へ流す。
 */
(function () {
  'use strict';

  var synth = null;
  var Utter = null;
  var supported = false;

  try {
    if (window.speechSynthesis && typeof window.SpeechSynthesisUtterance === 'function' &&
        typeof window.speechSynthesis.speak === 'function') {
      synth = window.speechSynthesis;
      Utter = window.SpeechSynthesisUtterance;
      supported = true;
    }
  } catch (e) {
    supported = false;
  }

  var MAX_CHUNK = 160;    // 1 発話に入れる字数の上限（長すぎると途中で止まる実装がある）
  var WAIT_STEP = 40;     // キューが空くのを見に行く間隔（ミリ秒）
  var WAIT_MAX = 1200;    // それでも空かないときは諦めて流す
  var START_GRACE = 700;  // 「speak したのに始まらない」を見つけるまでの猶予
  var ALIVE_STEP = 4000;  // 鳴っている間だけ回す見張りの間隔
  var SILENT_MAX = 1500;  // 解錠用の無音発話を待つ上限

  var LS_VOICE = 'sunkan:voice';   // 選んだ声。端末ごとに入っている声が違うので同期しない

  var voice = null;         // 選んだ声。無ければ null（lang だけで喋る）
  var wantVoice = '';       // 利用者が選んだ声の id。声が届く前でも覚えておく
  var voicesReady = false;
  var unlocked = false;     // 一度でも実際に音が出たか
  var silentPending = false;// 解錠用の無音発話がまだ流れているか
  var pending = null;       // 待たせている依頼。いちばん新しい 1 件だけ残す
  var pendingTimer = null;
  var active = null;        // いま流している依頼
  var aliveTimer = null;
  var listeners = [];
  var seq = 0;

  /* ---------- 声 ---------- */

  function loadVoices() {
    if (!supported) return false;
    var voices = [];
    try { voices = synth.getVoices() || []; } catch (e) { voices = []; }
    if (!voices.length) return false;

    var exact = null;
    var fallback = null;
    var chosen = null;
    for (var i = 0; i < voices.length; i++) {
      var lang = String(voices[i].lang || '').toLowerCase().replace('_', '-');
      // 選んだ声が入っていれば、それがいちばん強い
      if (!chosen && wantVoice && voiceId(voices[i]) === wantVoice) chosen = voices[i];
      if (!exact && lang === 'en-us') exact = voices[i];
      if (!fallback && lang.indexOf('en') === 0) fallback = voices[i];
    }
    voice = chosen || exact || fallback || null;
    voicesReady = true;
    return true;
  }

  /** 声を見分ける id。voiceURI が無い実装のために名前と言語で代わりを作る */
  function voiceId(v) {
    if (!v) return '';
    return String(v.voiceURI || (String(v.name || '') + '|' + String(v.lang || '')));
  }

  /** 英語の声だけ、選べる形で返す */
  function listVoices() {
    if (!supported) return [];
    var raw = [];
    try { raw = synth.getVoices() || []; } catch (e) { raw = []; }
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var lang = String(raw[i].lang || '').toLowerCase().replace('_', '-');
      if (lang.indexOf('en') !== 0) continue;   // 読むのは英文だけ
      out.push({
        id: voiceId(raw[i]),
        name: String(raw[i].name || ''),
        lang: String(raw[i].lang || ''),
        current: voice ? voiceId(raw[i]) === voiceId(voice) : false
      });
    }
    return out;
  }

  /** 声を選ぶ。空文字なら「おまかせ」に戻す */
  function setVoice(id) {
    wantVoice = String(id || '');
    try {
      if (wantVoice) window.localStorage.setItem(LS_VOICE, wantVoice);
      else window.localStorage.removeItem(LS_VOICE);
    } catch (e) { /* 保存できなくてもその場では効かせる */ }
    loadVoices();
    return voice ? voiceId(voice) : '';
  }

  /** 声は遅れて届く。イベントで拾いつつ、来ない実装のために数回だけ見に行く（回しっぱなしにはしない） */
  function watchVoices() {
    if (!supported) return;
    loadVoices();

    var onChanged = function () { loadVoices(); };
    if (typeof synth.addEventListener === 'function') {
      // 代入だと他の場所に上書きされる。必ず addEventListener で足す。
      try { synth.addEventListener('voiceschanged', onChanged); } catch (e) { /* 無視 */ }
    } else if (!synth.onvoiceschanged) {
      try { synth.onvoiceschanged = onChanged; } catch (e) { /* 無視 */ }
    }

    var delays = [100, 300, 700, 1500, 3000];
    var idx = 0;
    var tick = function () {
      if (voicesReady || idx >= delays.length) return;   // 見つかったら（諦めたら）そこで終わり
      var wait = delays[idx++];
      window.setTimeout(function () {
        if (!loadVoices()) tick();
      }, wait);
    };
    if (!voicesReady) tick();
  }

  /* ---------- 文を切る ---------- */

  function normalize(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').replace(/^ | $/g, '');
  }

  function lastBreak(s) {
    var i;
    for (i = s.length - 1; i > 20; i--) {
      var c = s.charAt(i);
      if (c === '.' || c === '!' || c === '?' || c === '…' || c === '。' || c === '！' || c === '？') return i + 1;
    }
    for (i = s.length - 1; i > 20; i--) {
      var c2 = s.charAt(i);
      if (c2 === ',' || c2 === ';' || c2 === ':' || c2 === '、') return i + 1;
    }
    for (i = s.length - 1; i > 20; i--) {
      if (s.charAt(i) === ' ') return i;
    }
    return -1;
  }

  function splitText(text) {
    var out = [];
    var rest = text;
    while (rest.length > MAX_CHUNK) {
      var cut = lastBreak(rest.slice(0, MAX_CHUNK + 1));
      if (cut <= 0) cut = MAX_CHUNK;
      var head = normalize(rest.slice(0, cut));
      if (head) out.push(head);
      rest = normalize(rest.slice(cut));
      if (!rest) break;
    }
    if (rest) out.push(rest);
    return out.length ? out : [text];
  }

  /* ---------- 知らせ ---------- */

  function report(reason, message, req) {
    var info = { reason: reason, message: message };
    if (req && req.onerror) {
      try { req.onerror(info); } catch (e) { /* 無視 */ }
    }
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](info); } catch (e2) { /* 無視 */ }
    }
  }

  /* ---------- 見張り（鳴っている間だけ） ---------- */

  function startKeepAlive() {
    if (aliveTimer) return;
    aliveTimer = window.setInterval(function () {
      var busy = false;
      try { busy = !!(synth.speaking || synth.pending); } catch (e) { busy = false; }
      if (!busy) { stopKeepAlive(); return; }   // 鳴り終わったら自分で止まる
      try { if (synth.paused) synth.resume(); } catch (e2) { stopKeepAlive(); }
    }, ALIVE_STEP);
  }

  function stopKeepAlive() {
    if (aliveTimer) {
      window.clearInterval(aliveTimer);
      aliveTimer = null;
    }
  }

  /* ---------- 発話 ---------- */

  function clearPendingTimer() {
    if (pendingTimer) {
      window.clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  }

  function dropActive() {
    if (active) {
      if (active.watchdog) window.clearTimeout(active.watchdog);
      active.done = true;
      active = null;
    }
    stopKeepAlive();
  }

  function speakChunks(run) {
    var list = run.req.chunks;
    try {
      for (var i = 0; i < list.length; i++) {
        var u = new Utter(list[i]);
        u.lang = run.req.lang;
        u.rate = run.req.rate;
        // 声がまだ届いていなくても lang だけで喋れる。待たせない。
        if (voice) { try { u.voice = voice; } catch (e) { /* 無視 */ } }
        if (i === 0) u.onstart = function () { onStart(run); };
        if (i === list.length - 1) u.onend = function () { onEnd(run); };
        u.onerror = function (ev) { onError(run, ev); };
        synth.speak(u);
      }
    } catch (e2) {
      run.done = true;
      if (active === run) active = null;
      report('error', '読み上げを始められませんでした。', run.req);
      return;
    }
    run.watchdog = window.setTimeout(function () { checkStarted(run); }, START_GRACE);
  }

  function onStart(run) {
    if (active !== run) return;
    run.started = true;
    unlocked = true;            // 実際に音が出た。無音の解錠はもう要らない
    if (run.watchdog) { window.clearTimeout(run.watchdog); run.watchdog = null; }
    startKeepAlive();
  }

  function onEnd(run) {
    if (active !== run) return;
    run.done = true;
    if (run.watchdog) { window.clearTimeout(run.watchdog); run.watchdog = null; }
    active = null;
    stopKeepAlive();
  }

  function onError(run, ev) {
    var code = '';
    try { code = (ev && ev.error) ? String(ev.error) : ''; } catch (e) { code = ''; }
    // こちらから止めたぶんは失敗ではない
    if (code === 'canceled' || code === 'interrupted') return;
    if (active !== run) return;
    run.done = true;
    if (run.watchdog) { window.clearTimeout(run.watchdog); run.watchdog = null; }
    active = null;
    stopKeepAlive();
    report('error', '読み上げが止まりました' + (code ? '（' + code + '）' : '') + '。', run.req);
  }

  /** speak() したのに何も始まらなかったとき。1 度だけやり直し、それでも駄目なら黙らずに言う */
  function checkStarted(run) {
    run.watchdog = null;
    if (active !== run || run.started || run.done) return;

    var busy = false;
    try { busy = !!(synth.speaking || synth.pending); } catch (e) { busy = false; }
    if (busy) {                     // onstart を出さない実装もある。鳴っているならよしとする
      unlocked = true;
      startKeepAlive();
      return;
    }
    if (!run.retried) {
      // 落ちたのは「cancel() の直後の speak()」だから、やり直しでまた cancel() しては
      // 同じ穴に落ちる。ここは鳴っていないと確かめた後なので、そのまま流し直す。
      run.retried = true;
      speakChunks(run);
      return;
    }
    run.done = true;
    active = null;
    stopKeepAlive();
    report('silent', '音が出ませんでした。画面をもう一度タップするか、消音スイッチと音量を確かめてください。', run.req);
  }

  function flush() {
    var req = pending;
    pending = null;
    clearPendingTimer();
    if (!req) return;
    silentPending = false;
    dropActive();
    active = { req: req, started: false, done: false, retried: false, watchdog: null };
    speakChunks(active);
  }

  /** キューが空くのを見てから流す。cancel() の直後に speak() すると落ちるため */
  function waitAndFlush(elapsed) {
    clearPendingTimer();
    pendingTimer = window.setTimeout(function () {
      pendingTimer = null;
      if (!pending) return;
      var busy = false;
      try { busy = !!(synth.speaking || synth.pending); } catch (e) { busy = false; }
      if (!busy || elapsed >= WAIT_MAX) { flush(); return; }
      waitAndFlush(elapsed + WAIT_STEP);
    }, WAIT_STEP);
  }

  function speak(text, opts) {
    if (!supported) {
      report('unsupported', 'この端末では読み上げが使えません。', null);
      return false;
    }
    var clean = normalize(text);
    if (!clean) return false;

    opts = opts || {};
    pending = {
      id: ++seq,
      text: clean,
      chunks: splitText(clean),
      lang: opts.lang || 'en-US',
      rate: (typeof opts.rate === 'number' && opts.rate > 0) ? opts.rate : 1,
      onerror: (typeof opts.onerror === 'function') ? opts.onerror : null
    };
    dropActive();

    var busy = false;
    try { busy = !!(synth.speaking || synth.pending); } catch (e) { busy = false; }

    if (busy && !silentPending) {
      // 鳴っている最中。止めてから、空くのを見て流す（最後の 1 つだけ鳴る）
      try { synth.cancel(); } catch (e2) { /* 無視 */ }
      waitAndFlush(0);
    } else {
      // タップから同期で呼ばれる道。ここで待つと iOS は音を出さない
      flush();
    }
    return true;
  }

  function cancel() {
    pending = null;
    clearPendingTimer();
    dropActive();
    if (!supported) return;
    try { synth.cancel(); } catch (e) { /* 無視 */ }
  }

  function speaking() {
    if (!supported) return false;
    if (pending) return true;
    try { return !!(synth.speaking || synth.pending); } catch (e) { return false; }
  }

  /* ---------- 音の解錠（最初のタップ） ---------- */

  function unlock() {
    if (!supported || unlocked) return;
    try {
      if (synth.speaking || synth.pending) { synth.resume(); return; }
      var u = new Utter(' ');
      u.volume = 0;
      u.lang = 'en-US';
      u.onend = function () { silentPending = false; };
      u.onerror = function () { silentPending = false; };
      silentPending = true;
      synth.speak(u);
      // 無音を読み飛ばす実装だと onend が来ない。いつまでも譲らないよう自分で外す
      window.setTimeout(function () { silentPending = false; }, SILENT_MAX);
    } catch (e) {
      silentPending = false;
    }
  }

  function onGesture() {
    if (!unlocked) {
      unlock();
      return;
    }
    // 勝手に paused になったまま戻らないことがある。触られたついでに起こす
    try {
      if (synth.paused && (synth.speaking || synth.pending)) synth.resume();
    } catch (e) { /* 無視 */ }
  }

  function armGestures() {
    if (!supported || !document.addEventListener) return;
    var names = ['pointerdown', 'touchend', 'mousedown', 'keydown'];
    for (var i = 0; i < names.length; i++) {
      try { document.addEventListener(names[i], onGesture, true); } catch (e) { /* 無視 */ }
    }
  }

  /* ---------- 起動 ---------- */

  if (supported) {
    try { wantVoice = window.localStorage.getItem(LS_VOICE) || ''; } catch (e) { wantVoice = ''; }
    // 前のページの発話が残っていることがある（再読み込み直後に喋らない不具合の元）
    try { synth.cancel(); } catch (e) { /* 無視 */ }
    watchVoices();
    armGestures();
    try {
      window.addEventListener('pagehide', function () { cancel(); });
    } catch (e2) { /* 無視 */ }
  }

  window.SUNKAN_SPEECH = {
    /** 読み上げが使えるか */
    supported: function () { return supported; },
    /** 英語を読み上げる。前の発話は止めて、最後に頼まれた 1 つだけ鳴らす */
    speak: speak,
    /** 鳴っているものを止める */
    cancel: cancel,
    /** 鳴っている / 鳴らす予定があるか */
    speaking: speaking,
    /** タップの中から呼ぶと無音の発話で音を解錠する（画面のどこを触っても自動で拾う） */
    unlock: unlock,
    /** 声が使えるようになっているか（届く前でも lang 指定で喋れる） */
    ready: function () { return voicesReady; },
    /** 使っている声の名前。無ければ空文字 */
    voiceName: function () { return voice ? String(voice.name || '') : ''; },
    /** 使っている声の言語。無ければ空文字 */
    voiceLang: function () { return voice ? String(voice.lang || '') : ''; },
    /** 選べる英語の声。[{id, name, lang, current}] */
    voices: listVoices,
    /** 声を選ぶ（空文字でおまかせに戻す）。選ばれた声の id を返す */
    setVoice: setVoice,
    /** いま選んである声の id（おまかせなら空文字） */
    chosenVoice: function () { return wantVoice; },
    /** 読み上げが失敗したときの理由を受け取る。戻り値を呼ぶと外れる */
    onProblem: function (fn) {
      if (typeof fn !== 'function') return function () {};
      listeners.push(fn);
      return function () {
        for (var i = 0; i < listeners.length; i++) {
          if (listeners[i] === fn) { listeners.splice(i, 1); return; }
        }
      };
    }
  };
})();
