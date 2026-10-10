/*
 * test/gate.test.mjs — tools/verify-expected.mjs 闸门守门单测
 * 运行：node --test test/gate.test.mjs
 *
 * 锁住两条口径：
 *   1) expected.row_count === null / 缺失 = 「未声明行数」，跳过行数对账（不得误判 FAIL）；
 *      但显式数字 row_count 仍须对账（闸门不能被改空）。
 *   2) 契约「忽略未知字段」：题库题级 / expected 内出现未知字段不得影响闸门结论。
 *
 * 做法：在 os.tmpdir() 现场生成 1 题最小 fixture，用 spawnSync 跑真实闸门脚本。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

/* 现场生成 1 题 fixture 题库并跑闸门，返回 { status, stdout } */
function runGate(question) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-sql-gate-'));
  const fixturePath = path.join(dir, 'questions.json');
  try {
    fs.writeFileSync(fixturePath, JSON.stringify({ questions: [question] }), 'utf8');
    const r = spawnSync('node', [path.join(ROOT, 'tools', 'verify-expected.mjs'), fixturePath], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    return { status: r.status, stdout: (r.stdout || '') + (r.stderr || '') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const baseQuestion = () => ({
  id: 'gate001',
  reference_sql_sqlite: 'SELECT 1 AS a;',
  expected: { columns: ['a'], row_count: null, rows: [[1]] },
});

test('row_count_null_is_treated_as_undeclared_and_passes', () => {
  const { status, stdout } = runGate(baseQuestion());
  assert.equal(status, 0, `期望退出码 0，实际 ${status}\n--- stdout ---\n${stdout}`);
  assert.match(stdout, /FAIL=0/, `期望 stdout 含 FAIL=0\n--- stdout ---\n${stdout}`);
});

test('numeric_row_count_is_still_enforced', () => {
  const q = baseQuestion();
  q.expected.row_count = 999;
  const { status, stdout } = runGate(q);
  assert.equal(status, 1, `期望退出码 1，实际 ${status}\n--- stdout ---\n${stdout}`);
  assert.match(stdout, /FAIL=1/, `期望 stdout 含 FAIL=1\n--- stdout ---\n${stdout}`);
});

test('unknown_fields_are_ignored', () => {
  const q = baseQuestion();
  q.expected.row_count = 1;
  q.zz_unknown_probe = { nested: { deep: [1, 2, { k: 'v' }] }, list: [{ x: 1 }] };
  q.expected.zz_unknown_probe = { any: ['a', { b: 2 }] };
  const { status, stdout } = runGate(q);
  assert.equal(status, 0, `期望退出码 0，实际 ${status}\n--- stdout ---\n${stdout}`);
  assert.match(stdout, /FAIL=0/, `期望 stdout 含 FAIL=0\n--- stdout ---\n${stdout}`);
});
