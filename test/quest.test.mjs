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

test('wrong_answer_loses_heart_and_records_wrong_book', () => {
  const s = L.freshState();
  const r1 = L.recordWrong(s, 'q001');
  assert.equal(r1.reset, false);
  assert.equal(s.hearts, 2, '判错扣 1 颗心');
  assert.equal(s.wrong.q001, true, '判错必须记入错题本');
  assert.equal(s.streak, 0, '判错连胜归零');
  L.recordWrong(s, 'q001');
  assert.equal(s.hearts, 1);
  const r3 = L.recordWrong(s, 'q001');
  assert.equal(r3.reset, true, '第三次错 → 扣光，重置本关');
  assert.equal(s.hearts, 3, '扣光后心回满');
});

test('hearts_depletion_does_not_touch_already_passed_levels', () => {
  const s = L.freshState();
  L.recordPass(s, 'q001');
  assert.equal(s.passed.q001, true);
  assert.equal(s.xp, 10);
  L.recordWrong(s, 'q002');
  L.recordWrong(s, 'q002');
  L.recordWrong(s, 'q002');       // q002 扣光 → 只重置 q002
  assert.equal(s.passed.q001, true, '已通过的关不受影响');
  assert.equal(s.xp, 10, 'XP 不回退');
  assert.equal(s.hearts, 3);
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

test('streak_increments_on_first_attempt_and_resets_on_any_wrong', () => {
  const s = L.freshState();
  L.recordPass(s, 'q001');
  assert.equal(s.streak, 1, '一次就过 +1');
  L.recordPass(s, 'q002');
  assert.equal(s.streak, 2);
  L.recordWrong(s, 'q003');
  assert.equal(s.streak, 0, '错一次归零');
  L.recordPass(s, 'q003');
  assert.equal(s.streak, 0, '错过之后再过不算「一次就过」');
  L.recordPass(s, 'q004');
  assert.equal(s.streak, 1, '重新开始计数');
});

test('cross_day_resets_hearts_and_today_count_only', () => {
  const s = L.freshState();
  L.ensureDay(s, '2026-06-30');
  assert.equal(s.lastDay, '2026-06-30');
  L.recordPass(s, 'q001');
  L.recordWrong(s, 'q002');
  assert.equal(s.hearts, 2);
  assert.equal(s.todayCount, 1);
  L.ensureDay(s, '2026-07-01');
  assert.equal(s.hearts, 3, '跨天心回 3');
  assert.equal(s.todayCount, 0, '跨天今日计数归零');
  assert.equal(s.passed.q001, true, '通过记录跨天保留');
  assert.equal(s.xp, 10, 'XP 跨天保留');
  assert.equal(s.wrong.q002, true, '错题本跨天保留');
});

test('daily_goal_met_after_three_first_time_passes', () => {
  const s = L.freshState();
  assert.equal(L.goalMet(s), false);
  L.recordPass(s, 'q001');
  L.recordPass(s, 'q002');
  assert.equal(L.goalMet(s), false);
  L.recordPass(s, 'q003');
  assert.equal(L.goalMet(s), true, '默认今日目标 3 关');
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
