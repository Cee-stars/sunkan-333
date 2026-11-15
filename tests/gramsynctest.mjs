/* 文法予測が 2 台で揃うか（規則・例文・予定・記録・段・消す）。
 *
 * 使い方:
 *   python3 -m http.server 8599 --bind 127.0.0.1 &
 *   node tests/fake-worker.mjs 8600 &
 *   node tests/gramsynctest.mjs
 *
 * **ここは CONTRACT の「項目を足すときに必ず 4 か所そろえる」の見張り。**
 * 実際にカードは `clean()` への書き忘れで「書き出しには入っているのに
 * 読み込むと 0 枚」になった。同じことを文法予測で起こさないためのもの。
 *
 * とくに見ているのは次の 3 つ。
 *   ・予定（srs）の添字は**規則 id**なので、例文を消しても予定が消えない
 *   ・記録（log）は**両方の端末のぶんを混ぜる**。片方を捨てると段が巻き戻る
 *   ・同じ時刻の記録は 1 つだけ（2 台で二重に数えない）
 *
 * 置き場は `cloudflare/worker.mjs` をそのまま動かしている（tests/fake-worker.mjs）。
 * **部屋は走らせるたびに別にする**（使い回すと前の回のぶんが残って件数が合わない）。
 */
const { chromium } = await import('/opt/node-tools/node_modules/playwright/index.mjs');
const W = 'http://127.0.0.1:8600';
const ROOM = 'gramsync-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

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

const b = await chromium.launch(LAUNCH);
let bad = 0, pass = 0;
const ok = (n, c, e = '') => {
  c ? (pass++, console.log('  PASS  ' + n)) : (bad++, console.log('  FAIL  ' + n + (e ? '  → ' + e : '')));
};

async function dev(w) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 }, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto('http://127.0.0.1:8599/', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.row');
  await p.evaluate(a => {
    localStorage.setItem('sunkan:sync:cfUrl', a.w);
    localStorage.setItem('sunkan:sync:cfRoom', a.r);
  }, { w: W, r: ROOM });
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
  await d.p.click('#btn-sync-close').catch(() => {});
  await d.p.waitForTimeout(250);
  return t.split('\n')[0];
};

const state = d => d.p.evaluate(() => ({
  rules: JSON.parse(localStorage.getItem('sunkan:gram:rules') || '[]').map(x => x.id).sort(),
  items: JSON.parse(localStorage.getItem('sunkan:gram:items') || '[]').map(x => x.id).sort(),
  srs: JSON.parse(localStorage.getItem('sunkan:gram:srs') || '{}'),
  seen: JSON.parse(localStorage.getItem('sunkan:gram:seen') || '{}'),
  log: JSON.parse(localStorage.getItem('sunkan:gram:log') || '{}')
}));

const A = await dev(1180), B = await dev(390);

/* ---------------------------------------------------------------
 * 1. A で答える → B に渡る
 * ------------------------------------------------------------- */
await A.p.evaluate(() => {
  // 予定と記録を直に置く（画面を通さず、同期だけを見たいので）
  localStorage.setItem('sunkan:gram:srs', JSON.stringify({
    'gr-there': { s: 3, d: 5, due: Date.now() + 3 * 86400000, last: 1000, reps: 1, lapses: 0, streak: 1, step: 0, state: 'review' }
  }));
  localStorage.setItem('sunkan:gram:log', JSON.stringify({
    'gr-there': [{ at: 1000, g: 3, iv: 3 }]
  }));
  localStorage.setItem('sunkan:gram:seen', JSON.stringify({
    'gi-13': { at: 1000, g: 3, q: 1 }
  }));
});

console.log('A 同期1:', await sync(A));
const msgB1 = await sync(B);
console.log('B 同期1:', msgB1);
const b1 = await state(B);

/* **文法予測だけが届いた回に、ちゃんと「取り込みました」と言うか。**
 * 「何か届いたか」の旗の式が 3 か所に写してあり、gram を足したとき 1 か所
 * 書き落としていた。中身は入るので、言わないことに誰も気付けない。
 * いまは `anyHit()` 1 本にまとめてあるが、戻ったらここで落ちる。 */
ok('文法予測だけ届いた回も「取り込みました」と言う', /取り込みました/.test(msgB1), msgB1);

ok('規則が B に渡る（5 個）', b1.rules.length === 5, JSON.stringify(b1.rules));
ok('例文が B に渡る（38 文）', b1.items.length === 38, String(b1.items.length));
ok('予定（srs）が B に渡る', !!b1.srs['gr-there'], JSON.stringify(Object.keys(b1.srs)));
ok('予定の添字は**規則 id**', Object.keys(b1.srs).every(k => /^gr/.test(k)),
   JSON.stringify(Object.keys(b1.srs)));
ok('記録（log）が B に渡る', (b1.log['gr-there'] || []).length === 1,
   JSON.stringify(b1.log['gr-there']));
ok('「最後に出した」が B に渡る', !!b1.seen['gi-13'], JSON.stringify(Object.keys(b1.seen)));
ok('「これでもいい?」の旗も渡る', b1.seen['gi-13'] && b1.seen['gi-13'].q === 1,
   JSON.stringify(b1.seen['gi-13']));

/* ---------------------------------------------------------------
 * 2. 両方の端末で別々に答える → 記録が混ざる（片方が消えない）
 * ------------------------------------------------------------- */
await A.p.evaluate(() => {
  const log = JSON.parse(localStorage.getItem('sunkan:gram:log') || '{}');
  log['gr-there'] = (log['gr-there'] || []).concat([{ at: 2000, g: 4, iv: 9 }]);
  localStorage.setItem('sunkan:gram:log', JSON.stringify(log));
});
await B.p.evaluate(() => {
  const log = JSON.parse(localStorage.getItem('sunkan:gram:log') || '{}');
  log['gr-there'] = (log['gr-there'] || []).concat([{ at: 3000, g: 3, iv: 20 }]);
  localStorage.setItem('sunkan:gram:log', JSON.stringify(log));
});
console.log('A 同期2:', await sync(A));
console.log('B 同期2:', await sync(B));
console.log('A 同期3:', await sync(A));

const a2 = await state(A), b2 = await state(B);
const ats = (s) => (s.log['gr-there'] || []).map(e => e.at).sort((x, y) => x - y);

ok('両方の端末のぶんが混ざる（1000・2000・3000）',
   JSON.stringify(ats(a2)) === JSON.stringify([1000, 2000, 3000]), JSON.stringify(ats(a2)));
ok('2 台の記録が一致する', JSON.stringify(ats(a2)) === JSON.stringify(ats(b2)),
   JSON.stringify(ats(a2)) + ' / ' + JSON.stringify(ats(b2)));
ok('記録は古い順に並ぶ（段をこれから数えるので順が要る）',
   ats(a2).every((v, i, arr) => i === 0 || arr[i - 1] <= v), JSON.stringify(ats(a2)));

// 同じ時刻の記録は 1 つだけ（2 台で二重に数えない）
await B.p.evaluate(() => {
  const log = JSON.parse(localStorage.getItem('sunkan:gram:log') || '{}');
  log['gr-there'] = (log['gr-there'] || []).concat([{ at: 2000, g: 4, iv: 9 }]);
  localStorage.setItem('sunkan:gram:log', JSON.stringify(log));
});
console.log('B 同期4:', await sync(B));
const b3 = await state(B);
ok('同じ時刻の記録は二重にならない',
   JSON.stringify(ats(b3)) === JSON.stringify([1000, 2000, 3000]), JSON.stringify(ats(b3)));

/* ---------------------------------------------------------------
 * 3. 段（二択 → タイプ）が 2 台でそろう
 * ------------------------------------------------------------- */
const stageOf = d => d.p.evaluate(() => {
  const log = JSON.parse(localStorage.getItem('sunkan:gram:log') || '{}')['gr-there'] || [];
  let m = 'pick', run = 0;
  for (const e of log) {
    const ok2 = e.g >= 3;
    if (m === 'pick') { run = ok2 ? run + 1 : 0; if (run >= 3) { m = 'type'; run = 0; } }
    else { run = ok2 ? 0 : run + 1; if (run >= 2) { m = 'pick'; run = 0; } }
  }
  return m;
});
const sa = await stageOf(A), sb = await stageOf(B);
ok('3 回続けて出たので、段がタイプに上がっている', sa === 'type', sa);
ok('段が 2 台でそろう', sa === sb, sa + ' / ' + sb);

/* ---------------------------------------------------------------
 * 4. 消したものが戻ってこない
 * ------------------------------------------------------------- */
await A.p.evaluate(() => {
  const items = JSON.parse(localStorage.getItem('sunkan:gram:items') || '[]');
  const gone = items.filter(x => x.id !== 'gi-13');
  localStorage.setItem('sunkan:gram:items', JSON.stringify(gone));
  window.SUNKAN_SYNC.recordDelete('gramitem:gi-13');
});
console.log('A 同期5:', await sync(A));
console.log('B 同期5:', await sync(B));
const b4 = await state(B);
ok('消した例文が B からも消える', b4.items.indexOf('gi-13') < 0, String(b4.items.length));
ok('消した例文の記録も連れて戻らない', !b4.seen['gi-13'], JSON.stringify(Object.keys(b4.seen)));
ok('例文を 1 つ消しても、規則の予定は残る', !!b4.srs['gr-there'],
   JSON.stringify(Object.keys(b4.srs)));

console.log('A 同期6:', await sync(A));
const a4 = await state(A);
ok('消したものが A に戻らない', a4.items.indexOf('gi-13') < 0, String(a4.items.length));

/* ---------------------------------------------------------------
 * 5. 文法予測を知らない古い版と同期しても消えない
 * ------------------------------------------------------------- */
const survives = await A.p.evaluate(() => {
  const text = window.SUNKAN_SYNC.backupText({});
  const d = JSON.parse(text);
  delete d.gram;                       // 古い版のつもり
  window.SUNKAN_SYNC.takeBackupText(JSON.stringify(d));
  return {
    rules: JSON.parse(localStorage.getItem('sunkan:gram:rules') || '[]').length,
    items: JSON.parse(localStorage.getItem('sunkan:gram:items') || '[]').length
  };
});
ok('gram を知らない古い版と同期しても規則が消えない', survives.rules === 5, JSON.stringify(survives));
ok('gram を知らない古い版と同期しても例文が消えない', survives.items === 37, JSON.stringify(survives));

ok('A にエラーが出ていない', A.errs.length === 0, A.errs.join(' / '));
ok('B にエラーが出ていない', B.errs.length === 0, B.errs.join(' / '));

await A.ctx.close(); await B.ctx.close();
await b.close();
console.log(`\n==== ${pass} PASS / ${bad} FAIL ====`);
process.exit(bad ? 1 : 0);
