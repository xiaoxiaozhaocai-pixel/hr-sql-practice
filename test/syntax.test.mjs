/*
 * test/syntax.test.mjs — 新语法卡（syntax_intro）内容与回看接线单测（T20 C 单）
 * 运行：node --test test/syntax.test.mjs
 * 覆盖：五字段非空 / 首现正确且唯一 / 跨段重复不重复出卡 / 同题多卡 /
 *       空壳不渲染 / 示例不泄题 / markSyntaxSeen 幂等且不碰计分字段。
 * 用例名一律 ASCII；存储用内存 stub，不依赖浏览器。
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
const BY_ID = {};
QUESTIONS.forEach((q) => { BY_ID[q.id] = q; });

/* 业务 v2 清单「首现题」列（41 行逐行落卡，学习顺序） */
const EXPECTED = [
  ['IS NULL', 'q001'],
  ['AND / OR 优先级', 'q002'],
  ['ORDER BY 多键', 'q003'],
  ['COUNT(*) / COUNT(列)', 'q002'],
  ['BETWEEN', 'q004'],
  ['IN 列表', 'q005'],
  ["LIKE '%…%'", 'q064'],
  ['ESCAPE', 'q065'],
  ['TRIM', 'q066'],
  ['SUBSTR / LEFT', 'q067'],
  ['COALESCE / IFNULL', 'q068'],
  ['strftime / YEAR()', 'q069'],
  ['DISTINCT', 'q070'],
  ['CASE WHEN', 'q072'],
  ['TOP / LIMIT', 'q073'],
  ['COUNT(DISTINCT)', 'q077'],
  ['GROUP BY', 'q007'],
  ['HAVING', 'q007'],
  ['SUM/AVG/MIN/MAX', 'q010'],
  ['JOIN … ON', 'q007'],
  ['LEFT JOIN', 'q023'],
  ['视图 V_*', 'q013'],
  ['子查询（IN (…)／= (…)）', 'q039'],
  ['EXISTS / NOT EXISTS', 'q014'],
  ['派生表 FROM (SELECT …) t', 'q016'],
  ['UNION / UNION ALL', 'q036'],
  ['EXCEPT', 'q041'],
  ['INTERSECT', 'q046'],
  ['窗口 OVER (…)', 'q018'],
  ['ROW_NUMBER / RANK', 'q018'],
  ['LAG / LEAD', 'q061'],
  ['递归 CTE', 'q055'],
  ['ROLLUP / GROUPING SETS', 'q084'],
  ['日期计算（EOMONTH/date）', 'q079'],
  ['时点快照（在册口径）', 'q100'],
  ['递归 CTE 造日历/月份序列', 'q101'],
  ['拉链式区间匹配', 'q102'],
  ['区间三元分类', 'q103'],
  ['LAG + 日期差（断档/二次雇佣）', 'q104'],
  ['ROW_NUMBER 事件流水', 'q108'],
  ['勾稽核对', 'q110']
];

function allCards() {
  const out = [];
  for (const q of QUESTIONS) {
    if (!Array.isArray(q.syntax_intro)) continue;
    for (const c of q.syntax_intro) out.push({ q: q.id, card: c });
  }
  return out;
}

test('every_syntax_intro_card_passes_validSyntaxItem', () => {
  const cards = allCards();
  assert.equal(cards.length, 41, '全库应落 41 张卡（业务 v2 清单三张表实读行数）');
  for (const { q, card } of cards) {
    const valid = L.validSyntaxItem(card);
    assert.ok(valid, `${q} 的卡必须有 syntax/what/when/example/misuse 五个非空字符串`);
    for (const k of ['syntax', 'what', 'when', 'example', 'misuse']) {
      assert.equal(typeof valid[k], 'string');
      assert.ok(valid[k].trim().length > 0, `${q} ${k} 不得为空`);
    }
  }
});

test('first_occurrence_is_unique_and_matches_the_manifest', () => {
  const cards = allCards();
  /* 每个语法（小写）只能在一道题上落卡 */
  const seenAt = {};
  for (const { q, card } of cards) {
    const key = card.syntax.toLowerCase();
    assert.equal(seenAt[key], undefined, `语法 ${card.syntax} 在 ${q} 之前已在 ${seenAt[key]} 落卡，首现不唯一`);
    seenAt[key] = q;
  }
  /* 落卡题必须与清单「首现题」列一致 */
  assert.equal(new Set(Object.keys(seenAt)).size, EXPECTED.length, '落卡语法数应等于清单行数');
  for (const [syntax, qid] of EXPECTED) {
    assert.equal(seenAt[syntax.toLowerCase()], qid, `${syntax} 的首现题应为 ${qid}`);
  }
  /* 反向：清单里的语法全部落了卡，没有多余语法 */
  const expectedLower = new Set(EXPECTED.map((e) => e[0].toLowerCase()));
  for (const key of Object.keys(seenAt)) assert.ok(expectedLower.has(key), key + ' 不在清单里');
});

test('syntaxIntrosFor_returns_only_first_occurrence_across_sections', () => {
  const map = L.syntaxIntrosFor(QUESTIONS);
  const qids = Object.keys(map).sort();
  assert.equal(qids.length, 37, '首现题共 37 道（q002/q007/q018 各多卡）');
  let total = 0;
  for (const id of qids) total += map[id].length;
  assert.equal(total, 41, '首现卡共 41 张');

  /* 构造：同语法在后续题再次出现 → 只返回首现那道题 */
  const card = (s) => ({ syntax: s, what: 'w', when: 'x', example: 'e', misuse: 'm' });
  const synthetic = [
    { id: 's1', section: 1, seq: 1, syntax_intro: [card('TRIM')] },
    { id: 's2', section: 3, seq: 2, syntax_intro: [card('trim')] },
    { id: 's3', section: 6, seq: 3, syntax_intro: [card('TRIM')] }
  ];
  const m = L.syntaxIntrosFor(synthetic);
  assert.deepEqual(Object.keys(m), ['s1'], '跨段重复只保留首现题');
  assert.equal(m.s1.length, 1);
});

test('same_question_multi_cards_keep_json_order', () => {
  const map = L.syntaxIntrosFor(QUESTIONS);
  assert.deepEqual(map.q002.map((c) => c.syntax), ['AND / OR 优先级', 'COUNT(*) / COUNT(列)']);
  assert.deepEqual(map.q007.map((c) => c.syntax), ['GROUP BY', 'HAVING', 'JOIN … ON']);
  assert.deepEqual(map.q018.map((c) => c.syntax), ['窗口 OVER (…)', 'ROW_NUMBER / RANK']);
  /* 张数与 JSON 内条数、顺序一致 */
  for (const id of ['q002', 'q007', 'q018']) {
    assert.equal(map[id].length, BY_ID[id].syntax_intro.length, id + ' 张数应与 JSON 一致');
    assert.deepEqual(map[id].map((c) => c.syntax), BY_ID[id].syntax_intro.map((c) => c.syntax));
  }
});

test('broken_or_empty_cards_render_nothing', () => {
  const good = { syntax: 'VALID', what: 'w', when: 'x', example: 'e', misuse: 'm' };
  /* 删掉一个字段 → 整张卡作废 */
  const missing = { syntax: 'BROKEN', what: 'w', when: 'x', example: 'e' };
  const map = L.syntaxIntrosFor([{ id: 'x', section: 1, seq: 1, syntax_intro: [missing, good] }]);
  assert.deepEqual(map.x.map((c) => c.syntax), ['VALID'], '缺字段的卡不得渲染');
  assert.deepEqual(L.syntaxIntrosFor([{ id: 'y', section: 1, seq: 1, syntax_intro: [] }]), {}, 'syntax_intro: [] 该题无卡');
  assert.deepEqual(L.syntaxIntrosFor([{ id: 'z', section: 1, seq: 1 }]), {}, '无字段该题无卡');
});

test('no_example_leaks_the_same_question_answer', () => {
  const strip = (s) => String(s || '').replace(/\s+/g, '');
  for (const { q, card } of allCards()) {
    const ex = strip(card.example);
    assert.ok(ex.length > 0);
    assert.notEqual(ex, strip(BY_ID[q].reference_sql), `${q} / ${card.syntax} 的示例不得与 reference_sql 去空白后相同`);
    if (BY_ID[q].reference_sql_sqlite) {
      assert.notEqual(ex, strip(BY_ID[q].reference_sql_sqlite), `${q} / ${card.syntax} 的示例不得与 reference_sql_sqlite 去空白后相同`);
    }
  }
});

test('markSyntaxSeen_is_idempotent_and_never_touches_scoring_fields', () => {
  const state = L.freshState();
  /* 先造出真实分数 / 今日成果 / 尝试记录，验证阅读记录不干扰它们 */
  const fb = L.recordLearningAttempt(state, {
    id: 'q001', kind: 'check', sql: 'SELECT 1', ok: true, stamp: '2026-06-30',
    referenceAvailable: true, execOk: true
  });
  L.creditLearningEvent(state, {
    id: 'q001', kind: 'check', ok: true, correct: true, stamp: '2026-06-30',
    firstTime: fb.firstTime, reviewResolved: fb.reviewResolved, completionType: fb.completionType
  });
  const snap = JSON.parse(JSON.stringify({
    xp: state.xp, passed: state.passed, review: state.learning.review,
    attempts: state.learning.attempts, todayCount: state.todayCount,
    dailyGoal: state.dailyGoal, daily: state.learning.daily
  }));

  assert.equal(L.isSyntaxSeen(state, 'GROUP BY'), false, '未记录前为 false');
  assert.equal(L.markSyntaxSeen(state, 'GROUP BY', '2026-06-30'), true, '首次写入返回 true');
  assert.equal(L.isSyntaxSeen(state, 'GROUP BY'), true);
  assert.equal(state.learning.syntaxSeen['GROUP BY'], '2026-06-30');
  /* 第二次（含换日期）不覆盖、结果一致 → 幂等 */
  assert.equal(L.markSyntaxSeen(state, 'GROUP BY', '2026-07-01'), false, '重复写入返回 false');
  assert.equal(state.learning.syntaxSeen['GROUP BY'], '2026-06-30', '保留首次日期，不被覆盖');

  assert.equal(state.xp, snap.xp, '不加 XP');
  assert.equal(state.todayCount, snap.todayCount, '今日计数不变');
  assert.equal(state.dailyGoal, snap.dailyGoal, '今日目标不变');
  assert.deepEqual(state.passed, snap.passed);
  assert.deepEqual(state.learning.review, snap.review);
  assert.deepEqual(state.learning.attempts, snap.attempts);
  assert.deepEqual(state.learning.daily, snap.daily, 'goalCelebrated 随 daily 原样');
  /* 空 key 不写 */
  assert.equal(L.markSyntaxSeen(state, '   ', '2026-06-30'), false);
  assert.equal(L.isSyntaxSeen(state, ''), false);
});

test('render_layer_wires_seen_button_and_review_toggle', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  assert.match(app, /已看过，开始尝试/, '首现卡必须有确认按钮');
  assert.match(app, /语法回看/, '确认后收起为语法回看');
  assert.match(app, /markSyntaxSeen/, '确认按钮必须调 markSyntaxSeen');
  assert.match(app, /isSyntaxSeen/, '渲染必须读阅读状态');
  assert.match(app, /aria-expanded/, '按钮 / 展开态要有 aria');
  assert.match(app, /aria-controls/);
  assert.match(app, /expandSyntaxCards/, '回看入口要能展开已收起的卡');
});
