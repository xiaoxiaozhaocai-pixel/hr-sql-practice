/*
 * test/diagnose.test.mjs — 学情诊断纯函数单测（node 原生 test runner）
 * 运行：node --test test/diagnose.test.mjs
 *
 * 测试桩全部自造固定对象，不读 data/questions.json，不取系统时间。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import diagnoseModule from '../src/diagnose.js';

const { diagnose } = diagnoseModule;
const TODAY = '2026-10-18';

function q(id, seq, section, title, syntax) {
  const out = { id, seq, title: title || ('题 ' + seq), section };
  if (syntax) out.syntax_intro = syntax.map((name) => ({ syntax: name }));
  return out;
}

test('empty_learning_ready_false_and_all_sections', () => {
  const questions = [q('q1', 1, 1), q('q2', 2, 1), q('q3', 3, 2)];
  const report = diagnose({ questions, learning: {} }, { today: TODAY });
  assert.equal(report.ready, false);
  assert.deepEqual(report.overall, {
    total: 3, completed: 0, independent: 0, guided: 0, needsFix: 0, due: 0, activeDays: 0
  });
  assert.deepEqual(report.sections.map((s) => s.section), [1, 2]);
  assert.deepEqual(report.sections.map((s) => s.total), [2, 1]);
  assert.equal(report.sections[0].rate, 0);
  assert.equal(report.sections[0].masteryRate, 0);
});

test('independent_completion_counts_once', () => {
  const questions = [q('q1', 1, 1), q('q2', 2, 1)];
  const learning = { completions: { q1: { completionType: 'independent' } } };
  const report = diagnose({ questions, learning }, { today: TODAY });
  assert.equal(report.overall.total, 2);
  assert.equal(report.overall.completed, 1);
  assert.equal(report.overall.independent, 1);
  assert.equal(report.sections[0].rate, 0.5);
  assert.equal(report.sections[0].masteryRate, 0.5);
});

test('guided_completion_is_not_independent', () => {
  const questions = [q('q1', 1, 1), q('q2', 2, 1)];
  const learning = { completions: { q1: { completionType: 'guided' } } };
  const report = diagnose({ questions, learning }, { today: TODAY });
  assert.equal(report.overall.completed, 1);
  assert.equal(report.overall.guided, 1);
  assert.equal(report.overall.independent, 0);
  assert.equal(report.sections[0].masteryRate, 0);
});

test('unknown_completion_type_counts_completed_only', () => {
  const questions = [q('q1', 1, 1)];
  const learning = { completions: { q1: { completionType: 'unknown' } } };
  const report = diagnose({ questions, learning }, { today: TODAY });
  assert.equal(report.overall.completed, 1);
  assert.equal(report.overall.independent, 0);
  assert.equal(report.overall.guided, 0);
  assert.equal(report.sections[0].completed, 1);
});

test('needsFix_is_first_in_plan', () => {
  const questions = [q('q1', 1, 1), q('q2', 2, 1)];
  const learning = {
    completions: { q1: { completionType: 'guided' } },
    review: { q2: { status: 'needsFix', dueDay: null } }
  };
  const report = diagnose({ questions, learning }, { today: TODAY });
  assert.equal(report.plan[0].id, 'q2');
  assert.equal(report.plan[0].reason, '待修正');
});

test('due_plan_only_when_dueDay_not_after_today', () => {
  const questions = [q('q1', 1, 1), q('q2', 2, 1)];
  const learning = {
    review: {
      q1: { status: 'due', dueDay: '2026-10-18' },
      q2: { status: 'due', dueDay: '2026-10-19' }
    }
  };
  const report = diagnose({ questions, learning }, { today: TODAY });
  const ids = report.plan.map((p) => p.id);
  assert.equal(ids.includes('q1'), true);
  assert.equal(ids.includes('q2'), false);
  assert.equal(report.plan[0].reason, '到期复查');
});

test('guided_only_is_first_plan_item_without_review', () => {
  const questions = [q('q1', 1, 1), q('q2', 2, 1)];
  const learning = { completions: { q2: { completionType: 'guided' } } };
  const report = diagnose({ questions, learning }, { today: TODAY });
  assert.equal(report.plan[0].id, 'q2');
  assert.equal(report.plan[0].reason, '仅跟练过，建议独立复做');
});

test('same_syntax_two_questions_mastery_half', () => {
  const questions = [
    q('q1', 1, 1, 'A', ['ORDER BY 多键']),
    q('q2', 2, 1, 'B', ['ORDER BY 多键'])
  ];
  const learning = {
    completions: {
      q1: { completionType: 'independent' },
      q2: { completionType: 'guided' }
    }
  };
  const report = diagnose({ questions, learning }, { today: TODAY });
  assert.equal(report.syntax.length, 1);
  assert.equal(report.syntax[0].name, 'ORDER BY 多键');
  assert.equal(report.syntax[0].total, 2);
  assert.equal(report.syntax[0].masteryRate, 0.5);
});

test('no_syntax_intro_gives_empty_syntax_and_coverage_note', () => {
  const questions = [q('q1', 1, 1), q('q2', 2, 1), q('q3', 3, 2)];
  const report = diagnose({ questions, learning: {} }, { today: TODAY });
  assert.deepEqual(report.syntax, []);
  assert.equal(report.notes.some((n) => n.includes('语法维度覆盖 0/3 题')), true);
});

test('plan_at_most_three_and_ids_unique', () => {
  const questions = [
    q('q1', 1, 1), q('q2', 2, 1), q('q3', 3, 2), q('q4', 4, 2), q('q5', 5, 3)
  ];
  const learning = {
    review: {
      q1: { status: 'needsFix', dueDay: '2026-10-01' },
      q2: { status: 'needsFix', dueDay: '2026-10-02' },
      q3: { status: 'needsFix', dueDay: '2026-10-03' },
      q4: { status: 'needsFix', dueDay: '2026-10-04' },
      q5: { status: 'needsFix', dueDay: '2026-10-05' }
    }
  };
  const report = diagnose({ questions, learning }, { today: TODAY });
  assert.equal(report.plan.length, 3);
  assert.equal(new Set(report.plan.map((p) => p.id)).size, 3);
});

test('zero_total_has_no_nan', () => {
  const report = diagnose({ questions: [], learning: {} }, { today: TODAY });
  assert.equal(report.overall.total, 0);
  assert.deepEqual(report.sections, []);
  assert.deepEqual(report.syntax, []);
  assert.deepEqual(report.plan, []);
  assert.equal(JSON.stringify(report).includes('NaN'), false);
  assert.equal(report.notes.length >= 2, true);
});
