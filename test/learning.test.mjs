/*
 * test/learning.test.mjs — 学习状态机单测（node 原生 test runner，零框架依赖）
 * 运行：node --test test/learning.test.mjs
 * 覆盖 T16 §七 三类场景：迁移 / 时钟 / 去重，以及每日小组、复查轮次、段进度、多标签页比较。
 * 用例名一律 ASCII；存储用内存 stub，不依赖浏览器。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import L from '../src/levels.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACK = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'data', 'questions.json'), 'utf8'));
const QUESTIONS = PACK.questions;
const SECTIONS = L.buildSections(QUESTIONS);

function checkEv(id, n, ok, day, extra) {
  return Object.assign({
    id: id, kind: 'check', sql: 'SQL-' + id + '-' + n, ok: ok, stamp: day,
    referenceAvailable: true, execOk: true
  }, extra || {});
}

test('exports_all_required_learning_interfaces_and_state_fields', () => {
  ['ensureLearningDay', 'buildDailyPlan', 'nextQuestion', 'beginReview', 'recordLearningAttempt',
    'creditLearningEvent', 'sectionProgress', 'recordWrong', 'recordPass', 'normalizeState', 'isStale']
    .forEach((k) => assert.equal(typeof L[k], 'function', k + ' 必须导出为函数'));
  const s = L.freshState();
  ['attempts', 'review', 'daily', 'activity', 'completions', 'syntaxSeen', 'sectionSummarySeen']
    .forEach((k) => assert.ok(s.learning[k] !== undefined, 'learning.' + k + ' 必须有默认值'));
  assert.equal(s.learning.schemaVersion, 1);
  assert.equal(s.version, 2, '顶层 version:2 保留');
  assert.equal(s.learning.daily.goal, 3);
  assert.equal(s.hearts, 3, 'hearts 字段保留');
  assert.equal(s.streak, 0, 'streak 字段保留');
});

/* ---------------------------- 迁移 ---------------------------- */

test('normalizeState_is_idempotent_on_legacy_state_and_does_not_replay_xp', () => {
  const legacy = {
    version: 2, passed: { q001: true, q002: true }, wrong: { q002: true, q003: true },
    xp: 20, hearts: 2, streak: 3, todayCount: 2, dailyGoal: 3,
    lastDay: '2026-06-29', sql: { q003: 'SELECT 1' }, hintSeen: { q003: 1 }, current: 'q003'
  };
  const a = L.normalizeState(legacy);
  const b = L.normalizeState(a);
  assert.deepEqual(b, a, '相同输入的两次归一化结果必须深度相等（幂等）');
  assert.equal(a.xp, 20, '迁移不重发 XP');
  assert.deepEqual(a.passed, { q001: true, q002: true }, '旧 passed 保留');
  assert.deepEqual(a.sql, { q003: 'SELECT 1' }, '旧草稿保留');
  assert.deepEqual(a.hintSeen, { q003: 1 }, '旧 hintSeen 保留');
});

test('migration_maps_legacy_wrong_and_marks_unknown_completion', () => {
  const a = L.normalizeState({ passed: { q001: true, q002: true }, wrong: { q002: true, q003: true }, xp: 20 });
  assert.equal(a.learning.review.q002.status, 'due', '旧 wrong + 已 passed → due（来自历史错题）');
  assert.equal(a.learning.review.q002.note, '来自历史错题');
  assert.equal(a.learning.review.q003.status, 'needsFix', '旧 wrong + 未 passed → needsFix');
  assert.equal(a.learning.review.q003.dueDay, null, '没有时间记录时不编造上次错误日期');
  assert.equal(a.learning.review.q001, undefined, '已通过且无错题记录 → 不凭空建 review');
  assert.equal(a.learning.completions.q001.completionType, 'unknown', '旧通过不推断为独立完成');
  for (const id of Object.keys(a.passed)) {
    assert.equal(a.passed[id], true, '不因迁移丢失旧通过记录');
  }
});

test('migration_keeps_legacy_today_count_as_history_without_fabricating_ids', () => {
  const a = L.normalizeState({ todayCount: 2, lastDay: '2026-06-29' });
  assert.equal(a.learning.daily.legacyCarry, 2, '升级前已完成 2 项以历史字段保留');
  assert.equal(a.todayCount, 2, '兼容投影仍显示 2，不宣称旧成果消失');
  assert.deepEqual(a.learning.daily.creditedIds, [], '不捏造题号');
  const same = L.normalizeState(a);
  assert.equal(same.todayCount, 2, '重复归一化不双计数');
});

/* ---------------------------- 时钟 ---------------------------- */

test('ensureLearningDay_is_idempotent_and_archives_only_daily_counters', () => {
  const s = L.freshState();
  L.ensureLearningDay(s, '2026-06-30');
  L.recordLearningAttempt(s, { id: 'q001', kind: 'run', sql: 'SELECT 1', ok: true, stamp: '2026-06-30' });
  L.recordLearningAttempt(s, { id: 'q001', kind: 'answer', stamp: '2026-06-30' });
  const p = L.recordLearningAttempt(s, checkEv('q002', 1, true, '2026-06-30'));
  L.creditLearningEvent(s, Object.assign({}, p, { stamp: '2026-06-30' }));
  assert.equal(s.todayCount, 1);
  const before = JSON.stringify(s.learning);
  L.ensureLearningDay(s, '2026-07-01');
  const after = JSON.stringify(s.learning);
  assert.notEqual(before, after, '跨日必须改变 daily.day');
  assert.equal(s.learning.daily.day, '2026-07-01');
  assert.equal(s.learning.daily.creditedIds.length, 0, '跨天 creditedIds 归零');
  assert.equal(s.learning.daily.goalCelebrated, false, '跨天庆祝标记归零');
  assert.equal(s.todayCount, 0, '兼容投影同步归零');
  assert.equal(s.learning.attempts.q001.answerSeen, true, '跨日不得清掉 answerSeen');
  assert.equal(s.sql.q001, 'SELECT 1', '跨日保留草稿');
  assert.equal(s.learning.review.q002, undefined, '干净首次通过不凭空造 review');
  const snapshot = JSON.stringify(s.learning.daily);
  L.ensureLearningDay(s, '2026-07-01');
  L.ensureLearningDay(s, '2026-07-01');
  assert.equal(JSON.stringify(s.learning.daily), snapshot, '同日重复调用幂等');
});

test('midnight_first_commit_belongs_to_the_new_day', () => {
  const s = L.freshState();
  L.ensureLearningDay(s, '2026-06-30');
  const p1 = L.recordLearningAttempt(s, checkEv('q001', 1, true, '2026-06-30'));
  L.creditLearningEvent(s, Object.assign({}, p1, { stamp: '2026-06-30' }));
  assert.equal(s.learning.daily.day, '2026-06-30');
  /* 不显式调用 ensureLearningDay：提交自带新日戳，必须先结算旧日再开新日 */
  const p2 = L.recordLearningAttempt(s, checkEv('q002', 1, true, '2026-07-01'));
  const c2 = L.creditLearningEvent(s, Object.assign({}, p2, { stamp: '2026-07-01' }));
  assert.equal(s.learning.daily.day, '2026-07-01', '午夜后一次提交归新日');
  assert.equal(c2.creditedCount, 1, '新日集合从 1 重新计');
  assert.equal(s.learning.daily.creditedIds.includes('q001'), false, '旧日题号不带到新日');
});

test('active_days_increments_on_yesterday_and_restarts_after_long_gap', () => {
  const s = L.freshState();
  function passNew(id, day) {
    const p = L.recordLearningAttempt(s, checkEv(id, 1, true, day));
    return L.creditLearningEvent(s, Object.assign({}, p, { stamp: day }));
  }
  passNew('q001', '2026-06-30');
  assert.equal(s.learning.activity.activeDays, 1);
  assert.equal(s.learning.activity.lastPracticeDay, '2026-06-30');
  passNew('q002', '2026-07-01');
  assert.equal(s.learning.activity.activeDays, 2, '上次为昨天 → activeDays +1');
  passNew('q003', '2026-07-04');
  assert.equal(s.learning.activity.activeDays, 1, '离开 3 天 → 重新从 1 计');
  assert.equal(s.xp, 0, 'GF1-A：通过不再累计 XP；离开期间不改 passed');
  assert.equal(s.passed.q001 && s.passed.q002 && s.passed.q003, true);
});

/* ---------------------------- 每日小组 ---------------------------- */

test('buildDailyPlan_is_deterministic_and_reentrant_within_the_same_day', () => {
  function stateAt(day) { const s = L.freshState(); L.ensureLearningDay(s, day); return s; }
  const s1 = stateAt('2026-06-30');
  const p1 = L.buildDailyPlan(s1, SECTIONS, '2026-06-30');
  assert.equal(p1.goal, 3, 'goal 默认 3');
  assert.deepEqual(p1.planIds, ['q001', 'q002', 'q003'], '最早到期复查优先，其后按课程顺序补新题');
  const p2 = L.buildDailyPlan(s1, SECTIONS, '2026-06-30');
  assert.deepEqual(p2.planIds, p1.planIds, '同 state 同日重入结果一致');
  assert.equal(p2.goal, p1.goal);
  const s2 = stateAt('2026-06-30');
  const p3 = L.buildDailyPlan(s2, SECTIONS, '2026-06-30');
  assert.deepEqual(p3.planIds, p1.planIds, '相同输入的独立 state 结果一致（不依赖 Math.random）');
});

test('buildDailyPlan_returns_zero_goal_when_nothing_is_eligible', () => {
  const s = L.freshState();
  L.ensureLearningDay(s, '2026-06-30');
  QUESTIONS.forEach((q) => {
    s.passed[q.id] = true;
    s.learning.completions[q.id] = { firstPassDay: '2026-06-30', completionType: 'independent', lastPassDay: '2026-06-30' };
  });
  const p = L.buildDailyPlan(s, SECTIONS, '2026-06-30');
  assert.equal(p.goal, 0, '无合格任务时 goal=0');
  assert.deepEqual(p.planIds, []);
  assert.deepEqual(p.reason, 'no-tasks');
  assert.equal(L.goalMet(s), false, '不伪造复习任务、不显示 0/3 达标');
});

test('buildDailyPlan_pulls_due_review_first_and_respects_course_section_order', () => {
  const s = L.freshState();
  L.ensureLearningDay(s, '2026-06-30');
  s.learning.review.q050 = { status: 'due', dueDay: '2026-06-29', lastErrorKind: 'wrong', note: null, lastIndependentPassDay: null };
  const p = L.buildDailyPlan(s, SECTIONS, '2026-06-30');
  assert.equal(p.planIds[0], 'q050', '到期日最早的复查排第一');
  assert.equal(p.planIds.length, 3);
  assert.equal(p.planIds.includes('q001'), true, '其余按课程顺序补未通过新题');
});

/* ---------------------------- 判分与去重 ---------------------------- */

test('duplicate_check_of_same_sql_in_same_round_does_not_double_charge', () => {
  const s = L.freshState();
  L.ensureLearningDay(s, '2026-06-30');
  const a = L.recordLearningAttempt(s, { id: 'q001', kind: 'check', sql: 'SELECT A', ok: false, stamp: '2026-06-30', referenceAvailable: true, execOk: true });
  assert.equal(a.counted, true);
  assert.equal(a.attemptsLeft, 3, 'GF1-A：判错不扣可用次数');
  assert.equal(a.wrongNo, 1, 'GF1-A：判错只累计供提示分层的次数');
  const b = L.recordLearningAttempt(s, { id: 'q001', kind: 'check', sql: 'SELECT A', ok: false, stamp: '2026-06-30', referenceAvailable: true, execOk: true });
  assert.equal(b.duplicate, true, '同轮同 SQL 重复检查');
  assert.equal(b.showPrevious, true, '返回「展示上次反馈」标记');
  assert.equal(s.learning.attempts.q001.attemptsLeft, 3, '重复检查同样不扣次数');
  assert.equal(s.learning.attempts.q001.round, 1, '不新开作答轮');
});

test('non_effective_check_does_not_charge_attempt_or_touch_review', () => {
  const s = L.freshState();
  L.ensureLearningDay(s, '2026-06-30');
  const empty = L.recordLearningAttempt(s, { id: 'q001', kind: 'check', sql: '   ', ok: false, stamp: '2026-06-30', referenceAvailable: true, execOk: true });
  assert.equal(empty.skipped, true);
  assert.equal(empty.reason, 'empty-sql');
  const exec = L.recordLearningAttempt(s, { id: 'q001', kind: 'check', sql: 'SELECT 1', ok: false, stamp: '2026-06-30', referenceAvailable: true, execOk: false });
  assert.equal(exec.reason, 'sql-error', 'SQL 执行错误不扣次数');
  const pend = L.recordLearningAttempt(s, { id: 'q001', kind: 'check', sql: 'SELECT 2', ok: false, stamp: '2026-06-30', referenceAvailable: true, execOk: true, pendingReview: true });
  assert.equal(pend.skipped, true, '题库待复核不判对错');
  assert.equal(s.learning.attempts.q001.attemptsLeft, 3, 'GF1-A：无效检查不扣次数，判错也不扣');
  assert.equal(s.learning.review.q001, undefined);
  assert.equal(s.passed.q001, undefined);
});

test('same_question_credits_once_per_day_even_across_multiple_passes', () => {
  const s = L.freshState();
  const p1 = L.recordLearningAttempt(s, checkEv('q001', 1, true, '2026-06-30'));
  const c1 = L.creditLearningEvent(s, Object.assign({}, p1, { stamp: '2026-06-30' }));
  assert.equal(c1.credited, true);
  assert.equal(c1.xpGained, 0, 'GF1-A：不再累计 XP');
  assert.equal(s.xp, 0, 'GF1-A：xp 字段保留兼容但不再增长');
  const p2 = L.recordLearningAttempt(s, checkEv('q001', 2, true, '2026-06-30'));
  const c2 = L.creditLearningEvent(s, Object.assign({}, p2, { stamp: '2026-06-30' }));
  assert.equal(p2.firstTime, false);
  assert.equal(c2.xpGained, 0, '重复通过不发 XP');
  assert.equal(c2.credited, false, '同题同日只计 1');
  assert.equal(s.learning.daily.creditedIds.length, 1);
  L.ensureLearningDay(s, '2026-07-01');
  const p3 = L.recordLearningAttempt(s, checkEv('q001', 3, true, '2026-07-01'));
  const c3 = L.creditLearningEvent(s, Object.assign({}, p3, { stamp: '2026-07-01' }));
  assert.equal(c3.credited, false, '已通过题的普通重做不计今日目标');
  assert.equal(s.learning.daily.creditedIds.length, 0);
});

test('legacy_xp_field_is_preserved_but_no_longer_awarded', () => {
  const s = L.freshState();
  L.ensureLearningDay(s, '2026-06-30');
  s.xp = 1200;
  const p = L.recordLearningAttempt(s, checkEv('q001', 1, true, '2026-06-30'));
  const c = L.creditLearningEvent(s, Object.assign({}, p, { stamp: '2026-06-30' }));
  assert.equal(c.xpGained, 0, 'GF1-A：通过不再发 XP');
  assert.equal(s.xp, 1200, '旧存档 xp 字段原样保留');
  assert.equal(p.firstTime, true, '不影响首次通过记录');
  assert.equal(s.passed.q001, true);
  assert.equal(c.credited, true, '仍计入今日已完成集合');
});

/* ---------------------------- 复查轮次 ---------------------------- */

test('review_cycle_goes_needsFix_to_due_then_resolved_without_reward_on_first_day', () => {
  const s = L.freshState();
  L.ensureLearningDay(s, '2026-06-30');
  const w = L.recordLearningAttempt(s, checkEv('q001', 1, false, '2026-06-30'));
  assert.equal(w.counted, true);
  assert.equal(s.learning.review.q001.status, 'needsFix');
  const pass = L.recordLearningAttempt(s, checkEv('q001', 2, true, '2026-06-30'));
  assert.equal(pass.firstTime, true);
  assert.equal(s.learning.review.q001.status, 'due', '有错/跟练的通过 → 重约明日而非当天奖励');
  assert.equal(s.learning.review.q001.dueDay, '2026-07-01');
  const credit = L.creditLearningEvent(s, Object.assign({}, pass, { stamp: '2026-06-30' }));
  assert.equal(credit.credited, true, '首次通过仍计当日集合');
  assert.equal(s.learning.daily.creditedIds.includes('q001'), true);

  L.ensureLearningDay(s, '2026-07-01');
  const b = L.beginReview(s, 'q001', '2026-07-01');
  assert.equal(b.round, 2, '到期复查开启新轮');
  assert.equal(b.attemptsLeft, 3, '新轮次数回满 3');
  assert.equal(b.mode, 'independent');
  assert.equal(b.answerSeen, false);
  const b2 = L.beginReview(s, 'q001', '2026-07-01');
  assert.equal(b2.resumed, true, '刷新继续同一轮，不新开一轮');
  assert.equal(b2.round, 2);
  const rp = L.recordLearningAttempt(s, { id: 'q001', kind: 'check', sql: 'CLEAN', ok: true, stamp: '2026-07-01', referenceAvailable: true, execOk: true });
  assert.equal(rp.reviewResolved, true);
  assert.equal(s.learning.review.q001.status, 'resolved', '到期复查干净通过 → resolved');
  const cr = L.creditLearningEvent(s, Object.assign({}, rp, { stamp: '2026-07-01' }));
  assert.equal(cr.xpGained, 0, '到期复查通过不加 XP');
  assert.equal(cr.credited, true, '计入新日集合');
  assert.equal(s.learning.daily.creditedIds.filter((x) => x === 'q001').length, 1, '同日同题最多计 1');
});

test('guided_and_answer_seen_persist_and_no_longer_force_guided_mode', () => {
  const s = L.freshState();
  L.ensureLearningDay(s, '2026-06-30');
  L.recordLearningAttempt(s, { id: 'q001', kind: 'answer', stamp: '2026-06-30' });
  assert.equal(s.learning.attempts.q001.answerSeen, true);
  assert.equal(s.learning.review.q001, undefined, '仅看答案不置 needsFix');
  for (let i = 0; i < 3; i++) {
    L.recordLearningAttempt(s, checkEv('q001', i, false, '2026-06-30'));
  }
  assert.equal(s.learning.attempts.q001.attemptsLeft, 3, 'GF1-A：判错不扣次数，永远不为 0');
  assert.equal(s.learning.attempts.q001.mode, 'independent', 'GF1-A：判错不再强制转 guided');
  assert.equal(s.learning.attempts.q001.wrongNo, 3, '判错次数只用于提示分层');
  const g = L.recordLearningAttempt(s, { id: 'q001', kind: 'guidedReset', stamp: '2026-06-30' });
  assert.equal(g.attemptsLeft, 3, '引导态兼容入口仍把次数留在 3');
  assert.equal(s.learning.attempts.q001.answerSeen, true, '跟练标记持久到本轮结束');
});

/* ---------------------------- 段进度 / 下一题 ---------------------------- */

test('sectionProgress_reports_needsFix_and_completed_side_by_side', () => {
  const s = L.freshState();
  s.passed.q001 = true;
  s.passed.q002 = true;
  s.learning.review.q003 = { status: 'needsFix', dueDay: null, lastErrorKind: 'wrong', note: null, lastIndependentPassDay: null };
  s.learning.review.q004 = { status: 'due', dueDay: '2026-07-01', lastErrorKind: 'wrong', note: null, lastIndependentPassDay: null };
  const sp = L.sectionProgress(s, SECTIONS);
  const first = sp.sections[0];
  assert.equal(first.section, 1);
  assert.equal(first.total, 20, '分母用该段题数');
  assert.equal(first.passed, 2, '分子用 passed');
  assert.equal(first.needsFix, 1, '待复查与已完成并列');
  assert.equal(first.due, 1);
  assert.equal(first.completed, false);
  const allPassed = L.freshState();
  SECTIONS[0].questions.forEach((q) => { allPassed.passed[q.id] = true; });
  const sp2 = L.sectionProgress(allPassed, SECTIONS);
  assert.equal(sp2.sections[0].completed, true);
  assert.equal(sp2.recommendedSection, 2, '本段全过 → 下一段为默认推荐');
});

test('nextQuestion_walks_sections_in_order_without_numeric_id_inference', () => {
  const s = L.freshState();
  assert.equal(L.nextQuestion(s, SECTIONS, 2).id, 'q006', 'section 2 的第一题是 q006，非数字 id 连续推导');
  s.passed.q006 = true;
  assert.equal(L.nextQuestion(s, SECTIONS, 2).id, 'q007');
  s.current = 'q012';
  assert.equal(L.nextQuestion(s, SECTIONS, 2).id, 'q021', '段内按 seq 继续（section 2 呈 q006..q012 + q021..q033 两段区间）');
  s.current = 'q033';
  assert.equal(L.nextQuestion(s, SECTIONS, 2).id, 'q013', '段末按 section 顺序跳到下一段，不按数字 id 连续性');
});

/* ---------------------------- 多标签页 / 持久化 ---------------------------- */

test('isStale_compares_updated_at_without_merging', () => {
  const older = JSON.stringify({ learning: { updatedAt: '2026-06-30T00:00:00.000Z' } });
  const newer = JSON.stringify({ learning: { updatedAt: '2026-07-01T00:00:00.000Z' } });
  assert.equal(L.isStale(newer, older), true);
  assert.equal(L.isStale(older, newer), false);
  assert.equal(L.isStale(newer, null), true);
  assert.equal(L.isStale('{bad json', older), false, '坏 JSON 不误报');
});

test('saveState_marks_memoryOnly_on_failure_and_clears_on_success', () => {
  const s = L.freshState();
  const bad = { setItem() { throw new Error('quota exceeded'); } };
  assert.equal(L.saveState(bad, s), false);
  assert.equal(s.learning.persistence, 'memoryOnly', '保存失败标记「仅本次有效」');
  const good = { setItem() {} };
  assert.equal(L.saveState(good, s), true);
  assert.equal(s.learning.persistence, 'persisted', '下次成功解除标记');
});

/* ---------------------------- 每日换题（T17） ---------------------------- */

const ORDER = SECTIONS.reduce((acc, sec) => acc.concat(sec.questions.map((q) => q.id)), []);
const DAY = '2026-06-30';
const snapshot = (s) => JSON.parse(JSON.stringify(s));

test('replacePlanItem_swaps_one_unfinished_item_in_place', () => {
  const s = L.freshState();
  L.ensureLearningDay(s, DAY);
  const p = L.buildDailyPlan(s, SECTIONS, DAY);
  assert.deepEqual(p.planIds, ORDER.slice(0, 3), '默认计划按课程顺序取前 3');
  const att = L.recordLearningAttempt(s, checkEv(ORDER[0], 1, true, DAY));
  L.creditLearningEvent(s, Object.assign({}, att, { stamp: DAY }));
  const creditedBefore = s.learning.daily.creditedIds.slice();

  const r = L.replacePlanItem(s, ORDER[2], { sections: SECTIONS });
  assert.equal(r.replaced, true);
  assert.equal(r.fromId, ORDER[2]);
  assert.equal(r.reason, 'replaced');
  assert.equal(r.toId, ORDER[3], '候选池排除计划内其余项后取下一题');
  assert.deepEqual(s.learning.daily.planIds, [ORDER[0], ORDER[1], ORDER[3]], '长度不变且保持原位置');
  assert.equal(s.learning.daily.planIds.filter((id) => id === r.toId).length, 1, '新 id 不与其余项重复');
  assert.deepEqual(s.learning.daily.creditedIds, creditedBefore, '已计数成果不动');
  assert.equal(s.learning.daily.goal, p.goal, 'goal 不动');
});

test('replacePlanItem_refuses_credited_item_without_mutating_state', () => {
  const s = L.freshState();
  L.ensureLearningDay(s, DAY);
  L.buildDailyPlan(s, SECTIONS, DAY);
  const att = L.recordLearningAttempt(s, checkEv(ORDER[0], 1, true, DAY));
  L.creditLearningEvent(s, Object.assign({}, att, { stamp: DAY }));
  assert.equal(s.learning.daily.creditedIds.includes(ORDER[0]), true, '前置：该题已计数');
  const before = snapshot(s);
  const r = L.replacePlanItem(s, ORDER[0], { sections: SECTIONS });
  assert.deepEqual(r, { replaced: false, fromId: ORDER[0], toId: null, reason: 'already-credited' });
  assert.deepEqual(snapshot(s), before, '被拒时 state 一个字节都不改');
});

test('replacePlanItem_reports_no_candidate_when_nothing_else_is_eligible', () => {
  const s = L.freshState();
  L.ensureLearningDay(s, DAY);
  ORDER.forEach((id) => {
    if (id === ORDER[0]) return;
    s.passed[id] = true;
    s.learning.completions[id] = { firstPassDay: DAY, completionType: 'independent', lastPassDay: DAY };
  });
  const p = L.buildDailyPlan(s, SECTIONS, DAY);
  assert.deepEqual(p.planIds, [ORDER[0]], '全库仅剩该题未完成');
  const before = snapshot(s);
  const r = L.replacePlanItem(s, ORDER[0], { sections: SECTIONS });
  assert.deepEqual(r, { replaced: false, fromId: ORDER[0], toId: null, reason: 'no-candidate' });
  assert.deepEqual(snapshot(s), before, '凑不满也不塞不可用题 / 不宣告达标');
  assert.equal(L.goalMet(s), false);
});

test('buildDailyPlan_honours_unavailableIds_and_lowers_goal_with_adjusted_reason', () => {
  const blocked = ORDER.slice(0, 4);
  const sA = L.freshState();
  L.ensureLearningDay(sA, DAY);
  const pA = L.buildDailyPlan(sA, SECTIONS, DAY, { unavailableIds: blocked });
  assert.equal(pA.goal, 3, '仍有足够可用题时不降目标');
  assert.deepEqual(pA.planIds, ORDER.slice(4, 7), '不可用题一律不进计划');
  assert.equal(blocked.some((id) => pA.planIds.includes(id)), false);
  assert.equal(pA.adjusted, undefined, '未降目标不给 adjusted');

  const sB = L.freshState();
  L.ensureLearningDay(sB, DAY);
  const blockedB = ORDER.slice(2);
  const pB = L.buildDailyPlan(sB, SECTIONS, DAY, { unavailableIds: blockedB });
  assert.deepEqual(pB.planIds, ORDER.slice(0, 2));
  assert.equal(pB.goal, 2, '凑不满时降低当天 goal');
  assert.equal(pB.reason, 'reduced');
  assert.ok(pB.adjusted, '必须给出 adjusted');
  assert.equal(pB.adjusted.goal, 2);
  assert.equal(typeof pB.adjusted.reason, 'string');
  assert.ok(pB.adjusted.reason.length > 0, 'adjusted.reason 可渲染且非空');
  assert.equal(pB.adjusted.reason.includes(String(blockedB.length)), true, 'reason 点明待复核题数');
});

test('replacePlanItem_is_idempotent_for_the_same_question', () => {
  const s = L.freshState();
  L.ensureLearningDay(s, DAY);
  L.buildDailyPlan(s, SECTIONS, DAY);
  const r1 = L.replacePlanItem(s, ORDER[2], { sections: SECTIONS });
  assert.equal(r1.replaced, true);
  const after = snapshot(s);
  const r2 = L.replacePlanItem(s, ORDER[2], { sections: SECTIONS });
  assert.deepEqual(r2, { replaced: false, fromId: ORDER[2], toId: null, reason: 'not-in-plan' });
  assert.equal(r2.replaced, false, '第二次不再替换');
  assert.deepEqual(snapshot(s), after, '第二次调用 state 深度相等');
});

/* ---------------------------- 段末结算（T19 / B2） ---------------------------- */

function passWholeSection(state, sec, day) {
  sec.questions.forEach((q) => {
    state.passed[q.id] = true;
    state.learning.completions[q.id] = { firstPassDay: day, completionType: 'independent', lastPassDay: day };
  });
}

test('sectionTransition_reports_completion_only_when_the_whole_section_passed', () => {
  const sec = SECTIONS[0];
  const last = sec.questions[sec.questions.length - 1].id;
  const s = L.freshState();
  L.ensureLearningDay(s, DAY);
  passWholeSection(s, { section: sec.section, questions: sec.questions.slice(0, -1) }, DAY);

  const mid = L.sectionTransition(s, SECTIONS, sec.questions[0].id);
  assert.equal(mid.completed, false, '最后一题未过时不算整段完成');
  assert.equal(mid.passed, sec.questions.length - 1);
  assert.equal(mid.section, sec.section);

  s.passed[last] = true;
  s.learning.completions[last] = { firstPassDay: DAY, completionType: 'independent', lastPassDay: DAY };
  const done = L.sectionTransition(s, SECTIONS, last);
  assert.equal(done.completed, true, '全段 passed 才算完成');
  assert.equal(done.passed, done.total);
  assert.equal(done.isLastSection, false, '第 1 段不是末段');
  assert.equal(typeof done.nextSection, 'number', '存在下一段');
  assert.ok(done.nextFirstQuestion, '下一段要给出第一题入口');
  assert.ok(done.keyPoints.length > 0 && done.keyPoints.length <= 3, '主要考点最多三个');
});

test('sectionTransition_marks_first_shown_once_and_never_rewards_xp', () => {
  const sec = SECTIONS[0];
  const s = L.freshState();
  L.ensureLearningDay(s, DAY);
  passWholeSection(s, sec, DAY);
  const xpBefore = s.xp;

  const first = L.sectionTransition(s, SECTIONS, sec.questions[0].id);
  assert.equal(first.firstShown, true, '首次展示');
  assert.equal(L.markSectionSummarySeen(s, sec.section), true, '首次标记成功');
  assert.equal(L.markSectionSummarySeen(s, sec.section), false, '重复标记返回 false');

  const again = L.sectionTransition(s, SECTIONS, sec.questions[0].id);
  assert.equal(again.completed, true, '旧用户仍可回看总结');
  assert.equal(again.firstShown, false, '回看不再首次庆祝');
  assert.equal(s.xp, xpBefore, '段末结算与标记都不重发 XP');
});

test('sectionTransition_splits_unseen_answer_and_guided_completions', () => {
  const sec = SECTIONS[0];
  const s = L.freshState();
  L.ensureLearningDay(s, DAY);
  passWholeSection(s, sec, DAY);
  s.learning.completions[sec.questions[0].id].completionType = 'guided';
  s.learning.review[sec.questions[1].id] = { status: 'due', dueDay: DAY, lastErrorKind: null, note: null, lastIndependentPassDay: null };
  s.learning.review[sec.questions[2].id] = { status: 'needsFix', dueDay: null, lastErrorKind: null, note: null, lastIndependentPassDay: null };

  const t = L.sectionTransition(s, SECTIONS, sec.questions[0].id);
  assert.equal(t.guided, 1, '跟练完成单独计数');
  assert.equal(t.unseenAnswer, sec.questions.length - 1, '其余为未看完整答案完成');
  assert.equal(t.due, 1);
  assert.deepEqual(t.dueIds, [sec.questions[1].id]);
  assert.equal(t.needsFix, 1, '待修正与待复查并列展示');
});

test('sectionTransition_last_section_carries_course_totals_and_has_no_next', () => {
  const sec = SECTIONS[SECTIONS.length - 1];
  const s = L.freshState();
  L.ensureLearningDay(s, DAY);
  passWholeSection(s, sec, DAY);

  const t = L.sectionTransition(s, SECTIONS, sec.questions[0].id);
  assert.equal(t.isLastSection, true);
  assert.equal(t.nextSection, null);
  assert.equal(t.nextFirstQuestion, null, '不寻找不存在的下一题');
  assert.equal(t.course.total, ORDER.length, '末段带全库题数');
  assert.equal(t.course.passed, sec.questions.length, '只统计已通过的题');
  assert.equal(t.course.dueIds.length, t.course.due);
});

test('sectionTransition_returns_null_for_unknown_question_or_empty_sections', () => {
  const s = L.freshState();
  assert.equal(L.sectionTransition(s, SECTIONS, 'q999'), null);
  assert.equal(L.sectionTransition(s, SECTIONS, null), null);
  assert.equal(L.sectionTransition(s, [], 'q001'), null);
  assert.equal(L.markSectionSummarySeen(s, null), false, '空段号不标记');
});
