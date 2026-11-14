/* モードの確かめ — パラフレ帳とカードを畳んだあと（build 69）。
 *
 * 使い方:
 *   python3 -m http.server 8599 --bind 127.0.0.1 &
 *   node tests/modetest.mjs
 *
 * **390px と 1180px の両方**で走る。見ているのは次の 7 こと。
 *   ・タブが 3 つで、パラフレ帳とカードがタブも画面も残っていない
 *   ・開いたモードの画面**だけ**が見える（出し分けの総当たりの数が合っているか）
 *   ・← → で端から端まで回って戻る
 *   ・畳んだモードを覚えている端末でも真っ白にならず、覚え直す
 *   ・口（window.SUNKAN_*）が、消したぶんだけ無くなっている
 *   ・畳んだぶんの**預かりは消していない**（「同期は後で」の約束）
 *   ・どこでもエラーが出ない
 */
import { chromium } from 'playwright';

const APP = 'http://127.0.0.1:8599/index.html';
let pass = 0, fail = 0;
const ok = (n, c, e = '') => {
  c ? (pass++, console.log('  PASS  ' + n))
    : (fail++, console.log('  FAIL  ' + n + (e ? '  → ' + e : '')));
};

const b = await chromium.launch();

for (const [label, width] of [['iPhone 390', 390], ['Mac 1180', 1180]]) {
  console.log('\n=== ' + label + ' ===');
  const ctx = await b.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await p.goto(APP, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.row');

  ok('タブは 3 つ', await p.locator('.mode-tab').count() === 3,
     String(await p.locator('.mode-tab').allInnerTexts()));
  ok('パラフレ帳のタブが無い', await p.locator('#tab-para').count() === 0);
  ok('カードのタブが無い', await p.locator('#tab-cards').count() === 0);
  ok('パラフレ帳の画面が無い', await p.locator('#view-para').count() === 0);
  ok('カードの画面が無い', await p.locator('#view-cards').count() === 0);

  for (const id of ['tab-listen', 'tab-phrase', 'tab-drill', 'tab-listen']) {
    await p.click('#' + id); await p.waitForTimeout(250);
  }
  ok('モードを行き来してもエラーが出ない', errs.length === 0, errs.join(' / '));

  // 開いているモードの画面だけが見えているか（総当たりの数が合っているかの検算）
  for (const [mode, view] of [['drill', '#view-drill'], ['phrase', '#phrase-view'], ['listen', '#listen-view']]) {
    await p.click('#tab-' + mode); await p.waitForTimeout(250);
    const shown = await p.locator(view).isVisible();
    let leak = '';
    for (const o of ['#view-drill', '#phrase-view', '#listen-view']) {
      if (o !== view && await p.locator(o).isVisible()) leak += o + ' ';
    }
    ok(mode + ' を開くと ' + view + ' だけが見える', shown && !leak,
       (shown ? '' : '本体が見えない ') + leak);
    ok(mode + ' のタブが選ばれている',
       await p.getAttribute('#tab-' + mode, 'aria-selected') === 'true');
  }

  // ← → でタブを行き来する（端で折り返す）
  await p.click('#tab-drill');
  await p.focus('#tab-drill');
  for (let i = 0; i < 3; i++) { await p.keyboard.press('ArrowRight'); await p.waitForTimeout(150); }
  const after = await p.evaluate(() => document.documentElement.getAttribute('data-mode'));
  ok('→ を 3 回で一周して drill に戻る', after === 'drill', String(after));

  // 畳んだモードを覚えている端末で開いても真っ白にならないか
  await p.evaluate(() => localStorage.setItem('sunkan:mode', 'cards'));
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.row');
  ok('カードを覚えている端末でも drill が開く',
     await p.evaluate(() => document.documentElement.getAttribute('data-mode')) === 'drill');
  ok('覚え直してある（次からは読みに行かせない）',
     await p.evaluate(() => localStorage.getItem('sunkan:mode')) === 'drill');

  const ports = await p.evaluate(() => ({
    para: !!window.SUNKAN_PARA, cards: !!window.SUNKAN_CARDS,
    mode: !!window.SUNKAN_MODE, drill: !!window.SUNKAN_DRILL,
    phrase: !!window.SUNKAN_PHRASE, listen: !!window.SUNKAN_LISTEN,
    imp: !!window.SUNKAN_IMPORT, sync: !!window.SUNKAN_SYNC, srs: !!window.SUNKAN_SRS
  }));
  ok('SUNKAN_PARA / SUNKAN_CARDS が無い', !ports.para && !ports.cards, JSON.stringify(ports));
  ok('残りの口はぜんぶ在る',
     ports.mode && ports.drill && ports.phrase && ports.listen && ports.imp && ports.sync && ports.srs,
     JSON.stringify(ports));

  // 畳んだぶんの預かりは消していない（「同期は後で」の約束）
  const known = await p.evaluate(() => {
    localStorage.setItem('sunkan:cards:items', JSON.stringify([{ id: 'keep-1', deck: 'd', en: 'a', ja: 'b' }]));
    localStorage.setItem('sunkan:para:cards', JSON.stringify([{ id: 'keep-2', en: 'a', lines: [] }]));
    return window.SUNKAN_SYNC.backupText({});
  });
  ok('書き出しにカードとパラフレが残っている（消していない）',
     known.indexOf('keep-1') >= 0 && known.indexOf('keep-2') >= 0,
     known ? '見つからない' : 'backupText が空');

  ok('最後までエラーなし', errs.length === 0, errs.join(' / '));
  await p.screenshot({ path: '/tmp/claude-0/-home-user-sunkan-333/d66a3ed4-89ad-527a-b1fe-8ea58c430df8/scratchpad/mode-' + width + '.png' });
  await ctx.close();
}

await b.close();
console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
process.exit(fail ? 1 : 0);
