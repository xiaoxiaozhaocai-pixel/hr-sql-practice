/*
 * test/display.test.mjs — HRIS 展示层裁定 2/3 守门单测
 * 运行：node --test test/display.test.mjs
 *
 * 裁定 2（回函_表行数展示与答案数字不上屏回执_20261010）：答案数字一律不上屏——
 *   题面 / 形状提示（output_hint）里不得出现「共 N 行」「正确答案 X」；
 *   数字迁入工程专用字段 expected_note（不进判题、不直接上屏）。
 * 裁定 3：结果规模提示只允许作为渐进提示的最后一层出现。
 *
 * 本测试锁住这两条口径，防止后续入库/润色把数字又漂回展示层。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import L from '../src/levels.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PACK = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'questions.json'), 'utf8'));
const QUESTIONS = PACK.questions;

/* 学生直接读到的字段 = 展示层；expected_note 是工程字段，不在其中 */
const SCREEN_FIELDS = ['stem', 'requirement', 'hint', 'output_hint'];
const SIZE_RE = /共\s*\d+\s*行/;
const ANSWER_RE = /正确答案/;
/* 结果规模两种既有体例：「共 N 行」（新批）与「预期 N 行」（v1 前 20 题原体例） */
const NOTE_SIZE_RE = /结果规模：(?:共|预期)\s*(\d+)\s*行/;
const NOTE_ANSWER_RE = /^正确答案\s+\S/;

test('answer_numbers_are_kept_off_the_screen', () => {
  assert.equal(QUESTIONS.length, 120);
  const leaks = [];
  for (const q of QUESTIONS) {
    for (const f of SCREEN_FIELDS) {
      const v = q[f] || '';
      if (SIZE_RE.test(v)) leaks.push(`${q.id}.${f} 含结果行数`);
      if (ANSWER_RE.test(v)) leaks.push(`${q.id}.${f} 含正确答案字样`);
    }
  }
  assert.deepEqual(leaks, [], '展示层不得出现结果行数与正确答案字样');
});

test('every_question_keeps_a_shape_only_output_hint', () => {
  for (const q of QUESTIONS) {
    const hint = q.output_hint;
    assert.equal(typeof hint, 'string', `${q.id} 必须有 output_hint`);
    assert.ok(hint.trim().length > 0, `${q.id} 的 output_hint 不能是空串`);
    /* 收掉数字后仍须留下形状：列数 / 列名 / 每行代表什么 / 排序 */
    assert.match(hint, /列|行|个数字|排序|升序|降序|空结果/, `${q.id} 的形状提示被收空了`);
  }
});

test('engineering_note_never_loses_the_collected_numbers', () => {
  let withNote = 0;
  for (const q of QUESTIONS) {
    const note = q.expected_note;
    if (note === undefined || note === null || note === '') continue;
    withNote += 1;
    assert.equal(typeof note, 'string', `${q.id} 的 expected_note 必须是字符串`);
    const okAnswer = NOTE_ANSWER_RE.test(note);
    const m = note.match(NOTE_SIZE_RE);
    assert.ok(okAnswer || m, `${q.id} 的 expected_note 必须带数字（正确答案 V… 或 结果规模：共 N 行）`);
    if (m) {
      const rc = q.expected && q.expected.row_count;
      if (typeof rc === 'number') {
        assert.equal(Number(m[1]), rc, `${q.id} 的 expected_note 行数与 expected.row_count 不符`);
      }
    }
  }
  assert.ok(withNote >= 100, `expected_note 覆盖题数过低（当前 ${withNote}），数字可能在收数字时丢了`);
});

test('renderer_shows_size_only_as_last_hint_and_hides_correct_answer_note', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  assert.match(app, /q\.expected_note/, '渲染层必须读 expected_note 才能把结果规模放进渐进提示');
  assert.match(app, /indexOf\('正确答案'\)\s*!==\s*0/, '渲染层必须挡住以「正确答案」开头的工程字段');
  assert.doesNotMatch(app, /textContent\s*=\s*[^;\n]*expected_note/, 'expected_note 不得直接写入 textContent');
  assert.match(app, /q-output/, '形状提示仍须有独立展示位');
  /* 渐进提示列表：形状层在前，结果规模在最后 */
  const shape = { id: 'x', hint: '两列：工号、姓名；按工号升序。', output_hint: '两列：工号、姓名；按工号升序。', expected_note: '结果规模：共 170 行' };
  const list = L.hintList(shape);
  assert.ok(list.length >= 1, 'hintList 必须给出非空提示列表');
});

/*
 * 行序口径不变式守门（2026-10-10 口径对齐，权威源：HRIS《修订说明_行序口径对齐_20261010》）
 * 判据：题面（requirement）或输出提示（output_hint）写明排序 ⟺ expected.order_sensitive = true。
 * 双向都要守：true 不说清 = 学员被暗坑；false 却要求排序 = 提示承诺了不执行的规则。
 */
const ORDER_TEXT_RE = /排序|升序|降序|顺序排列|按时点升序|依次|的顺序|①②③/;
const ORDER_SENSITIVE_TOTAL = 94;

test('row_order_flag_requires_explicit_ordering_text', () => {
  const ordered = QUESTIONS.filter((q) => q.expected && q.expected.order_sensitive === true);
  assert.equal(
    ordered.length,
    ORDER_SENSITIVE_TOTAL,
    `逐行判题数应为 ${ORDER_SENSITIVE_TOTAL}（口径对齐后锚点），当前 ${ordered.length}；若确为口径变更，请同步 docs/questions-contract-v1.md 与本锚点`,
  );
  const silent = ordered
    .filter((q) => !ORDER_TEXT_RE.test(`${q.requirement || ''}${q.output_hint || ''}`))
    .map((q) => q.id);
  assert.deepEqual(silent, [], '逐行判的题必须在题面或输出提示里说清行序，否则学员内容对、顺序错会被暗扣分');
});

test('output_hint_never_promises_ordering_when_flag_is_false', () => {
  const promiseOnly = QUESTIONS
    .filter((q) => (!q.expected || q.expected.order_sensitive !== true) && ORDER_TEXT_RE.test(q.output_hint || ''))
    .map((q) => q.id);
  assert.deepEqual(promiseOnly, [], '集合比对的题不得在输出提示里要求排序（提示与判分必须一致）');
});

/* ---------------------------- GF2 P1：渲染 / 交互接线守门 ----------------------------
 * app.js 是浏览器 IIFE，无 DOM 时不执行；下列断言固定在源码接线层面，
 * 防止后续重构把进入题目、保存合并、方向键 tablist、退出返回与段末位置改掉。
 */

const APP_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
const HTML_SRC = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(ROOT, 'src', 'style.css'), 'utf8');

test('gf2_enter_question_copy_and_focus_wiring', () => {
  for (const copy of ['本题尚未判题', '已恢复本题草稿，继续编辑', '本题已完成，可改写练习']) {
    assert.ok(APP_SRC.includes(copy), `进入题目文案缺失：${copy}`);
  }
  assert.match(APP_SRC, /function enterAnnouncement/, '需要「段内位置 + 恢复状态」的进入播报');
  assert.match(APP_SRC, /title\.focus/, '用户主动选题后焦点应落到 #q-title');
  /* B 的已知 bug：位置不能传题目对象（会播报第 0 题）。 */
  assert.doesNotMatch(APP_SRC, /sectionIndexOf\(sec,\s*q\)/, 'renderNav 位置不得再传题目对象');
  assert.match(APP_SRC, /sectionIndexOf\(sec,\s*q\.id\)/, 'renderNav 位置必须传题目 id');
});

test('gf2_syntax_confirm_focus_and_start_sql_entry', () => {
  assert.match(APP_SRC, /function refreshSyntaxStart/, '需要「最后一张未读语法卡确认后呈现开始写 SQL」');
  assert.ok(APP_SRC.includes('开始写 SQL'), '缺少开始写 SQL 入口');
  assert.match(APP_SRC, /querySelector\('\.syntax-review-toggle'\)/, '确认后焦点应去替换后的回看按钮');
  assert.match(APP_SRC, /replayAnim\(ul\.lastChild/, '只有新展开的提示用 A 动画');
});

test('gf2_editor_status_merges_save_feedback_after_400ms', () => {
  assert.match(APP_SRC, /function scheduleSaveStatus/, '需要合并保存反馈的调度函数');
  assert.match(APP_SRC, /var delay = prefersReducedMotion\(\) \? 0 : 400/, '保存反馈合并窗口应为 400ms（减弱动画下为 0）');
  assert.ok(APP_SRC.includes('草稿已保存到此浏览器'), '真实写入文案缺失');
  assert.ok(APP_SRC.includes('草稿仅暂存在本页，关闭可能丢失'), '仅内存态文案缺失');
  assert.match(APP_SRC, /clearTimeout\(editorStatusTimer\)/, '运行 / 判题结束时必须清掉待播的旧保存文案');
});

test('gf2_pass_celebration_only_on_first_completion', () => {
  assert.match(APP_SRC, /celebrate:\s*firstDone/, '只有首次完成触发 B');
  assert.match(APP_SRC, /info\.celebrate === false/, '非首次通过不得播放 pop');
  assert.ok(APP_SRC.includes('pass-summary'), '短通过摘要需要可被 aria-describedby 引用的 id');
  assert.match(APP_SRC, /L\.goalMet\(state\)/, '今日目标应读持久状态');
});

test('gf2_exit_and_return_wiring', () => {
  for (const id of ['btn-wrap', 'btn-wrap-back', 'btn-retry-save', 'foot-persist', 'today-wrap-title']) {
    assert.ok(HTML_SRC.includes('id="' + id + '"'), `index.html 缺少 #${id}`);
  }
  assert.ok(APP_SRC.includes('今天到这里：新完成'), '收束文案必须写清新完成 / 复查数量');
  assert.ok(APP_SRC.includes('下次从 #'), '收束文案必须给出下一次继续的题号');
  assert.match(APP_SRC, /function showTodayWrap/, '收束入口应存在');
  assert.match(APP_SRC, /function saveSentence/, '保存成功 / 仅内存暂存必须分开表达');
});

test('gf2_section_summary_sits_between_verdict_and_next_action', () => {
  const verdict = HTML_SRC.indexOf('id="verdict"');
  const summary = HTML_SRC.indexOf('id="section-summary"');
  const next = HTML_SRC.indexOf('id="next-action"');
  assert.ok(verdict > -1 && summary > -1 && next > -1, '三块都必须存在');
  assert.ok(verdict < summary && summary < next, '段末总结必须在判定之后、下一步之前');
  assert.match(HTML_SRC, /id="section-summary"[^>]*role="region"/, '段末总结需要 region 名称');
});

test('gf2_tablists_have_roving_tabindex_and_arrow_keys', () => {
  assert.match(APP_SRC, /function wireTablist/, '需要 tablist 方向键处理');
  assert.match(APP_SRC, /ArrowRight/);
  assert.match(APP_SRC, /ArrowLeft/);
  assert.match(APP_SRC, /setAttribute\('tabindex'/, '需要 roving tabindex 管理');
  assert.match(HTML_SRC, /id="result-panel"[^>]*role="tabpanel"/, '结果区应有 tabpanel 关联');
  for (const t of ['tab-mine', 'tab-ref', 'tab-tables', 'tab-dialect']) {
    assert.ok(HTML_SRC.includes('id="' + t + '"'), `缺少页签 #${t}`);
  }
});

test('gf2_next_primary_is_described_by_short_pass_summary', () => {
  assert.match(APP_SRC, /aria-describedby/, '下一步主按钮应关联短通过摘要');
  assert.match(APP_SRC, /'section-summary-title'/, '段通关时还应关联段末总结标题');
  assert.match(HTML_SRC, /id="section-summary-title"/, '段末总结标题 id 必须存在');
});

test('gf2_dead_heart_rules_removed_and_motion_budget_intact', () => {
  assert.doesNotMatch(CSS_SRC, /\.stat-hearts/, '.stat-hearts 已是死规则，必须删除');
  assert.doesNotMatch(CSS_SRC, /\.level-hearts/, '.level-hearts 已是死规则，必须删除');
  assert.doesNotMatch(CSS_SRC, /hr-shake/, '不得重新引入 hr-shake');
  assert.doesNotMatch(CSS_SRC, /transition:\s*width/, '进度过渡不得改回 width');
  const keyframes = CSS_SRC.match(/@keyframes\s+[\w-]+/g) || [];
  assert.deepEqual(
    keyframes.map((k) => k.replace(/\s+/, ' ')).sort(),
    ['@keyframes hr-fade-up', '@keyframes hr-pop', '@keyframes hr-summary-in'],
    '关键帧只允许三个',
  );
});
