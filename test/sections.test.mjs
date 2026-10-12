/*
 * test/sections.test.mjs — 段位轴（section）与 syntax_intro 首现判定单测
 * 运行：node --test test/sections.test.mjs
 *
 * 覆盖任务卡 T15：
 *   1) 120 题全部有 section，且严格落在题号区间表上；
 *   2) buildSections 按 section 分组，section 缺省 / 非法时不崩；
 *   3) syntax_intro 首现判定（同题多语法、跨段重复不重复弹卡、无效元素不渲染）；
 *   4) 渲染层骨架（app.js / index.html）确实按 section 与常驻标签行实现。
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

/* 段位回填口径（与写入 data/questions.json 时一致，可复算） */
const RANGES = [
  [1, 'q001', 'q005'], [1, 'q064', 'q078'],
  [2, 'q006', 'q012'], [2, 'q021', 'q033'],
  [3, 'q013', 'q018'], [3, 'q034', 'q047'],
  [4, 'q019', 'q020'], [4, 'q048', 'q063'],
  [5, 'q079', 'q099'],
  [6, 'q100', 'q120']
];
function expectedSection(id) {
  for (const [sec, a, b] of RANGES) if (id >= a && id <= b) return sec;
  return null;
}

test('every_question_has_section_matching_the_range_table', () => {
  assert.equal(QUESTIONS.length, 120);
  let missing = 0;
  for (const q of QUESTIONS) {
    if (!Number.isInteger(q.section)) missing += 1;
    assert.equal(q.section, expectedSection(q.id), `${q.id} 的 section 应落在区间表上`);
    assert.ok(q.section >= 1 && q.section <= 6, `${q.id} section 必须在 1..6`);
  }
  assert.equal(missing, 0, '120 题必须全部有整数 section');
});

test('section_is_an_axis_independent_of_level', () => {
  const combos = new Set(QUESTIONS.map((q) => q.section + ':' + q.level));
  assert.ok(combos.size > 6, '段位与难度是两根不同的轴，组合数应远多于整段数');
  const section5 = QUESTIONS.filter((q) => q.section === 5);
  assert.ok(section5.some((q) => q.level !== 1), '同一段位内应存在多种难度档');
});

test('buildSections_orders_by_section_then_seq', () => {
  const shuffled = QUESTIONS.slice().reverse();
  const sections = L.buildSections(shuffled);
  assert.deepEqual(sections.map((s) => s.section), [1, 2, 3, 4, 5, 6]);
  for (const s of sections) {
    const seqs = s.questions.map((q) => q.seq);
    assert.deepEqual(seqs, seqs.slice().sort((a, b) => a - b), `第 ${s.section} 段须按 seq 升序`);
  }
});

test('buildSections_does_not_crash_on_missing_or_bad_section', () => {
  assert.deepEqual(L.buildSections(null), []);
  assert.deepEqual(L.buildSections([]), []);
  const mixed = [
    { id: 'm1', seq: 1 },
    { id: 'm2', section: null, seq: 2 },
    { id: 'm3', section: 'abc', seq: 3 },
    { id: 'm4', section: 3, seq: 4 },
    { id: 'm5', section: '2', seq: 5 }
  ];
  let out;
  assert.doesNotThrow(() => { out = L.buildSections(mixed); });
  assert.deepEqual(out.map((s) => s.section), [2, 3], '非法 section 跳过，字符串数字可归一化');
  assert.deepEqual(out.map((s) => s.questions.map((q) => q.id)), [['m5'], ['m4']]);
});

test('syntax_intro_first_occurrence_only_by_section_then_seq', () => {
  const card = (syntax, tag) => ({ syntax, what: 'w' + tag, when: 'x', example: 'e', misuse: 'm' });
  const qs = [
    { id: 'a', section: 1, seq: 1, syntax_intro: [card('LEFT JOIN', '1'), card('COALESCE', '1')] },
    { id: 'b', section: 1, seq: 2, syntax_intro: [card('left join', '2')] },
    { id: 'c', section: 5, seq: 9, syntax_intro: [card('LEFT JOIN', '3'), card('CASE WHEN', '3')] }
  ];
  const map = L.syntaxIntrosFor(qs);
  assert.equal(map.a.length, 2, '同题两个不同语法各自成卡');
  assert.equal(map.b, undefined, '跨题重复语法（含大小写差异）不再出卡');
  assert.equal(map.c.length, 1, '跨段重复不再出卡，新语法仍出卡');
  assert.equal(map.c[0].syntax, 'CASE WHEN');
});

test('syntax_intro_invalid_elements_render_no_card', () => {
  const good = { syntax: 'VALID', what: 'w', when: 'x', example: 'e', misuse: 'm' };
  const bad = [
    null, 'string', 42,
    { syntax: 'A', what: 'w' },
    { syntax: '   ', what: 'w', when: 'x', example: 'e', misuse: 'm' },
    { syntax: 'B', what: '', when: 'x', example: 'e', misuse: 'm' }
  ];
  const map = L.syntaxIntrosFor([{ id: 'x', section: 1, seq: 1, syntax_intro: bad.concat([good]) }]);
  assert.deepEqual(map.x.map((c) => c.syntax), ['VALID'], '不完整元素全部丢弃，只留有效首现');
  assert.deepEqual(L.syntaxIntrosFor([{ id: 'y', section: 1, seq: 1, syntax_intro: [] }]), {}, '空数组不出卡');
  assert.deepEqual(L.syntaxIntrosFor([{ id: 'z', section: 1, seq: 1 }]), {}, '字段缺省不出卡');
  assert.deepEqual(L.syntaxIntrosFor(null), {}, '空题库不崩');
  assert.equal(L.validSyntaxItem(good).syntax, 'VALID');
  assert.equal(L.validSyntaxItem({ syntax: 'A' }), null);
});

test('render_layer_wires_section_tags_and_syntax_cards', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  assert.doesNotMatch(app, /sec\.level/, '渲染层不得再用 sec.level 表示段位');
  assert.match(app, /sec\.section/, '渲染层必须按 sec.section 编段');
  assert.match(app, /syntaxIntrosFor/, '渲染层必须调用首现判定');
  assert.match(app, /renderSyntaxCards/);
  assert.match(app, /renderTags/);
  assert.match(html, /id="q-tags"/);
  assert.match(html, /id="q-syntax"/);
  /* 标签行与语法卡必须在 q-tables-body 折叠容器之外 */
  const collapsed = html.slice(html.indexOf('id="q-tables-body"'), html.indexOf('id="q-dict-hints"'));
  assert.doesNotMatch(collapsed, /id="q-tags"/);
  assert.doesNotMatch(collapsed, /id="q-syntax"/);
});

/* ---------------------------- 今日小组 / 段末结算渲染骨架（T19 / B2） ---------------------------- */

test('render_layer_wires_today_group_and_section_summary', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  assert.match(app, /renderTodayGroup/, '渲染层必须渲染今日小组');
  assert.match(app, /renderSectionSummary/, '渲染层必须有独立段末总结');
  assert.match(app, /sectionTransition/, '渲染层必须调用段末结算纯函数');
  assert.match(app, /L\.replacePlanItem/, '换题只走 replacePlanItem');
  assert.match(html, /id="today-card"/);
  assert.match(html, /id="section-summary"/);
  assert.match(html, /id="next-action"/);
  assert.match(html, /id="btn-next-primary"/);
  assert.match(html, /id="btn-reinit"/, '数据库初始化失败要提供重新初始化');
});

test('attempt_caption_uses_local_attempts_not_global_hearts', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  assert.match(app, /本题独立尝试剩余/, '尝试次数用 §4.4 的本题口径');
  assert.doesNotMatch(app, /红心|等待回血|扣血|用尽/, '界面文案不得出现全局资源焦虑表达');
  assert.doesNotMatch(app, /window\.confirm|window\.alert|window\.prompt/, '不得使用浏览器确认弹窗');
});

test('nav_keeps_full_denominator_and_marks_section_position', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  /* 段进度分母恒为该段全题数；筛选只过滤题行，不参与分母 */
  assert.match(app, /passedInSection\(sec\)\s*\+\s*'\/'\s*\+\s*sec\.questions\.length/);
  assert.match(app, /本段第 /, '搜索结果必须标段内位置');
  assert.match(app, /清空筛选/, '筛选无结果必须有清空入口');
  assert.match(app, /已定位今日任务，目录筛选已清空/);
  assert.match(app, /待复查/, '已完成与待复查要能同时显示');
});

/* ---------------------------- 反馈层：动效 / 忙态 / 键盘流（Q3） ---------------------------- */

const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CSS = readSrc('src/style.css');
const APP = readSrc('src/app.js');

/* 从源码里按大括号配平截出一个具名函数体，供真实执行验证行为（不伪造结论）。 */
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return null;
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

const KEYFRAMES = [...CSS.matchAll(/@keyframes\s+([\w-]+)\s*\{([^\n]*)\}/g)];

test('feedback_animation_budget_durations_and_properties_stay_within_limits', () => {
  assert.ok(KEYFRAMES.length >= 3 && KEYFRAMES.length <= 5,
    `反馈层 keyframes 数量应在 3..5，实际 ${KEYFRAMES.length}`);
  const anims = [...CSS.matchAll(/\.(hr-anim-[\w-]+)\s*\{[^}]*animation:\s*([\w-]+)\s+(\d+)ms/g)];
  assert.equal(anims.length, KEYFRAMES.length, '每个 keyframe 都应有且仅有一条 hr-anim-* 规则引用');
  const referenced = new Set();
  for (const [, cls, kf, ms] of anims) {
    assert.ok(KEYFRAMES.some((m) => m[1] === kf), `${cls} 引用了未定义的 keyframe ${kf}`);
    assert.ok(Number(ms) >= 160 && Number(ms) <= 260, `${cls} 时长 ${ms}ms 必须落在 160–260ms`);
    referenced.add(kf);
  }
  for (const [, name] of KEYFRAMES) assert.ok(referenced.has(name), `keyframe ${name} 未被任何类引用`);
  for (const [, name, body] of KEYFRAMES) {
    const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    assert.ok(props.length > 0, `${name} 不应是空 keyframe`);
    for (const p of props) assert.ok(p === 'opacity' || p === 'transform', `${name} 动了 ${p}，只允许 opacity / transform`);
  }
  /* 宽度类动效走 transition，不新增 keyframe；keyframes + 宽度过渡合计 ≤ 5 */
  const w = CSS.match(/\.bar i \{[^}]*transition:\s*width\s+(\d+)ms/);
  assert.ok(w, '进度条宽度必须用 transition 平滑填充');
  assert.ok(Number(w[1]) >= 160 && Number(w[1]) <= 260, `进度条宽度过渡 ${w[1]}ms 必须落在 160–260ms`);
  assert.ok(KEYFRAMES.length + 1 <= 5, 'keyframes + 宽度过渡合计不得超过 5 个动效');
});

test('feedback_animations_are_disabled_by_reduced_motion', () => {
  const block = CSS.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(block, '必须有 prefers-reduced-motion 关停块');
  assert.match(block[1], /\*,\s*\*::before,\s*\*::after/, '关停块必须覆盖全部元素');
  assert.match(block[1], /animation-duration:\s*0\.001ms\s*!important/);
  assert.match(block[1], /transition-duration:\s*0\.001ms\s*!important/);
});

test('feedback_js_animation_classes_are_all_defined_in_css', () => {
  const used = new Set([...APP.matchAll(/'(hr-anim-[\w-]+)'/g)].map((m) => m[1]));
  assert.ok(used.size >= 3, `app.js 应至少使用 3 个动效类，实际 ${used.size}`);
  for (const cls of used) assert.match(CSS, new RegExp('\\.' + cls + '\\s*\\{'), `CSS 缺少 .${cls} 规则`);
  /* 通过 / 失败两条路径都要有反馈：verdict 淡入，失败额外抖编辑器 */
  assert.match(APP, /replayAnim\(box, 'hr-anim-fade-up'\)[\s\S]*?replayAnim\(\$\('sql-input'\), 'hr-anim-shake'\)/);
});

test('result_row_animation_is_capped_and_timer_free', () => {
  assert.match(APP, /MAX_ROW_ANIM\s*=\s*20/);
  const fn = extractFn(APP, 'renderTable');
  assert.ok(fn, 'renderTable 必须存在');
  assert.match(fn, /i < MAX_ROW_ANIM/, '只给前 MAX_ROW_ANIM 行挂动画');
  assert.doesNotMatch(fn, /setTimeout|setInterval|requestAnimationFrame/, '行淡入不得堆定时器');
});

function fakeButton(text) {
  const attrs = {};
  return {
    textContent: text, disabled: false,
    hasAttribute: (n) => Object.prototype.hasOwnProperty.call(attrs, n),
    setAttribute: (n, v) => { attrs[n] = String(v); },
    getAttribute: (n) => (Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null),
    removeAttribute: (n) => { delete attrs[n]; }
  };
}

test('busy_state_disables_then_restores_both_buttons', () => {
  const src = extractFn(APP, 'setBusy');
  assert.ok(src, 'app.js 必须有 setBusy');
  const setBusy = new Function('return (' + src + ')')();
  const run = fakeButton('运行');
  const judge = fakeButton('判题');
  setBusy(run, true, '运行中…');
  setBusy(judge, true);
  assert.equal(run.disabled, true);
  assert.equal(judge.disabled, true);
  assert.equal(run.textContent, '运行中…');
  assert.equal(judge.textContent, '判题', '未给忙态文案的按钮只禁用、不改文案');
  assert.equal(run.getAttribute('aria-busy'), 'true');
  assert.equal(judge.getAttribute('aria-busy'), 'true');
  setBusy(run, false);
  setBusy(judge, false);
  assert.equal(run.disabled, false);
  assert.equal(judge.disabled, false);
  assert.equal(run.textContent, '运行');
  assert.equal(run.getAttribute('aria-busy'), null);
  /* 运行 / 判题都必须同时锁住两个按钮 */
  assert.match(extractFn(APP, 'doRun'), /setBusy\(\$\('btn-run'\)[\s\S]*setBusy\(\$\('btn-judge'\)/);
  assert.match(extractFn(APP, 'setJudgeLoading'), /setBusy\(\$\('btn-judge'\)[\s\S]*setBusy\(\$\('btn-run'\)/);
});

function fakeAnimNode() {
  const node = {
    offsetWidth: 320, classes: new Set(), listeners: {},
    addEventListener(type, h) { node.listeners[type] = h; },
    removeEventListener(type) { delete node.listeners[type]; }
  };
  node.classList = {
    add(c) { node.classes.add(c); },
    remove(c) { node.classes.delete(c); }
  };
  return node;
}

test('replay_anim_restarts_and_cleans_up_on_animationend', () => {
  const src = extractFn(APP, 'replayAnim');
  assert.ok(src, 'app.js 必须有 replayAnim');
  const replayAnim = new Function('return (' + src + ')')();
  const node = fakeAnimNode();
  replayAnim(node, 'hr-anim-fade-up');
  assert.ok(node.classes.has('hr-anim-fade-up'), '重放时应挂上动画类');
  assert.equal(typeof node.listeners.animationend, 'function');
  /* 子元素冒泡上来的 animationend 不得误清本节点的类 */
  node.listeners.animationend({ target: {} });
  assert.ok(node.classes.has('hr-anim-fade-up'));
  /* 自身动画结束：摘类 + 摘监听，保证可重复重放 */
  node.listeners.animationend({ target: node });
  assert.ok(!node.classes.has('hr-anim-fade-up'));
  assert.equal(node.listeners.animationend, undefined);
  replayAnim(node, 'hr-anim-fade-up');
  assert.ok(node.classes.has('hr-anim-fade-up'), '第二次重放仍应生效');
});

test('suggest_supports_arrow_selection_enter_and_escape', () => {
  assert.match(APP, /function moveSuggest\(delta\)/);
  assert.match(APP, /suggestIndex >= 0/, 'Enter 只在有选中项时确认');
  assert.match(APP, /applySuggest\(pick\)/);
  const keydown = APP.slice(
    APP.indexOf("sqlInput.addEventListener('keydown'"),
    APP.indexOf("sqlInput.addEventListener('input'")
  );
  assert.ok(keydown.length > 0, '必须先定位到 sql-input 的 keydown 处理器');
  assert.match(keydown, /ArrowDown/);
  assert.match(keydown, /ArrowUp/);
  assert.match(keydown, /e\.key === 'Enter' && suggestIndex >= 0/);
  assert.match(keydown, /Escape/);
  assert.match(keydown, /\(e\.ctrlKey \|\| e\.metaKey\) && e\.key === 'Enter'/, 'Ctrl/Cmd+Enter 运行需保留');
  /* 键盘高亮类名必须与 CSS 规则对齐 */
  assert.match(CSS, /\.sql-suggest-item\.is-active/);
  assert.match(APP, /classList\.toggle\('is-active'/);
});

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

test('feedback_layer_adds_no_emoji_and_keeps_record_metrics_out_of_topbar', () => {
  for (const rel of ['src/style.css', 'src/app.js', 'src/index.html']) {
    assert.doesNotMatch(readSrc(rel), EMOJI_RE, `${rel} 不得出现 emoji`);
  }
  const html = readSrc('src/index.html');
  const topbar = html.slice(html.indexOf('class="topbar"'), html.indexOf('id="record-panel"'));
  assert.ok(topbar.length > 0, '必须先定位到顶栏段');
  assert.doesNotMatch(topbar, /stat-xp|stat-streak|stat-goal/, 'XP / 连续 / 今日目标不得搬回顶栏');
  assert.match(html, /id="record-panel"[\s\S]*id="stat-xp"/, 'XP 仍留在学习记录面板内');
});
