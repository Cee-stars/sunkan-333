/*!
 * 文法予測 — 手がかりだけ見て、続きが「1つ」か「複数」かを先に決める。
 * 素の ES2019 ブラウザ JavaScript。モジュール・外部ライブラリ・ビルド不要。
 * app.js / phrase.js / listen.js とは状態も保存先も共有しない。
 * DOM の定義は index.html、取り決めは CONTRACT.md を参照。
 *
 * ───────────────────────────────────────────────────────────────
 * ここは **調べた結果でできている** ので、変えるときは理由も一緒に見てほしい。
 *
 * ・**形（a/an、-s そのもの）を当てさせない。** 「次に来る語の音の形を先読みする」
 *   という証拠は、9 研究室・334 名・事前登録の追試で再現されなかった
 *   （Nieuwland et al. 2018, eLife）。残っているのは意味・カテゴリ素性の予測なので、
 *   **答えさせるのは「1つ／複数」という素性**にしてある。
 *   二択のラベルを `is / are` のような形にすると、素性の予測ではなく形の照合に
 *   なってしまう。**ラベルに英語の形を出さない。**
 *
 * ・**守るのは順序で、時間ではない。** 送信するまで続きを一切開示しない。
 *   秒数で締め切らない（締め切る根拠が無い。元にした研究の 3,500ms は
 *   「正解を出しておく時間」で、推測の締め切りではなかった）。
 *
 * ・**自分の答えは、採点を押し終えるまで消さない。** 模範解答とは同時に出す。
 *   自分の誤りを思い出せないと、誤りから学ぶ利得が消えて逆に害になる
 *   （Metcalfe & Huelser 2020）。片方を消す作りにしてはいけない。
 *
 * ・**照合（自己採点とは別に「合っていたか」を押させる手続き）は足さない。**
 *   足しても効かなかった（Alzahrani 2023, N=147）。説明のほうは付ける。
 *
 * ・**予定は規則ごとに進む。例文は毎回入れ替える。** 想起練習の利得は
 *   「出した項目」にしか及ばず（未出題への一般効果 g=0.04）、
 *   同じ例文を反復するとその例文を覚えるだけになる。
 *
 * ・**三単現は「数の予測」に乗らない。** 英語は主語が動詞に先行するので、
 *   左から右に読んで動詞の形を予測する形にできない。だから
 *   「主語を見て数を決める → その帰結として動詞をタイプする」の 2 段にしてある。
 *
 * ・**ゲート（形と意味の結び）は一度通れば終わりにしない** が、
 *   **通ったあとに外しても他の規則は止めない**（止めると催促になる）。
 *
 * 効くと分かっているのは「思い出す練習」と「間隔を空けること」までで、
 * **英文法の予測練習それ自体を直接確かめた研究はまだ無い。** 盛らないこと。
 * ───────────────────────────────────────────────────────────────
 */
(function () {
  'use strict';

  /* ============================================================
   * 1. 小物（phrase.js / listen.js と同じものを自分で持つ。状態は共有しない）
   * ========================================================== */

  var docEl = document.documentElement;

  function $(id) { return document.getElementById(id); }

  function str(v) { return (v === null || v === undefined) ? '' : String(v); }
  function trim(v) { return str(v).replace(/^[﻿\s]+|\s+$/g, ''); }
  function isArray(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
  function isObject(v) { return !!v && typeof v === 'object' && !isArray(v); }

  function num(v, dflt) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    return (typeof n === 'number' && isFinite(n)) ? n : dflt;
  }

  function lsGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }

  function lsSet(key, value) {
    try { window.localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }

  function readJSON(key, dflt) {
    var raw = lsGet(key);
    if (!raw) return dflt;
    try {
      var v = JSON.parse(raw);
      return (v === null || v === undefined) ? dflt : v;
    } catch (e) { return dflt; }
  }

  function writeJSON(key, value) { return lsSet(key, JSON.stringify(value)); }

  /** 一意な id。phrase.js / listen.js と同じ作り */
  var seq = 0;
  function uid(prefix) {
    seq += 1;
    return prefix + Date.now().toString(36) + seq.toString(36);
  }

  function srsPort() {
    return (window.SUNKAN_SRS && typeof window.SUNKAN_SRS.review === 'function')
      ? window.SUNKAN_SRS : null;
  }

  function speechPort() {
    return (window.SUNKAN_SPEECH && typeof window.SUNKAN_SPEECH.speak === 'function')
      ? window.SUNKAN_SPEECH : null;
  }

  /** 同期に「消した」を伝える。これを通さないと、消したものが同期で戻ってくる */
  function noteDelete(key) {
    var s = window.SUNKAN_SYNC;
    if (s && typeof s.recordDelete === 'function') s.recordDelete(key);
  }

  function startOfDay(t) {
    var d = new Date(num(t, Date.now()));
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /* ============================================================
   * 2. 定数
   * ========================================================== */

  var LS_RULES = 'sunkan:gram:rules';
  var LS_ITEMS = 'sunkan:gram:items';
  var LS_SRS   = 'sunkan:gram:srs';     // 添字は**規則 id**（例文 id ではない）
  var LS_SEEN  = 'sunkan:gram:seen';    // { [itemId]: {at, g, q} }
  var LS_LOG   = 'sunkan:gram:log';     // { [ruleId]: [{at, g, iv}] } 直近 LOG_MAX 件
  var LS_UI    = 'sunkan:gram:ui';      // 端末ごとの好み。**同期しない**
  var LS_SEEDED = 'sunkan:gram:seeded'; // 収録を一度入れた印

  var MODES = ['pick', 'type', 'gate'];

  /** 二択の既定のラベル。**英語の形は絶対に入れない**（上の但し書きを参照） */
  var PICK_LABELS = ['1つ', '複数'];

  /** 直近に外した例文を避ける日数。**根拠のある数字ではない**ので、
      設定には出さず定数 1 つにしてある（動かせる余地より画面の単純さを採る）。 */
  var AVOID_DAYS = 7;

  /** 1 規則あたりに残す記録の件数。無制限に伸びうるのはここだけなので上限を置く
      （規則 200 個でも 400KB 程度。同期は 1MB まで）。 */
  var LOG_MAX = 50;

  /** 段を上げる／戻す決まり。grade 3 以上を「出た」とみなす */
  var UP_RUN = 3;     // 二択で 3 回続けて出たら、タイプへ上げる
  var DOWN_RUN = 2;   // タイプで 2 回続けて外したら、二択へ戻す

  var FLASH_MS = 4000;

  /* 収録の規則と例文。**初回だけ localStorage に入れて、あとは本人のもの**
     （直すのも消すのも自由。瞬間英作文のような「元データを残す」二重持ちはしない）。

     標的の選び方には理由がある。
     ・There is/are・Has/Have・One of … **手がかりが名詞句より前に来る**ので、
       左から右に読んで数を予測できる。
     ・三単現 … 主語が動詞より前なので予測にならない。**数を決めた帰結として書かせる。**
     ・形と意味の結び … 日本語母語話者は複数形が概念的な複数性を安定して
       立ち上げないと報告されている（Tamura 2026, N=96, CEFR B1–B2）。
       立っていない素性は予測の手がかりにならない（Hopp 2013 の lexical bottleneck、
       Grüter et al. 2012 の「オフライン 96% なのにオンラインは有意でない」）。
       だから**先に通す関門**として置く。 */
  var SEED_RULES = [
    { id: 'gr-gate', name: '形と意味の結び（数）', mode: 'gate', gate: null,
      note: '英語の形（-s が付くか）ではなく、日本語でいくつのことか' },
    { id: 'gr-there', name: 'There is / There are', mode: 'pick', gate: 'gr-gate',
      note: 'There のあとの be 動詞が、後ろの名詞がいくつかを先に決めている' },
    { id: 'gr-have', name: 'Has / Have（疑問文）', mode: 'pick', gate: 'gr-gate',
      note: '文頭の Has / Have が、すぐ後ろに来る主語がいくつかを決めている' },
    { id: 'gr-oneof', name: 'One of ...', mode: 'pick', gate: 'gr-gate',
      note: 'one of のあとは「その中の 1 つ」なので、束のほうは必ず複数' },
    { id: 'gr-3sg', name: '三単現（主語を見て動詞を書く）', mode: 'type', gate: null,
      note: '主語が 1 つなら動詞に -s が付く。数を決めてから形が決まる' }
  ];

  var SEED_ITEMS = [
    /* --- 形と意味の結び（4 型 × 3 件）---
       可算複数 / 単数 / 不規則複数 / 不可算。
       **-s の有無で答えが出る形にしない。** それだと形の認識しか測れず、
       「複数形が概念的複数性を立ち上げるか」という肝心の隙間を跨いでしまう。 */
    { rule: 'gr-gate', en: 'I saw cats in the garden.', ja: '庭で猫を見た。',
      a: 1, opt: '猫を1匹 / 猫を何匹か' },
    { rule: 'gr-gate', en: 'She bought books yesterday.', ja: '彼女はきのう本を買った。',
      a: 1, opt: '本を1冊 / 本を何冊か' },
    { rule: 'gr-gate', en: 'Dogs were barking outside.', ja: '外で犬がほえていた。',
      a: 1, opt: '犬が1匹 / 犬が何匹か' },
    { rule: 'gr-gate', en: 'I saw a cat in the garden.', ja: '庭で猫を見た。',
      a: 0, opt: '猫を1匹 / 猫を何匹か' },
    { rule: 'gr-gate', en: 'She bought a book yesterday.', ja: '彼女はきのう本を買った。',
      a: 0, opt: '本を1冊 / 本を何冊か' },
    { rule: 'gr-gate', en: 'A dog was barking outside.', ja: '外で犬がほえていた。',
      a: 0, opt: '犬が1匹 / 犬が何匹か' },
    { rule: 'gr-gate', en: 'The children are in the park.', ja: '子どもが公園にいる。',
      a: 1, opt: '子どもが1人 / 子どもが何人か' },
    { rule: 'gr-gate', en: 'My feet hurt.', ja: '足が痛い。',
      a: 1, opt: '片足 / 両足' },
    { rule: 'gr-gate', en: 'Two men were waiting outside.', ja: '外で男性が待っていた。',
      a: 1, opt: '1人 / 何人か' },
    { rule: 'gr-gate', en: 'I drank water.', ja: '水を飲んだ。',
      a: 1, opt: '1つと決まっている / 数えない（量）' },
    { rule: 'gr-gate', en: 'I need information.', ja: '情報が必要だ。',
      a: 1, opt: '1件と決まっている / 数えない（まとまり）' },
    { rule: 'gr-gate', en: 'She bought bread.', ja: 'パンを買った。',
      a: 1, opt: '1個と決まっている / 数えない（量）' },

    /* --- There is / There are ---
       切る境界は「手がかり語の直後／名詞句の直前」。
       be 動詞を出しても答えは漏れない（答えは後ろの名詞句がいくつか）。 */
    { rule: 'gr-there', en: 'There are / three apples / in the basket.',
      ja: 'かごにりんごが3つある。', a: 1 },
    { rule: 'gr-there', en: 'There is / a cup of coffee / on the table.',
      ja: 'テーブルにコーヒーが1杯ある。', a: 0 },
    { rule: 'gr-there', en: 'There were / many people / at the station.',
      ja: '駅に人がたくさんいた。', a: 1 },
    { rule: 'gr-there', en: 'There was / no answer / from him.',
      ja: '彼からの返事はなかった。', a: 0 },
    { rule: 'gr-there', en: 'There are / some children / in the garden.',
      ja: '庭に子どもが何人かいる。', a: 1 },
    { rule: 'gr-there', en: 'There is / too much noise / in this room.',
      ja: 'この部屋はうるさすぎる。', a: 0 },
    { rule: 'gr-there', en: 'There are / a few things / I want to ask.',
      ja: '聞きたいことがいくつかある。', a: 1 },
    { rule: 'gr-there', en: 'There is / something / I have to tell you.',
      ja: '伝えなければいけないことがある。', a: 0 },

    /* --- Has / Have（疑問文にして、手がかりを主語より前に出す） --- */
    { rule: 'gr-have', en: 'Have / the students / finished the test?',
      ja: '学生たちはテストを終えましたか。', a: 1 },
    { rule: 'gr-have', en: 'Has / your brother / called you yet?',
      ja: 'お兄さんからもう電話がありましたか。', a: 0 },
    { rule: 'gr-have', en: 'Does / your sister / live in Tokyo?',
      ja: 'お姉さんは東京に住んでいますか。', a: 0 },
    { rule: 'gr-have', en: 'Do / your parents / know about this?',
      ja: 'ご両親はこれを知っていますか。', a: 1 },
    { rule: 'gr-have', en: 'Is / the meeting / still going on?',
      ja: '会議はまだ続いていますか。', a: 0 },
    { rule: 'gr-have', en: 'Are / the tickets / still available?',
      ja: 'チケットはまだありますか。', a: 1 },

    /* --- One of ... （数量詞 → 名詞の数） --- */
    { rule: 'gr-oneof', en: 'One of / my cousins / works at a bank.',
      ja: 'いとこの1人は銀行で働いている。', a: 1 },
    { rule: 'gr-oneof', en: 'Each of / the rooms / has a window.',
      ja: 'どの部屋にも窓がある。', a: 1 },
    { rule: 'gr-oneof', en: 'Both of / my sisters / live abroad.',
      ja: '姉妹は2人とも海外に住んでいる。', a: 1 },
    { rule: 'gr-oneof', en: 'Neither of / the answers / was correct.',
      ja: 'どちらの答えも正しくなかった。', a: 1 },

    /* --- 三単現（二択で数を決めてから、2 つめのかたまりをタイプ） --- */
    { rule: 'gr-3sg', en: 'My sister / works / at a hospital.',
      ja: '姉は病院で働いている。', a: 0 },
    { rule: 'gr-3sg', en: 'My parents / live / in Osaka.',
      ja: '両親は大阪に住んでいる。', a: 1 },
    { rule: 'gr-3sg', en: 'The train / leaves / at seven.',
      ja: 'その電車は7時に出る。', a: 0 },
    { rule: 'gr-3sg', en: 'These shoes / look / expensive.',
      ja: 'この靴は高そうだ。', a: 1 },
    { rule: 'gr-3sg', en: 'He / wants / to see you.',
      ja: '彼はあなたに会いたがっている。', a: 0 },
    { rule: 'gr-3sg', en: 'The children / play / outside every day.',
      ja: '子どもたちは毎日外で遊ぶ。', a: 1 },
    { rule: 'gr-3sg', en: 'My phone / needs / charging.',
      ja: '携帯を充電しないといけない。', a: 0 },
    { rule: 'gr-3sg', en: 'Those books / belong / to my brother.',
      ja: 'それらの本は兄のものだ。', a: 1 }
  ];

  /* ============================================================
   * 3. 保存データの検証（localStorage の中身は信用しない）
   * ========================================================== */

  function sanitizeRule(raw) {
    if (!isObject(raw)) return null;
    var id = trim(raw.id), name = trim(raw.name);
    if (!id || !name) return null;
    var mode = trim(raw.mode);
    if (MODES.indexOf(mode) < 0) mode = 'pick';
    var gate = trim(raw.gate);
    return {
      id: id, name: name, mode: mode,
      gate: gate || null,
      note: trim(raw.note),
      created: num(raw.created, 0) || Date.now()
    };
  }

  function sanitizeRules(raw) {
    var out = [], seen = {}, i, r;
    if (!isArray(raw)) return out;
    for (i = 0; i < raw.length; i++) {
      r = sanitizeRule(raw[i]);
      if (!r || seen[r.id]) continue;
      seen[r.id] = true;
      out.push(r);
    }
    return out;
  }

  /** 二択の言い方。`/` で 2 つに割れたときだけ使い、だめなら既定へ落とす */
  function sanitizeOpt(raw) {
    var parts = str(raw).split('/');
    if (parts.length !== 2) return null;
    var a = trim(parts[0]), b = trim(parts[1]);
    return (a && b) ? [a, b] : null;
  }

  function sanitizeItem(raw) {
    if (!isObject(raw)) return null;
    var id = trim(raw.id), rule = trim(raw.rule), en = trim(raw.en);
    if (!id || !rule || !en) return null;
    var alt = [], i;
    if (isArray(raw.alt)) {
      for (i = 0; i < raw.alt.length; i++) {
        var one = trim(raw.alt[i]);
        if (one && alt.indexOf(one) < 0) alt.push(one);
      }
    }
    return {
      id: id, rule: rule, en: en,
      ja: trim(raw.ja),
      a: num(raw.a, 0) === 1 ? 1 : 0,
      opt: isArray(raw.opt) ? sanitizeOpt(raw.opt.join(' / ')) : sanitizeOpt(raw.opt),
      alt: alt,
      created: num(raw.created, 0) || Date.now()
    };
  }

  function sanitizeItems(raw) {
    var out = [], seen = {}, i, it;
    if (!isArray(raw)) return out;
    for (i = 0; i < raw.length; i++) {
      it = sanitizeItem(raw[i]);
      if (!it || seen[it.id]) continue;
      seen[it.id] = true;
      out.push(it);
    }
    return out;
  }

  function sanitizeSeen(raw) {
    var out = {}, k, v;
    if (!isObject(raw)) return out;
    for (k in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
      v = raw[k];
      if (!isObject(v)) continue;
      out[k] = {
        at: num(v.at, 0),
        g: num(v.g, 0),
        q: num(v.q, 0) === 1 ? 1 : 0   // 「これでもいい?」の旗。無ければ 0
      };
    }
    return out;
  }

  function sanitizeLog(raw) {
    var out = {}, k, list, i, e, row;
    if (!isObject(raw)) return out;
    for (k in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
      if (!isArray(raw[k])) continue;
      list = [];
      for (i = 0; i < raw[k].length; i++) {
        e = raw[k][i];
        if (!isObject(e)) continue;
        row = { at: num(e.at, 0), g: num(e.g, 0), iv: num(e.iv, 0) };
        if (!row.at) continue;
        list.push(row);
      }
      if (list.length > LOG_MAX) list = list.slice(list.length - LOG_MAX);
      out[k] = list;
    }
    return out;
  }

  function sanitizeSrsMap(raw) {
    var out = {}, k, api = srsPort();
    if (!isObject(raw)) return out;
    for (k in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
      out[k] = api ? api.sanitize(raw[k]) : raw[k];
    }
    return out;
  }

  function sanitizeUI(raw) {
    var ui = { rule: '', session: null };
    if (!isObject(raw)) return ui;
    if (typeof raw.rule === 'string') ui.rule = raw.rule;
    if (isObject(raw.session)) {
      ui.session = {
        day: num(raw.session.day, 0),
        ids: isArray(raw.session.ids) ? raw.session.ids.slice() : [],
        // **答えた件数ではなく、答えた規則の並び。** 件数だけ持って ids から
        // 引いていくと、凍結した総数のほうが減って帯が永久に 0/0 になる
        done: isArray(raw.session.done) ? raw.session.done.slice() : []
      };
    }
    return ui;
  }

  /* ============================================================
   * 4. 状態
   * ========================================================== */

  var state = {
    rules: [],
    items: [],
    srs: {},
    seen: {},
    log: {},
    rule: '',          // 絞り込んでいる規則の id（'' はぜんぶ）
    session: null,     // { day, ids, done } … 始めた時点で凍結した予定
    cur: null,         // いま出している問題 { item, rule, stage, picked, typed, step }
    speechOK: false,
    flashTimer: null,
    editingId: null    // 例文ダイアログで直している例文 id（新規は null）
  };

  /* ============================================================
   * 5. DOM 参照（無くても落ちない）
   * ========================================================== */

  var elView = $('gram-view');
  var elStage = $('gram-stage');
  var elEmpty = $('gram-empty');
  var elStatus = $('gram-status');

  var elRuleSelect = $('gram-rule-select');
  var elAddBtn = $('btn-gram-add');
  var elRulesBtn = $('btn-gram-rules');

  var elLeft = $('gram-left');
  var elCount = $('gram-count');
  var elTrack = $('gram-track');
  var elFill = $('gram-fill');

  var elRuleName = $('gram-rule-name');
  var elStageTag = $('gram-stage-tag');
  var elSentence = $('gram-sentence');
  var elJa = $('gram-ja');

  var elPicks = $('gram-picks');
  var elPick0 = $('btn-gram-pick-0');
  var elPick1 = $('btn-gram-pick-1');

  var elType = $('gram-type');
  var elInput = $('gram-input');
  var elSend = $('btn-gram-send');

  var elAnswer = $('gram-answer');
  var elMine = $('gram-mine');
  var elModel = $('gram-model');
  var elWhy = $('gram-why');
  var elAlts = $('gram-alts');

  var elGrades = $('gram-grades');
  var elG = [null, $('btn-gram-g1'), $('btn-gram-g2'), $('btn-gram-g3'), $('btn-gram-g4')];
  var elWhen = [null, $('gram-when-1'), $('gram-when-2'), $('gram-when-3'), $('gram-when-4')];

  var elFlag = $('btn-gram-flag');
  var elSpeak = $('btn-gram-speak');
  var elEdit = $('btn-gram-edit');

  var elItemDialog = $('gram-item-dialog');
  var elItemTitle = $('gram-item-dialog-title');
  var elItemRule = $('gram-item-rule');
  var elItemEn = $('gram-item-en');
  var elItemJa = $('gram-item-ja');
  var elItemA0 = $('gram-item-a0');
  var elItemA1 = $('gram-item-a1');
  var elItemA0Label = $('gram-item-a0-label');
  var elItemA1Label = $('gram-item-a1-label');
  var elItemOpt = $('gram-item-opt');
  var elItemAlt = $('gram-item-alt');
  var elItemStatus = $('gram-item-status');
  var elItemSave = $('btn-gram-item-save');
  var elItemCancel = $('btn-gram-item-cancel');
  var elItemDelete = $('btn-gram-item-delete');

  var elRuleDialog = $('gram-rule-dialog');
  var elNewRule = $('gram-new-rule');
  var elNewMode = $('gram-new-mode');
  var elNewNote = $('gram-new-note');
  var elNewRuleBtn = $('btn-gram-new-rule');
  var elRuleList = $('gram-rule-manage-list');
  var elRuleStatus = $('gram-rule-status');
  var elRuleClose = $('btn-gram-rule-close');

  /* ============================================================
   * 6. 保存
   * ========================================================== */

  function saveRules() { return writeJSON(LS_RULES, state.rules); }
  function saveItems() { return writeJSON(LS_ITEMS, state.items); }
  function saveSrs() { return writeJSON(LS_SRS, state.srs); }
  function saveSeen() { return writeJSON(LS_SEEN, state.seen); }
  function saveLog() { return writeJSON(LS_LOG, state.log); }

  function saveUI() {
    return writeJSON(LS_UI, { rule: state.rule, session: state.session });
  }

  function flash(message) {
    if (!elStatus) return;
    elStatus.textContent = str(message);
    if (state.flashTimer) window.clearTimeout(state.flashTimer);
    state.flashTimer = window.setTimeout(function () {
      state.flashTimer = null;
      renderStatus();
    }, FLASH_MS);
  }

  /* ============================================================
   * 7. 問い合わせ（規則・例文・段・ゲート）
   * ========================================================== */

  function findRule(id) {
    for (var i = 0; i < state.rules.length; i++) {
      if (state.rules[i].id === id) return state.rules[i];
    }
    return null;
  }

  function findItem(id) {
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].id === id) return state.items[i];
    }
    return null;
  }

  function itemsOf(ruleId) {
    var out = [], i;
    for (i = 0; i < state.items.length; i++) {
      if (state.items[i].rule === ruleId) out.push(state.items[i]);
    }
    return out;
  }

  function srsOf(ruleId) {
    var api = srsPort();
    if (state.srs[ruleId]) return state.srs[ruleId];
    return api ? api.newState() : { state: 'new', due: null };
  }

  function logOf(ruleId) {
    return isArray(state.log[ruleId]) ? state.log[ruleId] : [];
  }

  /**
   * いまの段（二択か、タイプか）。
   *
   * **別の鍵には持たない。記録（log）から毎回たどる。**
   * 段を別に保存すると、記録と段の 2 つを合わせて面倒を見ることになり、
   * 記録を切り詰めたときに食い違う。たどるのは最大 LOG_MAX 件なので安い。
   *
   * 記録が LOG_MAX で切れていても困らない。上げ下げを決めるのは末尾の
   * 2〜3 件なので、古いぶんが落ちても答えは変わらない。
   */
  function stageOf(rule) {
    if (!rule) return 'pick';
    // ゲートと、はじめからタイプの規則は段を動かさない
    if (rule.mode === 'gate') return 'gate';
    if (rule.mode === 'type') return 'type';

    var list = logOf(rule.id);
    var m = 'pick', run = 0, i, ok;
    for (i = 0; i < list.length; i++) {
      ok = list[i].g >= 3;
      if (m === 'pick') {
        run = ok ? run + 1 : 0;
        if (run >= UP_RUN) { m = 'type'; run = 0; }
      } else {
        run = ok ? 0 : run + 1;
        if (run >= DOWN_RUN) { m = 'pick'; run = 0; }
      }
    }
    return m;
  }

  /**
   * ゲートを通ったか。**一度 grade 3 以上が付けば、以後ずっと通過。**
   *
   * 「いま due かどうか」で見てはいけない。ゲートも普通の規則として復習に
   * 乗るので、復習で due になるたび「未通過」に戻ってしまう。
   * 通ったあとに外しても他の規則は止めない（止めると催促になる）。
   */
  function gatePassed(gateId) {
    if (!gateId) return true;
    if (!findRule(gateId)) return true;   // ゲートの規則ごと消したなら、関門は無い
    var list = logOf(gateId), i;
    for (i = 0; i < list.length; i++) {
      if (list[i].g >= 3) return true;
    }
    return false;
  }

  /** その規則が、いまタイプまで上がれるか（ゲートが未通過なら上げない） */
  function canPromote(rule) {
    return !rule || !rule.gate ? true : gatePassed(rule.gate);
  }

  /** 実際に出す段。上げられない規則は二択に留める */
  function activeStage(rule) {
    var m = stageOf(rule);
    if (m === 'type' && rule && rule.mode === 'pick' && !canPromote(rule)) return 'pick';
    return m;
  }

  /**
   * その規則から 1 問選ぶ。
   *   旗（これでもいい?）→ 未見 → 出したのがいちばん古い
   * 直近に外したもの（grade 1 以下で AVOID_DAYS 以内）は、ほかに出せるものが
   * あるあいだは避ける。**ほかに無ければ出す**（出せる問題が無くなるほうが困る）。
   */
  /** 旗を下ろす。出した時点で下ろすので、次の回には普通の順で並ぶ */
  function dropFlag(itemId) {
    var rec = state.seen[itemId];
    if (!rec || rec.q !== 1) return;
    rec.q = 0;
    state.seen[itemId] = rec;
    saveSeen();
  }

  function pickItem(ruleId, now) {
    var list = itemsOf(ruleId);
    if (!list.length) return null;

    var cutoff = num(now, Date.now()) - AVOID_DAYS * 86400000;
    var flagged = [], fresh = [], rest = [], avoid = [], i, it, rec;

    for (i = 0; i < list.length; i++) {
      it = list[i];
      rec = state.seen[it.id];
      if (rec && rec.q === 1) { flagged.push(it); continue; }
      if (!rec || !rec.at) { fresh.push(it); continue; }
      if (rec.g <= 1 && rec.at > cutoff) { avoid.push(it); continue; }
      rest.push(it);
    }

    function oldest(arr) {
      var best = null, bestAt = Infinity, n, at;
      for (n = 0; n < arr.length; n++) {
        at = (state.seen[arr[n].id] && state.seen[arr[n].id].at) || 0;
        if (at < bestAt) { bestAt = at; best = arr[n]; }
      }
      return best;
    }

    if (flagged.length) return oldest(flagged);
    if (fresh.length) return fresh[Math.floor(Math.random() * fresh.length)];
    if (rest.length) return oldest(rest);
    return oldest(avoid);
  }

  /* ============================================================
   * 8. その日の予定（始めた時点で凍結する）
   *
   * **これが「やめ時が分かる」ということ。** 途中で増やしてはいけない。
   * grade 1 のとき忘却曲線は同じ日のうちに出し直そうとするが、その分は
   * 今日の予定には足さず、翌日に回す（帯が増えないことを守る）。
   * ========================================================== */

  /**
   * 今日やる規則を決める。**凍結するのはここ 1 回だけ。**
   *
   * ゲートが未通過の規則は、**この時点で**ゲートの枠に畳む。同じゲートを
   * 待っている規則がいくつ並んでいても、ゲートは 1 枠にまとまり、
   * 待たされた規則は今日の予定から外れて翌日に回る。
   * 途中で差し替える作りにすると、ゲートを外したときに同じ問題が延々と出て、
   * 「のこり」が減らなくなる（やめ時が分からない）。
   */
  function plannedIds(now) {
    var api = srsPort(), out = [], mark = {}, i, r, target;
    for (i = 0; i < state.rules.length; i++) {
      r = state.rules[i];
      if (state.rule && r.id !== state.rule) continue;
      if (!itemsOf(r.id).length) continue;         // 例文の無い規則は出さない
      if (api && !api.isDue(srsOf(r.id), now)) continue;

      target = r.id;
      if (r.gate && !gatePassed(r.gate)) {
        var g = findRule(r.gate);
        if (g && itemsOf(g.id).length) target = g.id;
      }
      if (mark[target]) continue;
      mark[target] = true;
      out.push(target);
    }
    return out;
  }

  /** 今日ぶんの予定を作る（まだ無ければ）。すでに在れば、そのまま使う */
  function ensureSession(now) {
    var today = startOfDay(now);
    if (state.session && state.session.day === today) return state.session;
    state.session = { day: today, ids: plannedIds(now), done: [] };
    saveUI();
    return state.session;
  }

  function isDone(ruleId) {
    if (!state.session) return false;
    return state.session.done.indexOf(ruleId) >= 0;
  }

  /** 予定のうち、いまも成り立っている規則の id（消された規則は数えない） */
  function livePlanIds() {
    if (!state.session) return [];
    var out = [], i, id;
    for (i = 0; i < state.session.ids.length; i++) {
      id = state.session.ids[i];
      if (!findRule(id) || !itemsOf(id).length) continue;
      out.push(id);
    }
    return out;
  }

  /** まだ答えていない規則の id */
  function remainingIds() {
    var ids = livePlanIds(), out = [], i;
    for (i = 0; i < ids.length; i++) {
      if (!isDone(ids[i])) out.push(ids[i]);
    }
    return out;
  }

  /** 次に出す規則。予定の並びのまま、まだ答えていない先頭 */
  function nextRule() {
    var ids = remainingIds();
    return ids.length ? findRule(ids[0]) : null;
  }

  /** 答え終わった印。**予定の並びは減らさない**（帯の分母が動かないように） */
  function markDone(ruleId) {
    if (!state.session || isDone(ruleId)) return;
    state.session.done.push(ruleId);
    saveUI();
  }

  /* ============================================================
   * 9. 出題
   * ========================================================== */

  /** `/` でかたまりに割る。1 つしか無ければ、丸ごと 1 かたまり */
  function chunksOf(text) {
    var parts = str(text).split('/'), out = [], i, one;
    for (i = 0; i < parts.length; i++) {
      one = trim(parts[i]);
      if (one) out.push(one);
    }
    return out.length ? out : [trim(text)];
  }

  function labelsFor(item, rule) {
    if (item && item.opt) return item.opt;
    if (rule && rule.mode === 'gate') return PICK_LABELS;   // opt 無しのゲートは既定
    return PICK_LABELS;
  }

  /** 模範解答にあたる文字（タイプの段は 2 つめのかたまり） */
  function modelText(item) {
    var ch = chunksOf(item.en);
    return ch.length > 1 ? ch[1] : ch[0];
  }

  function render() {
    if (!elStage || !elEmpty) return;

    var now = Date.now();
    ensureSession(now);

    if (!state.rules.length || !state.items.length) {
      state.cur = null;
      elStage.hidden = true;
      elEmpty.hidden = false;
      elEmpty.textContent = '規則と例文がありません。☰ から規則を作って、「＋ 足す」で例文を入れてください。';
      renderProgress();
      renderStatus();
      return;
    }

    if (!state.cur) {
      var rule = nextRule();
      if (!rule) {
        elStage.hidden = true;
        elEmpty.hidden = false;
        elEmpty.textContent = '今日の復習はありません。';
        renderProgress();
        renderStatus();
        return;
      }
      var item = pickItem(rule.id, now);
      if (!item) {
        // 例文が 1 つも無い規則は出しようがない。答えた扱いにして次へ
        markDone(rule.id);
        render();
        return;
      }
      state.cur = {
        item: item, rule: rule,
        stage: activeStage(rule),
        picked: -1, typed: '', step: 'pick'
      };
      // **旗はここで下りる。** 「次にこの規則が来たとき先に出す」ための印なので、
      // 先に出した時点で役目が終わる。採点のときに消すと、旗を付けてから採点する
      // というただ 1 つの道で必ず消えてしまい、一度も効かない。
      dropFlag(item.id);
    }

    elEmpty.hidden = true;
    elStage.hidden = false;
    renderQuestion();
    renderProgress();
    renderStatus();
  }

  /** いまの問題を描く。**step より先の段は 1 つも出さない** */
  function renderQuestion() {
    var cur = state.cur;
    if (!cur) return;
    var item = cur.item, rule = cur.rule;
    var chunks = chunksOf(item.en);
    var labels = labelsFor(item, rule);

    if (elRuleName) elRuleName.textContent = rule.name;
    if (elStageTag) {
      elStageTag.textContent = (cur.stage === 'type')
        ? '続きをタイプ'
        : (cur.stage === 'gate' ? '形と意味' : '二択');
    }

    // 問題文。答え合わせの前は、1 つめのかたまりだけ見せる
    if (elSentence) {
      while (elSentence.firstChild) elSentence.removeChild(elSentence.firstChild);
      var open = (cur.step === 'done') ? chunks.length
        : (cur.stage === 'gate' ? chunks.length : 1);
      for (var i = 0; i < chunks.length; i++) {
        var sp = document.createElement('span');
        sp.className = 'gram-chunk ' + (i < open ? 'is-shown' : 'is-hidden');
        if (cur.step === 'done' && i === 1) sp.className += ' is-fresh';
        sp.textContent = chunks[i] + (i < chunks.length - 1 ? ' ' : '');
        elSentence.appendChild(sp);
      }
    }

    // 日本語は**答え合わせまで出さない**。ゲートは日本語で二択を出すので、
    // 訳を先に見せると答えがそのまま読める
    if (elJa) {
      elJa.textContent = (cur.step === 'done') ? item.ja : '';
      elJa.hidden = !(cur.step === 'done' && item.ja);
    }

    // ① 二択
    if (elPicks) elPicks.hidden = (cur.step !== 'pick');
    if (elPick0) {
      elPick0.textContent = labels[0];
      elPick0.classList.toggle('is-picked', cur.picked === 0);
    }
    if (elPick1) {
      elPick1.textContent = labels[1];
      elPick1.classList.toggle('is-picked', cur.picked === 1);
    }

    // ② タイプ
    if (elType) elType.hidden = (cur.step !== 'type');
    if (elInput && cur.step === 'type') {
      elInput.value = cur.typed;
      elInput.focus();
    }

    // ③ 答え合わせ（自分の答えと模範を**並べて**置く）
    var done = (cur.step === 'done');
    if (elAnswer) elAnswer.hidden = !done;
    if (done) renderAnswer();

    // ④ 自己採点
    if (elGrades) elGrades.hidden = !done;
    if (elFlag) {
      elFlag.hidden = !done;
      var rec = state.seen[item.id];
      elFlag.setAttribute('aria-pressed', (rec && rec.q === 1) ? 'true' : 'false');
    }
  }

  function renderAnswer() {
    var cur = state.cur;
    if (!cur) return;
    var item = cur.item, labels = labelsFor(item, cur.rule);
    var wrong;

    if (cur.stage === 'type') {
      var model = modelText(item);
      var mine = trim(cur.typed);
      wrong = !sameAnswer(mine, model, item.alt);
      if (elMine) elMine.textContent = mine || '（書かなかった）';
      if (elModel) elModel.textContent = model;
    } else {
      wrong = (cur.picked !== item.a);
      if (elMine) elMine.textContent = (cur.picked >= 0) ? labels[cur.picked] : '（選ばなかった）';
      if (elModel) elModel.textContent = labels[item.a];
    }

    if (elAnswer) elAnswer.classList.toggle('is-wrong', wrong);

    /* 説明は**規則に 1 本**（例文ごとに書かせると、作るのが重くて続かない）。
       ただしそれだけだと規則の言い換えにしかならないので、**その例文の語**で
       1 行を機械的に作って頭に付ける（「a cup of coffee が 1つ」）。
       本人に書かせずに「この文のどこがそう決めているか」を出せる。 */
    if (elWhy) {
      var line = '';
      var ch = chunksOf(item.en);
      if (cur.stage !== 'gate' && ch.length > 1) {
        line = ch[1] + ' が ' + labels[item.a];
      }
      var note = cur.rule.note;
      elWhy.textContent = line ? (line + (note ? '。' + note : '')) : note;
      elWhy.hidden = !(line || note);
    }
    if (elAlts) {
      elAlts.textContent = item.alt.length ? ('ほかに: ' + item.alt.join(' / ')) : '';
      elAlts.hidden = !item.alt.length;
    }

    // 「次はいつ」を各ボタンに出す
    var api = srsPort();
    if (api) {
      var pv = api.preview(srsOf(cur.rule.id), { now: Date.now() });
      for (var g = 1; g <= 4; g++) {
        if (elWhen[g]) elWhen[g].textContent = api.humanInterval(pv[g]);
      }
    }
  }

  /** タイプの答え合わせ。大文字小文字と前後の空白、終わりの記号は見ない */
  function normalizeTyped(v) {
    return trim(v).toLowerCase().replace(/[.!?,;:]+$/, '').replace(/\s+/g, ' ');
  }

  function sameAnswer(mine, model, alt) {
    var key = normalizeTyped(mine);
    if (!key) return false;
    if (key === normalizeTyped(model)) return true;
    for (var i = 0; i < (alt || []).length; i++) {
      if (key === normalizeTyped(alt[i])) return true;
    }
    return false;
  }

  function renderProgress() {
    var total = livePlanIds().length;
    var left = remainingIds().length;
    var done = Math.max(0, total - left);
    if (elLeft) elLeft.textContent = 'のこり ' + left + ' 問';
    if (elCount) elCount.textContent = done + ' / ' + total;
    if (elTrack) {
      elTrack.setAttribute('aria-valuemax', String(total));
      elTrack.setAttribute('aria-valuenow', String(done));
    }
    if (elFill) elFill.style.width = total ? ((done / total) * 100) + '%' : '0';
  }

  function renderStatus() {
    if (!elStatus || state.flashTimer) return;
    var rules = state.rules.length, items = state.items.length;
    elStatus.textContent = rules
      ? ('規則 ' + rules + '・例文 ' + items)
      : '';
  }

  /* ============================================================
   * 10. 答える
   * ========================================================== */

  function onPick(which) {
    var cur = state.cur;
    if (!cur || cur.step !== 'pick') return;
    cur.picked = which;
    // 二択だけの規則とゲートは、ここで答え合わせへ。
    // タイプの段はここから 2 段目に入る（続きはまだ出さない）
    cur.step = (cur.stage === 'type') ? 'type' : 'done';
    renderQuestion();
  }

  function onSend() {
    var cur = state.cur;
    if (!cur || cur.step !== 'type') return;
    cur.typed = elInput ? elInput.value : '';
    cur.step = 'done';
    renderQuestion();
  }

  function onGrade(g) {
    var cur = state.cur;
    if (!cur || cur.step !== 'done') return;
    var api = srsPort();
    var now = Date.now();
    var ruleId = cur.rule.id;

    var iv = 0;
    if (api) {
      var next = api.review(srsOf(ruleId), g, { now: now });
      iv = num(next.intervalDays, 0);
      state.srs[ruleId] = next;
      saveSrs();
    }

    // 例文の「最後に出した」を控える。
    // **旗（これでもいい?）はここで消さない。** 旗と採点は同時に出るので、
    // ここで消すと「旗を付けて採点する」というただ 1 つの道で必ず消え、
    // 旗が一度も効かない。下りるのは**次にこの例文を出したとき**（pickItem）。
    var was = state.seen[cur.item.id];
    state.seen[cur.item.id] = { at: now, g: g, q: (was && was.q === 1) ? 1 : 0 };
    saveSeen();

    // 記録。**直近 LOG_MAX 件だけ残す**（無制限に伸びるのはここだけ）
    var list = logOf(ruleId).slice();
    list.push({ at: now, g: g, iv: iv });
    if (list.length > LOG_MAX) list = list.slice(list.length - LOG_MAX);
    state.log[ruleId] = list;
    saveLog();

    // 今日の予定は、結果にかかわらずここで終わり。
    // grade 1 で忘却曲線が同じ日に出し直そうとしても**今日は足さない**
    // （帯が増えると、やめ時が分からなくなる）。翌日の予定に入る。
    markDone(ruleId);

    state.cur = null;
    render();
  }

  /** 「これでもいい?」の旗。**予定（間隔）には効かせない。**
      次にこの規則が来たとき、この例文を先に出すだけ */
  function onFlag() {
    var cur = state.cur;
    if (!cur || cur.step !== 'done') return;
    var rec = state.seen[cur.item.id] || { at: 0, g: 0, q: 0 };
    rec.q = rec.q === 1 ? 0 : 1;
    state.seen[cur.item.id] = rec;
    saveSeen();
    if (elFlag) elFlag.setAttribute('aria-pressed', rec.q === 1 ? 'true' : 'false');
    flash(rec.q === 1 ? '「これでもいい?」を付けました。次にこの規則が来たとき先に出します。' : '印を外しました。');
  }

  function speakCurrent() {
    var cur = state.cur, port = speechPort();
    if (!cur || !port) return;
    // **答え合わせの前は読み上げない。** 読めば続きが音で漏れる
    if (cur.step !== 'done') {
      flash('答え合わせのあとに聞けます。');
      return;
    }
    port.speak(chunksOf(cur.item.en).join(' '));
  }

  /* ============================================================
   * 11. 規則の一覧
   * ========================================================== */

  function renderRuleSelect() {
    if (!elRuleSelect) return;
    var keep = state.rule;
    while (elRuleSelect.firstChild) elRuleSelect.removeChild(elRuleSelect.firstChild);

    var all = document.createElement('option');
    all.value = '';
    all.textContent = 'ぜんぶ（' + state.rules.length + '）';
    elRuleSelect.appendChild(all);

    for (var i = 0; i < state.rules.length; i++) {
      var o = document.createElement('option');
      o.value = state.rules[i].id;
      o.textContent = state.rules[i].name + '（' + itemsOf(state.rules[i].id).length + '）';
      elRuleSelect.appendChild(o);
    }
    elRuleSelect.value = findRule(keep) ? keep : '';
    state.rule = elRuleSelect.value;
  }

  function renderItemRuleSelect() {
    if (!elItemRule) return;
    var keep = elItemRule.value;
    while (elItemRule.firstChild) elItemRule.removeChild(elItemRule.firstChild);
    for (var i = 0; i < state.rules.length; i++) {
      var o = document.createElement('option');
      o.value = state.rules[i].id;
      o.textContent = state.rules[i].name;
      elItemRule.appendChild(o);
    }
    if (findRule(keep)) elItemRule.value = keep;
  }

  function renderRuleList() {
    if (!elRuleList) return;
    var api = srsPort();
    while (elRuleList.firstChild) elRuleList.removeChild(elRuleList.firstChild);

    for (var i = 0; i < state.rules.length; i++) {
      var r = state.rules[i];
      var li = document.createElement('li');
      li.className = 'deck-manage-row';
      li.setAttribute('data-id', r.id);

      var name = document.createElement('input');
      name.type = 'text';
      name.className = 'field-input deck-manage-name';
      name.value = r.name;
      name.setAttribute('data-role', 'name');
      li.appendChild(name);

      var count = document.createElement('span');
      count.className = 'deck-manage-count';
      count.textContent = itemsOf(r.id).length + ' 文';
      li.appendChild(count);

      var when = document.createElement('span');
      when.className = 'deck-manage-when';
      if (api) {
        var st = srsOf(r.id);
        when.textContent = api.isDue(st, Date.now())
          ? '今日'
          : api.humanInterval(Math.round((st.due - Date.now()) / 86400000));
      }
      li.appendChild(when);

      var mode = document.createElement('span');
      mode.className = 'deck-manage-count';
      mode.textContent = (r.mode === 'gate') ? '形と意味'
        : (activeStage(r) === 'type' ? 'タイプ' : '二択');
      li.appendChild(mode);

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn--icon genre-manage-delete';
      del.setAttribute('data-role', 'delete');
      del.setAttribute('aria-label', r.name + ' を消す');
      del.textContent = '🗑';
      li.appendChild(del);

      elRuleList.appendChild(li);
    }
  }

  function addRule() {
    var name = trim(elNewRule && elNewRule.value);
    if (!name) {
      if (elRuleStatus) elRuleStatus.textContent = '名前を入れてください。';
      return;
    }
    var mode = trim(elNewMode && elNewMode.value);
    if (MODES.indexOf(mode) < 0) mode = 'pick';
    state.rules.push({
      id: uid('gr'), name: name, mode: mode,
      gate: null, note: trim(elNewNote && elNewNote.value),
      created: Date.now()
    });
    saveRules();
    if (elNewRule) elNewRule.value = '';
    if (elNewNote) elNewNote.value = '';
    if (elRuleStatus) elRuleStatus.textContent = '「' + name + '」を作りました。';
    renderRuleList();
    renderRuleSelect();
    renderItemRuleSelect();
    render();
  }

  function renameRule(id, name) {
    var r = findRule(id);
    name = trim(name);
    if (!r || !name || r.name === name) return;
    r.name = name;
    saveRules();
    renderRuleSelect();
    renderItemRuleSelect();
    if (state.cur && state.cur.rule.id === id) renderQuestion();
  }

  /** 規則を消すと、その例文と記録も一緒に消える（残すと迷子になる） */
  function deleteRule(id) {
    var r = findRule(id);
    if (!r) return;
    if (!window.confirm('「' + r.name + '」と、その例文 ' + itemsOf(id).length + ' 文を消します。よろしいですか。')) return;

    var keepItems = [], i;
    for (i = 0; i < state.items.length; i++) {
      if (state.items[i].rule === id) {
        noteDelete('gramitem:' + state.items[i].id);
        delete state.seen[state.items[i].id];
      } else {
        keepItems.push(state.items[i]);
      }
    }
    state.items = keepItems;

    var keepRules = [];
    for (i = 0; i < state.rules.length; i++) {
      if (state.rules[i].id === id) continue;
      // この規則を関門にしていた規則は、関門を外す（消えた関門で止めない）
      if (state.rules[i].gate === id) state.rules[i].gate = null;
      keepRules.push(state.rules[i]);
    }
    state.rules = keepRules;

    delete state.srs[id];
    delete state.log[id];
    noteDelete('gramrule:' + id);

    saveRules(); saveItems(); saveSrs(); saveSeen(); saveLog();
    // 予定からは消さない。livePlanIds が「もう無い規則」として数えないので、
    // 分母のほうが自然に 1 つ減る（消した規則が「のこり」に残らない）
    if (state.cur && state.cur.rule.id === id) state.cur = null;

    renderRuleList();
    renderRuleSelect();
    renderItemRuleSelect();
    render();
    if (elRuleStatus) elRuleStatus.textContent = '「' + r.name + '」を消しました。';
  }

  /* ============================================================
   * 12. 例文のダイアログ
   * ========================================================== */

  function openItemDialog(itemId) {
    if (!elItemDialog) return;
    state.editingId = itemId || null;
    renderItemRuleSelect();

    var it = itemId ? findItem(itemId) : null;
    if (elItemTitle) elItemTitle.textContent = it ? '例文を直す' : '例文を足す';
    if (elItemRule) elItemRule.value = it ? it.rule : (state.rule || (state.rules[0] && state.rules[0].id) || '');
    if (elItemEn) elItemEn.value = it ? it.en : '';
    if (elItemJa) elItemJa.value = it ? it.ja : '';
    if (elItemOpt) elItemOpt.value = (it && it.opt) ? it.opt.join(' / ') : '';
    if (elItemAlt) elItemAlt.value = (it && it.alt.length) ? it.alt.join(', ') : '';
    if (elItemA0) elItemA0.checked = !it || it.a === 0;
    if (elItemA1) elItemA1.checked = !!it && it.a === 1;
    if (elItemDelete) elItemDelete.hidden = !it;
    if (elItemStatus) elItemStatus.textContent = '';
    syncItemLabels();

    if (typeof elItemDialog.showModal === 'function') elItemDialog.showModal();
    else elItemDialog.setAttribute('open', '');
  }

  function closeItemDialog() {
    if (!elItemDialog) return;
    if (typeof elItemDialog.close === 'function') elItemDialog.close();
    else elItemDialog.removeAttribute('open');
    state.editingId = null;
  }

  /** 二択のラベルを、いま入れている `opt` に合わせる（何を選ぶのか分かるように） */
  function syncItemLabels() {
    var opt = sanitizeOpt(elItemOpt && elItemOpt.value) || PICK_LABELS;
    if (elItemA0Label) elItemA0Label.textContent = opt[0];
    if (elItemA1Label) elItemA1Label.textContent = opt[1];
  }

  function saveItem() {
    var rule = trim(elItemRule && elItemRule.value);
    var en = trim(elItemEn && elItemEn.value);
    if (!findRule(rule)) {
      if (elItemStatus) elItemStatus.textContent = '規則を選んでください。';
      return;
    }
    if (!en) {
      if (elItemStatus) elItemStatus.textContent = '英文を入れてください。';
      return;
    }
    var r = findRule(rule);
    if (r.mode !== 'gate' && chunksOf(en).length < 2) {
      if (elItemStatus) {
        elItemStatus.textContent = '英文を / で区切ってください（1 つめが手がかり、2 つめが答えの正体）。';
      }
      return;
    }

    var alt = [], raw = str(elItemAlt && elItemAlt.value).split(','), i, one;
    for (i = 0; i < raw.length; i++) {
      one = trim(raw[i]);
      if (one && alt.indexOf(one) < 0) alt.push(one);
    }

    var body = {
      rule: rule, en: en,
      ja: trim(elItemJa && elItemJa.value),
      a: (elItemA1 && elItemA1.checked) ? 1 : 0,
      opt: sanitizeOpt(elItemOpt && elItemOpt.value),
      alt: alt
    };

    if (state.editingId) {
      var cur = findItem(state.editingId);
      if (cur) {
        cur.rule = body.rule; cur.en = body.en; cur.ja = body.ja;
        cur.a = body.a; cur.opt = body.opt; cur.alt = body.alt;
      }
    } else {
      body.id = uid('gi');
      body.created = Date.now();
      state.items.push(body);
    }
    saveItems();
    closeItemDialog();

    // 直した例文がいま出ているなら、作り直す（答えが変わっているかもしれない）
    if (state.cur) state.cur = null;
    renderRuleSelect();
    render();
    flash(state.editingId ? '直しました。' : '例文を足しました。');
  }

  function deleteItem() {
    if (!state.editingId) return;
    var it = findItem(state.editingId);
    if (!it) return;
    if (!window.confirm('この例文を消します。よろしいですか。')) return;

    var keep = [], i;
    for (i = 0; i < state.items.length; i++) {
      if (state.items[i].id !== it.id) keep.push(state.items[i]);
    }
    state.items = keep;
    delete state.seen[it.id];
    noteDelete('gramitem:' + it.id);
    saveItems(); saveSeen();
    closeItemDialog();
    if (state.cur) state.cur = null;
    renderRuleSelect();
    render();
    flash('例文を消しました。');
  }

  /* ============================================================
   * 13. イベント
   * ========================================================== */

  /** Enter では保存しない（日本語の変換の Enter で勝手に保存されるのを防ぐ）。
      ほかのモードと同じ作法。CONTRACT「Enter では追加しない」を参照 */
  function blockEnter(input) {
    if (!input || !input.addEventListener) return;
    input.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
    });
  }

  function bindEvents() {
    if (elPick0) elPick0.addEventListener('click', function () { onPick(0); });
    if (elPick1) elPick1.addEventListener('click', function () { onPick(1); });
    if (elSend) elSend.addEventListener('click', onSend);

    // タイプの欄だけは Enter で送れるようにする（**送信の合図**なので、
    // 保存ではない。ここを塞ぐと毎回ボタンまで指を運ぶことになる）
    if (elInput) {
      elInput.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (!e.isComposing) onSend();   // 変換中の Enter では送らない
      });
    }

    for (var g = 1; g <= 4; g++) {
      if (!elG[g]) continue;
      (function (grade) {
        elG[grade].addEventListener('click', function () { onGrade(grade); });
      })(g);
    }

    if (elFlag) elFlag.addEventListener('click', onFlag);
    if (elSpeak) elSpeak.addEventListener('click', speakCurrent);
    if (elEdit) {
      elEdit.addEventListener('click', function () {
        if (!state.cur) return;
        // **答え合わせの前は開かない。** 直す画面には英文が区切りごと丸ごと入り、
        // 訳も、どちらが正しいかの印まで入っている。開けたら答えがそのまま読める
        // （🔈 と同じ門。こちらに付け忘れていた）。
        if (state.cur.step !== 'done') {
          flash('答え合わせのあとに直せます。');
          return;
        }
        openItemDialog(state.cur.item.id);
      });
    }

    if (elRuleSelect) {
      elRuleSelect.addEventListener('change', function () {
        state.rule = elRuleSelect.value;
        state.session = null;      // 絞り込みを変えたら予定を組み直す
        state.cur = null;
        saveUI();
        render();
      });
    }

    if (elAddBtn) elAddBtn.addEventListener('click', function () { openItemDialog(null); });
    if (elRulesBtn) {
      elRulesBtn.addEventListener('click', function () {
        renderRuleList();
        if (elRuleStatus) elRuleStatus.textContent = '';
        if (elRuleDialog && typeof elRuleDialog.showModal === 'function') elRuleDialog.showModal();
        else if (elRuleDialog) elRuleDialog.setAttribute('open', '');
      });
    }

    if (elItemSave) elItemSave.addEventListener('click', saveItem);
    if (elItemCancel) elItemCancel.addEventListener('click', closeItemDialog);
    if (elItemDelete) elItemDelete.addEventListener('click', deleteItem);
    if (elItemOpt) elItemOpt.addEventListener('input', syncItemLabels);
    blockEnter(elItemEn); blockEnter(elItemJa);
    blockEnter(elItemOpt); blockEnter(elItemAlt);

    if (elNewRuleBtn) elNewRuleBtn.addEventListener('click', addRule);
    blockEnter(elNewRule); blockEnter(elNewNote);
    if (elRuleClose) {
      elRuleClose.addEventListener('click', function () {
        if (elRuleDialog && typeof elRuleDialog.close === 'function') elRuleDialog.close();
        else if (elRuleDialog) elRuleDialog.removeAttribute('open');
      });
    }

    // 規則の一覧の中の操作はまとめて受ける
    if (elRuleList) {
      elRuleList.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('[data-role="delete"]') : null;
        if (!btn) return;
        var row = btn.closest('.deck-manage-row');
        if (row) deleteRule(row.getAttribute('data-id'));
      });
      elRuleList.addEventListener('change', function (e) {
        var inp = e.target;
        if (!inp || inp.getAttribute('data-role') !== 'name') return;
        var row = inp.closest ? inp.closest('.deck-manage-row') : null;
        if (row) renameRule(row.getAttribute('data-id'), inp.value);
      });
    }
  }

  /* ============================================================
   * 14. 外に出す口
   * ========================================================== */

  /** 画面を開いたとき（mode.js の setMode から）。ここで予定を凍結する */
  function onShow() {
    state.cur = null;
    render();
  }

  function onHide() {
    var port = speechPort();
    if (port) port.cancel();
  }

  /** localStorage を読み直して作り直す（同期で中身が入れ替わったとき用）。
      **答えている途中の問題は捨てない**（裏で同期が走るので、ここを捨てると
      答えを見ている最中に問題が入れ替わる） */
  function reloadFromStorage() {
    var curId = state.cur ? state.cur.item.id : '';
    var step = state.cur ? state.cur.step : '';
    var picked = state.cur ? state.cur.picked : -1;
    var typed = state.cur ? state.cur.typed : '';
    // **段も持ち越す。** ここで引き直すと、相手の端末の記録が届いて段が
    // 二択 → タイプに上がった瞬間に、二択で答えて答え合わせを見ている画面が
    // タイプの採点に化け、**自分の答えが「（書かなかった）」に置き換わって赤くなる**。
    // 「自分の答えは採点を押し終えるまで消さない」の約束を破るので、
    // いま出ている問題は**出したときの段のまま**最後まで終わらせる。
    var stage = state.cur ? state.cur.stage : '';

    load();

    if (curId && findItem(curId)) {
      var it = findItem(curId);
      var r = findRule(it.rule);
      if (r) {
        state.cur = {
          item: it, rule: r, stage: stage || activeStage(r),
          picked: picked, typed: typed, step: step || 'pick'
        };
      }
    } else {
      state.cur = null;
    }
    renderRuleSelect();
    render();
  }

  window.SUNKAN_GRAM = {
    /** 画面を開いた／離れたとき（mode.js から） */
    onShow: onShow,
    onHide: onHide,
    /** 同期が中身を入れ替えたあとに呼ぶ */
    reload: reloadFromStorage,
    /** 件数（同期の「2 台で見比べる」用） */
    counts: function () {
      return { rules: state.rules.length, items: state.items.length };
    }
  };

  /* ============================================================
   * 15. 起動
   * ========================================================== */

  /** 収録を入れる。**一度だけ。** 消したものが next 起動で戻ってこないように印を残す */
  function seedOnce() {
    if (lsGet(LS_SEEDED) === '1') return false;
    var hasAny = (readJSON(LS_RULES, null) !== null) || (readJSON(LS_ITEMS, null) !== null);
    lsSet(LS_SEEDED, '1');
    if (hasAny) return false;    // すでに自分のものが在るなら入れない

    var rules = [], items = [], i, n = 0;
    for (i = 0; i < SEED_RULES.length; i++) {
      rules.push({
        id: SEED_RULES[i].id, name: SEED_RULES[i].name, mode: SEED_RULES[i].mode,
        gate: SEED_RULES[i].gate, note: SEED_RULES[i].note, created: Date.now()
      });
    }
    for (i = 0; i < SEED_ITEMS.length; i++) {
      n += 1;
      items.push({
        id: 'gi-' + n, rule: SEED_ITEMS[i].rule, en: SEED_ITEMS[i].en,
        ja: SEED_ITEMS[i].ja, a: SEED_ITEMS[i].a,
        opt: sanitizeOpt(SEED_ITEMS[i].opt), alt: [], created: Date.now()
      });
    }
    writeJSON(LS_RULES, rules);
    writeJSON(LS_ITEMS, items);
    return true;
  }

  function load() {
    state.rules = sanitizeRules(readJSON(LS_RULES, []));
    state.items = sanitizeItems(readJSON(LS_ITEMS, []));
    state.srs = sanitizeSrsMap(readJSON(LS_SRS, {}));
    state.seen = sanitizeSeen(readJSON(LS_SEEN, {}));
    state.log = sanitizeLog(readJSON(LS_LOG, {}));

    var ui = sanitizeUI(readJSON(LS_UI, {}));
    state.rule = findRule(ui.rule) ? ui.rule : '';
    // 日が変わっていたら予定は捨てる（その日のぶんしか意味がない）
    state.session = (ui.session && ui.session.day === startOfDay(Date.now())) ? ui.session : null;
  }

  function init() {
    if (!elView || !elStage) return;    // DOM が想定と違うときは何もしない

    var port = speechPort();
    state.speechOK = !!(port && port.supported());
    if (elSpeak) elSpeak.hidden = !state.speechOK;

    seedOnce();
    load();
    renderRuleSelect();
    renderItemRuleSelect();
    bindEvents();

    /* **自分で data-mode を見る。** mode.js の init が setMode を呼ぶ時点では
       このファイルの口がまだ無いことがあり、onShow が来ない。それだと
       文法予測を開いた状態で起動したとき画面が空になる（listen.js と同じ）。 */
    if (docEl.getAttribute('data-mode') === 'gram') render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
