/* フレーズモード：自分で足す／ファイルから読み込む／同期に乗る。
 *
 * 使い方:
 *   python3 -m http.server 8599 --bind 127.0.0.1 &
 *   node tests/phrasetest.mjs
 *
 * **iPhone 幅 390 と Mac 幅 1180 の両方**で通します。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const PLAYWRIGHT = process.env.PLAYWRIGHT_PKG || '/opt/node-tools/node_modules/playwright/index.mjs';
const { chromium } = await import(PLAYWRIGHT);
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'phrasetest-')) + path.sep;
fs.writeFileSync(D+'ph-block.txt', `JA: ちょっと待って\nEN: Hold on a second.\n場面: 電話\n---\nJA: お会計をお願いします\nEN: Could I get the check?\n場面: 食事\n---\nJA: それ、いいですね\nEN: That sounds good.\n`);
fs.writeFileSync(D+'ph-table.tsv', `日本語\t英語\t場面\tメモ\nまた連絡します\tI'll get back to you.\t仕事\t\n少し考えさせてください\tLet me think about it.\t仕事\t丁寧\n`);
let pass=0, fail=0;
const ok=(n,c,e='')=>{ c?(pass++,console.log('  PASS  '+n)):(fail++,console.log('  FAIL  '+n+(e?'  → '+e:''))); };
const b = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
for (const [label,w,h] of [['iPhone 390',390,844],['Mac 1180',1180,800]]) {
  console.log(`\n=== ${label} ===`);
  const ctx = await b.newContext({ viewport:{width:w,height:h}, serviceWorkers:'block' });
  const p = await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
  await p.goto(`http://127.0.0.1:${process.env.PORT||'8599'}/`,{waitUntil:'domcontentloaded'});
  await p.waitForTimeout(300);
  await p.click('#tab-phrase'); await p.waitForTimeout(300);
  await p.click('#btn-phrase-import'); await p.waitForTimeout(300);
  ok('取り込みのダイアログが開く', await p.$eval('#phrase-import-dialog',e=>e.open));

  // 見出し付きのファイル
  await p.setInputFiles('#phrase-file', D+'ph-block.txt'); await p.waitForTimeout(500);
  const pv = await p.$eval('#phrase-import-preview',e=>e.textContent.trim());
  ok('ファイルを読んで件数を先に出す', /3 件ぶん読めました/.test(pv), pv);
  ok('場面つきの数も出す', /場面つき 2 件/.test(pv), pv);
  // 場面の無いぶんにまとめて付ける
  await p.fill('#phrase-import-scene','ぜんぶ'); await p.waitForTimeout(300);
  ok('残りの入れ先を言う', /「ぜんぶ」に入れます/.test(await p.$eval('#phrase-import-preview',e=>e.textContent)), '');
  await p.click('#btn-phrase-import-save'); await p.waitForTimeout(600);
  ok('読み込むと閉じる', await p.$eval('#phrase-import-dialog',e=>e.open)===false);
  const items = await p.evaluate(()=>JSON.parse(localStorage.getItem('sunkan:phrase:items')||'[]'));
  ok('3 件入った', items.length===3, JSON.stringify(items.map(x=>x.ja)));
  ok('場面が入っている', items[0].scene==='電話'&&items[1].scene==='食事', JSON.stringify(items.map(x=>x.scene)));
  ok('場面の無いぶんに「ぜんぶ」が付いた', items[2].scene==='ぜんぶ', items[2].scene);
  ok('日本語と英語が入れ替わっていない', items[0].ja==='ちょっと待って'&&items[0].en==='Hold on a second.', JSON.stringify(items[0]));

  // 表（日本語が先）
  await p.click('#btn-phrase-import'); await p.waitForTimeout(300);
  await p.setInputFiles('#phrase-file', D+'ph-table.tsv'); await p.waitForTimeout(500);
  ok('表も読める', /2 件ぶん読めました/.test(await p.$eval('#phrase-import-preview',e=>e.textContent)), await p.$eval('#phrase-import-preview',e=>e.textContent.trim()));
  await p.click('#btn-phrase-import-save'); await p.waitForTimeout(600);
  const all = await p.evaluate(()=>JSON.parse(localStorage.getItem('sunkan:phrase:items')||'[]'));
  ok('表のぶんも入って 5 件', all.length===5, String(all.length));
  const t = all.find(x=>x.ja==='また連絡します');
  ok('表でも日本語が先として読めている', !!t && t.en==="I'll get back to you." && t.scene==='仕事', JSON.stringify(t));

  // 同じものは飛ばす
  await p.click('#btn-phrase-import'); await p.waitForTimeout(300);
  await p.setInputFiles('#phrase-file', D+'ph-table.tsv'); await p.waitForTimeout(500);
  await p.click('#btn-phrase-import-save'); await p.waitForTimeout(600);
  const again = await p.evaluate(()=>JSON.parse(localStorage.getItem('sunkan:phrase:items')||'[]'));
  ok('同じものは二重に入らない', again.length===5, String(again.length));

  ok('場面の絞り込みに出る', (await p.$$eval('#phrase-scene option',e=>e.map(x=>x.textContent))).length>=4,
     (await p.$$eval('#phrase-scene option',e=>e.map(x=>x.textContent.trim()))).join(' | '));
  ok('一覧に 5 行出る', (await p.$$eval('#phrase-rows .row',e=>e.length))===5, '');
  // --- ↻ と % が忘却曲線に乗るか ---
  await p.click('#phrase-rows .row:nth-child(1) .row-star'); await p.waitForTimeout(250);
  const srs1 = await p.evaluate(()=>JSON.parse(localStorage.getItem('sunkan:phrase:srs')||'{}'));
  ok('↻ が「言えなかった」として記録される', Object.keys(srs1).length===1, JSON.stringify(srs1));
  await p.selectOption('#phrase-rows .row:nth-child(1) .row-level','100'); await p.waitForTimeout(300);
  ok('% を選ぶと「次は …」が出る',
     /次は .+。/.test(await p.$eval('#phrase-status',e=>e.textContent)),
     await p.$eval('#phrase-status',e=>e.textContent.trim()));

  // --- 同期の道（書き出し→取り込み）に乗っているか ---
  const backup = await p.evaluate(()=>window.SUNKAN_SYNC.backupText());
  const parsed = JSON.parse(backup);
  ok('送り出す中身に phrase が入っている',
     !!parsed.phrase && parsed.phrase.items.length===5, Object.keys(parsed).join(','));
  ok('phrase に段階と予定も入っている',
     !!parsed.phrase.levels && !!parsed.phrase.srs && !!parsed.phrase.stars, '');

  const restored = await p.evaluate(t=>{
    ['items','stars','levels','srs'].forEach(k=>localStorage.removeItem('sunkan:phrase:'+k));
    const r = window.SUNKAN_SYNC.takeBackupText(t);
    return { ok:r.ok,
      items: JSON.parse(localStorage.getItem('sunkan:phrase:items')||'[]').length,
      srs: Object.keys(JSON.parse(localStorage.getItem('sunkan:phrase:srs')||'{}')).length };
  }, backup);
  ok('取り込みでフレーズが戻る', restored.ok===true && restored.items===5 && restored.srs===1,
     JSON.stringify(restored));

  // phrase を知らない古い版と同期しても消えない
  const survives = await p.evaluate(t=>{
    const d = JSON.parse(t); delete d.phrase;
    window.SUNKAN_SYNC.takeBackupText(JSON.stringify(d));
    return JSON.parse(localStorage.getItem('sunkan:phrase:items')||'[]').length;
  }, backup);
  ok('phrase を知らない古い版と同期しても消えない', survives===5, String(survives));

  // --- 5 モードの行き来 ---
  for (const id of ['tab-drill','tab-para','tab-cards','tab-shadow','tab-phrase']) {
    await p.click('#'+id); await p.waitForTimeout(200);
  }
  ok('5 モードを行き来してもエラーが出ない', errs.length===0, errs.join(' / '));

  ok('エラーなし', errs.length===0, errs.join(' / '));
  if (w===390) await p.screenshot({ path: D+'phrase-imported.png' });
  await ctx.close();
}
await b.close();
console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
process.exit(fail?1:0);
