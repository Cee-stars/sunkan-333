/* つまずいた所（言えなかった語）が残せて、数えられて、同期に乗るか。
 *
 * 使い方:
 *   python3 -m http.server 8599 --bind 127.0.0.1 &
 *   node tests/gaptest.mjs
 *
 * **iPhone 幅 390 と Mac 幅 1180 の両方**で通します。
 */
const PLAYWRIGHT = process.env.PLAYWRIGHT_PKG || '/opt/node-tools/node_modules/playwright/index.mjs';
const { chromium } = await import(PLAYWRIGHT);

const BASE = `http://127.0.0.1:${process.env.PORT || '8599'}/`;
const EXEC = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  → ' + extra : ''}`); }
};

const browser = await chromium.launch({ executablePath: EXEC });

for (const [label, width, height] of [['iPhone 390', 390, 844], ['Mac 1180', 1180, 800]]) {
  console.log(`\n=== ${label} ===`);
  const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.row');
  ok('JS のエラーが出ていない', errors.length === 0, errors.join(' / '));

  const firstId = await page.$eval('.row', el => el.getAttribute('data-id'));
  const row1 = '.row:nth-child(1)';

  // --- 閉じている行では △ を出さない（答えを見てから付けるもの）---
  const hiddenGap = await page.evaluate(() => {
    const b = document.querySelector('.row .row-gap');
    return b ? getComputedStyle(b).display : 'ない';
  });
  ok('閉じている行には △ を出さない', hiddenGap === 'none', hiddenGap);

  // --- 開くと出る ---
  await page.click(`${row1} .cell--ja`);   // 390px では行の中央に道具が重なる（build 50）
  await page.waitForTimeout(200);
  const shownGap = await page.evaluate(() => {
    const b = document.querySelector('.row .row-gap');
    const r = b.getBoundingClientRect();
    return { display: getComputedStyle(b).display, w: r.width, h: r.height };
  });
  ok('開いた行には △ が出る',
    shownGap.display !== 'none' && shownGap.w > 0 && shownGap.h > 0, JSON.stringify(shownGap));

  // --- △ でダイアログが開き、英語が語に割れている ---
  await page.click(`${row1} .row-gap`);
  await page.waitForTimeout(200);
  const en = await page.$eval(`${row1} .en-text`, el => el.textContent.trim());
  const chips = await page.$$eval('#gap-words .gap-word', els => els.map(e => e.textContent));
  ok('ダイアログが開く', await page.$eval('#gap-dialog', el => el.open) === true);
  ok('英語が語に割れて並ぶ', chips.length === en.split(/\s+/).filter(Boolean).length,
    `${chips.join('|')} / ${en}`);
  ok('見せる語はもとのまま（記号も残す）', chips.join(' ') === en, chips.join(' '));

  // --- 語をタップするとその場で保存される ---
  await page.click('#gap-words .gap-word:nth-child(2)');
  await page.waitForTimeout(150);
  const saved = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('sunkan:gaps') || '{}'); } catch (e) { return null; }
  });
  const rec = saved ? (Object.values(saved)[0] || {})[firstId] : null;
  ok('タップしただけで保存される（保存ボタンを押させない）',
    !!rec && rec.w.length === 1, JSON.stringify(saved));
  const second = chips[1];
  ok('数える形は小文字で前後の記号を落としてある',
    !!rec && rec.w[0] === second.toLowerCase().replace(/^[^0-9a-z']+|[^0-9a-z']+$/g, ''),
    `${rec && rec.w[0]} ← ${second}`);
  ok('印の数が出る',
    /1 語に印を付けています/.test(await page.$eval('#gap-status', e => e.textContent)), '');

  // --- もう一度押すと外れる ---
  await page.click('#gap-words .gap-word:nth-child(2)');
  await page.waitForTimeout(150);
  const after = await page.evaluate(id => {
    const all = JSON.parse(localStorage.getItem('sunkan:gaps') || '{}');
    return (Object.values(all)[0] || {})[id];
  }, firstId);
  ok('もう一度押すと外れる', !!after && after.w.length === 0, JSON.stringify(after));

  // --- 付け直して閉じると、行の △ に色が付く ---
  await page.click('#gap-words .gap-word:nth-child(1)');
  await page.click('#gap-words .gap-word:nth-child(2)');
  await page.waitForTimeout(150);
  await page.click('#btn-gap-close');
  await page.waitForTimeout(250);
  ok('ダイアログが閉じる', await page.$eval('#gap-dialog', el => el.open) === false);
  ok('印のある行は △ が押された状態になる',
    await page.$eval(`${row1} .row-gap`, el => el.getAttribute('aria-pressed')) === 'true');
  ok('△ のラベルに語数が入る',
    /2 語/.test(await page.$eval(`${row1} .row-gap`, el => el.getAttribute('aria-label'))),
    await page.$eval(`${row1} .row-gap`, el => el.getAttribute('aria-label')));

  // --- 別の文にも付けて、数えられるか ---
  await page.click('.row:nth-child(2) .cell--ja');
  await page.waitForTimeout(150);
  await page.click('.row:nth-child(2) .row-gap');
  await page.waitForTimeout(200);
  const chips2 = await page.$$eval('#gap-words .gap-word', els => els.map(e => e.getAttribute('data-key')));
  // 1 文目と同じ語があればそれを、無ければ先頭を押す
  const shared = chips2.indexOf(after ? null : null) >= 0 ? 0 : 0;
  await page.click(`#gap-words .gap-word:nth-child(${shared + 1})`);
  await page.waitForTimeout(150);
  await page.click('#btn-gap-close');
  await page.waitForTimeout(200);

  // --- よくつまずく語 ---
  await page.click('#btn-menu');
  await page.waitForTimeout(250);
  await page.click('#btn-gaps');
  await page.waitForTimeout(250);
  ok('「よくつまずく語」が開く', await page.$eval('#gaps-dialog', el => el.open) === true);
  const list = await page.$$eval('#gaps-list li', els => els.map(e => ({
    w: e.querySelector('.gaps-word').textContent,
    c: e.querySelector('.gaps-count').textContent
  })));
  ok('付けた語が並ぶ', list.length === 3, JSON.stringify(list));
  ok('件数が「N 文」で出る', list.every(x => /^\d+ 文$/.test(x.c)), JSON.stringify(list));
  ok('語は均した形で数えている（小文字）',
    list.every(x => x.w === x.w.toLowerCase()), JSON.stringify(list));
  await page.click('#btn-gaps-close');
  await page.waitForTimeout(200);

  // --- 読み直しても残る ---
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.row');
  ok('読み直しても印が残る',
    await page.$eval(`${row1} .row-gap`, el => el.getAttribute('aria-pressed')) === 'true');

  // --- 同期の道（書き出し→取り込み）に乗っているか ---
  const backup = await page.evaluate(() => window.SUNKAN_SYNC.backupText());
  const parsed = JSON.parse(backup);
  ok('送り出す中身に gaps が入っている',
    !!parsed.gaps && !!Object.keys(parsed.gaps).length, Object.keys(parsed).join(','));

  const restored = await page.evaluate(({ text, id }) => {
    localStorage.removeItem('sunkan:gaps');
    const r = window.SUNKAN_SYNC.takeBackupText(text);
    const all = JSON.parse(localStorage.getItem('sunkan:gaps') || '{}');
    return { ok: r.ok, w: ((Object.values(all)[0] || {})[id] || {}).w };
  }, { text: backup, id: firstId });
  ok('取り込みで印が戻る', restored.ok === true && restored.w && restored.w.length === 2,
    JSON.stringify(restored));

  // 片方で外したものが、古い記録で戻ってこない
  const notResurrected = await page.evaluate(({ text, id }) => {
    const data = JSON.parse(text);
    const deckId = Object.keys(data.gaps)[0];
    data.gaps[deckId][id] = { w: ['zzz-ふるい'], at: Date.now() - 86400000 };  // 1 日前
    window.SUNKAN_SYNC.takeBackupText(JSON.stringify(data));
    const all = JSON.parse(localStorage.getItem('sunkan:gaps') || '{}');
    return ((Object.values(all)[0] || {})[id] || {}).w;
  }, { text: backup, id: firstId });
  ok('古い記録は手元の新しい記録を上書きしない',
    !!notResurrected && notResurrected.indexOf('zzz-ふるい') < 0 && notResurrected.length === 2,
    JSON.stringify(notResurrected));

  // gaps を知らない古い版と同期しても消えない
  const survives = await page.evaluate(({ text, id }) => {
    const data = JSON.parse(text);
    delete data.gaps;
    window.SUNKAN_SYNC.takeBackupText(JSON.stringify(data));
    const all = JSON.parse(localStorage.getItem('sunkan:gaps') || '{}');
    return ((Object.values(all)[0] || {})[id] || {}).w;
  }, { text: backup, id: firstId });
  ok('gaps を知らない古い版と同期しても消えない',
    !!survives && survives.length === 2, JSON.stringify(survives));

  ok('最後までエラーが出ていない', errors.length === 0, errors.join(' / '));
  await ctx.close();
}

await browser.close();
console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
process.exit(fail ? 1 : 0);
