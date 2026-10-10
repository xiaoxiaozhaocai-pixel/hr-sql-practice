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
  assert.equal(s.xp, 30, '离开期间不改 xp / passed');
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
  assert.equal(a.attemptsLeft, 2);
  const b = L.recordLearningAttempt(s, { id: 'q001', kind: 'check', sql: 'SELECT A', ok: false, stamp: '2026-06-30', referenceAvailable: true, execOk: true });
  assert.equal(b.duplicate, true, '同轮同 SQL 重复检查');
  assert.equal(b.showPrevious, true, '返回「展示上次反馈」标记');
  assert.equal(s.learning.attempts.q001.attemptsLeft, 2, '重复检查不重复扣次数');
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
  assert.equal(s.learning.attempts.q001.attemptsLeft, 3, '三次无效检查后次数仍为 3');
  assert.equal(s.learning.review.q001, undefined);
  assert.equal(s.passed.q001, undefined);
});

test('same_question_credits_once_per_day_even_across_multiple_passes', () => {
  const s = L.freshState();
  const p1 = L.recordLearningAttempt(s, checkEv('q001', 1, true, '2026-06-30'));
  const c1 = L.creditLearningEvent(s, Object.assign({}, p1, { stamp: '2026-06-30' }));
  assert.equal(c1.credited, true);
  assert.equal(c1.xpGained, 10);
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

test('xp_is_capped_at_1200_and_first_pass_still_records', () => {
  const s = L.freshState();
  L.ensureLearningDay(s, '2026-06-30');
  s.xp = 1200;
  const p = L.recordLearningAttempt(s, checkEv('q001', 1, true, '2026-06-30'));
  const c = L.creditLearningEvent(s, Object.assign({}, p, { stamp: '2026-06-30' }));
  assert.equal(c.xpGained, 0, '封顶后不再发 XP');
  assert.equal(s.xp, 1200);
  assert.equal(p.firstTime, true, '封顶不影响首次通过记录');
  assert.equal(s.passed.q001, true);
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

test('guided_and_answer_seen_persist_and_guidedReset_restores_attempts', () => {
  const s = L.freshState();
  L.ensureLearningDay(s, '2026-06-30');
  L.recordLearningAttempt(s, { id: 'q001', kind: 'answer', stamp: '2026-06-30' });
  assert.equal(s.learning.attempts.q001.answerSeen, true);
  assert.equal(s.learning.review.q001, undefined, '仅看答案不置 needsFix');
  for (let i = 0; i < 3; i++) {
    L.recordLearningAttempt(s, checkEv('q001', i, false, '2026-06-30'));
  }
  assert.equal(s.learning.attempts.q001.attemptsLeft, 0);
  assert.equal(s.learning.attempts.q001.mode, 'guided', '扣光后进入引导态');
  const g = L.recordLearningAttempt(s, { id: 'q001', kind: 'guidedReset', stamp: '2026-06-30' });
  assert.equal(g.attemptsLeft, 3, '引导态重置回满 3 次');
  assert.equal(g.mode, 'guided', 'mode 仍记有辅助历史');
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
