/*
 * tools/verify-expected.mjs — 独立权威库复核：用真实 sql.js 重建 data/schema_sqlite.sql + data/seed_sqlite.sql，
 * 逐题跑 reference_sql_sqlite，与 data/questions.json 的 expected 对账。
 *
 * 与判题层互补：判题只比学员结果与 expected；本脚本比「参考 SQL 真跑结果」与 expected，
 * 用来抓「题库自相矛盾」「数据重建后答案漂移」这类问题（q031 整除截断就是这样抓出来的）。
 *
 * 比对口径：
 *   1) 采样题（expected.rows 少于 row_count，实为「结果前 N 行」样本）：按序前缀比对（本库 9 题）。
 *   2) order_sensitive=true：逐行比序，并核对参考 SQL 确实带 ORDER BY。
 *   3) 其余题：集合比对（列名不比对，与判题口径一致）。
 *
 * 用法：npm run verify   （失败时退出码 1）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from '../vendor/sqljs/sql-wasm.js';
import '../src/db.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HRDb = globalThis.HRDb;
const schemaSql = fs.readFileSync(path.join(ROOT, 'data', 'schema_sqlite.sql'), 'utf8');
const seedSql = fs.readFileSync(path.join(ROOT, 'data', 'seed_sqlite.sql'), 'utf8');
const wasm = fs.readFileSync(path.join(ROOT, 'vendor', 'sqljs', 'sql-wasm.wasm')).toString('base64');
const questionsPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'data', 'questions.json');
const qs = JSON.parse(fs.readFileSync(questionsPath, 'utf8')).questions;

const SQL = await initSqlJs({ wasmBinary: HRDb.base64ToArrayBuffer(wasm) });
const build = () => { const d = new SQL.Database(); d.run(schemaSql); d.run(seedSql); return d; };
const norm = (v) => v === null || v === undefined ? '<NULL>'
  : typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6) : String(v).replace(/\s+$/, '');
const key = (row) => row.map(norm).join('|');

let pass = 0;
const fails = [];
const samples = [];
const osChecked = [];
const noSql = [];

for (const q of qs) {
  const sql = q.reference_sql_sqlite;
  if (!sql) { noSql.push(q.id); continue; }
  const exp = q.expected || {};
  const expRows = exp.rows || [];
  let res;
  try {
    res = HRDb.runQuery(build(), sql);
  } catch (e) {
    fails.push({ id: q.id, why: 'SQL_ERROR ' + String(e.message).slice(0, 140) });
    continue;
  }
  const R = res.rows.map(key);
  const probs = [];

  if (exp.columns && res.columns.length !== exp.columns.length) {
    probs.push('column_count got ' + res.columns.length + ' want ' + exp.columns.length);
  }
  if (typeof exp.row_count === 'number' && R.length !== exp.row_count) {
    probs.push('row_count got ' + R.length + ' want ' + exp.row_count);
  }
  if (typeof exp.row_count === 'number' && expRows.length > exp.row_count) {
    probs.push('expected.rows 比 row_count 还多');
  }

  const isSample = expRows.length < (exp.row_count ?? expRows.length);
  if (isSample) {
    samples.push(q.id);
    for (let i = 0; i < expRows.length; i++) {
      if (R[i] !== key(expRows[i])) {
        probs.push('prefix@row' + (i + 1) + ' got[' + R[i] + '] want[' + key(expRows[i]) + ']');
        break;
      }
    }
  } else if (expRows.length > 0 && R.length === expRows.length) {
    const E = expRows.map(key);
    if (exp.order_sensitive) {
      osChecked.push(q.id);
      if (!/\bORDER\s+BY\b/i.test(sql)) probs.push('order_sensitive=true 但参考 SQL 无 ORDER BY');
      for (let i = 0; i < R.length; i++) {
        if (R[i] !== E[i]) { probs.push('order@row' + (i + 1) + ' got[' + R[i] + '] want[' + E[i] + ']'); break; }
      }
    } else {
      const a = [...R].sort(), b = [...E].sort();
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) { probs.push('row_content got[' + a[i] + '] want[' + b[i] + ']'); break; }
      }
    }
  } else if (expRows.length > 0) {
    probs.push('rows_len got ' + R.length + ' want ' + expRows.length + '（既非全量也非前缀样本，需人工看）');
  }

  if (probs.length) fails.push({ id: q.id, why: probs.join(' ; ') }); else pass++;
}

console.log('TOTAL=' + qs.length + ' CHECKED=' + (qs.length - noSql.length) + ' PASS=' + pass + ' FAIL=' + fails.length);
console.log('NO_SQLITE_REF=[' + noSql.join(',') + ']');
console.log('ORDER_SENSITIVE_CHECKED=' + osChecked.length + ' (含采样题)');
console.log('SAMPLE_PREFIX_CHECKED=' + samples.length + ' [' + samples.join(',') + ']');
if (fails.length) {
  console.log('--- FAILS (max 40) ---');
  for (const f of fails.slice(0, 40)) console.log(f.id + ' :: ' + f.why);
  process.exit(1);
}
console.log('--- OK: 参考 SQL 真跑结果与 expected 全部一致 ---');
