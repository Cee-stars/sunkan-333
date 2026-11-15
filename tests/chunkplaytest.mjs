/* リスニング — **かたまり 1 つだけ**鳴らす（英文の下の番号の札）。
 *
 * 使い方:
 *   python3 -m http.server 8599 --bind 127.0.0.1 &
 *   node tests/fake-worker.mjs 8600 &
 *   node tests/chunkplaytest.mjs
 *
 * ここで見張っているのは 4 つ。
 *   ・札は**出したかたまりのぶんだけ**出る（札の数が「あと何かたまり」の答えに
 *     ならない。ぼかしているのと同じ理由で、ここが漏れると意味が無くなる）
 *   ・札を押すと**そのかたまりだけ**鳴る（まるごと鳴らしてしまわない）
 *   ・札を押しても**行は進まない**（押すたびに次が出てしまうと読めない）
 *   ・AI の音声でも同じ道を通る。かたまりの音は**別の鍵**でしまわれ、
 *     2 度は作らせない（無料枠を二重に使わない）
 *
 * 音そのものの良し悪しは端末と Cloudflare の都合なので見ない（ttstest と同じ）。
 * **iPhone 幅 390 と Mac 幅 1180 の両方**で通します。
 */
const PLAYWRIGHT = process.env.PLAYWRIGHT_PKG || '/opt/node-tools/node_modules/playwright/index.mjs';
const { chromium } = await import(PLAYWRIGHT);
const APP = `http://127.0.0.1:${process.env.PORT || '8599'}/`;
const WORKER = `http://127.0.0.1:${process.env.WPORT || '8600'}`;

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
const ok = (n, c, e = '') => {
  c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + (e ? '  → ' + e : '')));
};

/* 3 かたまりの文と、1 かたまりしか無い文 */
const MANY = { en: "Let's get / a cup of coffee / after this.", ja: '行こう / コーヒーを 1 杯 / このあと' };
const MANY_CHUNKS = ["Let's get", 'a cup of coffee', 'after this.'];
const MANY_WHOLE = "Let's get a cup of coffee after this.";
const ONE = { en: 'Thanks a lot.', ja: 'ありがとう。' };

const ROW1 = '#listen-rows .row:nth-child(1)';
const ROW2 = '#listen-rows .row:nth-child(2)';

/** 読み上げを横取りして、**何を**読ませたかだけ覚える（鳴らす必要は無い） */
const SPY = () => window.__CP = {
  said: [],
  install() {
    if (!window.SUNKAN_SPEECH) return false;
    const self = this;
    window.SUNKAN_SPEECH.speak = function (text) { self.said.push(text); return true; };
    return true;
  },
  last() { return this.said.length ? this.said[this.said.length - 1] : null; },
  /** その行で見えている札（番号）だけ */
  plays(sel) {
    const row = document.querySelector(sel);
    if (!row) return [];
    return Array.prototype.slice.call(row.querySelectorAll('.listen-play'))
      .filter(b => !b.hidden && b.getBoundingClientRect().width > 0)
      .map(b => b.textContent.trim());
  },
  /** ぼけているかたまりの数（出した数の裏取り） */
  blur(sel) {
    const row = document.querySelector(sel);
    if (!row) return -1;
    return Array.prototype.slice.call(row.querySelectorAll('*'))
      .filter(el => /blur/.test(getComputedStyle(el).filter)).length;
  }
};

const browser = await chromium.launch(LAUNCH);

for (const [label, width] of [['iPhone 390', 390], ['Mac 1180', 1180]]) {
  console.log(`\n=== ${label} ===`);
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));

  // 置き場へ「作って」と行った回数を数える（ttstest と同じ手）
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
  await page.evaluate(a => window.SUNKAN_LISTEN.addItems([a.many, a.one]), { many: MANY, one: ONE });
  await page.click('#tab-listen');
  await page.waitForTimeout(400);
  await page.evaluate(SPY);
  ok('読み上げの口を横取りできた', await page.evaluate(() => window.__CP.install()));

  /* ---------- 札は、出したぶんだけ ---------- */
  ok('閉じている行に札は出ない', (await page.evaluate(() => window.__CP.plays('#listen-rows .row:nth-child(1)'))).length === 0);
  ok('閉じている行の札は hidden',
    await page.$eval(ROW1 + ' .listen-plays', e => e.hidden === true));

  const tap = async () => { await page.click(ROW1 + ' .row-main'); await page.waitForTimeout(250); };

  await tap();
  let plays = await page.evaluate(() => window.__CP.plays('#listen-rows .row:nth-child(1)'));
  ok('1 かたまり出すと札は 1 つ', plays.length === 1 && plays[0] === '1', JSON.stringify(plays));
  ok('札の数と「出した数」が合う（ぼけ 2）',
    await page.evaluate(() => window.__CP.blur('#listen-rows .row:nth-child(1)')) === 2);

  await tap();
  plays = await page.evaluate(() => window.__CP.plays('#listen-rows .row:nth-child(1)'));
  ok('2 かたまり目で札は 2 つ', plays.join(',') === '1,2', JSON.stringify(plays));

  await tap();
  plays = await page.evaluate(() => window.__CP.plays('#listen-rows .row:nth-child(1)'));
  ok('ぜんぶ出すと札は 3 つ', plays.join(',') === '1,2,3', JSON.stringify(plays));

  /* ---------- 札を押すと、そのかたまりだけ鳴る ---------- */
  ok('札に中身が書いてある（読み上げ用）',
    (await page.$eval(ROW1 + ' .listen-play[data-i="1"]', e => e.getAttribute('aria-label')))
      .indexOf(MANY_CHUNKS[1]) >= 0,
    await page.$eval(ROW1 + ' .listen-play[data-i="1"]', e => e.getAttribute('aria-label')));

  const blurBefore = await page.evaluate(() => window.__CP.blur('#listen-rows .row:nth-child(1)'));
  await page.click(ROW1 + ' .listen-play[data-i="1"]');
  await page.waitForTimeout(250);
  ok('2 つめの札で、2 つめのかたまりだけ鳴る',
    await page.evaluate(() => window.__CP.last()) === MANY_CHUNKS[1],
    String(await page.evaluate(() => window.__CP.last())));
  ok('札を押しても行は進まない（出した数が変わらない）',
    await page.evaluate(() => window.__CP.blur('#listen-rows .row:nth-child(1)')) === blurBefore);
  ok('札を押しても閉じない（札は 3 つのまま）',
    (await page.evaluate(() => window.__CP.plays('#listen-rows .row:nth-child(1)'))).join(',') === '1,2,3');

  await page.click(ROW1 + ' .listen-play[data-i="0"]');
  await page.waitForTimeout(200);
  ok('1 つめの札では 1 つめだけ鳴る',
    await page.evaluate(() => window.__CP.last()) === MANY_CHUNKS[0],
    String(await page.evaluate(() => window.__CP.last())));

  /* ---------- 左の 🔈 は、今までどおり「まるごと」 ---------- */
  await page.click(ROW1 + ' .listen-speak');
  await page.waitForTimeout(250);
  ok('左の 🔈 は文をまるごと鳴らす（スラッシュは読ませない）',
    await page.evaluate(() => window.__CP.last()) === MANY_WHOLE,
    String(await page.evaluate(() => window.__CP.last())));

  /* ---------- 札はどのかたまりか分かる（触れると下線） ---------- */
  await page.focus(ROW1 + ' .listen-play[data-i="2"]');
  await page.waitForTimeout(150);
  const cued = await page.$$eval(ROW1 + ' .listen-chunk', els =>
    els.map(e => e.classList.contains('is-cued')));
  ok('札に止まると、そのかたまりに下線が付く', cued.join(',') === 'false,false,true', JSON.stringify(cued));
  await page.evaluate(() => document.activeElement.blur());
  await page.waitForTimeout(150);
  ok('札から離れると下線が消える',
    (await page.$$eval(ROW1 + ' .listen-chunk', els => els.filter(e => e.classList.contains('is-cued')).length)) === 0);

  /* ---------- 閉じると札も畳む ---------- */
  await tap();   // ぜんぶ出したあとのタップ＝最初に戻る
  ok('最初に戻すと札も消える',
    (await page.evaluate(() => window.__CP.plays('#listen-rows .row:nth-child(1)'))).length === 0);
  ok('最初に戻すと札は hidden に戻る',
    await page.$eval(ROW1 + ' .listen-plays', e => e.hidden === true));

  /* ---------- かたまりが 1 つの文には札を出さない ---------- */
  await page.click(ROW2 + ' .row-main');
  await page.waitForTimeout(250);
  ok('かたまりが 1 つの文には札を作らない（左の 🔈 と同じになるので）',
    await page.$$eval(ROW2 + ' .listen-play', els => els.length) === 0);

  /* ---------- 自動読み上げでも「かたまりだけ」 ---------- */
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('sunkan:settings') || '{}');
    s.autoSpeak = true;
    localStorage.setItem('sunkan:settings', JSON.stringify(s));
  });
  await tap();
  ok('自動読み上げでも、出したかたまりだけ鳴る',
    await page.evaluate(() => window.__CP.last()) === MANY_CHUNKS[0],
    String(await page.evaluate(() => window.__CP.last())));
  await tap();
  ok('2 つめを出したら 2 つめだけ鳴る',
    await page.evaluate(() => window.__CP.last()) === MANY_CHUNKS[1],
    String(await page.evaluate(() => window.__CP.last())));

  /* ---------- 置き場が無いので、まだ 1 度も作らせていない ---------- */
  ok('AI が切なら置き場に行かない', made === 0, '行った回数 ' + made);

  /* ---------- 画面からはみ出さない・道具の下に潜らない ---------- */
  const layout = await page.evaluate(() => {
    const W = document.documentElement.clientWidth;
    const row = document.querySelector('#listen-rows .row:nth-child(1)');
    const box = el => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width }; };
    const strip = box(row.querySelector('.listen-plays'));
    const tools = box(row.querySelector('.row-tools'));
    let under = 0;
    row.querySelectorAll('.listen-play').forEach(function (b) {
      if (b.hidden) return;
      const a = box(b);
      if (a.w && a.r > tools.l + 1 && a.l < tools.r - 1 && a.b > tools.t + 1 && a.t < tools.b - 1) under++;
    });
    return { under, scroll: document.documentElement.scrollWidth > W + 1, stripW: strip.w, right: strip.r <= W + 1 };
  });
  ok('札が行の道具（↻ ✎ 🗑）の下に潜らない', layout.under === 0, '隠れ ' + layout.under);
  ok('札のぶんで横スクロールが出ない', layout.scroll === false);
  ok('札が画面の外に出ない', layout.right === true);

  ok('ここまで JS のエラーが出ていない', errs.length === 0, errs.join(' / '));

  /* =========================================================
   * AI の音声でも同じ道を通る（別の鍵でしまう・2 度は作らせない）
   * ======================================================= */
  await page.evaluate(w => {
    localStorage.setItem('sunkan:sync:cfUrl', w);
    localStorage.setItem('sunkan:sync:cfRoom', 'chunkplay-room-abcdefgh');
    // 片方の文だけにして、作らせる数をはっきりさせる
    const items = JSON.parse(localStorage.getItem('sunkan:listen:items') || '[]');
    localStorage.setItem('sunkan:listen:items', JSON.stringify(items.slice(0, 1)));
    const s = JSON.parse(localStorage.getItem('sunkan:settings') || '{}');
    s.autoSpeak = false;   // 自動読み上げは切っておく（数えたいのは札のぶんだけ）
    localStorage.setItem('sunkan:settings', JSON.stringify(s));
  }, WORKER);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(ROW1, { timeout: 15000 });
  await page.waitForTimeout(400);
  await page.evaluate(SPY);
  await page.evaluate(() => window.__CP.install());
  await page.evaluate(() => window.SUNKAN_AUDIO.clear());
  made = 0;

  // AI を入にすると、まず**まるごと**のぶんを用意する
  await page.click('#btn-listen-ai');
  await page.waitForTimeout(2500);
  ok('AI を入にすると、まるごとのぶんを用意する', made === 1, '行った回数 ' + made);

  // 行を開くと、**その行のかたまり**のぶんを用意する（3 つ）
  await page.click(ROW1 + ' .row-main');
  await page.waitForTimeout(5000);
  ok('行を開くと、その行のかたまりのぶんも用意する（1 + 3）', made === 4, '行った回数 ' + made);

  const saved = await page.evaluate(() => window.SUNKAN_AUDIO.usage());
  ok('まるごとと、かたまり 3 つを別々にしまう', saved.count === 4, JSON.stringify(saved));

  const keys = await page.evaluate(a => ({
    whole: window.SUNKAN_AUDIO.keyFor(a.whole, 'ai'),
    chunk: window.SUNKAN_AUDIO.keyFor(a.chunk, 'ai')
  }), { whole: MANY_WHOLE, chunk: MANY_CHUNKS[1] });
  ok('まるごととかたまりで鍵が違う（取り違えない）', keys.whole !== keys.chunk, JSON.stringify(keys));

  ok('用意できた札に印が付く',
    await page.$eval(ROW1 + ' .listen-play[data-i="0"]', e => e.classList.contains('has-audio')));

  // 押しても、もう作らせない（しまってあるぶんで鳴る）
  // 出しているのは 1 かたまりなので、押せる札も 1 つめだけ
  ok('出していないかたまりの札は押せない（畳んである）',
    await page.$eval(ROW1 + ' .listen-play[data-i="1"]', e => e.hidden === true));
  await page.click(ROW1 + ' .listen-play[data-i="0"]');
  await page.waitForTimeout(1200);
  ok('札を押しても、もう作らせない', made === 4, '行った回数 ' + made);
  ok('しまってあるぶんで鳴るので、端末の声は使わない',
    (await page.evaluate(() => window.__CP.said.length)) === 0,
    JSON.stringify(await page.evaluate(() => window.__CP.said)));

  // 置き場を外すと、黙って端末の声に戻る
  await page.evaluate(() => {
    localStorage.removeItem('sunkan:sync:cfUrl');
    localStorage.removeItem('sunkan:sync:cfRoom');
    window.SUNKAN_AUDIO.clear();
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(ROW1, { timeout: 15000 });
  await page.waitForTimeout(400);
  await page.evaluate(SPY);
  await page.evaluate(() => window.__CP.install());
  const before = made;
  await page.click(ROW1 + ' .row-main');
  await page.waitForTimeout(300);
  await page.click(ROW1 + ' .listen-play[data-i="0"]');
  await page.waitForTimeout(900);
  ok('置き場が無ければ作りに行かない', made === before, '行った回数 ' + (made - before));
  ok('置き場が無いときは端末の声でそのかたまりを鳴らす',
    await page.evaluate(() => window.__CP.last()) === MANY_CHUNKS[0],
    String(await page.evaluate(() => window.__CP.last())));

  ok('JS のエラーが出ていない', errs.length === 0, errs.join(' / '));
  await ctx.close();
}

await browser.close();
console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
process.exit(fail ? 1 : 0);
