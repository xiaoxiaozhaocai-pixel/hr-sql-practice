/*
 * src/app.js — DB Quest v2 界面逻辑（DOM 操作）
 * ---------------------------------------------------------------------------
 * 依赖注入关系（为什么这么分层）：
 *   HR_BOOT   —— build.mjs 内联进来的权威数据（题库 / DDL / DML / wasm base64）
 *   HRJudge   —— src/judge.js，纯函数判题引擎；本文件只「接线调用」，绝不改判题口径
 *   HRLevels  —— src/levels.js，段编排 + 游戏化状态机 + localStorage 读写（纯逻辑）
 *   HRDb      —— src/db.js，sql.js 加载 / 建库灌数 / 11 表自检 / 跑查询
 * 本文件只做三件事：把状态渲染成 DOM、把用户动作转成对上述模块的调用、把结果写回状态。
 *
 * 进度键 dbquest.v2（v1 练习台的键不复用，避免脏数据）。任何状态变化立即 saveProgress()。
 * 所有题库文本一律 textContent 写入，不拼 HTML。
 */
(function () {
  'use strict';

  var MAX_PREVIEW_ROWS = 200;   // 运行结果最多渲染 200 行，超出只提示总行数
  var BOOT = window.HR_BOOT || {};
  var QUESTIONS = Array.isArray(BOOT.questions) ? BOOT.questions : [];
  var BASELINE_DATE = BOOT.baselineDate || '2026-06-30';
  var L = window.HRLevels;
  var T = window.HRTables;
  var MODEL_NOTES = BOOT.modelNotes || null;

  /* 题 seq -> 涉及的表名（唯一权威源：docs/model-notes-v1.json 的 questions[].tables） */
  var TABLE_MAP = (T && MODEL_NOTES) ? T.questionTableMap(MODEL_NOTES.questions) : {};

  var SECTIONS = L ? L.buildSections(QUESTIONS) : [];
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
  var dbReady = false;
  var refCache = {};          // id -> 参考 SQL 的实跑结果（含是否与 expected.row_count 对账成功）
  var openSections = {};      // level -> 是否展开
  var currentId = null;

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

  function repeats(ch, n) { var s = ''; for (var i = 0; i < n; i++) s += ch; return s; }

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

  /* ------------------------------ 顶栏统计 ------------------------------ */
  function currentSection() {
    var q = currentQuestion();
    if (q && SECTION_OF[q.id]) return SECTION_OF[q.id];
    return SECTIONS[0] || null;
  }

  function renderStats() {
    var sec = currentSection();
    if (sec) $('stat-stage').textContent = '第' + sec.level + '段 ' + passedInSection(sec) + '/' + sec.questions.length;
    $('stat-xp').textContent = 'XP ' + state.xp;
    $('stat-hearts').textContent = repeats('\u2764', state.hearts) + repeats('\u{1F90D}', L.HEARTS_PER_LEVEL - state.hearts);
    $('stat-streak').textContent = '\u{1F525}' + state.streak;
    var goal = $('stat-goal');
    var met = L.goalMet(state);
    goal.textContent = '今日 ' + Math.min(state.todayCount, state.dailyGoal) + '/' + state.dailyGoal + (met ? ' \u2713' : '');
    goal.className = 'stat goal' + (met ? ' is-met' : '');
    var hh = $('q-hearts');
    if (hh) hh.textContent = '本关心 ' + repeats('\u2764', state.hearts) + repeats('\u{1F90D}', L.HEARTS_PER_LEVEL - state.hearts);
  }

  /* ------------------------------ 左栏主线 ------------------------------ */
  function renderNav() {
    var nav = $('section-nav');
    if (!nav) return;
    nav.textContent = '';
    var activeSec = currentSection();

    SECTIONS.forEach(function (sec) {
      var isActive = activeSec && activeSec.level === sec.level;
      if (openSections[sec.level] === undefined) openSections[sec.level] = !!isActive;

      var box = el('div', null, 'section' + (isActive ? ' active' : ''));
      var head = el('div', null, 'section-head');
      head.appendChild(el('span', (openSections[sec.level] ? '\u25be ' : '\u25b8 ') + '第' + sec.level + '段 · ' + sec.title));
      head.appendChild(el('span', passedInSection(sec) + '/' + sec.questions.length, 'sec-count'));
      head.addEventListener('click', function () {
        openSections[sec.level] = !openSections[sec.level];
        renderNav();
      });
      box.appendChild(head);

      var ul = el('ul', null, 'levels');
      ul.hidden = !openSections[sec.level];
      sec.questions.forEach(function (q) {
        var li = document.createElement('li');
        var cls = [];
        if (q.id === currentId) cls.push('active');
        if (state.passed[q.id]) cls.push('passed');
        if (state.wrong[q.id]) cls.push('wrong');
        if (cls.length) li.className = cls.join(' ');
        li.appendChild(el('span', '#' + q.seq, 'lv-seq'));
        var titleWrap = el('span', null, 'lv-title');
        titleWrap.appendChild(el('span', q.title || q.id));
        titleWrap.appendChild(el('span', q.knowledge_point || '', 'lv-kp'));
        li.appendChild(titleWrap);
        if (state.passed[q.id]) li.appendChild(el('span', '\u2713', 'lv-mark done'));
        else if (state.wrong[q.id]) li.appendChild(el('span', '\u26a0', 'lv-mark wrong-mark'));
        li.addEventListener('click', function () { selectLevel(q.id); });
        ul.appendChild(li);
      });
      box.appendChild(ul);
      nav.appendChild(box);
    });
  }

  function selectLevel(id) {
    if (!QUESTION_BY_ID[id]) return;
    currentId = id;
    state.current = id;
    var sec = SECTION_OF[id];
    if (sec) openSections[sec.level] = true;
    saveProgress();
    renderNav();
    renderStats();
    renderDetail();
  }

  /* ------------------------------ 渐进提示 ------------------------------ */
  function hintTexts(q) { return L.hintList(q); }

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
    $('hint-counter').textContent = list.length ? '已解锁 ' + seen + '/' + list.length : '本题未提供提示';
    show($('hint-empty'), seen === 0 && list.length > 0);
    var btn = $('btn-hint');
    btn.disabled = !list.length || seen >= list.length;
    btn.textContent = seen >= list.length && list.length ? '提示已全部解锁' : '再看一条';
  }

  /* ------------------------------ 表结构速查 ------------------------------ */
  /* 只渲染结构（表名 / 中文名 / 字段 / 类型 / 可空 / 业务含义），数据行一律不出现。 */
  function buildFieldTable(table, matchedFields) {
    var mark = {};
    (matchedFields || []).forEach(function (n) { mark[String(n).toUpperCase()] = true; });
    var tbl = el('table', null, 'field-table');
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
      tr.appendChild(el('td', f.note, 'f-note'));
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
      sum.appendChild(el('span', t.fields.length + ' 字段', 'tbl-chip-count'));
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

  /* 每题题干预设区：列出该题涉及的表，点开看全字段。标题用「涉及的表 / 字段」。 */
  function renderQuestionTables(q) {
    var block = $('q-tables-block');
    var box = $('q-tables');
    if (!block || !box) return;
    if (!T || !MODEL_NOTES) { show(block, false); return; }
    var names = TABLE_MAP[q.seq] || [];
    if (!names.length) { show(block, false); return; }
    box.textContent = '';
    names.forEach(function (n) { box.appendChild(tableChip(n, [], false)); });
    show(block, true);
  }

  /* 左栏「表结构」页签：可搜索、可点开；末尾附 3 个视图（只列作用）。 */
  function renderTablesPanel(keyword) {
    var list = $('tables-list');
    if (!list || !T) return;
    var kw = String(keyword || '').trim();
    list.textContent = '';
    var results = T.searchTables(kw);
    if (!results.length) {
      list.appendChild(el('div', '没有匹配的表或字段。', 'note'));
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

  function bindSidebarTabs() {
    var tl = $('tab-levels');
    var tt = $('tab-tables');
    if (!tl || !tt) return;
    function activate(tablesOn) {
      tl.classList.toggle('is-active', !tablesOn);
      tt.classList.toggle('is-active', tablesOn);
      tl.setAttribute('aria-selected', String(!tablesOn));
      tt.setAttribute('aria-selected', String(tablesOn));
      var pl = $('panel-levels');
      var pt = $('panel-tables');
      if (pl) pl.hidden = tablesOn;
      if (pt) pt.hidden = !tablesOn;
    }
    tl.addEventListener('click', function () { activate(false); });
    tt.addEventListener('click', function () { activate(true); });
    var search = $('tables-search');
    if (search) search.addEventListener('input', function () { renderTablesPanel(this.value); });
    renderTablesPanel('');
  }

  /* ------------------------------ 单关渲染 ------------------------------ */
  function renderDetail() {
    var q = currentQuestion();
    show($('detail-empty'), !q);
    show($('detail-body'), !!q);
    if (!q) return;

    $('q-title').textContent = '第' + q.level + '段 · #' + q.seq + ' ' + (q.title || q.id);

    var meta = $('q-meta');
    meta.textContent = '';
    var parts = ['难度 L' + q.level, '业务域 ' + (q.subject || '-'), '考点 ' + (q.knowledge_point || '-'), 'id ' + q.id];
    parts.forEach(function (t) { meta.appendChild(el('span', t)); });
    if (Array.isArray(q.tags) && q.tags.length) meta.appendChild(el('span', '标签 ' + q.tags.join(' / ')));

    var principle = $('q-principle');
    principle.textContent = '';
    principle.appendChild(el('div', '主考点：' + (q.knowledge_point || '-')));
    if (Array.isArray(q.secondary_points) && q.secondary_points.length) {
      principle.appendChild(el('div', '次要考点：' + q.secondary_points.join(' / ')));
    }
    principle.appendChild(el('div', '本题在结果集层面判分：只比跑出来的行与列，不比 SQL 写法。', 'note'));

    $('q-stem').textContent = q.stem || '';
    $('q-requirement').textContent = q.requirement || '';
    $('q-output').textContent = q.output_hint || '';

    renderQuestionTables(q);

    var sqlInput = $('sql-input');
    sqlInput.value = state.sql[q.id] || '';
    checkForbidden();

    renderHints(q);

    show($('ref-review-block'), false);
    show($('verdict'), false);
    show($('result-block'), false);
    show($('answer-block'), false);

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
  }

  /* forbidden_syntax 命中只警告不阻断（任务卡 §4.8）。 */
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

  function renderVerdict(kind, title, verdict, refColumns, extraNote) {
    var box = $('verdict');
    box.className = 'verdict ' + kind;
    box.textContent = '';
    box.appendChild(el('div', title));
    if (extraNote) box.appendChild(el('div', extraNote, 'note'));
    if (verdict) {
      box.appendChild(el('div', verdict.reason, 'note'));
      if (verdict.columnIssue) {
        var p = [verdict.columnIssue.message];
        if (verdict.columnIssue.missing && verdict.columnIssue.missing.length) p.push('缺失列：' + verdict.columnIssue.missing.join('、'));
        if (verdict.columnIssue.extra && verdict.columnIssue.extra.length) p.push('多余列：' + verdict.columnIssue.extra.join('、'));
        box.appendChild(el('div', p.join(' '), 'note'));
      }
      box.appendChild(el('div', '对齐方式 alignMode=' + verdict.alignMode +
        '；你的行数 ' + verdict.userRowCount + '，预期行数 ' + verdict.refRowCount, 'note'));
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
    renderVerdict('fail', 'SQL 执行错误（原样展示）：', {
      reason: msg, columnIssue: null, diffRows: [], alignMode: 'none', userRowCount: 0, refRowCount: 0
    }, null, '人话：' + explainError(msg));
  }

  /* ------------------------------ 数据库 / 参考结果 ------------------------------ */
  /* 预期结果 = 现场跑 reference_sql_sqlite，不信任写死的结果行；再与 expected.row_count 对账。
     对不上就打「题库待复核」并跳过判题 —— 把锅算在题库上，不算在学员头上。 */
  function referenceResult(q) {
    if (refCache[q.id] !== undefined) return refCache[q.id];
    var out = { ok: false, error: null, result: null, expectedRowCount: null, mismatch: false };
    var sql = q.reference_sql_sqlite || q.reference_sql || '';
    try {
      out.result = window.HRDb.runQuery(db, sql);
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
    renderTable($('result-table'), res.columns, res.rows, MAX_PREVIEW_ROWS);
    $('result-note').textContent = '共 ' + res.rows.length + ' 行、' + res.columns.length + ' 列' +
      (res.rows.length > MAX_PREVIEW_ROWS ? '，仅显示前 ' + MAX_PREVIEW_ROWS + ' 行。' : '。');
    show($('result-block'), true);
    if (q) { state.sql[q.id] = sql; saveProgress(); }
  }

  function doJudge() {
    if (!requireDb()) return;
    var q = currentQuestion();
    if (!q) return;
    var sql = $('sql-input').value;
    if (!sql.trim()) { renderVerdict('warn', '请先写 SQL 再判题。', null, null); return; }

    var ref = referenceResult(q);
    if (!ref.ok) {
      $('ref-review-block').textContent = '⚠ 题库待复核：参考 SQL（reference_sql_sqlite）在当前库上执行失败——' + ref.error + '。本题不判你的对错。';
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

    /* 题库对账不通过 → 不判用户错，也不扣心。 */
    if (ref.mismatch) {
      $('ref-review-block').textContent = '⚠ 题库待复核：参考 SQL 实跑 ' + ref.result.rows.length +
        ' 行，与 expected.row_count=' + ref.expectedRowCount + ' 不一致。本题不判你的对错（下方结论仅供参考），也不扣心。';
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
      var note = r.firstTime
        ? '过关 +' + r.xpGained + ' XP' + (r.streak > 0 ? '，连胜 ' + r.streak : '')
        : '重复通关，不再加分（同一关只计一次）';
      if (r.goalMet && r.firstTime) note += '；今日目标已达成 \u2713';
      renderVerdict('pass', '通过 —— ' + note, verdict, ref.result.columns);
    } else {
      var w = L.recordWrong(state, q.id);
      saveProgress();
      var hintList = hintTexts(q);
      var before = state.hintSeen[q.id] || 0;
      if (before < hintList.length) {
        state.hintSeen[q.id] = before + 1;   // 判错自动解锁下一条提示（渐进，不一次甩全）
        saveProgress();
      }
      renderHints(q);
      var note2 = w.reset
        ? '休息一下，本关重新开始（心已回满，已通过的关不受影响）。错题已记入错题本。'
        : '不通过，扣 1 颗心，还剩 ' + w.hearts + ' 颗。错题已记入错题本。';
      renderVerdict('fail', '未通过 —— ' + note2, verdict, ref.result.columns);
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
  /* 补全口径：token 以 HR_ 开头（或含下划线）→ 补表名；其余情况 → 补「SQL 里已出现的表」
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
    if (!namesInText.length && q) namesInText = TABLE_MAP[q.seq] || [];
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

  /* ------------------------------ 事件绑定 ------------------------------ */
  function bindUi() {
    $('btn-hint').addEventListener('click', revealNextHint);
    $('btn-run').addEventListener('click', doRun);
    $('btn-judge').addEventListener('click', doJudge);
    $('btn-answer').addEventListener('click', doAnswer);

    var sqlInput = $('sql-input');
    /* Tab 插入两个空格，不把焦点跳走（键盘用户友好；任务卡 §4.3） */
    sqlInput.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      var s = this.selectionStart;
      var t = this.selectionEnd;
      this.value = this.value.slice(0, s) + '  ' + this.value.slice(t);
      this.selectionStart = this.selectionEnd = s + 2;
      onSqlEdit();
    });
    sqlInput.addEventListener('input', onSqlEdit);
    sqlInput.addEventListener('blur', function () { hideSuggest(); });
    sqlInput.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') hideSuggest();
    });
    bindSidebarTabs();

    $('btn-drawer').addEventListener('click', function () {
      var sb = document.querySelector('.sidebar');
      var collapsed = sb.classList.toggle('collapsed');
      this.textContent = collapsed ? '展开' : '收起';
      this.setAttribute('aria-expanded', String(!collapsed));
    });

    $('btn-reset').addEventListener('click', function () {
      if (!window.confirm('确定重置全部进度？XP / 通过记录 / 错题本 / 今日计数 / 已写 SQL 全部清空。')) return;
      if (!window.confirm('再确认一次：此操作不可撤销。')) return;
      state = L.freshState();
      L.ensureDay(state, L.todayStamp());
      saveProgress();
      refCache = {};
      openSections = {};
      currentId = null;
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
    window.HRDb.createDatabase(initSqlJs, {
      wasmBase64: BOOT.wasmBase64,
      schemaSql: BOOT.schemaSql,
      seedSql: BOOT.seedSql,
      expectedCounts: BOOT.rowcountExpected || {}
    }).then(function (r) {
      showBanner('load-banner', '');
      db = r.db;
      dbReady = true;
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
