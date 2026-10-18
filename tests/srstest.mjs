/* 復習の予定（忘却曲線）が、印を選ぶだけで動くか。
 *
 * 使い方:
 *   python3 -m http.server 8599 --bind 127.0.0.1 &
 *   node tests/srstest.mjs
 *
 * **iPhone 幅 390 と Mac 幅 1180 の両方**で通します。狭い幅でしか出ない不具合が
 * 何度もあったためで、片方だけ通っても確かめたことになりません。
 *
 * PLAYWRIGHT … 入っている場所が環境で変わるので、環境変数で差し替えられるように
 * してあります（既定はこのコンテナの場所）。
 */
const PLAYWRIGHT = process.env.PLAYWRIGHT_PKG || '/opt/node-tools/node_modules/playwright/index.mjs';
const { chromium } = await import(PLAYWRIGHT);

const PORT = process.env.PORT || '8599';
const BASE = `http://127.0.0.1:${PORT}/`;
const EXEC = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  → ' + extra : ''}`); }
};

const browser = await chromium.launch({ executablePath: EXEC });

for (const [label, width, height] of [['iPhone 390', 390, 844], ['Mac 1180', 1180, 800]]) {
  console.log(`\n=== ${label} ===`);
  // Service Worker が route を横取りするので毎回まっさらなコンテキストで
  const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.row', { timeout: 10000 });

  ok('JS のエラーが出ていない', errors.length === 0, errors.join(' / '));

  // --- 絞り込みに「今日やるぶん」がある ---
  const opts = await page.$$eval('#level-filter option', els =>
    els.map(e => ({ v: e.value, t: e.textContent.trim() })));
  const due = opts.find(o => o.v === 'due');
  ok('絞り込みに「今日やるぶん」がある', !!due, JSON.stringify(opts.map(o => o.v)));
  ok('「今日やるぶん」に件数が付いている', !!due && /今日 \d+/.test(due.t), due && due.t);

  const total = await page.$$eval('.row', els => els.length);
  // まだ一度も採点していない文は「やる番」。最初は全部が対象
  ok('はじめは全部が「今日やるぶん」', !!due && due.t.endsWith(' ' + total), `${due && due.t} / 全 ${total}`);

  // --- 100% を選ぶと予定が先に延びる ---
  const firstId = await page.$eval('.row', el => el.getAttribute('data-id'));
  await page.selectOption('.row:nth-child(1) .row-level', '100');
  await page.waitForTimeout(150);

  const saved = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('sunkan:drill:srs') || '{}'); }
    catch (e) { return null; }
  });
  const flat = saved ? Object.values(saved)[0] || {} : {};
  const rec = flat[firstId];
  ok('sunkan:drill:srs に記録が入った', !!rec, JSON.stringify(saved));
  ok('100% は「かんたん」として日をまたぐ予定になる',
    !!rec && rec.state === 'review' && rec.due > Date.now() + 23 * 3600 * 1000,
    rec && `state=${rec.state} due=${rec.due && new Date(rec.due).toISOString()}`);
  ok('答えた回数が 1 になっている', !!rec && rec.reps === 1, rec && `reps=${rec.reps}`);

  const flash1 = await page.$eval('#status-bar', el => el.textContent.trim());
  ok('「次は …」と知らせが出る', /次は .+。/.test(flash1), flash1);
  ok('知らせに 100% が入っている', /100%/.test(flash1), flash1);

  // --- 「今日やるぶん」から外れる ---
  const dueAfter = await page.$$eval('#level-filter option',
    els => (els.find(e => e.value === 'due') || {}).textContent.trim());
  ok('100% にした文は「今日やるぶん」から外れた',
    dueAfter === `今日 ${total - 1}`, `${dueAfter} / 全 ${total}`);

  // --- 絞り込むと、その文だけ表に出ない ---
  await page.selectOption('#level-filter', 'due');
  await page.waitForTimeout(150);
  const shown = await page.$$eval('.row', els => els.filter(e => !e.hidden).length);
  ok('「今日やるぶん」で絞ると 1 件減る', shown === total - 1, `${shown} / ${total - 1}`);
  const stillThere = await page.evaluate(id => {
    const li = Array.from(document.querySelectorAll('.row'))
      .find(e => e.getAttribute('data-id') === id);
    return li ? li.hidden : null;
  }, firstId);
  ok('外れた文は hidden になっている', stillThere === true, String(stillThere));

  // --- 100% から「まだ」へ下げると、今日のうちに戻る ---
  await page.selectOption('#level-filter', 'all');
  await page.waitForTimeout(100);
  const readSrs = id => page.evaluate(i => {
    const all = JSON.parse(localStorage.getItem('sunkan:drill:srs') || '{}');
    return (Object.values(all)[0] || {})[i] || null;
  }, id);

  await page.selectOption('.row:nth-child(1) .row-level', '0');
  await page.waitForTimeout(150);
  const rec2 = await readSrs(firstId);
  ok('100% から「まだ」へ下げると記録が動く', !!rec2 && rec2.reps === 2,
    rec2 && `reps=${rec2.reps}`);
  ok('「まだ」は今日のうちにまた出る予定',
    !!rec2 && rec2.due < Date.now() + 24 * 3600 * 1000,
    rec2 && new Date(rec2.due).toISOString());
  ok('忘れた回数が 1 になっている', !!rec2 && rec2.lapses === 1, rec2 && `lapses=${rec2.lapses}`);
  const flash2 = await page.$eval('#status-bar', el => el.textContent.trim());
  ok('「まだ にしました」と出る', /まだ にしました/.test(flash2), flash2);
  ok('「まだ」の知らせも「次は」を言う', /次は .+。/.test(flash2), flash2);

  // --- ↻「もう一度」が「言えなかった」の記録になる ---
  // 段階の欄は既定が「まだ」なので、まだ の行では「まだ」を選べない。
  // 言えなかったことを残せる操作はここだけ。
  const thirdId = await page.$eval('.row:nth-child(3)', el => el.getAttribute('data-id'));
  ok('↻ の前は記録が無い', (await readSrs(thirdId)) === null);
  await page.click('.row:nth-child(3) .row-star');
  await page.waitForTimeout(150);
  const rec3 = await readSrs(thirdId);
  ok('↻ を付けると記録が入る', !!rec3, JSON.stringify(rec3));
  ok('↻ は「もう一度」として今日のうちに出る',
    !!rec3 && rec3.due < Date.now() + 24 * 3600 * 1000,
    rec3 && new Date(rec3.due).toISOString());
  ok('↻ では知らせを出さない（答えはいつも今日なので言うことが無い）',
    (await page.$eval('#status-bar', el => el.textContent.trim())) === flash2);
  // 外すときは採点しない（印を消すだけ）
  await page.click('.row:nth-child(3) .row-star');
  await page.waitForTimeout(150);
  const rec3b = await readSrs(thirdId);
  ok('↻ を外しても採点は増えない', !!rec3b && rec3b.reps === 1, rec3b && `reps=${rec3b.reps}`);

  // --- 元からのデータを壊していない ---
  const levels = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('sunkan:levels') || '{}'); }
    catch (e) { return null; }
  });
  const lv = levels ? (Object.values(levels)[0] || {})[firstId] : null;
  ok('sunkan:levels も今までどおり書かれている（形は { v, at }）',
    !!lv && lv.v === 0 && typeof lv.at === 'number', JSON.stringify(levels).slice(0, 140));

  // --- 読み直しても予定が残る（保存できている） ---
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.row', { timeout: 10000 });
  const dueReload = await page.$$eval('#level-filter option',
    els => (els.find(e => e.value === 'due') || {}).textContent.trim());
  // 1 件目を「まだ」に戻し、3 件目は ↻ を付けて外した。
  // どちらも 10 分後の予定だが「今日のうち」なので、今日やるぶんに残る
  ok('「まだ」にした文は今日やるぶんに残る（10 分後に消えない）',
    dueReload === `今日 ${total}`, `${dueReload} / 全 ${total}`);
  const keptReps = await page.evaluate(id => {
    const all = JSON.parse(localStorage.getItem('sunkan:drill:srs') || '{}');
    return ((Object.values(all)[0] || {})[id] || {}).reps;
  }, firstId);
  ok('読み直しても答えた回数が残っている', keptReps === 2, String(keptReps));

  // --- 英文がボタンの下に隠れていないか（広い画面）---
  // ボタンを足すたびに `--tools-space` を測り直さないと、英文が潜って読めなくなる。
  // % と △ を足したとき実際に 125px ぶん隠れたので、ここで止める。
  await page.click('#btn-toggle-all');        // ぜんぶ開く
  await page.waitForTimeout(350);
  const hidden = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.row').forEach((li, i) => {
      if (li.hidden) return;
      const en = li.querySelector('.en-text'), t = li.querySelector('.row-tools');
      if (!en || !t) return;
      const a = en.getBoundingClientRect(), b = t.getBoundingClientRect();
      if (!a.width) return;
      // **左右と上下の両方**が重なって初めて「隠れている」。
      // 狭い画面では開いた行のボタンが 2 段目へ下りるので、
      // 左右だけ見ると下の段と重なって見えて誤判定する。
      var x = a.right > b.left + 1 && a.left < b.right - 1;
      var y = a.bottom > b.top + 1 && a.top < b.bottom - 1;
      if (x && y) out.push(i + 1);
    });
    return out;
  });
  ok('英文がボタンの下に隠れていない', hidden.length === 0, '隠れている行: ' + hidden.slice(0, 8).join(','));
  await page.click('#btn-toggle-all');        // 元に戻す
  await page.waitForTimeout(300);

  // --- build 50 を壊していないか（隠したままでも ↻ と % が押せる）---
  const vis = await page.evaluate(() => {
    const li = document.querySelector('.row');
    const seen = sel => {
      const el = li.querySelector(sel);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    return { revealed: li.classList.contains('is-revealed'), star: seen('.row-star'), level: seen('.row-level') };
  });
  ok('閉じている行でも ↻ が出ている', vis.revealed === false && vis.star === true, JSON.stringify(vis));
  ok('閉じている行でも % が出ている', vis.level === true, JSON.stringify(vis));

  // --- 同期の道（バックアップ＝snapshot→clean→merge→apply）に乗っているか ---
  const backup = await page.evaluate(() => window.SUNKAN_SYNC.backupText());
  const parsed = JSON.parse(backup);
  ok('送り出す中身に drillSrs が入っている',
    !!parsed.drillSrs && !!Object.keys(parsed.drillSrs).length, Object.keys(parsed).join(','));
  const beforeReps = await page.evaluate(id => {
    const all = JSON.parse(localStorage.getItem('sunkan:drill:srs') || '{}');
    return ((Object.values(all)[0] || {})[id] || {}).reps;
  }, firstId);

  // まるごと消してから取り込み直す → 戻ってくるか
  const restored = await page.evaluate(text => {
    localStorage.removeItem('sunkan:drill:srs');
    const r = window.SUNKAN_SYNC.takeBackupText(text);
    const all = JSON.parse(localStorage.getItem('sunkan:drill:srs') || '{}');
    return { ok: r.ok, all: all };
  }, backup);
  ok('取り込みで予定が戻る', restored.ok === true &&
    !!Object.keys(restored.all).length, JSON.stringify(restored).slice(0, 160));
  const repsBack = (Object.values(restored.all)[0] || {})[firstId];
  ok('戻した予定の答えた回数が元と同じ',
    !!repsBack && repsBack.reps === beforeReps, `${repsBack && repsBack.reps} / ${beforeReps}`);

  // 古い記録を取り込んでも、手元の新しい記録を上書きしない（last が新しいほうを残す）
  const notClobbered = await page.evaluate(({ text, id }) => {
    const data = JSON.parse(text);
    const deckId = Object.keys(data.drillSrs)[0];
    // 相手側の記録を「1 年前・答えた回数 99」に作り替える
    data.drillSrs[deckId][id] = Object.assign({}, data.drillSrs[deckId][id], {
      last: Date.now() - 365 * 86400000, reps: 99
    });
    window.SUNKAN_SYNC.takeBackupText(JSON.stringify(data));
    const all = JSON.parse(localStorage.getItem('sunkan:drill:srs') || '{}');
    return ((Object.values(all)[0] || {})[id] || {}).reps;
  }, { text: backup, id: firstId });
  ok('古い記録は手元の新しい記録を上書きしない',
    notClobbered === beforeReps, `${notClobbered} / ${beforeReps}`);

  // 相手が drillSrs を知らない古い版でも、手元のぶんを落とさない
  const survivesOldPeer = await page.evaluate(({ text, id }) => {
    const data = JSON.parse(text);
    delete data.drillSrs;                     // 古い版が送ってきた形
    window.SUNKAN_SYNC.takeBackupText(JSON.stringify(data));
    const all = JSON.parse(localStorage.getItem('sunkan:drill:srs') || '{}');
    return ((Object.values(all)[0] || {})[id] || {}).reps;
  }, { text: backup, id: firstId });
  ok('drillSrs を知らない古い版と同期しても予定が消えない',
    survivesOldPeer === beforeReps, `${survivesOldPeer} / ${beforeReps}`);

  await ctx.close();
}

await browser.close();
console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
process.exit(fail ? 1 : 0);
