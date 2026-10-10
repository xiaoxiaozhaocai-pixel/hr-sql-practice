/*
 * test/db.test.mjs — src/db.js 建库 / 跑查询的收口测试
 * ---------------------------------------------------------------------------
 * 用真实 vendor sql.js + 真实 schema_sqlite.sql / seed_sqlite.sql 建库，单进程可跑：
 *   node test/db.test.mjs          （本仓 npm test 尚未包含本文件，见汇报待验收清单）
 * 覆盖：A 参考库隔离 / B 行数上限 / C 工作量实测 / D 空结果保留列名。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from '../vendor/sqljs/sql-wasm.js';
import '../src/db.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HRDb = globalThis.HRDb;

const schemaSql = fs.readFileSync(path.join(ROOT, 'data/schema_sqlite.sql'), 'utf8');
const seedSql = fs.readFileSync(path.join(ROOT, 'data/seed_sqlite.sql'), 'utf8');
const wasmBase64 = fs.readFileSync(path.join(ROOT, 'vendor/sqljs/sql-wasm.wasm')).toString('base64');
const questions = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/questions.json'), 'utf8')).questions;
const q006 = questions.find((q) => q.id === 'q006');
const q006Sql = q006.reference_sql_sqlite;

let SQL = null;
async function freshPair() {
  if (!SQL) SQL = await initSqlJs({ wasmBinary: HRDb.base64ToArrayBuffer(wasmBase64) });
  function build() {
    const d = new SQL.Database();
    d.run(schemaSql);
    d.run(seedSql);
    return d;
  }
  return { db: build(), refDb: build() };
}

test('A_reference_db_isolated_from_user_writes', async () => {
  const { db, refDb } = await freshPair();
  const before = HRDb.runQuery(refDb, q006Sql).rows;
  assert.deepEqual(before, [[200, 197, 170]], 'q006 基准初始值');

  HRDb.runQuery(db, 'UPDATE HR_EMPLOYEE SET Mobile = NULL');

  const userAfter = HRDb.runQuery(db, q006Sql).rows;
  const refAfter = HRDb.runQuery(refDb, q006Sql).rows;
  assert.deepEqual(userAfter, [[200, 197, 0]], '反证：用户库确实被写坏');
  assert.deepEqual(refAfter, [[200, 197, 170]], '参考库不受用户写操作影响');
});

test('B_row_cap_truncates_and_flags', async () => {
  const { db } = await freshPair();
  const res = HRDb.runQuery(db, 'SELECT a.Code, b.Code FROM HR_DICT a, HR_DICT b');
  assert.equal(HRDb.MAX_ROWS, 1000);
  assert.equal(res.rows.length, HRDb.MAX_ROWS, 'rows 截断到上限');
  assert.equal(res.truncated, true, 'truncated 标记为真');

  const small = HRDb.runQuery(db, 'SELECT EmpNo FROM HR_EMPLOYEE');
  assert.equal(small.rows.length, 200);
  assert.equal(small.truncated, false, '未超限不置标记');
});

test('C_heavy_cross_join_count_completes', async () => {
  const { db } = await freshPair();
  const t0 = Date.now();
  const res = HRDb.runQuery(db, 'SELECT COUNT(*) FROM HR_SALARY a, HR_SALARY b');
  const ms = Date.now() - t0;
  console.log('[C] COUNT(*) cross join HR_SALARY x HR_SALARY =', res.rows[0][0], 'rows, elapsed_ms =', ms);
  assert.deepEqual(res.rows, [[1868 * 1868]]);
  assert.ok(ms < 10000, '重查询应在 10s 内返回，实测 ' + ms + 'ms');
});

test('D_empty_result_keeps_column_names', async () => {
  const { db } = await freshPair();
  const res = HRDb.runQuery(db, 'SELECT EmpNo, EmpName FROM HR_EMPLOYEE WHERE 1 = 0');
  assert.deepEqual(res.columns, ['EmpNo', 'EmpName']);
  assert.deepEqual(res.rows, []);
  assert.equal(res.truncated, false);
});

test('multi_statement_keeps_last_result_set', async () => {
  const { db } = await freshPair();
  const res = HRDb.runQuery(db, "UPDATE HR_EMPLOYEE SET IsActive = 9 WHERE EmpNo = '10002';\nSELECT EmpNo, IsActive FROM HR_EMPLOYEE WHERE EmpNo = '10002';");
  assert.deepEqual(res.columns, ['EmpNo', 'IsActive']);
  assert.deepEqual(res.rows, [['10002', 9]]);
});
