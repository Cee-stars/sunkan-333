/* AI の音声（置き場で作って、端末にしまう）。
 *
 * 使い方:
 *   python3 -m http.server 8599 --bind 127.0.0.1 &
 *   node tests/fake-worker.mjs 8600 &
 *   node tests/ttstest.mjs
 *
 * 置き場は `cloudflare/worker.mjs` をそのまま動かしている（tests/fake-worker.mjs）。
 * Workers AI の口だけ偽物で、**それらしい大きさの音**を返す。
 * ここで見るのは「何回 作らせに行ったか」と「しまったぶんで鳴るか」。
 * 音そのものの良し悪しは、端末に入っているものと Cloudflare 側の都合なので見ない。
 *
 * **iPhone 幅 390 と Mac 幅 1180 の両方**で通します。
 */
const PLAYWRIGHT = process.env.PLAYWRIGHT_PKG || '/opt/node-tools/node_modules/playwright/index.mjs';
const { chromium } = await import(PLAYWRIGHT);
const APP = `http://127.0.0.1:${process.env.PORT || '8599'}/`;
const WORKER = `http://127.0.0.1:${process.env.WPORT || '8600'}`;
const EXEC = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + (e ? '  → ' + e : ''))); };

const SENTENCE = 'Could you say that again / a little more slowly?';

const browser = await chromium.launch({ executablePath: EXEC });

for (const [label, width] of [['iPhone 390', 390], ['Mac 1180', 1180]]) {
  console.log(`\n=== ${label} ===`);
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));

  // 置き場へ「作って」と行った回数を数える
  let made = 0;
  await page.route('**/*', async route => {
    const req = route.request();
    if (req.method() === 'POST' && req.url().indexOf('8600') >= 0) {
      let body = {};
      try { body = JSON.parse(req.postData() || '{}'); } catch (e) { /* 形が違えば数えない */ }
      if (body.op === 'tts') made++;
    }
    await route.continue();
  });

  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.row');

  // 置き場をつないで、文を 1 つ入れる
  await page.evaluate(w => {
    localStorage.setItem('sunkan:sync:cfUrl', w);
    localStorage.setItem('sunkan:sync:cfRoom', 'ttstest-room-abcdefgh');
  }, WORKER);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.row');
  await page.evaluate(s => window.SUNKAN_LISTEN.addItems([{ en: s, ja: '', note: '' }]), SENTENCE);
  await page.click('#tab-listen');
  await page.waitForTimeout(400);

  // --- 切のままなら、置き場には行かない（端末の声のまま）---
  ok('はじめは AI の音声は切', (await page.$eval('#btn-listen-ai', e => e.getAttribute('aria-pressed'))) === 'false');
  await page.click('#listen-rows .row:nth-child(1) .listen-speak');
  await page.waitForTimeout(600);
  ok('切のときは置き場に行かない', made === 0, '行った回数 ' + made);

  // --- 入にする ---
  await page.click('#btn-listen-ai');
  await page.waitForTimeout(300);
  ok('入にすると札が光る', (await page.$eval('#btn-listen-ai', e => e.getAttribute('aria-pressed'))) === 'true');

  // --- 1 回目は作らせに行く ---
  await page.click('#listen-rows .row:nth-child(1) .listen-speak');
  await page.waitForTimeout(2000);
  ok('1 回目は置き場で作る', made === 1, '行った回数 ' + made);
  ok('できたことを知らせる', /できました/.test(await page.$eval('#listen-status', e => e.textContent)),
    await page.$eval('#listen-status', e => e.textContent));

  const saved = await page.evaluate(() => window.SUNKAN_AUDIO.usage());
  ok('作った音を端末にしまう', saved.count === 1 && saved.bytes > 256, JSON.stringify(saved));

  // --- 2 回目は作らせない（しまってあるぶんで鳴らす）---
  await page.click('#listen-rows .row:nth-child(1) .listen-speak');
  await page.waitForTimeout(1200);
  ok('2 回目は作らせない（しまってあるぶんで鳴らす）', made === 1, '行った回数 ' + made);

  // --- 読み直しても残る（無料枠を二度使わない）---
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#listen-rows .row', { timeout: 15000 });
  await page.waitForTimeout(500);
  ok('読み直しても入のまま', (await page.$eval('#btn-listen-ai', e => e.getAttribute('aria-pressed'))) === 'true');
  await page.click('#listen-rows .row:nth-child(1) .listen-speak');
  await page.waitForTimeout(1200);
  ok('読み直しても作らせない', made === 1, '行った回数 ' + made);
  ok('音がある行は 🔈 に印が付く',
    await page.$eval('#listen-rows .row:nth-child(1) .listen-speak', e => e.classList.contains('has-audio')));

  // --- 文を直したら、古い音は鳴らさない（鍵が変わる）---
  await page.evaluate(() => {
    const k1 = window.SUNKAN_AUDIO.keyFor('Could you say that again a little more slowly?', 'ai');
    const k2 = window.SUNKAN_AUDIO.keyFor('Could you say that again a little faster?', 'ai');
    window.__k = { k1, k2 };
  });
  const keys = await page.evaluate(() => window.__k);
  ok('文が違えば鍵も違う', keys.k1 !== keys.k2, JSON.stringify(keys));

  // --- 置き場が無いときは、黙って端末の声に戻る ---
  await page.evaluate(() => {
    localStorage.removeItem('sunkan:sync:cfUrl');
    localStorage.removeItem('sunkan:sync:cfRoom');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#listen-rows .row', { timeout: 15000 });
  await page.waitForTimeout(400);
  await page.evaluate(s => window.SUNKAN_LISTEN.addItems([{ en: s, ja: '', note: '' }]),
    'This one has no audio yet.');
  await page.waitForTimeout(300);
  const before = made;
  await page.click('#listen-rows .row:nth-child(2) .listen-speak');
  await page.waitForTimeout(800);
  ok('置き場が無ければ作りに行かない', made === before, '行った回数 ' + (made - before));
  ok('置き場が要ることを知らせる',
    /置き場/.test(await page.$eval('#listen-status', e => e.textContent)),
    await page.$eval('#listen-status', e => e.textContent));

  ok('JS のエラーが出ていない', errs.length === 0, errs.join(' / '));
  await ctx.close();
}

await browser.close();
console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
process.exit(fail ? 1 : 0);
