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

  /**
   * 建库 + 灌数。
   * @param {Function} initSqlJs vendor 加载器（由 sql-wasm.js 暴露）
   * @param {Object} opts { wasmBase64, schemaSql, seedSql, expectedCounts }
   * @returns {Promise<{db:Object, selfCheck:Object}>}
   */
  function createDatabase(initSqlJs, opts) {
    return initSqlJs({ wasmBinary: base64ToArrayBuffer(opts.wasmBase64) }).then(function (SQL) {
      var db = new SQL.Database();
      db.run(opts.schemaSql);
      db.run(opts.seedSql);
      return { db: db, selfCheck: selfCheck(db, opts.expectedCounts) };
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
   */
  function runQuery(db, sql) {
    var res = db.exec(sql);
    if (!res || res.length === 0) return { columns: [], rows: [] };
    var last = res[res.length - 1];
    return { columns: last.columns.slice(), rows: last.values.map(function (r) { return r.slice(); }) };
  }

  root.HRDb = {
    TABLE_KEYS: TABLE_KEYS,
    base64ToArrayBuffer: base64ToArrayBuffer,
    createDatabase: createDatabase,
    selfCheck: selfCheck,
    runQuery: runQuery
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
