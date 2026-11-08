/* リスニングのプレイリスト（聞く文を入れ物で分ける）。
 *
 * 使い方:
 *   python3 -m http.server 8599 --bind 127.0.0.1 &
 *   node tests/playlisttest.mjs
 *
 * 見ているのは次のこと。
 *   ・操作列の**いちばん上**に `#listen-deck`（絞り込みの欄）がある
 *   ・プレイリストを作れる／**空では作れない**／**同じ名前は作れない**（理由も出る）
 *   ・追加ダイアログの**いちばん上**に「入れ先」がある。取り込みダイアログにもある
 *   ・「＋ 新しいプレイリスト」を選んだときだけ名前の欄が出る
 *   ・入れ先ごとに文を足せる（`deck` に入る。**`''` は未分類**）
 *   ・選ぶと**その文だけ**になる。「すべて」と「未分類」も効く
 *   ・欄に出る件数が合っている
 *   ・名前を変えられる（id も中の文の `deck` も動かない）
 *   ・**消しても中の文は消えない**（`deck` が `''` に戻って未分類へ）。鍵は `listendeck:<id>`
 *   ・読み直しても残る。選んでいたものを `sunkan:listen:ui` が覚えている
 *   ・**古い形（`deck` の無い文）**を入れておいても落ちない・未分類に出る
 *   ・長い名前でも横スクロールが出ない
 *   ・JS のエラーが出ていない
 *
 * **iPhone 幅 390 と Mac 幅 1180 の両方**で通します。
 *
 * 押すものは id で指し、**無ければ見える字（本文・aria-label・title）で当てる**
 * （id は担当しだいなので、名前が変わっても見張りが死なないように）。
 * 390 では道具が重なるので、押すのは必ず「印を付けた 1 つ」。座標では押さない。
 * `CSS.escape` は Node のがわでは使えないので使わない。
 */
import fs from 'node:fs';
const PLAYWRIGHT = process.env.PLAYWRIGHT_PKG || '/opt/node-tools/node_modules/playwright/index.mjs';
const { chromium } = await import(PLAYWRIGHT);
const APP = `http://127.0.0.1:${process.env.PORT || '8599'}/`;
const EXEC = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + (e ? '  → ' + e : ''))); };

/* ---------- 入れるもの ---------- */

// プレイリストの名前。**数字を入れない**（欄に出る件数を数字で読み取るため）
const P1 = '朝のニュース';
const P2 = 'あさのニュース帳';     // 名前を変えたあと
const PLONG = 'とても長い名前のプレイリストで操作列が横に伸びないかどうかを確かめるためのもの';

// 英文は**スラッシュ入りのまま**。スラッシュが出す単位になる
const OLD = { en: 'The old one / has no deck.', ja: '古い形の / 文です。', mark: 'old one' };
const ONE = { en: 'Morning news / is on the radio.', ja: '朝のニュースが / 流れている。', mark: 'radio' };
const TWO = { en: 'Keep this one / without a playlist.', ja: 'これは / 入れ物なしのまま。', mark: 'without a playlist' };

const LS_ITEMS = 'sunkan:listen:items';
const LS_DECKS = 'sunkan:listen:decks';
const LS_UI = 'sunkan:listen:ui';

const ROWS = '#listen-rows';
const ROW = '#listen-rows .row';
const HIT = '[data-pt-hit="1"]';      // いま押そうとしている 1 つ
const FIELD = '[data-pt-field="1"]';  // いま書き込もうとしている欄
const SEL = '[data-pt-sel="1"]';      // いま選ぼうとしている <select>

/** 正規表現に入れる前に逃がす（名前に記号が入っても壊れないように） */
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ---------- 画面のがわで使う道具（読み直しても要るので addInitScript） ---------- */

const INIT = () => {
  const clear = attr => {
    const old = document.querySelectorAll('[' + attr + ']');
    for (let i = 0; i < old.length; i++) old[i].removeAttribute(attr);
  };
  const words = el => [
    (el.textContent || '').trim(),
    el.getAttribute('aria-label') || '',
    el.getAttribute('title') || ''
  ];
  const shown = el => !!el.getClientRects().length;

  window.__PT = {
    /** 見える字のどれかが当たる、押せるものに印を付ける */
    mark(pattern, near) {
      clear('data-pt-hit');
      const re = new RegExp(pattern);
      const all = Array.prototype.slice.call(document.querySelectorAll(
        'button, [role="button"], a[href], summary, label, li'));
      let hits = all.filter(function (el) {
        if (!shown(el) || el.disabled) return false;
        return words(el).some(function (w) { return w && re.test(w); });
      });
      if (near) {
        // 同じ字のボタンが並ぶ（プレイリストごとの「変える」「消す」）ので、
        // **その名前の近く**にあるものを選ぶ
        const close = hits.filter(function (el) {
          let p = el, n = 0;
          while (p && n < 5) {
            if (words(p).some(function (w) { return w.indexOf(near) >= 0; })) return true;
            p = p.parentElement; n++;
          }
          return false;
        });
        if (close.length) hits = close;
      }
      // いちばん内側（当たりの中に別の当たりを含まないもの）を採る
      const inner = hits.filter(function (el) {
        return !hits.some(function (o) { return o !== el && el.contains(o); });
      });
      const el = inner[0] || hits[0] || null;
      if (!el) return false;
      el.setAttribute('data-pt-hit', '1');
      return true;
    },

    /** 名前を書き込む欄に印を付ける（開いているダイアログの中を先に見る） */
    markField() {
      clear('data-pt-field');
      const scope = document.querySelector('dialog[open]') || document;
      const around = el => {
        let t = '';
        const lab = el.id ? document.querySelector('label[for="' + el.id + '"]') : null;
        if (lab) t += lab.textContent || '';
        const wrap = el.closest ? el.closest('label') : null;
        if (wrap) t += wrap.textContent || '';
        return t + ' ' + (el.placeholder || '') + ' ' + (el.getAttribute('aria-label') || '');
      };
      const list = Array.prototype.slice.call(scope.querySelectorAll('input'))
        .filter(function (el) { return (!el.type || el.type === 'text') && shown(el); });
      const named = list.filter(function (el) { return /名前|プレイリスト/.test(around(el)); });
      const el = named[0] || list[0] || null;
      if (!el) return false;
      el.setAttribute('data-pt-field', '1');
      return true;
    },

    /** 一覧の中から、その名前の行（と、その中の名前の欄）に印を付ける */
    markDeckRow(name) {
      clear('data-pt-row');
      clear('data-pt-field');
      const scope = document.querySelector('dialog[open]') || document;
      const input = Array.prototype.slice.call(scope.querySelectorAll('input'))
        .filter(function (el) { return shown(el) && (el.value || '').trim() === name; })[0] || null;
      let row = input && input.closest ? input.closest('li, tr, .row, div') : null;
      if (!row) {
        row = Array.prototype.slice.call(scope.querySelectorAll('li, tr'))
          .filter(function (el) { return shown(el) && (el.textContent || '').indexOf(name) >= 0; })[0] || null;
      }
      if (input) input.setAttribute('data-pt-field', '1');
      if (row) row.setAttribute('data-pt-row', '1');
      return { field: !!input, row: !!row };
    },

    /** 印を付けた行の中のボタンに印を付ける（行が無ければダイアログの中から） */
    markRowButton(pattern) {
      const row = document.querySelector('[data-pt-row="1"]');
      clear('data-pt-hit');
      const re = new RegExp(pattern);
      const scope = row || document.querySelector('dialog[open]') || document;
      const el = Array.prototype.slice.call(scope.querySelectorAll('button, [role="button"]'))
        .filter(function (b) {
          if (!shown(b) || b.disabled) return false;
          return words(b).some(function (w) { return w && re.test(w); });
        })[0] || null;
      if (!el) return false;
      el.setAttribute('data-pt-hit', '1');
      return true;
    },

    /** 「入れ先」の <select> に印を付ける（絞り込みの #listen-deck は除く） */
    markSelect(scopeSel, needles) {
      clear('data-pt-sel');
      const scope = scopeSel ? document.querySelector(scopeSel) : document;
      if (!scope) return false;
      const el = Array.prototype.slice.call(scope.querySelectorAll('select'))
        .filter(function (s) {
          if (s.id === 'listen-deck') return false;
          return Array.prototype.slice.call(s.options).some(function (o) {
            const t = (o.textContent || '');
            return needles.some(function (n) { return t.indexOf(n) >= 0; });
          });
        })[0] || null;
      if (!el) return false;
      el.setAttribute('data-pt-sel', '1');
      return true;
    },

    /** 開いているダイアログの中で、見えている 1 行入力の数（名前の欄が出たかを見る） */
    textFields() {
      const scope = document.querySelector('dialog[open]') || document;
      return Array.prototype.slice.call(scope.querySelectorAll('input'))
        .filter(function (el) { return (!el.type || el.type === 'text') && shown(el); }).length;
    },

    top(sel) {
      const el = document.querySelector(sel);
      if (!el || !shown(el)) return null;
      return el.getBoundingClientRect().top;
    },

    /** 知らせの字（ダイアログの中。黙って失敗していないかを見る） */
    says(sel) {
      const el = sel ? document.querySelector(sel) : null;
      if (el) return (el.textContent || '').trim();
      const dlg = document.querySelector('dialog[open]');
      return dlg ? (dlg.innerText || '').replace(/\s+/g, ' ').trim() : '';
    }
  };
};

/* ---------- 中身（ソースの確かめ。1 回だけ） ---------- */

console.log('\n=== 中身 ===');
const root = new URL('../', import.meta.url);
const listenSrc = fs.existsSync(new URL('assets/listen.js', root))
  ? fs.readFileSync(new URL('assets/listen.js', root), 'utf8') : '';
const htmlSrc = fs.readFileSync(new URL('index.html', root), 'utf8');
ok('listen.js は sunkan:listen:decks に書く', /sunkan:listen:decks/.test(listenSrc));
ok('消した記録の鍵は listendeck:', /listendeck:/.test(listenSrc));
ok('index.html に <select id="listen-deck"> がある', /id="listen-deck"/.test(htmlSrc));
// 画面に出す言葉は「プレイリスト」（「セット」「デッキ」と混ぜない）
ok('画面の言葉は「プレイリスト」', /プレイリスト/.test(htmlSrc) || /プレイリスト/.test(listenSrc));

/* ---------- 実際に押して確かめる ---------- */

const browser = await chromium.launch({ executablePath: EXEC });
let promptText = '';   // 名前を window.prompt で聞く作りのときに返すもの

for (const [label, width] of [['iPhone 390', 390], ['Mac 1180', 1180]]) {
  console.log(`\n=== ${label} ===`);
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  // 名前を prompt で聞く作り・消すときの confirm でも止まらないようにする
  page.on('dialog', d => {
    if (d.type() === 'prompt') d.accept(promptText).catch(() => {});
    else d.accept().catch(() => {});
  });

  /* ---- 保存データを覗く ---- */
  const items = () => page.evaluate(k => JSON.parse(localStorage.getItem(k) || '[]'), LS_ITEMS);
  const decks = () => page.evaluate(k => JSON.parse(localStorage.getItem(k) || '[]'), LS_DECKS);
  const ui = () => page.evaluate(k => localStorage.getItem(k) || '', LS_UI);
  const tombs = () => page.evaluate(() => JSON.parse(localStorage.getItem('sunkan:sync:tombs') || '[]'));
  const itemBy = async mark => (await items()).filter(it => (it.en || '').indexOf(mark) >= 0)[0] || null;

  /* ---- 画面を覗く・押す ---- */

  /** 見えている行（`hidden` が付いていない行）の字 */
  const shownRows = () => page.$$eval(ROW, els =>
    els.filter(e => !e.hidden).map(e => (e.innerText || '').replace(/\s+/g, ' ').trim()));

  const optTexts = sel => page.$$eval(sel + ' option', els => els.map(o => (o.textContent || '').trim()));

  /** 文字で選ぶ（value は担当しだいなので index で選ぶ） */
  const selectByText = async (sel, re) => {
    const list = await optTexts(sel);
    let i = -1;
    for (let k = 0; k < list.length; k++) { if (re.test(list[k])) { i = k; break; } }
    if (i < 0) return null;
    await page.selectOption(sel, { index: i });
    await page.waitForTimeout(350);
    return list[i];
  };
  const chosenText = sel => page.$eval(sel, e =>
    e.selectedIndex >= 0 ? (e.options[e.selectedIndex].textContent || '').trim() : '');

  /** 欄に出ている件数（名前のうしろの数字） */
  const countOf = async re => {
    const list = await optTexts('#listen-deck');
    for (const t of list) {
      if (!re.test(t)) continue;
      const m = t.match(/(\d+)\D*$/);
      return m ? Number(m[1]) : -1;
    }
    return null;
  };

  /** 印を付けた 1 つを押す */
  const pressHit = async () => {
    try { await page.click(HIT, { timeout: 2500 }); } catch (e) { return false; }
    await page.waitForTimeout(250);
    return true;
  };
  /** 字で当てて押す（当たりが無ければ false） */
  const press = async (pattern, near) => {
    if (!(await page.evaluate(a => window.__PT.mark(a.p, a.n), { p: pattern, n: near || '' }))) return false;
    return pressHit();
  };
  /** id があればそれを押し、無ければ字で当てて押す */
  const clickOne = async (sel, pattern, near) => {
    if (sel && await page.$(sel)) {
      try { await page.click(sel, { timeout: 2500 }); } catch (e) { return false; }
      await page.waitForTimeout(250);
      return true;
    }
    return press(pattern, near);
  };
  const says = sel => page.evaluate(s => window.__PT.says(s), sel);

  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.row');

  // ---------- 古い形（`deck` の無い文）を入れておく ----------
  await page.evaluate(a => {
    localStorage.setItem(a.k, JSON.stringify([
      { id: 'listen-old-1', en: a.en, ja: a.ja, note: '', created: 1 }   // deck が無い
    ]));
  }, { k: LS_ITEMS, en: OLD.en, ja: OLD.ja });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.row');
  await page.click('#tab-listen');
  await page.waitForTimeout(400);

  ok('リスニングの表がある', !!(await page.$(ROWS)));
  if (!(await page.$('#listen-deck'))) {
    ok('操作列に #listen-deck がある', false, 'プレイリストの欄がまだ無いので、ここから先は見られません');
    ok('JS のエラーが出ていない', errs.length === 0, errs.join(' / '));
    await ctx.close();
    continue;
  }
  // 絞り込みで先頭の行が隠れていることがあるので、**見えるか**ではなく**在るか**で待つ
  await page.waitForSelector(ROW, { state: 'attached', timeout: 15000 });
  ok('古い形（deck の無い文）でも落ちずに出る', (await shownRows()).length === 1,
    JSON.stringify(await shownRows()));
  ok('古い形の文でエラーが出ない', errs.length === 0, errs.join(' / '));
  ok('古い形の文は「未分類」に出る', (await countOf(/未分類/)) === 1, String(await countOf(/未分類/)));

  // ---------- 欄の場所（操作列のいちばん上） ----------
  const tops = await page.evaluate(() => ({
    deck: window.__PT.top('#listen-deck'),
    rates: window.__PT.top('#listen-rates'),
    toggle: window.__PT.top('#listen-toggle-all'),
    search: window.__PT.top('#listen-search'),
    add: window.__PT.top('#btn-listen-add')
  }));
  const others = [tops.rates, tops.toggle, tops.search, tops.add].filter(v => v !== null);
  ok('プレイリストの欄が操作列のいちばん上にある',
    tops.deck !== null && others.length > 0 && others.every(v => tops.deck <= v + 1),
    JSON.stringify(tops));

  // ---------- プレイリストを作る ----------
  const openManager = () => clickOne('#btn-listen-decks',
    '(プレイリスト.*(管理|直す|作る|分ける)|^プレイリスト$|^♪$)');
  const closeManager = async () => {
    await clickOne('#btn-listen-deck-close', '^(閉じる|とじる|OK)$');
    await page.waitForTimeout(250);
  };

  /** 名前を入れて作る。戻り値は作ったあとに出ている知らせ */
  const makeDeck = async name => {
    promptText = name;
    await openManager();
    await page.waitForTimeout(250);
    let field = (await page.$('#listen-new-deck')) ? '#listen-new-deck' : null;
    if (!field && await page.evaluate(() => window.__PT.markField())) field = FIELD;
    if (field) await page.fill(field, name);
    if (!(await clickOne('#btn-listen-new-deck', '^(作る|作成|追加する|追加)$'))) {
      await press('(作る|作成|追加する)');
    }
    await page.waitForTimeout(450);
    const msg = await says('#listen-deck-status');
    await closeManager();
    return msg;
  };

  await makeDeck(P1);
  let dl = await decks();
  ok('プレイリストを作れる', dl.length === 1 && !!dl[0] && dl[0].name === P1, JSON.stringify(dl));
  ok('作ったプレイリストは {id, name, created} の形',
    !!dl[0] && !!dl[0].id && !!dl[0].name && typeof dl[0].created === 'number', JSON.stringify(dl[0] || {}));
  ok('作ったプレイリストが欄に出る',
    (await optTexts('#listen-deck')).some(t => t.indexOf(P1) >= 0),
    (await optTexts('#listen-deck')).join(' / '));

  const emptyMsg = await makeDeck('');
  ok('空では作れない', (await decks()).length === 1, JSON.stringify(await decks()));
  ok('空のときは理由を出す（黙って失敗しない）', /名前/.test(emptyMsg), emptyMsg);

  const dupMsg = await makeDeck(P1);
  ok('同じ名前は作れない', (await decks()).length === 1, JSON.stringify(await decks()));
  ok('同じ名前のときは理由を出す', /あります|同じ/.test(dupMsg), dupMsg);

  const deckId = (await decks())[0].id;

  // ---------- 追加ダイアログの「入れ先」 ----------
  const pick = async (cands, what) => {
    for (const s of cands) { if (await page.$(s)) return s; }
    ok(what + ' がある', false, cands.join(' / '));
    return null;
  };
  const selEn = await pick(['#listen-en-input', '#listen-en'], '英文の欄');
  const selJa = await pick(['#listen-ja-input', '#listen-ja'], '日本語の欄');
  const selSave = await pick(['#btn-listen-save'], '保存のボタン');
  const selClose = await pick(['#btn-listen-close', '#btn-listen-cancel'], '閉じるボタン');
  if (!selEn || !selSave) {
    ok('JS のエラーが出ていない', errs.length === 0, errs.join(' / '));
    await ctx.close();
    continue;
  }

  await selectByText('#listen-deck', new RegExp(esc(P1)));
  await page.click('#btn-listen-add');
  await page.waitForTimeout(350);
  const hasDeckField = await page.evaluate(() => window.__PT.markSelect('dialog[open]', ['未分類']));
  ok('追加ダイアログに「入れ先」がある', hasDeckField);
  if (hasDeckField) {
    const place = await page.evaluate(a => ({
      sel: window.__PT.top('[data-pt-sel="1"]'),
      en: window.__PT.top(a.en)
    }), { en: selEn });
    ok('「入れ先」はダイアログのいちばん上（英文の欄より上）',
      place.sel !== null && place.en !== null && place.sel < place.en, JSON.stringify(place));
    ok('入れ先の初期値はいま選んでいるプレイリスト',
      (await chosenText(SEL)).indexOf(P1) >= 0, await chosenText(SEL));

    // 「＋ 新しいプレイリスト」を選んだときだけ名前の欄が出る
    const before = await page.evaluate(() => window.__PT.textFields());
    const gotNew = await selectByText(SEL, /新しいプレイリスト/);
    const after = await page.evaluate(() => window.__PT.textFields());
    ok('入れ先に「＋ 新しいプレイリスト」がある', gotNew !== null, String(gotNew));
    ok('「＋ 新しいプレイリスト」を選んだときだけ名前の欄が出る', after === before + 1,
      '前 ' + before + ' / 後 ' + after);
    await selectByText(SEL, new RegExp(esc(P1)));
  }
  if (selClose) { await page.click(selClose); await page.waitForTimeout(300); }

  // ---------- 入れ先ごとに足す ----------
  /** 入れ先を選んで 1 文足す。`deckName` が null なら未分類 */
  const addOne = async (sentence, deckName) => {
    // 入れ先の欄が無い作りでも通るよう、絞り込みのほうも先に合わせておく
    await selectByText('#listen-deck', deckName ? new RegExp(esc(deckName)) : /未分類/);
    await page.click('#btn-listen-add');
    await page.waitForTimeout(350);
    if (await page.evaluate(() => window.__PT.markSelect('dialog[open]', ['未分類']))) {
      await selectByText(SEL, deckName ? new RegExp(esc(deckName)) : /未分類/);
    }
    await page.fill(selEn, sentence.en);
    if (selJa) await page.fill(selJa, sentence.ja);
    await page.click(selSave);
    await page.waitForTimeout(400);
    if (selClose) {
      const open = await page.$eval(selClose, e => !!e.getClientRects().length).catch(() => false);
      if (open) { await page.click(selClose); await page.waitForTimeout(300); }
    }
  };

  await addOne(ONE, P1);
  await addOne(TWO, null);
  const itOne = await itemBy(ONE.mark);
  const itTwo = await itemBy(TWO.mark);
  ok('3 件そろった', (await items()).length === 3, String((await items()).length));
  ok('プレイリストを選んで足すと deck に入る', !!itOne && itOne.deck === deckId, JSON.stringify(itOne));
  ok('未分類に足すと deck は空文字', !!itTwo && itTwo.deck === '', JSON.stringify(itTwo));

  // ---------- 取り込みダイアログの「入れ先」 ----------
  if (await page.$('#btn-listen-import')) {
    await page.click('#btn-listen-import');
    await page.waitForTimeout(400);
    const impSel = await page.evaluate(a => window.__PT.markSelect('#listen-import-dialog',
      ['未分類', a.p, '新しいプレイリスト']), { p: P1 });
    ok('取り込みダイアログにも「入れ先」がある', impSel);
    if (impSel && await page.$('#listen-import-text')) {
      const place = await page.evaluate(() => ({
        sel: window.__PT.top('[data-pt-sel="1"]'),
        text: window.__PT.top('#listen-import-text')
      }));
      ok('取り込みの「入れ先」は貼り付け欄より上',
        place.sel !== null && place.text !== null && place.sel < place.text, JSON.stringify(place));
    }
    if (!(await clickOne('#btn-listen-import-cancel', '^(キャンセル|閉じる)$'))) {
      await page.keyboard.press('Escape');
    }
    await page.waitForTimeout(350);
  }

  // ---------- 選ぶと、その文だけになる ----------
  await selectByText('#listen-deck', new RegExp(esc(P1)));
  let rows = await shownRows();
  ok('プレイリストを選ぶとその文だけになる',
    rows.length === 1 && rows[0].indexOf(ONE.mark) >= 0, JSON.stringify(rows));

  await selectByText('#listen-deck', /未分類/);
  rows = await shownRows();
  ok('「未分類」は入れ物の無い文だけ出す',
    rows.length === 2
    && rows.join(' ').indexOf(OLD.mark) >= 0
    && rows.join(' ').indexOf(TWO.mark) >= 0, JSON.stringify(rows));

  await selectByText('#listen-deck', /^すべて/);
  rows = await shownRows();
  ok('「すべて」はぜんぶ出す', rows.length === 3, JSON.stringify(rows));

  // ---------- 件数 ----------
  ok('「すべて」の件数が合っている', (await countOf(/^すべて/)) === 3, String(await countOf(/^すべて/)));
  ok('プレイリストの件数が合っている', (await countOf(new RegExp(esc(P1)))) === 1,
    String(await countOf(new RegExp(esc(P1)))));
  ok('「未分類」の件数が合っている', (await countOf(/未分類/)) === 2, String(await countOf(/未分類/)));

  // ---------- 名前を変える ----------
  promptText = P2;
  await openManager();
  await page.waitForTimeout(250);
  const spot = await page.evaluate(n => window.__PT.markDeckRow(n), P1);
  if (spot.field) await page.fill(FIELD, P2);
  if (await page.evaluate(() => window.__PT.markRowButton('(変える|変更|名前|改名|✎|✏)'))) {
    await pressHit();
  } else {
    await press('(変える|変更|名前|改名|✎|✏)', P1);
  }
  await page.waitForTimeout(250);
  if (!spot.field && await page.evaluate(() => window.__PT.markField())) {
    // 名前の欄があとから出る作り（別のダイアログ・prompt）にも付き合う
    await page.fill(FIELD, P2);
    await press('^(変える|変更する|変更|直す|保存する|保存|決定|OK)$');
  }
  await page.waitForTimeout(450);
  await closeManager();

  dl = await decks();
  ok('名前を変えられる', dl.length === 1 && dl[0].name === P2, JSON.stringify(dl));
  ok('名前を変えても id は変わらない', dl.length === 1 && dl[0].id === deckId, JSON.stringify(dl));
  ok('名前を変えても中の文は動かない',
    ((await itemBy(ONE.mark)) || {}).deck === deckId, JSON.stringify(await itemBy(ONE.mark)));
  ok('変えた名前が欄に出る',
    (await optTexts('#listen-deck')).some(t => t.indexOf(P2) >= 0),
    (await optTexts('#listen-deck')).join(' / '));

  // ---------- 読み直しても残る（選んだものも覚えている） ----------
  await selectByText('#listen-deck', new RegExp(esc(P2)));
  ok('選んだプレイリストを sunkan:listen:ui が覚える', (await ui()).indexOf(deckId) >= 0, await ui());
  await page.reload({ waitUntil: 'domcontentloaded' });
  // 絞り込みで先頭の行が隠れていることがあるので、**見えるか**ではなく**在るか**で待つ
  await page.waitForSelector(ROW, { state: 'attached', timeout: 15000 });
  await page.waitForTimeout(400);
  dl = await decks();
  ok('読み直してもプレイリストが残る', dl.length === 1 && dl[0].name === P2, JSON.stringify(dl));
  ok('読み直しても選んでいたプレイリストのまま',
    (await chosenText('#listen-deck')).indexOf(P2) >= 0, await chosenText('#listen-deck'));
  rows = await shownRows();
  ok('読み直しても絞り込みが効いている',
    rows.length === 1 && rows[0].indexOf(ONE.mark) >= 0, JSON.stringify(rows));

  // ---------- 長い名前でも横に伸びない ----------
  await selectByText('#listen-deck', /^すべて/);
  await makeDeck(PLONG);
  ok('長い名前のプレイリストも作れる', (await decks()).length === 2, JSON.stringify(await decks()));
  await selectByText('#listen-deck', new RegExp(esc(PLONG.slice(0, 10))));
  const layout = await page.evaluate(() => {
    const W = document.documentElement.clientWidth;
    const el = document.querySelector('#listen-deck');
    const r = el ? el.getBoundingClientRect() : null;
    return {
      scroll: document.documentElement.scrollWidth > W + 1,
      over: !!r && r.right > W + 1,
      w: W, right: r ? Math.round(r.right) : null
    };
  });
  ok('長い名前でも横スクロールが出ない', layout.scroll === false, JSON.stringify(layout));
  ok('長い名前でも欄が画面からはみ出さない', layout.over === false, JSON.stringify(layout));

  // ---------- 消しても中の文は消えない ----------
  await selectByText('#listen-deck', new RegExp(esc(P2)));
  await openManager();
  await page.waitForTimeout(250);
  await page.evaluate(n => window.__PT.markDeckRow(n), P2);
  if (await page.evaluate(() => window.__PT.markRowButton('(消す|削除|🗑)'))) await pressHit();
  else await press('(消す|削除|🗑)', P2);
  await page.waitForTimeout(350);
  await press('^(削除する|消す|はい|OK)$');     // 確かめのダイアログが画面の中にある作りのため
  await page.waitForTimeout(500);
  await closeManager();

  dl = await decks();
  ok('プレイリストを消せる', !dl.some(d => d && d.id === deckId), JSON.stringify(dl));
  ok('消しても中の文は消えない', (await items()).length === 3, String((await items()).length));
  ok('消した中の文は未分類へ戻る（deck が空文字）',
    ((await itemBy(ONE.mark)) || {}).deck === '', JSON.stringify(await itemBy(ONE.mark)));
  ok('消した記録の鍵は listendeck:<id>',
    (await tombs()).some(t => t && t.k === 'listendeck:' + deckId), JSON.stringify(await tombs()));

  // 絞り込みで先頭の行が隠れていることがあるので、**見えるか**ではなく**在るか**で待つ
  await page.waitForSelector(ROW, { state: 'attached', timeout: 15000 });
  await selectByText('#listen-deck', /未分類/);
  rows = await shownRows();
  ok('消したあとは未分類に 3 件そろう', rows.length === 3, JSON.stringify(rows));
  ok('消したあとの未分類の件数も合う', (await countOf(/未分類/)) === 3, String(await countOf(/未分類/)));

  ok('JS のエラーが出ていない', errs.length === 0, errs.join(' / '));
  await ctx.close();
}

await browser.close();
console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
process.exit(fail ? 1 : 0);
