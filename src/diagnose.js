/*
 * src/diagnose.js — DB Quest 学情诊断纯函数
 * ---------------------------------------------------------------------------
 * 设计约束：
 *   1) 纯函数：不依赖 DOM / window / 浏览器 API，也不调用 Date.now() / new Date()；
 *      「今天」一律由 opts.today 传入。
 *   2) 双模加载：node 下走 CommonJS（module.exports），浏览器内联时挂 globalThis.HRDiagnose。
 *   3) 只读汇总：不修改传入的 questions / learning，不参与判题与题库。
 *
 * 口径（来自任务卡 T22，逐条实现）：
 *   - completed   = learning.completions 里存在该 id
 *   - independent = completions[id].completionType === 'independent'
 *   - guided      = completions[id].completionType === 'guided'
 *   - unknown / 缺失 completionType → 计入 completed，不计 independent / guided
 *   - needsFix    = review[id].status === 'needsFix'
 *   - due         = review[id].status === 'due'
 *   - activeDays  = learning.activity.activeDays（缺失按 0）
 *   - rate        = completed / total；masteryRate = independent / total；total=0 时为 0
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory();
  } else {
    root.HRDiagnose = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var hasOwn = Object.prototype.hasOwnProperty;

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function asObject(v) {
    return isPlainObject(v) ? v : {};
  }

  function asArray(v) {
    return Array.isArray(v) ? v : [];
  }

  function str(v) {
    return (v === null || v === undefined) ? '' : String(v);
  }

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function has(obj, key) {
    return hasOwn.call(obj, key);
  }

  /* 段号排序：数字段按数值升序，非数字段回退字符串比较。 */
  function compareSection(a, b) {
    var na = Number(a);
    var nb = Number(b);
    if (isFinite(na) && isFinite(nb)) return na - nb;
    return str(a).localeCompare(str(b));
  }

  function emptyStat(section) {
    return {
      section: section,
      total: 0,
      completed: 0,
      independent: 0,
      guided: 0,
      needsFix: 0,
      rate: 0,
      masteryRate: 0
    };
  }

  function finishStat(stat) {
    stat.rate = stat.total ? stat.completed / stat.total : 0;
    stat.masteryRate = stat.total ? stat.independent / stat.total : 0;
    return stat;
  }

  function questionOf(q, fallbackId) {
    q = isPlainObject(q) ? q : {};
    return {
      id: has(q, 'id') ? q.id : fallbackId,
      seq: has(q, 'seq') ? q.seq : null,
      title: str(q.title),
      section: has(q, 'section') ? q.section : '',
      syntax_intro: asArray(q.syntax_intro)
    };
  }

  function diagnose(input, opts) {
    input = asObject(input);
    opts = asObject(opts);

    var rawQuestions = asArray(input.questions);
    var learning = asObject(input.learning);
    var completions = asObject(learning.completions);
    var review = asObject(learning.review);
    var activity = asObject(learning.activity);
    var today = str(opts.today);

    var questions = rawQuestions.map(function (q, i) {
      return questionOf(q, 'q' + (i + 1));
    });

    /* ---------------------------- overall ---------------------------- */
    var overall = {
      total: questions.length,
      completed: 0,
      independent: 0,
      guided: 0,
      needsFix: 0,
      due: 0,
      activeDays: num(activity.activeDays)
    };

    var sectionMap = {};
    var sectionOrder = [];
    var syntaxMap = {};
    var syntaxOrder = [];

    questions.forEach(function (q) {
      var id = q.id;
      var done = has(completions, id);
      var c = has(completions, id) ? completions[id] : null;
      var type = isPlainObject(c) ? c.completionType : '';
      var rv = has(review, id) ? review[id] : null;
      var rvStatus = isPlainObject(rv) ? rv.status : '';

      if (done) overall.completed += 1;
      if (type === 'independent') overall.independent += 1;
      if (type === 'guided') overall.guided += 1;
      if (rvStatus === 'needsFix') overall.needsFix += 1;
      if (rvStatus === 'due') overall.due += 1;

      /* 段：按题目 section 聚合，最后按 section 升序输出。 */
      var secKey = str(q.section);
      if (!has(sectionMap, secKey)) {
        sectionMap[secKey] = emptyStat(q.section);
        sectionOrder.push(secKey);
      }
      var sec = sectionMap[secKey];
      sec.total += 1;
      if (done) sec.completed += 1;
      if (type === 'independent') sec.independent += 1;
      if (type === 'guided') sec.guided += 1;
      if (rvStatus === 'needsFix') sec.needsFix += 1;

      /* 语法：同一题内同名语法点只计一次「覆盖题数」。 */
      var seenSyntax = {};
      q.syntax_intro.forEach(function (item) {
        var name = isPlainObject(item) ? str(item.syntax) : '';
        if (!name || seenSyntax[name]) return;
        seenSyntax[name] = true;
        if (!has(syntaxMap, name)) {
          syntaxMap[name] = {
            name: name,
            total: 0,
            completed: 0,
            independent: 0,
            guided: 0,
            needsFix: 0,
            masteryRate: 0
          };
          syntaxOrder.push(name);
        }
        var sx = syntaxMap[name];
        sx.total += 1;
        if (done) sx.completed += 1;
        if (type === 'independent') sx.independent += 1;
        if (type === 'guided') sx.guided += 1;
        if (rvStatus === 'needsFix') sx.needsFix += 1;
      });
    });

    var sections = sectionOrder.map(function (key) {
      return finishStat(sectionMap[key]);
    }).sort(function (a, b) {
      return compareSection(a.section, b.section);
    });

    var syntax = syntaxOrder.map(function (name) {
      var sx = syntaxMap[name];
      sx.masteryRate = sx.total ? sx.independent / sx.total : 0;
      return sx;
    }).filter(function (sx) {
      return sx.total > 0;
    }).sort(function (a, b) {
      if (a.masteryRate !== b.masteryRate) return a.masteryRate - b.masteryRate;
      return b.total - a.total;
    });

    /* ------------------------------ plan ------------------------------ */
    var plan = [];
    var planned = {};

    function pushPlan(q, reason) {
      if (!q || planned[q.id]) return;
      planned[q.id] = true;
      plan.push({
        id: q.id,
        seq: q.seq,
        title: q.title,
        section: q.section,
        reason: reason
      });
    }

    function dueValue(q) {
      var rv = has(review, q.id) ? review[q.id] : null;
      if (!isPlainObject(rv)) return null;
      var d = rv.dueDay;
      return (d === null || d === undefined || d === '') ? null : str(d);
    }

    function compareDueMissingLast(a, b) {
      var da = dueValue(a);
      var db = dueValue(b);
      if (da === null && db === null) return 0;
      if (da === null) return 1;
      if (db === null) return -1;
      return da < db ? -1 : (da > db ? 1 : 0);
    }

    /* 1) needsFix：按 dueDay 升序，无 dueDay 排后面。 */
    questions.filter(function (q) {
      var rv = has(review, q.id) ? review[q.id] : null;
      return isPlainObject(rv) && rv.status === 'needsFix';
    }).sort(compareDueMissingLast).forEach(function (q) {
      pushPlan(q, '待修正');
    });

    /* 2) due 且 dueDay <= today：按 dueDay 升序。 */
    questions.filter(function (q) {
      var rv = has(review, q.id) ? review[q.id] : null;
      if (!isPlainObject(rv) || rv.status !== 'due' || !today) return false;
      var d = dueValue(q);
      return d !== null && d <= today;
    }).sort(function (a, b) {
      var da = dueValue(a);
      var db = dueValue(b);
      return da < db ? -1 : (da > db ? 1 : 0);
    }).forEach(function (q) {
      pushPlan(q, '到期复查');
    });

    /* 3) 仅 guided 完成过。 */
    questions.filter(function (q) {
      var c = has(completions, q.id) ? completions[q.id] : null;
      return isPlainObject(c) && c.completionType === 'guided';
    }).forEach(function (q) {
      pushPlan(q, '仅跟练过，建议独立复做');
    });

    /* 4) 第一个未满段里的第一道未完成题。 */
    var firstUnfinishedSection = null;
    sections.some(function (sec) {
      if (sec.total > 0 && sec.completed < sec.total) {
        firstUnfinishedSection = sec;
        return true;
      }
      return false;
    });
    if (firstUnfinishedSection) {
      var nextQ = null;
      questions.some(function (q) {
        if (str(q.section) !== str(firstUnfinishedSection.section)) return false;
        if (has(completions, q.id)) return false;
        nextQ = q;
        return true;
      });
      if (nextQ) pushPlan(nextQ, '本段下一题');
    }

    plan = plan.slice(0, 3);

    /* ------------------------------ notes ----------------------------- */
    var covered = questions.filter(function (q) {
      return q.syntax_intro.length > 0;
    }).length;
    var notes = ['语法维度覆盖 ' + covered + '/' + questions.length + ' 题'];

    var ready = overall.completed > 0 || overall.activeDays > 0 || Object.keys(review).length > 0;
    if (!ready) notes.push('还没有学习记录：完成任意一题或产生一次学习活动后，这里会显示诊断。');

    return {
      ready: ready,
      overall: overall,
      sections: sections,
      syntax: syntax,
      plan: plan,
      notes: notes
    };
  }

  return { diagnose: diagnose };
});
