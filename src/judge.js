/*
 * src/judge.js — HR SQL 练习台判题引擎
 * ---------------------------------------------------------------------------
 * 设计约束：
 *   1) 纯函数：不依赖 DOM / window / 浏览器 API，node 可直接 import。
 *   2) 双模加载：node 下走 CommonJS（module.exports），浏览器内联时挂 globalThis.HRJudge。
 *   3) 判题口径依据 docs/questions-contract-v1.md §5，并按交付七口径做了一处工程裁决：
 *      —— 列名「默认不比」；仅在差异区提示「列名与预期不同」（见 README「待业务侧钉死」）。
 *
 * 归一化口径（易错点，改前先读这里）：
 *   - NULL：与 NULL 相等；与 0、'' 均不等（三种值各占一个独立 key，永不串味）。
 *   - 数值：按「十进制四舍五入到 2 位」后比较，1 === 1.00。
 *     四舍五入基于数字的最短十进制表示（String(x)）做逐位进位，而不是 Math.round(x*100)/100，
 *     否则 1.005 会因 IEEE754 表示（1.00499999…）被吞成 1.00，与「四舍五入」语义不符。
 *   - 字符串：忽略首尾空格 + 大小写不敏感。
 *     纯十进制字面量（无前导零）当数值处理，如 '1.00' === 1；'007' 不算数值，保留为字符串。
 *   - 日期：'YYYY-MM-DD' 按文本直接比较，绝不转时间戳（'2026-06-30' !== '2026-6-30'）。
 *   - 行：默认行序不敏感，按多重集比较（重复行数量必须一致）。
 *   - 列对齐：先按列名一一匹配（trim + 小写），匹配不上退回按列序；两种对齐任一通过即通过。
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory();
  } else {
    root.HRJudge = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_DIFF_ROWS = 10;
  var SEP = '\u0001';
  var NULL_KEY = 'z:';

  function isNil(v) {
    return v === null || v === undefined;
  }

  /* 十进制四舍五入到 2 位（避免 IEEE754 把 1.005 吞成 1.00）。 */
  function round2(x) {
    if (typeof x !== 'number' || !isFinite(x)) return x;
    if (Number.isInteger(x)) return x;
    var s = String(x);
    if (s.indexOf('e') !== -1 || s.indexOf('E') !== -1) {
      return Math.round(x * 100) / 100;
    }
    var neg = s.charAt(0) === '-';
    var body = neg ? s.slice(1) : s;
    var dot = body.indexOf('.');
    if (dot < 0) return x;
    var intPart = body.slice(0, dot);
    var frac = body.slice(dot + 1);
    var keep = (frac + '00').slice(0, 2);
    var next = frac.length > 2 ? frac.charCodeAt(2) - 48 : 0;
    var n = Number(intPart + keep);
    if (next >= 5) n += 1;
    var v = n / 100;
    return neg ? -v : v;
  }

  /* 无前导零的十进制字面量才当数值；'007' / '1e3' / '2026-06-30' 都不是。 */
  function numericFromString(s) {
    if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(s)) return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  function toArray(v) {
    return Array.isArray(v) ? v : [];
  }

  function toRows(v) {
    var rows = toArray(v);
    var out = [];
    for (var i = 0; i < rows.length; i++) out.push(toArray(rows[i]));
    return out;
  }

  function toCols(v) {
    var cols = toArray(v);
    var out = [];
    for (var i = 0; i < cols.length; i++) {
      out.push(cols[i] === null || cols[i] === undefined ? '' : String(cols[i]));
    }
    return out;
  }

  /* 单元格 -> 归一化 key。不同「种类」用不同前缀，保证 NULL / '' / 0 永不相等。 */
  function cellKey(value) {
    if (isNil(value)) return NULL_KEY;
    if (typeof value === 'number') return 'n:' + String(round2(value));
    if (typeof value === 'boolean') return 'n:' + (value ? '1' : '0');
    if (typeof value === 'bigint') return 'n:' + String(value);
    if (typeof value === 'string') {
      var t = value.trim();
      var num = numericFromString(t);
      if (num !== null) return 'n:' + String(round2(num));
      return 's:' + t.toLowerCase();
    }
    return 'o:' + JSON.stringify(value);
  }

  function rowKey(row) {
    var keys = [];
    for (var i = 0; i < row.length; i++) keys.push(cellKey(row[i]));
    return keys.join(SEP);
  }

  function countMap(rows) {
    var m = Object.create(null);
    for (var i = 0; i < rows.length; i++) {
      var k = rowKey(rows[i]);
      m[k] = (m[k] || 0) + 1;
    }
    return m;
  }

  function rowsEqual(a, b, orderSensitive) {
    if (a.length !== b.length) return false;
    var i;
    if (orderSensitive) {
      for (i = 0; i < a.length; i++) {
        if (rowKey(a[i]) !== rowKey(b[i])) return false;
      }
      return true;
    }
    var ma = countMap(a);
    var mb = countMap(b);
    var ka = Object.keys(ma);
    for (i = 0; i < ka.length; i++) {
      if (ma[ka[i]] !== mb[ka[i]]) return false;
    }
    return true;
  }

  function normName(name) {
    return String(name === null || name === undefined ? '' : name).trim().toLowerCase();
  }

  /* 列名多重集是否一致（用于「列名与预期不同」的提示，不参与通过与否）。 */
  function namesSetEqual(userCols, refCols) {
    if (userCols.length !== refCols.length) return false;
    var a = userCols.map(normName).sort();
    var b = refCols.map(normName).sort();
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /* 按列名做一一匹配：userCols[i] -> refCols[map[i]]；匹配不全则 ok=false。 */
  function buildNamePermutation(userCols, refCols) {
    var used = [];
    var map = [];
    for (var i = 0; i < userCols.length; i++) {
      var un = normName(userCols[i]);
      var found = -1;
      for (var j = 0; j < refCols.length; j++) {
        if (used[j]) continue;
        if (normName(refCols[j]) === un) { found = j; break; }
      }
      if (found < 0) return { ok: false, map: null };
      used[found] = true;
      map[i] = found;
    }
    return { ok: true, map: map };
  }

  /* 把一行按 map 重排成「参考列顺序」。 */
  function applyPermutation(row, map) {
    var out = new Array(map.length);
    for (var i = 0; i < map.length; i++) {
      out[map[i]] = i < row.length ? row[i] : null;
    }
    return out;
  }

  function columnsIn(a, b) {
    var bKeys = Object.create(null);
    for (var i = 0; i < b.length; i++) bKeys[normName(b[i])] = true;
    var out = [];
    for (var j = 0; j < a.length; j++) {
      if (!bKeys[normName(a[j])]) out.push(String(a[j]));
    }
    return out;
  }

  function diffRowsOf(userRows, refRows, orderSensitive) {
    var diffs = [];
    var i;
    if (orderSensitive) {
      var n = Math.max(userRows.length, refRows.length);
      for (i = 0; i < n && diffs.length < MAX_DIFF_ROWS; i++) {
        var u = userRows[i];
        var r = refRows[i];
        if (u === undefined) diffs.push({ kind: 'missing', index: i, row: r });
        else if (r === undefined) diffs.push({ kind: 'extra', index: i, row: u });
        else if (rowKey(u) !== rowKey(r)) diffs.push({ kind: 'changed', index: i, row: u, expected: r });
      }
      return diffs;
    }
    var mu = countMap(userRows);
    var mr = countMap(refRows);
    var ku = Object.keys(mu);
    var kr = Object.keys(mr);
    for (i = 0; i < ku.length && diffs.length < MAX_DIFF_ROWS; i++) {
      var extra = mu[ku[i]] - (mr[ku[i]] || 0);
      if (extra > 0) {
        var row = firstRowWithKey(userRows, ku[i]);
        for (var e = 0; e < extra && diffs.length < MAX_DIFF_ROWS; e++) {
          diffs.push({ kind: 'extra', row: row });
        }
      }
    }
    for (i = 0; i < kr.length && diffs.length < MAX_DIFF_ROWS; i++) {
      var missing = mr[kr[i]] - (mu[kr[i]] || 0);
      if (missing > 0) {
        var row2 = firstRowWithKey(refRows, kr[i]);
        for (var m = 0; m < missing && diffs.length < MAX_DIFF_ROWS; m++) {
          diffs.push({ kind: 'missing', row: row2 });
        }
      }
    }
    return diffs;
  }

  function firstRowWithKey(rows, key) {
    for (var i = 0; i < rows.length; i++) {
      if (rowKey(rows[i]) === key) return rows[i];
    }
    return null;
  }

  /**
   * 判题主入口。
   * @param {Array<Array<any>>} userRows    用户结果行
   * @param {Array<string>}      userColumns 用户结果列名
   * @param {Array<Array<any>>} refRows      参考 SQL 在同一个 SQLite 实例上跑出的行
   * @param {Array<string>}      refColumns  参考结果列名
   * @param {Object} [options] { orderSensitive?: boolean }
   * @returns {{pass:boolean, reason:string, columnIssue:(null|Object),
   *            diffRows:Array, userRowCount:number, refRowCount:number, alignMode:string}}
   */
  function judgeResult(userRows, userColumns, refRows, refColumns, options) {
    options = options || {};
    var uRows = toRows(userRows);
    var uCols = toCols(userColumns);
    var rRows = toRows(refRows);
    var rCols = toCols(refColumns);

    var verdict = {
      pass: false,
      reason: '',
      columnIssue: null,
      diffRows: [],
      userRowCount: uRows.length,
      refRowCount: rRows.length,
      alignMode: 'none'
    };

    if (uCols.length !== rCols.length) {
      verdict.reason = '不通过：列数不一致——你的结果 ' + uCols.length + ' 列，预期 ' + rCols.length + ' 列。';
      verdict.columnIssue = {
        kind: 'count',
        message: verdict.reason,
        extra: columnsIn(uCols, rCols),
        missing: columnsIn(rCols, uCols)
      };
      return verdict;
    }

    var namesSame = namesSetEqual(uCols, rCols);
    if (!namesSame) {
      verdict.columnIssue = {
        kind: 'name',
        message: '列名与预期不同（判题默认不比列名，仅作提示）。',
        extra: columnsIn(uCols, rCols),
        missing: columnsIn(rCols, uCols)
      };
    }

    var perm = buildNamePermutation(uCols, rCols);
    var byName = null;
    if (perm.ok) {
      byName = [];
      for (var i = 0; i < uRows.length; i++) byName.push(applyPermutation(uRows[i], perm.map));
    }

    var orderSensitive = !!options.orderSensitive;
    var nameEq = byName !== null && rowsEqual(byName, rRows, orderSensitive);
    var posEq = rowsEqual(uRows, rRows, orderSensitive);

    if (nameEq && posEq) verdict.alignMode = 'both';
    else if (nameEq) verdict.alignMode = 'name';
    else if (posEq) verdict.alignMode = 'position';

    verdict.pass = nameEq || posEq;

    var probe = byName !== null ? byName : uRows;
    if (!verdict.pass) {
      verdict.diffRows = diffRowsOf(probe, rRows, orderSensitive);
    }

    if (verdict.pass) {
      verdict.reason = '通过：结果集与预期一致（' + rRows.length + ' 行）' +
        (verdict.alignMode === 'name' ? '，按列名对齐。' :
          verdict.alignMode === 'position' ? '，按列序对齐。' : '。');
    } else {
      verdict.reason = '不通过：行集不一致——你的结果 ' + uRows.length + ' 行，预期 ' + rRows.length +
        ' 行；差异样例 ' + verdict.diffRows.length + ' 条（最多 ' + MAX_DIFF_ROWS + ' 条）。';
    }
    return verdict;
  }

  return {
    judgeResult: judgeResult,
    normalizeCell: cellKey,
    round2: round2,
    MAX_DIFF_ROWS: MAX_DIFF_ROWS
  };
});
