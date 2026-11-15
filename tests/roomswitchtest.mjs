/* 合言葉（部屋）を取り替えたとき、先に入っていたものが消えないか。
 *
 * 使い方:
 *   python3 -m http.server 8599 --bind 127.0.0.1 &
 *   node tests/fake-worker.mjs 8600 &
 *   node tests/roomswitchtest.mjs
 *
 * なぜ要るか:
 *   2 台が**別々の置き場（URL も合言葉も違う）**を入れていた、ということが実際にあった。
 *   どちらも「同期しました」と出るので、本人は繋がっているつもりのまま、
 *   中身だけが一生合わない。直し方は「片方の URL と合言葉を、もう片方と同じに書き換える」。
 *   そのとき聞かれるのは必ずこれ:「書き換えたら、いま iPhone に入っているものは消える？」
 *   答えは「消えない。足し算なので両方残る」だが、**言葉で言うだけでは証にならない**。
 *   ここでその一言を実際に動かして見張る。消えるようになったら、ここが落ちる。
 *
 * 見張るもの:
 *   1. 別の部屋どうしだと、両方「同期しました」なのに中身が届かない（＝症状そのもの）
 *   2. 合言葉を相手と同じに書き換えて同期すると、**こちらのぶんは 1 件も減らない**
 *   3. 同時に、相手のぶんが届く → もう一度相手が同期すれば 2 台の中身が一致する
 *   4. 消した記録（tombstone）は部屋を移ったあとも効く（消したものは消えたまま）
 *
 * データは 1 種類では足りない。瞬間英作文の「足した文」（セットの下にぶら下がる）・
 * 場面（phrase: ひらたい並び）・リスニング（listen: プレイリスト付き）で、
 * 突き合わせの作りがそれぞれ違うため、3 つとも見る。
 *
 * 置き場は `cloudflare/worker.mjs` をそのまま動かしている（tests/fake-worker.mjs）。
 */
const PLAYWRIGHT = process.env.PLAYWRIGHT_PKG || '/opt/node-tools/node_modules/playwright/index.mjs';
const { chromium } = await import(PLAYWRIGHT);
const APP = `http://127.0.0.1:${process.env.PORT || '8599'}/`;
const WORKER = `http://127.0.0.1:${process.env.WPORT || '8600'}`;

// 部屋は走らせるたびに別にする。同じ部屋を使い回すと、前の回のぶんが
// 置き場に残っていて件数が合わなくなる（listensynctest で実際に 53 → 106 になった）
const tag = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
const ROOM1 = 'roomswitch-mac-' + tag();    // Mac 側の部屋（本物の置き場）
const ROOM2 = 'roomswitch-ip-' + tag();     // iPhone が間違えて入れていた部屋

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

const browser = await chromium.launch(LAUNCH);

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

/**
 * 置き場の URL と合言葉を**画面の欄に打ち込んで**同期する。
 * localStorage に直接書いても同期はできるが、利用者がやるのは「欄を書き換える」。
 * 書き換えが保存される道（change → saveFields）ごと見張りたいので、欄を使う。
 * 終わったらダイアログを閉じる（次の回にまた開き直せるように）。
 */
async function syncWith(d, url, room) {
  await d.page.click('#btn-settings');
  await d.page.waitForTimeout(250);
  await d.page.click('#btn-sync-open');
  await d.page.waitForTimeout(300);
  if (url !== null) await d.page.fill('#sync-cf-url', url);
  if (room !== null) await d.page.fill('#sync-cf-room', room);
  await d.page.click('#btn-sync-now');
  // 往復を待つ
  for (let i = 0; i < 60; i++) {
    const t = await d.page.$eval('#sync-status', e => e.textContent.trim());
    if (t && !/同期しています/.test(t)) break;
    await d.page.waitForTimeout(150);
  }
  const text = await d.page.$eval('#sync-status', e => e.textContent.trim());
  await d.page.click('#btn-sync-close').catch(() => {});
  await d.page.waitForTimeout(250);
  return text;
}

/** いまこの端末に何が入っているか。3 種類まとめて数える */
const snap = d => d.page.evaluate(() => {
  const g = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const added = g('sunkan:added') || {};
  const addedList = [];
  Object.keys(added).forEach(id => (added[id] || []).forEach(x => addedList.push(x.ja + ' / ' + x.en)));
  return {
    added: addedList.sort(),
    phrase: (g('sunkan:phrase:items') || []).map(x => x.ja).sort(),
    listen: (g('sunkan:listen:items') || []).map(x => x.en).sort(),
    decks: (g('sunkan:decks') || []).map(x => x.name).sort(),
    listenDecks: (g('sunkan:listen:decks') || []).map(x => x.name).sort()
  };
});
const sameAs = (x, y) => x.added.join('|') === y.added.join('|')
  && x.phrase.join('|') === y.phrase.join('|')
  && x.listen.join('|') === y.listen.join('|');

// A = Mac 想定（幅 1180）、B = iPhone 想定（幅 390）。
// 幅で出来が変わる作りなので、**両方の幅で通ること**をこの 1 本で見る
const A = await device('A（Mac 想定）', 1180);
const B = await device('B（iPhone 想定）', 390);

/* ============================================================
 * 1. A（Mac）を本物の部屋 R1 につなぎ、A だけが持つものを入れる
 * ========================================================== */

await A.page.evaluate(() => {
  window.SUNKAN_DRILL.addSentences('Mac のセット', [
    { ja: 'Mac で足した文 1', en: 'Added on the Mac one.', note: '' },
    { ja: 'Mac で足した文 2', en: 'Added on the Mac two.', note: '' }
  ]);
  window.SUNKAN_PHRASE.addPhrases([
    { ja: 'Mac の場面 1', en: 'Mac scene one.', scene: '仕事', note: '' },
    { ja: 'Mac の場面 2', en: 'Mac scene two.', scene: '仕事', note: '' }
  ]);
  localStorage.setItem('sunkan:listen:decks', JSON.stringify([{ id: 'pl-mac', name: 'Mac のプレイリスト', created: 1 }]));
});
await A.page.reload({ waitUntil: 'domcontentloaded' });
await A.page.waitForSelector('.row');
await A.page.evaluate(() => window.SUNKAN_LISTEN.addItems([
  { en: 'Mac listening one.', ja: 'Mac のリスニング 1', note: '', deck: 'pl-mac' },
  { en: 'Mac listening two.', ja: 'Mac のリスニング 2', note: '', deck: 'pl-mac' }
]));
await A.page.waitForTimeout(200);

const a0 = await snap(A);
ok('A に 3 種類とも入った', a0.added.length === 2 && a0.phrase.length === 2 && a0.listen.length === 2,
   JSON.stringify([a0.added.length, a0.phrase.length, a0.listen.length]));

const msgA1 = await syncWith(A, WORKER, ROOM1);
ok('A が R1 に同期できる', /同期しました/.test(msgA1), msgA1.split('\n')[0]);

/* ============================================================
 * 2. B（iPhone）は**別の部屋 R2**。B だけが持つものを入れる
 *    ここが利用者の状態。URL も合言葉も違うので、繋がっているのに揃わない
 * ========================================================== */

await B.page.evaluate(() => {
  window.SUNKAN_DRILL.addSentences('iPhone のセット', [
    { ja: 'iPhone で足した文 1', en: 'Added on the phone one.', note: '' },
    { ja: 'iPhone で足した文 2', en: 'Added on the phone two.', note: '' },
    { ja: 'iPhone で足した文 3', en: 'Added on the phone three.', note: '' }
  ]);
  window.SUNKAN_PHRASE.addPhrases([
    { ja: 'iPhone の場面 1', en: 'Phone scene one.', scene: '電話', note: '' },
    { ja: 'iPhone の場面 2', en: 'Phone scene two.', scene: '電話', note: '' },
    { ja: 'iPhone の場面 3', en: 'Phone scene three.', scene: '食事', note: '' }
  ]);
  localStorage.setItem('sunkan:listen:decks', JSON.stringify([{ id: 'pl-ip', name: 'iPhone のプレイリスト', created: 2 }]));
});
await B.page.reload({ waitUntil: 'domcontentloaded' });
await B.page.waitForSelector('.row');
await B.page.evaluate(() => window.SUNKAN_LISTEN.addItems([
  { en: 'Phone listening one.', ja: 'iPhone のリスニング 1', note: '', deck: 'pl-ip' },
  { en: 'Phone listening two.', ja: 'iPhone のリスニング 2', note: '', deck: 'pl-ip' },
  { en: 'Phone listening three.', ja: 'iPhone のリスニング 3', note: '', deck: '' }
]));
await B.page.waitForTimeout(200);

const bBefore = await snap(B);
ok('B に 3 種類とも入った（3 件ずつ）',
   bBefore.added.length === 3 && bBefore.phrase.length === 3 && bBefore.listen.length === 3,
   JSON.stringify([bBefore.added.length, bBefore.phrase.length, bBefore.listen.length]));

const msgB1 = await syncWith(B, WORKER, ROOM2);
ok('B も（別の部屋で）同期できる', /同期しました/.test(msgB1), msgB1.split('\n')[0]);

/* ============================================================
 * 3. 症状の確認：両方「同期しました」なのに、互いのぶんが届いていない
 *    ここが「繋がっているつもりで一生揃わない」の正体。
 *    この 3 つが落ちるなら、症状の作り方そのものが間違っている（下の見張りも意味を失う）
 * ========================================================== */

const b1 = await snap(B);
ok('別の部屋だと A の足した文が B に届かない',
   b1.added.join('|') === bBefore.added.join('|'), b1.added.join('|'));
ok('別の部屋だと A の場面が B に届かない',
   b1.phrase.join('|') === bBefore.phrase.join('|'), b1.phrase.join('|'));
ok('別の部屋だと A のリスニングが B に届かない',
   b1.listen.join('|') === bBefore.listen.join('|'), b1.listen.join('|'));

/* ============================================================
 * 4. B の合言葉を R1 に書き換えて同期する（＝利用者がこれからやること）
 *    ここで消えたら「消えません」という説明が嘘になる
 * ========================================================== */

const msgB2 = await syncWith(B, WORKER, ROOM1);
ok('B が部屋を R1 に移して同期できる', /同期しました/.test(msgB2), msgB2.split('\n')[0]);

const b2 = await snap(B);

// ★ ここが本題。B が元から持っていたものが 1 件も減っていないこと
const kept = k => bBefore[k].every(v => b2[k].indexOf(v) >= 0);
ok('★ 部屋を移しても B の足した文が 1 件も消えない',
   kept('added') && b2.added.length >= 3, 'before=' + bBefore.added.join('|') + '  after=' + b2.added.join('|'));
ok('★ 部屋を移しても B の場面が 1 件も消えない',
   kept('phrase') && b2.phrase.length >= 3, 'before=' + bBefore.phrase.join('|') + '  after=' + b2.phrase.join('|'));
ok('★ 部屋を移しても B のリスニングが 1 件も消えない',
   kept('listen') && b2.listen.length >= 3, 'before=' + bBefore.listen.join('|') + '  after=' + b2.listen.join('|'));
ok('B の自作セットも残る（足した文のぶら下がり先）',
   b2.decks.indexOf('iPhone のセット') >= 0, b2.decks.join('|'));
ok('B のプレイリストも残る',
   b2.listenDecks.indexOf('iPhone のプレイリスト') >= 0, b2.listenDecks.join('|'));

// そして A のぶんが足し算で届いていること
ok('部屋を移すと A の足した文が B に届く', b2.added.length === 5, b2.added.join('|'));
ok('部屋を移すと A の場面が B に届く', b2.phrase.length === 5, b2.phrase.join('|'));
ok('部屋を移すと A のリスニングが B に届く', b2.listen.length === 5, b2.listen.join('|'));
ok('A の自作セットとプレイリストも届く',
   b2.decks.indexOf('Mac のセット') >= 0 && b2.listenDecks.indexOf('Mac のプレイリスト') >= 0,
   b2.decks.join('|') + '  /  ' + b2.listenDecks.join('|'));
// 足した文は「どのセットの下か」まで保たれていないと、画面のどこにも出てこない
const where = await B.page.evaluate(() => {
  const added = JSON.parse(localStorage.getItem('sunkan:added') || '{}');
  const decks = JSON.parse(localStorage.getItem('sunkan:decks') || '[]');
  const name = {};
  decks.forEach(d => { name[d.id] = d.name; });
  const out = {};
  Object.keys(added).forEach(id => { out[name[id] || id] = added[id].length; });
  return out;
});
ok('足した文が、それぞれ元のセットの下に入っている',
   where['Mac のセット'] === 2 && where['iPhone のセット'] === 3, JSON.stringify(where));

/* ============================================================
 * 5. そのあと A が同期すると、A にも B のぶんが届き、2 台の中身が一致する
 * ========================================================== */

const msgA2 = await syncWith(A, null, null);
ok('A の 2 回目の同期', /同期しました/.test(msgA2), msgA2.split('\n')[0]);

const a2 = await snap(A);
ok('A に B のぶんが届く（足した文 5）', a2.added.length === 5, a2.added.join('|'));
ok('A に B のぶんが届く（場面 5）', a2.phrase.length === 5, a2.phrase.join('|'));
ok('A に B のぶんが届く（リスニング 5）', a2.listen.length === 5, a2.listen.join('|'));
ok('2 台の中身が一致する（3 種類とも）', sameAs(a2, b2),
   JSON.stringify({ A: [a2.added.length, a2.phrase.length, a2.listen.length],
                    B: [b2.added.length, b2.phrase.length, b2.listen.length] }));

/* ============================================================
 * 6. 消した記録は部屋を移ったあとも効く
 *
 *    足し算だけだと「消したものが相手から戻ってくる」。消したのに戻るのは、
 *    件数が増えるぶん「消えない」より困る（何度消しても生き返る）。
 *    ここだけは**消えるのが正しい**ので、消えることを見張る。
 *    題材は B で作った場面にする（部屋を移って A に届いたものを、A で消す）。
 * ========================================================== */

const killed = await A.page.evaluate(() => {
  const items = JSON.parse(localStorage.getItem('sunkan:phrase:items') || '[]');
  const gone = items.find(x => x.ja === 'iPhone の場面 3');
  if (!gone) return '';
  window.SUNKAN_SYNC.recordDelete('phraseitem:' + gone.id);
  localStorage.setItem('sunkan:phrase:items', JSON.stringify(items.filter(x => x !== gone)));
  return gone.ja;
});
ok('A で B 由来の場面を 1 件消せた', killed === 'iPhone の場面 3', killed);
await A.page.reload({ waitUntil: 'domcontentloaded' });
await A.page.waitForSelector('.row');

ok('消したあとの A の同期', /同期しました/.test(await syncWith(A, null, null)));
ok('消したあとの B の同期', /同期しました/.test(await syncWith(B, null, null)));

const a3 = await snap(A), b3 = await snap(B);
ok('A で消した 1 件は、部屋を移った B からも消える',
   b3.phrase.length === 4 && b3.phrase.indexOf('iPhone の場面 3') < 0, b3.phrase.join('|'));
ok('消したものが A に戻ってこない',
   a3.phrase.length === 4 && a3.phrase.indexOf('iPhone の場面 3') < 0, a3.phrase.join('|'));
ok('消したあとも 2 台の中身が一致する', sameAs(a3, b3),
   JSON.stringify({ A: [a3.added.length, a3.phrase.length, a3.listen.length],
                    B: [b3.added.length, b3.phrase.length, b3.listen.length] }));
// 消えたのは名指しの 1 件だけ。ついでに他のものまで落ちていないこと
ok('消したのは 1 件だけ（足した文とリスニングは減らない）',
   b3.added.length === 5 && b3.listen.length === 5,
   JSON.stringify([b3.added.length, b3.listen.length]));

/* ============================================================
 * 7. ついで：合言葉を丸ごと画面に出していないか
 *    部屋を取り替える話は人に画面を見せながらやることがある。
 *    照合用の末尾 4 文字は出してよいが、丸ごとは出さない。
 * ========================================================== */

await B.page.click('#btn-settings');
await B.page.waitForTimeout(250);
await B.page.click('#btn-sync-open');
await B.page.waitForTimeout(300);
const stateText = await B.page.$eval('#sync-status', e => e.textContent);
ok('状態の文に合言葉を丸ごと出さない', stateText.indexOf(ROOM1) < 0, stateText.slice(0, 120));
ok('間違えていた側の合言葉も残して見せない', stateText.indexOf(ROOM2) < 0, stateText.slice(0, 120));

ok('JS のエラーが出ていない', A.errs.length === 0 && B.errs.length === 0,
   A.errs.concat(B.errs).join(' / '));

await A.ctx.close(); await B.ctx.close();
await browser.close();
console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
process.exit(fail ? 1 : 0);
