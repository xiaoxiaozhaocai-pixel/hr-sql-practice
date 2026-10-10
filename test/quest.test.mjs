/*
 * test/quest.test.mjs — 关卡编排 + 游戏化状态机单测（node 原生 test runner，零框架依赖）
 * 运行：node --test test/quest.test.mjs
 *
 * 覆盖任务卡 §9.2 要求的六组：分段 / 通关判定 / XP / 连胜 / 跨天 / localStorage 往返。
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

function memStorage(seed) {
  const map = new Map(seed ? Object.entries(seed) : []);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _dump: () => Object.fromEntries(map)
  };
}

test('sections_partition_question_bank_into_6_with_counts_20_20_20_18_21_21', () => {
  const sections = L.buildSections(QUESTIONS);
  assert.equal(sections.length, 6, '题库必须正好分成 6 段');
  assert.deepEqual(sections.map((s) => s.section), [1, 2, 3, 4, 5, 6], '段按 section 升序');
  assert.deepEqual(sections.map((s) => s.questions.length), [20, 20, 20, 18, 21, 21], '各段关数 20/20/20/18/21/21');
  assert.deepEqual(
    sections.map((s) => s.title),
    ['入门 · 单表查询', '进阶 · 分组与多表', '实战 · 子查询与口径',
      '挑战 · 时点与进阶', '综合 · 报表与汇总', '时点 · 历史与口径']
  );
  for (const s of sections) {
    const seqs = s.questions.map((q) => q.seq);
    const sorted = seqs.slice().sort((a, b) => a - b);
    assert.deepEqual(seqs, sorted, `第 ${s.section} 段段内必须按 seq 升序`);
    for (const q of s.questions) assert.equal(q.section, s.section);
  }
  const allIds = sections.flatMap((s) => s.questions.map((q) => q.id));
  assert.equal(allIds.length, QUESTIONS.length, '编排结果必须覆盖题库全部题目');
  assert.equal(new Set(allIds).size, QUESTIONS.length, '关卡不重不漏');
});

test('question_bank_has_120_questions_with_contiguous_seq_1_to_120', () => {
  assert.equal(QUESTIONS.length, 120, '题库必须为 120 题');
  const seqs = QUESTIONS.map((q) => q.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, Array.from({ length: 120 }, (_, i) => i + 1), 'seq 必须连续 1..120');
  const ids = QUESTIONS.map((q) => q.id).sort();
  assert.deepEqual(ids, Array.from({ length: 120 }, (_, i) => 'q' + String(i + 1).padStart(3, '0')), 'id 必须连续无缺无重');
});

test('wrong_answer_decrements_attempts_and_marks_review_needsFix', () => {
  const s = L.freshState();
  L.ensureLearningDay(s, '2026-06-30');
  const ev = (n) => ({ id: 'q001', kind: 'check', sql: 'SELECT ' + n, ok: false, stamp: '2026-06-30', referenceAvailable: true, execOk: true });
  const r1 = L.recordLearningAttempt(s, ev(1));
  assert.equal(r1.counted, true);
  assert.equal(r1.attemptsLeft, 2, '第 1 次有效判错：attemptsLeft 3→2');
  assert.equal(r1.mode, 'independent');
  assert.equal(s.wrong.q001, true, '判错必须记入错题本');
  assert.equal(s.learning.review.q001.status, 'needsFix');
  L.recordLearningAttempt(s, ev(2));
  const r3 = L.recordLearningAttempt(s, ev(3));
  assert.equal(r3.attemptsLeft, 0, '第 3 次有效判错：attemptsLeft=0');
  assert.equal(r3.mode, 'guided', '扣光转 guided，不自动回满');
  const r4 = L.recordLearningAttempt(s, ev(4));
  assert.equal(r4.attemptsLeft, 0, '归零后继续判错不再扣');
});

test('attempts_are_per_question_and_passed_is_untouched_by_wrong', () => {
  const s = L.freshState();
  L.ensureLearningDay(s, '2026-06-30');
  L.recordPass(s, 'q001');
  assert.equal(s.passed.q001, true);
  assert.equal(s.xp, 10);
  for (let i = 0; i < 3; i++) {
    L.recordLearningAttempt(s, { id: 'q002', kind: 'check', sql: 'S' + i, ok: false, stamp: '2026-06-30', referenceAvailable: true, execOk: true });
  }
  assert.equal(s.passed.q001, true, '已通过的其它题不受影响');
  assert.equal(s.xp, 10, 'XP 不回退');
  assert.equal(s.learning.attempts.q002.attemptsLeft, 0, 'q002 归零只影响 q002');
  assert.equal(s.learning.attempts.q001.attemptsLeft, 3, 'q001 的次数不受 q002 影响');
});

test('correct_answer_passes_and_xp_scored_once', () => {
  const s = L.freshState();
  const a = L.recordPass(s, 'q001');
  assert.equal(a.firstTime, true);
  assert.equal(a.xpGained, 10);
  assert.equal(s.xp, 10);
  assert.equal(s.todayCount, 1);
  const b = L.recordPass(s, 'q001');
  assert.equal(b.firstTime, false, '同一关重复通过不是首次');
  assert.equal(b.xpGained, 0, '同一关重复通过不再加分');
  assert.equal(s.xp, 10, 'XP 保持 10');
  assert.equal(s.todayCount, 1, '今日计数不重复累加');
});

test('legacy_streak_is_kept_as_history_but_no_longer_updated', () => {
  const s = L.freshState();
  s.streak = 4;
  L.ensureLearningDay(s, '2026-06-30');
  L.recordPass(s, 'q001');
  assert.equal(s.streak, 4, '旧连胜字段保留为历史值，不再自增');
  L.recordLearningAttempt(s, { id: 'q002', kind: 'check', sql: 'S', ok: false, stamp: '2026-06-30', referenceAvailable: true, execOk: true });
  assert.equal(s.streak, 4, '判错也不再把旧连胜清零');
});

test('ensureLearningDay_archives_day_and_preserves_drafts_and_answerSeen', () => {
  const s = L.freshState();
  L.ensureLearningDay(s, '2026-06-30');
  L.recordLearningAttempt(s, { id: 'q001', kind: 'run', sql: 'SELECT 1', ok: true, stamp: '2026-06-30' });
  L.recordLearningAttempt(s, { id: 'q001', kind: 'answer', stamp: '2026-06-30' });
  L.recordPass(s, 'q002');
  assert.equal(s.todayCount, 1);
  L.ensureLearningDay(s, '2026-07-01');
  assert.equal(s.learning.daily.day, '2026-07-01');
  assert.equal(s.learning.daily.creditedIds.length, 0, '跨天今日集合归零');
  assert.equal(s.todayCount, 0, '兼容投影 todayCount 同步归零');
  assert.equal(s.learning.attempts.q001.answerSeen, true, '跨天不得清掉 answerSeen');
  assert.equal(s.sql.q001, 'SELECT 1', '跨天保留题目草稿');
  assert.equal(s.passed.q002, true, '通过记录跨天保留');
  assert.equal(s.xp, 10, 'XP 跨天保留');
  const before = JSON.stringify(s.learning.daily);
  L.ensureLearningDay(s, '2026-07-01');
  assert.equal(JSON.stringify(s.learning.daily), before, '同日重复调用幂等');
});

test('daily_goal_counts_deduped_credited_ids_only', () => {
  const s = L.freshState();
  L.ensureLearningDay(s, '2026-06-30');
  assert.equal(L.goalMet(s), false);
  L.recordPass(s, 'q001');
  L.recordPass(s, 'q001');
  assert.equal(s.learning.daily.creditedIds.length, 1, '同题同日重复通过只计 1');
  assert.equal(L.goalMet(s), false);
  L.recordPass(s, 'q002');
  L.recordPass(s, 'q003');
  assert.equal(s.learning.daily.creditedIds.length, 3);
  assert.equal(L.goalMet(s), true, '默认今日目标 3 题');
  assert.equal(s.learning.daily.goalCelebrated, true, '首次达标只庆祝一次');
});

test('localstorage_round_trip_is_lossless', () => {
  const s = L.freshState();
  L.ensureDay(s, '2026-06-30');
  L.recordPass(s, 'q001');
  L.recordWrong(s, 'q002');
  s.current = 'q003';
  s.sql.q001 = 'SELECT 1';
  s.hintSeen.q002 = 1;
  const store = memStorage();
  assert.equal(L.saveState(store, s), true);
  const back = L.loadState(store);
  assert.deepEqual(back, s, '存进去再读出来必须一模一样');
  assert.equal(store._dump()[L.STORAGE_KEY] !== undefined, true, '键名必须是 dbquest.v2');
});

test('load_state_falls_back_to_fresh_on_empty_or_corrupt', () => {
  assert.deepEqual(L.loadState(memStorage()), L.freshState(), '空存储 → 全新状态');
  assert.deepEqual(L.loadState(memStorage({ 'dbquest.v2': '{not json' })), L.freshState(), '坏 JSON 不抛错');
});

test('hint_list_normalizes_string_and_array', () => {
  assert.deepEqual(L.hintList({ hint: 'one' }), ['one']);
  assert.deepEqual(L.hintList({ hint: 'one\ntwo' }), ['one', 'two']);
  assert.deepEqual(L.hintList({ hint: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(L.hintList({}), []);
  assert.deepEqual(L.hintList(null), []);
});
