/*
 * test/judge.test.mjs — 判题引擎单测（node 原生 test runner，零测试框架依赖）
 * 运行：node --test test/judge.test.mjs
 *
 * 每条用例对应交付自检清单里的一条口径；用例名一律 ASCII。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import judge from '../src/judge.js';

const { judgeResult } = judge;

test('null_versus_zero_and_empty_string', () => {
  assert.equal(judgeResult([[null]], ['a'], [[0]], ['a']).pass, false, 'NULL 与 0 必须不等');
  assert.equal(judgeResult([[null]], ['a'], [['']], ['a']).pass, false, 'NULL 与空串必须不等');
  assert.equal(judgeResult([[null]], ['a'], [[null]], ['a']).pass, true, 'NULL 与 NULL 必须相等');
});

test('numeric_1_equals_1_00', () => {
  const v = judgeResult([[1]], ['a'], [[1.0]], ['a']);
  assert.equal(v.pass, true, '1 与 1.00 必须相等');
  assert.equal(v.columnIssue, null, '列名相同时不应有列名提示');
});

test('numeric_rounding_boundary_1_005', () => {
  // 四舍五入按十进制最短表示逐位进位：1.005 -> 1.01，因此与 1.00 不等、与 1.01 相等
  assert.equal(judgeResult([[1.005]], ['a'], [[1.0]], ['a']).pass, false, '1.005 四舍五入到 1.01，不等于 1.00');
  assert.equal(judgeResult([[1.005]], ['a'], [[1.01]], ['a']).pass, true, '1.005 四舍五入后等于 1.01');
});

test('string_case_and_trim_insensitive', () => {
  assert.equal(judgeResult([['  Alpha ']], ['a'], [['alpha']], ['a']).pass, true);
});

test('row_order_insensitive', () => {
  assert.equal(judgeResult([[1], [2], [3]], ['a'], [[3], [1], [2]], ['a']).pass, true);
});

test('duplicate_row_counts_must_match', () => {
  assert.equal(judgeResult([[1], [1], [2]], ['a'], [[1], [2]], ['a']).pass, false);
});

test('column_count_mismatch_fails', () => {
  const v = judgeResult([[1, 2]], ['a', 'b'], [[1]], ['a']);
  assert.equal(v.pass, false);
  assert.ok(v.columnIssue, '列数不一致必须给出 columnIssue');
  assert.equal(v.columnIssue.kind, 'count');
  assert.match(v.reason, /2/);
  assert.match(v.reason, /1/);
});

test('different_column_names_same_position_passes_with_column_issue', () => {
  const v = judgeResult([[1]], ['x'], [[1]], ['工号']);
  assert.equal(v.pass, true, '列名默认不比，按列序一致即通过');
  assert.equal(v.alignMode, 'position');
  assert.ok(v.columnIssue, '列名与预期不同时必须给提示');
  assert.equal(v.columnIssue.kind, 'name');
});

test('reordered_columns_matched_by_name', () => {
  const v = judgeResult([[2, 1]], ['b', 'a'], [[1, 2]], ['a', 'b']);
  assert.equal(v.pass, true);
  assert.equal(v.alignMode, 'name', '列序不同但列名可匹配时按列名对齐');
  assert.equal(v.columnIssue, null, '列名集合一致时不应有列名提示');
});

test('date_iso_text_compared_literally', () => {
  assert.equal(judgeResult([['2026-06-30']], ['d'], [['2026-06-30']], ['d']).pass, true);
  assert.equal(judgeResult([['2026-6-30']], ['d'], [['2026-06-30']], ['d']).pass, false, '日期按 ISO 文本比较，不转时间戳');
});

test('numeric_string_equals_number', () => {
  assert.equal(judgeResult([['1.00']], ['a'], [[1]], ['a']).pass, true);
});

test('diff_rows_reported_and_capped_at_10', () => {
  const user = [];
  for (let i = 0; i < 15; i++) user.push([i]);
  const v = judgeResult(user, ['a'], [[999]], ['a']);
  assert.equal(v.pass, false);
  assert.equal(v.userRowCount, 15);
  assert.equal(v.refRowCount, 1);
  assert.equal(v.diffRows.length, 10, '差异样例最多 10 条');
  assert.ok(v.diffRows.every((d) => d.kind === 'extra'));
});
