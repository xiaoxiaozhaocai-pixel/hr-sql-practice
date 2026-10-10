/*
 * src/db.js — sql.js 加载 + 建库灌数 + 自检（浏览器内联，无 node 依赖）
 * ---------------------------------------------------------------------------
 * 关键点：
 *   - WASM 由 build.mjs 以 base64 内联，运行时解码成 ArrayBuffer 经 wasmBinary 传入，
 *     因此绝不走 locateFile / fetch，file:// 双击也能跑（无任何外部请求）。
 *   - 建库用 db.run()（对应 sqlite3_exec，可一次跑多语句脚本），不用 db.exec()，
 *     避免把 seed 的执行结果全部物化进内存。
 *   - seed 内含 PRAGMA ignore_check_constraints（权威源 3 行日期倒挂脏数据），必须一起灌。
 */
(function (root) {
  'use strict';

  var TABLE_KEYS = [
    'HR_DICT', 'HR_ORG', 'HR_JOB', 'HR_EMPLOYEE', 'HR_POSITION', 'HR_ASSIGNMENT',
    'HR_SALARY', 'HR_ATTENDANCE', 'HR_RECRUIT_REQ', 'HR_CANDIDATE', 'HR_PERFORMANCE'
  ];

  /* base64 -> ArrayBuffer（不依赖 atob 之外的任何 API，也不发起网络请求）。 */
  function base64ToArrayBuffer(b64) {
    var binary = atob(b64);
    var len = binary.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  /* 单次查询最多返回的行数：超过即截断并在结果里置 truncated=true。
     取值理由：题库 120 题 expected.row_count 最大 200（HR_EMPLOYEE 全表），
     1000 给 5 倍余量，既不误伤任何题的参考答案，又能挡住
     `SELECT * FROM HR_SALARY a, HR_SALARY b` 这类笛卡尔积把结果全物化进内存。 */
  var MAX_ROWS = 1000;

  /* 建一份新库：schema + seed（seed 含 PRAGMA ignore_check_constraints，必须整体灌）。 */
  function buildDb(SQL, opts) {
    var db = new SQL.Database();
    db.run(opts.schemaSql);
    db.run(opts.seedSql);
    return db;
  }

  /**
   * 建库 + 灌数。
   * @param {Function} initSqlJs vendor 加载器（由 sql-wasm.js 暴露）
   * @param {Object} opts { wasmBase64, schemaSql, seedSql, expectedCounts }
   * @returns {Promise<{db:Object, selfCheck:Object}>}
   */
  function createDatabase(initSqlJs, opts) {
    return initSqlJs({ wasmBinary: base64ToArrayBuffer(opts.wasmBase64) }).then(function (SQL) {
      var db = buildDb(SQL, opts);
      return { db: db, selfCheck: selfCheck(db, opts.expectedCounts) };
    });
  }

  /**
   * 一次 wasm 实例、两份独立 Database：db = 用户作答库（随便改），refDb = 判题参考库（只读）。
   * 参考库与作答库隔离，用户 UPDATE/DELETE/DROP/CREATE 改不到判题基准。
   * 内存代价：只多一份种子库（11 表 / 4842 行），不做快照、不复制多份。
   * @returns {Promise<{db:Object, refDb:Object, selfCheck:Object}>}
   */
  function createDatabases(initSqlJs, opts) {
    return initSqlJs({ wasmBinary: base64ToArrayBuffer(opts.wasmBase64) }).then(function (SQL) {
      var db = buildDb(SQL, opts);
      var refDb = buildDb(SQL, opts);
      return { db: db, refDb: refDb, selfCheck: selfCheck(db, opts.expectedCounts) };
    });
  }

  /* 11 表行数自检：对 data/rowcount_expected.json。 */
  function selfCheck(db, expectedCounts) {
    var tables = [];
    var okCount = 0;
    for (var i = 0; i < TABLE_KEYS.length; i++) {
      var name = TABLE_KEYS[i];
      var expected = expectedCounts[name];
      var actual = null;
      var error = null;
      try {
        var res = db.exec('SELECT COUNT(*) FROM ' + name);
        actual = res && res[0] && res[0].values[0] ? res[0].values[0][0] : null;
      } catch (e) {
        error = String(e && e.message ? e.message : e);
      }
      var ok = error === null && actual === expected;
      if (ok) okCount++;
      tables.push({ table: name, expected: expected, actual: actual, ok: ok, error: error });
    }
    return {
      ok: okCount === TABLE_KEYS.length,
      okCount: okCount,
      total: TABLE_KEYS.length,
      tables: tables
    };
  }

  /**
   * 跑一段用户 SQL，取最后一条有结果集的语句。
   * 语法错误原样抛出，由 UI 展示原始错误信息。
   *
   * 实现用 prepare + step 逐行取，而不是 db.exec：
   *   1) 空结果集（如 WHERE 1 = 0）：getColumnNames() 在 step 之前就有值，列名不再丢；
   *   2) 行上限 MAX_ROWS：取满即停并置 truncated=true，不会把整张笛卡尔积物化进内存。
   * 注意：行上限只约束「取出的行」，聚合/排序/笛卡尔积的中间计算仍由 SQLite 在
   *       sqlite3_step 内跑完，WASM 单线程无 sqlite3_interrupt / progress handler
   *      （vendor 未导出），因此重聚合查询本身无法真正中断——见 docs 与汇报。
   */
  function runQuery(db, sql) {
    if (!sql || !String(sql).trim()) return { columns: [], rows: [], truncated: false };
    var iter = db.iterateStatements(sql);
    var last = null;
    var truncated = false;
    var step;
    while (!(step = iter.next()).done) {
      var st = step.value;
      try {
        var cols = st.getColumnNames();
        if (!cols || cols.length === 0) {
          while (st.step()) { /* 无结果集的语句（INSERT/UPDATE/DDL）：执行到底 */ }
          continue;
        }
        var rows = [];
        var capped = false;
        while (st.step()) {
          if (rows.length >= MAX_ROWS) { capped = true; break; }
          rows.push(st.get());
        }
        last = { columns: cols.slice(), rows: rows };
        if (capped) truncated = true;
      } finally {
        st.free();
      }
    }
    if (!last) return { columns: [], rows: [], truncated: false };
    return { columns: last.columns, rows: last.rows, truncated: truncated };
  }

  root.HRDb = {
    TABLE_KEYS: TABLE_KEYS,
    MAX_ROWS: MAX_ROWS,
    base64ToArrayBuffer: base64ToArrayBuffer,
    createDatabase: createDatabase,
    createDatabases: createDatabases,
    selfCheck: selfCheck,
    runQuery: runQuery
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
