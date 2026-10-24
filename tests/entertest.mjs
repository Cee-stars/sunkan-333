/* エンターで勝手に追加されないこと。
 *
 * 使い方:
 *   python3 -m http.server 8599 --bind 127.0.0.1 &
 *   node tests/entertest.mjs
 *
 * 日本語を変換して確定するときの Enter で追加されてしまうのが、
 * 入れている途中でいちばん邪魔だった。**Enter では何も起きない**のが正しい。
 * ダイアログの中は <form method="dialog"> なので、素通しすると
 * Enter で黙って閉じて書いたものが消える。そこも見る。
 *
 * **iPhone 幅 390 と Mac 幅 1180 の両方**で通します。
 */
import fs from 'node:fs';
const PLAYWRIGHT = process.env.PLAYWRIGHT_PKG || '/opt/node-tools/node_modules/playwright/index.mjs';
const { chromium } = await import(PLAYWRIGHT);
const APP = `http://127.0.0.1:${process.env.PORT || '8599'}/`;
const EXEC = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + (e ? '  → ' + e : ''))); };

// --- 入口がどこにも残っていないか（カード・シャドー・言い換えはここで見る）---
console.log('\n=== 中身 ===');
for (const f of ['app', 'cards', 'shadow', 'paraphrase', 'phrase']) {
  const src = fs.readFileSync(new URL(`../assets/${f}.js`, import.meta.url), 'utf8');
  ok(`${f}.js に blockEnter がある`, /function blockEnter\(/.test(src));
  ok(`${f}.js に Enter で保存する道が残っていない`,
    !/bindEnterToSave|function bindEnter\(/.test(src));
}

const browser = await chromium.launch({ executablePath: EXEC });

for (const [label, width] of [['iPhone 390', 390], ['Mac 1180', 1180]]) {
  console.log(`\n=== ${label} ===`);
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.row');

  // ---------- 瞬間英作文（＋追加）----------
  // 数えるのは**保存したもの**。知らせの文で見ると、
  // あとから別の知らせに上書きされて、素通りしてしまう。
  const countAdded = () => page.evaluate(() => {
    const all = JSON.parse(localStorage.getItem('sunkan:added') || '{}');
    let n = 0;
    Object.keys(all).forEach(k => { n += (all[k] || []).length; });
    return n;
  });
  const before = await countAdded();
  await page.click('#btn-add');
  await page.waitForTimeout(250);
  await page.fill('#add-ja', 'エンターで入ってはいけない');
  await page.press('#add-ja', 'Enter');
  await page.waitForTimeout(250);
  ok('瞬間英作文：Enter でダイアログが閉じない', await page.$eval('#add-dialog', e => e.open));
  ok('瞬間英作文：Enter で日本語が消えない',
    (await page.$eval('#add-ja', e => e.value)) === 'エンターで入ってはいけない');
  await page.fill('#add-en', 'This must not be added by Enter.');
  await page.press('#add-en', 'Enter');
  await page.press('#add-note', 'Enter');
  await page.waitForTimeout(250);
  ok('瞬間英作文：Enter では追加されない', (await countAdded()) === before, String(await countAdded()));
  ok('瞬間英作文：Enter で英語も消えない',
    (await page.$eval('#add-en', e => e.value)) === 'This must not be added by Enter.');
  // ボタンならちゃんと追加される（止めすぎていないことの裏取り）
  await page.click('#btn-add-save');
  await page.waitForTimeout(350);
  ok('瞬間英作文：ボタンなら追加できる', (await countAdded()) === before + 1,
    await page.$eval('#add-status', e => e.textContent));
  // 新しいセットの名前でも Enter で作らない
  await page.fill('#new-deck-name', 'エンターで作ってはいけない');
  await page.press('#new-deck-name', 'Enter');
  await page.waitForTimeout(250);
  ok('瞬間英作文：Enter ではセットを作らない',
    (await page.evaluate(() => (localStorage.getItem('sunkan:decks') || ''))).indexOf('エンターで作ってはいけない') < 0);
  await page.click('#btn-add-close');
  await page.waitForTimeout(250);
  ok('追加したぶんは残っている（止めすぎていない）', (await countAdded()) === before + 1);

  // ---------- 場面 ----------
  await page.click('#tab-phrase');
  await page.waitForTimeout(300);
  await page.click('#btn-phrase-add');
  await page.waitForTimeout(250);
  await page.fill('#phrase-scene-input', 'トイレが空いてない時');
  await page.press('#phrase-scene-input', 'Enter');
  await page.fill('#phrase-ja', '他にトイレありますか？');
  await page.press('#phrase-ja', 'Enter');
  await page.waitForTimeout(250);
  ok('場面：Enter でダイアログが閉じない', await page.$eval('#phrase-edit-dialog', e => e.open));
  ok('場面：Enter では保存されない',
    (await page.evaluate(() => JSON.parse(localStorage.getItem('sunkan:phrase:items') || '[]'))).length === 0);
  ok('場面：Enter で書いたものが消えない',
    (await page.$eval('#phrase-ja', e => e.value)) === '他にトイレありますか？');
  await page.click('#btn-phrase-save');
  await page.waitForTimeout(350);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('sunkan:phrase:items') || '[]'));
  ok('場面：ボタンなら保存できる', saved.length === 1 && saved[0].ja === '他にトイレありますか？',
    JSON.stringify(saved));

  ok('JS のエラーが出ていない', errs.length === 0, errs.join(' / '));
  await ctx.close();
}

await browser.close();
console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
process.exit(fail ? 1 : 0);
