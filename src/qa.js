/*
 * src/qa.js — 「问一问」本地问答内核（纯逻辑：不碰 DOM / window / fs，零网络）
 * ---------------------------------------------------------------------------
 * 双模加载：node module.exports / 浏览器 globalThis.HRQa（与 src/tables.js 同款 UMD）。
 * 数据来源全部是站内既有数据，本模块不新增数据、不解析 docs/*.md：
 *   - 表结构：HRTables.allTables()（11 表；字段含 name / type / nullable / note）
 *   - 题库：boot.questions（每题 id/seq/title/knowledge_point/secondary_points/pitfalls/...）
 *   - 语法卡：HRLevels.syntaxIntrosFor(questions) 的产物（syntax/what/when/example/misuse）
 * 口径：命中就给结论并指来源；未命中必须明说「本地知识里没有这条」，严禁编造。
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory();
  } else {
    root.HRQa = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var FALLBACK_TITLE = '本地知识里没有这条';
  var SCOPE_HINT = '我只答站内三类来源：表 / 字段（表结构速查）、当前题的考点 / 易错点 / 要求、语法卡。';

  function str(v) { return v === null || v === undefined ? '' : String(v); }
  function lower(v) { return str(v).trim().toLowerCase(); }
  function uniq(arr) {
    var out = [];
    (Array.isArray(arr) ? arr : []).forEach(function (x) { if (x && out.indexOf(x) === -1) out.push(x); });
    return out;
  }

  /* ------------------------------ 索引 ------------------------------ */

  function copyCard(c) {
    return {
      syntax: str(c.syntax).trim(),
      what: str(c.what).trim(),
      when: str(c.when).trim(),
      example: str(c.example).trim(),
      misuse: str(c.misuse).trim()
    };
  }
  function validCard(c) {
    return c && typeof c === 'object' && !Array.isArray(c) && str(c.syntax).trim();
  }

  /* 语法卡入参两种形态都吃：id -> 卡片数组（syntaxIntrosFor 产物）或扁平数组。 */
  function flattenCards(raw) {
    var out = [];
    if (Array.isArray(raw)) {
      raw.forEach(function (c) { if (validCard(c)) out.push(copyCard(c)); });
    } else if (raw && typeof raw === 'object') {
      Object.keys(raw).forEach(function (id) {
        (Array.isArray(raw[id]) ? raw[id] : []).forEach(function (c) { if (validCard(c)) out.push(copyCard(c)); });
      });
    }
    return out;
  }

  /**
   * 建本地索引：表 / 字段倒排 + 业务词别名 + 语法卡标题索引。
   * @param {{tables?:Array, questions?:Array, syntaxCards?:Array|Object}} input
   */
  function buildIndex(input) {
    var opts = input || {};
    var tables = Array.isArray(opts.tables) ? opts.tables : [];
    var questions = Array.isArray(opts.questions) ? opts.questions : [];
    var cards = flattenCards(opts.syntaxCards);

    var tableByName = {};
    var fields = [];
    var fieldIndex = {};
    var aliases = {};

    function addAlias(term, entry) {
      var k = lower(term);
      if (!k) return;
      if (!aliases[k]) aliases[k] = [];
      for (var i = 0; i < aliases[k].length; i++) {
        if (aliases[k][i].kind === entry.kind && aliases[k][i].label === entry.label) return;
      }
      aliases[k].push(entry);
    }

    tables.forEach(function (t) {
      if (!t || !t.name) return;
      tableByName[str(t.name).toUpperCase()] = t;
      var fs = Array.isArray(t.fields) ? t.fields : [];
      fs.forEach(function (f) {
        if (!f || !f.name) return;
        var entry = { table: str(t.name), tableCn: str(t.cn_name), field: str(f.name), note: str(f.note), type: str(f.type) };
        fields.push(entry);
        var key = str(f.name).toUpperCase();
        if (!fieldIndex[key]) fieldIndex[key] = [];
        fieldIndex[key].push(entry);
        addAlias(f.name, { kind: 'field', label: key, table: entry.table, field: entry.field });
      });
      addAlias(t.name, { kind: 'table', label: str(t.name).toUpperCase(), table: str(t.name) });
      if (t.cn_name) addAlias(t.cn_name, { kind: 'table', label: str(t.name).toUpperCase(), table: str(t.name), cn: str(t.cn_name) });
    });

    var syntaxIndex = {};
    cards.forEach(function (c) {
      var k = lower(c.syntax);
      if (k && !syntaxIndex[k]) syntaxIndex[k] = c;
      addAlias(c.syntax, { kind: 'syntax', label: c.syntax, syntax: c.syntax });
    });

    return {
      tables: tables.slice(),
      tableByName: tableByName,
      fields: fields,
      fieldIndex: fieldIndex,
      aliases: aliases,
      syntaxCards: cards,
      syntaxIndex: syntaxIndex,
      questions: questions.slice()
    };
  }

  /* ------------------------------ 匹配辅助 ------------------------------ */

  function textOfTable(t) {
    return lower(str(t.name) + ' ' + str(t.cn_name) + ' ' + str(t.role));
  }
  function textOfField(e) {
    return lower(str(e.field) + ' ' + str(e.note) + ' ' + str(e.table) + ' ' + str(e.tableCn));
  }
  function textOfCard(c) {
    return lower(str(c.syntax) + ' ' + str(c.what) + ' ' + str(c.when) + ' ' + str(c.misuse));
  }

  /* 表名命中：英文名精确 / 前缀 / 包含 > 中文名 > 角色描述。返回按分值降序的候选。 */
  function matchTables(index, q) {
    var t = lower(q);
    if (!t || !index) return [];
    var scored = [];
    (index.tables || []).forEach(function (tb) {
      var name = lower(tb.name), cn = lower(tb.cn_name), role = lower(tb.role);
      var s = 0;
      if (name === t) s = 100;
      else if (name.indexOf(t) === 0) s = 80;
      else if (t.length >= 2 && name.indexOf(t) !== -1) s = 60;
      if (cn === t) s = Math.max(s, 95);
      else if (t.length >= 2 && cn.indexOf(t) !== -1) s = Math.max(s, 70);
      if (t.length >= 2 && role.indexOf(t) !== -1) s = Math.max(s, 30);
      if (s > 0) scored.push({ score: s, table: tb });
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored;
  }

  /* 字段命中：英文列名精确 / 包含 > note 业务词包含。跨表重名按表分组列出。 */
  function matchFields(index, q) {
    var t = lower(q);
    if (!t || !index) return [];
    var scored = [];
    (index.fields || []).forEach(function (e) {
      var name = lower(e.field), note = lower(e.note);
      var s = 0;
      if (name === t) s = 100;
      else if (t.length >= 2 && name.indexOf(t) !== -1) s = 60;
      if (t.length >= 2 && note.indexOf(t) !== -1) s = Math.max(s, 40);
      if (s > 0) scored.push({ score: s, entry: e });
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored;
  }

  function matchSyntax(index, q) {
    var t = lower(q);
    if (!t || !index) return [];
    var scored = [];
    (index.syntaxCards || []).forEach(function (c) {
      var s = 0;
      if (lower(c.syntax) === t) s = 100;
      else if (lower(c.syntax).indexOf(t) !== -1) s = 70;
      else if (t.length >= 2 && textOfCard(c).indexOf(t) !== -1) s = 40;
      if (s > 0) scored.push({ score: s, card: c });
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored;
  }

  /* ------------------------------ SQLite 报错映射 ------------------------------ */

  /* 顺序即优先级：先具体后兜底。 */
  var ERR_MAP = [
    [/no such table|no such view/i, '库里没有这张表 / 视图：核对表名拼写，HR_ 前缀别丢；本页是 SQLite，表名不带 dbo. 前缀。'],
    [/ambiguous column name/i, '列名有歧义：多表 JOIN 时同名列要加表别名前缀，如 a.ID / b.ID。'],
    [/misuse of aggregate/i, '聚合函数位置不当：聚合结果不能直接写在 WHERE 里；先 GROUP BY，过滤聚合用 HAVING，或把聚合放进子查询。'],
    [/no such column/i, '没有这个列：核对列名拼写；SQLite 列名不区分大小写，但错字照样报错。'],
    [/no such function/i, '没有这个函数：本引擎是 SQLite，用 IFNULL / CAST / LIMIT，别用 ISNULL / GETDATE / TOP。'],
    [/wrong number of arguments/i, '函数参数个数不对：核对这个函数要几个参数，别多给也别少给。'],
    [/near\s+"[^"]*"/i, '语法错误在 near 指出的位置附近：多半是漏逗号、括号没配对、关键字拼错或子句顺序不对（SELECT / FROM / WHERE / GROUP BY / HAVING / ORDER BY / LIMIT）。'],
    [/incomplete input/i, 'SQL 没写完：检查括号与引号是否成对。'],
    [/datatype mismatch/i, '类型对不上：比较或插入的两边类型不一致，必要时用 CAST 显式转换。'],
    [/UNIQUE constraint failed/i, '违反唯一键：同一主键 / 唯一键的值重复了。'],
    [/syntax error/i, 'SQL 语法有误：常见是漏逗号、关键字拼错、子句顺序不对（SELECT / FROM / WHERE / GROUP BY / HAVING / ORDER BY / LIMIT）。']
  ];

  /** SQLite 报错原文 -> 一句中文解释；未收录时给通用排查话术（不编造具体原因）。 */
  function explainSqliteError(msg) {
    var m = str(msg);
    if (!m.trim()) return '没有收到报错内容，无法解释。';
    for (var i = 0; i < ERR_MAP.length; i++) {
      if (ERR_MAP[i][0].test(m)) return ERR_MAP[i][1];
    }
    return '这条报错未收录进本地映射表：请把报错点到的表名 / 列名 / 关键字逐个核对；本地知识里没有这条的现成解释。';
  }

  var ERR_DETECT = [
    /no such (table|view|column|function)/i,
    /ambiguous column name/i,
    /misuse of aggregate/i,
    /wrong number of arguments/i,
    /incomplete input/i,
    /datatype mismatch/i,
    /syntax error/i,
    /near\s+"[^"]*"/i
  ];
  function looksLikeError(msg) {
    for (var i = 0; i < ERR_DETECT.length; i++) { if (ERR_DETECT[i].test(str(msg))) return true; }
    return false;
  }

  /* ------------------------------ 结构化对比 ------------------------------ */

  function stripSql(sql) {
    return str(sql)
      .replace(/--[^\n]*/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/'(?:[^']|'')*'/g, "''");
  }

  function sqlTables(sql) {
    var s = stripSql(sql);
    var re = /\b(?:FROM|JOIN)\s+([A-Za-z_\[][A-Za-z0-9_.\[\]]*)/gi;
    var out = [], m;
    while ((m = re.exec(s)) !== null) {
      var n = m[1].replace(/[\[\]]/g, '').split('.').pop().trim().toUpperCase();
      if (n && out.indexOf(n) === -1) out.push(n);
    }
    return out;
  }

  function countJoins(sql) {
    var m = stripSql(sql).match(/\bJOIN\b/gi);
    return m ? m.length : 0;
  }

  function aggregatesIn(sql) {
    var re = /\b(COUNT|SUM|AVG|MIN|MAX|TOTAL|GROUP_CONCAT)\s*\(/gi;
    var out = [], m;
    while ((m = re.exec(stripSql(sql))) !== null) {
      var n = m[1].toUpperCase();
      if (out.indexOf(n) === -1) out.push(n);
    }
    return out;
  }

  /* 顶层 SELECT 列表：从第一个 SELECT 到同层 FROM，按同层逗号切分。 */
  function selectList(sql) {
    var s = stripSql(sql);
    var sel = /\bSELECT\b/i.exec(s);
    if (!sel) return null;
    var i = sel.index + sel[0].length;
    var depth = 0, end = -1;
    for (; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (depth === 0 && /\s/.test(ch)) {
        var rest = s.slice(i);
        var f = /^\s+FROM\b/i.exec(rest);
        if (f) { end = i; break; }
      }
    }
    if (end === -1) return null;
    var body = s.slice(sel.index + sel[0].length, end);
    var parts = [], buf = '', d = 0;
    for (var j = 0; j < body.length; j++) {
      var c = body.charAt(j);
      if (c === '(') d++;
      else if (c === ')') d--;
      if (c === ',' && d === 0) { parts.push(buf); buf = ''; } else buf += c;
    }
    parts.push(buf);
    return parts.map(function (p) { return p.trim(); }).filter(function (p) { return p.length > 0; });
  }

  /**
   * 保守的结构化差异：只给能确定的事实；解析不确定时（子查询、SELECT *）不下结论。
   * 判题口径不参与：这里只对比 SQL 结构，不判对错。
   */
  function compareToReference(userSql, refSql) {
    var out = {
      ok: false,
      tables: { user: [], ref: [] },
      joins: { user: 0, ref: 0 },
      aggregates: { user: [], ref: [] },
      groupBy: { user: false, ref: false },
      orderBy: { user: false, ref: false },
      selectAll: { user: false, ref: false },
      columnCount: { user: null, ref: null },
      observations: [],
      notes: []
    };
    var u = str(userSql).trim();
    var r = str(refSql).trim();
    if (!u) { out.notes.push('编辑器里还没有 SQL，先写一版再对比。'); return out; }
    if (!r) { out.notes.push('本题没有参考答案，无法对比。'); return out; }
    out.ok = true;

    var us = stripSql(u), rs = stripSql(r);
    var uncertain = { user: /FROM\s*\(/i.test(us), ref: /FROM\s*\(/i.test(rs) };

    if (!uncertain.user) out.tables.user = sqlTables(us);
    if (!uncertain.ref) out.tables.ref = sqlTables(rs);
    out.joins.user = countJoins(us);
    out.joins.ref = countJoins(rs);
    out.aggregates.user = aggregatesIn(us);
    out.aggregates.ref = aggregatesIn(rs);
    out.groupBy.user = /\bGROUP\s+BY\b/i.test(us);
    out.groupBy.ref = /\bGROUP\s+BY\b/i.test(rs);
    out.orderBy.user = /\bORDER\s+BY\b/i.test(us);
    out.orderBy.ref = /\bORDER\s+BY\b/i.test(rs);

    var ul = selectList(us), rl = selectList(rs);
    out.selectAll.user = !!(ul && ul.some(function (x) { return x === '*'; }));
    out.selectAll.ref = !!(rl && rl.some(function (x) { return x === '*'; }));
    /* SELECT * 时列数不可粗算；子查询结构下也不下结论。 */
    if (ul && !out.selectAll.user && !uncertain.user) out.columnCount.user = ul.length;
    if (rl && !out.selectAll.ref && !uncertain.ref) out.columnCount.ref = rl.length;

    /* 用表差异：只有两边都能解析时才说。 */
    if (!uncertain.user && !uncertain.ref) {
      var uOnly = out.tables.user.filter(function (n) { return out.tables.ref.indexOf(n) === -1; });
      var rOnly = out.tables.ref.filter(function (n) { return out.tables.user.indexOf(n) === -1; });
      if (uOnly.length || rOnly.length) {
        out.observations.push('用到的表不同：你这里解析到 [' + (out.tables.user.join(', ') || '无') +
          ']，参考答案用 [' + out.tables.ref.join(', ') + ']' +
          (uOnly.length ? '；你多/错用了 ' + uOnly.join(', ') : '') +
          (rOnly.length ? '；你少了 ' + rOnly.join(', ') : '') + '。');
      }
    } else {
      out.notes.push('一侧含子查询（FROM (...)），用表解析不可靠，未对比用表。');
    }

    if (out.joins.user !== out.joins.ref) {
      out.observations.push('JOIN 数量不同：你 ' + out.joins.user + ' 个，参考答案 ' + out.joins.ref + ' 个。');
    }
    var ua = out.aggregates.user.join(','), ra = out.aggregates.ref.join(',');
    if (ua !== ra) {
      out.observations.push('聚合函数集合不同：你用 [' + (ua || '无') + ']，参考答案用 [' + (ra || '无') + ']。');
    }
    if (out.groupBy.user !== out.groupBy.ref) {
      out.observations.push('GROUP BY 有无不同：你' + (out.groupBy.user ? '有' : '没有') +
        '，参考答案' + (out.groupBy.ref ? '有' : '没有') + '。');
    }
    if (out.orderBy.user !== out.orderBy.ref) {
      out.observations.push('ORDER BY 有无不同：你' + (out.orderBy.user ? '有' : '没有') +
        '，参考答案' + (out.orderBy.ref ? '有' : '没有') + '。');
    }
    if (out.selectAll.user) out.observations.push('你用了 SELECT *：若题面要求指定列，这会多出列导致列数对不上。');
    if (out.columnCount.user !== null && out.columnCount.ref !== null && out.columnCount.user !== out.columnCount.ref) {
      out.observations.push('SELECT 列数粗算不同：你 ' + out.columnCount.user + ' 列，参考答案 ' + out.columnCount.ref + ' 列。');
    }
    if (!out.observations.length) {
      out.observations.push('结构上没发现可确认的差异（列数按逗号粗算，未比对列名与结果集）。');
    }
    out.notes.push('这只是 SQL 结构对比，不判对错；判题只看结果集的列数与行数据。');
    return out;
  }

  /* ------------------------------ 问答 ------------------------------ */

  function hit(kind, title, lines, source, hint) {
    return { ok: true, kind: kind, title: title, lines: lines || [], source: source || null, hint: hint || null };
  }
  function miss(lines) {
    return {
      ok: false,
      kind: 'fallback',
      title: FALLBACK_TITLE,
      lines: lines && lines.length ? lines : ['没匹配到你问的词。试试：表名 / 字段业务词 / 语法名，或当前题问「考点 / 易错点 / 要求」。'],
      source: null,
      hint: SCOPE_HINT
    };
  }

  function tableLines(scored) {
    var lines = [];
    scored.slice(0, 3).forEach(function (x) {
      var t = x.table;
      lines.push(t.name + '（' + str(t.cn_name) + '）：' + str(t.role));
      var fs = (t.fields || []).slice(0, 8).map(function (f) { return f.name; });
      if (fs.length) lines.push('字段：' + fs.join(' / ') + (t.fields.length > fs.length ? ' …共 ' + t.fields.length + ' 个' : ''));
    });
    return lines;
  }

  function fieldLines(scored) {
    var lines = [];
    var seen = {};
    scored.slice(0, 6).forEach(function (x) {
      var e = x.entry;
      var key = e.table + '.' + e.field;
      if (seen[key]) return;
      seen[key] = true;
      lines.push(e.table + '.' + e.field + '（' + str(e.type) + '）：' + str(e.note));
    });
    if (scored.length > 6) lines.push('还有 ' + (scored.length - 6) + ' 条相关字段，请把问题写具体一点。');
    return lines;
  }

  function cardLines(c) {
    var lines = ['说明：' + str(c.what), '何时用：' + str(c.when)];
    if (c.example) lines.push('示例：' + c.example);
    if (c.misuse) lines.push('常见误用：' + c.misuse);
    return lines;
  }

  function questionId(q) { return str(q && (q.id || q.seq)); }

  /* 解题思路：从题面要求 + 参考 SQL 的结构特征，派生一条「动作序列」。
     只讲先做什么 / 再做什么 / 怎么自查；不给答案、不报结果行数。
     题目自带 approach（字符串或数组）时原样展示，便于后续逐题精修。 */
  function approachLines(q) {
    var preset = q.approach;
    if (preset) {
      var pl = (Array.isArray(preset) ? preset : [preset])
        .map(function (x) { return str(x).trim(); })
        .filter(function (x) { return x.length > 0; });
      if (pl.length) return pl;
    }
    var ref = str(q.reference_sql_sqlite || q.reference_sql || '');
    var marks = ['①', '②', '③', '④', '⑤', '⑥', '⑦'];
    var steps = [];
    function push(t) { steps.push((marks[steps.length] || '·') + ' ' + t); }
    function endDot(s) { return /[。！？.；;]$/.test(s) ? s : s + '。'; }
    push('先定产出：' + endDot(str(q.output_hint).trim() || str(q.requirement).trim() ||
      '读题面「要求」与「输出」两句，把要交的列和粒度定下来'));
    if (!ref) {
      push('再拆步骤：取哪些列 → 从哪张表 → 要不要汇总，三步写完先跑一次。');
    } else {
      var tbls = sqlTables(ref);
      /* CTE 名（WITH x AS (…)）不是表，报给用户会误导，剔掉。 */
      var cteNames = [];
      var cteRe = /(?:WITH(?:\s+RECURSIVE)?|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^()]*\))?\s*AS\s*\(/gi;
      var cm;
      while ((cm = cteRe.exec(ref))) cteNames.push(String(cm[1]).toLowerCase());
      tbls = tbls.filter(function (t) { return cteNames.indexOf(String(t).toLowerCase()) === -1; });
      var joins = countJoins(ref);
      var aggs = aggregatesIn(ref);
      push(tbls.length
        ? ('找数据来源：本题落在 ' + tbls.join(' / ') + (tbls.length > 1
          ? '；先确认它们的关联键（一般是 Code / ID 结尾的字段）能不能对上。' : '，单表取材即可。'))
        : '找数据来源：用表结构速查确认字段落在哪张表。');
      if (joins > 0) {
        push('连表：先把主表写出来跑通，再一个一个补 JOIN；每加一个 JOIN 就跑一次，看行数有没有意外放大。');
      }
      if (aggs.length) {
        push('分层写：先写明细 SELECT，用 WHERE 把范围筛准；再套 ' + aggs.join(' / ') +
          (/GROUP\s+BY/i.test(ref) ? ' 并按分组字段 GROUP BY 收成汇总' : ' 收成一行结果') + '。');
      } else {
        push('直接写明细：本题不需要聚合，按要交的列逐个取，别多带列。');
      }
      if (/\bWHERE\b/i.test(ref)) push('筛条件：把题面里的限定词（在职 / 某年 / 某类）逐条翻成 WHERE 条件，加一条就跑一次看结果变化。');
      if (/\bHAVING\b/i.test(ref)) push('筛聚合：对聚合结果的过滤要写进 HAVING，不能写进 WHERE。');
      if (/\bORDER\s+BY\b/i.test(ref)) push('排序：按题面要求的字段 ORDER BY；题面没提顺序时判题按行集合比，顺序不影响对错。');
    }
    push('自查：跑一次，看列数与题面「输出」要求对不对得上；再点「对比我的 SQL」看结构差在哪、「易错点」看本题坑。');
    return steps;
  }

  /* 当前题意图词 -> 答哪一块。 */
  var Q_INTENT = [
    [/考点|知识点|考什么|考哪些|knowledge/i, 'kp'],
    [/易错|坑|陷阱|pitfall|注意什么/i, 'pitfalls'],
    [/解题|思路|怎么解|怎么做|怎么下手|从哪下手|步骤|approach/i, 'approach'],
    [/提示|hint|怎么写/i, 'hint'],
    [/方言|dialect/i, 'dialect'],
    [/要求|任务|做什么|输出什么|题目要求/i, 'task'],
    [/涉及|用到|哪些表|用哪些表/i, 'tables']
  ];

  function answerQuestion(q, intent) {
    var src = '题 ' + questionId(q);
    if (intent === 'kp') {
      var kp = ['主考点：' + str(q.knowledge_point || '未登记')];
      if (Array.isArray(q.secondary_points) && q.secondary_points.length) {
        kp.push('次要考点：' + q.secondary_points.join(' / '));
      }
      kp.push('判题只比结果集（列数 + 行数据），不比对列名与写法。');
      return hit('question', '本题考点', kp, src, null);
    }
    if (intent === 'pitfalls') {
      var ps = Array.isArray(q.pitfalls) ? q.pitfalls : [];
      if (!ps.length) return hit('question', '本题易错点', ['本题未登记易错点。'], src, null);
      return hit('question', '本题易错点', ps.slice(), src, null);
    }
    if (intent === 'approach') {
      return hit('question', '本题解题思路', approachLines(q), src,
        '这是解题顺序，不是答案本身；具体写法自己拿主意，写完可用「对比我的 SQL」自查。');
    }
    if (intent === 'hint') {
      var h = q.hint;
      var hs = Array.isArray(h) ? h.slice() : (str(h).trim() ? [str(h).trim()] : []);
      if (!hs.length) return hit('question', '本题提示', ['本题未登记提示。'], src, null);
      return hit('question', '本题提示', hs, src, '提示按「先自己想」用：只给方向，不给完整答案。');
    }
    if (intent === 'dialect') {
      return hit('question', '本题方言提示', [str(q.dialect_note || '本题未登记方言提示。')], src, null);
    }
    if (intent === 'tables') {
      var ts = sqlTables(q.reference_sql_sqlite || q.reference_sql || '');
      if (!ts.length) return hit('question', '本题涉及的表', ['未能从参考 SQL 解析到表名。'], src, null);
      return hit('question', '本题涉及的表', ['参考 SQL 里用到：' + ts.join(' / ')], src, null);
    }
    /* task */
    var tlines = [];
    if (q.stem) tlines.push('题面：' + str(q.stem));
    if (q.requirement) tlines.push('要求：' + str(q.requirement));
    if (q.output_hint) tlines.push('输出：' + str(q.output_hint));
    if (!tlines.length) tlines.push('本题未登记题面与要求。');
    return hit('question', '本题任务要求', tlines, src, '我不写完整答案；用「查看答案」看参考写法。');
  }

  /* 问题文本是否落在当前题的自有文本里（模糊命中）。 */
  function questionFuzzy(q, text) {
    var t = lower(text);
    if (t.length < 2) return false;
    var blob = lower([
      q.title, q.knowledge_point,
      (q.secondary_points || []).join(' '),
      q.stem, q.requirement, q.output_hint,
      (q.pitfalls || []).join(' ')
    ].join(' '));
    return blob.indexOf(t) !== -1;
  }

  /**
   * 本地问答入口。
   * @param {string} text 用户问题
   * @param {{index:Object, question?:Object, userSql?:string}} ctx
   * @returns {{ok:boolean, kind:string, title:string, lines:Array<string>, source:?string, hint:?string}}
   */
  function ask(text, ctx) {
    var raw = str(text).trim();
    var c = ctx || {};
    var index = c.index || null;
    var q = c.question || null;

    if (!raw) {
      return hit('error', '问点什么', ['输入表名 / 字段业务词 / 语法名 / 报错原文，或问当前题的考点、易错点。'], null, SCOPE_HINT);
    }
    if (looksLikeError(raw)) {
      return hit('error', 'SQLite 报错解释', [explainSqliteError(raw)], '本地报错映射表', null);
    }

    /* 0) 裸题号（12 / #12 / 第12题）：整条输入就是题号时直接定位该题 */
    var qNum = /^\s*#?\s*(\d{1,3})\s*$/.exec(raw) || /^\s*第\s*(\d{1,3})\s*题\s*$/.exec(raw);
    if (qNum) {
      var n = Number(qNum[1]);
      var qHit = null;
      if (index) {
        for (var qi = 0; qi < index.questions.length; qi++) {
          var cand = index.questions[qi];
          if (Number(cand.seq) === n || str(cand.id) === String(n)) { qHit = cand; break; }
        }
      }
      if (qHit) {
        var ps = Array.isArray(qHit.pitfalls) ? qHit.pitfalls.slice(0, 3) : [];
        return hit('question', '第 ' + n + ' 题：' + str(qHit.title || qHit.id), [
          '考点：' + str(qHit.knowledge_point || '—'),
          '易错点：' + (ps.length ? ps.join('；') : '—'),
          '想更具体可问：考点 / 易错点 / 要求（先在左侧切到该题）。'
        ], '题 ' + questionId(qHit), null);
      }
      return miss();
    }

    /* 1) 当前题的意图词（有当前题才走） */
    if (q) {
      for (var i = 0; i < Q_INTENT.length; i++) {
        if (Q_INTENT[i][0].test(raw)) return answerQuestion(q, Q_INTENT[i][1]);
      }
    }

    if (!index) return miss(['本地索引未就绪，只答不了表 / 字段 / 语法卡。']);

    /* 2) 语法卡（精确 / 包含优先） */
    var sc = matchSyntax(index, raw);
    if (sc.length && sc[0].score >= 70) {
      var card = sc[0].card;
      return hit('syntax', '语法卡：' + card.syntax, cardLines(card), '语法卡 ' + card.syntax, null);
    }

    /* 3) 表 */
    var tc = matchTables(index, raw);
    if (tc.length && (!sc.length || tc[0].score >= sc[0].score)) {
      return hit('table', '表：' + tc[0].table.name, tableLines(tc), '表 ' + tc[0].table.name, null);
    }

    /* 4) 字段 / 业务词 */
    var fc = matchFields(index, raw);
    if (fc.length) {
      var src = '字段 ' + fc[0].entry.table + '.' + fc[0].entry.field;
      return hit('field', '字段：' + fc[0].entry.field, fieldLines(fc), src, null);
    }

    /* 5) 语法卡模糊 */
    if (sc.length) {
      var c2 = sc[0].card;
      return hit('syntax', '语法卡：' + c2.syntax, cardLines(c2), '语法卡 ' + c2.syntax, null);
    }

    /* 6) 当前题模糊命中 */
    if (q && questionFuzzy(q, raw)) {
      return hit('question', '本题相关：' + str(q.title || questionId(q)),
        ['题面里提到「' + raw + '」。可用「考点 / 易错点 / 要求」问得更具体。'],
        '题 ' + questionId(q), null);
    }

    return miss();
  }

  return {
    FALLBACK_TITLE: FALLBACK_TITLE,
    buildIndex: buildIndex,
    ask: ask,
    explainSqliteError: explainSqliteError,
    compareToReference: compareToReference
  };
});
