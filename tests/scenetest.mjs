/* 場面（旧フレーズ）：セリフ・言い方3本・印の言葉・写真・はみ出し。
 *
 * 使い方:
 *   python3 -m http.server 8599 --bind 127.0.0.1 &
 *   node tests/scenetest.mjs
 *
 * **iPhone 幅 390 と Mac 幅 1180 の両方**で通します。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const PLAYWRIGHT = process.env.PLAYWRIGHT_PKG || '/opt/node-tools/node_modules/playwright/index.mjs';
const { chromium } = await import(PLAYWRIGHT);
const APP = `http://127.0.0.1:${process.env.PORT || '8599'}/`;
const EXEC = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + (e ? '  → ' + e : ''))); };

// 試しに使う写真を 1 枚作る
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scenetest-'));
const PHOTO = path.join(tmp, 'p.png');
const browser = await chromium.launch({ executablePath: EXEC });
{
  const c = await browser.newContext({ viewport: { width: 400, height: 300 } });
  const q = await c.newPage();
  await q.setContent('<body style="margin:0;background:#3b7ddd"></body>');
  await q.screenshot({ path: PHOTO });
  await c.close();
}

for (const [label, width] of [['iPhone 390', 390], ['Mac 1180', 1180]]) {
  console.log(`\n=== ${label} ===`);
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.row');

  // --- 名前が「場面」になっているか ---
  const tabs = await page.$$eval('.mode-tab', e => e.map(x => x.textContent.trim()));
  ok('タブが「場面」になっている', tabs.indexOf('場面') >= 0, tabs.join(' / '));
  ok('「フレーズ」はどこにも出ない', tabs.indexOf('フレーズ') < 0, tabs.join(' / '));

  await page.click('#tab-phrase');
  await page.waitForTimeout(300);
  ok('足すボタンが「場面を足す」', /場面を足す/.test(await page.$eval('#btn-phrase-add', e => e.textContent)));

  // --- セリフだけで保存できる（その「時」は突然来るので、英語は後から）---
  await page.click('#btn-phrase-add');
  await page.waitForTimeout(250);
  await page.fill('#phrase-ja', '他にトイレありますか？');
  await page.fill('#phrase-scene-input', 'トイレが空いてない');
  await page.click('#btn-phrase-save');
  await page.waitForTimeout(350);
  const only = await page.evaluate(() => JSON.parse(localStorage.getItem('sunkan:phrase:items') || '[]'));
  ok('セリフだけで保存できる（英語なし）', only.length === 1 && !only[0].en, JSON.stringify(only));

  // --- 言い方 3 本 ---
  await page.fill('#phrase-ja', 'お会計をお願いします');
  await page.fill('#phrase-en', 'Check, please.');
  await page.fill('#phrase-en2', 'Could I get the check?');
  await page.fill('#phrase-en3', 'Do you know where I can pay?');
  await page.setInputFiles('#phrase-photo-file', PHOTO);
  await page.waitForTimeout(900);
  ok('写真を取り込める', /取り込みました/.test(await page.$eval('#phrase-photo-status', e => e.textContent)),
    await page.$eval('#phrase-photo-status', e => e.textContent));
  await page.click('#btn-phrase-save');
  await page.waitForTimeout(350);
  await page.click('#btn-phrase-close');
  await page.waitForTimeout(300);

  const rows = await page.$$eval('#phrase-rows .row', els => els.map(li => ({
    ja: (li.querySelector('.ja-text') || {}).textContent,
    lead: (li.querySelector('.say-lead') || {}).textContent,
    says: Array.from(li.querySelectorAll('.say-line')).map(x => ({
      tag: (x.querySelector('.say-tag') || {}).textContent || '',
      text: (x.querySelector('.say-text') || {}).textContent
    })),
    yet: !!li.querySelector('.say-yet'),
    photo: !li.querySelector('.row-photo').hidden
  })));

  ok('セリフが「…」で囲まれる', /^「.+」$/.test(rows[0].ja), rows[0].ja);
  ok('「と言ってみよう」が付く', rows[0].lead === 'と言ってみよう', rows[0].lead);
  ok('英語が無い行は「英語まだ」', rows[0].yet === true && rows[0].says.length === 0, JSON.stringify(rows[0]));
  ok('言い方が 3 本出る', rows[1].says.length === 3, JSON.stringify(rows[1].says));
  ok('方向の札が付く', rows[1].says.map(x => x.tag).join('/') === '短く/やわらかく/遠回しに',
    rows[1].says.map(x => x.tag).join('/'));

  // **同じ太さ**であること。1 本目を太くすると、それが「正解」になってしまう
  const weights = await page.$$eval('#phrase-rows .row:nth-child(2) .say-text',
    e => e.map(x => getComputedStyle(x).fontWeight));
  ok('言い方 3 本は同じ太さ', new Set(weights).size === 1, weights.join('/'));

  // --- 印は言葉。数字は出さない ---
  const opts = await page.$$eval('#phrase-rows .row:nth-child(1) .row-level option', e => e.map(x => x.textContent));
  ok('印が「出なかった／詰まった／言えた」', opts.join('/') === 'まだ/出なかった/詰まった/言えた', opts.join('/'));
  await page.selectOption('#phrase-rows .row:nth-child(1) .row-level', '80');
  await page.waitForTimeout(300);
  const flash = await page.$eval('#phrase-status', e => e.textContent.trim());
  ok('知らせも言葉で出す（％を出さない）', /詰まった/.test(flash) && !/%/.test(flash), flash);
  ok('知らせが「次は」を言う', /次は .+。/.test(flash), flash);
  ok('印の値は 80 のまま（忘却曲線はそのまま）',
    await page.evaluate(() => {
      const lv = JSON.parse(localStorage.getItem('sunkan:phrase:levels') || '{}');
      return Object.values(lv).some(x => x.v === 80);
    }));

  // --- 写真は付いている行にだけ ---
  ok('写真の無い行に 🖼 を出さない', rows[0].photo === false);
  ok('写真のある行にだけ 🖼 が出る', rows[1].photo === true);
  await page.click('#phrase-rows .row:nth-child(2) .row-photo');
  await page.waitForTimeout(600);
  ok('写真を大きく見られる', await page.$eval('#phrase-photo-dialog', e => e.open));
  ok('写真が貼られている', (await page.$eval('#phrase-photo-big', e => e.getAttribute('src') || '')).length > 0);
  await page.click('#btn-phrase-photo-close');
  await page.waitForTimeout(300);

  // --- 長い中身でも、はみ出さない／ボタンの下に潜らない ---
  await page.click('#btn-phrase-add');
  await page.waitForTimeout(250);
  await page.fill('#phrase-ja', 'わざと長い日本語で、表が画面の外へ押し出されないかを見る');
  await page.fill('#phrase-en', 'Excuse me, I was wondering whether there might be another restroom somewhere nearby that I could use right now');
  await page.fill('#phrase-scene-input', 'とても長いどんな時の名前');
  await page.click('#btn-phrase-save');
  await page.waitForTimeout(300);
  await page.click('#btn-phrase-close');
  await page.waitForTimeout(300);
  await page.click('#phrase-toggle-all');   // ぜんぶ開く
  await page.waitForTimeout(400);

  const layout = await page.evaluate(() => {
    const W = document.documentElement.clientWidth;
    let hidden = 0;
    document.querySelectorAll('#phrase-rows .row').forEach(li => {
      const t = li.querySelector('.row-tools').getBoundingClientRect();
      li.querySelectorAll('.say-text').forEach(x => {
        const a = x.getBoundingClientRect();
        // **左右と上下の両方**が重なって初めて「隠れている」
        const ox = a.right > t.left + 1 && a.left < t.right - 1;
        const oy = a.bottom > t.top + 1 && a.top < t.bottom - 1;
        if (a.width && ox && oy) hidden++;
      });
    });
    return { hidden, scroll: document.documentElement.scrollWidth > W + 1 };
  });
  ok('言い方がボタンの下に隠れない', layout.hidden === 0, '隠れ ' + layout.hidden);
  ok('横スクロールが出ない', layout.scroll === false);

  // --- 読み直しても残る ---
  await page.reload({ waitUntil: 'domcontentloaded' });
  // 読み直すと場面モードで開くので、瞬間英作文の行は隠れている。
  // `.row` で待つと、その隠れた行を待ってしまう
  await page.waitForSelector('#phrase-rows .row', { timeout: 15000 });
  await page.waitForTimeout(300);
  const after = await page.$$eval('#phrase-rows .row', els => els.length);
  ok('読み直しても 3 件残る', after === 3, String(after));

  ok('JS のエラーが出ていない', errs.length === 0, errs.join(' / '));
  await ctx.close();
}

await browser.close();
console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
process.exit(fail ? 1 : 0);
