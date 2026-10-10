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
  var BOOT = window.HR_BOOT || {};
  var QUESTIONS = Array.isArray(BOOT.questions) ? BOOT.questions : [];
  var BASELINE_DATE = BOOT.baselineDate || '2026-06-30';
  var L = window.HRLevels;
  var T = window.HRTables;

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
  function safeStorage() {
    try {
      var t = '__dbquest_probe__';
      window.localStorage.setItem(t, '1');
      window.localStorage.removeItem(t);
      return window.localStorage;
    } catch (e) {
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

  var openPanel = null;       // 'drawer' | 'rail' | null
  var lastRun = null;         // { columns, rows }：最近一次「运行」的结果，供结果区 tab 切换
  var filter = { kw: '', diffs: {}, undoneOnly: false };

  /* ------------------------------ 小工具 ------------------------------ */
  function $(id) { return document.getElementById(id); }

  function el(tag, text, cls) {
    var node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (cls) node.className = cls;
    return node;
  }

  function show(node, on) { if (node) node.hidden = !on; }

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

  /* ------------------------------ 顶栏统计：进度 + 游戏化指标 ------------------------------ */
  function currentSection() {
    var q = currentQuestion();
    if (q && SECTION_OF[q.id]) return SECTION_OF[q.id];
    return SECTIONS[0] || null;
  }

  function repeats(ch, n) { var s = ''; for (var i = 0; i < n; i++) s += ch; return s; }

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
    /* 游戏化指标（设计意图，2026-10-10 恢复渲染层） */
    var xp = $('stat-xp');
    if (xp) xp.textContent = 'XP ' + state.xp;
    var hearts = $('stat-hearts');
    if (hearts) hearts.textContent = repeats('\u2764', state.hearts) + repeats('\u{1F90D}', Math.max(0, L.HEARTS_PER_LEVEL - state.hearts));
    var streak = $('stat-streak');
    if (streak) streak.textContent = '\u{1F525}' + state.streak;
    var goal = $('stat-goal');
    if (goal) {
      var met = L.goalMet(state);
      goal.textContent = '今日 ' + Math.min(state.todayCount, state.dailyGoal) + '/' + state.dailyGoal + (met ? ' \u2713' : '');
      goal.className = 'stat stat-goal' + (met ? ' is-met' : '');
    }
    var qh = $('q-hearts');
    if (qh) qh.textContent = '本关心 ' + repeats('\u2764', state.hearts) + repeats('\u{1F90D}', Math.max(0, L.HEARTS_PER_LEVEL - state.hearts));
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

    SECTIONS.forEach(function (sec) {
      var qs = sec.questions.filter(questionMatches);
      var isActive = activeSec && activeSec.section === sec.section;

      var head = el('div', null, 'group-head' + (isActive ? ' on' : ''));
      head.appendChild(el('span', '第 ' + sec.section + ' 段 · ' + sec.title, 'group-title'));
      head.appendChild(el('span', passedInSection(sec) + '/' + sec.questions.length, 'group-count'));
      nav.appendChild(head);

      if (!qs.length) { nav.appendChild(el('div', '本段没有匹配的题', 'group-empty')); return; }

      var ul = el('ul', null, 'qgroup');
      qs.forEach(function (q) {
        var li = el('li', null, q.id === currentId ? 'on' : '');
        var row = el('div', null, 'q-row');
        row.appendChild(el('span', pad2(q.seq), 'no'));
        row.appendChild(el('span', q.title || q.id, 'qt'));
        li.appendChild(row);

        var meta = el('span', null, 'qmeta');
        meta.appendChild(el('span', q.subject || '-', 'chip solid'));
        meta.appendChild(el('span', 'L' + q.level, 'chip'));
        if (state.passed[q.id]) meta.appendChild(el('span', '已完成', 'chip ok'));
        else if (state.wrong[q.id]) meta.appendChild(el('span', '待重做', 'chip warn'));
        li.appendChild(meta);

        li.addEventListener('click', function () { selectLevel(q.id); });
        ul.appendChild(li);
      });
      nav.appendChild(ul);
    });
  }

  function selectLevel(id) {
    if (!QUESTION_BY_ID[id]) return;
    currentId = id;
    state.current = id;
    saveProgress();
    renderNav();
    renderStats();
    renderDetail();
    if (openPanel === 'rail') closePanel();
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

  /* syntax_intro 首现卡片：SYNTAX_BY_ID 已按 section→seq 扫好，只渲染首现项；
     无有效卡片时整块隐藏（不出现空壳）。与题面同层，不放进任何折叠容器。 */
  function renderSyntaxCards(q) {
    var host = $('q-syntax');
    if (!host) return;
    host.textContent = '';
    host.hidden = true;
    var cards = q ? SYNTAX_BY_ID[q.id] : null;
    if (!cards || !cards.length) return;
    cards.forEach(function (c) {
      var card = el('div', null, 'syntax-card');
      card.appendChild(el('div', c.syntax, 'syntax-name'));
      var body = el('div', null, 'syntax-body');
      [['说明', c.what, ''], ['何时用', c.when, ''], ['示例', c.example, 'syntax-code'], ['常见误用', c.misuse, '']]
        .forEach(function (pair) {
          var row = el('div', null, 'syntax-row');
          row.appendChild(el('b', pair[0] + '：'));
          row.appendChild(el('span', pair[1], pair[2]));
          body.appendChild(row);
        });
      card.appendChild(body);
      host.appendChild(card);
    });
    host.hidden = false;
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

    show($('ref-review-block'), false);
    show($('verdict'), false);
    show($('result-block'), false);
    show($('answer-block'), false);
    lastRun = null;

    var post = $('post-pass-block');
    if (state.passed[q.id]) { renderPostPass(q); show(post, true); } else { show(post, false); }

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

  function renderVerdict(kind, title, verdict, refColumns, extraNote) {
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
      if (verdict.diffRows && verdict.diffRows.length) {
        var wrap = el('div', null, 'diff');
        wrap.appendChild(el('div', '差异样例（最多 10 条）：'));
        verdict.diffRows.forEach(function (d) {
          var label = d.kind === 'extra' ? '多余行' : d.kind === 'missing' ? '缺失行' : '不一致行';
          var cols = Array.isArray(refColumns) && refColumns.length ? ' 列：' + refColumns.join(' | ') : '';
          wrap.appendChild(el('div', '[' + label + ']' + cols + '  ' + JSON.stringify(d.row), 'k-' + d.kind));
        });
        box.appendChild(wrap);
      }
    }
    show(box, true);
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

  function doRun() {
    if (!requireDb()) return;
    var q = currentQuestion();
    var sql = $('sql-input').value;
    if (!sql.trim()) { renderVerdict('warn', '请先写 SQL。', null, null); return; }
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

  /* 判题：同步计算，但先给按钮 loading 态让浏览器有机会重绘；不阻塞编辑器输入。 */
  function setJudgeLoading(on) {
    var b = $('btn-judge');
    if (!b) return;
    if (on) { b.setAttribute('data-label', b.textContent); b.textContent = '判题中…'; b.disabled = true; }
    else { var lbl = b.getAttribute('data-label'); if (lbl) b.textContent = lbl; b.disabled = false; }
  }

  function doJudge() {
    if (judging) return;
    judging = true;
    setJudgeLoading(true);
    setTimeout(function () {
      try { judgeNow(); }
      catch (err) { renderRunError(String(err && err.message ? err.message : err)); }
      finally { judging = false; setJudgeLoading(false); }
    }, 0);
  }

  function judgeNow() {
    if (!requireDb()) return;
    var q = currentQuestion();
    if (!q) return;
    var sql = $('sql-input').value;
    if (!sql.trim()) { renderVerdict('warn', '请先写 SQL 再判题。', null, null); return; }

    var ref = referenceResult(q);
    if (!ref.ok) {
      $('ref-review-block').textContent = '题库待复核：参考 SQL（reference_sql_sqlite）在当前库上执行失败——' + ref.error + '。本题不判你的对错。';
      show($('ref-review-block'), true);
      renderVerdict('warn', '本题标记「题库待复核」，跳过判题。', null, null);
      return;
    }
    show($('ref-review-block'), false);

    var res;
    try {
      res = window.HRDb.runQuery(db, sql);
    } catch (e) {
      renderRunError(String(e && e.message ? e.message : e));
      return;
    }

    var verdict = window.HRJudge.judgeResult(
      res.rows, res.columns,
      ref.result.rows, ref.result.columns,
      { orderSensitive: !!(q.expected && q.expected.order_sensitive) }
    );

    lastRun = { columns: res.columns, rows: res.rows, truncated: !!res.truncated };
    show($('result-block'), true);
    showResultTab('mine');

    /* 题库对账不通过 -> 不判用户错。 */
    if (ref.mismatch) {
      $('ref-review-block').textContent = '题库待复核：参考 SQL 实跑 ' + ref.result.rows.length +
        ' 行，与 expected.row_count=' + ref.expectedRowCount + ' 不一致。本题不判你的对错（下方结论仅供参考）。';
      show($('ref-review-block'), true);
      renderVerdict('warn', '本题标记「题库待复核」。', verdict, ref.result.columns);
      return;
    }

    state.sql[q.id] = sql;

    if (verdict.pass) {
      var r = L.recordPass(state, q.id);
      saveProgress();
      renderPostPass(q);
      show($('post-pass-block'), true);
      renderVerdict('pass', '通过 —— ' + (r.firstTime ? '首次通关' : '重复通关（同一关只计一次）'), verdict, ref.result.columns);
    } else {
      L.recordWrong(state, q.id);
      saveProgress();
      /* 判错自动解锁下一条提示（渐进，不一次甩全） */
      var hintList = hintTexts(q);
      var before = state.hintSeen[q.id] || 0;
      if (before < hintList.length) { state.hintSeen[q.id] = before + 1; saveProgress(); }
      renderHints(q);
      renderVerdict('fail', '未通过 —— 结果与预期不一致，已记入错题本；练习不扣分，看提示后重试即可。', verdict, ref.result.columns);
    }
    renderStats();
    renderNav();
  }

  function doAnswer() {
    var q = currentQuestion();
    if (!q) return;
    $('answer-mssql').textContent = q.reference_sql || '（题库未提供 reference_sql，本题禁用查看答案）';
    $('answer-sqlite').textContent = q.reference_sql_sqlite || q.reference_sql || '（题库未提供）';
    $('answer-note').textContent = '上方为 SQL Server 权威写法（仅展示、不执行，含 dbo. 前缀）；下方为 SQLite 等价写法，' +
      '判题的预期结果就是它在当前库上现场跑出来的。权威以 SQL Server 版为准。基准日固定 ' + BASELINE_DATE + '。';
    show($('answer-block'), true);
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
  }

  function updateSuggest() {
    var box = $('sql-suggest');
    var ta = $('sql-input');
    if (!box || !ta) return;
    if (document.activeElement !== ta || ta.selectionStart !== ta.selectionEnd) { hideSuggest(); return; }
    var items = sqlSuggestions(ta.value, ta.selectionStart);
    if (!items.length) { hideSuggest(); return; }
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
      if (e.key === 'Escape') hideSuggest();
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

    /* Esc 关闭浮层 */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && openPanel) closePanel();
    });

    $('btn-reset').addEventListener('click', function () {
      if (!window.confirm('确定重置全部进度？通过记录 / 错题本 / 已写 SQL 全部清空。')) return;
      if (!window.confirm('再确认一次：此操作不可撤销。')) return;
      state = L.freshState();
      L.ensureDay(state, L.todayStamp());
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
  }

  function onSqlEdit() {
    var q = currentQuestion();
    if (q) { state.sql[q.id] = $('sql-input').value; saveProgress(); }
    checkForbidden();
    updateSuggest();
  }

  /* ------------------------------ 启动 ------------------------------ */
  function boot() {
    if (!L) { showBanner('load-banner', '初始化失败：关卡编排模块 HRLevels 缺失。'); return; }
    if (!QUESTIONS.length) {
      showBanner('load-banner', '题库为空：未能从内联数据中读到 questions。');
      return;
    }
    bindUi();

    /* 品牌行题数按题库实际长度注入，避免下次扩容再改 HTML。 */
    var brandMeta = $('brand-meta');
    if (brandMeta) brandMeta.textContent = '题库 v1.0 · ' + QUESTIONS.length + ' 题';

    /* 恢复上次所在关；无效则落回第一关。 */
    var startId = state.current && QUESTION_BY_ID[state.current] ? state.current : SECTIONS[0].questions[0].id;
    currentId = startId;
    state.current = startId;
    saveProgress();
    renderNav();
    renderStats();
    renderDetail();

    if (!window.HRDb || typeof initSqlJs !== 'function') {
      showBanner('load-banner', '初始化失败：内联脚本未完整加载（HRDb / initSqlJs 缺失）。');
      return;
    }
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
      /* 库就绪后补渲染一次码值对照：首屏渲染时库还没建好，查不了 HR_DICT。 */
      renderDictHints(currentQuestion());
      /* 11 表行数对不上：页面红条提示，而不是白屏。 */
      if (!r.selfCheck.ok) {
        showBanner('selfcheck-banner', '库自检失败（' + r.selfCheck.okCount + '/' + r.selfCheck.total + ' 表不符）：' +
          r.selfCheck.tables.filter(function (t) { return !t.ok; })
            .map(function (t) { return t.table + ' 期望 ' + t.expected + ' 实得 ' + t.actual; }).join('；'));
      }
    })['catch'](function (e) {
      showBanner('load-banner', '数据库初始化失败：' + (e && e.message ? e.message : e));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
