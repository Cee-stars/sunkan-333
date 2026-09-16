/* Duo — 取り込み（PDF・テキスト・表）
 *
 * **カードと瞬間英作文の両方**がここを通る。
 *
 * 「どんな PDF でも同じ形になる」を 2 本立てで満たす。
 *
 *   A. 決まった書き方の PDF … そのまま読む。AI も通信も要らない
 *   B. バラバラな PDF      … 「AI への指示」をコピーして AI に整えさせ、
 *                            返ってきた文字を貼り付ける
 *
 * どちらの道も、最後は同じパーサ（parseBlocks）を通る。だから出来上がる形は完全に同じ。
 * ブラウザだけで任意の PDF を正しく読み解くことはできないので、そこは正直に AI に投げて、
 * 代わりに「出口の形」を 1 つに固定することで揃えている。
 *
 * 保存には手を出さない。足すのは window.SUNKAN_CARDS.addCards と
 * window.SUNKAN_DRILL.addSentences 越しに限る。
 */
'use strict';

(function () {

  /* ============================================================
   * 1. 小物
   * ========================================================== */

  function $(id) { return document.getElementById(id); }
  function str(v) { return (v === null || v === undefined) ? '' : String(v); }
  function trim(v) { return str(v).trim(); }

  function cardsAPI() {
    var api = window.SUNKAN_CARDS;
    return (api && typeof api.addCards === 'function') ? api : null;
  }

  /** app.js が持っている表の割り方（TSV / CSV 自動判定）を借りる */
  function splitTable(text) {
    var api = window.SUNKAN_DRILL;
    if (api && typeof api.splitTable === 'function') return api.splitTable(text);
    // app.js が無い場面は無いはずだが、落とさない
    var body = str(text);
    var mark = body.indexOf('\t') >= 0 ? '\t' : ',';
    var rows = [];
    var lines = body.split(/\r\n|\r|\n/);
    for (var i = 0; i < lines.length; i++) {
      if (trim(lines[i])) rows.push(lines[i].split(mark));
    }
    return { rows: rows, delimiter: mark };
  }

  function copyText(text, done) {
    var api = window.SUNKAN_DRILL;
    if (api && typeof api.copyText === 'function') { api.copyText(text, done); return; }
    try {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } catch (e) { done(false); }
  }

  /* ============================================================
   * 2. 定数
   * ========================================================== */

  var PDF_LIB = 'assets/vendor/pdf.min.js';
  var PDF_WORKER = 'assets/vendor/pdf.worker.min.js';

  /** 一度に取り込む上限。多すぎると localStorage が溢れる */
  var MAX_CARDS = 2000;

  /** 見出しの言葉 → 中で使う名前。PDF から拾うので日本語の言い方も通す */
  var KEYS = {
    en: 'en', english: 'en', word: 'en', term: 'en',
    '英語': 'en', '語': 'en', '表現': 'en', '見出し': 'en',
    ja: 'ja', jp: 'ja', meaning: 'ja',
    '意味': 'ja', '日本語': 'ja', '訳語': 'ja',
    ex: 'exEn', example: 'exEn', sentence: 'exEn',
    '例文': 'exEn', '英文': 'exEn',
    exja: 'exJa', exjp: 'exJa', translation: 'exJa',
    '訳': 'exJa', '例文訳': 'exJa', '例文の訳': 'exJa', '和訳': 'exJa',
    memo: 'note', note: 'note',
    'メモ': 'note', '注': 'note', '補足': 'note'
  };

  /** 日本語（かな・カナ・漢字・句読点） */
  var CJK = /[ぁ-んァ-ヶ一-龠々〜ー、。「」（）]/;

  /**
   * PDF で折り返された行をつなぐ。
   * 英語どうしなら空白を挟み、日本語どうしならそのままつなげる
   * （「費用を減らす 賢いやり方」のように、要らない空白が入るのを防ぐ）。
   */
  function joinWrapped(head, tail) {
    var a = trim(head), b = trim(tail);
    if (!a) return b;
    if (!b) return a;
    var joinTight = CJK.test(a.charAt(a.length - 1)) && CJK.test(b.charAt(0));
    return a + (joinTight ? '' : ' ') + b;
  }

  /** 行の頭が「見出し:」になっているか */
  var KEY_LINE = /^\s*([A-Za-z]{1,6}|[ぁ-んァ-ヶ一-龠]{1,5})\s*[:：]\s*(.*)$/;

  /** 1 枚の区切り */
  var SEPARATOR = /^\s*(-{3,}|={3,}|\*{3,}|—{3,}|・{3,})\s*$/;

  /** セット名の指定（# セット: 〜） */
  var DECK_LINE = /^\s*#+\s*(?:セット名?|deck|set)\s*[:：]\s*(.+)$/i;

  var CARD_PROMPT = [
    'この PDF（資料）から、英語学習用のフラッシュカードを作ってください。',
    '',
    '出力は下の形式の文字だけを、そのまま返してください。',
    'コードブロック・前置き・説明・通し番号・箇条書きは一切付けないでください。',
    '',
    'EN: 覚える英語の語または表現（原形で）',
    'JA: その日本語の意味（20 字以内で簡潔に）',
    'EX: その語を使った英語の例文（8〜15 語程度の自然な 1 文）',
    'EXJA: EX の日本語訳（自然な日本語で）',
    'MEMO: 使い方の注意が 1 つだけあれば 20 字以内で。無ければこの行ごと省く',
    '---',
    '',
    'ルール:',
    '- 1 枚につき上の形で書き、そのあとに --- を必ず入れる',
    '- EX は必ず EN の語を含める（活用した形でよい）',
    '- 資料に例文があればそれを使い、無ければ自然な例文を作る',
    '- EN と JA と EX と EXJA は必ず埋める。空にしない',
    '- 1 枚ぶんを 1 行にまとめず、上のとおり 1 項目 1 行で書く',
    '- 同じ語を 2 枚作らない',
    '- 固有名詞・記号・数字だけの項目はカードにしない',
    '- 資料に出てくる語だけを使い、勝手に語を足さない',
    '- 最大 100 枚まで',
    '',
    '例:',
    'EN: take after',
    'JA: 〜に似ている',
    'EX: She takes after her mother in both looks and temper.',
    'EXJA: 彼女は見た目も気性も母親に似ている。',
    'MEMO: 家族の話で頻出',
    '---'
  ].join('\n');

  var CARD_TEMPLATE = [
    '# セット: サンプル',
    '',
    '# この形で書いた PDF・テキストは、Duo がそのまま読み込めます。',
    '# 使う見出しは EN / JA / EX / EXJA / MEMO の 5 つだけ。',
    '# 英語: 意味: 例文: 訳: メモ: と日本語で書いてもかまいません。',
    '# --- が 1 枚の区切りです。MEMO と EXJA は空でも通ります。',
    '# 長い文が途中で折り返されていても、続きとしてつなげて読みます。',
    '',
    'EN: take after',
    'JA: 〜に似ている',
    'EX: She takes after her mother in both looks and temper.',
    'EXJA: 彼女は見た目も気性も母親に似ている。',
    'MEMO: 家族の話で頻出',
    '---',
    'EN: put off',
    'JA: 延期する',
    'EX: They put off the meeting until Friday afternoon.',
    'EXJA: 彼らは会議を金曜の午後まで延期した。',
    '---',
    'EN: come up with',
    'JA: 思いつく',
    'EX: She came up with a clever way to cut the cost.',
    'EXJA: 彼女は費用を減らす賢いやり方を思いついた。',
    '---'
  ].join('\n');

  /* --- 瞬間英作文（日本語の文 → 英文）用 --- */

  var DRILL_PROMPT = [
    'この PDF（資料）から、瞬間英作文の練習に使う「日本語の文 → 英文」の組を作ってください。',
    '',
    '出力は下の形式の文字だけを、そのまま返してください。',
    'コードブロック・前置き・説明・通し番号・箇条書きは一切付けないでください。',
    '',
    'JA: 日本語の文',
    'EN: その英訳',
    'MEMO: つまずきやすい所が 1 つだけあれば 20 字以内で。無ければこの行ごと省く',
    '---',
    '',
    'ルール:',
    '- 1 組につき上の形で書き、そのあとに --- を必ず入れる',
    '- JA と EN は必ず埋める。空にしない',
    '- **必ず文にする。単語や句だけにしない**（瞬間英作文は文を口に出す練習なので、',
    '  「late」のような単語だけだと出題できない）',
    '- 英文は 8〜15 語程度の自然な 1 文にする',
    '- 日本語は、そのまま口に出せる自然な言い方にする（直訳調にしない）',
    '- 資料に出てくる語や表現を使った文にする。勝手に関係のない話を足さない',
    '- 同じ文を 2 つ作らない',
    '- 1 組を 1 行にまとめず、上のとおり 1 項目 1 行で書く',
    '- 最大 100 組まで',
    '',
    '例:',
    'JA: 私は毎朝コーヒーを飲みます。',
    'EN: I drink coffee every morning.',
    '---',
    'JA: 彼女は見た目も気性も母親に似ている。',
    'EN: She takes after her mother in both looks and temper.',
    'MEMO: take after = 〜に似ている',
    '---'
  ].join('\n');

  var DRILL_TEMPLATE = [
    '# セット: サンプル',
    '',
    '# この形で書いた PDF・テキストは、瞬間英作文がそのまま読み込めます。',
    '# 使う見出しは JA / EN / MEMO の 3 つだけ。',
    '# 日本語: 英語: メモ: と書いてもかまいません。',
    '# --- が 1 組の区切りです。MEMO は空でも通ります。',
    '# 長い文が途中で折り返されていても、続きとしてつなげて読みます。',
    '',
    'JA: 私は毎朝コーヒーを飲みます。',
    'EN: I drink coffee every morning.',
    '---',
    'JA: 彼は今どこにいますか。',
    'EN: Where is he now?',
    '---',
    'JA: 彼女は見た目も気性も母親に似ている。',
    'EN: She takes after her mother in both looks and temper.',
    'MEMO: take after = 〜に似ている',
    '---'
  ].join('\n');

  /* ============================================================
   * 3. 決まった書き方を読む
   * ========================================================== */

  /**
   * 「EN: 〜」の並びからカードを起こす。
   *
   * PDF から拾った文字は、1 つの文が途中で折り返されていることが多い。
   * 行の頭が「見出し:」でなければ、前の見出しの続きとしてつなげる。ここが要。
   *
   * @returns {{items:Array, deckName:string}}
   */
  function parseBlocks(text) {
    var lines = str(text).split(/\r\n|\r|\n/);
    var items = [];
    var deckName = '';
    var cur = null;
    var lastKey = '';

    function flush() {
      if (!cur) return;
      if (trim(cur.en) && (trim(cur.ja) || trim(cur.exJa))) items.push(cur);
      cur = null;
      lastKey = '';
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var bare = trim(line);

      // セット名の指定
      var deckHit = bare.match(DECK_LINE);
      if (deckHit) { deckName = trim(deckHit[1]); continue; }

      // 区切り
      if (SEPARATOR.test(bare)) { flush(); continue; }

      // 空行は「続き」を切るだけ。1 枚の区切りにはしない
      // （PDF は段落の間に空行が入りがちで、区切りにすると 1 枚が割れる）
      if (!bare) { lastKey = ''; continue; }

      // 覚え書きの行（# で始まる）は読み飛ばす
      if (bare.charAt(0) === '#') continue;

      var hit = bare.match(KEY_LINE);
      var key = hit ? KEYS[hit[1].toLowerCase()] : null;

      if (key) {
        // 区切りが抜けていても、EN が 2 回来たら次の 1 枚と見なす
        if (key === 'en' && cur && trim(cur.en)) flush();
        if (!cur) cur = { en: '', ja: '', exEn: '', exJa: '', note: '' };
        cur[key] = trim(hit[2]);
        lastKey = key;
        continue;
      }

      // 見出しの付いていない行 … 直前の見出しの続き
      if (cur && lastKey) {
        cur[lastKey] = joinWrapped(cur[lastKey], bare);
      }
    }
    flush();

    return { items: items.slice(0, MAX_CARDS), deckName: deckName };
  }

  /**
   * タブ区切り・カンマ区切りの表を読む。
   * 列は左から 英語 / 意味 / 例文 / 訳 / メモ。
   */
  function parseTable(text) {
    var split = splitTable(text);
    var rows = split.rows || [];
    var items = [];

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i] || [];
      var en = trim(row[0]);
      var ja = trim(row[1]);
      var exEn = trim(row[2]);
      var exJa = trim(row[3]);
      if (!en) continue;

      // 意味も例文も無い行は表ではなくただの文章。ここで弾かないと、
      // ふつうの文書を貼っただけで 1 行 1 枚のゴミ札が大量にできる。
      if (!ja && !exJa) continue;

      // 見出し行が付いていれば外す
      if (i === 0 && /^(en|english|英語|語|表現)$/i.test(en)) continue;

      items.push({
        en: en, ja: ja,
        exEn: exEn, exJa: exJa, note: trim(row[4])
      });
    }
    return { items: items.slice(0, MAX_CARDS), deckName: '' };
  }

  /**
   * 「見出し:」の形で書かれているか。
   *
   * 表として読むか、ブロックとして読むかの分かれ目。瞬間英作文は表の列の並びが
   * こちらと逆（1 列目が日本語）なので、**表はあちらに任せて、こちらはブロックだけ**を見る。
   * その判定にこれを使う。
   */
  function looksBlock(text) {
    var lines = str(text).split(/\r\n|\r|\n/);
    var keyed = 0;
    for (var i = 0; i < lines.length; i++) {
      var hit = trim(lines[i]).match(KEY_LINE);
      if (hit && KEYS[hit[1].toLowerCase()]) keyed++;
      if (keyed >= 2) return true;
    }
    return false;
  }

  /**
   * 読み取った中身を、瞬間英作文の {ja, en, note} に直す。
   *
   * **単語カードの形（EX / EXJA がある）で書かれていても使えるようにする。**
   * 瞬間英作文は文を口に出す練習なので、語そのものではなく**例文のほうを出題に回す**。
   * カード用に作った PDF がそのまま瞬間英作文でも使える、ということ。
   * そのとき、見出しの語は答え合わせのときのメモに入れておく。
   *
   * @returns {{items:Array, fromExample:number}}
   */
  function toDrillPairs(items) {
    var out = [], fromExample = 0;
    var list = items || [];

    for (var i = 0; i < list.length; i++) {
      var it = list[i] || {};
      var ja, en, note;

      if (trim(it.exEn) && trim(it.exJa)) {
        // 単語カードの形 … 例文を出題に、見出しの語はメモへ
        ja = trim(it.exJa);
        en = trim(it.exEn);
        var head = trim(it.en);
        if (head && trim(it.ja)) head += '（' + trim(it.ja) + '）';
        note = [head, trim(it.note)].filter(Boolean).join(' / ');
        fromExample++;
      } else {
        ja = trim(it.ja);
        en = trim(it.en);
        note = trim(it.note);
      }
      if (!ja || !en) continue;
      out.push({ ja: ja, en: en, note: note });
    }
    return { items: out, fromExample: fromExample };
  }

  /**
   * どちらの書き方かを見分けて読む。
   * 「見出し:」の行がひとつでもあればブロック、無ければ表として扱う。
   */
  function parseAny(text) {
    if (looksBlock(text)) return parseBlocks(text);

    var table = parseTable(text);
    if (table.items.length) return table;
    return parseBlocks(text);   // 表としても読めないなら、ブロックの結果（と理由）を返す
  }

  /* ============================================================
   * 4. PDF を読む
   * ========================================================== */

  var pdfLoading = null;

  /** pdf.js を必要になったときだけ読み込む（1.5MB あるので起動では読まない） */
  function loadPdfLib() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (pdfLoading) return pdfLoading;

    pdfLoading = new Promise(function (resolve, reject) {
      var tag = document.createElement('script');
      tag.src = PDF_LIB;
      tag.onload = function () {
        if (!window.pdfjsLib) { reject(new Error('pdf.js を読み込めませんでした。')); return; }
        try {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
        } catch (e) { /* 既定のままでも動くことがある */ }
        resolve(window.pdfjsLib);
      };
      tag.onerror = function () { reject(new Error('pdf.js を読み込めませんでした。')); };
      document.head.appendChild(tag);
    });
    return pdfLoading;
  }

  /**
   * 1 ページぶんの文字を、行に組み直す。
   *
   * pdf.js が返すのは「文字のかたまり」であって行ではない。
   * そのまま continue すると単語がばらばらに並ぶので、縦の位置 (transform[5]) が
   * ほぼ同じものを 1 行にまとめる。
   */
  function pageToLines(content) {
    var items = (content && content.items) || [];
    var lines = [];
    var cur = null;

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var text = str(it.str);

      if (!text) {
        if (it.hasEOL) cur = null;
        continue;
      }
      var y = it.transform ? Math.round(it.transform[5]) : 0;

      if (!cur || Math.abs(cur.y - y) > 2) {
        cur = { y: y, parts: [] };
        lines.push(cur);
      }
      cur.parts.push(text);
      if (it.hasEOL) cur = null;
    }

    var out = [];
    for (var k = 0; k < lines.length; k++) {
      var line = lines[k].parts.join('').replace(/\s+/g, ' ').trim();
      if (line) out.push(line);
    }
    return out;
  }

  /** PDF のファイルから、行に組み直した文字ぜんぶを取り出す */
  function pdfToText(file, onProgress) {
    return loadPdfLib().then(function (lib) {
      return file.arrayBuffer().then(function (buf) {
        return lib.getDocument({ data: new Uint8Array(buf) }).promise;
      });
    }).then(function (doc) {
      var all = [];
      var page = 1;

      function nextPage() {
        if (page > doc.numPages) return Promise.resolve(all.join('\n'));
        if (onProgress) onProgress(page, doc.numPages);
        return doc.getPage(page).then(function (p) {
          return p.getTextContent();
        }).then(function (content) {
          all = all.concat(pageToLines(content));
          page++;
          return nextPage();
        });
      }
      return nextPage();
    });
  }

  /* ============================================================
   * 5. 画面
   * ========================================================== */

  var elDialog = $('card-import-dialog');
  var elOpenBtn = $('btn-card-import');
  var elName = $('card-import-name');
  var elText = $('card-import-text');
  var elPreview = $('card-import-preview');
  var elSave = $('btn-card-import-save');
  var elCancel = $('btn-card-import-cancel');

  var elPdfBtn = $('btn-card-pdf');
  var elPdfFile = $('card-pdf-file');
  var elPdfStatus = $('card-pdf-status');
  var elTemplateBtn = $('btn-card-template');
  var elPromptBtn = $('btn-card-prompt');
  var elPromptStatus = $('card-prompt-status');
  var elTarget = $('card-import-target');
  var elNameField = $('card-import-name-field');

  /** セット名を、こちらが勝手に入れたものか（人が打ったものは上書きしない） */
  var nameAuto = false;

  /**
   * 「入れ先」の選択肢を作る。
   *
   * **いま開いているセットを初期値にする。** 毎回 新しいセットを作らせると、
   * 少し足したいだけでもセットが増えていって続かない。
   */
  function renderTarget() {
    if (!elTarget) return;
    var api = window.SUNKAN_CARDS;
    var decks = (api && typeof api.decks === 'function') ? api.decks() : [];
    var keep = elTarget.value;

    while (elTarget.firstChild) elTarget.removeChild(elTarget.firstChild);

    var fresh = document.createElement('option');
    fresh.value = '';
    fresh.textContent = '＋ 新しいセットを作る';
    elTarget.appendChild(fresh);

    var known = {};
    for (var i = 0; i < decks.length; i++) {
      known[decks[i].id] = true;
      var opt = document.createElement('option');
      opt.value = decks[i].id;
      opt.textContent = decks[i].name + '（' + decks[i].count + '）';
      elTarget.appendChild(opt);
    }

    var current = (api && typeof api.currentDeckId === 'function') ? api.currentDeckId() : '';
    var want = known[keep] ? keep : current;
    elTarget.value = known[want] ? want : '';
    syncTargetField();
  }

  /** 新しいセットを選んだときだけ、名前の欄を出す */
  function syncTargetField() {
    if (!elNameField) return;
    elNameField.hidden = !!(elTarget && elTarget.value);
  }

  /** いま選ばれている入れ先の名前（新しく作るときは空） */
  function targetName() {
    if (!elTarget || !elTarget.value) return '';
    var opt = elTarget.options[elTarget.selectedIndex];
    return opt ? opt.textContent.replace(/（\d+）$/, '') : '';
  }

  /**
   * セット名を自動で埋める。
   * 順番は「人が打った名前 > 中身に書いてある # セット: > ファイル名」。
   * ファイル名を先に入れてしまうので、あとから中身の名前で上書きできるようにしてある。
   */
  function autofillName(value) {
    if (!elName) return;
    var name = trim(value);
    if (!name) return;
    if (trim(elName.value) && !nameAuto) return;   // 人が打ったものは触らない
    elName.value = name;
    nameAuto = true;
  }

  function openDialog() {
    if (!elDialog) return;
    if (elPreview) elPreview.textContent = '';
    if (elPdfStatus) elPdfStatus.textContent = '';
    if (elPromptStatus) elPromptStatus.textContent = '';
    renderTarget();   // セットは増えているかもしれないので毎回作り直す
    if (typeof elDialog.showModal === 'function') {
      if (!elDialog.open) elDialog.showModal();
    } else {
      elDialog.setAttribute('open', 'open');
    }
    // いちばん上（入れ先）から見せる。中ほどの欄に焦点を当てると、
    // ダイアログがそこまでスクロールした状態で開き、**入れ先を見落とす**。
    elDialog.scrollTop = 0;
    if (elTarget) elTarget.focus();
  }

  function closeDialog() {
    if (!elDialog) return;
    if (typeof elDialog.close === 'function') {
      if (elDialog.open) elDialog.close();
    } else {
      elDialog.removeAttribute('open');
    }
  }

  /** 貼り付けた中身を読んで、何枚できるかを先に見せる */
  function preview() {
    if (!elPreview) return;
    var text = str(elText && elText.value);
    if (!trim(text)) { elPreview.textContent = ''; return; }

    var parsed = parseAny(text);
    if (!parsed.items.length) {
      elPreview.textContent = 'カードとして読めませんでした。EN: JA: EX: EXJA: の書き方か、' +
        '英語 / 意味 / 例文 / 訳 の 4 列の表にしてください。';
      return;
    }
    var withEx = 0;
    for (var i = 0; i < parsed.items.length; i++) {
      if (trim(parsed.items[i].exEn)) withEx++;
    }
    // どこに入るのかを先に言う。押すまで分からないのがいちばん困る
    var into = targetName();
    elPreview.textContent = (into ? '「' + into + '」に ' : '') +
      parsed.items.length + ' 枚ぶん読めました' +
      '（うち例文つき ' + withEx + ' 枚）。' +
      (withEx < parsed.items.length ? '例文の無い札は「聞く」「言う」の面が弱くなります。' : '');

    if (!targetName()) autofillName(parsed.deckName);   // 新しく作るときだけ
  }

  function save() {
    var api = cardsAPI();
    if (!api) return;

    var text = str(elText && elText.value);
    var parsed = parseAny(text);

    if (!parsed.items.length) {
      if (elPreview) elPreview.textContent = '読み込めるカードがありませんでした。';
      return;
    }
    var targetId = elTarget ? trim(elTarget.value) : '';
    var name = trim(elName && elName.value) || parsed.deckName || '取り込んだカード';
    var result = api.addCards(name, parsed.items, targetId);

    closeDialog();
    if (elText) elText.value = '';
    if (elName) elName.value = '';
    nameAuto = false;
    if (elPreview) elPreview.textContent = '';

    api.flash('「' + result.deckName + '」に ' + result.added + ' 枚入れました' +
      (result.skipped ? '（' + result.skipped + ' 枚は同じものか中身が足りないので飛ばしました）' : '') + '。');
  }

  function pickFile() {
    if (elPdfFile) elPdfFile.click();
  }

  function onFile() {
    if (!elPdfFile || !elPdfFile.files || !elPdfFile.files.length) return;
    var file = elPdfFile.files[0];
    var isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';

    // ファイル名はとりあえずの名前。中身に # セット: があれば、あとで上書きする
    autofillName(file.name.replace(/\.(pdf|txt|md)$/i, ''));

    // PDF でないものは、そのまま文字として読む
    if (!isPdf) {
      var reader = new FileReader();
      reader.onload = function () {
        if (elText) elText.value = str(reader.result);
        if (elPdfStatus) elPdfStatus.textContent = file.name + ' を読みました。';
        preview();
      };
      reader.onerror = function () {
        if (elPdfStatus) elPdfStatus.textContent = 'ファイルを読めませんでした。';
      };
      reader.readAsText(file);
      elPdfFile.value = '';
      return;
    }

    if (elPdfStatus) elPdfStatus.textContent = 'PDF を読んでいます…';
    if (elPdfBtn) elPdfBtn.disabled = true;

    pdfToText(file, function (page, total) {
      if (elPdfStatus) elPdfStatus.textContent = 'PDF を読んでいます… ' + page + ' / ' + total + ' ページ';
    }).then(function (text) {
      if (elText) elText.value = text;
      if (elPdfBtn) elPdfBtn.disabled = false;

      var parsed = parseAny(text);
      if (!parsed.items.length) {
        if (elPdfStatus) {
          elPdfStatus.textContent = file.name + ' の文字は取れましたが、決まった書き方ではありませんでした。' +
            '下の「AI への指示をコピー」を使って整えてから貼り付けてください。';
        }
      } else if (elPdfStatus) {
        elPdfStatus.textContent = file.name + ' を読みました。';
      }
      preview();
    }).catch(function (err) {
      if (elPdfBtn) elPdfBtn.disabled = false;
      if (elPdfStatus) {
        elPdfStatus.textContent = 'PDF を読めませんでした（' +
          ((err && err.message) || '理由は分かりません') + '）。' +
          '文字ではなく画像として取り込まれた PDF は読めません。その場合は AI への指示を使ってください。';
      }
    });

    elPdfFile.value = '';   // 同じファイルをもう一度選べるように
  }

  function copyPrompt() {
    copyText(CARD_PROMPT, function (ok) {
      if (!elPromptStatus) return;
      elPromptStatus.textContent = ok
        ? 'コピーしました。PDF といっしょに AI へ渡してください。'
        : 'コピーできませんでした。長押しで選んでコピーしてください。';
    });
  }

  function downloadTemplate() {
    try {
      var blob = new Blob(['﻿' + CARD_TEMPLATE], { type: 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'duo-カードの書き方.txt';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      if (elPdfStatus) elPdfStatus.textContent = '見本を書き出しました。この形で書けば、そのまま読み込めます。';
    } catch (e) {
      // 書き出せない端末では、欄に入れてしまうほうが早い
      if (elText) elText.value = CARD_TEMPLATE;
      preview();
      if (elPdfStatus) elPdfStatus.textContent = '見本を下の欄に入れました。';
    }
  }

  function bindEvents() {
    if (elOpenBtn) elOpenBtn.addEventListener('click', openDialog);
    if (elCancel) elCancel.addEventListener('click', closeDialog);
    if (elSave) elSave.addEventListener('click', save);
    if (elText) {
      elText.addEventListener('input', preview);
      elText.addEventListener('paste', function () { window.setTimeout(preview, 0); });
    }
    if (elName) {
      // 人が打ったら、こちらからは触らない
      elName.addEventListener('input', function () { nameAuto = false; });
    }
    if (elTarget) {
      elTarget.addEventListener('change', function () {
        syncTargetField();
        preview();     // 「どこに入るか」の言い方が変わる
      });
    }
    if (elPdfBtn) elPdfBtn.addEventListener('click', pickFile);
    if (elPdfFile) elPdfFile.addEventListener('change', onFile);
    if (elPromptBtn) elPromptBtn.addEventListener('click', copyPrompt);
    if (elTemplateBtn) elTemplateBtn.addEventListener('click', downloadTemplate);

    bindDrill();
  }

  /* ============================================================
   * 6. 瞬間英作文のがわ
   *
   * 中身を解いて保存するのは app.js（parseImportText → 「読み込む」）。
   * こちらは **PDF を文字にして欄へ入れるところまで**と、AI への指示・見本だけを持つ。
   * 欄へ入れたあとは input を投げて、向こうの下読みに拾わせる（二重に解かない）。
   * ========================================================== */

  var elDrillText = $('import-text');
  var elDrillName = $('import-name');
  var elDrillPdfBtn = $('btn-drill-pdf');
  var elDrillPdfFile = $('drill-pdf-file');
  var elDrillPdfStatus = $('drill-pdf-status');
  var elDrillPromptBtn = $('btn-drill-prompt');
  var elDrillTemplateBtn = $('btn-drill-template');
  var elDrillPromptStatus = $('drill-prompt-status');

  var drillNameAuto = false;

  function drillNotify() {
    if (!elDrillText) return;
    // app.js の下読みは input で動く。値を入れただけでは動かない
    try {
      elDrillText.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (e) {
      var ev = document.createEvent('Event');
      ev.initEvent('input', true, true);
      elDrillText.dispatchEvent(ev);
    }
  }

  function drillFillName(value) {
    if (!elDrillName) return;
    var name = trim(value);
    if (!name) return;
    if (trim(elDrillName.value) && !drillNameAuto) return;
    elDrillName.value = name;
    drillNameAuto = true;
  }

  function onDrillFile() {
    if (!elDrillPdfFile || !elDrillPdfFile.files || !elDrillPdfFile.files.length) return;
    var file = elDrillPdfFile.files[0];
    var isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';

    drillFillName(file.name.replace(/\.(pdf|txt|md)$/i, ''));

    if (!isPdf) {
      var reader = new FileReader();
      reader.onload = function () {
        if (elDrillText) elDrillText.value = str(reader.result);
        drillFillName(parseAny(str(reader.result)).deckName);
        if (elDrillPdfStatus) elDrillPdfStatus.textContent = file.name + ' を読みました。';
        drillNotify();
      };
      reader.onerror = function () {
        if (elDrillPdfStatus) elDrillPdfStatus.textContent = 'ファイルを読めませんでした。';
      };
      reader.readAsText(file);
      elDrillPdfFile.value = '';
      return;
    }

    if (elDrillPdfStatus) elDrillPdfStatus.textContent = 'PDF を読んでいます…';
    if (elDrillPdfBtn) elDrillPdfBtn.disabled = true;

    pdfToText(file, function (page, total) {
      if (elDrillPdfStatus) {
        elDrillPdfStatus.textContent = 'PDF を読んでいます… ' + page + ' / ' + total + ' ページ';
      }
    }).then(function (text) {
      if (elDrillText) elDrillText.value = text;
      if (elDrillPdfBtn) elDrillPdfBtn.disabled = false;
      drillFillName(parseAny(text).deckName);

      if (elDrillPdfStatus) {
        elDrillPdfStatus.textContent = looksBlock(text)
          ? file.name + ' を読みました。'
          : file.name + ' の文字は取れましたが、決まった書き方ではありませんでした。' +
            '下の「AI への指示をコピー」を使って整えてから貼り付けてください。';
      }
      drillNotify();
    }).catch(function (err) {
      if (elDrillPdfBtn) elDrillPdfBtn.disabled = false;
      if (elDrillPdfStatus) {
        elDrillPdfStatus.textContent = 'PDF を読めませんでした（' +
          ((err && err.message) || '理由は分かりません') + '）。' +
          '文字ではなく画像として取り込まれた PDF は読めません。その場合は AI への指示を使ってください。';
      }
    });

    elDrillPdfFile.value = '';   // 同じファイルをもう一度選べるように
  }

  function bindDrill() {
    if (elDrillPdfBtn) {
      elDrillPdfBtn.addEventListener('click', function () {
        if (elDrillPdfFile) elDrillPdfFile.click();
      });
    }
    if (elDrillPdfFile) elDrillPdfFile.addEventListener('change', onDrillFile);
    if (elDrillName) {
      elDrillName.addEventListener('input', function () { drillNameAuto = false; });
    }
    if (elDrillPromptBtn) {
      elDrillPromptBtn.addEventListener('click', function () {
        copyText(DRILL_PROMPT, function (ok) {
          if (!elDrillPromptStatus) return;
          elDrillPromptStatus.textContent = ok
            ? 'コピーしました。PDF といっしょに AI へ渡してください。'
            : 'コピーできませんでした。長押しで選んでコピーしてください。';
        });
      });
    }
    if (elDrillTemplateBtn) {
      elDrillTemplateBtn.addEventListener('click', function () {
        try {
          var blob = new Blob(['﻿' + DRILL_TEMPLATE], { type: 'text/plain;charset=utf-8' });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = 'duo-瞬間英作文の書き方.txt';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
          if (elDrillPdfStatus) {
            elDrillPdfStatus.textContent = '見本を書き出しました。この形で書けば、そのまま読み込めます。';
          }
        } catch (e) {
          if (elDrillText) elDrillText.value = DRILL_TEMPLATE;
          drillNotify();
          if (elDrillPdfStatus) elDrillPdfStatus.textContent = '見本を下の欄に入れました。';
        }
      });
    }
  }

  /* ============================================================
   * 7. 外に出す口（app.js / cards.js / 試すため）
   * ========================================================== */

  window.SUNKAN_IMPORT = {
    /** 文字から中身を起こす（書き方は自動で見分ける）。{items, deckName} */
    parse: parseAny,
    parseBlocks: parseBlocks,
    parseTable: parseTable,
    /** 「見出し:」の形で書かれているか。表として読むかの分かれ目 */
    looksBlock: looksBlock,
    /** 読み取った中身を瞬間英作文の {ja,en,note} に直す。{items, fromExample} */
    toDrillPairs: toDrillPairs,
    /** PDF のファイルから文字を取り出す */
    pdfToText: pdfToText,
    /** AI に渡す指示文 */
    cardPrompt: CARD_PROMPT,
    drillPrompt: DRILL_PROMPT,
    /** 決まった書き方の見本 */
    cardTemplate: CARD_TEMPLATE,
    drillTemplate: DRILL_TEMPLATE
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindEvents);
  } else {
    bindEvents();
  }
})();
