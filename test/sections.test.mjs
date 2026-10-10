/*
 * test/sections.test.mjs — 段位轴（section）与 syntax_intro 首现判定单测
 * 运行：node --test test/sections.test.mjs
 *
 * 覆盖任务卡 T15：
 *   1) 120 题全部有 section，且严格落在题号区间表上；
 *   2) buildSections 按 section 分组，section 缺省 / 非法时不崩；
 *   3) syntax_intro 首现判定（同题多语法、跨段重复不重复弹卡、无效元素不渲染）；
 *   4) 渲染层骨架（app.js / index.html）确实按 section 与常驻标签行实现。
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

/* 段位回填口径（与写入 data/questions.json 时一致，可复算） */
const RANGES = [
  [1, 'q001', 'q005'], [1, 'q064', 'q078'],
  [2, 'q006', 'q012'], [2, 'q021', 'q033'],
  [3, 'q013', 'q018'], [3, 'q034', 'q047'],
  [4, 'q019', 'q020'], [4, 'q048', 'q063'],
  [5, 'q079', 'q099'],
  [6, 'q100', 'q120']
];
function expectedSection(id) {
  for (const [sec, a, b] of RANGES) if (id >= a && id <= b) return sec;
  return null;
}

test('every_question_has_section_matching_the_range_table', () => {
  assert.equal(QUESTIONS.length, 120);
  let missing = 0;
  for (const q of QUESTIONS) {
    if (!Number.isInteger(q.section)) missing += 1;
    assert.equal(q.section, expectedSection(q.id), `${q.id} 的 section 应落在区间表上`);
    assert.ok(q.section >= 1 && q.section <= 6, `${q.id} section 必须在 1..6`);
  }
  assert.equal(missing, 0, '120 题必须全部有整数 section');
});

test('section_is_an_axis_independent_of_level', () => {
  const combos = new Set(QUESTIONS.map((q) => q.section + ':' + q.level));
  assert.ok(combos.size > 6, '段位与难度是两根不同的轴，组合数应远多于整段数');
  const section5 = QUESTIONS.filter((q) => q.section === 5);
  assert.ok(section5.some((q) => q.level !== 1), '同一段位内应存在多种难度档');
});

test('buildSections_orders_by_section_then_seq', () => {
  const shuffled = QUESTIONS.slice().reverse();
  const sections = L.buildSections(shuffled);
  assert.deepEqual(sections.map((s) => s.section), [1, 2, 3, 4, 5, 6]);
  for (const s of sections) {
    const seqs = s.questions.map((q) => q.seq);
    assert.deepEqual(seqs, seqs.slice().sort((a, b) => a - b), `第 ${s.section} 段须按 seq 升序`);
  }
});

test('buildSections_does_not_crash_on_missing_or_bad_section', () => {
  assert.deepEqual(L.buildSections(null), []);
  assert.deepEqual(L.buildSections([]), []);
  const mixed = [
    { id: 'm1', seq: 1 },
    { id: 'm2', section: null, seq: 2 },
    { id: 'm3', section: 'abc', seq: 3 },
    { id: 'm4', section: 3, seq: 4 },
    { id: 'm5', section: '2', seq: 5 }
  ];
  let out;
  assert.doesNotThrow(() => { out = L.buildSections(mixed); });
  assert.deepEqual(out.map((s) => s.section), [2, 3], '非法 section 跳过，字符串数字可归一化');
  assert.deepEqual(out.map((s) => s.questions.map((q) => q.id)), [['m5'], ['m4']]);
});

test('syntax_intro_first_occurrence_only_by_section_then_seq', () => {
  const card = (syntax, tag) => ({ syntax, what: 'w' + tag, when: 'x', example: 'e', misuse: 'm' });
  const qs = [
    { id: 'a', section: 1, seq: 1, syntax_intro: [card('LEFT JOIN', '1'), card('COALESCE', '1')] },
    { id: 'b', section: 1, seq: 2, syntax_intro: [card('left join', '2')] },
    { id: 'c', section: 5, seq: 9, syntax_intro: [card('LEFT JOIN', '3'), card('CASE WHEN', '3')] }
  ];
  const map = L.syntaxIntrosFor(qs);
  assert.equal(map.a.length, 2, '同题两个不同语法各自成卡');
  assert.equal(map.b, undefined, '跨题重复语法（含大小写差异）不再出卡');
  assert.equal(map.c.length, 1, '跨段重复不再出卡，新语法仍出卡');
  assert.equal(map.c[0].syntax, 'CASE WHEN');
});

test('syntax_intro_invalid_elements_render_no_card', () => {
  const good = { syntax: 'VALID', what: 'w', when: 'x', example: 'e', misuse: 'm' };
  const bad = [
    null, 'string', 42,
    { syntax: 'A', what: 'w' },
    { syntax: '   ', what: 'w', when: 'x', example: 'e', misuse: 'm' },
    { syntax: 'B', what: '', when: 'x', example: 'e', misuse: 'm' }
  ];
  const map = L.syntaxIntrosFor([{ id: 'x', section: 1, seq: 1, syntax_intro: bad.concat([good]) }]);
  assert.deepEqual(map.x.map((c) => c.syntax), ['VALID'], '不完整元素全部丢弃，只留有效首现');
  assert.deepEqual(L.syntaxIntrosFor([{ id: 'y', section: 1, seq: 1, syntax_intro: [] }]), {}, '空数组不出卡');
  assert.deepEqual(L.syntaxIntrosFor([{ id: 'z', section: 1, seq: 1 }]), {}, '字段缺省不出卡');
  assert.deepEqual(L.syntaxIntrosFor(null), {}, '空题库不崩');
  assert.equal(L.validSyntaxItem(good).syntax, 'VALID');
  assert.equal(L.validSyntaxItem({ syntax: 'A' }), null);
});

test('render_layer_wires_section_tags_and_syntax_cards', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  assert.doesNotMatch(app, /sec\.level/, '渲染层不得再用 sec.level 表示段位');
  assert.match(app, /sec\.section/, '渲染层必须按 sec.section 编段');
  assert.match(app, /syntaxIntrosFor/, '渲染层必须调用首现判定');
  assert.match(app, /renderSyntaxCards/);
  assert.match(app, /renderTags/);
  assert.match(html, /id="q-tags"/);
  assert.match(html, /id="q-syntax"/);
  /* 标签行与语法卡必须在 q-tables-body 折叠容器之外 */
  const collapsed = html.slice(html.indexOf('id="q-tables-body"'), html.indexOf('id="q-dict-hints"'));
  assert.doesNotMatch(collapsed, /id="q-tags"/);
  assert.doesNotMatch(collapsed, /id="q-syntax"/);
});
