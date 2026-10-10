/*
 * test/tables.test.mjs — 表结构速查模块单测（node 原生 test runner，零框架依赖）
 * 运行：node --test test/tables.test.mjs
 *
 * 覆盖任务卡 §5.3 的三组：题目 -> 表的映射 / 表结构构建 / 无数据行。
 * 关键：字段定义同时从 docs/data-model-v1.md 解析出来做交叉比对，
 *       保证 src/tables.js 与权威人读版数据模型不漂移。
 * 用例名一律 ASCII。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import HRTables from '../src/tables.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const PACK = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'questions.json'), 'utf8'));
const MODEL = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'model-notes-v1.json'), 'utf8'));
const MODEL_MD = fs.readFileSync(path.join(ROOT, 'docs', 'data-model-v1.md'), 'utf8');
const TABLES_SRC = fs.readFileSync(path.join(ROOT, 'src', 'tables.js'), 'utf8');

/* 解析 docs/data-model-v1.md 的 “### 2.N `表名`” 小节，抽出字段表中「字段」一列的非空值。 */
function parseModelMarkdown(md) {
  const out = {};
  const blocks = md.split(/^### /m);
  for (const block of blocks) {
    const head = block.match(/^2\.\d+\s+`([A-Z_]+)`/);
    if (!head) continue;
    const fields = [];
    const lines = block.split(/\r?\n/);
    let inTable = false;
    for (const line of lines) {
      const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      if (cells.length < 4) continue;
      if (cells[0] === '字段') { inTable = true; continue; }
      if (/^-+$/.test(cells[0])) continue;
      if (!inTable) continue;
      fields.push(cells[0].replace(/`/g, ''));
    }
    out[head[1]] = fields;
  }
  return out;
}

test('model_notes_questions_map_to_their_own_seqs_with_nonempty_tables', () => {
  const map = HRTables.questionTableMap(MODEL.questions);
  assert.equal(Object.keys(map).length, MODEL.questions.length, 'model-notes 必须覆盖自身全部条目');
  const seqs = MODEL.questions.map((q) => q.id).sort((a, b) => a - b);
  assert.deepEqual(seqs, Array.from({ length: MODEL.questions.length }, (_, i) => i + 1), 'model-notes seq 必须连续 1..N');
  for (const q of MODEL.questions) {
    const tables = HRTables.tablesForSeq(MODEL.questions, q.id);
    assert.ok(Array.isArray(tables) && tables.length > 0, `seq=${q.id} 的 tables 必须非空`);
    for (const name of tables) {
      assert.ok(HRTables.getTable(name), `seq=${q.id} 引用了未知表 ${name}`);
    }
  }
  /* id === seq 是任务卡的硬映射 */
  for (const q of MODEL.questions) {
    assert.equal(q.id, Number(PACK.questions[q.id - 1].id.slice(1)), `id=${q.id} 必须对应 q0${q.id}`);
  }
});

test('builds_11_tables_with_field_details', () => {
  const tables = HRTables.allTables();
  assert.equal(tables.length, 11, '必须是 11 张表');
  const counts = {};
  for (const t of tables) {
    assert.ok(t.name && t.cn_name && t.role, `${t.name} 缺表级说明`);
    assert.ok(Array.isArray(t.fields) && t.fields.length > 0, `${t.name} 必须至少 1 个字段`);
    for (const f of t.fields) {
      assert.ok(f.name && f.type, `${t.name}.${f.name} 缺字段名或类型`);
      assert.equal(typeof f.nullable, 'boolean', `${t.name}.${f.name} 可空必须是布尔`);
      assert.ok(typeof f.note === 'string' && f.note.length > 0, `${t.name}.${f.name} 缺业务含义`);
    }
    counts[t.name] = t.fields.length;
  }
  /* 与 docs/data-model-v1.md 逐表逐字段比对（名字 + 顺序） */
  const md = parseModelMarkdown(MODEL_MD);
  assert.equal(Object.keys(md).length, 11, 'markdown 必须解析出 11 张表');
  for (const t of tables) {
    assert.deepEqual(md[t.name], t.fields.map((f) => f.name), `${t.name} 字段必须与 data-model-v1.md 完全一致`);
  }
  /* 中文名与 model-notes 对齐 */
  const cnByName = Object.fromEntries(MODEL.tables.map((t) => [t.name, t.cn_name]));
  for (const t of tables) {
    assert.equal(t.cn_name, cnByName[t.name], `${t.name} 中文名必须与 model-notes 一致`);
  }
  /* 字段数实测（本断言记录真实口径） */
  assert.deepEqual(counts, {
    HR_ORG: 12,
    HR_JOB: 5,
    HR_POSITION: 7,
    HR_EMPLOYEE: 12,
    HR_ASSIGNMENT: 10,
    HR_SALARY: 11,
    HR_ATTENDANCE: 9,
    HR_RECRUIT_REQ: 9,
    HR_CANDIDATE: 10,
    HR_PERFORMANCE: 8,
    HR_DICT: 7
  });
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 100, '11 表字段合计 100');
});

test('three_views_are_listed_without_field_details', () => {
  const views = HRTables.allViews();
  assert.deepEqual(views.map((v) => v.name), ['V_ORG_TREE', 'V_EMP_ASSIGNMENT', 'V_ORG_HEADCOUNT']);
  for (const v of views) {
    assert.ok(v.purpose && v.purpose.length > 0, `${v.name} 必须有作用说明`);
    assert.equal(v.fields, undefined, `${v.name} 不应带字段明细`);
  }
});

test('structure_data_contains_no_data_rows', () => {
  const blob = JSON.stringify({ tables: HRTables.allTables(), views: HRTables.allViews() });
  assert.doesNotMatch(blob, /INSERT\s+INTO/i, '表结构数据不得含 INSERT 语句');
  assert.doesNotMatch(blob, /\bVALUES\s*\(/i, '表结构数据不得含 VALUES 行');
  assert.doesNotMatch(blob, /https?:\/\//i, '表结构数据不得含外部 URL');
  assert.doesNotMatch(TABLES_SRC, /INSERT\s+INTO/i, 'src/tables.js 源码不得含 INSERT 语句');
  /* 结构字段对象只允许 name/type/nullable/note 四个键，不得夹带取值字段 */
  for (const t of HRTables.allTables()) {
    for (const f of t.fields) {
      assert.deepEqual(Object.keys(f).sort(), ['name', 'note', 'nullable', 'type'], `${t.name}.${f.name} 夹带了非结构字段`);
    }
  }
  assert.doesNotMatch(TABLES_SRC, /\brequire\s*\(/, 'src/tables.js 不得读文件 / 引依赖');
});

test('search_matches_table_name_and_field_name', () => {
  const byTable = HRTables.searchTables('assignment');
  assert.equal(byTable.length, 1);
  assert.equal(byTable[0].table.name, 'HR_ASSIGNMENT');
  const byField = HRTables.searchTables('NetPay');
  assert.equal(byField.length, 1);
  assert.deepEqual(byField[0].matchedFields, ['NetPay']);
  assert.equal(HRTables.searchTables('不存在的关键字').length, 0);
  assert.equal(HRTables.searchTables('').length, 11, '空关键字返回全部 11 表');
  assert.equal(HRTables.fieldCount('HR_EMPLOYEE'), 12);
  assert.deepEqual(HRTables.fieldNames('HR_JOB').length, 5);
  assert.equal(HRTables.getTable('hr_org').name, 'HR_ORG', '表名查询不区分大小写');
  assert.equal(HRTables.getTable('NOPE'), null);
});
