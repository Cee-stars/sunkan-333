/* リスニングが 2 台で揃うか（文・プレイリスト・足す・消す）。
 *
 * 使い方:
 *   python3 -m http.server 8599 --bind 127.0.0.1 &
 *   node tests/fake-worker.mjs 8600 &
 *   node tests/listensynctest.mjs
 *
 * synctest は場面（phrase）の往復を見ているが、**リスニングの往復を見るものが
 * 無かった**。「iPhone とパソコンでリスニングだけ中身が違う」と言われたときに、
 * アプリ側か端末側かを切り分けられるようにするためのもの。
 * 置き場は `cloudflare/worker.mjs` をそのまま動かしている（tests/fake-worker.mjs）。
 */
const { chromium } = await import('/opt/node-tools/node_modules/playwright/index.mjs');
const W = 'http://127.0.0.1:8600';
// 置き場は走らせるたびに別の部屋にする。同じ部屋を使い回すと、
// 前の回の文が残っていて件数が合わなくなる（実際に 53 → 106 になった）
const ROOM = 'listensync-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let bad = 0;
let pass = 0;
const ok = (n, c, e='') => { c ? (pass++, console.log('  PASS  ' + n)) : (bad++, console.log('  FAIL  ' + n + (e ? '  → ' + e : ''))); };

async function dev(w) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 }, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto('http://127.0.0.1:8599/', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.row');
  await p.evaluate(a => { localStorage.setItem('sunkan:sync:cfUrl', a.w); localStorage.setItem('sunkan:sync:cfRoom', a.r); }, { w: W, r: ROOM });
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.row');
  return { ctx, p, errs };
}
const sync = async d => {
  await d.p.click('#btn-settings'); await d.p.waitForTimeout(200);
  await d.p.click('#btn-sync-open'); await d.p.waitForTimeout(300);
  await d.p.click('#btn-sync-now');
  for (let i = 0; i < 60; i++) {
    const t = await d.p.$eval('#sync-status', e => e.textContent.trim());
    if (t && !/同期しています/.test(t)) break;
    await d.p.waitForTimeout(150);
  }
  const t = await d.p.$eval('#sync-status', e => e.textContent.trim());
  await d.p.click('#btn-sync-close').catch(()=>{});
  await d.p.waitForTimeout(250);
  return t.split('\n')[0];
};
const state = d => d.p.evaluate(() => {
  const items = JSON.parse(localStorage.getItem('sunkan:listen:items') || '[]');
  const decks = JSON.parse(localStorage.getItem('sunkan:listen:decks') || '[]');
  return {
    n: items.length,
    decks: decks.map(x => x.name),
    deckOf: items.reduce((m, x) => { const k = x.deck || '(未分類)'; m[k] = (m[k]||0)+1; return m; }, {}),
    ens: items.map(x => x.en).sort()
  };
});

const A = await dev(1180), B = await dev(390);

// A（パソコンのつもり）に 53 件ぶんを入れる
await A.p.evaluate(() => {
  localStorage.setItem('sunkan:listen:decks', JSON.stringify([{ id: 'pl-e', name: 'Elliot choy', created: 1 }]));
});
await A.p.reload({ waitUntil: 'domcontentloaded' });
await A.p.waitForSelector('.row');
await A.p.evaluate(() => {
  const list = [];
  for (let i = 1; i <= 53; i++) list.push({ en: 'Sentence number ' + i + ' / goes here', ja: '文 ' + i + ' / です', note: 'Block', deck: 'pl-e' });
  window.SUNKAN_LISTEN.addItems(list);
});
console.log('A 最初:', JSON.stringify(await state(A)).slice(0, 120));
console.log('A 同期:', await sync(A));
console.log('B 同期:', await sync(B));
const sb = await state(B);
ok('B に 53 件とも届く', sb.n === 53, 'B=' + sb.n);
ok('B にプレイリストが届く', sb.decks.join() === 'Elliot choy', sb.decks.join());
ok('B でも同じプレイリストに入っている', (sb.deckOf['pl-e'] || 0) === 53, JSON.stringify(sb.deckOf));

// B で 2 件足して、A へ戻るか
await B.p.evaluate(() => window.SUNKAN_LISTEN.addItems([
  { en: 'Added on the phone / one', ja: '電話で足した / 1', note: '', deck: 'pl-e' },
  { en: 'Added on the phone / two', ja: '電話で足した / 2', note: '', deck: '' }
]));
console.log('B 同期2:', await sync(B));
console.log('A 同期2:', await sync(A));
const sa = await state(A);
ok('A に B のぶんが戻る（55 件）', sa.n === 55, 'A=' + sa.n);
const sb2 = await state(B);
ok('2台の中身が一致する', sa.ens.join('|') === sb2.ens.join('|'),
   'A=' + sa.n + ' B=' + sb2.n);

// A で 1 件消したら、B からも消えるか
await A.p.evaluate(() => {
  const items = JSON.parse(localStorage.getItem('sunkan:listen:items') || '[]');
  const gone = items.find(x => /number 1 /.test(x.en));
  if (gone && window.SUNKAN_SYNC) window.SUNKAN_SYNC.recordDelete('listenitem:' + gone.id);
  localStorage.setItem('sunkan:listen:items', JSON.stringify(items.filter(x => x !== gone)));
});
await A.p.reload({ waitUntil: 'domcontentloaded' }); await A.p.waitForSelector('.row');
console.log('A 同期3:', await sync(A));
console.log('B 同期3:', await sync(B));
const sb3 = await state(B);
ok('消した 1 件が B からも消える', sb3.n === 54, 'B=' + sb3.n);
ok('消したものが A に戻らない', (await state(A)).n === 54, 'A=' + (await state(A)).n);
ok('JS のエラーが出ていない', A.errs.length === 0 && B.errs.length === 0,
   A.errs.concat(B.errs).join(' / '));

await b.close();
console.log(`\n==== ${pass} PASS / ${bad} FAIL ====`);
process.exit(bad ? 1 : 0);
