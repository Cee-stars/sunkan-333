/* 文法予測の確かめ。
 *
 * 使い方:
 *   python3 -m http.server 8599 --bind 127.0.0.1 &
 *   node tests/gramtest.mjs
 *
 * **390px と 1180px の両方**で走る。見ているのは次のこと。
 *   ・タブと画面が出て、収録の規則と例文が入る
 *   ・**はじめに出るのはゲート**（形と意味の結び）。待たされた規則は予定に出てこない
 *   ・ゲートは英文をまるごと見せ、**二択は日本語**（形で答えが出ないように）
 *   ・予測の段では**送信するまで続きを開示しない**（順序の決まり。ここが肝）
 *   ・二択のラベルに**英語の形が出ない**（出ると形の照合になってしまう）
 *   ・答え合わせで**自分の答えと模範が並んで出る**（片方が消えない）
 *   ・自己採点を押すと予定が進み、帯の「のこり」が減る。**分母は増えない**
 *   ・「これでもいい?」の旗は**予定（間隔）を動かさない**
 *   ・タイプの段は、二択のあとでも続きがぼけたまま
 *   ・読み直しても戻らない／収録が二重に入らない／はみ出さない
 */
import { chromium } from 'playwright';

const APP = 'http://127.0.0.1:8599/index.html';
let pass = 0, fail = 0;
const ok = (n, c, e = '') => {
  c ? (pass++, console.log('  PASS  ' + n))
    : (fail++, console.log('  FAIL  ' + n + (e ? '  → ' + e : '')));
};

const b = await chromium.launch();

for (const [label, width] of [['iPhone 390', 390], ['Mac 1180', 1180]]) {
  console.log('\n=== ' + label + ' ===');
  const ctx = await b.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await p.goto(APP, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.row');

  // --- タブと画面 ---
  ok('タブは 4 つ', await p.locator('.mode-tab').count() === 4,
     String(await p.locator('.mode-tab').allInnerTexts()));
  ok('「文法予測」のタブがある', (await p.innerText('#tab-gram')).trim() === '文法予測');

  await p.click('#tab-gram');
  await p.waitForSelector('#gram-stage', { state: 'visible' });
  ok('文法予測の画面が見える', await p.locator('#gram-view').isVisible());
  ok('ほかのモードの画面は見えない',
     !(await p.locator('#view-drill').isVisible()) &&
     !(await p.locator('#phrase-view').isVisible()) &&
     !(await p.locator('#listen-view').isVisible()));

  const seeded = await p.evaluate(() => ({
    rules: JSON.parse(localStorage.getItem('sunkan:gram:rules') || '[]').length,
    items: JSON.parse(localStorage.getItem('sunkan:gram:items') || '[]').length
  }));
  ok('収録の規則が入った（5 個）', seeded.rules === 5, JSON.stringify(seeded));
  ok('収録の例文が入った（38 文）', seeded.items === 38, JSON.stringify(seeded));

  /* ---------------------------------------------------------------
   * 1. はじめはゲート。待たされた規則は予定に出てこない
   * ------------------------------------------------------------- */
  const plan = await p.evaluate(() => {
    const ui = JSON.parse(localStorage.getItem('sunkan:gram:ui') || '{}');
    const rules = JSON.parse(localStorage.getItem('sunkan:gram:rules') || '[]');
    const ids = (ui.session && ui.session.ids) || [];
    return { ids: ids, gated: rules.filter(r => r.gate).map(r => r.id) };
  });
  ok('ゲートが予定に入っている', plan.ids.indexOf('gr-gate') >= 0, JSON.stringify(plan.ids));
  ok('ゲートは 1 枠だけ（待っている規則が 3 つあっても畳まれる）',
     plan.ids.filter(x => x === 'gr-gate').length === 1, JSON.stringify(plan.ids));
  ok('ゲート未通過のあいだ、待たされた規則は予定に出ない',
     plan.gated.filter(id => plan.ids.indexOf(id) >= 0).length === 0, JSON.stringify(plan));
  ok('いま出ているのはゲート', (await p.innerText('#gram-rule-name')).indexOf('形と意味') >= 0,
     await p.innerText('#gram-rule-name'));

  // ゲートは英文をまるごと見せ、二択は日本語で出す
  ok('ゲートは英文をまるごと見せる',
     await p.locator('#gram-sentence .gram-chunk.is-hidden').count() === 0);
  const gateLabels = [
    (await p.innerText('#btn-gram-pick-0')).trim(),
    (await p.innerText('#btn-gram-pick-1')).trim()
  ];
  ok('ゲートの二択は日本語（英語の形が出ない）',
     !/[A-Za-z]/.test(gateLabels.join('')), JSON.stringify(gateLabels));

  await p.click('#btn-gram-pick-0');
  await p.waitForTimeout(250);
  ok('ゲートでも答え合わせが出る', await p.locator('#gram-answer').isVisible());
  ok('答え合わせで日本語訳が出る', (await p.innerText('#gram-ja')).trim().length > 0);
  await p.click('#btn-gram-g3');
  await p.waitForTimeout(350);

  const passed = await p.evaluate(() => {
    const log = JSON.parse(localStorage.getItem('sunkan:gram:log') || '{}');
    return (log['gr-gate'] || []).filter(e => e.g >= 3).length > 0;
  });
  ok('ゲートを通った（記録に grade 3 以上が入った）', passed);

  /* ---------------------------------------------------------------
   * 2. 予測の段：送信するまで続きを開示しない
   * ------------------------------------------------------------- */
  await p.selectOption('#gram-rule-select', 'gr-there');
  await p.waitForTimeout(350);
  ok('規則を選ぶと、その規則が出る',
     (await p.innerText('#gram-rule-name')).indexOf('There') >= 0,
     await p.innerText('#gram-rule-name'));

  const shown = await p.locator('#gram-sentence .gram-chunk.is-shown').count();
  const hidden = await p.locator('#gram-sentence .gram-chunk.is-hidden').count();
  ok('出ているのは手がかりの 1 かたまりだけ', shown === 1, String(shown));
  ok('続きはぼけている', hidden >= 1, String(hidden));

  const blurred = await p.evaluate(() => {
    const el = document.querySelector('#gram-sentence .gram-chunk.is-hidden');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { filter: cs.filter, select: cs.userSelect || cs.webkitUserSelect };
  });
  ok('続きは blur がかかっている', !!blurred && /blur/.test(blurred.filter),
     JSON.stringify(blurred));
  ok('続きは選べない（長押しで盗み見られない）', !!blurred && blurred.select === 'none',
     JSON.stringify(blurred));
  ok('答え合わせの前は日本語訳を出さない（訳で答えが読めてしまう）',
     !(await p.locator('#gram-ja').isVisible()));
  ok('答え合わせはまだ出ていない', !(await p.locator('#gram-answer').isVisible()));
  ok('採点はまだ出ていない', !(await p.locator('#gram-grades').isVisible()));

  const labels = [
    (await p.innerText('#btn-gram-pick-0')).trim(),
    (await p.innerText('#btn-gram-pick-1')).trim()
  ];
  ok('二択のラベルは「1つ」「複数」（英語の形を出さない）',
     labels.join('/') === '1つ/複数', JSON.stringify(labels));

  // 読み上げは答え合わせの前はしない（音で続きが漏れる）
  if (await p.locator('#btn-gram-speak').isVisible()) {
    await p.click('#btn-gram-speak');
    await p.waitForTimeout(200);
    ok('答え合わせの前は読み上げない',
       (await p.innerText('#gram-status')).indexOf('答え合わせ') >= 0,
       await p.innerText('#gram-status'));
  } else {
    ok('読み上げが使えない端末では 🔈 を出さない', true);
  }

  const countBefore = (await p.innerText('#gram-count')).trim();
  const leftBefore = (await p.innerText('#gram-left')).trim();
  ok('帯が「0 / n」から始まる', /^0 \/ \d+$/.test(countBefore), countBefore);

  await p.click('#btn-gram-pick-1');
  await p.waitForTimeout(250);
  ok('答え合わせが出た', await p.locator('#gram-answer').isVisible());
  ok('続きが出た', await p.locator('#gram-sentence .gram-chunk.is-hidden').count() === 0);
  ok('自分の答えと模範が**同時に**出ている（片方が消えていない）',
     (await p.locator('#gram-mine').isVisible()) && (await p.locator('#gram-model').isVisible()) &&
     (await p.innerText('#gram-mine')).trim().length > 0 &&
     (await p.innerText('#gram-model')).trim().length > 0);
  ok('説明が出ている', (await p.innerText('#gram-why')).trim().length > 0);
  ok('採点のラベルは 4 つ',
     (await p.locator('#gram-grades .grade-label').allInnerTexts())
       .map(s => s.trim()).join('/') === 'ちがった/迷った/出た/すぐ出た',
     String(await p.locator('#gram-grades .grade-label').allInnerTexts()));
  ok('「次はいつ」が各ボタンに出ている', (await p.innerText('#gram-when-3')).trim().length > 0);

  // 旗は予定（間隔）を動かさない
  const srsBeforeFlag = await p.evaluate(() => localStorage.getItem('sunkan:gram:srs'));
  await p.click('#btn-gram-flag');
  await p.waitForTimeout(200);
  ok('旗が立った', await p.getAttribute('#btn-gram-flag', 'aria-pressed') === 'true');
  ok('旗は予定（間隔）を動かさない',
     await p.evaluate(() => localStorage.getItem('sunkan:gram:srs')) === srsBeforeFlag);

  await p.click('#btn-gram-g3');
  await p.waitForTimeout(350);

  const after = await p.evaluate(() => ({
    srs: JSON.parse(localStorage.getItem('sunkan:gram:srs') || '{}'),
    log: JSON.parse(localStorage.getItem('sunkan:gram:log') || '{}'),
    seen: JSON.parse(localStorage.getItem('sunkan:gram:seen') || '{}')
  }));
  ok('予定の添字は**規則 id**（例文 id ではない）',
     Object.keys(after.srs).every(k => k.indexOf('gr-') === 0 || k.indexOf('gr') === 0),
     JSON.stringify(Object.keys(after.srs)));
  ok('There の規則にも予定が付いた', !!after.srs['gr-there'], JSON.stringify(Object.keys(after.srs)));
  ok('記録（log）が付いた', (after.log['gr-there'] || []).length === 1, JSON.stringify(after.log['gr-there']));
  /* **採点しても旗は下りない。**
   * CONTRACT は「出した時点で下りる」と書いてある。旗と採点は**同時に出る**ので、
   * 採点のときに消すと「旗を付けてから採点する」というただ 1 つの道で必ず消え、
   * 旗が一度も効かない。ここは前、**採点した時点で下りる**ことを確かめていて、
   * 決まりと違うものを測っていた（不具合を追認していた）。 */
  const flaggedIds = Object.keys(after.seen).filter(k => after.seen[k].q === 1);
  ok('★ 採点しても旗は下りない（下りるのは次に出したとき）',
     flaggedIds.length === 1, JSON.stringify(after.seen));
  ok('採点そのものは記録されている',
     flaggedIds.length === 1 && after.seen[flaggedIds[0]].g >= 3, JSON.stringify(after.seen));

  const countAfter = (await p.innerText('#gram-count')).trim();
  ok('帯が 1 つ進んだ', countAfter.split('/')[0].trim() === '1', countBefore + ' → ' + countAfter);
  ok('帯の分母は増えていない',
     countAfter.split('/')[1].trim() === countBefore.split('/')[1].trim(),
     countBefore + ' → ' + countAfter);
  ok('「のこり」が減った', (await p.innerText('#gram-left')).trim() !== leftBefore,
     leftBefore + ' → ' + (await p.innerText('#gram-left')).trim());

  /* ---------------------------------------------------------------
   * 3. タイプの段：二択のあとも続きはぼけたまま
   * ------------------------------------------------------------- */
  await p.selectOption('#gram-rule-select', 'gr-3sg');
  await p.waitForTimeout(350);
  ok('タイプの規則が出た', (await p.innerText('#gram-stage-tag')).indexOf('タイプ') >= 0,
     await p.innerText('#gram-stage-tag'));
  await p.click('#btn-gram-pick-0');
  await p.waitForTimeout(250);
  ok('二択のあと、タイプの欄が出る', await p.locator('#gram-type').isVisible());
  ok('**二択のあとも続きはぼけたまま**（タイプする前に答えを見せない）',
     await p.locator('#gram-sentence .gram-chunk.is-hidden').count() >= 1,
     String(await p.locator('#gram-sentence .gram-chunk.is-hidden').count()));
  ok('タイプの前は答え合わせを出さない', !(await p.locator('#gram-answer').isVisible()));

  await p.fill('#gram-input', 'zzz');
  await p.click('#btn-gram-send');
  await p.waitForTimeout(250);
  ok('送ると続きが出る', await p.locator('#gram-sentence .gram-chunk.is-hidden').count() === 0);
  ok('外したときは自分の答えが残っている',
     (await p.innerText('#gram-mine')).trim() === 'zzz', await p.innerText('#gram-mine'));
  ok('外したことが分かる', await p.evaluate(() =>
    document.getElementById('gram-answer').classList.contains('is-wrong')));
  await p.click('#btn-gram-g1');
  await p.waitForTimeout(350);

  /* ---------------------------------------------------------------
   * 4. 読み直し・はみ出し
   * ------------------------------------------------------------- */
  const countKeep = (await p.innerText('#gram-count')).trim();
  await p.reload({ waitUntil: 'domcontentloaded' });
  // ここで出るのは「問題」か「今日の復習はありません。」のどちらか。
  // #gram-stage と #gram-empty の片方しか出ないので、両方見て待つ
  await p.waitForFunction(() => {
    const a = document.getElementById('gram-stage');
    const e = document.getElementById('gram-empty');
    return (a && !a.hidden) || (e && !e.hidden);
  });
  ok('読み直しても文法予測が開く',
     await p.evaluate(() => document.documentElement.getAttribute('data-mode')) === 'gram');
  ok('読み直しても帯が戻らない', (await p.innerText('#gram-count')).trim() === countKeep,
     countKeep + ' → ' + (await p.innerText('#gram-count')).trim());

  // この規則はもう答え終わっているので、予定は空。**おまけ問題は出さない**
  ok('やり終えたら「今日の復習はありません。」で終わる',
     (await p.innerText('#gram-empty')).indexOf('今日の復習はありません') >= 0,
     await p.innerText('#gram-empty'));
  ok('やり終えたら問題は出さない', await p.evaluate(() =>
    document.getElementById('gram-stage').hidden === true));
  ok('収録が二重に入らない', await p.evaluate(() =>
    JSON.parse(localStorage.getItem('sunkan:gram:items') || '[]').length) === 38);

  const over = await p.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok('横スクロールが出ない', over <= 1, String(over));

  /* ---------------------------------------------------------------
   * 5. 規則の一覧と、例文を足す
   * ------------------------------------------------------------- */
  await p.click('#btn-gram-rules');
  await p.waitForTimeout(250);
  ok('問題が無い状態でも規則の一覧は開く', await p.locator('#gram-rule-dialog').isVisible());
  ok('一覧に 5 行ある', await p.locator('#gram-rule-manage-list .deck-manage-row').count() === 5);
  await p.click('#btn-gram-rule-close');
  await p.waitForTimeout(200);

  await p.click('#btn-gram-add');
  await p.waitForTimeout(250);
  ok('例文のダイアログが開く', await p.locator('#gram-item-dialog').isVisible());
  await p.selectOption('#gram-item-rule', 'gr-there');
  await p.fill('#gram-item-en', 'There are four cats here.');
  await p.click('#btn-gram-item-save');
  await p.waitForTimeout(250);
  ok('/ の無い英文は弾かれる', (await p.innerText('#gram-item-status')).indexOf('/') >= 0,
     await p.innerText('#gram-item-status'));
  await p.fill('#gram-item-en', 'There are / four cats / here.');
  await p.fill('#gram-item-ja', 'ここに猫が4匹いる。');
  await p.check('#gram-item-a1');
  await p.click('#btn-gram-item-save');
  await p.waitForTimeout(300);
  ok('足せた', await p.evaluate(() =>
    JSON.parse(localStorage.getItem('sunkan:gram:items') || '[]').length) === 39);

  /* ===================================================================
   * ✎ は、答え合わせの前には開かない
   *
   * **ここは答えが漏れるかどうかの見張り。** 直す画面には英文が区切りごと
   * 丸ごと入り、訳も、どちらが正しいかの印まで入っている。送信前に開けたら
   * 問題の答えがそのまま読める。🔈 には同じ門があったのに、✎ には無かった。
   * ================================================================= */
  // 上で今日ぶんを答え切っているので、予定を組み直させてから問題を出す
  // （`#gram-stage` は「今日はもう無い」とき**正しく畳まれる**ので、
  //   そのまま待つと出てこない）
  await p.evaluate(() => {
    const ui = JSON.parse(localStorage.getItem('sunkan:gram:ui') || '{}');
    delete ui.session;
    localStorage.setItem('sunkan:gram:ui', JSON.stringify(ui));
    localStorage.setItem('sunkan:gram:srs', '{}');
  });
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#gram-stage', { state: 'visible', timeout: 15000 });
  await p.waitForTimeout(300);

  await p.click('#btn-gram-edit');
  await p.waitForTimeout(300);
  ok('★ 送る前に ✎ を押しても、直す画面が開かない',
     (await p.locator('#gram-item-dialog').isVisible()) === false);
  ok('なぜ開かないのかを言う',
     /答え合わせのあと/.test(await p.innerText('#gram-status')),
     await p.innerText('#gram-status'));
  const leakEn = await p.evaluate(() => {
    const el = document.getElementById('gram-item-en');
    return el ? el.value : '(欄が無い)';
  });
  ok('★ 英文が欄に入っていない（開かなかったので）', !/\//.test(leakEn), leakEn);

  // 答え合わせのあとなら開ける（門が固すぎないことの確かめ）。
  // **二択の規則を名指しで開く** — どれが出るかは日によって変わり、
  // タイプの段が出ると押す所が違う
  await p.selectOption('#gram-rule-select', 'gr-there');
  await p.waitForTimeout(400);
  await p.click('#btn-gram-pick-0');
  await p.waitForTimeout(350);
  await p.click('#btn-gram-edit');
  await p.waitForTimeout(300);
  ok('答え合わせのあとなら ✎ で直せる', await p.locator('#gram-item-dialog').isVisible(),
     'status=' + (await p.innerText('#gram-status'))
     + ' / grades=' + (await p.locator('#gram-grades').isVisible())
     + ' / view=' + (await p.innerText('#gram-view')).replace(/\s+/g, ' ').slice(0, 60));
  await p.click('#btn-gram-item-cancel');
  await p.waitForTimeout(250);

  /* ===================================================================
   * 旗は「次に出したとき」に下りる（決まりどおりか）
   *
   * Has / Have の例文に 1 つだけ旗を立て、その規則を開く。
   * **旗の付いた例文が先に出て、出た時点で旗が下りる**のが決まり。
   * ================================================================= */
  const target = await p.evaluate(() => {
    // 今日ぶんは上で答え切っているので、予定を組み直させる
    // （`sunkan:gram:ui` が「今日やった規則」を覚えている）
    const ui = JSON.parse(localStorage.getItem('sunkan:gram:ui') || '{}');
    delete ui.session;
    localStorage.setItem('sunkan:gram:ui', JSON.stringify(ui));
    localStorage.setItem('sunkan:gram:srs', '{}');   // 今日また出るようにする

    const items = JSON.parse(localStorage.getItem('sunkan:gram:items') || '[]')
      .filter(x => x.rule === 'gr-have');
    // わざと 2 つめを立てる（1 つめが先に出ただけ、では確かめにならない）
    const pick = items[1];
    const seen = JSON.parse(localStorage.getItem('sunkan:gram:seen') || '{}');
    items.forEach(function (it, i) { seen[it.id] = { at: 1000 + i, g: 3, q: 0 }; });
    seen[pick.id] = { at: 1000, g: 3, q: 1 };
    localStorage.setItem('sunkan:gram:seen', JSON.stringify(seen));
    return { id: pick.id, en: pick.en };
  });
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#gram-stage', { state: 'visible', timeout: 15000 });
  await p.selectOption('#gram-rule-select', 'gr-have');
  await p.waitForTimeout(400);

  const shownEn = (await p.innerText('#gram-view')).replace(/\s+/g, ' ');
  const head = target.en.split('/')[0].trim();
  ok('★ 旗の付いた例文が先に出る', shownEn.indexOf(head) >= 0, head + '  /  ' + shownEn);
  ok('★ 出した時点で旗が下りる',
     await p.evaluate(k => {
       const seen = JSON.parse(localStorage.getItem('sunkan:gram:seen') || '{}');
       return !!seen[k] && seen[k].q === 0;
     }, target.id),
     JSON.stringify(await p.evaluate(k => {
       const seen = JSON.parse(localStorage.getItem('sunkan:gram:seen') || '{}');
       return seen[k];
     }, target.id)));

  /* ===================================================================
   * 裏で同期が走っても、自分の答えは消えない
   *
   * 相手の端末の記録が届いて段が「二択 → タイプ」に上がると、
   * **二択で答えて答え合わせを見ている画面がタイプの採点に化け**、
   * 自分の答えが「（書かなかった）」に置き換わって赤くなっていた。
   * 「自分の答えは採点を押し終えるまで消さない」の約束を破る。
   * ================================================================= */
  await p.selectOption('#gram-rule-select', 'gr-there');
  await p.waitForTimeout(400);
  await p.click('#btn-gram-pick-1');
  await p.waitForTimeout(300);
  const mineBefore = (await p.innerText('#gram-mine')).trim();
  ok('二択で答えると「あなた」が出ている', mineBefore.length > 0, mineBefore);

  // 相手の端末から記録が届いて段が上がった、のと同じことを起こす
  await p.evaluate(() => {
    const log = JSON.parse(localStorage.getItem('sunkan:gram:log') || '{}');
    log['gr-there'] = [{ at: 1, g: 3, iv: 1 }, { at: 2, g: 3, iv: 2 }, { at: 3, g: 3, iv: 3 }];
    localStorage.setItem('sunkan:gram:log', JSON.stringify(log));
    window.SUNKAN_GRAM.reload();     // sync.js の refreshViews が呼ぶのと同じ口
  });
  await p.waitForTimeout(350);
  const mineAfter = (await p.innerText('#gram-mine')).trim();
  ok('★ 裏で同期が走っても、自分の答えが消えない', mineAfter === mineBefore,
     '前=' + mineBefore + ' / 後=' + mineAfter);
  ok('★ 答え合わせが勝手に赤くならない',
     (await p.locator('#gram-mine').getAttribute('class') || '').indexOf('is-wrong') < 0,
     String(await p.locator('#gram-mine').getAttribute('class')));

  ok('最後までエラーなし', errs.length === 0, errs.join(' / '));
  await p.screenshot({ path: '/tmp/claude-0/-home-user-sunkan-333/d66a3ed4-89ad-527a-b1fe-8ea58c430df8/scratchpad/gram-' + width + '.png', fullPage: true });
  await ctx.close();
}

await b.close();
console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
process.exit(fail ? 1 : 0);
