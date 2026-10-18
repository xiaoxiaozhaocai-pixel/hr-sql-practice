/*
 * src/app.js — HR 语境 SQL 练习台 界面逻辑（DOM 操作）—— UI 收敛版（2026-10-10）
 * ---------------------------------------------------------------------------
 * 本次只改「UI 与信息呈现」：判题口径、题库、题目内容、数据（tables.js / 内联种子）一律未动。
 * 布局：左栏题号列表 + 主列（题面 / 深色编辑器 / 结果）；表结构、方言对照改右侧抽屉（默认收起）。
 * 游戏化：只保留段/关进度与通关徽章；奖励经济、连击、今日配额、心形生命值全部不再呈现。
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
  var panelReturnFocus = null;  // 打开浮层前的焦点来源，关闭时归还（C）
  var lastRun = null;         // { columns, rows }：最近一次「运行」的结果，供结果区 tab 切换
  var lastSel = null;         // 编辑器最近一次选区，供「返回练习」恢复（L）
  var filter = { kw: '', diffs: {}, undoneOnly: false };
  var suggestItems = [];      // 当前补全候选（键盘 ↑/↓ 用）
  var suggestIndex = -1;      // -1 = 未选中，Enter 保持换行语义
  var editorStatusTimer = null; // 连续输入停止 400ms 后合并显示一次保存反馈（D/I）
  var editorStatusSave = '';    // 已确认的保存反馈文案

  /* GF1-D/E/F：受理快照与事件标识。每次运行/判题固定「题号 + SQL 快照 + 递增事件号」；
     提交后再编辑、切题或开始新一轮都会让旧快照失效，旧装饰回调不再落到新状态上。 */
  var eventSeq = 0;
  var accepted = null;        // { qid, sql, event, kind:'run'|'judge', stale:false }
  var barAnimNext = false;    // 仅「同段首次完成」这一次把进度条按 120ms 延迟演到新比例
  var barState = { section: null, ratio: 0 };

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
    var prev = node.__hrAnimEnd;
    if (prev) node.removeEventListener('animationend', prev);
    node.classList.remove(cls);
    void node.offsetWidth;
    node.classList.add(cls);
    var onEnd = function (e) {
      if (e.target !== node) return;
      node.classList.remove(cls);
      node.removeEventListener('animationend', onEnd);
      if (node.__hrAnimEnd === onEnd) node.__hrAnimEnd = null;
    };
    node.__hrAnimEnd = onEnd;
    node.addEventListener('animationend', onEnd);
  }

  function saveProgress() { return state ? L.saveState(storage, state) : false; }

  /* GF1-D/B：编辑器标题旁的静态状态文字（保存 / 已运行 / 已修改 / 进入题目的恢复状态）。 */
  function editorStatusBase() {
    if (accepted && accepted.qid === currentId) {
      return accepted.stale ? '已修改，需重新运行或判题'
        : (accepted.kind === 'run' ? '已运行，尚未判题' : '已判题');
    }
    var q = currentQuestion();
    if (!q) return '';
    if (state.passed[q.id]) return '本题已完成，可改写练习';
    if (state.sql[q.id]) return '已恢复本题草稿，继续编辑';
    return '本题尚未判题';
  }

  /* 保存反馈只在「确实写入」或「确实降级为仅内存」时才说，不用同一句兜底两种状态。 */
  function saveFeedbackText() {
    if (!state || !currentId) return '';
    var sql = state.sql[currentId];
    if (sql === undefined || sql === null || sql === '') return '';
    if (!STORAGE_OK || (state.learning && state.learning.persistence === 'memoryOnly')) {
      return '草稿仅暂存在本页，关闭可能丢失';
    }
    return '草稿已保存到此浏览器';
  }

  function paintEditorStatus() {
    var node = $('editor-status');
    if (!node) return;
    var text = editorStatusBase();
    if (editorStatusSave) text = text ? text + ' · ' + editorStatusSave : editorStatusSave;
    node.textContent = text;
  }

  /* 立即写：用于运行 / 判题结束、换题与回看——清掉待播的保存反馈，避免残留过期文案。 */
  function updateEditorStatus() {
    if (editorStatusTimer) { clearTimeout(editorStatusTimer); editorStatusTimer = null; }
    editorStatusSave = saveFeedbackText();
    paintEditorStatus();
  }

  /* D：连续输入停止 400ms 后合并显示一次保存反馈；保存本身仍按每次编辑执行。 */
  function prefersReducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { return false; }
  }

  function scheduleSaveStatus() {
    if (editorStatusTimer) clearTimeout(editorStatusTimer);
    /* 减弱动画下延迟一并归零；判题 / 运行结束时仍由 updateEditorStatus 立即写正确文案。 */
    var delay = prefersReducedMotion() ? 0 : 400;
    editorStatusTimer = setTimeout(function () {
      editorStatusTimer = null;
      editorStatusSave = saveFeedbackText();
      paintEditorStatus();
    }, delay);
  }

  /* GF1-D/E：旧运行结果 / 旧判定一旦被后续编辑或新一轮运行取代，就地标为过期；
     只改呈现，不撤销历史完成数（state.passed 不动）。 */
  function markStale() {
    var box = $('verdict');
    if (box && !box.hidden) {
      if (!box.querySelector('.stale-note')) {
        box.appendChild(el('div', '已过期，需重新运行 / 判题（旧结论仅作历史参考）。', 'muted stale-note'));
      }
      box.classList.add('is-stale');
    }
    var nb = $('next-action');
    if (nb && !nb.hidden) nb.hidden = true;
  }

  function setRunHint(text) {
    var node = $('run-hint');
    if (node) node.textContent = text || '';
  }

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
  function hasUnfinishedQuestions() {
    if (!L.sectionProgress) return false;
    var sp = L.sectionProgress(state, SECTIONS);
    return sp.sections.some(function (s) { return !s.completed; });
  }

  function chooseNextAction(info) {
    info = info || {};
    if (info.sectionCompleted && info.goalMet) {
      return { primary: { label: '今天先到这里', run: function () { showTodayWrap(false); } }, secondary: { label: '查看下一段', run: gotoNextSection } };
    }
    if (info.sectionCompleted) {
      /* J（P0）末段兜底：有真实下一段就去；还有未完成题就指向真实目标；
         全库完成则进入今日收束，绝不留指向空对象的「下一段」。 */
      if (pendingSummary && pendingSummary.nextFirstQuestion) {
        return { primary: { label: '查看下一段任务', run: gotoNextSection }, secondary: null };
      }
      if (hasUnfinishedQuestions()) {
        return { primary: { label: '继续未完成的题', run: continueToNext }, secondary: null };
      }
      return { primary: { label: '今天先到这里', run: function () { showTodayWrap(false); } }, secondary: { label: '继续练', run: continueToNext } };
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
    /* 目标可能在 sticky 顶栏之下不可见：一次即时最小滚动（不用平滑滚动抢注意力）。 */
    try {
      var r = target.getBoundingClientRect();
      var top = 64;
      if (r.top < top || r.bottom > (window.innerHeight || 0)) target.scrollIntoView({ block: 'nearest' });
    } catch (e) { /* 无布局信息时放弃滚动，不影响状态 */ }
    return true;
  }

  /* 提交以来用户是否主动把焦点移到了别处（用于决定是否抢回焦点）。 */
  function userMovedFocus(ev) {
    if (!ev) return true;
    var active = document.activeElement;
    if (!active || active === document.body) return false;
    if (active === ev.focusAtSubmit) return false;
    /* 判题按钮被禁用后焦点常回到 body；textarea 是发起时焦点则仍视为未移开。 */
    if (ev.focusAtSubmit && active === $('sql-input') && ev.focusAtSubmit === $('sql-input')) return false;
    return true;
  }

  /* 段末结算：独立卡片；旧用户回看只展示、不重发奖励。combined=与今日目标合并成一张结算。 */
  function renderSectionSummary(trans, combined, animate) {
    var box = $('section-summary');
    if (!box) return;
    if (!trans || !trans.completed) { pendingSummary = null; show(box, false); return; }
    pendingSummary = trans;
    $('section-summary-title').textContent = combined
      ? '第 ' + trans.section + ' 段完成 + 今日目标达成'
      : '第 ' + trans.section + ' 段完成 · ' + trans.passed + '/' + trans.total;
    var body = '完成 ' + trans.passed + '/' + trans.total +
      '；未看完整答案完成 ' + trans.unseenAnswer + ' 题' +
      '；跟练完成 ' + trans.guided + ' 题' +
      '；待复查 ' + trans.due + ' 题。';
    if (trans.isLastSection) {
      var remain = Math.max(0, trans.course.total - trans.course.passed);
      body = (trans.course.passed === trans.course.total
        ? '120 题已完成（' + trans.course.passed + '/' + trans.course.total + ' 题），待复查 ' + trans.course.due + ' 题。'
        : '第 ' + trans.section + ' 段完成，尚有 ' + remain + ' 题未完成。') +
        '本段完成 ' + trans.passed + '/' + trans.total + '；未看完整答案完成 ' + trans.unseenAnswer +
        ' 题；跟练完成 ' + trans.guided + ' 题。';
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
    /* GF1-H：段通关用 hr-summary-in，替代普通通过的 hr-pop，不叠加。 */
    if (animate !== false) replayAnim(box, 'hr-anim-summary');
    if (trans.firstShown) L.markSectionSummarySeen(state, trans.section);
  }

  /* 今日收束：完成目标后非阻塞小结；只庆祝一次。 */
  function todayWrapTitle() {
    return L.goalMet(state) ? '今天目标已完成' : '今天到这里';
  }

  /* L：保存成功与仅内存暂存分开表达，不用同一句兜底。 */
  function saveSentence() {
    if (!STORAGE_OK || (state.learning && state.learning.persistence === 'memoryOnly')) {
      return '进度仅保留在本页，关闭或刷新可能丢失。';
    }
    return '草稿和进度已保存到此浏览器。';
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
    var nextId = nextPlanItem();
    var nq = nextId ? QUESTION_BY_ID[nextId] : null;
    var nextText = nq ? ('下次从 #' + pad2(nq.seq) + ' 继续。') : '当前没有待推进的题，可自由回看或换题。';
    return '今天到这里：新完成 ' + fresh + ' 题，复查 ' + review + ' 题。' + nextText + saveSentence();
  }

  /* 页面底部与学习记录的保存承诺随真实写入状态调整。 */
  function updatePersistNotes() {
    var memOnly = !STORAGE_OK || !!(state.learning && state.learning.persistence === 'memoryOnly');
    var foot = $('foot-persist');
    if (foot) {
      foot.textContent = memOnly
        ? '本次进度仅保留在本页，关闭或刷新可能丢失（可重试保存）。'
        : '进度只存在本机浏览器 localStorage（键 dbquest.v2），刷新不丢。';
    }
    var retry = $('btn-retry-save');
    if (retry && !$('today-wrap').hidden) show(retry, memOnly);
    return memOnly;
  }

  function showTodayWrap(celebrate) {
    var box = $('today-wrap');
    if (!box) return;
    /* L：先保存，再显示静态摘要；不清草稿、不清通过记录、不自动关窗。 */
    saveProgress();
    $('today-wrap-title').textContent = todayWrapTitle();
    $('today-wrap-body').textContent = todayWrapText();
    show(box, true);
    updatePersistNotes();
    /* L：小结聚焦标题；「返回练习」按钮留在原地。 */
    var title = $('today-wrap-title');
    if (title) {
      title.setAttribute('tabindex', '-1');
      try { title.focus({ preventScroll: true }); } catch (e) { try { title.focus(); } catch (e2) { /* 保持原焦点 */ } }
    }
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
      var totalQ = sec.questions.length;
      var doneQ = passedInSection(sec);
      var ratio = totalQ ? doneQ / totalQ : 0;
      var sameSec = barState.section === sec.section;
      var prevRatio = sameSec ? barState.ratio : 0;
      if (barAnimNext && sameSec && ratio > prevRatio) {
        /* 同段首次完成：延迟 120ms，由旧比例演到新比例（D 的唯一动画路径）。 */
        bar.style.transitionDelay = '120ms';
      } else {
        /* 切段 / 首次加载 / 非首次完成：直接设终值，不演成「凭空获得进度」。 */
        bar.style.transitionDelay = '';
      }
      bar.style.transform = 'scaleX(' + ratio + ')';
      barAnimNext = false;
      barState = { section: sec.section, ratio: ratio };
      var wrap = bar.parentNode;
      if (wrap) {
        wrap.setAttribute('role', 'progressbar');
        wrap.setAttribute('aria-label', '第 ' + sec.section + ' 段进度');
        wrap.setAttribute('aria-valuemin', '0');
        wrap.setAttribute('aria-valuemax', String(totalQ));
        wrap.setAttribute('aria-valuenow', String(doneQ));
        wrap.setAttribute('aria-valuetext', '第 ' + sec.section + ' 段，已完成 ' + doneQ + '/' + totalQ);
      }
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
      if (memoryOnly) { persist.textContent = '本次进度尚未保存到浏览器（刷新可能丢失）；可重试保存，已有完成记录不变。'; show(persist, true); }
      else { persist.textContent = ''; show(persist, false); }
    }
    updatePersistNotes();
    renderTodayGroup();
  }

  /* 学情诊断：只读汇总学习记录，不参与判题、不改题库与段进度口径。 */
  function renderDiagnose() {
    var box = $('record-diagnose');
    if (!box) return;
    var D = window.HRDiagnose;
    var report = (D && typeof D.diagnose === 'function' && state && state.learning)
      ? D.diagnose({ questions: QUESTIONS, learning: state.learning }, { today: L.todayStamp() })
      : null;
    if (!report || !report.ready) {
      box.hidden = true;
      box.textContent = '';
      return;
    }
    box.hidden = false;
    box.textContent = '';

    var o = report.overall;
    box.appendChild(el('div',
      '已完成 ' + o.completed + '/' + o.total + ' · 独立完成 ' + o.independent +
      ' · 待修正 ' + o.needsFix + ' · 到期复查 ' + o.due,
      'record-diagnose-line record-diagnose-overview'));

    var sectionBox = el('div', null, 'record-diagnose-sections');
    report.sections.forEach(function (s) {
      sectionBox.appendChild(el('div',
        '第 ' + s.section + ' 段 已完成 ' + s.completed + '/' + s.total +
        ' · 独立 ' + s.independent + ' · 掌握率 ' + Math.round(s.masteryRate * 100) + '%',
        'record-diagnose-line'));
    });
    box.appendChild(sectionBox);

    if (report.syntax.length > 0) {
      var syntaxBox = el('div', null, 'record-diagnose-syntax');
      report.syntax.slice(0, 5).forEach(function (sx) {
        /* T24：排序已经把练过的顶到前面，但读起来还分不出哪行是刚练的、哪行没碰过。
           练过的写「已练 c/t」，没碰过的写「待练 t」，并用 class 让练过的深一档。
           仍只读：不改判题、不改题库、不改学习记录。 */
        var started = sx.completed > 0;
        syntaxBox.appendChild(el('div',
          started
            ? sx.name + ' · 已练 ' + sx.completed + '/' + sx.total + ' 题 · 掌握率 ' +
              Math.round(sx.masteryRate * 100) + '%'
            : sx.name + ' · 待练 ' + sx.total + ' 题',
          'record-diagnose-line' + (started ? ' record-diagnose-started' : '')));
      });
      box.appendChild(syntaxBox);
    }

    if (report.plan.length > 0) {
      var planBox = el('div', null, 'record-diagnose-plan');
      report.plan.forEach(function (p) {
        /* T23：下一步可点，点了直接跳到那道题。
           诊断本身仍是只读的：跳转不改判题、不改题库、不改任何学习记录。 */
        var go = el('button',
          '#' + p.seq + ' ' + p.title + ' · ' + p.reason,
          'record-diagnose-line record-diagnose-go');
        go.type = 'button';
        go.setAttribute('data-qid', p.id);
        go.addEventListener('click', function () {
          var closer = $('record-close');
          if (closer) closer.click();   /* 复用收起逻辑：同步 aria-expanded 与焦点 */
          jumpToQuestion(p.id);
          announce('已跳到 #' + p.seq + '。');
        });
        planBox.appendChild(go);
      });
      box.appendChild(planBox);
    }
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
        li.setAttribute('aria-label', '第 ' + sec.section + ' 段第 ' + sectionIndexOf(sec, q.id) + ' 题：' + (q.title || q.id));
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
          meta.appendChild(el('span', '本段第 ' + sectionIndexOf(sec, q.id) + ' 题', 'chip'));
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

  /* B：进入题目时读屏只需题号 / 段内位置与恢复状态，不朗读整题。 */
  function enterAnnouncement(q) {
    if (!q) return '';
    var sec = SECTION_OF[q.id];
    var pos = sec ? ('第 ' + sec.section + ' 段第 ' + sectionIndexOf(sec, q.id) + ' 题') : '';
    var st = state.passed[q.id] ? '本题已完成，可改写练习'
      : (state.sql[q.id] ? '已恢复本题草稿，继续编辑' : '本题尚未判题');
    return pos ? (pos + '。' + st) : st;
  }

  function selectLevel(id, fromKeyboard) {
    if (!QUESTION_BY_ID[id]) return;
    currentId = id;
    state.current = id;
    saveProgress();
    /* K（P0）：先交接再开下一轮——旧补全、旧快照、旧装饰全部失效，不落到新题上。 */
    accepted = null;
    hideSuggest();
    setRunHint('');
    renderNav();
    renderStats();
    renderDetail();
    if (openPanel === 'rail') closePanel();
    /* B/K：点击或键盘选题都先把焦点交到新题标题（程序可聚焦），再由用户自主进入编辑器。 */
    var title = $('q-title');
    if (title) {
      title.setAttribute('tabindex', '-1');
      try { title.focus({ preventScroll: true }); } catch (e) { try { title.focus(); } catch (e2) { /* 标题不可聚焦时保持原焦点 */ } }
    }
    announce(enterAnnouncement(currentQuestion()));
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
    renderHints(q, true);
    if (n > 0 && list[n - 1]) announce('已展开提示 ' + n + '/' + list.length + '：' + list[n - 1]);
    else if (!list.length) announce('本题未提供提示。');
  }

  function renderHints(q, animate) {
    var list = hintTexts(q);
    var seen = hintSeen(q);
    state.hintSeen[q.id] = seen;
    var ul = $('hint-list');
    ul.textContent = '';
    for (var i = 0; i < seen; i++) ul.appendChild(el('li', list[i]));
    show($('hint-empty'), seen === 0 && list.length > 0);
    /* C：只有新展开的那一条用 A（hr-fade-up），回看 / 重绘不重播。 */
    if (animate && ul.lastChild) replayAnim(ul.lastChild, 'hr-anim-fade-up');

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
        /* 只记阅读状态并落盘：不加奖励、不计今日目标、不扣任何额度 */
        if (L && state) L.markSyntaxSeen(state, c.syntax, L.todayStamp());
        saveProgress();
        var fresh = syntaxCardNode(c, i, qid);
        if (card.parentNode) card.parentNode.replaceChild(fresh, card);
        /* C：确认后焦点去替换后的回看按钮，键盘路径不断档。 */
        var back = fresh.querySelector('.syntax-review-toggle');
        if (back) { try { back.focus(); } catch (e) { /* 保持原焦点 */ } }
        refreshSyntaxStart(QUESTION_BY_ID[qid]);
        announce('已记录看过语法：' + c.syntax);
      });
      actions.appendChild(btn);
      body.hidden = false;
    }
    card.appendChild(actions);
    return card;
  }

  /* C：最后一张未读语法卡确认后才呈现「开始写 SQL」入口；不要求确认所有卡才能作答。 */
  function refreshSyntaxStart(q) {
    var host = $('q-syntax');
    if (!host) return;
    var existing = host.querySelector('.syntax-start-entry');
    var cards = (q && SYNTAX_BY_ID[q.id]) || null;
    var allSeen = !!(cards && cards.length) && cards.every(function (c) {
      return !!(L && typeof L.isSyntaxSeen === 'function' && L.isSyntaxSeen(state, c.syntax));
    });
    if (!allSeen) { if (existing && existing.parentNode) existing.parentNode.removeChild(existing); return; }
    if (existing) return;
    var actions = el('div', null, 'syntax-actions syntax-start-entry');
    var go = el('button', '开始写 SQL', 'btn primary sm');
    go.type = 'button';
    go.addEventListener('click', function () {
      var ta = $('sql-input');
      if (ta) { ta.focus(); try { ta.scrollIntoView({ block: 'nearest' }); } catch (e) { /* 只聚焦 */ } }
    });
    actions.appendChild(go);
    host.appendChild(actions);
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
    refreshSyntaxStart(q);
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
  /* E/C：tablist 方向键 ←/→ 在标签间移动并切换，roving tabindex 与 aria-selected 同步。 */
  function wireTablist(tabs, onSelect) {
    tabs.forEach(function (t, i) {
      if (!t) return;
      t.addEventListener('keydown', function (e) {
        var d = e.key === 'ArrowRight' ? 1 : (e.key === 'ArrowLeft' ? -1 : 0);
        if (!d) return;
        e.preventDefault();
        var next = tabs[(i + d + tabs.length) % tabs.length];
        onSelect(next);
        try { next.focus(); } catch (e2) { /* 无法聚焦时仍完成切换 */ }
      });
    });
  }

  function focusablesIn(node) {
    if (!node) return [];
    var all = node.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    return [].filter.call(all, function (n) {
      /* 抽屉 / 左栏浮层是 position:fixed，offsetParent 恒为 null，不能用它判可见性。 */
      return !n.disabled && n.getAttribute('aria-hidden') !== 'true' && n.getClientRects().length > 0;
    });
  }

  function focusFirstPanelNode(panel, preferred) {
    var target = preferred || (focusablesIn(panel)[0] || null);
    if (!target) return;
    try { target.focus(); } catch (e) { /* 无焦点支持时保持原焦点 */ }
  }

  function setDrawerTab(tab) {
    var tt = $('tab-tables'), td = $('tab-dialect');
    if (tt) {
      tt.classList.toggle('on', tab === 'tables');
      tt.setAttribute('aria-selected', String(tab === 'tables'));
      tt.setAttribute('tabindex', tab === 'tables' ? '0' : '-1');
    }
    if (td) {
      td.classList.toggle('on', tab === 'dialect');
      td.setAttribute('aria-selected', String(tab === 'dialect'));
      td.setAttribute('tabindex', tab === 'dialect' ? '0' : '-1');
    }
    show($('panel-tables'), tab === 'tables');
    show($('panel-dialect'), tab === 'dialect');
  }

  function openDrawer(tab) {
    setDrawerTab(tab);
    /* C：记录来源，打开后聚焦对应页签；关闭时归还来源。 */
    panelReturnFocus = document.activeElement;
    show($('drawer'), true);
    var d = $('drawer');
    if (d) d.setAttribute('aria-hidden', 'false');
    show($('scrim'), true);
    openPanel = 'drawer';
    focusFirstPanelNode(d, tab === 'dialect' ? $('tab-dialect') : $('tab-tables'));
  }

  function openRail() {
    var r = $('rail');
    panelReturnFocus = document.activeElement;
    if (r) r.classList.add('is-open');
    show($('scrim'), true);
    openPanel = 'rail';
    var search = $('rail-search');
    focusFirstPanelNode(r, search || $('btn-rail'));
  }

  function closePanel() {
    var wasOpen = openPanel;
    var drawer = $('drawer');
    show(drawer, false);
    if (drawer) drawer.setAttribute('aria-hidden', 'true');
    var r = $('rail');
    if (r) r.classList.remove('is-open');
    show($('scrim'), false);
    openPanel = null;
    /* C：关闭后焦点回到来源；来源已不可用时保持现状，不把焦点丢到隐藏节点。 */
    var back = panelReturnFocus;
    panelReturnFocus = null;
    if (wasOpen && back && document.contains(back)) {
      var hidden = back.getClientRects().length === 0 && back !== $('btn-rail');
      if (!hidden) { try { back.focus(); } catch (e) { /* 保持现状 */ } }
    }
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
    var vbox = $('verdict');
    if (vbox) vbox.classList.remove('is-stale');
    var nextBtn0 = $('btn-next-primary');
    if (nextBtn0) nextBtn0.removeAttribute('aria-describedby');
    show($('result-block'), false);
    show($('answer-block'), false);
    show($('today-wrap'), false);
    lastRun = null;

    var post = $('post-pass-block');
    if (state.passed[q.id]) { renderPostPass(q); show(post, true); } else { show(post, false); }

    /* 段末总结：所在段已完成时可回看（回看静态展示，不重播动画）。 */
    var transNow = L.sectionTransition(state, SECTIONS, q.id);
    renderSectionSummary(transNow, false, false);
    /* K：未通过题不显示「通过后的下一项」主按钮；已通过题才给下一步。 */
    if (state.passed[q.id]) {
      renderNextAction({
        sectionCompleted: !!(transNow && transNow.completed),
        goalMet: L.goalMet(state)
      });
    } else {
      var nextBox = $('next-action');
      if (nextBox) nextBox.hidden = true;
    }

    updateEditorStatus();
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
      if (all) { badge.textContent = '第 ' + sec.section + ' 段通关'; show(badge, true); }
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
    if (mine) {
      mine.classList.toggle('on', which === 'mine');
      mine.setAttribute('aria-selected', String(which === 'mine'));
      mine.setAttribute('tabindex', which === 'mine' ? '0' : '-1');
    }
    if (refTab) {
      refTab.classList.toggle('on', which === 'ref');
      refTab.setAttribute('aria-selected', String(which === 'ref'));
      refTab.setAttribute('tabindex', which === 'ref' ? '0' : '-1');
    }
    var panel = $('result-panel');
    if (panel) panel.setAttribute('aria-labelledby', which === 'mine' ? 'tab-mine' : 'tab-ref');
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

  function appendBackToSql(box) {
    var back = el('button', '回到 SQL 修改', 'btn ghost sm verdict-back');
    back.type = 'button';
    back.addEventListener('click', function () {
      var ta = $('sql-input');
      if (!ta) return;
      ta.focus();
      try { ta.scrollIntoView({ block: 'center' }); } catch (e) { /* 无布局信息时只聚焦 */ }
    });
    box.appendChild(back);
  }

  function renderVerdict(kind, title, verdict, refColumns, extraNote, info) {
    info = info || {};
    var box = $('verdict');
    box.className = 'card-note ' + (VERDICT_MOD[kind] || 'is-warn') + (info.stale ? ' is-stale' : '');
    box.textContent = '';
    box.appendChild(el('div', title, 'verdict-title'));
    if (extraNote) {
      var noteEl = el('div', extraNote, 'muted');
      /* H：给「下一步」主按钮一个可被 aria-describedby 引用的短通过摘要。 */
      if (kind === 'pass') noteEl.id = 'pass-summary';
      box.appendChild(noteEl);
    }

    var fmtDiff = function (d) {
      var label = d.kind === 'extra' ? '多余行' : d.kind === 'missing' ? '缺失行' : '不一致行';
      var cols = Array.isArray(refColumns) && refColumns.length ? ' 列：' + refColumns.join(' | ') : '';
      return '[' + label + ']' + cols + '  ' + JSON.stringify(d.row);
    };

    /* G（P0）：失败卡顺序固定为 结论 → 首个差异证据 → 一个建议 → 回到 SQL 修改；
       其余诊断（原因、对齐、更多差异、回看入口）折叠在最后，不同时动画化上下两块。 */
    if (kind === 'fail' && verdict) {
      var dtypeF = diffTypeOf(verdict, !!info.orderSensitive);
      if (dtypeF) box.appendChild(el('div', dtypeF, 'diff-type'));
      var diffsF = verdict.diffRows || [];
      if (diffsF.length) box.appendChild(el('div', fmtDiff(diffsF[0]), 'diff k-' + diffsF[0].kind));
      if (info.action) box.appendChild(el('div', info.action, 'verdict-action'));
      appendBackToSql(box);
      var diag = document.createElement('details');
      diag.className = 'verdict-diag';
      diag.appendChild(el('summary', '更多诊断与回看'));
      if (verdict.reason) diag.appendChild(el('div', verdict.reason, 'muted'));
      if (verdict.columnIssue) {
        var pf = [verdict.columnIssue.message];
        if (verdict.columnIssue.missing && verdict.columnIssue.missing.length) pf.push('缺失列：' + verdict.columnIssue.missing.join('、'));
        if (verdict.columnIssue.extra && verdict.columnIssue.extra.length) pf.push('多余列：' + verdict.columnIssue.extra.join('、'));
        diag.appendChild(el('div', pf.join(' '), 'muted'));
      }
      if (verdict.refRowCount == null) diag.appendChild(el('div', '预期行数 —（SQL 未跑通，未计算）', 'muted'));
      else diag.appendChild(el('div', '对齐方式 alignMode=' + verdict.alignMode +
        '；你的行数 ' + verdict.userRowCount + '，预期行数 ' + verdict.refRowCount, 'muted'));
      if (diffsF.length > 1) {
        var detF = document.createElement('details');
        detF.className = 'diff diff-more';
        detF.appendChild(el('summary', '展开更多差异（其余 ' + (diffsF.length - 1) + ' 条）'));
        diffsF.slice(1).forEach(function (d) { detF.appendChild(el('div', fmtDiff(d), 'k-' + d.kind)); });
        diag.appendChild(detF);
      }
      if (info.reviewTools && currentQuestion()) attachReviewTools(diag, currentQuestion());
      if (info.reviewNote) diag.appendChild(el('div', info.reviewNote, 'muted'));
      box.appendChild(diag);
    } else if (verdict) {
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
      var dtype = diffTypeOf(verdict, !!info.orderSensitive);
      if (dtype) box.appendChild(el('div', dtype, 'diff-type'));
      var diffs = verdict.diffRows || [];
      if (diffs.length) {
        box.appendChild(el('div', fmtDiff(diffs[0]), 'diff k-' + diffs[0].kind));
        if (diffs.length > 1) {
          var det = document.createElement('details');
          det.className = 'diff diff-more';
          det.appendChild(el('summary', '展开更多差异（其余 ' + (diffs.length - 1) + ' 条）'));
          diffs.slice(1).forEach(function (d) { det.appendChild(el('div', fmtDiff(d), 'k-' + d.kind)); });
          box.appendChild(det);
        }
      }
      if (info.action) box.appendChild(el('div', info.action, 'verdict-action'));
      if (info.reviewTools && currentQuestion()) attachReviewTools(box, currentQuestion());
      if (info.reviewNote) box.appendChild(el('div', info.reviewNote, 'muted'));
    } else if (info.action) {
      box.appendChild(el('div', info.action, 'verdict-action'));
    }
    if (info.stale) box.appendChild(el('div', '已过期，需重新运行 / 判题（旧结论仅作历史参考）。', 'muted stale-note'));
    show(box, true);
    /* H/J：把「下一步」主按钮与短通过摘要 / 段末总结标题关联起来。 */
    if (kind === 'pass') {
      var nextBtn = $('btn-next-primary');
      if (nextBtn) {
        var described = [];
        if (extraNote) described.push('pass-summary');
        if (info.sectionCompleted) described.push('section-summary-title');
        if (described.length) nextBtn.setAttribute('aria-describedby', described.join(' '));
        else nextBtn.removeAttribute('aria-describedby');
      }
    }
    /* GF1-G：失败不再 shake 编辑器。GF1-H：通过用 hr-pop（240ms、无回弹）。过期结论不播装饰动画。 */
    /* I/J：只有本次首次完成触发 B；段通关用 hr-summary-in 替换 B；重复 / 回看 / 改写不播放。 */
    var noCelebrate = kind === 'pass' && info.celebrate === false;
    if (!info.stale && !(kind === 'pass' && info.sectionCompleted) && !noCelebrate) {
      replayAnim(box, kind === 'pass' ? 'hr-anim-pop' : 'hr-anim-fade-up');
    }
  }

  function renderRunError(msg, sql) {
    show($('result-block'), false);
    /* 语句级预检优先：漏 FROM 时引擎先抛 no such column，只翻译报错文本会把学员引去核列名。
       用受理时的 SQL 快照，不读当前草稿（可能已改）。 */
    if (sql === undefined) sql = ($('sql-input') && $('sql-input').value) || '';
    var triage = sqlTriage(sql);
    renderVerdict('fail', 'SQL 执行错误（原样展示）：', {
      reason: msg, columnIssue: null, diffRows: [], alignMode: 'none', userRowCount: null, refRowCount: null
    }, null, '人话：' + (triage ? triage : explainError(msg)));
    announce('SQL 执行错误（原样展示）：' + msg);
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

  /* 实际执行抽出来：忙态已就位后再跑，结束时由 doRun 统一恢复按钮。
     只报「跑出了什么」（行数/列数/错误），绝不冒充通过，也不写判定。 */
  function runNow(ev, sql, qid) {
    var res;
    try {
      res = window.HRDb.runQuery(db, sql);
    } catch (e) {
      if (qid === currentId) renderRunError(String(e && e.message ? e.message : e), sql);
      return;
    }
    if (qid !== currentId) return;   /* 已切题：旧事件不写新题内容 */
    lastRun = { columns: res.columns, rows: res.rows, truncated: !!res.truncated, qid: qid, sql: sql };
    show($('result-block'), true);
    showResultTab('mine');
    setRunHint('已运行：' + res.rows.length + ' 行、' + res.columns.length + ' 列；尚未判题');
  }

  function doRun() {
    if (running || judging) return;
    if (!requireDb()) return;
    var sqlInput = $('sql-input');
    var sql = sqlInput.value;
    if (!sql.trim()) { renderVerdict('warn', '请先写 SQL。', null, null); sqlInput.focus(); return; }
    /* E：受理时固定题号 + SQL 快照 + 递增事件号。 */
    var qid = currentId;
    var ev = { qid: qid, sql: sql, event: ++eventSeq, kind: 'run', stale: false, focusAtSubmit: document.activeElement };
    accepted = ev;
    running = true;
    setBusy($('btn-run'), true, '运行中…');
    setBusy($('btn-judge'), true);   /* 运行期间判题同样禁用，只禁用不改文案 */
    /* 运行不产生判定：旧结论降为历史，但历史完成数不撤销。 */
    markStale();
    updateEditorStatus();
    /* 先让浏览器重绘出忙态，再执行同步查询。 */
    setTimeout(function () {
      try { runNow(ev, sql, qid); }
      catch (e) { if (qid === currentId) renderRunError(String(e && e.message ? e.message : e), sql); }
      finally {
        running = false;
        setBusy($('btn-run'), false);
        setBusy($('btn-judge'), false);
        if (qid === currentId) updateEditorStatus();
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
    var sqlInput = $('sql-input');
    var sql = sqlInput.value;
    if (!sql.trim()) { renderVerdict('warn', '请先写 SQL 再判题。', null, null); sqlInput.focus(); return; }
    /* F：受理 → 计算 → 结论只有一个状态源；受理时固定题号 + SQL 快照 + 事件号。 */
    var qid = currentId;
    var ev = { qid: qid, sql: sql, event: ++eventSeq, kind: 'judge', stale: false, focusAtSubmit: document.activeElement };
    accepted = ev;
    judging = true;
    setJudgeLoading(true);
    setTimeout(function () {
      try {
        if (qid !== currentId) return;
        judgeNow(qid, ev);
      }
      catch (err) {
        if (qid === currentId) renderRunError(String(err && err.message ? err.message : err), sql);
      }
      finally { judging = false; setJudgeLoading(false); if (qid === currentId) updateEditorStatus(); }
    }, 0);
  }

  function judgeNow(qid, ev) {
    if (!requireDb()) return;
    qid = qid || currentId;
    if (qid !== currentId) return;
    var q = QUESTION_BY_ID[qid];
    if (!q) return;
    ev = ev || accepted;
    var sql = (ev && ev.sql != null) ? ev.sql : $('sql-input').value;
    var stamp = L.todayStamp();
    if (!sql.trim()) { renderVerdict('warn', '请先写 SQL 再判题。', null, null); return; }
    /* 提交后又被编辑：草稿保留，结论只能标为「提交版本的历史结果」，不对当前草稿庆祝。 */
    var edited = !!(ev && $('sql-input') && $('sql-input').value !== sql);
    var hintAnnounced = false;
    if (ev && edited) ev.stale = true;

    var ref = referenceResult(q);
    if (!ref.ok) {
      /* 题库异常：不记用户失败、不消耗次数，允许换题。 */
      $('ref-review-block').textContent = '题库待复核：参考 SQL（reference_sql_sqlite）在当前库上执行失败——' + ref.error + '。本题不判你的对错、不消耗次数。';
      show($('ref-review-block'), true);
      renderVerdict('warn', '本题标记「题库待复核」，跳过判题；你仍可换题继续。', null, null, null, { stale: edited });
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
      renderRunError(String(e && e.message ? e.message : e), sql);
      renderStats();
      return;
    }

    var orderSensitive = !!(q.expected && q.expected.order_sensitive);
    var verdict = window.HRJudge.judgeResult(
      res.rows, res.columns,
      ref.result.rows, ref.result.columns,
      { orderSensitive: orderSensitive }
    );

    lastRun = { columns: res.columns, rows: res.rows, truncated: !!res.truncated, qid: qid, sql: sql };
    show($('result-block'), true);
    showResultTab('mine');

    if (ref.mismatch) {
      $('ref-review-block').textContent = '题库待复核：参考 SQL 实跑 ' + ref.result.rows.length +
        ' 行，与 expected.row_count=' + ref.expectedRowCount + ' 不一致。本题不判你的对错、不消耗次数（下方结论仅供参考）。';
      show($('ref-review-block'), true);
      renderVerdict('warn', '本题标记「题库待复核」。', verdict, ref.result.columns, null, { orderSensitive: orderSensitive, stale: edited });
      return;
    }

    if (verdict.pass) {
      /* 唯一计分入口：recordLearningAttempt 判 + creditLearningEvent 结算。 */
      var prevCelebrated = !!(state.learning && state.learning.daily && state.learning.daily.goalCelebrated);
      var fb = L.recordLearningAttempt(state, { id: q.id, kind: 'check', sql: sql, ok: true, stamp: stamp });
      var credit = L.creditLearningEvent(state, fb);
      saveProgress();
      var trans = L.sectionTransition(state, SECTIONS, q.id);
      var sectionCompleted = !!(trans && trans.completed);
      /* I：目标是否达成只看持久状态，不用重复事件返回的默认 credit.goalMet=false。 */
      var goalMetNow = L.goalMet(state);
      var combined = sectionCompleted && goalMetNow;
      lastCombined = combined ? { section: trans.section } : null;
      var firstDone = !!fb.firstTime && !fb.duplicate && !edited;
      renderSectionSummary(trans, combined, !edited);
      /* J：庆祝 seen 标记与进度一起落盘，刷新后回看不补播。 */
      saveProgress();
      var justCelebrated = !!credit.goalCelebrated && !prevCelebrated;
      if (goalMetNow && !combined) showTodayWrap(justCelebrated && !edited);
      else if (!goalMetNow) show($('today-wrap'), false);
      if (edited) { var nb = $('next-action'); if (nb) nb.hidden = true; }
      else renderNextAction({ sectionCompleted: sectionCompleted, goalMet: goalMetNow });
      renderPostPass(q);
      show($('post-pass-block'), true);
      /* H：区分本次首次完成 / 重复提交 / 回看，文案不含任何奖励措辞。 */
      var title, passNote;
      if (fb.duplicate) { title = '通过 · 与上次结果一致'; passNote = '重复提交，完成题数未变化。'; }
      else if (firstDone) {
        title = '通过 · 首次完成';
        /* I：只报本次真实的段内推进，不写奖励倍数 / 连击。 */
        var fromN = trans ? Math.max(0, trans.passed - 1) : 0;
        passNote = '结果集与预期一致。第 ' + (trans ? trans.section : '?') + ' 段：' +
          fromN + '/' + (trans ? trans.total : '?') + ' → ' + (trans ? trans.passed : '?') + '/' + (trans ? trans.total : '?') + '。';
      }
      else if (fb.reviewResolved) { title = '通过 · 复查完成'; passNote = '本次复查已通过，这题移出待复查列表。'; }
      else { title = '通过 · 改写通过'; passNote = '改写通过，本题已完成；完成题数未变化。'; }
      if (fb.completionType === 'guided') passNote += ' 本次为跟练完成；已安排复查。';
      if (edited) passNote += '（提交后已修改，本结论为提交版本的历史结果，需重新判题。）';
      /* 只有同段首次完成才把进度条按 120ms 延迟演到新比例。 */
      barAnimNext = firstDone;
      renderVerdict('pass', title, verdict, ref.result.columns, passNote, {
        action: null,
        orderSensitive: orderSensitive,
        sectionCompleted: sectionCompleted,
        celebrate: firstDone,
        stale: edited
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
        hintAnnounced = true;
      }
      renderHints(q);
      var wrongNo = (typeof fb2.wrongNo === 'number') ? fb2.wrongNo : 0;
      var reviewNote = '';
      if (fb2.duplicate) reviewNote = '与上次判题相同，未重复累计判错。';
      else if (fb2.skipped) reviewNote = '这一步不算有效结果判错。';
      else if (wrongNo === 1) reviewNote = '第 1 次判错：已记录待修正，并展开第 1 条提示。';
      else if (wrongNo === 2) {
        reviewNote = '第 2 次判错：建议回看本题语法卡与易错点。';
        if (list.length <= 1) reviewNote += ' 本题只有这条提示——不另造第二条，回看入口见下方。';
      } else if (wrongNo >= 3) {
        reviewNote = '已经试了 ' + wrongNo + ' 次，换个思路：对照提示拆开检查。运行、改写、提示、看答案仍可用，这题可以暂停、留作待修正。';
      }
      renderVerdict('fail', '未通过 · 结果与预期不符，已记录待修正；练习不扣分、不扣次数。', verdict, ref.result.columns, null, {
        action: firstActionHint(q, verdict),
        orderSensitive: orderSensitive,
        reviewTools: wrongNo >= 2,
        reviewNote: reviewNote,
        stale: edited
      });
    }
    renderStats();
    renderNav();
    var handed = false;
    if (verdict.pass && !edited && !userMovedFocus(ev)) handed = focusNextAction();
    /* 单次最终结论播报：焦点已交接就不再向 live 区写同一句，避免同一事件双播报。 */
    if (!handed && !hintAnnounced) {
      announce(verdict.pass ? '通过：结果与预期一致。' : '未通过：结果与预期不符，可按建议修改后重新判题。');
    }
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
    /* L：编辑操作区的次级退出入口；已达目标时主按钮是同名动作。 */
    var wrapBtn = $('btn-wrap');
    if (wrapBtn) wrapBtn.addEventListener('click', function () { showTodayWrap(false); });

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
    sqlInput.addEventListener('blur', function () {
      /* L：记住选区，返回练习时恢复。 */
      lastSel = [sqlInput.selectionStart, sqlInput.selectionEnd];
      hideSuggest();
    });

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
    /* C/E：抽屉 tablist 方向键切换 + roving tabindex。 */
    wireTablist([$('tab-tables'), $('tab-dialect')], function (t) {
      setDrawerTab(t === $('tab-tables') ? 'tables' : 'dialect');
    });
    setDrawerTab('tables');
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

    /* 结果区 tab（E）：点击 + ←/→ 方向键都能切换，aria-selected / tabindex 同步。 */
    var tm = $('tab-mine'), tr = $('tab-ref');
    if (tm) tm.addEventListener('click', function () { showResultTab('mine'); });
    if (tr) tr.addEventListener('click', function () { showResultTab('ref'); });
    wireTablist([tm, tr], function (t) { showResultTab(t === tm ? 'mine' : 'ref'); });
    if (tm) tm.setAttribute('tabindex', '0');
    if (tr) tr.setAttribute('tabindex', '-1');
    showResultTab('mine');

    /* L：今日收束卡的「返回练习」与「重试保存」。 */
    var wrapBack = $('btn-wrap-back');
    if (wrapBack) wrapBack.addEventListener('click', function () {
      var ta = $('sql-input');
      if (!ta) return;
      if (lastSel) { try { ta.setSelectionRange(lastSel[0], lastSel[1]); } catch (e) { /* 选区不可恢复时只聚焦 */ } }
      ta.focus();
      try { ta.scrollIntoView({ block: 'nearest' }); } catch (e) { /* 只聚焦 */ }
    });
    var retrySave = $('btn-retry-save');
    if (retrySave) retrySave.addEventListener('click', function () {
      var ok = saveProgress();
      renderStats();
      var box = $('today-wrap');
      if (box && !box.hidden) $('today-wrap-body').textContent = todayWrapText();
      updatePersistNotes();
      announce(ok && STORAGE_OK ? '已重新保存到浏览器。' : '保存仍未成功，进度仅保留在本页。');
    });

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

    /* C：浮层打开时 Tab 在浮层内循环，背景不接收焦点。 */
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab' || !openPanel) return;
      var panel = openPanel === 'drawer' ? $('drawer') : $('rail');
      var f = focusablesIn(panel);
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      var active = document.activeElement;
      var outside = !panel.contains(active);
      if (e.shiftKey && (active === first || outside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || outside)) { e.preventDefault(); first.focus(); }
    });

    /* 学习记录：可折叠面板，展开 / 收起带 aria-expanded，键盘可达。 */
    var recPanel = $('record-panel');
    var recBtn = $('btn-record');
    function setRecord(on) {
      if (recPanel) recPanel.hidden = !on;
      if (recBtn) recBtn.setAttribute('aria-expanded', String(!!on));
      if (on) renderStats();
      if (on) renderDiagnose();
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
    var value = $('sql-input').value;
    if (q) { state.sql[q.id] = value; saveProgress(); }
    /* D：本次提交后又改动 SQL —— 旧结果/旧判定明确标为过期，旧装饰回调失效；
       草稿照常保存，历史完成数（state.passed）不撤销。 */
    if (accepted && accepted.qid === currentId && value !== accepted.sql) {
      accepted.stale = true;
      markStale();
    }
    checkForbidden();
    updateSuggest();
    /* D/I：立即写当前状态；保存反馈合并到停止输入 400ms 后显示一次。 */
    editorStatusSave = '';
    paintEditorStatus();
    scheduleSaveStatus();
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
