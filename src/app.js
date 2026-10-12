/*
 * src/app.js — HR 语境 SQL 练习台 界面逻辑（DOM 操作）—— UI 收敛版（2026-10-10）
 * ---------------------------------------------------------------------------
 * 本次只改「UI 与信息呈现」：判题口径、题库、题目内容、数据（tables.js / 内联种子）一律未动。
 * 布局：左栏题号列表 + 主列（题面 / 深色编辑器 / 结果）；表结构、方言对照改右侧抽屉（默认收起）。
 * 游戏化：只保留段/关进度与通关徽章；XP、连击、今日配额、心形生命值全部不再呈现。
 *
 * 依赖注入关系（不变）：
 *   HR_BOOT / HRJudge / HRLevels / HRDb / HRTables；本文件只把状态渲染成 DOM、把动作转成调用。
 * 进度键 dbquest.v2；状态变化立即 saveProgress()。题库文本一律 textContent 写入，不拼 HTML。
 */
(function () {
  'use strict';

  var MAX_PREVIEW_ROWS = 200;   // 运行结果最多渲染 200 行，超出只提示总行数
  var MAX_ROW_ANIM = 20;        // 结果行淡入只处理前 20 行，避免一次性堆大量动画
  var BOOT = window.HR_BOOT || {};
  var QUESTIONS = Array.isArray(BOOT.questions) ? BOOT.questions : [];
  var BASELINE_DATE = BOOT.baselineDate || '2026-06-30';
  var L = window.HRLevels;
  var T = window.HRTables;
  var QA = window.HRQa;

  /* 题 seq -> 真实用表：由 src/tables.js 从参考 SQL 解析（不再读 model-notes 的人工映射）。 */
  function tablesOf(q) {
    return (T && q) ? T.questionTables(q) : [];
  }

  var SECTIONS = L ? L.buildSections(QUESTIONS) : [];
  var SYNTAX_BY_ID = L ? L.syntaxIntrosFor(QUESTIONS) : {};   // id -> 首现语法卡
  var QUESTION_BY_ID = {};
  var SECTION_OF = {};   // 题目 id -> 段
  SECTIONS.forEach(function (sec) {
    sec.questions.forEach(function (q) { QUESTION_BY_ID[q.id] = q; SECTION_OF[q.id] = sec; });
  });

  /* localStorage 不可用（隐私模式 / file:// 策略）时退化成内存 stub，页面照常可玩。 */
  var STORAGE_OK = true;
  function safeStorage() {
    try {
      var t = '__dbquest_probe__';
      window.localStorage.setItem(t, '1');
      window.localStorage.removeItem(t);
      return window.localStorage;
    } catch (e) {
      STORAGE_OK = false;
      var mem = {};
      return {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
        setItem: function (k, v) { mem[k] = String(v); },
        removeItem: function (k) { delete mem[k]; }
      };
    }
  }

  var storage = safeStorage();
  var state = L ? L.loadState(storage) : null;
  if (state) L.ensureDay(state, L.todayStamp());

  var db = null;
  var refDb = null;           // 判题参考库：与 db 隔离，用户写操作改不到
  var dbReady = false;
  var refCache = {};          // id -> 参考 SQL 的实跑结果（含是否与 expected.row_count 对账成功）
  var currentId = null;
  var judging = false;
  var dailyPlan = null;          // buildDailyPlan 的当日结果（建立后固定，换题只走 replacePlanItem）
  var pendingSummary = null;     // 最近一次段末结算描述，供「查看下一段」等次动作复用
  var lastCombined = null;       // 段末 + 今日目标合并结算只弹一次

  var openPanel = null;       // 'drawer' | 'rail' | null
  var lastRun = null;         // { columns, rows }：最近一次「运行」的结果，供结果区 tab 切换
  var filter = { kw: '', diffs: {}, undoneOnly: false };
  var suggestItems = [];      // 当前补全候选（键盘 ↑/↓ 用）
  var suggestIndex = -1;      // -1 = 未选中，Enter 保持换行语义

  /* ------------------------------ 小工具 ------------------------------ */
  function $(id) { return document.getElementById(id); }

  function el(tag, text, cls) {
    var node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (cls) node.className = cls;
    return node;
  }

  function show(node, on) { if (node) node.hidden = !on; }

  /* 反馈层：重放一次 CSS 动画。先摘类名再强制回流，保证连续两次判题都能看到动效；
     动画结束后摘掉类名（reduced-motion 下动画即时结束，行为一致，无定时器）。 */
  function replayAnim(node, cls) {
    if (!node || !node.classList) return;
    node.classList.remove(cls);
    void node.offsetWidth;
    node.classList.add(cls);
    var onEnd = function (e) {
      if (e.target !== node) return;
      node.classList.remove(cls);
      node.removeEventListener('animationend', onEnd);
    };
    node.addEventListener('animationend', onEnd);
  }

  function saveProgress() { if (state) L.saveState(storage, state); }

  function currentQuestion() { return currentId ? QUESTION_BY_ID[currentId] : null; }

  function passedInSection(sec) {
    var n = 0;
    sec.questions.forEach(function (q) { if (state.passed[q.id]) n++; });
    return n;
  }

  function pad2(n) { n = Number(n) || 0; return (n < 10 ? '0' : '') + n; }

  function showBanner(id, text) {
    var node = $(id);
    if (!node) return;
    if (text) { node.textContent = text; node.hidden = false; } else { node.hidden = true; }
  }

  /* 读屏播报：一个专用的 polite 区域，避免整块反馈卡重绘被反复朗读。 */
  function announce(text) {
    var node = $('live-status');
    if (!node) return;
    node.textContent = String(text || '');
  }

  /* 引擎报错 -> 一句人话解释。原样报错仍然完整展示（学习价值），这里只是追加。 */
  var ERROR_HINTS = [
    [/no such table|no such view/i, '库里没有这个名字的表：核对表名拼写，HR_ 前缀别丢；本页是 SQLite，表名不带 dbo. 前缀。'],
    [/no such column/i, '列名不存在：核对列名拼写；SQLite 列名不区分大小写，但错字照样报错。'],
    [/no such function/i, '函数名不对或本引擎不支持：SQLite 用 IFNULL / CAST / LIMIT，别用 ISNULL / GETDATE / TOP。'],
    [/misuse of aggregate/i, '聚合函数位置不当：聚合结果不能直接写在 WHERE 里，先 GROUP BY 再用 HAVING，或把聚合放进子查询。'],
    [/wrong number of arguments/i, '函数参数个数不对：核对这个函数要几个参数。'],
    [/ambiguous column/i, '列名有歧义：多表 JOIN 时同名列要加表别名前缀，如 a.id / b.id。'],
    [/syntax error|near "/i, 'SQL 语法有误：常见是漏逗号、关键字拼错、子句顺序不对（SELECT / FROM / WHERE / GROUP BY / HAVING / ORDER BY / LIMIT）。'],
    [/incomplete input/i, 'SQL 没写完：检查括号与引号是否成对。'],
    [/GROUP BY/i, '涉及分组：SELECT 里的非聚合列都必须出现在 GROUP BY 中。']
  ];
  function explainError(msg) {
    for (var i = 0; i < ERROR_HINTS.length; i++) {
      if (ERROR_HINTS[i][0].test(msg)) return ERROR_HINTS[i][1];
    }
    return '本引擎原样返回了上面的报错；把报错点到的表名 / 列名 / 关键字逐个核对一遍。';
  }

  /* 语句级预检：先看语句自身的结构缺口，再落到引擎报错的文本翻译上。
     漏 FROM 时 SQLite 先抛 no such column，若只按报错文本翻译会把学员引去核列名 —— 这里优先纠结构。 */
  function sqlTriage(sql) {
    /* 剥掉行注释 / 块注释，避免注释里的关键字参与判定 */
    var s = String(sql || '')
      .replace(/--[^\n]*/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ');
    var up = s.toUpperCase().replace(/\s+/g, ' ').trim();
    if (!up) return null;
    var q = currentQuestion();
    var names = tablesOf(q);
    var tableHint = names.length ? names.join(' / ') : '见上方「涉及的表 / 字段」';
    if (up.indexOf('FROM') === -1) {
      return '缺少 FROM 子句：SELECT 的字段来自哪张表？本题的表是 ' + tableHint +
        '（本页是 SQLite，表名不加 dbo. 前缀）。';
    }
    if (/\bFROM\s*(WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|;|$)/.test(up)) {
      return 'FROM 后面没写表名：把它补上。本题的表是 ' + tableHint + '。';
    }
    return null;
  }

  /* ------------------------------ 今日小组（§4.1 / §4.2 / §5.3） ------------------------------ */

  function sectionIndexOf(sec, id) {
    if (!sec) return 0;
    for (var i = 0; i < sec.questions.length; i++) if (sec.questions[i].id === id) return i + 1;
    return 0;
  }

  /* 题级状态：同时保留「已完成」与「待复查」，不互相遮盖（§4.2）。 */
  function planItemStatus(id) {
    var d = state.learning.daily;
    var rv = state.learning.review[id];
    var reviewTag = (rv && rv.status === 'due') ? '待复查' : ((rv && rv.status === 'needsFix') ? '待修正' : null);
    if (d.creditedIds.indexOf(id) >= 0) return { label: '已完成', review: reviewTag };
    if (reviewTag) return { label: reviewTag, review: reviewTag };
    if (state.passed[id]) return { label: '已完成', review: null };
    var a = state.learning.attempts[id];
    if (a && a.active) return { label: '进行中', review: null };
    return { label: '未开始', review: null };
  }

  function planIdsNow() {
    if (dailyPlan && dailyPlan.planIds && dailyPlan.planIds.length) return dailyPlan.planIds;
    return (state.learning.daily.planIds || []);
  }

  /* 今日小组里下一项「尚未计入今日成果」的题；没有计划项时退回 section→seq 的下一未完成题。 */
  function nextPlanItem() {
    var d = state.learning.daily;
    var ids = planIdsNow();
    for (var i = 0; i < ids.length; i++) {
      if (d.creditedIds.indexOf(ids[i]) === -1 && QUESTION_BY_ID[ids[i]]) return ids[i];
    }
    var nq = L.nextQuestion(state, SECTIONS);
    return nq ? nq.id : null;
  }

  /* 题库待复核 / 不可用题：无参考 SQL，或参考 SQL 实跑失败 / 与 expected 对不上。 */
  function unavailableIds() {
    var out = [];
    QUESTIONS.forEach(function (q) {
      if (!q.reference_sql && !q.reference_sql_sqlite) { out.push(q.id); return; }
      var r = refCache[q.id];
      if (r && (!r.ok || r.mismatch)) out.push(q.id);
    });
    return out;
  }

  /* 跳转前若被筛选隐藏：清空筛选并告知（§4.2）；筛选不改变课程完成度的推断。 */
  function jumpToQuestion(id) {
    var q = QUESTION_BY_ID[id];
    if (!q) return;
    if (!questionMatches(q)) {
      clearFilters();
      announce('已定位今日任务，目录筛选已清空。');
    }
    selectLevel(id, false);
  }

  function continueToNext() {
    var id = nextPlanItem();
    if (id) jumpToQuestion(id);
  }

  function gotoNextSection() {
    if (pendingSummary && pendingSummary.nextFirstQuestion) jumpToQuestion(pendingSummary.nextFirstQuestion);
  }

  function renderTodayGroup() {
    var list = $('today-list');
    if (!list) return;
    list.textContent = '';
    var d = state.learning.daily;
    var ids = planIdsNow();
    var doneN = 0, dueN = 0, freshN = 0, fixN = 0;

    /* 今日摘要用文字表达进度，不把今日目标挪回顶栏。 */
    var summary = $('today-summary');
    var count = $('today-count');

    ids.forEach(function (id) {
      if (d.creditedIds.indexOf(id) >= 0) { doneN += 1; return; }
      var rv = state.learning.review[id];
      if (rv && rv.status === 'due') dueN += 1;
      else if (rv && rv.status === 'needsFix') fixN += 1;
      else if (!state.passed[id]) freshN += 1;
    });

    if (count) count.textContent = ids.length ? doneN + '/' + ids.length + ' 已完成' : '今天没有安排';
    if (summary) {
      if (!ids.length) summary.textContent = '今天没有安排；可以从左侧任选一段开始。';
      else {
        var parts = [];
        if (dueN) parts.push('复查 ' + dueN + ' 题');
        if (fixN) parts.push('修正 ' + fixN + ' 题');
        if (freshN) parts.push('再推进 ' + freshN + ' 题');
        summary.textContent = '今天练 ' + ids.length + ' 项' + (parts.length ? '：' + parts.join('，') + '。' : '，均已完成。');
      }
    }

    var note = $('today-note');
    if (note) {
      var lines = [];
      if (!STORAGE_OK) lines.push('本次进度仅在当前页面保留。');
      if (state.learning.persistence === 'memoryOnly') lines.push('本次进度尚未保存到浏览器（刷新可能丢失）。');
      note.textContent = lines.join(' ');
      show(note, lines.length > 0);
    }
    var adj = $('today-adjust');
    if (adj) {
      if (dailyPlan && dailyPlan.adjusted && dailyPlan.adjusted.reason) {
        adj.textContent = dailyPlan.adjusted.reason;
        show(adj, true);
      } else { adj.textContent = ''; show(adj, false); }
    }

    var primaryId = nextPlanItem();
    var primaryIsInPlan = primaryId && ids.indexOf(primaryId) >= 0;

    ids.forEach(function (id) {
      var q = QUESTION_BY_ID[id];
      if (!q) return;
      var st = planItemStatus(id);
      var sec = SECTION_OF[id];
      var li = el('li', null, (id === currentId ? 'on' : '') + (st.label === '已完成' ? ' done' : '') +
        (st.review === '待复查' ? ' is-review' : ''));

      var no = el('span', '第 ' + (sec ? sec.section : '?') + ' 段 · 第 ' + sectionIndexOf(sec, id) + ' 题', 't-no');
      li.appendChild(no);
      var title = el('button', q.title || q.id, 'link-btn t-title');
      title.type = 'button';
      title.addEventListener('click', function () { jumpToQuestion(id); });
      li.appendChild(title);
      li.appendChild(el('span', st.label + (st.review && st.label !== st.review ? ' · ' + st.review : ''), 't-status'));

      /* 未完成项才提供「替换这一项」；已完成项不显示该入口（T17 唯一换题通道）。 */
      if (st.label !== '已完成') {
        var rep = el('button', '替换这一项', 'link-btn');
        rep.type = 'button';
        rep.addEventListener('click', function () { doReplace(id); });
        li.appendChild(rep);
      }
      if (primaryIsInPlan && id === primaryId && st.label !== '已完成') {
        var go = el('button', '开始这一项', 'btn primary sm');
        go.type = 'button';
        go.addEventListener('click', function () { jumpToQuestion(id); });
        li.appendChild(go);
      }
      list.appendChild(li);
    });

    if (!ids.length) list.appendChild(el('li', '今天没有安排，可以从左侧任选一段开始。', 'muted'));
  }

  /* 换题：只走 replacePlanItem；换不了时按 reason 给可读说明，不宣告达标。 */
  function doReplace(qid) {
    if (!L.replacePlanItem) return;
    var res = L.replacePlanItem(state, qid, { sections: SECTIONS, unavailableIds: unavailableIds(), today: L.todayStamp() });
    saveProgress();
    if (res.replaced) {
      dailyPlan = dailyPlan ? { day: dailyPlan.day, goal: dailyPlan.goal, planIds: state.learning.daily.planIds.slice(), reason: 'fixed', adjusted: dailyPlan.adjusted } : dailyPlan;
      announce('已把这一项替换为 ' + res.toId + '。');
      renderTodayGroup();
      return;
    }
    var msg = res.reason === 'already-credited' ? '这一项今天已经完成了，不需要替换。'
      : res.reason === 'no-candidate' ? '没有别的可换的题了；可以先学下一段，或稍后再来。'
      : '这一项不在今天的计划里。';
    var adj = $('today-adjust');
    if (adj) { adj.textContent = msg; show(adj, true); }
    announce(msg);
  }

  /* 下一步：按 §5.3 优先级只显示一个主动作。 */
  function chooseNextAction(info) {
    info = info || {};
    if (info.sectionCompleted && info.goalMet) {
      return { primary: { label: '今天先到这里', run: function () { showTodayWrap(false); } }, secondary: { label: '查看下一段', run: gotoNextSection } };
    }
    if (info.sectionCompleted) {
      return { primary: { label: '查看下一段任务', run: gotoNextSection }, secondary: null };
    }
    if (info.goalMet) {
      return { primary: { label: '今天先到这里', run: function () { showTodayWrap(false); } }, secondary: { label: '继续练', run: continueToNext } };
    }
    return { primary: { label: '继续今天这一组的下一项', run: continueToNext }, secondary: null };
  }

  function renderNextAction(info) {
    var box = $('next-action');
    if (!box) return;
    var plan = chooseNextAction(info);
    var p = $('btn-next-primary');
    var s = $('btn-next-secondary');
    box.hidden = false;
    if (p) { p.textContent = plan.primary.label; p.onclick = plan.primary.run; }
    if (s) {
      if (plan.secondary) { s.textContent = plan.secondary.label; s.hidden = false; s.onclick = plan.secondary.run; }
      else { s.hidden = true; s.onclick = null; s.textContent = ''; }
    }
  }

  /* 判题完成后把焦点交给下一步按钮：优先主按钮，其次次按钮；都没露时不抢焦点。 */
  function focusNextAction() {
    var box = $('next-action');
    if (!box || box.hidden) return false;
    var p = $('btn-next-primary');
    var s = $('btn-next-secondary');
    var target = (p && !p.hidden && !p.disabled) ? p : ((s && !s.hidden && !s.disabled) ? s : null);
    if (!target) return false;
    try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); }
    return true;
  }

  /* 段末结算：独立卡片；旧用户回看只展示、不重发 XP。combined=与今日目标合并成一张结算。 */
  function renderSectionSummary(trans, combined) {
    var box = $('section-summary');
    if (!box) return;
    if (!trans || !trans.completed) { pendingSummary = null; show(box, false); return; }
    pendingSummary = trans;
    $('section-summary-title').textContent = combined
      ? '第 ' + trans.section + ' 段完成 + 今日目标达成'
      : '第 ' + trans.section + ' 段 ' + trans.total + ' 题已完成';
    var body = '完成 ' + trans.passed + '/' + trans.total +
      '；未看完整答案完成 ' + trans.unseenAnswer + ' 题' +
      '；跟练完成 ' + trans.guided + ' 题' +
      '；待复查 ' + trans.due + ' 题。';
    if (trans.isLastSection) {
      body = '全库首次完成 ' + trans.course.passed + '/' + trans.course.total + ' 题，待复查 ' + trans.course.due + ' 题。' +
        '本段完成 ' + trans.passed + '/' + trans.total + '；未看完整答案完成 ' + trans.unseenAnswer +
        ' 题；跟练完成 ' + trans.guided + ' 题。没有下一段了，可以进入复习计划。';
    } else if (trans.nextTitle) {
      body += ' 下一段开始练' + trans.nextTitle + '。';
    }
    $('section-summary-body').textContent = body;

    var ul = $('section-summary-points');
    ul.textContent = '';
    trans.keyPoints.forEach(function (p) { ul.appendChild(el('li', p)); });
    if (!trans.keyPoints.length) ul.appendChild(el('li', '题库未登记主要考点。'));

    var due = $('section-summary-due');
    if (trans.isLastSection) {
      due.textContent = trans.course.due
        ? '待复查清单（' + trans.course.due + ' 题）：' + trans.course.dueIds.join('、')
        : '当前没有待复查的题。';
    } else {
      due.textContent = trans.due ? '本段待复查 ' + trans.due + ' 题：' + trans.dueIds.join('、') : '本段当前没有待复查的题。';
    }
    /* 合并结算：今日小结折进同一张卡，不连弹两次（§5.3 第 1 条）。 */
    if (combined) due.textContent += ' ' + todayWrapText();
    show(box, true);
    replayAnim(box, 'hr-anim-summary');
    if (trans.firstShown) L.markSectionSummarySeen(state, trans.section);
  }

  /* 今日收束：完成目标后非阻塞小结；只庆祝一次。 */
  function todayWrapTitle() {
    return L.goalMet(state) ? '今天目标已完成' : '今天到这里';
  }

  function todayWrapText() {
    var d = state.learning.daily;
    var today = d.day;
    var fresh = 0, review = 0;
    d.creditedIds.forEach(function (id) {
      var c = state.learning.completions[id];
      if (c && c.firstPassDay === today) fresh += 1;
      else review += 1;
    });
    var sp = L.sectionProgress(state, SECTIONS);
    var needs = sp.sections.reduce(function (n, s) { return n + s.needsFix; }, 0);
    return '今天完成 ' + fresh + ' 道新题、复查 ' + review +
      ' 题；待修正 ' + needs + ' 题。下次主动作：' + (nextPlanItem() ? '继续今天这一组的下一项' : '从待复查或下一段继续') + '。' +
      '错过一天不退段、不扣 XP，下次从上次的位置继续即可。';
  }

  function showTodayWrap(celebrate) {
    var box = $('today-wrap');
    if (!box) return;
    $('today-wrap-title').textContent = todayWrapTitle();
    $('today-wrap-body').textContent = todayWrapText();
    show(box, true);
    if (celebrate) announce('今日目标已完成。');
  }

  /* ------------------------------ 顶栏统计：进度 + 游戏化指标 ------------------------------ */
  function currentSection() {
    var q = currentQuestion();
    if (q && SECTION_OF[q.id]) return SECTION_OF[q.id];
    return SECTIONS[0] || null;
  }

  function repeats(ch, n) { var s = ''; for (var i = 0; i < n; i++) s += ch; return s; }

  /* 顶栏只留段进度 / 题目入口 / 设置入口；游戏化指标收进「学习记录」。 */
  function renderStats() {
    var sec = currentSection();
    var stage = $('stat-stage');
    if (sec && stage) {
      var done = passedInSection(sec);
      stage.textContent = '第 ' + sec.section + ' 段 · 已完成 ' + done + '/' + sec.questions.length;
    }
    var bar = $('stat-bar');
    if (bar && sec) {
      bar.style.width = (sec.questions.length ? Math.round(passedInSection(sec) / sec.questions.length * 100) : 0) + '%';
    }
    var xp = $('stat-xp');
    if (xp) xp.textContent = 'XP ' + state.xp;
    var streak = $('stat-streak');
    if (streak) {
      var act = (state.learning && state.learning.activity) || {};
      streak.textContent = '连续 ' + (act.activeDays || 0) + ' 天';
    }
    var goal = $('stat-goal');
    if (goal) {
      var d = state.learning.daily;
      var credited = (d.creditedIds || []).length;
      var met = L.goalMet(state);
      goal.textContent = '今日 ' + Math.min(credited, d.goal) + '/' + d.goal + (met ? ' \u2713' : '') +
        (d.legacyCarry > 0 ? '（升级前已完成 ' + d.legacyCarry + ' 项）' : '');
      goal.className = 'stat stat-goal' + (met ? ' is-met' : '');
    }
    var prog = $('stat-progress');
    if (prog && L.sectionProgress) {
      var sp = L.sectionProgress(state, SECTIONS);
      var nPassed = 0, nNeeds = 0, nDue = 0;
      sp.sections.forEach(function (s) { nPassed += s.passed; nNeeds += s.needsFix; nDue += s.due; });
      prog.textContent = '已完成 ' + nPassed + ' 题 · 待修正 ' + nNeeds + ' 题 · 待复查 ' + nDue + ' 题';
    }
    var persist = $('record-persist');
    if (persist) {
      var memoryOnly = !!(state.learning && state.learning.persistence === 'memoryOnly');
      if (memoryOnly) { persist.textContent = '本次进度尚未保存到浏览器（刷新可能丢失）；重试保存不会重复加分。'; show(persist, true); }
      else { persist.textContent = ''; show(persist, false); }
    }
    renderAttempts();
    renderTodayGroup();
  }

  /* 本题三次尝试：以状态机 learning.attempts 为准，不画血条、不显示生命值。 */
  function renderAttempts() {
    var node = $('q-attempts');
    if (!node) return;
    var q = currentQuestion();
    if (!q) { node.textContent = ''; return; }
    var a = state.learning && state.learning.attempts ? state.learning.attempts[q.id] : null;
    if (a && a.mode === 'guided') {
      node.textContent = '本题进入跟练模式（运行 / 改写 / 提示 / 看答案仍可用）';
      return;
    }
    var left = a ? a.attemptsLeft : L.HEARTS_PER_LEVEL;
    node.textContent = '本题独立尝试剩余 ' + left + ' 次';
  }

  /* ------------------------------ 左栏题号列表 ------------------------------ */
  function questionMatches(q) {
    var kw = String(filter.kw || '').trim().toLowerCase();
    if (kw) {
      var hay = ('#' + q.seq + ' ' + q.id + ' ' + (q.title || '') + ' ' + (q.knowledge_point || '') +
        ' ' + (q.subject || '') + ' ' + ((q.tags || []).join(' '))).toLowerCase();
      if (hay.indexOf(kw) === -1) return false;
    }
    var on = Object.keys(filter.diffs).filter(function (k) { return filter.diffs[k]; });
    if (on.length && on.indexOf(String(q.level)) === -1) return false;
    if (filter.undoneOnly && state.passed[q.id]) return false;
    return true;
  }

  function renderNav() {
    var nav = $('section-nav');
    if (!nav) return;
    nav.textContent = '';
    var activeSec = currentSection();
    var anyMatch = false;

    SECTIONS.forEach(function (sec) {
      var qs = sec.questions.filter(questionMatches);
      var isActive = activeSec && activeSec.section === sec.section;

      var head = el('div', null, 'group-head' + (isActive ? ' on' : ''));
      head.appendChild(el('span', '第 ' + sec.section + ' 段 · ' + sec.title, 'group-title'));
      /* 段进度分母恒为该段全题数，筛选不改变分母（§4.2 / §5.2）。 */
      head.appendChild(el('span', passedInSection(sec) + '/' + sec.questions.length, 'group-count'));
      nav.appendChild(head);

      if (!qs.length) { nav.appendChild(el('div', '本段没有匹配的题', 'group-empty')); return; }

      var ul = el('ul', null, 'qgroup');
      qs.forEach(function (q) {
        anyMatch = true;
        var li = el('li', null, q.id === currentId ? 'on' : '');
        li.setAttribute('role', 'button');
        li.setAttribute('tabindex', '0');
        li.setAttribute('data-qid', q.id);
        li.setAttribute('aria-label', '第 ' + sec.section + ' 段第 ' + sectionIndexOf(sec, q) + ' 题：' + (q.title || q.id));
        var row = el('div', null, 'q-row');
        row.appendChild(el('span', pad2(q.seq), 'no'));
        row.appendChild(el('span', q.title || q.id, 'qt'));
        li.appendChild(row);

        var meta = el('span', null, 'qmeta');
        meta.appendChild(el('span', q.subject || '-', 'chip solid'));
        meta.appendChild(el('span', 'L' + q.level, 'chip'));
        /* 「已完成」和「待复查 / 待修正」可以同时出现，不互相遮盖（§4.2）。 */
        if (state.passed[q.id]) meta.appendChild(el('span', '已完成', 'chip ok'));
        else if (state.wrong[q.id]) meta.appendChild(el('span', '待重做', 'chip warn'));
        var rv = state.learning.review[q.id];
        if (rv && rv.status === 'due') meta.appendChild(el('span', '待复查', 'chip warn'));
        else if (rv && rv.status === 'needsFix') meta.appendChild(el('span', '待修正', 'chip warn'));
        /* 搜索结果标段号 + 段内位置，避免 q005→q064 像难度跳变。 */
        if (String(filter.kw || '').trim()) {
          meta.appendChild(el('span', '本段第 ' + sectionIndexOf(sec, q) + ' 题', 'chip'));
        }
        li.appendChild(meta);

        li.addEventListener('click', function () { selectLevel(q.id, false); });
        li.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectLevel(q.id, true); }
        });
        ul.appendChild(li);
      });
      nav.appendChild(ul);
    });

    if (!anyMatch) {
      var empty = el('div', null, 'group-empty');
      empty.appendChild(el('span', '没有匹配的题。'));
      var clr = el('button', '清空筛选', 'link-btn');
      clr.type = 'button';
      clr.addEventListener('click', function () { clearFilters(); announce('已清空筛选。'); });
      empty.appendChild(clr);
      nav.appendChild(empty);
    }
  }

  function selectLevel(id, fromKeyboard) {
    if (!QUESTION_BY_ID[id]) return;
    currentId = id;
    state.current = id;
    saveProgress();
    renderNav();
    renderStats();
    renderDetail();
    if (openPanel === 'rail') closePanel();
    /* 切题后焦点回到合理位置：键盘激活时把焦点放回被选中的题行。 */
    if (fromKeyboard) {
      var li = document.querySelector('#section-nav li[data-qid="' + id + '"]');
      if (li && li.focus) li.focus();
    }
  }

  /* ------------------------------ 渐进提示（一个动作 + 一个计数） ------------------------------ */
  function hintTexts(q) {
    var list = L.hintList(q).slice();
    /* HRIS 裁定 3：本题结果规模数字移到渐进提示最后一层；
       expected_note 里的答案数字（以「正确答案」开头）永不上屏、不进判题。 */
    var note = q && q.expected_note;
    /* 字段不存在或为空串时不得渲染任何提示块：只认非空字符串。 */
    if (typeof note === 'string' && note.trim() && note.indexOf('正确答案') !== 0) list.push(note);
    return list;
  }

  function hintSeen(q) {
    var list = hintTexts(q);
    var n = state.hintSeen[q.id] || 0;
    /* 判错过的关至少解锁第一条（兼容 v1 状态里没有 hintSeen 的情况） */
    if (state.wrong[q.id] && n === 0 && list.length) n = 1;
    n = Math.max(0, Math.min(n, list.length));
    return n;
  }

  function revealNextHint() {
    var q = currentQuestion();
    if (!q) return;
    var list = hintTexts(q);
    var n = Math.min(hintSeen(q) + 1, list.length);
    state.hintSeen[q.id] = n;
    saveProgress();
    renderHints(q);
    if (n > 0 && list[n - 1]) announce('已展开提示 ' + n + '/' + list.length + '：' + list[n - 1]);
    else if (!list.length) announce('本题未提供提示。');
  }

  function renderHints(q) {
    var list = hintTexts(q);
    var seen = hintSeen(q);
    state.hintSeen[q.id] = seen;
    var ul = $('hint-list');
    ul.textContent = '';
    for (var i = 0; i < seen; i++) ul.appendChild(el('li', list[i]));
    show($('hint-empty'), seen === 0 && list.length > 0);

    var btn = $('btn-hint');
    if (!btn) return;
    if (!list.length) { btn.textContent = '本题未提供提示'; btn.disabled = true; return; }
    var all = seen >= list.length;
    btn.disabled = all;
    btn.textContent = (all ? '提示已全部解锁' : '看下一条提示') + '（' + seen + '/' + list.length + '）';
  }

  /* ------------------------------ 表结构速查（只列结构，零数据行） ------------------------------ */
  function buildFieldTable(table, matchedFields) {
    var mark = {};
    (matchedFields || []).forEach(function (n) { mark[String(n).toUpperCase()] = true; });
    var tbl = el('table', null, 'field-table');
    var cg = document.createElement('colgroup');
    ['c1', 'c2', 'c3', ''].forEach(function (c) {
      var col = document.createElement('col');
      if (c) col.className = c;
      cg.appendChild(col);
    });
    tbl.appendChild(cg);
    var thead = document.createElement('thead');
    var htr = document.createElement('tr');
    ['字段', '类型', '可空', '业务含义'].forEach(function (h) { htr.appendChild(el('th', h)); });
    thead.appendChild(htr);
    tbl.appendChild(thead);
    var tbody = document.createElement('tbody');
    table.fields.forEach(function (f) {
      var tr = document.createElement('tr');
      if (mark[f.name.toUpperCase()]) tr.className = 'is-match';
      tr.appendChild(el('td', f.name, 'f-name'));
      tr.appendChild(el('td', f.type, 'f-type'));
      tr.appendChild(el('td', f.nullable ? '是' : '否', 'f-null'));
      var note = el('td', f.note, 'f-note');
      note.title = f.note || '';
      tr.appendChild(note);
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    return tbl;
  }

  function tableChip(name, matchedFields, open) {
    var t = T ? T.getTable(name) : null;
    var det = document.createElement('details');
    det.className = 'tbl-chip';
    if (open) det.open = true;
    var sum = document.createElement('summary');
    sum.appendChild(el('span', name, 'tbl-chip-name'));
    if (t) {
      sum.appendChild(el('span', t.cn_name, 'tbl-chip-cn'));
      /* HRIS 裁定 1：每张表标「共 N 行」，口径取 data/rowcount_expected.json（BOOT.rowcountExpected），不写死；
         视图不走 tableChip 这条渲染路径（renderTablesPanel 用 view-row 单独渲染），故视图天然不标。 */
      var rc = (BOOT.rowcountExpected || {})[name];
      sum.appendChild(el('span', t.fields.length + ' 字段' + (typeof rc === 'number' ? ' · 共 ' + rc + ' 行' : ''), 'tbl-chip-count'));
    } else {
      sum.appendChild(el('span', '（结构表未登记）', 'tbl-chip-cn'));
    }
    det.appendChild(sum);
    if (t) {
      var body = el('div', null, 'tbl-chip-body');
      if (t.role) body.appendChild(el('div', '业务角色：' + t.role, 'tbl-role'));
      body.appendChild(buildFieldTable(t, matchedFields));
      det.appendChild(body);
    }
    return det;
  }

  /* 每题题干预设区：列出该题涉及的表，点开看全字段（默认收起）。 */
  function renderQuestionTables(q) {
    var block = $('tables-toggle');
    var box = $('q-tables');
    if (!block || !box) return;
    if (!T) { show(block, false); return; }
    var names = tablesOf(q);
    if (!names.length) { show(block, false); return; }
    box.textContent = '';
    names.forEach(function (n) { box.appendChild(tableChip(n, [], false)); });
    var cap = $('q-tables-cap');
    if (cap) cap.textContent = names.length + ' 张表 · 只给结构，不含数据行';
    show(block, true);
  }

  /* R-003：本题涉及字段里凡 *Code 字段，直接列出该题用得到的码值（字段名 ＋ 码值 ＋ 中文）。
     码值一律现查 HR_DICT，不写死在题目里——以后改码值不会不同步。 */
  function dictTypesInDb() {
    /* 现查 HR_DICT 里实际存在的字典类型；查不到就返回空 → 整块不显示，不报错。 */
    if (!dbReady || !db) return [];
    try {
      var res = window.HRDb.runQuery(db, 'SELECT DISTINCT DictType AS dt FROM HR_DICT');
      return (res.rows || []).map(function (r) { return String(r[0]); });
    } catch (e) { return []; }
  }

  function fieldNoteOf(fieldName) {
    /* 兜底通道：该字段说明里显式写了「HR_DICT 的 XXX」时，按它认字典。 */
    if (!T || !T.allTables) return '';
    var all = T.allTables();
    for (var i = 0; i < all.length; i++) {
      var fs2 = all[i].fields || [];
      for (var j = 0; j < fs2.length; j++) {
        if (fs2[j].name === fieldName) return String(fs2[j].note || '');
      }
    }
    return '';
  }

  function dictTypeOfField(fieldName, allTypes) {
    /* 通道 1：字段名去 Code 后缀 → SCREAMING_SNAKE
       （EducationCode → EDUCATION、EmpTypeCode → EMP_TYPE），再拿 HR_DICT 实有类型自校验。 */
    var base = String(fieldName || '').replace(/Code$/, '');
    var guess = base.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
    if (allTypes.indexOf(guess) !== -1) return guess;
    /* 通道 2：字段说明里写了「HR_DICT 的 XXX」。 */
    var m = fieldNoteOf(fieldName).match(/HR_DICT\s*的\s*([A-Z_]+)/);
    if (m && allTypes.indexOf(m[1]) !== -1) return m[1];
    return null;
  }

  function dictValuesOf(dictType) {
    try {
      var res = window.HRDb.runQuery(db,
        "SELECT Code, Title FROM HR_DICT WHERE DictType = '" + dictType + "' ORDER BY SortNo");
      return res.rows || [];
    } catch (e) { return []; }
  }

  function codeFieldsInQuestion(q) {
    /* 本题用到的 *Code 字段：从参考 SQL 里取（判题基准就是它，口径一致）。 */
    var sql = String((q && (q.reference_sql_sqlite || q.reference_sql)) || '');
    var found = sql.match(/\b[A-Za-z_][A-Za-z0-9_]*Code\b/g) || [];
    var uniq = [];
    found.forEach(function (f) { if (uniq.indexOf(f) === -1) uniq.push(f); });
    return uniq;
  }

  /* 题面常驻标签行：考点 / 次要考点 / 标签。与题面同层，不放进任何折叠容器。 */
  function renderTags(q) {
    var host = $('q-tags');
    if (!host) return;
    host.textContent = '';
    if (!q) return;
    var kp = String(q.knowledge_point || '').trim();
    if (kp) host.appendChild(el('span', '考点 ' + kp, 'tag tag-main'));
    (Array.isArray(q.secondary_points) ? q.secondary_points : []).forEach(function (p) {
      p = String(p === null || p === undefined ? '' : p).trim();
      if (p) host.appendChild(el('span', '次要 ' + p, 'tag'));
    });
    (Array.isArray(q.tags) ? q.tags : []).forEach(function (t) {
      t = String(t === null || t === undefined ? '' : t).trim();
      if (t) host.appendChild(el('span', '#' + t, 'tag tag-soft'));
    });
  }

  /* 单张语法卡：未确认时展示四要素 + 主按钮「已看过，开始尝试」；
     已确认时收起为一行「语法回看」，可再展开看四要素。按钮与展开态都带 aria 属性。 */
  function syntaxCardNode(c, i, qid) {
    var card = el('div', null, 'syntax-card');
    var bodyId = 'syntax-body-' + qid + '-' + i;
    var seen = !!(L && state && typeof L.isSyntaxSeen === 'function' && L.isSyntaxSeen(state, c.syntax));

    card.appendChild(el('div', c.syntax, 'syntax-name'));

    var body = el('div', null, 'syntax-body');
    body.id = bodyId;
    [['说明', c.what, ''], ['何时用', c.when, ''], ['示例', c.example, 'syntax-code'], ['常见误用', c.misuse, '']]
      .forEach(function (pair) {
        var row = el('div', null, 'syntax-row');
        row.appendChild(el('b', pair[0] + '：'));
        row.appendChild(el('span', pair[1], pair[2]));
        body.appendChild(row);
      });
    card.appendChild(body);

    var actions = el('div', null, 'syntax-actions');
    if (seen) {
      var toggle = el('button', '语法回看：' + c.syntax, 'link-btn syntax-review-toggle');
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-controls', bodyId);
      body.hidden = true;
      toggle.addEventListener('click', function () {
        var willOpen = body.hidden;
        body.hidden = !willOpen;
        toggle.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      });
      actions.appendChild(toggle);
    } else {
      var btn = el('button', '已看过，开始尝试', 'btn ghost sm btn-syntax-seen');
      btn.type = 'button';
      btn.setAttribute('aria-expanded', 'true');
      btn.setAttribute('aria-controls', bodyId);
      btn.addEventListener('click', function () {
        /* 只记阅读状态并落盘：不加 XP、不计今日目标、不扣尝试次数 */
        if (L && state) L.markSyntaxSeen(state, c.syntax, L.todayStamp());
        saveProgress();
        var fresh = syntaxCardNode(c, i, qid);
        if (card.parentNode) card.parentNode.replaceChild(fresh, card);
        announce('已记录看过语法：' + c.syntax);
      });
      actions.appendChild(btn);
      body.hidden = false;
    }
    card.appendChild(actions);
    return card;
  }

  /* syntax_intro 首现卡片：SYNTAX_BY_ID 已按 section→seq 扫好，只渲染首现项；
     无有效卡片时整块隐藏（不出现空壳）。与题面同层，不放进任何折叠容器。 */
  function renderSyntaxCards(q) {
    var host = $('q-syntax');
    if (!host) return;
    host.textContent = '';
    host.hidden = true;
    var cards = q ? SYNTAX_BY_ID[q.id] : null;
    if (!cards || !cards.length) return;
    cards.forEach(function (c, i) {
      host.appendChild(syntaxCardNode(c, i, q.id));
    });
    host.hidden = false;
  }

  /* 回看入口点「语法卡」时展开已收起的卡（不改阅读状态、不动首次教学卡按钮状态）。 */
  function expandSyntaxCards() {
    var host = $('q-syntax');
    if (!host) return;
    var bodies = host.querySelectorAll('.syntax-body');
    for (var i = 0; i < bodies.length; i++) {
      if (!bodies[i].hidden) continue;
      bodies[i].hidden = false;
      var card = bodies[i].parentNode;
      var toggle = card ? card.querySelector('.syntax-review-toggle') : null;
      if (toggle) toggle.setAttribute('aria-expanded', 'true');
    }
  }

  /* ---------------------------- 问一问（本地离线问答面板，默认收起） ---------------------------- */
  var qaIndex = null;

  function qaEnsureIndex() {
    if (qaIndex || !QA) return qaIndex;
    qaIndex = QA.buildIndex({
      tables: T ? T.allTables() : [],
      questions: QUESTIONS,
      syntaxCards: SYNTAX_BY_ID
    });
    return qaIndex;
  }

  function qaContextText() {
    var q = currentQuestion();
    return q ? ('当前题：#' + pad2(q.seq) + ' ' + (q.title || q.id)) : '未选题：只答表结构 / 字段 / 语法卡。';
  }

  function qaNode(res) {
    var card = el('div', null, 'qa-answer ' + (res.ok ? 'is-hit' : 'is-miss'));
    card.appendChild(el('div', res.title, 'qa-title'));
    (res.lines || []).forEach(function (l) { card.appendChild(el('div', l, 'qa-line')); });
    if (res.source) card.appendChild(el('div', '来源：' + res.source, 'qa-source'));
    if (res.hint) card.appendChild(el('div', res.hint, 'qa-hint'));
    return card;
  }

  function qaCompareNode(cmp) {
    var card = el('div', null, 'qa-answer ' + (cmp.ok ? 'is-hit' : 'is-miss'));
    card.appendChild(el('div', '与参考 SQL 的结构对比', 'qa-title'));
    (cmp.observations || []).forEach(function (o) { card.appendChild(el('div', o, 'qa-line')); });
    if (cmp.notes && cmp.notes.length) card.appendChild(el('div', cmp.notes.join(' '), 'qa-hint'));
    card.appendChild(el('div', '来源：当前题参考答案 + 你的编辑器 SQL', 'qa-source'));
    return card;
  }

  function qaRun(text) {
    var input = $('qa-input');
    var box = $('qa-results');
    if (!box) return;
    if (text !== undefined && input) input.value = text;
    var asked = input ? input.value : '';
    box.textContent = '';
    if (!QA) { box.appendChild(el('div', '问一问模块未加载。', 'qa-line')); return; }
    var cur = currentQuestion();
    if (String(asked).indexOf('对比') !== -1) {
      var ref = cur ? (cur.reference_sql_sqlite || cur.reference_sql || '') : '';
      var userSql = $('sql-input') ? $('sql-input').value : '';
      box.appendChild(qaCompareNode(QA.compareToReference(userSql, ref)));
      return;
    }
    box.appendChild(qaNode(QA.ask(asked, { index: qaEnsureIndex(), question: cur })));
  }

  function qaSetOpen(on) {
    var body = $('qa-body'), toggle = $('qa-toggle'), caret = $('qa-caret');
    if (!body || !toggle) return;
    body.hidden = !on;
    toggle.setAttribute('aria-expanded', on ? 'true' : 'false');
    if (caret) caret.classList.toggle('open', on);
    if (on) { var input = $('qa-input'); if (input) input.focus(); }
  }

  function renderDictHints(q) {
    var host = $('q-dict-hints');
    if (!host) return;
    host.textContent = '';
    host.hidden = true;
    if (!q) return;
    var fields = codeFieldsInQuestion(q);
    if (!fields.length) return;
    var allTypes = dictTypesInDb();
    if (!allTypes.length) return;
    var parts = [];
    var usedDicts = [];
    fields.forEach(function (fn) {
      var dt = dictTypeOfField(fn, allTypes);
      if (!dt) return;
      var vals = dictValuesOf(dt);
      if (!vals.length) return;
      parts.push({ field: fn, dict: dt, vals: vals });
      if (usedDicts.indexOf(dt) === -1) usedDicts.push(dt);
    });
    if (!parts.length) return;
    host.appendChild(el('div', '本题用到 ' + usedDicts.join(' / ') + '（共 ' + usedDicts.length +
      ' 类字典），该题用得到的码值如下：', 'dh-cap'));
    parts.forEach(function (p) {
      var item = el('div', null, 'dh-item');
      item.appendChild(el('div', p.field + '（字典 ' + p.dict + '）', 'dh-head'));
      var line = el('div', null, 'dh-vals');
      p.vals.forEach(function (r) {
        var span = el('span', null, 'dh-val');
        span.appendChild(el('b', String(r[0]), 'dh-code'));
        span.appendChild(document.createTextNode('=' + String(r[1])));
        line.appendChild(span);
      });
      item.appendChild(line);
      host.appendChild(item);
    });
    host.hidden = false;
  }

  function toggleQuestionTables() {
    var body = $('q-tables-body');
    if (!body) return;
    body.hidden = !body.hidden;
    var caret = $('q-tables-caret');
    if (caret) caret.classList.toggle('open', !body.hidden);
    var head = $('tables-toggle-head');
    if (head) head.setAttribute('aria-expanded', String(!body.hidden));
  }

  /* 右侧抽屉「表结构」页签：可搜索、可点开；末尾附 3 个视图（只列作用）。 */
  function renderTablesPanel(keyword) {
    var list = $('tables-list');
    if (!list || !T) return;
    var kw = String(keyword || '').trim();
    list.textContent = '';
    var results = T.searchTables(kw);
    if (!results.length) {
      list.appendChild(el('div', '没有匹配的表或字段。', 'muted'));
    } else {
      results.forEach(function (r) { list.appendChild(tableChip(r.table.name, r.matchedFields, false)); });
    }
    var lower = kw.toLowerCase();
    var views = T.allViews().filter(function (v) {
      return !kw || v.name.toLowerCase().indexOf(lower) !== -1 || v.purpose.toLowerCase().indexOf(lower) !== -1;
    });
    if (views.length) {
      list.appendChild(el('div', '视图（只列作用，无字段明细）', 'tables-subhead'));
      views.forEach(function (v) {
        var row = el('div', null, 'view-row');
        row.appendChild(el('span', v.name, 'tbl-chip-name'));
        row.appendChild(el('span', v.purpose, 'tbl-chip-cn'));
        list.appendChild(row);
      });
    }
  }

  /* ------------------------------ 抽屉 / 左栏浮层 ------------------------------ */
  function setDrawerTab(tab) {
    var tt = $('tab-tables'), td = $('tab-dialect');
    if (tt) { tt.classList.toggle('on', tab === 'tables'); tt.setAttribute('aria-selected', String(tab === 'tables')); }
    if (td) { td.classList.toggle('on', tab === 'dialect'); td.setAttribute('aria-selected', String(tab === 'dialect')); }
    show($('panel-tables'), tab === 'tables');
    show($('panel-dialect'), tab === 'dialect');
  }

  function openDrawer(tab) {
    setDrawerTab(tab);
    show($('drawer'), true);
    var d = $('drawer');
    if (d) d.setAttribute('aria-hidden', 'false');
    show($('scrim'), true);
    openPanel = 'drawer';
  }

  function openRail() {
    var r = $('rail');
    if (r) r.classList.add('is-open');
    show($('scrim'), true);
    openPanel = 'rail';
  }

  function closePanel() {
    show($('drawer'), false);
    var d = $('drawer');
    if (d) d.setAttribute('aria-hidden', 'true');
    var r = $('rail');
    if (r) r.classList.remove('is-open');
    show($('scrim'), false);
    openPanel = null;
  }

  /* ------------------------------ 单关渲染 ------------------------------ */
  function renderDetail() {
    var q = currentQuestion();
    show($('detail-empty'), !q);
    show($('detail-body'), !!q);
    /* 问一问：换题时刷新上下文、清掉上一题的回答，避免串味。 */
    var qaCtx = $('qa-context');
    if (qaCtx) qaCtx.textContent = qaContextText();
    var qaBox = $('qa-results');
    if (qaBox) qaBox.textContent = '';
    if (!q) return;

    $('q-title').textContent = '#' + pad2(q.seq) + ' ' + (q.title || q.id);
    var lv = $('q-level');
    if (lv) {
      var sec = SECTION_OF[q.id];
      lv.textContent = sec ? ('段' + sec.section + ' · ' + sec.title) : '难度 L' + q.level;
    }

    /* 题面 meta 行：压成一行 12px 灰字；与考点/业务域重复的标签删掉。 */
    var meta = $('q-meta');
    meta.textContent = '';
    var kp = String(q.knowledge_point || ''), subj = String(q.subject || '');
    var parts = ['难度 L' + q.level, '业务域 ' + (subj || '-'), '考点 ' + (kp || '-'), '题号 ' + q.id];
    var uniq = [];
    (Array.isArray(q.tags) ? q.tags : []).forEach(function (t) {
      t = String(t);
      if (!t || kp.indexOf(t) !== -1 || subj.indexOf(t) !== -1) return;
      if (uniq.indexOf(t) !== -1) return;
      uniq.push(t);
    });
    if (uniq.length) parts.push('标签 ' + uniq.join(' / '));
    parts.forEach(function (t) { meta.appendChild(el('span', t)); });
    renderTags(q);

    var principle = $('q-principle');
    principle.textContent = '';
    principle.appendChild(el('div', '主考点：' + (kp || '-')));
    if (Array.isArray(q.secondary_points) && q.secondary_points.length) {
      principle.appendChild(el('div', '次要考点：' + q.secondary_points.join(' / ')));
    }
    principle.appendChild(el('div', '本题在结果集层面判分：只比跑出来的行与列，不比 SQL 写法。', 'muted'));

    $('q-stem').textContent = q.stem || '';
    $('q-requirement').textContent = q.requirement || '';
    $('q-output').textContent = q.output_hint || '';

    /* 涉及的表 / 字段：默认收起 */
    var tbody = $('q-tables-body');
    if (tbody) tbody.hidden = true;
    var caret = $('q-tables-caret');
    if (caret) caret.classList.remove('open');
    var thead = $('tables-toggle-head');
    if (thead) thead.setAttribute('aria-expanded', 'false');
    renderQuestionTables(q);
    renderDictHints(q);
    renderSyntaxCards(q);

    var sqlInput = $('sql-input');
    sqlInput.value = state.sql[q.id] || '';
    checkForbidden();

    renderHints(q);

    /* 参考 SQL 缺失时禁用查看答案并说明原因。 */
    var ansBtn = $('btn-answer');
    if (ansBtn) {
      var hasAnswer = !!(q.reference_sql || q.reference_sql_sqlite);
      ansBtn.disabled = !hasAnswer;
      ansBtn.textContent = hasAnswer ? '查看答案' : '本题无参考答案';
      ansBtn.title = hasAnswer ? '' : '题库未提供 reference_sql，禁用查看答案';
    }

    show($('ref-review-block'), false);
    show($('verdict'), false);
    show($('result-block'), false);
    show($('answer-block'), false);
    lastRun = null;

    var post = $('post-pass-block');
    if (state.passed[q.id]) { renderPostPass(q); show(post, true); } else { show(post, false); }

    /* 段末总结：所在段已完成时可回看（旧用户回看不重发 XP，不问是否首次）。 */
    var transNow = L.sectionTransition(state, SECTIONS, q.id);
    renderSectionSummary(transNow, false);
    renderNextAction({
      sectionCompleted: !!(transNow && transNow.completed),
      goalMet: L.goalMet(state)
    });

    renderStats();
  }

  function renderPostPass(q) {
    var ul = $('q-pitfalls');
    ul.textContent = '';
    (q.pitfalls || []).forEach(function (p) { ul.appendChild(el('li', p)); });
    if (!(q.pitfalls || []).length) ul.appendChild(el('li', '题库未登记易错点。'));
    $('q-dialect').textContent = q.dialect_note || '本题未登记方言提示。';

    var badge = $('pass-badge');
    if (badge) {
      var sec = SECTION_OF[q.id];
      var all = sec && sec.questions.every(function (x) { return state.passed[x.id]; });
      if (all) { badge.textContent = '第 ' + sec.section + ' 段通关'; show(badge, true); replayAnim(badge, 'hr-anim-pop'); }
      else show(badge, false);
    }
  }

  /* forbidden_syntax 命中只警告不阻断。 */
  function checkForbidden() {
    var q = currentQuestion();
    var warn = $('forbidden-warning');
    if (!q || !Array.isArray(q.forbidden_syntax) || !q.forbidden_syntax.length) { show(warn, false); return; }
    var sql = ($('sql-input').value || '').toUpperCase();
    var hit = q.forbidden_syntax.filter(function (s) {
      var needle = String(s).trim().toUpperCase();
      return needle && sql.indexOf(needle) !== -1;
    });
    if (hit.length) {
      warn.textContent = '本题禁用语法命中：' + hit.join('、') +
        '（仅警告，不阻断）。这题在 SQL Server 里该用别的写法；本页仍允许你跑，看看结果差在哪。';
      show(warn, true);
    } else {
      show(warn, false);
    }
  }

  /* ------------------------------ 结果渲染 ------------------------------ */
  function renderTable(table, columns, rows, limit) {
    table.textContent = '';
    var thead = document.createElement('thead');
    var tr = document.createElement('tr');
    columns.forEach(function (c) {
      tr.appendChild(el('th', c === null || c === undefined ? '(未命名列)' : c));
    });
    thead.appendChild(tr);
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    var n = Math.min(rows.length, limit);
    for (var i = 0; i < n; i++) {
      var r = document.createElement('tr');
      /* 行是每次渲染重建的 DOM，直接挂动画类即可自动播放；只做前 MAX_ROW_ANIM 行。 */
      if (i < MAX_ROW_ANIM) r.className = 'hr-anim-fade-up';
      for (var j = 0; j < columns.length; j++) {
        var v = rows[i][j];
        r.appendChild(el('td', v === null || v === undefined ? 'NULL' : String(v)));
      }
      tbody.appendChild(r);
    }
    table.appendChild(tbody);
  }

  function showResultTab(which) {
    var mine = $('tab-mine'), refTab = $('tab-ref');
    if (mine) mine.classList.toggle('on', which === 'mine');
    if (refTab) refTab.classList.toggle('on', which === 'ref');
    var note = $('result-note');
    var table = $('result-table');

    if (which === 'mine') {
      if (!lastRun) { note.textContent = '还没有运行结果，点上方的「运行」跑一次。'; table.textContent = ''; return; }
      renderTable(table, lastRun.columns, lastRun.rows, MAX_PREVIEW_ROWS);
      note.textContent = '共 ' + lastRun.rows.length + ' 行、' + lastRun.columns.length + ' 列' +
        (lastRun.rows.length > MAX_PREVIEW_ROWS ? '，仅显示前 ' + MAX_PREVIEW_ROWS + ' 行。' : '。') +
        (lastRun.truncated ? '（已达单次查询上限 ' + window.HRDb.MAX_ROWS + ' 行，结果被截断。）' : '');
      return;
    }

    var q = currentQuestion();
    if (!q) return;
    if (!dbReady) { note.textContent = '数据库尚未就绪，请稍后重试。'; table.textContent = ''; return; }
    var ref = referenceResult(q);
    if (!ref.ok) { note.textContent = '预期结果：参考 SQL 执行失败（' + ref.error + '）。'; table.textContent = ''; return; }
    renderTable(table, ref.result.columns, ref.result.rows, MAX_PREVIEW_ROWS);
    note.textContent = '预期结果（题库参考 SQL 在本地库实跑，权威源 = SQL Server）·共 ' + ref.result.rows.length + ' 行' +
      (ref.mismatch ? '（与 expected.row_count 不一致，题库待复核）' : '');
  }

  /* 提示 / 警告 / 错误共用同一套卡片样式（左侧 3px 色条 + 浅底）。 */
  var VERDICT_MOD = { pass: 'is-ok', fail: 'is-err', warn: 'is-warn' };

  /* 差异类型由 verdict 现有字段派生（不新增判题口径）。 */
  function diffTypeOf(verdict, orderSensitive) {
    if (!verdict) return null;
    if (verdict.columnIssue) {
      return verdict.columnIssue.kind === 'count'
        ? '差异类型：列数不同'
        : '差异类型：列名 / 列位对齐不同';
    }
    var kinds = {};
    (verdict.diffRows || []).forEach(function (d) { kinds[d.kind] = true; });
    if (kinds.missing) return '差异类型：缺失行（预期里有、你的结果里没有）';
    if (kinds.extra) return '差异类型：多余行（你的结果里有、预期里没有）';
    if (kinds.changed) return orderSensitive ? '差异类型：顺序不同或数值不符' : '差异类型：数值不符（行对上了，值不同）';
    if (verdict.userRowCount != null && verdict.refRowCount != null && verdict.userRowCount !== verdict.refRowCount) {
      return '差异类型：行数不同';
    }
    return '差异类型：行集不一致';
  }

  /* 只给一个最相关动作；来源是 pitfalls 时只能写「可以检查」，不断言根因。 */
  function firstActionHint(q, verdict) {
    var pit = (q && Array.isArray(q.pitfalls)) ? q.pitfalls : [];
    if (verdict && verdict.columnIssue) return '可以检查：SELECT 里选了几列、是否漏了聚合列或分组列。';
    var kinds = {};
    (verdict && verdict.diffRows || []).forEach(function (d) { kinds[d.kind] = true; });
    if (kinds.missing) return '可以检查：筛选条件是否排除了空值（NULL），或 JOIN 条件是否过严。';
    if (kinds.extra) return '可以检查：WHERE 条件是否漏写，多表连接是否缺了限制。';
    if (kinds.changed) return '可以检查：聚合口径、四舍五入或金额单位是否和题面一致。';
    if (pit.length) return '可以检查：' + pit[0];
    return '可以检查：题面要求的列、行与条件是否都覆盖了。';
  }

  /* 第二次判错把原理 / 语法卡 / 易错点入口露出来（不存在的内容不编造）。 */
  function attachReviewTools(box, q) {
    var wrap = el('div', null, 'review-tools');
    wrap.appendChild(el('span', '回看入口：', 'muted'));
    [['考点提示', 'principle-box'], ['语法卡', 'q-syntax']].forEach(function (t) {
      var node = $(t[1]);
      if (!node || (t[1] === 'q-syntax' && !node.childNodes.length)) return;
      var b = el('button', t[0], 'link-btn');
      b.type = 'button';
      b.addEventListener('click', function () {
        if (t[1] === 'q-syntax') expandSyntaxCards();
        node.scrollIntoView({ block: 'center' });
      });
      wrap.appendChild(b);
    });
    if (Array.isArray(q.pitfalls) && q.pitfalls.length) {
      var det = document.createElement('details');
      det.appendChild(el('summary', '本题易错点'));
      var ul = el('ul');
      q.pitfalls.forEach(function (p) { ul.appendChild(el('li', p)); });
      det.appendChild(ul);
      wrap.appendChild(det);
    }
    if (wrap.childNodes.length > 1) box.appendChild(wrap);
  }

  function renderVerdict(kind, title, verdict, refColumns, extraNote, info) {
    var box = $('verdict');
    box.className = 'card-note ' + (VERDICT_MOD[kind] || 'is-warn');
    box.textContent = '';
    box.appendChild(el('div', title, 'verdict-title'));
    if (extraNote) box.appendChild(el('div', extraNote, 'muted'));
    if (verdict) {
      box.appendChild(el('div', verdict.reason, 'muted'));
      if (verdict.columnIssue) {
        var p = [verdict.columnIssue.message];
        if (verdict.columnIssue.missing && verdict.columnIssue.missing.length) p.push('缺失列：' + verdict.columnIssue.missing.join('、'));
        if (verdict.columnIssue.extra && verdict.columnIssue.extra.length) p.push('多余列：' + verdict.columnIssue.extra.join('、'));
        box.appendChild(el('div', p.join(' '), 'muted'));
      }
      if (verdict.refRowCount == null) {
        box.appendChild(el('div', '预期行数 —（SQL 未跑通，未计算）', 'muted'));
      } else {
        box.appendChild(el('div', '对齐方式 alignMode=' + verdict.alignMode +
          '；你的行数 ' + verdict.userRowCount + '，预期行数 ' + verdict.refRowCount, 'muted'));
      }
      var dtype = diffTypeOf(verdict, !!(info && info.orderSensitive));
      if (dtype) box.appendChild(el('div', dtype, 'diff-type'));
      var diffs = verdict.diffRows || [];
      if (diffs.length) {
        var fmt = function (d) {
          var label = d.kind === 'extra' ? '多余行' : d.kind === 'missing' ? '缺失行' : '不一致行';
          var cols = Array.isArray(refColumns) && refColumns.length ? ' 列：' + refColumns.join(' | ') : '';
          return '[' + label + ']' + cols + '  ' + JSON.stringify(d.row);
        };
        /* 只展示首个主要证据，其余默认折叠。 */
        box.appendChild(el('div', fmt(diffs[0]), 'diff k-' + diffs[0].kind));
        if (diffs.length > 1) {
          var det = document.createElement('details');
          det.className = 'diff diff-more';
          var sm = document.createElement('summary');
          sm.textContent = '展开更多差异（其余 ' + (diffs.length - 1) + ' 条）';
          det.appendChild(sm);
          diffs.slice(1).forEach(function (d) { det.appendChild(el('div', fmt(d), 'k-' + d.kind)); });
          box.appendChild(det);
        }
      }
    }
    if (info && info.action) box.appendChild(el('div', info.action, 'verdict-action'));
    if (info && info.reviewTools && currentQuestion()) attachReviewTools(box, currentQuestion());
    if (info && info.reviewNote) box.appendChild(el('div', info.reviewNote, 'muted'));
    show(box, true);
    replayAnim(box, 'hr-anim-fade-up');
    if (kind === 'fail') replayAnim($('sql-input'), 'hr-anim-shake');
  }

  function renderRunError(msg) {
    show($('result-block'), false);
    /* 语句级预检优先：漏 FROM 时引擎先抛 no such column，只翻译报错文本会把学员引去核列名。 */
    var sql = ($('sql-input') && $('sql-input').value) || '';
    var triage = sqlTriage(sql);
    renderVerdict('fail', 'SQL 执行错误（原样展示）：', {
      reason: msg, columnIssue: null, diffRows: [], alignMode: 'none', userRowCount: null, refRowCount: null
    }, null, '人话：' + (triage ? triage : explainError(msg)));
  }

  /* ------------------------------ 数据库 / 参考结果 ------------------------------ */
  /* 预期结果 = 现场跑 reference_sql_sqlite，不信任写死的结果行；再与 expected.row_count 对账。
     对不上就打「题库待复核」并跳过判题 —— 把锅算在题库上，不算在学员头上。 */
  function referenceResult(q) {
    if (refCache[q.id] !== undefined) return refCache[q.id];
    var out = { ok: false, error: null, result: null, expectedRowCount: null, mismatch: false };
    var sql = q.reference_sql_sqlite || q.reference_sql || '';
    try {
      /* 参考结果只在干净的 refDb 上跑，与用户作答库 db 完全隔离。 */
      out.result = window.HRDb.runQuery(refDb, sql);
      out.ok = true;
      var exp = q.expected && typeof q.expected.row_count === 'number' ? q.expected.row_count : null;
      out.expectedRowCount = exp;
      out.mismatch = exp !== null && out.result.rows.length !== exp;
    } catch (e) {
      out.error = String(e && e.message ? e.message : e);
    }
    refCache[q.id] = out;
    return out;
  }

  function requireDb() {
    if (dbReady) return true;
    renderVerdict('warn', '数据库尚未就绪，请等待顶部初始化提示消失后重试。', null, null);
    return false;
  }

  /* 忙态：运行 / 判题期间禁用按钮、给文案与 aria-busy，结束原样恢复（#live-status 不动）。 */
  function setBusy(btn, on, busyText) {
    if (!btn) return;
    if (on) {
      if (busyText) {
        if (!btn.hasAttribute('data-busy-label')) btn.setAttribute('data-busy-label', btn.textContent);
        btn.textContent = busyText;
      }
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
    } else {
      var lbl = btn.getAttribute('data-busy-label');
      if (lbl !== null) { btn.textContent = lbl; btn.removeAttribute('data-busy-label'); }
      btn.removeAttribute('aria-busy');
      btn.disabled = false;
    }
  }

  var running = false;

  /* 实际执行抽出来：忙态已就位后再跑，结束时由 doRun 统一恢复按钮。 */
  function runNow() {
    var q = currentQuestion();
    var sql = $('sql-input').value;
    var res;
    try {
      res = window.HRDb.runQuery(db, sql);
    } catch (e) {
      renderRunError(String(e && e.message ? e.message : e));
      return;
    }
    lastRun = { columns: res.columns, rows: res.rows, truncated: !!res.truncated };
    show($('result-block'), true);
    showResultTab('mine');
    if (q) { state.sql[q.id] = sql; saveProgress(); }
  }

  function doRun() {
    if (running || judging) return;
    if (!requireDb()) return;
    if (!$('sql-input').value.trim()) { renderVerdict('warn', '请先写 SQL。', null, null); return; }
    running = true;
    setBusy($('btn-run'), true, '运行中…');
    setBusy($('btn-judge'), true);   /* 运行期间判题同样禁用，只禁用不改文案 */
    /* 先让浏览器重绘出忙态，再执行同步查询。 */
    setTimeout(function () {
      try { runNow(); }
      catch (e) { renderRunError(String(e && e.message ? e.message : e)); }
      finally {
        running = false;
        setBusy($('btn-run'), false);
        setBusy($('btn-judge'), false);
      }
    }, 0);
  }

  /* 判题：同步计算，但先给按钮 loading 态让浏览器有机会重绘；不阻塞编辑器输入。 */
  function setJudgeLoading(on) {
    setBusy($('btn-judge'), on, on ? '判题中…' : null);
    setBusy($('btn-run'), on);   /* 判题期间运行同样禁用 */
  }

  function doJudge() {
    if (judging || running) return;
    judging = true;
    /* 判题快照：发起时记下题号，异步回来若已切题就丢弃，不渲染到新题上。 */
    var qid = currentId;
    setJudgeLoading(true);
    setTimeout(function () {
      try {
        if (qid !== currentId) return;
        judgeNow(qid);
      }
      catch (err) {
        if (qid === currentId) renderRunError(String(err && err.message ? err.message : err));
      }
      finally { judging = false; setJudgeLoading(false); }
    }, 0);
  }

  function judgeNow(qid) {
    if (!requireDb()) return;
    qid = qid || currentId;
    if (qid !== currentId) return;
    var q = QUESTION_BY_ID[qid];
    if (!q) return;
    var sql = $('sql-input').value;
    var stamp = L.todayStamp();
    if (!sql.trim()) { renderVerdict('warn', '请先写 SQL 再判题。', null, null); return; }

    var ref = referenceResult(q);
    if (!ref.ok) {
      /* 题库异常：不记用户失败、不消耗次数，允许换题。 */
      $('ref-review-block').textContent = '题库待复核：参考 SQL（reference_sql_sqlite）在当前库上执行失败——' + ref.error + '。本题不判你的对错、不消耗次数。';
      show($('ref-review-block'), true);
      renderVerdict('warn', '本题标记「题库待复核」，跳过判题；你仍可换题继续。', null, null);
      return;
    }
    show($('ref-review-block'), false);

    var res;
    try {
      res = window.HRDb.runQuery(db, sql);
    } catch (e) {
      /* 执行错误不算有效结果判错：只存草稿，不消耗次数。 */
      L.recordLearningAttempt(state, { id: q.id, kind: 'check', sql: sql, ok: false, execOk: false, stamp: stamp });
      saveProgress();
      if (qid !== currentId) return;
      renderRunError(String(e && e.message ? e.message : e));
      renderStats();
      return;
    }

    var orderSensitive = !!(q.expected && q.expected.order_sensitive);
    var verdict = window.HRJudge.judgeResult(
      res.rows, res.columns,
      ref.result.rows, ref.result.columns,
      { orderSensitive: orderSensitive }
    );

    lastRun = { columns: res.columns, rows: res.rows, truncated: !!res.truncated };
    show($('result-block'), true);
    showResultTab('mine');

    if (ref.mismatch) {
      $('ref-review-block').textContent = '题库待复核：参考 SQL 实跑 ' + ref.result.rows.length +
        ' 行，与 expected.row_count=' + ref.expectedRowCount + ' 不一致。本题不判你的对错、不消耗次数（下方结论仅供参考）。';
      show($('ref-review-block'), true);
      renderVerdict('warn', '本题标记「题库待复核」。', verdict, ref.result.columns, null, { orderSensitive: orderSensitive });
      return;
    }

    state.sql[q.id] = sql;

    if (verdict.pass) {
      /* 唯一计分入口：recordLearningAttempt 判 + creditLearningEvent 结算。 */
      var prevCelebrated = !!(state.learning && state.learning.daily && state.learning.daily.goalCelebrated);
      var fb = L.recordLearningAttempt(state, { id: q.id, kind: 'check', sql: sql, ok: true, stamp: stamp });
      var credit = L.creditLearningEvent(state, fb);
      saveProgress();
      var trans = L.sectionTransition(state, SECTIONS, q.id);
      var sectionCompleted = !!(trans && trans.completed);
      var combined = sectionCompleted && !!credit.goalMet;
      lastCombined = combined ? { section: trans.section } : null;
      renderSectionSummary(trans, combined);
      var justCelebrated = !!credit.goalCelebrated && !prevCelebrated;
      if (credit.goalMet && !combined) showTodayWrap(justCelebrated);
      else if (!credit.goalMet) show($('today-wrap'), false);
      renderNextAction({ sectionCompleted: sectionCompleted, goalMet: !!credit.goalMet });
      renderPostPass(q);
      show($('post-pass-block'), true);
      var title, passNote;
      if (fb.duplicate) { title = '通过 —— 与上次判题相同'; passNote = '未重复计数，不重复加 XP。'; }
      else if (fb.firstTime) { title = '通过 —— 首次完成'; passNote = '首次完成 +' + credit.xpGained + ' XP。'; }
      else if (fb.reviewResolved) { title = '通过 —— 复查完成'; passNote = '复查完成，不重复加 XP；这题移出待复查列表。'; }
      else { title = '通过 —— 不重复加 XP'; passNote = '结果与预期一致。'; }
      if (fb.completionType === 'guided') passNote += ' 本次按跟练完成记录。';
      renderVerdict('pass', title, verdict, ref.result.columns, passNote, {
        action: null,
        orderSensitive: orderSensitive
      });
    } else {
      var fb2 = L.recordLearningAttempt(state, { id: q.id, kind: 'check', sql: sql, ok: false, stamp: stamp });
      saveProgress();
      var list = hintTexts(q);
      var before = state.hintSeen[q.id] || 0;
      if (!fb2.duplicate && !fb2.skipped && before < list.length) {
        state.hintSeen[q.id] = before + 1;
        saveProgress();
        announce('已展开提示 ' + state.hintSeen[q.id] + '/' + list.length + '：' + list[state.hintSeen[q.id] - 1]);
      }
      renderHints(q);
      var left = (typeof fb2.attemptsLeft === 'number') ? fb2.attemptsLeft : 0;
      var wrongNo = 3 - left;
      var reviewNote = '';
      if (fb2.duplicate) reviewNote = '与上次判题相同，未重复扣次数。';
      else if (fb2.skipped) reviewNote = '这一步不算有效结果判错，未消耗次数。';
      else if (wrongNo === 1) reviewNote = '第 1 次判错：已记录待修正，并展开第 1 条提示。';
      else if (wrongNo === 2) {
        reviewNote = '第 2 次判错：建议回看本题语法卡与易错点。';
        if (list.length <= 1) reviewNote += ' 本题只有这条提示——不另造第二条，回看入口见下方。';
      } else if (wrongNo >= 3) {
        reviewNote = '已经试了 3 次，换个思路：对照提示拆开检查。运行、改写、提示、看答案仍可用，这题可以暂停、留作待修正。';
      }
      renderVerdict('fail', '未通过 —— 结果与预期不一致，已记录待修正；练习不扣分。', verdict, ref.result.columns, null, {
        action: firstActionHint(q, verdict),
        orderSensitive: orderSensitive,
        reviewTools: wrongNo === 2 || wrongNo >= 3,
        reviewNote: reviewNote
      });
    }
    renderStats();
    renderNav();
    if (verdict.pass) focusNextAction();
  }

  function doAnswer() {
    var q = currentQuestion();
    if (!q) return;
    var mssql = q.reference_sql || '';
    var sqlite = q.reference_sql_sqlite || q.reference_sql || '';
    var btn = $('btn-answer');
    if (!mssql && !sqlite) {
      if (btn) { btn.disabled = true; btn.textContent = '本题无参考答案'; }
      renderVerdict('warn', '本题参考 SQL 缺失，查看答案已禁用（原因：题库未提供 reference_sql）。仍可正常尝试判题。', null, null);
      announce('本题没有参考答案，查看答案已禁用。');
      return;
    }
    /* 先记当前作答轮的 answerSeen，再展示完整答案；退出 / 刷新 / 换题都不清这个标记。 */
    L.recordLearningAttempt(state, { id: q.id, kind: 'answer', stamp: L.todayStamp() });
    saveProgress();
    $('answer-mssql').textContent = q.reference_sql || '（题库未提供 reference_sql）';
    $('answer-sqlite').textContent = q.reference_sql_sqlite || q.reference_sql || '（题库未提供）';
    $('answer-note').textContent = '上方为 SQL Server 权威写法（仅展示、不执行，含 dbo. 前缀）；下方为 SQLite 等价写法，' +
      '判题的预期结果就是它在当前库上现场跑出来的。权威以 SQL Server 版为准。基准日固定 ' + BASELINE_DATE + '。' +
      '已记录本次看了完整答案，通过后将按跟练完成记录，并预约次日复查。';
    show($('answer-block'), true);
    announce('已展开参考答案，本次作答记为跟练。');
    renderAttempts();
  }

  /* ------------------------------ 编辑器字段补全 ------------------------------ */
  /* 补全口径：token 以 HR_ 开头（或含下划线）-> 补表名；其余情况 -> 补「SQL 里已出现的表」
     的字段名，没出现过表名时回退到本题涉及表的字段名。不弹出任何数据行。 */
  function sqlSuggestions(text, caret) {
    if (!T) return [];
    var before = text.slice(0, caret);
    var m = before.match(/([A-Za-z_][A-Za-z0-9_]*)$/);
    var token = m ? m[1] : '';
    if (!token) return [];
    var prefix = token.toUpperCase();
    var upperText = text.toUpperCase();
    var items = [];
    var seen = {};
    function push(label, detail, insert) {
      var k = label.toUpperCase();
      if (seen[k]) return;
      seen[k] = true;
      items.push({ label: label, detail: detail, insert: insert });
    }
    var isTableToken = prefix.indexOf('HR_') === 0 || token.indexOf('_') !== -1;
    if (isTableToken) {
      T.allTables().forEach(function (t) {
        if (t.name.toUpperCase().indexOf(prefix) === 0) push(t.name, t.cn_name, t.name);
      });
      return items.slice(0, 12);
    }
    var namesInText = T.allTables().map(function (t) { return t.name; })
      .filter(function (n) { return upperText.indexOf(n) !== -1; });
    var q = currentQuestion();
    if (!namesInText.length && q) namesInText = tablesOf(q);
    namesInText.forEach(function (n) {
      T.fieldNames(n).forEach(function (f) {
        if (f.toUpperCase().indexOf(prefix) === 0) push(f, n, f);
      });
    });
    return items.slice(0, 12);
  }

  function hideSuggest() {
    var box = $('sql-suggest');
    if (box) { box.hidden = true; box.textContent = ''; }
    suggestItems = [];
    suggestIndex = -1;
  }

  /* ↑/↓ 在候选间循环移动；Enter 用当前选中项；Esc 由输入框 keydown 负责关闭。 */
  function moveSuggest(delta) {
    var box = $('sql-suggest');
    if (!box || box.hidden || !suggestItems.length) return false;
    var n = suggestItems.length;
    if (suggestIndex < 0) suggestIndex = delta > 0 ? 0 : n - 1;
    else suggestIndex = (suggestIndex + delta + n) % n;
    var nodes = box.querySelectorAll('.sql-suggest-item');
    [].forEach.call(nodes, function (node, i) { node.classList.toggle('is-active', i === suggestIndex); });
    if (nodes[suggestIndex]) nodes[suggestIndex].scrollIntoView({ block: 'nearest' });
    return true;
  }

  function updateSuggest() {
    var box = $('sql-suggest');
    var ta = $('sql-input');
    if (!box || !ta) return;
    if (document.activeElement !== ta || ta.selectionStart !== ta.selectionEnd) { hideSuggest(); return; }
    var items = sqlSuggestions(ta.value, ta.selectionStart);
    if (!items.length) { hideSuggest(); return; }
    suggestItems = items;
    suggestIndex = -1;
    box.textContent = '';
    items.forEach(function (it) {
      var b = el('button', null, 'sql-suggest-item');
      b.type = 'button';
      b.appendChild(el('span', it.label, 's-label'));
      if (it.detail) b.appendChild(el('span', it.detail, 's-detail'));
      b.addEventListener('mousedown', function (e) { e.preventDefault(); applySuggest(it); });
      box.appendChild(b);
    });
    box.hidden = false;
  }

  function applySuggest(it) {
    var ta = $('sql-input');
    var caret = ta.selectionStart;
    var m = ta.value.slice(0, caret).match(/([A-Za-z_][A-Za-z0-9_]*)$/);
    var start = m ? caret - m[1].length : caret;
    ta.value = ta.value.slice(0, start) + it.insert + ta.value.slice(caret);
    var pos = start + it.insert.length;
    ta.selectionStart = ta.selectionEnd = pos;
    hideSuggest();
    onSqlEdit();
    ta.focus();
  }

  /* ------------------------------ 筛选 ------------------------------ */
  function clearFilters() {
    filter.kw = '';
    filter.diffs = {};
    filter.undoneOnly = false;
    var rs = $('rail-search');
    if (rs) rs.value = '';
    var diffBox = $('filter-diff');
    if (diffBox) {
      [].forEach.call(diffBox.querySelectorAll('input'), function (i) { i.checked = false; });
    }
    var undo = $('filter-undone');
    if (undo) undo.checked = false;
    renderNav();
  }

  /* ------------------------------ 事件绑定 ------------------------------ */
  function bindUi() {
    $('btn-hint').addEventListener('click', revealNextHint);
    $('btn-run').addEventListener('click', doRun);
    $('btn-judge').addEventListener('click', doJudge);
    $('btn-answer').addEventListener('click', doAnswer);

    var sqlInput = $('sql-input');
    /* Tab 插入两个空格，不把焦点跳走（键盘用户友好） */
    sqlInput.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') {
        e.preventDefault();
        var s = this.selectionStart;
        var t = this.selectionEnd;
        this.value = this.value.slice(0, s) + '  ' + this.value.slice(t);
        this.selectionStart = this.selectionEnd = s + 2;
        onSqlEdit();
        return;
      }
      /* Ctrl / Cmd + Enter 运行 */
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doRun(); return; }
      /* 补全打开时：↑/↓ 选择、Enter 确认（未选中时保留换行语义） */
      var sugOpen = (function () { var s = $('sql-suggest'); return !!(s && !s.hidden); })();
      if (sugOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        moveSuggest(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (sugOpen && e.key === 'Enter' && suggestIndex >= 0) {
        e.preventDefault();
        var pick = suggestItems[suggestIndex];
        if (pick) applySuggest(pick);
        return;
      }
      if (e.key === 'Escape') {
        var sug = $('sql-suggest');
        if (sug && !sug.hidden) { hideSuggest(); return; }
        this.blur();   /* Esc 退出编辑器，焦点交给页面其余控件 */
        return;
      }
    });
    sqlInput.addEventListener('input', onSqlEdit);
    sqlInput.addEventListener('blur', function () { hideSuggest(); });

    /* 左栏：搜索 + 筛选 popover */
    var rs = $('rail-search');
    if (rs) rs.addEventListener('input', function () { filter.kw = this.value; renderNav(); });

    var bf = $('btn-filter'), pop = $('filter-pop');
    if (bf && pop) {
      bf.addEventListener('click', function (e) {
        e.stopPropagation();
        var willOpen = pop.hidden;
        pop.hidden = !willOpen;
        bf.setAttribute('aria-expanded', String(willOpen));
      });
      document.addEventListener('click', function (e) {
        if (!pop.hidden && e.target !== bf && !pop.contains(e.target)) {
          pop.hidden = true;
          bf.setAttribute('aria-expanded', 'false');
        }
      });
    }
    var diffBox = $('filter-diff');
    if (diffBox) {
      diffBox.addEventListener('change', function (e) {
        var t = e.target;
        if (t && t.dataset && t.dataset.diff) { filter.diffs[t.dataset.diff] = t.checked; renderNav(); }
      });
    }
    var undo = $('filter-undone');
    if (undo) undo.addEventListener('change', function () { filter.undoneOnly = this.checked; renderNav(); });
    var clr = $('btn-filter-clear');
    if (clr) clr.addEventListener('click', clearFilters);

    /* 数据库重新初始化：失败后保留题面与草稿，主动重试。 */
    var re = $('btn-reinit');
    if (re) re.addEventListener('click', function () { initDb(); });

    /* 右侧抽屉 */
    $('btn-tables-drawer').addEventListener('click', function () { openDrawer('tables'); });
    $('btn-dialect-drawer').addEventListener('click', function () { openDrawer('dialect'); });
    $('drawer-close').addEventListener('click', closePanel);
    $('scrim').addEventListener('click', closePanel);
    $('tab-tables').addEventListener('click', function () { setDrawerTab('tables'); });
    $('tab-dialect').addEventListener('click', function () { setDrawerTab('dialect'); });
    var ts = $('tables-search');
    if (ts) ts.addEventListener('input', function () { renderTablesPanel(this.value); });
    renderTablesPanel('');

    /* 涉及的表 / 字段：可展开 */
    var tth = $('tables-toggle-head');
    if (tth) {
      tth.addEventListener('click', toggleQuestionTables);
      tth.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleQuestionTables(); }
      });
    }

    /* 结果区 tab */
    var tm = $('tab-mine'), tr = $('tab-ref');
    if (tm) tm.addEventListener('click', function () { showResultTab('mine'); });
    if (tr) tr.addEventListener('click', function () { showResultTab('ref'); });

    /* 窄屏：左栏抽屉 */
    var br = $('btn-rail');
    if (br) br.addEventListener('click', function () { if (openPanel === 'rail') closePanel(); else openRail(); });

    /* Esc 关闭浮层（含学习记录）与重置确认卡 */
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (openPanel) { closePanel(); return; }
      if (recPanel && !recPanel.hidden) { setRecord(false); if (recBtn) recBtn.focus(); return; }
      if (resetPanel && !resetPanel.hidden) { resetPanel.hidden = true; return; }
    });

    /* 学习记录：可折叠面板，展开 / 收起带 aria-expanded，键盘可达。 */
    var recPanel = $('record-panel');
    var recBtn = $('btn-record');
    function setRecord(on) {
      if (recPanel) recPanel.hidden = !on;
      if (recBtn) recBtn.setAttribute('aria-expanded', String(!!on));
      if (on) renderStats();
    }
    if (recBtn) {
      recBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        setRecord(recPanel ? recPanel.hidden : false);
      });
    }
    var recClose = $('record-close');
    if (recClose) recClose.addEventListener('click', function () { setRecord(false); if (recBtn) recBtn.focus(); });
    document.addEventListener('click', function (e) {
      if (recPanel && !recPanel.hidden && recBtn && e.target !== recBtn && !recPanel.contains(e.target)) setRecord(false);
    });

    /* 重置进度：不用浏览器确认弹窗，改为页内一张确认卡（一次操作最多一张卡）。 */
    var resetPanel = $('reset-confirm');
    $('btn-reset').addEventListener('click', function () {
      if (resetPanel) resetPanel.hidden = false;
    });
    var resetNo = $('btn-reset-no');
    if (resetNo) resetNo.addEventListener('click', function () { if (resetPanel) resetPanel.hidden = true; });
    var resetYes = $('btn-reset-yes');
    if (resetYes) resetYes.addEventListener('click', function () {
      if (resetPanel) resetPanel.hidden = true;
      state = L.freshState();
      L.ensureDay(state, L.todayStamp());
      dailyPlan = L.buildDailyPlan(state, SECTIONS, L.todayStamp(), { unavailableIds: unavailableIds() });
      saveProgress();
      refCache = {};
      lastRun = null;
      currentId = null;
      closePanel();
      renderNav();
      renderStats();
      renderDetail();
      showBanner('selfcheck-banner', '');
    });

    /* 问一问：折叠头可点击 / 键盘可达；输入回车即问；快捷 chips 填词再问。 */
    var qaToggle = $('qa-toggle');
    var qaBody = $('qa-body');
    if (qaToggle && qaBody) {
      qaToggle.addEventListener('click', function () { qaSetOpen(qaBody.hidden); });
      qaToggle.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault();
          qaSetOpen(qaBody.hidden);
        }
      });
      qaSetOpen(false);
    }
    var qaAsk = $('qa-ask');
    if (qaAsk) qaAsk.addEventListener('click', function () { qaRun(); });
    var qaInput = $('qa-input');
    if (qaInput) {
      qaInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); qaRun(); }
      });
    }
    var qaChips = $('qa-chips');
    if (qaChips) {
      qaChips.addEventListener('click', function (e) {
        var b = e.target && e.target.closest ? e.target.closest('.qa-chip') : null;
        if (b && b.getAttribute('data-qa')) qaRun(b.getAttribute('data-qa'));
      });
    }
  }

  function onSqlEdit() {
    var q = currentQuestion();
    if (q) { state.sql[q.id] = $('sql-input').value; saveProgress(); }
    checkForbidden();
    updateSuggest();
  }

  /* ------------------------------ 启动 ------------------------------ */
  function setDbEnabled(on) {
    var run = $('btn-run'), judge = $('btn-judge'), re = $('btn-reinit');
    if (run) run.disabled = !on;
    if (judge) judge.disabled = !on;
    if (re) re.hidden = on;
  }

  /* 数据库初始化抽成独立函数：失败时保留题面与草稿，禁用执行，并提供重新初始化。 */
  function initDb() {
    if (!window.HRDb || typeof initSqlJs !== 'function') {
      setDbEnabled(false);
      showBanner('load-banner', '初始化失败：内联脚本未完整加载（HRDb / initSqlJs 缺失）。');
      return;
    }
    setDbEnabled(false);
    showBanner('load-banner', '正在初始化内置数据库（建表 + 灌数 + 11 表自检）…');
    window.HRDb.createDatabases(initSqlJs, {
      wasmBase64: BOOT.wasmBase64,
      schemaSql: BOOT.schemaSql,
      seedSql: BOOT.seedSql,
      expectedCounts: BOOT.rowcountExpected || {}
    }).then(function (r) {
      showBanner('load-banner', '');
      db = r.db;
      refDb = r.refDb;
      dbReady = true;
      setDbEnabled(true);
      /* 库就绪后补渲染一次码值对照：首屏渲染时库还没建好，查不了 HR_DICT。 */
      renderDictHints(currentQuestion());
      /* 重新评估待复核题：参考 SQL 跑不通的题不进今日计划，并在换题时给出说明。 */
      dailyPlan = L.buildDailyPlan(state, SECTIONS, L.todayStamp(), { unavailableIds: unavailableIds() });
      saveProgress();
      renderStats();
      /* 11 表行数对不上：页面红条提示，而不是白屏。 */
      if (!r.selfCheck.ok) {
        showBanner('selfcheck-banner', '库自检失败（' + r.selfCheck.okCount + '/' + r.selfCheck.total + ' 表不符）：' +
          r.selfCheck.tables.filter(function (t) { return !t.ok; })
            .map(function (t) { return t.table + ' 期望 ' + t.expected + ' 实得 ' + t.actual; }).join('；'));
      }
    })['catch'](function (e) {
      setDbEnabled(false);
      showBanner('load-banner', '数据库初始化失败：' + (e && e.message ? e.message : e) +
        '。题面与已写草稿保留，可点「重新初始化数据库」重试。');
    });
  }

  function boot() {
    if (!L) { showBanner('load-banner', '初始化失败：关卡编排模块 HRLevels 缺失。'); return; }
    if (!QUESTIONS.length) {
      showBanner('load-banner', '题库为空：未能从内联数据中读到 questions。');
      return;
    }
    /* 题库无有效段时不得访问不存在的 SECTIONS[0]。 */
    if (!SECTIONS.length || !SECTIONS[0] || !SECTIONS[0].questions || !SECTIONS[0].questions.length) {
      showBanner('load-banner', '课程资料异常：题库未能编成任何有效段。请检查 data/questions.json 的 section 字段。');
      return;
    }
    bindUi();

    /* 品牌行题数按题库实际长度注入，避免下次扩容再改 HTML。 */
    var brandMeta = $('brand-meta');
    if (brandMeta) brandMeta.textContent = '题库 v1.0 · ' + QUESTIONS.length + ' 题';

    /* 同日恢复计划与已完成集合；跨日生成新计划但草稿不清。 */
    var today = L.todayStamp();
    L.ensureLearningDay(state, today);
    dailyPlan = L.buildDailyPlan(state, SECTIONS, today, { unavailableIds: unavailableIds() });

    /* 恢复上次所在关；无效则落到今日计划第一项，再退回第一关。 */
    var startId = state.current && QUESTION_BY_ID[state.current] ? state.current
      : (dailyPlan && dailyPlan.planIds.length && QUESTION_BY_ID[dailyPlan.planIds[0]] ? dailyPlan.planIds[0]
        : SECTIONS[0].questions[0].id);
    currentId = startId;
    state.current = startId;
    saveProgress();
    renderNav();
    renderStats();
    renderDetail();

    initDb();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
