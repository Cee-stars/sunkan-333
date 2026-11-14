/* 読み上げの声えらび。
 *
 * 使い方:
 *   python3 -m http.server 8599 --bind 127.0.0.1 &
 *   node tests/voicetest.mjs
 *
 * 端末に入っている声は良し悪しの差が大きい。**最初に見つかった en-US** を使うと、
 * Mac では古い作り物の声（Fred・Zarvox など）に当たることがあり、同じ文でも聞き取れない。
 * ここでは**偽の声の一覧**を端末のふりをして流し込み、どれを選ぶかだけを見る。
 * （実際の音は、どの端末に何が入っているか次第なので、ここでは確かめられない）
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

// Mac に実際に入っている並び（古い声が先に出てくる）を真似た一覧
const FAKE = [
  { name: 'Fred', lang: 'en-US', localService: true, default: true },
  { name: 'Albert', lang: 'en-US', localService: true },
  { name: 'Zarvox', lang: 'en-US', localService: true },
  { name: 'Kyoko', lang: 'ja-JP', localService: true },
  { name: 'Daniel', lang: 'en-GB', localService: true },
  { name: 'Samantha', lang: 'en-US', localService: true },
  { name: 'Ava (Premium)', lang: 'en-US', localService: true }
];

const browser = await chromium.launch(LAUNCH);
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
await ctx.addInitScript(list => {
  // 端末のふりをする。speechSynthesis そのものは差し替えられないので、
  // getVoices だけを自分のものに置き換える
  try {
    window.speechSynthesis.getVoices = function () {
      return list.map(v => Object.assign({ voiceURI: v.name + '|' + v.lang }, v));
    };
  } catch (e) { /* 置き換えられない実装ではこのテストは成り立たない */ }
}, FAKE);

const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.row');
await page.waitForTimeout(400);

const got = await page.evaluate(() => ({
  name: window.SUNKAN_SPEECH.voiceName(),
  list: window.SUNKAN_SPEECH.voices().map(v => v.name)
}));

ok('偽の一覧が届いている', got.list.length > 0, JSON.stringify(got));
ok('いちばん良い声（プレミアム）を自分で選ぶ', got.name === 'Ava (Premium)', got.name);
ok('古い作り物の声は選ばない', !/Fred|Albert|Zarvox/.test(got.name), got.name);
ok('一覧は良い順に並ぶ', got.list[0] === 'Ava (Premium)' && got.list[1] === 'Samantha',
  got.list.join(' / '));
ok('英語でない声は一覧に出さない', got.list.indexOf('Kyoko') < 0, got.list.join(' / '));
ok('古い声も、選びたい人のために一覧には残す', got.list.indexOf('Fred') >= 0, got.list.join(' / '));
ok('JS のエラーが出ていない', errs.length === 0, errs.join(' / '));

await ctx.close();
await browser.close();
console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
process.exit(fail ? 1 : 0);
