/* リスニング：タブ名・🔈 の位置・ぼかし・かたまりを 1 つずつ・はみ出し。
 *
 * 使い方:
 *   python3 -m http.server 8599 --bind 127.0.0.1 &
 *   node tests/listentest.mjs
 *
 * 見ているのは次の 12 こと。
 *   ・タブが「リスニング」になっていて、「シャドー」がどこにも残っていない
 *   ・1 件足せる（Enter では保存しない）
 *   ・行の**左に 🔈**、その右に英文。英文が 🔈 の下に潜らない
 *   ・はじめは、かたまりがぼけている（filter に blur が入っている）
 *   ・タップごとに**かたまりが 1 つずつ**出る
 *   ・出したかたまりは色が違い、その日本語が下に出る（まだのぶんは出ない）
 *   ・ぜんぶ出したあとのタップで最初に戻る
 *   ・長い文でも横スクロールが出ない
 *   ・読み直しても残る／JS のエラーが出ていない
 *
 * **iPhone 幅 390 と Mac 幅 1180 の両方**で通します。
 */
const PLAYWRIGHT = process.env.PLAYWRIGHT_PKG || '/opt/node-tools/node_modules/playwright/index.mjs';
const { chromium } = await import(PLAYWRIGHT);
const APP = `http://127.0.0.1:${process.env.PORT || '8599'}/`;
/* Chromium の置き場は、入れ物（コンテナ）が替わると動く。決め打ちにすると
   中身とは関係ないところでテストが落ちるので、**あるものを探してから使う**。
   どれも無ければ Playwright に任せる（executablePath を渡さない）。 */
import fs from 'node:fs';
const EXEC = [process.env.CHROMIUM]
  .concat(fs.existsSync('/opt/pw-browsers')
    ? fs.readdirSync('/opt/pw-browsers')
        .filter(d => /^chromium-/.test(d))
        .map(d => ['/opt/pw-browsers/' + d + '/chrome-linux64/chrome',
                   '/opt/pw-browsers/' + d + '/chrome-linux/chrome'])
        .reduce((a, b) => a.concat(b), [])
    : [])
  .concat(['/usr/bin/google-chrome', '/usr/bin/chromium'])
  .filter(x => x && fs.existsSync(x))[0];
const LAUNCH = EXEC ? { executablePath: EXEC } : {};

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + (e ? '  → ' + e : ''))); };

// 入れる 2 件。英文は**スラッシュ入りのまま**で、スラッシュが出す単位になる
const ONE = {
  en: "Let's get / a cup of coffee / after this.",
  ja: 'この後 / コーヒーを / 飲もうよ。'
};
const LONG = {
  en: 'I was wondering / whether there might be another place nearby / '
    + 'where we could sit down and talk for a while / before the meeting starts.',
  ja: '思っていたんだけど / この近くに別の場所があるんじゃないかな / '
    + '少し座って話せるような / 会議が始まる前に。'
};
const parts = s => s.split('/').map(x => x.trim()).filter(Boolean);

// --- 中身（シャドーイングが外れているか・前のデータに手を出していないか）---
console.log('\n=== 中身 ===');
const assets = new URL('../assets/', import.meta.url);
ok('assets/shadow.js が無い', !fs.existsSync(new URL('shadow.js', assets)));
const hasListen = fs.existsSync(new URL('listen.js', assets));
ok('assets/listen.js がある', hasListen);
if (hasListen) {
  const src = fs.readFileSync(new URL('listen.js', assets), 'utf8');
  ok('listen.js は sunkan:listen:* に書く', /sunkan:listen:items/.test(src));
  // 前のシャドーイングのデータは本人の持ちもの。消さない決まり
  ok('listen.js は sunkan:shadow:* を触らない', !/sunkan:shadow/.test(src));
  ok('listen.js に blockEnter がある（Enter で保存しない）', /function blockEnter\(/.test(src));
}

// 画面の中で、いつも同じ所を指すもの
const ROWS = '#listen-rows';
const ROW = '#listen-rows .row';

const browser = await chromium.launch(LAUNCH);

// `__LT` は読み直しても要るので addInitScript で入れる。
// かたまりの class 名は担当しだいなので、**はじめにぼけている要素**から見つける。
const INIT = () => {
  window.__LT = {
    row() { return document.querySelector('#listen-rows .row'); },
    nodes(root) { return Array.prototype.slice.call(root.querySelectorAll('*')); },
    blurred(root) {
      return this.nodes(root).filter(function (el) {
        return /blur/.test(getComputedStyle(el).filter);
      });
    },
    /** 🔈 だけを持つ要素（ボタンでも span でも拾える） */
    speaker(root) {
      return this.nodes(root).filter(function (el) {
        return el.textContent.trim() === '🔈';
      }).pop() || null;
    },
    /** 文字の等しい末端の要素（かたまり 1 つぶん） */
    leafWith(root, text) {
      return this.nodes(root).filter(function (el) {
        return !el.children.length && el.textContent.trim() === text;
      })[0] || null;
    },
    box(el) {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height };
    }
  };
};

for (const [label, width] of [['iPhone 390', 390], ['Mac 1180', 1180]]) {
  console.log(`\n=== ${label} ===`);
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.row');

  // --- 名前が「リスニング」になっているか ---
  const tabs = await page.$$eval('.mode-tab', e => e.map(x => x.textContent.trim()));
  ok('タブが「リスニング」になっている', tabs.indexOf('リスニング') >= 0, tabs.join(' / '));
  ok('「シャドー」のタブが無い', tabs.join('').indexOf('シャドー') < 0, tabs.join(' / '));
  ok('画面のどこにも「シャドー」が出ない',
    (await page.$eval('body', e => e.innerHTML)).indexOf('シャドー') < 0);
  ok('shadow.js を読み込んでいない',
    await page.evaluate(() => !Array.prototype.slice.call(document.scripts)
      .some(s => /shadow/.test(s.src || ''))));

  if (!(await page.$('#tab-listen'))) {
    ok('#tab-listen がある', false, 'リスニングのタブがまだ無いので、ここから先は見られません');
    ok('JS のエラーが出ていない', errs.length === 0, errs.join(' / '));
    await ctx.close();
    continue;
  }
  await page.click('#tab-listen');
  await page.waitForTimeout(300);
  ok('リスニングの表がある', !!(await page.$(ROWS)));

  // 要素の名前は担当しだいなので、在るほうを使う
  const pick = async (cands, what) => {
    for (const s of cands) { if (await page.$(s)) return s; }
    ok(what + ' がある', false, cands.join(' / '));
    return null;
  };
  const selAdd = await pick(['#btn-listen-add'], '追加のボタン');
  if (!selAdd) { ok('JS のエラーが出ていない', errs.length === 0, errs.join(' / ')); await ctx.close(); continue; }

  // ---------- 1 件足す ----------
  await page.click(selAdd);
  await page.waitForTimeout(250);
  const selEn = await pick(['#listen-en-input', '#listen-en'], '英文の欄');
  const selJa = await pick(['#listen-ja-input', '#listen-ja'], '日本語の欄');
  const selSave = await pick(['#btn-listen-save'], '保存のボタン');
  const selClose = await pick(['#btn-listen-close', '#btn-listen-cancel'], '閉じるボタン');
  if (!selEn || !selSave) { ok('JS のエラーが出ていない', errs.length === 0, errs.join(' / ')); await ctx.close(); continue; }

  const count = () => page.evaluate(() =>
    JSON.parse(localStorage.getItem('sunkan:listen:items') || '[]').length);

  await page.fill(selEn, ONE.en);
  if (selJa) await page.fill(selJa, ONE.ja);
  // Enter では保存しない（日本語を変換して確定する Enter で入ってしまうのを止める）
  await page.press(selEn, 'Enter');
  await page.waitForTimeout(250);
  ok('Enter では保存されない', (await count()) === 0, String(await count()));
  ok('Enter で書いたものが消えない', (await page.$eval(selEn, e => e.value)) === ONE.en);

  await page.click(selSave);
  await page.waitForTimeout(350);
  ok('ボタンなら 1 件足せる', (await count()) === 1, String(await count()));
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('sunkan:listen:items') || '[]')[0] || {});
  ok('英文はスラッシュ入りのまま保存される', saved.en === ONE.en, JSON.stringify(saved));
  if (selClose) { await page.click(selClose); await page.waitForTimeout(300); }

  // ほかのモードの隠れた行を拾わないよう、**リスニングの中**で待つ
  await page.waitForSelector(ROW, { timeout: 15000 });
  await page.waitForTimeout(200);

  // ---------- 行の作り（🔈 は左、英文はその右）----------
  const chunks = parts(ONE.en), jas = parts(ONE.ja);
  const look = await page.evaluate(() => {
    const row = window.__LT.row();
    const sp = window.__LT.speaker(row);
    const b = window.__LT.blurred(row);
    return {
      speaker: sp ? window.__LT.box(sp) : null,
      blur: b.length,
      first: b.length ? window.__LT.box(b[0]) : null,
      // **左右と上下の両方**が重なって初めて「隠れている」
      hidden: !sp ? 0 : b.filter(function (el) {
        const a = window.__LT.box(el), t = window.__LT.box(sp);
        const ox = a.right > t.left + 1 && a.left < t.right - 1;
        const oy = a.bottom > t.top + 1 && a.top < t.bottom - 1;
        return a.w && ox && oy;
      }).length
    };
  });
  ok('行に 🔈 がある', !!look.speaker);
  ok('🔈 は行の左にある',
    !!look.speaker && !!look.first && look.speaker.left < look.first.left,
    JSON.stringify({ sp: look.speaker, en: look.first }));
  ok('英文が 🔈 の下に潜らない', look.hidden === 0, '隠れ ' + look.hidden);
  ok('はじめはかたまりがぼけている（filter に blur）', look.blur > 0, 'ぼけ ' + look.blur);
  ok('ぼけているかたまりの数がスラッシュの数と合う', look.blur === chunks.length,
    'ぼけ ' + look.blur + ' / かたまり ' + chunks.length);

  // ---------- タップごとに 1 つずつ ----------
  // 390 幅では道具の列が行に重なるので、**狙ったかたまり**の所を押す
  const tap = async () => {
    const at = await page.evaluate(() => {
      const row = window.__LT.row();
      const b = window.__LT.blurred(row);
      const el = b.length ? b[0] : row;
      const r = window.__LT.box(el);
      return { x: r.left + Math.min(6, r.w / 2), y: r.top + r.h / 2 };
    });
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(250);
  };
  const state = async (chunkText, jaText, nextJa) => page.evaluate(a => {
    const row = window.__LT.row();
    const el = window.__LT.leafWith(row, a.chunkText);
    const b = window.__LT.blurred(row);
    return {
      blur: b.length,
      shown: !!el && !/blur/.test(getComputedStyle(el).filter),
      color: el ? getComputedStyle(el).color : '',
      blurColor: b.length ? getComputedStyle(b[0]).color : '',
      ja: row.innerText.indexOf(a.jaText) >= 0,
      nextJa: a.nextJa ? row.innerText.indexOf(a.nextJa) >= 0 : false,
      // 出したかたまりの日本語。**英語と同じ色**でなければ、どこの訳なのか読み取れない
      jaColor: (function () {
        var all = row.querySelectorAll('*'), i, t;
        for (i = 0; i < all.length; i++) {
          t = (all[i].textContent || '').trim();
          if (t === a.jaText && !all[i].children.length) return getComputedStyle(all[i]).color;
        }
        return '';
      })()
    };
  }, { chunkText, jaText, nextJa });

  await tap();
  const s1 = await state(chunks[0], jas[0], jas[1]);
  ok('1 回のタップで出るのは 1 つだけ', s1.blur === chunks.length - 1,
    'ぼけ ' + s1.blur + ' / はじめ ' + chunks.length);
  ok('出したかたまりはぼけていない', s1.shown === true);
  ok('出したかたまりの色がほかと違う', !!s1.color && s1.color !== s1.blurColor,
    s1.color + ' / ' + s1.blurColor);
  ok('出したかたまりの日本語が出る', s1.ja === true, jas[0]);
  ok('出したかたまりは日本語も同じ色', !!s1.jaColor && s1.jaColor === s1.color,
    '日本語 ' + s1.jaColor + ' / 英語 ' + s1.color);
  ok('まだ出していないかたまりの日本語は出さない', s1.nextJa === false, jas[1]);

  await tap();
  const s2 = await state(chunks[1], jas[1], jas[2]);
  ok('2 回目も 1 つだけ出る', s2.blur === chunks.length - 2, 'ぼけ ' + s2.blur);
  ok('2 つめの日本語も出る', s2.ja === true, jas[1]);

  // のこりをぜんぶ出す
  for (let i = 2; i < chunks.length; i++) await tap();
  const done = await page.evaluate(() => window.__LT.blurred(window.__LT.row()).length);
  ok('ぜんぶ出すとぼけが無くなる', done === 0, 'ぼけ ' + done);

  // ぜんぶ出したあと、もう一度タップすると最初に戻る
  await tap();
  const again = await page.evaluate(() => window.__LT.blurred(window.__LT.row()).length);
  ok('ぜんぶ出したあとのタップで最初に戻る', again === chunks.length, 'ぼけ ' + again);

  // ---------- 長い文：はみ出さない・ボタンの下に潜らない ----------
  await page.click(selAdd);
  await page.waitForTimeout(250);
  await page.fill(selEn, LONG.en);
  if (selJa) await page.fill(selJa, LONG.ja);
  await page.click(selSave);
  await page.waitForTimeout(350);
  if (selClose) { await page.click(selClose); await page.waitForTimeout(300); }
  await page.waitForTimeout(200);

  const layout = await page.evaluate(() => {
    const W = document.documentElement.clientWidth;
    const n = { speak: 0, tools: 0 };
    document.querySelectorAll('#listen-rows .row').forEach(function (li) {
      const pairs = [['speak', window.__LT.speaker(li)], ['tools', li.querySelector('.row-tools')]];
      pairs.forEach(function (pair) {
        const t = pair[1];
        if (!t) return;
        const tb = window.__LT.box(t);
        window.__LT.blurred(li).forEach(function (el) {
          const a = window.__LT.box(el);
          // **左右と上下の両方**が重なって初めて「隠れている」
          const ox = a.right > tb.left + 1 && a.left < tb.right - 1;
          const oy = a.bottom > tb.top + 1 && a.top < tb.bottom - 1;
          if (a.w && ox && oy) n[pair[0]]++;
        });
      });
    });
    return { speak: n.speak, tools: n.tools, scroll: document.documentElement.scrollWidth > W + 1, rows: document.querySelectorAll('#listen-rows .row').length };
  });
  ok('長い文でも英文が 🔈 の下に潜らない', layout.speak === 0, '隠れ ' + layout.speak);
  ok('長い文でも英文が行の道具（↻ ✎）の下に潜らない', layout.tools === 0, '隠れ ' + layout.tools);
  ok('横スクロールが出ない', layout.scroll === false);
  ok('2 件並んでいる', layout.rows === 2, String(layout.rows));

  // ---------- 読み直しても残る ----------
  await page.reload({ waitUntil: 'domcontentloaded' });
  // 読み直すとリスニングで開くので、ほかのモードの行は隠れている。
  // `.row` で待つと、その隠れた行を待ってしまう
  await page.waitForSelector(ROW, { timeout: 15000 });
  await page.waitForTimeout(300);
  const after = await page.$$eval(ROW, els => els.length);
  ok('読み直しても 2 件残る', after === 2, String(after));
  const reBlur = await page.evaluate(() => window.__LT.blurred(window.__LT.row()).length);
  ok('読み直すとまたぼけている', reBlur > 0, 'ぼけ ' + reBlur);

  ok('JS のエラーが出ていない', errs.length === 0, errs.join(' / '));
  await ctx.close();
}

await browser.close();
console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
process.exit(fail ? 1 : 0);
