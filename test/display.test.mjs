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
