/* 自分の置き場（Cloudflare Worker）で 2 台が揃うか。
 *
 * 使い方:
 *   python3 -m http.server 8599 --bind 127.0.0.1 &
 *   node tests/fake-worker.mjs 8600 &
 *   node tests/synctest.mjs
 *
 * 置き場は `cloudflare/worker.mjs` をそのまま動かしている（tests/fake-worker.mjs）。
 * つまりここで通れば、Cloudflare に置いたものも同じように動く。
 */
const PLAYWRIGHT = process.env.PLAYWRIGHT_PKG || '/opt/node-tools/node_modules/playwright/index.mjs';
const { chromium } = await import(PLAYWRIGHT);
const APP = `http://127.0.0.1:${process.env.PORT || '8599'}/`;
const WORKER = `http://127.0.0.1:${process.env.WPORT || '8600'}`;
const EXEC = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + (e ? '  → ' + e : ''))); };

const browser = await chromium.launch({ executablePath: EXEC });

/** 1 台ぶんを開く。端末ごとに別の入れ物にする（localStorage を分けるため） */
async function device(label, width) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(label + ': ' + e));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.row');
  return { ctx, page, errs, label };
}

async function openSync(d) {
  await d.page.click('#btn-settings');
  await d.page.waitForTimeout(250);
  await d.page.click('#btn-sync-open');
  await d.page.waitForTimeout(300);
}

async function syncNow(d) {
  await d.page.click('#btn-sync-now');
  // 往復を待つ
  for (let i = 0; i < 40; i++) {
    const t = await d.page.$eval('#sync-status', e => e.textContent.trim());
    if (t && !/同期しています/.test(t)) return t;
    await d.page.waitForTimeout(150);
  }
  return await d.page.$eval('#sync-status', e => e.textContent.trim());
}

const A = await device('A（iPhone 想定）', 390);
const B = await device('B（Mac 想定）', 1180);

// --- A：フレーズを 2 件入れて、置き場に繋ぐ ---
await A.page.evaluate(() => window.SUNKAN_PHRASE.addPhrases([
  { ja: 'ちょっと待って', en: 'Hold on a second.', scene: '電話', note: '' },
  { ja: 'お会計をお願いします', en: 'Could I get the check?', scene: '食事', note: '' }
]));
await A.page.waitForTimeout(200);

await openSync(A);
await A.page.fill('#sync-cf-url', WORKER);
await A.page.click('#btn-sync-cf-make');
await A.page.waitForTimeout(300);
const room = await A.page.inputValue('#sync-cf-room');
ok('合言葉ができる', /^[a-z0-9-]{16,64}$/.test(room), room);
ok('合言葉は紛らわしい文字を使わない', !/[l1o0]/.test(room), room);

const msgA = await syncNow(A);
ok('A が同期できる', /同期しました/.test(msgA), msgA);

// --- B：同じ URL と合言葉を入れるだけ ---
await openSync(B);
await B.page.fill('#sync-cf-url', WORKER);
await B.page.fill('#sync-cf-room', room);
const msgB = await syncNow(B);
ok('B が同期できる', /同期しました/.test(msgB), msgB);

const gotB = await B.page.evaluate(() => JSON.parse(localStorage.getItem('sunkan:phrase:items') || '[]'));
ok('B に A のフレーズが届く', gotB.length === 2, JSON.stringify(gotB.map(x => x.ja)));
ok('中身が壊れていない', gotB.some(x => x.ja === 'ちょっと待って' && x.en === 'Hold on a second.'), JSON.stringify(gotB[0]));
ok('場面も届く', gotB.some(x => x.scene === '食事'), JSON.stringify(gotB.map(x => x.scene)));

// --- B で足して、A へ戻るか ---
await B.page.evaluate(() => window.SUNKAN_PHRASE.addPhrases([
  { ja: 'また連絡します', en: "I'll get back to you.", scene: '仕事', note: '' }
]));
await B.page.waitForTimeout(200);
ok('B の 2 回目の同期', /同期しました/.test(await syncNow(B)));
const msgA2 = await syncNow(A);
ok('A の 2 回目の同期', /同期しました/.test(msgA2), msgA2);
const gotA = await A.page.evaluate(() => JSON.parse(localStorage.getItem('sunkan:phrase:items') || '[]'));
ok('A に B のぶんが戻る（3 件）', gotA.length === 3, JSON.stringify(gotA.map(x => x.ja)));

// --- どちらで足したものも消えない（同時に足して、両方残るか）---
await A.page.evaluate(() => window.SUNKAN_PHRASE.addPhrases([
  { ja: 'Aだけの文', en: 'Only on A.', scene: '', note: '' }
]));
await B.page.evaluate(() => window.SUNKAN_PHRASE.addPhrases([
  { ja: 'Bだけの文', en: 'Only on B.', scene: '', note: '' }
]));
await A.page.waitForTimeout(200);
await syncNow(A);
await syncNow(B);
await syncNow(A);
const finalA = await A.page.evaluate(() => JSON.parse(localStorage.getItem('sunkan:phrase:items') || '[]'));
const finalB = await B.page.evaluate(() => JSON.parse(localStorage.getItem('sunkan:phrase:items') || '[]'));
const jaA = finalA.map(x => x.ja).sort().join(',');
const jaB = finalB.map(x => x.ja).sort().join(',');
ok('両方の端末で足したものが、どちらにも残る', finalA.length === 5, jaA);
ok('2 台の中身が一致する', jaA === jaB, jaA + '  /  ' + jaB);

// --- 設定は同期に載せない（鍵を配らない）---
const leaked = await A.page.evaluate(() => {
  const s = window.SUNKAN_SYNC.backupText();
  return s.indexOf('cfRoom') >= 0 || s.indexOf('sync:cf') >= 0;
});
ok('合言葉と URL は同期データに入らない', leaked === false);

// --- 状態の表示には、合言葉の末尾だけを出す（丸ごとは出さない）---
// 入力欄には出す（本人が読んで 2 台目に入れるため）。出してはいけないのは
// 「いまの状態」の文で、ここは人に画面を見せることがある。
// 「いまの状態」はダイアログを開いた瞬間に出る。同期直後は結果の文が出ているので、
// 一度閉じて開き直してから読む
await A.page.click('#btn-sync-close');
await A.page.waitForTimeout(250);
await openSync(A);
const whenText = await A.page.evaluate(() => {
  const el = document.getElementById('sync-status');
  return el ? el.textContent : '';
});
ok('状態の文に合言葉を丸ごと出さない', whenText.indexOf(room) < 0, whenText.slice(0, 120));
ok('同じものを入れたか照合できる末尾は出す',
   whenText.indexOf(room.slice(-4)) >= 0 || whenText === '', whenText.slice(0, 120));

ok('JS エラーが出ていない', A.errs.length === 0 && B.errs.length === 0, A.errs.concat(B.errs).join(' / '));

await A.ctx.close(); await B.ctx.close();
await browser.close();
console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
process.exit(fail ? 1 : 0);
