/* 瞬間英作文でも AI の音声が使えるか。
 *
 * 使い方:
 *   python3 -m http.server 8599 --bind 127.0.0.1 &
 *   node tests/fake-worker.mjs 8600 &
 *   node tests/drillttstest.mjs
 *
 * 中身はリスニングと同じ仕組み（置き場で作って端末にしまう）。
 * ここで見るのは「何回 作らせに行ったか」と「入／切が 2 つのモードで共通か」。
 * 声の良し悪しは端末と Cloudflare の都合なので見ない。
 *
 * **iPhone 幅 390 と Mac 幅 1180 の両方**で通します。
 */
const PLAYWRIGHT = process.env.PLAYWRIGHT_PKG || '/opt/node-tools/node_modules/playwright/index.mjs';
const { chromium } = await import(PLAYWRIGHT);
const APP = `http://127.0.0.1:${process.env.PORT || '8599'}/`;
const WORKER = `http://127.0.0.1:${process.env.WPORT || '8600'}`;

/* Chromium の置き場は、入れ物（コンテナ）が替わると動く。決め打ちにすると
   中身とは関係ないところでテストが落ちるので、**あるものを探してから使う**。 */
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

const browser = await chromium.launch(LAUNCH);

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
  await page.evaluate(w => {
    localStorage.setItem('sunkan:sync:cfUrl', w);
    localStorage.setItem('sunkan:sync:cfRoom', 'drillai-room-abcdefgh');
  }, WORKER);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.row');

  /* 道具は「開いた行・いまの行」にしか出ない。1 行目を開いてから見る。
     **狭い幅では、上の帯や道具列が重なって指が届かない**ので、
     ここは要素そのものに click() を送る（押したときの動きを見るテストで、
     指の当たり判定を見るテストではない）。 */
  const tap = sel => page.$eval(sel, el => el.click());
  await tap('#rows .row:nth-child(1) .row-main');
  await page.waitForTimeout(300);
  ok('切のときは置き場に行かない', made === 0, '行った回数 ' + made);

  // --- ☰ → 音声の設定 → AI の音声を入にする ---
  await tap('#btn-menu'); await page.waitForTimeout(300);
  await tap('#btn-voice'); await page.waitForTimeout(400);
  ok('音声の設定に「AI の音声」がある', (await page.$('#opt-ai-voice')) !== null);
  await page.check('#opt-ai-voice');

  // 先読みが落ち着くまで待つ（上限 20 文・1 つずつ・400ms 間隔）
  for (let i = 0; i < 40; i++) {
    const a = made;
    await page.waitForTimeout(700);
    if (made === a) break;
  }
  ok('押す前に用意しておく', made > 0, '行った回数 ' + made);
  ok('用意するのは上限（20 文）まで', made <= 20, '行った回数 ' + made);

  const saved = await page.evaluate(() => window.SUNKAN_AUDIO.usage());
  ok('作った音を端末にしまう', saved.count === made && saved.bytes > 256, JSON.stringify(saved));

  await tap('#btn-voice-close').catch(() => {});
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);

  // --- 押しても、もう作らせない（しまってあるぶんで鳴らす）---
  const before = made;
  await tap('#rows .row:nth-child(1) .row-speak');
  await page.waitForTimeout(1000);
  ok('押しても作らせない（しまってあるぶんで鳴らす）', made === before, '行った回数 ' + (made - before));
  ok('音がある行は 🔈 に印が付く',
    await page.$eval('#rows .row:nth-child(1) .row-speak', e => e.classList.contains('has-audio')));

  // --- 入／切はリスニングと共通 ---
  await tap('#tab-listen');
  await page.waitForTimeout(500);
  ok('リスニング側の札も入になっている',
    (await page.$eval('#btn-listen-ai', e => e.getAttribute('aria-pressed'))) === 'true');

  // リスニング側で切にすると、瞬間英作文の設定も切になる
  await tap('#btn-listen-ai');
  await page.waitForTimeout(400);
  ok('リスニングで切にすると設定も切になる',
    (await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('sunkan:settings') || '{}');
      return s.aiVoice === false;
    })), JSON.stringify(await page.evaluate(() => localStorage.getItem('sunkan:settings'))));

  ok('JS のエラーが出ていない', errs.length === 0, errs.join(' / '));
  await ctx.close();
}

await browser.close();
console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
process.exit(fail ? 1 : 0);
