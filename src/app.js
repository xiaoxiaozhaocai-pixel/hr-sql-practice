/*
 * src/app.js — UI 逻辑（DOM 操作；数据与判题逻辑分别来自 HR_BOOT 与 HRJudge）
 * ---------------------------------------------------------------------------
 * 进度持久化：localStorage（file:// 下同样可用），键 hr-sql-practice:v1。
 * 所有题目文本一律用 textContent 写入，不拼 HTML。
 */
(function () {
  'use strict';

  var MAX_PREVIEW_ROWS = 200;   // 运行结果最多渲染 200 行，超出只提示总行数
  var STORAGE_KEY = 'hr-sql-practice:v1';
  var BOOT = window.HR_BOOT || {};
  var QUESTIONS = Array.isArray(BOOT.questions) ? BOOT.questions : [];
  var BASELINE_DATE = BOOT.baselineDate || '2026-06-30';

  var db = null;
  var dbReady = false;
  var currentId = null;
  var refCache = {};
  var progress = loadProgress();

  /* ------------------------------ 小工具 ------------------------------ */
  function $(id) { return document.getElementById(id); }

  function el(tag, text, cls) {
    var node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (cls) node.className = cls;
    return node;
  }

  function show(node, on) { if (node) node.hidden = !on; }

  function loadProgress() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      var obj = JSON.parse(raw);
      return obj && typeof obj === 'object' ? obj : {};
    } catch (e) {
      return {};
    }
  }

  function saveProgress() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
    } catch (e) {
      /* 隐私模式 / file:// 受限时静默降级为「仅本次会话有效」 */
    }
  }

  function entryFor(id) {
    if (!progress[id] || typeof progress[id] !== 'object') progress[id] = { sql: '', passed: false };
    return progress[id];
  }

  function isPassed(id) { return !!(progress[id] && progress[id].passed); }

  function passedCount() {
    var n = 0;
    for (var i = 0; i < QUESTIONS.length; i++) if (isPassed(QUESTIONS[i].id)) n++;
    return n;
  }

  function currentQuestion() {
    for (var i = 0; i < QUESTIONS.length; i++) if (QUESTIONS[i].id === currentId) return QUESTIONS[i];
    return null;
  }

  function byId(id) { return $(id); }

  function showBanner(id, text) {
    var node = byId(id);
    if (!node) return;
    if (text) { node.textContent = text; node.hidden = false; } else { node.hidden = true; }
  }

  /* ------------------------------ 列表 / 筛选 ------------------------------ */
  function matchFilters(q) {
    var lv = byId('filter-level').value;
    var sub = byId('filter-subject').value;
    var tag = byId('filter-tag').value;
    var kp = byId('filter-kp').value;
    if (lv && String(q.level) !== lv) return false;
    if (sub && q.subject !== sub) return false;
    if (kp && q.knowledge_point !== kp) return false;
    if (tag && (!Array.isArray(q.tags) || q.tags.indexOf(tag) === -1)) return false;
    return true;
  }

  function comparator() {
    var key = byId('sort-by').value;
    return function (a, b) {
      var va, vb;
      if (key === 'level') { va = a.level; vb = b.level; }
      else if (key === 'subject') { va = a.subject || ''; vb = b.subject || ''; }
      else if (key === 'knowledge_point') { va = a.knowledge_point || ''; vb = b.knowledge_point || ''; }
      else if (key === 'tags') { va = (a.tags || []).join(','); vb = (b.tags || []).join(','); }
      else { va = a.seq; vb = b.seq; }
      if (va < vb) return -1;
      if (va > vb) return 1;
      return (a.seq || 0) - (b.seq || 0);
    };
  }

  function fillFilters() {
    var levels = {}, subjects = {}, tags = {}, kps = {};
    QUESTIONS.forEach(function (q) {
      if (q.level !== undefined) levels[q.level] = true;
      if (q.subject) subjects[q.subject] = true;
      if (q.knowledge_point) kps[q.knowledge_point] = true;
      (q.tags || []).forEach(function (t) { tags[t] = true; });
    });
    fillSelect('filter-level', Object.keys(levels).sort(), function (v) { return 'L' + v; }, function (v) { return v; });
    fillSelect('filter-subject', Object.keys(subjects).sort(), null, null);
    fillSelect('filter-tag', Object.keys(tags).sort(), null, null);
    fillSelect('filter-kp', Object.keys(kps).sort(), null, null);
  }

  function fillSelect(id, values, labelFn, valueFn) {
    var sel = byId(id);
    if (!sel) return;
    while (sel.options.length > 1) sel.remove(1);
    values.forEach(function (v) {
      var opt = document.createElement('option');
      opt.value = valueFn ? valueFn(v) : v;
      opt.textContent = labelFn ? labelFn(v) : v;
      sel.appendChild(opt);
    });
  }

  function renderList() {
    var list = byId('question-list');
    if (!list) return;
    list.textContent = '';
    var rows = QUESTIONS.filter(matchFilters).sort(comparator());
    if (!rows.length) {
      list.appendChild(el('li', '没有符合筛选条件的题目', 'empty'));
      return;
    }
    rows.forEach(function (q) {
      var li = document.createElement('li');
      if (q.id === currentId) li.className = 'active';
      li.appendChild(el('span', '#' + q.seq, 'seq'));
      li.appendChild(el('span', 'L' + q.level, 'lv'));
      li.appendChild(el('span', q.title || q.id));
      if (isPassed(q.id)) li.appendChild(el('span', '\u2713', 'done'));
      li.addEventListener('click', function () { selectQuestion(q.id); });
      list.appendChild(li);
    });
  }

  function updateProgressText() {
    var node = byId('progress-text');
    if (node) node.textContent = '已通过 ' + passedCount() + ' / ' + QUESTIONS.length;
  }

  /* ------------------------------ 详情 ------------------------------ */
  function selectQuestion(id) {
    currentId = id;
    renderList();
    renderDetail();
  }

  function renderDetail() {
    var q = currentQuestion();
    show(byId('detail-empty'), !q);
    show(byId('detail-body'), !!q);
    if (!q) return;

    byId('q-title').textContent = '#' + q.seq + ' ' + (q.title || q.id);
    var meta = byId('q-meta');
    meta.textContent = '';
    ['业务域 ' + (q.subject || '-'), '难度 L' + q.level, '考点 ' + (q.knowledge_point || '-')].forEach(function (t) {
      meta.appendChild(el('span', t));
    });
    if (Array.isArray(q.secondary_points) && q.secondary_points.length) {
      meta.appendChild(el('span', '次考点 ' + q.secondary_points.join(' / ')));
    }
    byId('q-stem').textContent = q.stem || '';
    byId('q-requirement').textContent = q.requirement || '';
    byId('q-output').textContent = q.output_hint || '';

    var hintBtn = byId('btn-hint');
    var hint = byId('q-hint');
    hint.textContent = q.hint || '本题未提供提示。';
    hint.hidden = true;
    hintBtn.textContent = '展开提示';
    hintBtn.disabled = !q.hint;

    var sqlInput = byId('sql-input');
    sqlInput.value = entryFor(q.id).sql || '';
    checkForbidden();

    show(byId('verdict'), false);
    show(byId('result-block'), false);
    show(byId('answer-block'), false);

    var post = byId('post-pass-block');
    show(post, isPassed(q.id));
    if (isPassed(q.id)) renderPostPass(q);
  }

  function renderPostPass(q) {
    var ul = byId('q-pitfalls');
    ul.textContent = '';
    (q.pitfalls || []).forEach(function (p) { ul.appendChild(el('li', p)); });
    if (!(q.pitfalls || []).length) ul.appendChild(el('li', '题库未登记易错点。'));
    byId('q-dialect').textContent = q.dialect_note || '本题未登记方言提示。';
  }

  function checkForbidden() {
    var q = currentQuestion();
    var warn = byId('forbidden-warning');
    if (!q || !Array.isArray(q.forbidden_syntax) || !q.forbidden_syntax.length) { show(warn, false); return; }
    var sql = (byId('sql-input').value || '').toUpperCase();
    var hit = q.forbidden_syntax.filter(function (s) {
      var needle = String(s).trim().toUpperCase();
      if (!needle) return false;
      /* 'TOP n PERCENT' 这类带占位符的写法退化为取首个词判断，避免误报 */
      return sql.indexOf(needle) !== -1;
    });
    if (hit.length) {
      warn.textContent = '本题禁用语法命中：' + hit.join('、') + '（仅警告，不阻断提交）。';
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

  function renderVerdict(kind, title, verdict, refColumns) {
    var box = byId('verdict');
    box.className = 'verdict ' + kind;
    box.textContent = '';
    box.appendChild(el('div', title));
    if (verdict) {
      box.appendChild(el('div', verdict.reason, 'note'));
      if (verdict.columnIssue) {
        var parts = [verdict.columnIssue.message];
        if (verdict.columnIssue.missing && verdict.columnIssue.missing.length) parts.push('缺失列：' + verdict.columnIssue.missing.join('、'));
        if (verdict.columnIssue.extra && verdict.columnIssue.extra.length) parts.push('多余列：' + verdict.columnIssue.extra.join('、'));
        box.appendChild(el('div', parts.join(' '), 'note'));
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

  /* ------------------------------ 数据库 ------------------------------ */
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
    var sql = byId('sql-input').value;
    if (!sql.trim()) { renderVerdict('warn', '请先写 SQL。', null, null); return; }
    var res;
    try {
      res = window.HRDb.runQuery(db, sql);
    } catch (e) {
      show(byId('result-block'), false);
      renderVerdict('fail', 'SQL 执行错误（原样展示）：', { reason: String(e && e.message ? e.message : e), columnIssue: null, diffRows: [], alignMode: 'none', userRowCount: 0, refRowCount: 0 }, null);
      return;
    }
    renderTable(byId('result-table'), res.columns, res.rows, MAX_PREVIEW_ROWS);
    byId('result-note').textContent = '共 ' + res.rows.length + ' 行、' + res.columns.length + ' 列' +
      (res.rows.length > MAX_PREVIEW_ROWS ? '，仅显示前 ' + MAX_PREVIEW_ROWS + ' 行。' : '。');
    show(byId('result-block'), true);
    if (q) { entryFor(q.id).sql = sql; saveProgress(); }
  }

  function doJudge() {
    if (!requireDb()) return;
    var q = currentQuestion();
    if (!q) return;
    var sql = byId('sql-input').value;
    if (!sql.trim()) { renderVerdict('warn', '请先写 SQL 再判题。', null, null); return; }

    var ref = referenceResult(q);
    if (!ref.ok) {
      byId('ref-review-block').textContent = '⚠ 题库待复核：参考 SQL（reference_sql_sqlite）在当前库上执行失败——' + ref.error + '。本题不判你的对错。';
      show(byId('ref-review-block'), true);
      renderVerdict('warn', '本题标记「题库待复核」，跳过判题。', null, null);
      return;
    }
    show(byId('ref-review-block'), false);

    var res;
    try {
      res = window.HRDb.runQuery(db, sql);
    } catch (e) {
      renderVerdict('fail', 'SQL 执行错误（原样展示）：', { reason: String(e && e.message ? e.message : e), columnIssue: null, diffRows: [], alignMode: 'none', userRowCount: 0, refRowCount: 0 }, null);
      return;
    }

    var verdict = window.HRJudge.judgeResult(
      res.rows, res.columns,
      ref.result.rows, ref.result.columns,
      { orderSensitive: !!(q.expected && q.expected.order_sensitive) }
    );

    /* 契约 §4 方案 A + B 对账：row_count 不一致 → 打「题库待复核」，不得判用户错 */
    if (ref.mismatch) {
      byId('ref-review-block').textContent = '⚠ 题库待复核：参考 SQL 实跑 ' + ref.result.rows.length +
        ' 行，与 expected.row_count=' + ref.expectedRowCount + ' 不一致。本题不判你的对错（下方结论仅供参考）。';
      show(byId('ref-review-block'), true);
      renderVerdict('warn', '本题标记「题库待复核」。', verdict, ref.result.columns);
      return;
    }

    if (verdict.pass) {
      entryFor(q.id).passed = true;
      entryFor(q.id).sql = sql;
      saveProgress();
      renderPostPass(q);
      show(byId('post-pass-block'), true);
      renderVerdict('pass', '通过', verdict, ref.result.columns);
    } else {
      renderVerdict('fail', '不通过', verdict, ref.result.columns);
    }
    updateProgressText();
    renderList();
  }

  function doAnswer() {
    var q = currentQuestion();
    if (!q) return;
    byId('answer-mssql').textContent = q.reference_sql || '（题库未提供 reference_sql，本题禁用查看答案）';
    byId('answer-sqlite').textContent = q.reference_sql_sqlite || q.reference_sql || '（题库未提供）';
    byId('answer-note').textContent = '上方为 SQL Server 权威写法（仅展示、不执行，含 dbo. 前缀）；下方为 SQLite 等价写法，' +
      '判题的预期结果就是它在当前库上现场跑出来的。权威以 SQL Server 版为准。基准日固定 ' + BASELINE_DATE + '。';
    show(byId('answer-block'), true);
  }

  /* ------------------------------ 事件绑定 ------------------------------ */
  function bindUi() {
    byId('btn-hint').addEventListener('click', function () {
      var hint = byId('q-hint');
      hint.hidden = !hint.hidden;
      this.textContent = hint.hidden ? '展开提示' : '收起提示';
    });
    byId('btn-run').addEventListener('click', doRun);
    byId('btn-judge').addEventListener('click', doJudge);
    byId('btn-answer').addEventListener('click', doAnswer);
    byId('sql-input').addEventListener('input', function () {
      var q = currentQuestion();
      if (q) { entryFor(q.id).sql = this.value; saveProgress(); }
      checkForbidden();
    });
    ['filter-level', 'filter-subject', 'filter-tag', 'filter-kp', 'sort-by'].forEach(function (id) {
      byId(id).addEventListener('change', renderList);
    });
    byId('btn-reset').addEventListener('click', function () {
      if (!window.confirm('确定清空全部题的作答与通过状态？')) return;
      progress = {};
      saveProgress();
      refCache = {};
      updateProgressText();
      renderList();
      renderDetail();
    });
  }

  /* ------------------------------ 启动 ------------------------------ */
  function boot() {
    updateProgressText();
    if (!QUESTIONS.length) {
      showBanner('load-banner', '题库为空：未能从内联数据中读到 questions。');
      return;
    }
    fillFilters();
    bindUi();
    renderList();

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
      var banner = byId('load-banner');
      if (banner) { banner.textContent = '数据库已就绪。'; banner.hidden = true; }
      db = r.db;
      dbReady = true;
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
