/*
 * test/qa.test.mjs — 「问一问」本地问答内核单测（node 原生 test runner，零框架依赖）
 * 运行：node --test test/qa.test.mjs
 *
 * 覆盖：表名 / 中文业务词 / 英文列名命中；未命中明确返回；SQLite 报错映射；
 *       compareToReference 的保守性；题目上下文问答。
 * 用例名一律 ASCII。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QA from '../src/qa.js';
import HRTables from '../src/tables.js';
import HRLevels from '../src/levels.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PACK = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'questions.json'), 'utf8'));

const INDEX = QA.buildIndex({
  tables: HRTables.allTables(),
  questions: PACK.questions,
  syntaxCards: HRLevels.syntaxIntrosFor(PACK.questions)
});

const Q001 = PACK.questions.find((q) => q.id === 'q001');
assert.ok(Q001, 'fixture: data/questions.json 里应有 q001');

function ask(text, question) {
  return QA.ask(text, { index: INDEX, question: question || null });
}

test('table_hit_by_english_name', () => {
  const res = ask('HR_EMPLOYEE');
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'table');
  assert.match(res.title, /HR_EMPLOYEE/);
  assert.match(res.source, /HR_EMPLOYEE/);
});

test('table_hit_by_chinese_name', () => {
  const res = ask('薪酬');
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'table');
  assert.match(res.source, /HR_SALARY/);
});

test('field_hit_by_chinese_business_word', () => {
  const res = ask('实发');
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'field');
  assert.match(res.source, /HR_SALARY\.NetPay/);
  assert.ok(res.lines.some((l) => l.includes('实发')), 'lines 应回显业务含义');
});

test('field_hit_by_english_column', () => {
  const res = ask('netpay');
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'field');
  assert.match(res.source, /NetPay/);
});

test('miss_returns_explicit_local_knowledge_fallback', () => {
  for (const text of ['今天天气怎么样', '这道题答案是多少钱', 'zzz_not_in_kb']) {
    const res = ask(text);
    assert.equal(res.ok, false, text);
    assert.equal(res.kind, 'fallback', text);
    assert.equal(res.title, QA.FALLBACK_TITLE, text);
    assert.ok(res.lines.length >= 1, text);
  }
});

test('miss_does_not_repeat_title_or_hint', () => {
  // 未命中时不得同句重复：title 不出现在 lines 里，lines 与 hint 不互为子串。
  const cases = [
    ask('今天天气怎么样'),
    ask('zzz_not_in_kb'),
    QA.ask('zzz', { index: null })
  ];
  for (const res of cases) {
    assert.equal(res.ok, false);
    const body = res.lines.join(' ');
    assert.ok(!body.includes(QA.FALLBACK_TITLE), 'title 不应出现在 lines 里: ' + body);
    assert.ok(!body.includes(res.title), 'lines 不应重复 title');
    assert.ok(!body.includes(res.hint), 'lines 不应包含 hint 全文');
    assert.ok(!res.hint.includes(body), 'hint 不应包含 lines 全文');
  }
});

test('bare_question_number_hits_question', () => {
  const idx = QA.buildIndex({
    questions: [{ seq: 12, id: 'q12', title: '分组统计', knowledge_point: 'GROUP BY', pitfalls: ['漏写列', '别名冲突'] }],
    tables: [],
    syntaxCards: []
  });
  for (const text of ['12', '#12', '第12题']) {
    const res = QA.ask(text, { index: idx });
    assert.equal(res.ok, true, text);
    assert.equal(res.kind, 'question', text);
    assert.match(res.title, /12/, text);
    assert.ok(res.lines.join(' ').includes('考点') && res.lines.join(' ').includes('GROUP BY'), text);
    assert.ok(res.lines.join(' ').includes('漏写列'), text);
    assert.match(res.source, /q12/, text);
  }
});

test('unknown_bare_question_number_falls_back_without_fabricating', () => {
  const idx = QA.buildIndex({
    questions: [{ seq: 12, id: 'q12', title: '分组统计' }],
    tables: [],
    syntaxCards: []
  });
  const res = QA.ask('999', { index: idx });
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'fallback');
  assert.equal(res.title, QA.FALLBACK_TITLE);
  assert.ok(!res.lines.join(' ').includes(QA.FALLBACK_TITLE));
});

test('bare_question_number_is_safe_without_index', () => {
  const res = QA.ask('12', { index: null });
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'fallback');
});


test('sqlite_error_map_covers_at_least_five_kinds', () => {
  const cases = [
    ['no such table: HR_EMPOLYEE', /表/],
    ['no such column: NetPay2', /列/],
    ['near ",": syntax error', /语法/],
    ['misuse of aggregate: COUNT()', /聚合/],
    ['ambiguous column name: ID', /歧义/],
    ['no such function: GETDATE', /函数/],
    ['wrong number of arguments to function substr()', /参数/]
  ];
  const seen = new Set();
  for (const [msg, re] of cases) {
    const out = QA.explainSqliteError(msg);
    assert.ok(typeof out === 'string' && out.length > 0, msg);
    assert.match(out, re, msg);
    seen.add(out);
  }
  assert.ok(seen.size >= 5, '至少 5 种不同解释，实得 ' + seen.size);
});

test('error_like_question_routes_to_error_kind', () => {
  const res = ask('near "FROM": syntax error');
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'error');
  assert.equal(res.source, '本地报错映射表');
});

test('compare_is_conservative_when_input_missing', () => {
  const empty = QA.compareToReference('', 'SELECT EmpNo FROM HR_EMPLOYEE');
  assert.equal(empty.ok, false);
  assert.equal(empty.columnCount.user, null);
  const noRef = QA.compareToReference('SELECT EmpNo FROM HR_EMPLOYEE', '');
  assert.equal(noRef.ok, false);
  assert.ok(noRef.notes.length >= 1);
});

test('compare_reports_only_definite_structural_diffs', () => {
  const res = QA.compareToReference(
    'SELECT EmpNo FROM HR_EMPLOYEE',
    'SELECT EmpNo, EmpName FROM HR_EMPLOYEE ORDER BY EmpNo'
  );
  assert.equal(res.ok, true);
  assert.equal(res.columnCount.user, 1);
  assert.equal(res.columnCount.ref, 2);
  assert.equal(res.orderBy.user, false);
  assert.equal(res.orderBy.ref, true);
  assert.equal(res.selectAll.user, false);
  assert.ok(res.observations.some((o) => o.includes('列数粗算不同')));
  assert.ok(res.observations.some((o) => o.includes('ORDER BY')));
});

test('compare_does_not_guess_column_count_for_select_star_or_subquery', () => {
  const star = QA.compareToReference('SELECT * FROM HR_EMPLOYEE', 'SELECT EmpNo FROM HR_EMPLOYEE');
  assert.equal(star.columnCount.user, null, 'SELECT * 不可粗算列数');
  assert.equal(star.selectAll.user, true);

  const sub = QA.compareToReference(
    'SELECT EmpNo FROM (SELECT EmpNo FROM HR_EMPLOYEE) t',
    'SELECT EmpNo FROM HR_EMPLOYEE'
  );
  assert.equal(sub.columnCount.user, null, '子查询结构不下结论');
  assert.ok(sub.notes.some((n) => n.includes('子查询')), '应说明未对比用表');
});

test('question_context_answers_knowledge_point', () => {
  const res = QA.ask('考点', { index: INDEX, question: Q001 });
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'question');
  assert.match(res.source, /q001/);
  assert.ok(res.lines.join(' ').includes(Q001.knowledge_point));
});

test('question_context_answers_pitfalls', () => {
  const res = QA.ask('易错点', { index: INDEX, question: Q001 });
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'question');
  assert.ok(res.lines.join(' ').includes(Q001.pitfalls[0]));
});

test('question_context_tables_derived_from_reference_sql', () => {
  const res = QA.ask('涉及哪些表', { index: INDEX, question: Q001 });
  assert.equal(res.ok, true);
  assert.ok(res.lines.join(' ').includes('HR_EMPLOYEE'));
});

test('no_question_context_still_answers_table_and_syntax', () => {
  const tbl = ask('HR_ORG');
  assert.equal(tbl.kind, 'table');
  const syntax = ask('IS NULL');
  assert.equal(syntax.kind, 'syntax');
});

test('syntax_card_hit_returns_source_of_card', () => {
  const res = ask('GROUP BY');
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'syntax');
  assert.match(res.source, /语法卡/);
});

test('question_context_answers_approach_as_action_sequence', () => {
  const res = ask('解题思路', Q001);
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'question');
  assert.match(res.title, /解题思路/);
  assert.match(res.source, /q001/);
  assert.ok(res.lines.length >= 3, '应给出多步动作序列，实得 ' + res.lines.length);
  const text = res.lines.join(' ');
  assert.ok(text.includes('HR_EMPLOYEE'), '应点名本题涉及的表');
  assert.doesNotMatch(text, /共\s*\d+\s*行/, '不得报结果行数');
  assert.doesNotMatch(text, /正确答案/, '不得泄露答案');
});

test('approach_intent_does_not_leak_into_hint', () => {
  const ap = ask('思路', Q001);
  assert.equal(ap.title, '本题解题思路');
  const hint = ask('提示', Q001);
  assert.equal(hint.title, '本题提示');
});

/* ---- 面板接入（静态核对：node 里没有 DOM，这里只查接线是否存在） ---- */

const HTML = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
const BUILD_SRC = fs.readFileSync(path.join(ROOT, 'build.mjs'), 'utf8');

test('panel_markup_has_required_ids_and_keyboard_toggle', () => {
  for (const id of ['qa-panel', 'qa-toggle', 'qa-body', 'qa-input', 'qa-ask', 'qa-results', 'qa-context']) {
    const n = HTML.split(`id="${id}"`).length - 1;
    assert.equal(n, 1, `#${id} 应恰好出现 1 次，实得 ${n}`);
  }
  assert.match(HTML, /id="qa-toggle"[^>]*role="button"/);
  assert.match(HTML, /id="qa-toggle"[^>]*tabindex="0"/);
  assert.match(HTML, /id="qa-body"[^>]*hidden=""/);
});

test('qa_placeholder_and_build_injection_present', () => {
  assert.equal(HTML.split('/*__HR_QA__*/').length - 1, 1);
  assert.ok(BUILD_SRC.includes("inject(html, '/*__HR_QA__*/'"));
  assert.ok(APP_SRC.includes('window.HRQa'));
  assert.ok(APP_SRC.includes('function qaSetOpen'));
  assert.ok(APP_SRC.includes("qaToggle.addEventListener('keydown'"));
});

test('approach_chip_is_wired_into_qa_chips_row', () => {
  assert.equal(HTML.split('data-qa="解题思路"').length - 1, 1, '「解题思路」chip 应恰好 1 个');
  assert.equal((HTML.match(/class="qa-chip"/g) || []).length, 5, 'qa-chips 行应有 5 个 chip');
  assert.match(HTML, /id="qa-input"[^>]*placeholder="[^"]*解题思路/);
});

test('approach_steps_are_clean_text_without_double_period', () => {
  /* 题面 output_hint 自带宽句号，拼接时若再补一个会出「。。」，读起来毛糙。 */
  for (const id of ['q001', 'q042', 'q120']) {
    const q = PACK.questions.find((x) => x.id === id);
    assert.ok(q, id + ' 应存在于题库');
    const res = ask('解题思路', q);
    assert.ok(res.lines.length >= 3, id + ' 应给出多步动作序列');
    res.lines.forEach((l) => assert.doesNotMatch(l, /。。/, id + ' 出现连续句号：' + l));
  }
});

test('approach_does_not_report_cte_names_as_tables', () => {
  /* q100 用 WITH tp(t) AS (…) … FROM tp LEFT JOIN HR_EMPLOYEE：tp 不是表。 */
  const q = PACK.questions.find((x) => x.id === 'q100');
  const res = ask('解题思路', q);
  const text = res.lines.join(' ');
  assert.match(text, /HR_EMPLOYEE/, '应点名真实表');
  assert.doesNotMatch(text, /落在\s+tp\b/, 'CTE 名 tp 不应被当成表');
});

test('approach_keeps_join_step_when_cte_join_present', () => {
  const q = PACK.questions.find((x) => x.id === 'q100');
  const res = ask('解题思路', q);
  assert.ok(res.lines.join(' ').includes('JOIN'), '有 JOIN 的题应给连表提示');
});

test('approach_strips_recursive_cte_names_too', () => {
  /* q115 用 WITH RECURSIVE m(ym) AS (…) , me AS (…)：m / me 都不是表。 */
  const q = PACK.questions.find((x) => x.id === 'q115');
  const res = ask('解题思路', q);
  const text = res.lines.join(' ');
  assert.match(text, /HR_EMPLOYEE/, '应点名真实表');
  assert.doesNotMatch(text, /落在\s+(?:m|me)\s*[/，,]/i, '递归 CTE 名不应被当成表');
});
