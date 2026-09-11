/* Duo — 忘却曲線（FSRS-5）
 *
 * 「いつ出すか」だけを決める。DOM も localStorage も触らない純粋な計算。
 * cards.js から window.SUNKAN_SRS 越しに呼ぶ。
 *
 * なぜ SM-2（1987 年の式）ではなく FSRS か:
 *   SM-2 は「正解したら間隔に固定の倍率を掛ける」だけで、忘れかけているかどうかを見ていない。
 *   FSRS は記憶を 3 つの数（安定度 S・難しさ D・思い出せる確率 R）で持ち、
 *   R が狙った値（既定 0.9）まで落ちる日を計算して出す。
 *   Anki が 2023 年から既定にしていて、同じ定着率を 2〜3 割少ない復習で達成する。
 *
 * 用語（この先ずっと同じ意味で使う）:
 *   S … 安定度。R が 0.9 に落ちるまでの日数。大きいほど忘れにくい
 *   D … 難しさ 1〜10。大きいほど覚えにくい札
 *   R … いま思い出せる確率 0〜1。時間とともに落ちる
 *   G … 押したボタン 1=もう一度 2=むずかしい 3=できた 4=かんたん
 *
 * 画面のボタンは 3 つ（もう一度 / できた / かんたん = 1 / 3 / 4）。
 * 2（むずかしい）は使わないが、式からは外さない。外すと D の動きが変わる。
 */
'use strict';

(function () {

  /* ============================================================
   * 1. 定数
   * ========================================================== */

  /** FSRS-5 の既定パラメータ（19 個）。
   *  本家が 7 億件超の復習記録から学習した値。自分の記録に合わせた最適化は、
   *  復習が 1000 件ほど溜まってからの話なので、まずはこのまま使う。 */
  var DEFAULT_W = [
    0.40255, 1.18385, 3.173, 15.69105,
    7.1949, 0.5345, 1.4604, 0.0046,
    1.54575, 0.1192, 1.01925, 1.9395,
    0.11, 0.29605, 2.2698, 0.2315,
    2.9898, 0.51655, 0.6621
  ];

  /** 忘却曲線の形。R(t) = (1 + FACTOR * t/S) ^ DECAY */
  var DECAY = -0.5;
  var FACTOR = Math.pow(0.9, 1 / DECAY) - 1;   // = 19/81 ≒ 0.2345679

  /** 狙う定着率。0.9 なら「次に会うとき 9 割は思い出せる」ように間隔を決める */
  var DEFAULT_RETENTION = 0.9;

  /** 間隔の上限・下限（日） */
  var MIN_INTERVAL = 1;
  var MAX_INTERVAL = 365 * 10;

  /** D の範囲 */
  var MIN_D = 1;
  var MAX_D = 10;

  /** 覚えたての札を、今日のうちに何分後へ置き直すか（分）。
   *  まだ日をまたいでいない札は FSRS の日単位の式に乗らないので、ここは素朴な段数で持つ。
   *  最後の段を越えたら日をまたぐ予定（review）へ卒業する。 */
  var LEARN_STEPS = [1, 10];      // 初めて覚えるとき
  var RELEARN_STEPS = [10];       // 忘れて覚え直すとき

  function stepsFor(state) {
    return state === 'relearning' ? RELEARN_STEPS : LEARN_STEPS;
  }

  var DAY_MS = 86400000;

  /* ============================================================
   * 2. 小物
   * ========================================================== */

  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

  function num(v, fallback) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    return (isFinite(n)) ? n : fallback;
  }

  /** 押されたボタンを 1〜4 に均す。読めない値は「できた」扱いにしない（甘くしない）ため 1 に寄せる */
  function grade(g) {
    var n = Math.round(num(g, 1));
    return clamp(n, 1, 4);
  }

  function w(params, i) { return num(params && params[i], DEFAULT_W[i]); }

  /* ============================================================
   * 3. 忘却曲線そのもの
   * ========================================================== */

  /**
   * t 日たったときに思い出せる確率。
   * @param {number} elapsedDays 前回からの日数（0 以上）
   * @param {number} stability   安定度 S
   * @returns {number} 0〜1
   */
  function retrievability(elapsedDays, stability) {
    var t = Math.max(0, num(elapsedDays, 0));
    var s = Math.max(0.01, num(stability, 0.01));
    return Math.pow(1 + FACTOR * t / s, DECAY);
  }

  /**
   * R が retention まで落ちる日数。これが次に出す間隔になる。
   */
  function intervalFor(stability, retention) {
    var s = Math.max(0.01, num(stability, 0.01));
    var r = clamp(num(retention, DEFAULT_RETENTION), 0.7, 0.99);
    var days = (s / FACTOR) * (Math.pow(r, 1 / DECAY) - 1);
    return clamp(Math.round(days), MIN_INTERVAL, MAX_INTERVAL);
  }

  /* ============================================================
   * 4. S と D の更新
   * ========================================================== */

  /** 初めて答えたときの S */
  function initialStability(params, g) {
    return Math.max(0.1, w(params, g - 1));
  }

  /** 初めて答えたときの D */
  function initialDifficulty(params, g) {
    var d = w(params, 4) - Math.exp(w(params, 5) * (g - 1)) + 1;
    return clamp(d, MIN_D, MAX_D);
  }

  /** D の更新。できなかったほど上がり、少しずつ真ん中へ戻る */
  function nextDifficulty(params, d, g) {
    var delta = -w(params, 6) * (g - 3);
    // 線形の減衰。D が 10 に近いほど上がりにくく、1 に近いほど下がりにくい
    var damped = d + delta * (10 - d) / 9;
    // 平均への回帰。放っておくと全部の札が「むずかしい」に張り付くのを防ぐ
    var reverted = w(params, 7) * initialDifficulty(params, 4) + (1 - w(params, 7)) * damped;
    return clamp(reverted, MIN_D, MAX_D);
  }

  /** 思い出せたときの S。忘れかけ（R が低い）ほど大きく伸びる＝ぎりぎりで復習するほど効く */
  function stabilityAfterRecall(params, d, s, r, g) {
    var hardPenalty = (g === 2) ? w(params, 15) : 1;
    var easyBonus = (g === 4) ? w(params, 16) : 1;
    var growth = 1 + Math.exp(w(params, 8))
      * (11 - d)
      * Math.pow(s, -w(params, 9))
      * (Math.exp(w(params, 10) * (1 - r)) - 1)
      * hardPenalty
      * easyBonus;
    return clamp(s * growth, 0.01, MAX_INTERVAL);
  }

  /** 忘れたときの S。FSRS-5 では元の S を超えない（忘れたのに強くなるのはおかしい） */
  function stabilityAfterForget(params, d, s, r) {
    var next = w(params, 11)
      * Math.pow(d, -w(params, 12))
      * (Math.pow(s + 1, w(params, 13)) - 1)
      * Math.exp(w(params, 14) * (1 - r));
    return clamp(Math.min(next, s), 0.01, MAX_INTERVAL);
  }

  /** 同じ日にもう一度答えたときの S。日をまたいでいないので上の式は使えない */
  function stabilitySameDay(params, s, g) {
    var next = s * Math.exp(w(params, 17) * (g - 3 + w(params, 18)));
    return clamp(next, 0.01, MAX_INTERVAL);
  }

  /* ============================================================
   * 5. 1 枚ぶんの記憶の状態
   * ========================================================== */

  /**
   * まだ一度も出していない札の状態。
   * due が null なのが「新しい札」の印。
   */
  function newState() {
    return {
      s: 0,          // 安定度。0 は未学習
      d: 0,          // 難しさ。0 は未学習
      due: null,     // 次に出す時刻（ミリ秒）。null は新しい札
      last: null,    // 前に答えた時刻（ミリ秒）
      reps: 0,       // 答えた回数
      lapses: 0,     // 忘れた回数
      streak: 0,     // 連続で思い出せている回数（面の開放に使う）
      step: 0,       // 覚えたての札が、今日のうちの何段目にいるか
      state: 'new'   // 'new' | 'learning' | 'review' | 'relearning'
    };
  }

  /** 読めない中身を newState の形に均す。保存データは何が入っているか分からない */
  function sanitize(raw) {
    var base = newState();
    if (!raw || typeof raw !== 'object') return base;
    base.s = clamp(num(raw.s, 0), 0, MAX_INTERVAL);
    base.d = raw.d ? clamp(num(raw.d, 0), MIN_D, MAX_D) : 0;
    base.due = (typeof raw.due === 'number' && isFinite(raw.due)) ? raw.due : null;
    base.last = (typeof raw.last === 'number' && isFinite(raw.last)) ? raw.last : null;
    base.reps = Math.max(0, Math.round(num(raw.reps, 0)));
    base.lapses = Math.max(0, Math.round(num(raw.lapses, 0)));
    base.streak = Math.max(0, Math.round(num(raw.streak, 0)));
    base.step = Math.max(0, Math.round(num(raw.step, 0)));
    base.state = ({ 'new': 1, learning: 1, review: 1, relearning: 1 })[raw.state] ? raw.state : 'new';
    // 未学習なのに due だけ入っている、のような半端な組み合わせは新しい札に戻す
    if (base.state === 'new' || base.s <= 0) {
      base.s = 0; base.d = 0; base.due = null; base.step = 0; base.state = 'new';
    }
    return base;
  }

  /* ============================================================
   * 6. 答えを受けて次の予定を出す
   * ========================================================== */

  /**
   * 1 枚に答えたあとの新しい状態を返す。元の state は書き換えない。
   *
   * @param {object} state    sanitize 済みの状態
   * @param {number} g        1=もう一度 2=むずかしい 3=できた 4=かんたん
   * @param {object} [opts]   { now, retention, params }
   * @returns {object} 新しい状態（+ intervalDays に決まった間隔が入る）
   */
  function review(state, g, opts) {
    opts = opts || {};
    var now = num(opts.now, Date.now());
    var retention = num(opts.retention, DEFAULT_RETENTION);
    var params = opts.params || DEFAULT_W;

    var cur = sanitize(state);
    g = grade(g);

    var next = {
      s: cur.s, d: cur.d, due: cur.due, last: now,
      reps: cur.reps + 1,
      lapses: cur.lapses,
      streak: cur.streak,
      step: cur.step,
      state: cur.state
    };

    /** 今日のうちの何段目かを決めて、日をまたぐか今日もう一度かを返す */
    function placeInSteps(stateName, nextStep) {
      var steps = stepsFor(stateName);
      if (nextStep >= steps.length) {      // 段を越えた → 卒業
        next.state = 'review';
        next.step = 0;
        var days = intervalFor(next.s, retention);
        next.due = now + days * DAY_MS;
        next.intervalDays = days;
      } else {
        next.state = stateName;
        next.step = nextStep;
        next.due = now + steps[nextStep] * 60000;
        next.intervalDays = 0;
      }
      return next;
    }

    // --- 初めて出す札 ---
    if (cur.state === 'new' || cur.s <= 0) {
      next.s = initialStability(params, g);
      next.d = initialDifficulty(params, g);
      next.streak = (g === 1) ? 0 : 1;

      // かんたん … 今日はもう出さず、いきなり日をまたぐ
      if (g === 4) {
        next.state = 'review';
        next.step = 0;
        var d0 = intervalFor(next.s, retention);
        next.due = now + d0 * DAY_MS;
        next.intervalDays = d0;
        return next;
      }
      // もう一度 → 1 段目から。できた／むずかしい → 2 段目から
      return placeInSteps('learning', g === 1 ? 0 : 1);
    }

    // --- 2 回目以降 ---
    var elapsedMs = (cur.last === null) ? 0 : Math.max(0, now - cur.last);
    var elapsedDays = elapsedMs / DAY_MS;
    var r = retrievability(elapsedDays, cur.s);

    // 同じ日のうちの答え直し。日単位の式に乗せると間隔が跳ねるので別扱い
    var sameDay = elapsedDays < 1 && (cur.state === 'learning' || cur.state === 'relearning');

    next.d = nextDifficulty(params, cur.d || initialDifficulty(params, 3), g);

    // --- 忘れた ---
    if (g === 1) {
      next.s = stabilityAfterForget(params, next.d, cur.s, r);
      next.lapses = cur.lapses + 1;
      next.streak = 0;
      return placeInSteps('relearning', 0);
    }

    next.s = sameDay
      ? stabilitySameDay(params, cur.s, g)
      : stabilityAfterRecall(params, next.d, cur.s, r, g);
    next.streak = cur.streak + 1;

    // --- 覚えたて／覚え直しの途中 ---
    if (cur.state === 'learning' || cur.state === 'relearning') {
      if (g === 4) {                       // かんたん … 残りの段を飛ばして卒業
        return placeInSteps(cur.state, stepsFor(cur.state).length);
      }
      if (g === 2) {                       // むずかしい … 同じ段でもう一度
        return placeInSteps(cur.state, cur.step);
      }
      return placeInSteps(cur.state, cur.step + 1);   // できた … 次の段へ
    }

    // --- もう日をまたぐ予定に乗っている札 ---
    next.state = 'review';
    next.step = 0;
    var days = intervalFor(next.s, retention);
    next.due = now + days * DAY_MS;
    next.intervalDays = days;
    return next;
  }

  /* ============================================================
   * 7. 画面に出すための読み取り
   * ========================================================== */

  /** いま出す番が来ているか */
  function isDue(state, now) {
    var cur = sanitize(state);
    if (cur.state === 'new' || cur.due === null) return true;
    return cur.due <= num(now, Date.now());
  }

  /** まだ一度も出していない札か */
  function isNew(state) {
    return sanitize(state).state === 'new';
  }

  /** いま思い出せる確率（0〜1）。未学習は 0 */
  function recallChance(state, now) {
    var cur = sanitize(state);
    if (cur.state === 'new' || cur.s <= 0 || cur.last === null) return 0;
    var days = Math.max(0, (num(now, Date.now()) - cur.last)) / DAY_MS;
    return retrievability(days, cur.s);
  }

  /**
   * 答える前に、ボタンごとの次の間隔を先に出す（画面に「2日後」と添えるため）。
   * @returns {{1:number,2:number,3:number,4:number}} 日数。0 は「今日のうちにまた出す」
   */
  function preview(state, opts) {
    var out = {};
    for (var g = 1; g <= 4; g++) {
      out[g] = review(state, g, opts).intervalDays || 0;
    }
    return out;
  }

  /** 「2日後」「1か月後」のような短い言い方にする */
  function humanInterval(days) {
    var d = Math.round(num(days, 0));
    if (d <= 0) return '今日';
    if (d === 1) return '明日';
    if (d < 30) return d + '日後';
    if (d < 365) {
      var m = Math.round(d / 30);
      return m + 'か月後';
    }
    var y = Math.round(d / 365 * 10) / 10;
    return y + '年後';
  }

  /* ============================================================
   * 8. 外に出す口
   * ========================================================== */

  window.SUNKAN_SRS = {
    newState: newState,
    sanitize: sanitize,
    review: review,
    preview: preview,
    isDue: isDue,
    isNew: isNew,
    recallChance: recallChance,
    retrievability: retrievability,
    intervalFor: intervalFor,
    humanInterval: humanInterval,
    DEFAULT_RETENTION: DEFAULT_RETENTION,
    DEFAULT_W: DEFAULT_W
  };

})();
