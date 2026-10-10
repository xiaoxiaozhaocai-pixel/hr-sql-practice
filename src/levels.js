/*
 * src/levels.js — 关卡编排 + 学习状态机（纯逻辑：不碰 DOM / window / localStorage）
 * ---------------------------------------------------------------------------
 * 为什么单独成文件（开源第 1 条「题库与逻辑分离」）：
 *   1) 段/关的定义只依赖题目自带的 level / seq / title / knowledge_point，
 *      渲染层不再写死任何段号与关数；别人往 data/questions.json 里加题即可自动进段。
 *   2) 纯函数 + 显式传入 storage，使得 node 原生 test runner 能直接用内存 stub 验证
 *      「尝试次数 / 复查状态 / 今日小组 / 活跃天数 / 跨天 / 读写往返」，不必启动浏览器。
 *
 * 双模加载：node 下 module.exports；浏览器内联时挂 globalThis.HRLevels（与 src/judge.js 同款）。
 *
 * 学习状态机口径（T16）：
 *   - 题级尝试：每题一轮 3 次；有效判错扣 1；扣光转 guided（不回满，除非显式 guidedReset）。
 *   - 复查：needsFix / due / resolved；到期复查干净通过 → resolved；跟练通过 → 重约明日。
 *   - 今日小组：daily.planIds 当天固定；完成进 daily.creditedIds（按 id 去重）。
 *   - 活跃天数：当日首个有效成果更新 activity；昨天练过则 +1，否则重新从 1 计。
 *   - todayCount 只作 creditedIds.length 的兼容投影，禁止两边分别自增。
 *   - hearts / streak 字段保留为历史值，不再驱动新逻辑。
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory();
  } else {
    root.HRLevels = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STORAGE_KEY = 'dbquest.v2';   // v2 新键：不复用旧练习台的键，避免脏数据串味
  var DEFAULT_DAILY_GOAL = 3;
  var HEARTS_PER_LEVEL = 3;
  var XP_PER_LEVEL = 10;
  var XP_CAP = 1200;                // 120 题 × 10，全库封顶
  var LEARNING_SCHEMA_VERSION = 1;
  var MAINTENANCE_REVIEW_DAYS = 7;  // 最近一次看完整答案通过距今 ≥7 自然日

  /* 段标题：段位（section）与难度档（level）是两根独立的轴。
     section 由题库显式字段决定（1–6，回填口径见 test/sections.test.mjs 的区间表），
     level 继续保留为 1–4 的难度档，两者互不影响。这里只登记标题。 */
  var SECTION_TITLES = {
    1: '入门 · 单表查询',
    2: '进阶 · 分组与多表',
    3: '实战 · 子查询与口径',
    4: '挑战 · 时点与进阶',
    5: '综合 · 报表与汇总',
    6: '时点 · 历史与口径'
  };

  /* ------------------------------------------------------------------ *
   * 基础工具
   * ------------------------------------------------------------------ */

  function plainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function num(v, d) {
    return (typeof v === 'number' && isFinite(v)) ? v : d;
  }

  function str(v, d) {
    return typeof v === 'string' ? v : d;
  }

  function copyMap(src) {
    var out = {};
    if (plainObject(src)) {
      Object.keys(src).forEach(function (k) { out[k] = src[k]; });
    }
    return out;
  }

  function uniqueStrings(arr) {
    var seen = {};
    var out = [];
    (Array.isArray(arr) ? arr : []).forEach(function (x) {
      if (typeof x !== 'string' || !x || seen[x]) return;
      seen[x] = true;
      out.push(x);
    });
    return out;
  }

  /* 本地自然日：'YYYY-MM-DD'，沿用 todayStamp() 的口径 */
  function shiftDay(stamp, delta) {
    var p = String(stamp).split('-');
    var t = Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) + delta * 86400000;
    var d = new Date(t);
    var m = d.getUTCMonth() + 1;
    var day = d.getUTCDate();
    return d.getUTCFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }

  function daysBetween(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return null;
    var pa = a.split('-');
    var pb = b.split('-');
    if (pa.length !== 3 || pb.length !== 3) return null;
    var ta = Date.UTC(Number(pa[0]), Number(pa[1]) - 1, Number(pa[2]));
    var tb = Date.UTC(Number(pb[0]), Number(pb[1]) - 1, Number(pb[2]));
    if (!isFinite(ta) || !isFinite(tb)) return null;
    return Math.round((tb - ta) / 86400000);
  }

  /* ------------------------------------------------------------------ *
   * 段编排（T15 保持不变）
   * ------------------------------------------------------------------ */

  /**
   * 把题目按 section 编排成段：section = { section, title, questions[] }。
   * 段序按 section 升序；段内严格按 seq 升序 —— 题库作者已排好循序渐进的坡度，编排层不得重排。
   * section 缺省 / 非数字的题目直接跳过（不崩），与旧版对 level 缺省的处理口径一致。
   */
  function buildSections(questions, titles) {
    titles = titles || SECTION_TITLES;
    var bySection = {};
    (questions || []).forEach(function (q) {
      if (!q || q.section === undefined || q.section === null) return;
      var sec = Number(q.section);
      if (!isFinite(sec)) return;
      if (!bySection[sec]) bySection[sec] = [];
      bySection[sec].push(q);
    });
    return Object.keys(bySection)
      .map(Number)
      .sort(function (a, b) { return a - b; })
      .map(function (sec) {
        var qs = bySection[sec].slice().sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
        return { section: sec, title: titles[sec] || ('第 ' + sec + ' 段'), questions: qs };
      });
  }

  /* 单条语法卡是否「有效」：必须是对象，且 syntax / what / when / example / misuse 五字段
     都是非空字符串。缺字段、空数组、元素不完整 —— 一律不渲染（与 expected_note 同款口径）。 */
  function validSyntaxItem(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    var out = {};
    var keys = ['syntax', 'what', 'when', 'example', 'misuse'];
    for (var i = 0; i < keys.length; i++) {
      var v = item[keys[i]];
      if (typeof v !== 'string' || !v.trim()) return null;
      out[keys[i]] = v.trim();
    }
    return out;
  }

  /**
   * syntax_intro 首现判定：按 section 升序 → seq 升序扫题库（复用 buildSections 的段序/段内序），
   * 某个 syntax 第一次出现的那道题才返回卡片；同题多语法各自成卡，跨段重复不再返回。
   * @returns {Object} 题目 id -> 有效卡片数组（只含首现项）
   */
  function syntaxIntrosFor(questions, titles) {
    var sections = buildSections(questions, titles);
    var seen = {};
    var byId = {};
    sections.forEach(function (sec) {
      sec.questions.forEach(function (q) {
        if (!q || !Array.isArray(q.syntax_intro)) return;
        var cards = [];
        q.syntax_intro.forEach(function (raw) {
          var item = validSyntaxItem(raw);
          if (!item) return;
          var key = item.syntax.toLowerCase();
          if (seen[key]) return;
          seen[key] = true;
          cards.push(item);
        });
        if (cards.length) byId[q.id] = cards;
      });
    });
    return byId;
  }

  /**
   * 渐进提示归一化：题库当前把 hint 写成单条字符串，这里统一成数组。
   */
  function hintList(q) {
    if (!q) return [];
    var h = q.hint;
    if (Array.isArray(h)) {
      return h.map(function (x) { return String(x === null || x === undefined ? '' : x).trim(); })
        .filter(function (s) { return s.length > 0; });
    }
    if (typeof h === 'string' && h.trim()) {
      return h.split(/\r?\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
    }
    return [];
  }

  /* ------------------------------------------------------------------ *
   * learning 子结构：默认值 / 归一化 / 迁移
   * ------------------------------------------------------------------ */

  function freshAttempt() {
    return {
      round: 1,
      attemptsLeft: HEARTS_PER_LEVEL,
      mode: 'independent',
      answerSeen: false,
      wrongInRound: false,
      lastSql: '',
      lastCheckedStamp: null,
      lastCheckedRound: 0,
      active: true,
      isReview: false,
      hasDraft: false
    };
  }

  function freshLearning() {
    return {
      schemaVersion: LEARNING_SCHEMA_VERSION,
      attempts: {},
      review: {},
      completions: {},
      syntaxSeen: {},
      sectionSummarySeen: {},
      daily: { day: null, goal: DEFAULT_DAILY_GOAL, planIds: [], creditedIds: [], goalCelebrated: false, legacyCarry: 0 },
      activity: { lastPracticeDay: null, activeDays: 0 },
      updatedAt: null,
      persistence: 'persisted'
    };
  }

  function normAttempt(a) {
    if (!plainObject(a)) return null;
    return {
      round: num(a.round, 1),
      attemptsLeft: Math.max(0, Math.min(HEARTS_PER_LEVEL, num(a.attemptsLeft, HEARTS_PER_LEVEL))),
      mode: a.mode === 'guided' ? 'guided' : 'independent',
      answerSeen: a.answerSeen === true,
      wrongInRound: a.wrongInRound === true,
      lastSql: str(a.lastSql, ''),
      lastCheckedStamp: str(a.lastCheckedStamp, null),
      lastCheckedRound: num(a.lastCheckedRound, 0),
      active: a.active === true,
      isReview: a.isReview === true,
      hasDraft: a.hasDraft === true
    };
  }

  function normReview(r) {
    if (!plainObject(r)) return null;
    var status = (r.status === 'needsFix' || r.status === 'due' || r.status === 'resolved') ? r.status : 'needsFix';
    return {
      status: status,
      dueDay: str(r.dueDay, null),
      lastErrorKind: str(r.lastErrorKind, null),
      note: str(r.note, null),
      lastIndependentPassDay: str(r.lastIndependentPassDay, null)
    };
  }

  function normCompletion(c) {
    if (!plainObject(c)) return null;
    var type = (c.completionType === 'independent' || c.completionType === 'guided') ? c.completionType : 'unknown';
    return {
      firstPassDay: str(c.firstPassDay, null),
      completionType: type,
      lastPassDay: str(c.lastPassDay, null)
    };
  }

  function mapValues(src, fn) {
    var out = {};
    if (!plainObject(src)) return out;
    Object.keys(src).forEach(function (k) {
      var v = fn(src[k]);
      if (v) out[k] = v;
    });
    return out;
  }

  function copyStringMap(src) {
    var out = {};
    if (!plainObject(src)) return out;
    Object.keys(src).forEach(function (k) {
      if (typeof src[k] === 'string') out[k] = src[k];
    });
    return out;
  }

  /* 旧存档 → learning 的迁移推导：只做一次（learning 缺失时）。幂等，不重发 XP。 */
  function migrateLearning(legacy) {
    var out = freshLearning();
    var passed = copyMap(legacy && legacy.passed);
    var wrong = copyMap(legacy && legacy.wrong);
    Object.keys(wrong).forEach(function (id) {
      if (wrong[id] !== true) return;
      var wasPassed = passed[id] === true;
      out.review[id] = {
        status: wasPassed ? 'due' : 'needsFix',
        dueDay: null,                       // 无时间记录 → 不编造上次错误日期
        lastErrorKind: 'legacy',
        note: '来自历史错题',
        lastIndependentPassDay: null
      };
    });
    Object.keys(passed).forEach(function (id) {
      if (passed[id] !== true) return;
      /* 旧通过记录无 answerSeen 信息 → unknown（不推断为独立完成） */
      out.completions[id] = { firstPassDay: null, completionType: 'unknown', lastPassDay: null };
    });
    out.daily.legacyCarry = Math.max(0, num(legacy && legacy.todayCount, 0));
    return out;
  }

  function normalizeLearning(raw, legacy) {
    if (!plainObject(raw)) return migrateLearning(legacy);
    var out = freshLearning();
    out.schemaVersion = num(raw.schemaVersion, LEARNING_SCHEMA_VERSION);
    out.attempts = mapValues(raw.attempts, normAttempt);
    out.review = mapValues(raw.review, normReview);
    out.completions = mapValues(raw.completions, normCompletion);
    out.syntaxSeen = copyStringMap(raw.syntaxSeen);
    out.sectionSummarySeen = copyStringMap(raw.sectionSummarySeen);
    if (plainObject(raw.daily)) {
      out.daily.day = str(raw.daily.day, null);
      out.daily.goal = Math.max(0, num(raw.daily.goal, DEFAULT_DAILY_GOAL));
      out.daily.planIds = uniqueStrings(raw.daily.planIds);
      out.daily.creditedIds = uniqueStrings(raw.daily.creditedIds);
      out.daily.goalCelebrated = raw.daily.goalCelebrated === true;
      out.daily.legacyCarry = Math.max(0, num(raw.daily.legacyCarry, 0));
    }
    if (plainObject(raw.activity)) {
      out.activity.lastPracticeDay = str(raw.activity.lastPracticeDay, null);
      out.activity.activeDays = Math.max(0, num(raw.activity.activeDays, 0));
    }
    out.updatedAt = str(raw.updatedAt, null);
    out.persistence = raw.persistence === 'memoryOnly' ? 'memoryOnly' : 'persisted';
    return out;
  }

  function ensureLearning(state) {
    if (!plainObject(state.learning)) {
      state.learning = migrateLearning(state);
    }
    return state.learning;
  }

  /* todayCount / dailyGoal 的兼容投影：只读派生，禁止两边分别自增 */
  function syncCounts(state) {
    ensureLearning(state);
    var d = state.learning.daily;
    state.todayCount = d.creditedIds.length + (d.legacyCarry || 0);
    state.dailyGoal = (typeof d.goal === 'number') ? d.goal : DEFAULT_DAILY_GOAL;
    return state;
  }

  /* ------------------------------------------------------------------ *
   * state 生命周期
   * ------------------------------------------------------------------ */

  function freshState() {
    return {
      version: 2,
      passed: {},       // id -> true：通过记录，只增不减
      xp: 0,
      hearts: HEARTS_PER_LEVEL,
      streak: 0,        // 历史字段：不再驱动新逻辑
      todayCount: 0,    // creditedIds.length 的兼容投影
      dailyGoal: DEFAULT_DAILY_GOAL,
      lastDay: null,    // 'YYYY-MM-DD'，跨天检测用（兼容字段）
      wrong: {},        // id -> true：错题本
      current: null,    // 当前关卡 id
      sql: {},          // id -> 最近一次作答
      hintSeen: {},     // id -> 已解锁提示条数
      attemptWrong: {}, // id -> true：本次尝试判错过
      learning: freshLearning()
    };
  }

  /* 从任意（含损坏 / 旧版本）对象恢复出一个结构完整的 state，坏字段回落到默认值。 */
  function normalizeState(obj) {
    var s = freshState();
    if (!obj || typeof obj !== 'object') return s;
    ['passed', 'wrong', 'sql', 'hintSeen', 'attemptWrong'].forEach(function (k) {
      if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) s[k] = copyMap(obj[k]);
    });
    if (typeof obj.xp === 'number' && isFinite(obj.xp) && obj.xp >= 0) s.xp = obj.xp;
    if (typeof obj.hearts === 'number' && obj.hearts > 0 && obj.hearts <= HEARTS_PER_LEVEL) s.hearts = obj.hearts;
    if (typeof obj.streak === 'number' && isFinite(obj.streak) && obj.streak >= 0) s.streak = obj.streak;
    if (typeof obj.todayCount === 'number' && isFinite(obj.todayCount) && obj.todayCount >= 0) s.todayCount = obj.todayCount;
    if (typeof obj.dailyGoal === 'number' && obj.dailyGoal > 0) s.dailyGoal = obj.dailyGoal;
    if (typeof obj.lastDay === 'string') s.lastDay = obj.lastDay;
    if (typeof obj.current === 'string') s.current = obj.current;
    s.learning = normalizeLearning(obj.learning, obj);
    return syncCounts(s);
  }

  function todayStamp(d) {
    d = d || new Date();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }

  /* ------------------------------------------------------------------ *
   * 跨日结算
   * ------------------------------------------------------------------ */

  /**
   * 跨日结算（幂等）。日期变化时：归档旧日、清空 creditedIds/planIds/goalCelebrated；
   * 题目草稿、attempts（含 answerSeen / 错误历史）与 review 原样保留。
   * @returns {Object} state（原地更新后返回，便于链式调用）
   */
  function ensureLearningDay(state, today) {
    ensureLearning(state);
    today = today || todayStamp();
    var d = state.learning.daily;
    if (d.day === today) return syncCounts(state);
    if (d.day === null) {
      /* 迁移当天：把旧 todayCount 记为历史投影，不捏造题号、不双计数 */
      d.legacyCarry = Math.max(0, num(state.todayCount, 0));
    } else {
      d.legacyCarry = 0;
    }
    d.day = today;
    d.planIds = [];
    d.creditedIds = [];
    d.goalCelebrated = false;
    state.lastDay = today;
    return syncCounts(state);
  }

  /* 兼容：旧 ensureDay（回血 + 清今日计数）保留，内部转发到新结算 */
  function ensureDay(state, today, goal) {
    goal = goal || state.dailyGoal || DEFAULT_DAILY_GOAL;
    state.dailyGoal = state.dailyGoal || goal;
    if (state.lastDay !== today) {
      state.lastDay = today;
      state.hearts = HEARTS_PER_LEVEL;
      state.todayCount = 0;
    }
    ensureLearningDay(state, today);
    return state;
  }

  /* ------------------------------------------------------------------ *
   * 每日小组（确定性）
   * ------------------------------------------------------------------ */

  function courseIndex(sections) {
    var flat = [];
    var byId = {};
    (sections || []).forEach(function (sec) {
      (sec.questions || []).forEach(function (q) {
        var item = { id: q.id, section: sec.section, seq: q.seq || 0, order: flat.length };
        flat.push(item);
        byId[q.id] = item;
      });
    });
    return { flat: flat, byId: byId };
  }

  function currentSectionId(state, sections) {
    var idx = courseIndex(sections);
    if (state && state.current && idx.byId[state.current]) return idx.byId[state.current].section;
    for (var i = 0; i < (sections || []).length; i++) {
      var sec = sections[i];
      for (var j = 0; j < (sec.questions || []).length; j++) {
        if (!state.passed[sec.questions[j].id]) return sec.section;
      }
    }
    return sections && sections.length ? sections[sections.length - 1].section : null;
  }

  /**
   * 每日小组：确定性选题。同一 state + 同一天可重入且结果一致（不依赖 Math.random）。
   * 顺序：最早到期复查 1 题 → 当前段起的未通过新题 → 其余到期复查 → 维护复查（≥7 天未练）。
   * @returns {{day:string, goal:number, planIds:string[], reason:string}}
   */
  function buildDailyPlan(state, sections, today) {
    ensureLearning(state);
    today = today || state.learning.daily.day || todayStamp();
    ensureLearningDay(state, today);
    var d = state.learning.daily;
    if (d.planIds.length > 0) {
      return { day: today, goal: d.goal, planIds: d.planIds.slice(), reason: 'fixed' };
    }
    var goal = (typeof d.goal === 'number' && d.goal > 0) ? d.goal : DEFAULT_DAILY_GOAL;
    var idx = courseIndex(sections);
    var review = state.learning.review;

    var dueList = Object.keys(review)
      .filter(function (id) { return review[id] && review[id].status === 'due' && idx.byId[id]; })
      .map(function (id) { return idx.byId[id]; })
      .sort(function (a, b) {
        var da = str(review[a.id].dueDay, '');
        var db = str(review[b.id].dueDay, '');
        if (da !== db) return da < db ? -1 : 1;
        if (a.section !== b.section) return a.section - b.section;
        return a.order - b.order;
      });

    var curSec = currentSectionId(state, sections);
    var fresh = idx.flat.filter(function (x) { return !state.passed[x.id]; });
    /* 当前段优先，其余按课程顺序（不按 id 连续性或 level 推导段位） */
    var freshOrdered = fresh.filter(function (x) { return x.section >= curSec; })
      .concat(fresh.filter(function (x) { return x.section < curSec; }));

    var picked = [];
    var seen = {};
    function push(item) {
      if (!item || seen[item.id] || picked.length >= goal) return;
      seen[item.id] = true;
      picked.push(item.id);
    }
    if (dueList.length) push(dueList[0]);
    for (var i = 0; i < freshOrdered.length; i++) push(freshOrdered[i]);
    for (var j = 1; j < dueList.length; j++) push(dueList[j]);

    /* 维护复查：已通过且最近一次（含看答案）通过距今 ≥7 自然日，最久未练优先 */
    if (picked.length < goal) {
      var maint = idx.flat.filter(function (x) {
        if (!state.passed[x.id]) return false;
        var c = state.learning.completions[x.id];
        if (!c || !c.lastPassDay) return false;
        var gap = daysBetween(c.lastPassDay, today);
        return gap !== null && gap >= MAINTENANCE_REVIEW_DAYS;
      }).sort(function (a, b) {
        var la = state.learning.completions[a.id].lastPassDay;
        var lb = state.learning.completions[b.id].lastPassDay;
        if (la !== lb) return la < lb ? -1 : 1;
        return a.order - b.order;
      });
      for (var k = 0; k < maint.length; k++) push(maint[k]);
    }

    d.planIds = picked.slice();
    if (picked.length === 0) {
      d.goal = 0;
      syncCounts(state);
      return { day: today, goal: 0, planIds: [], reason: 'no-tasks' };
    }
    var reason = 'ok';
    if (picked.length < goal) {
      d.goal = picked.length;
      reason = 'reduced';
    }
    syncCounts(state);
    return { day: today, goal: d.goal, planIds: d.planIds.slice(), reason: reason };
  }

  /**
   * 下一题：只在 buildSections() 结果里找下一项，不按数字 id 连续性或 level 推导段位。
   * @returns {Object|null} 题目对象
   */
  function nextQuestion(state, sections, currentSectionIdArg) {
    var idx = courseIndex(sections);
    var start = 0;
    if (state && state.current && idx.byId[state.current]) {
      start = idx.byId[state.current].order + 1;
    } else {
      var target = currentSectionIdArg;
      if (target === undefined || target === null) target = currentSectionId(state, sections);
      for (var i = 0; i < idx.flat.length; i++) {
        if (idx.flat[i].section === target) { start = i; break; }
      }
    }
    for (var j = start; j < idx.flat.length; j++) {
      if (!state.passed[idx.flat[j].id]) return idx.byId[idx.flat[j].id] && findQuestion(sections, idx.flat[j].id);
    }
    return null;
  }

  function findQuestion(sections, id) {
    var found = null;
    (sections || []).forEach(function (sec) {
      (sec.questions || []).forEach(function (q) { if (q.id === id) found = q; });
    });
    return found;
  }

  /* ------------------------------------------------------------------ *
   * 复查轮次
   * ------------------------------------------------------------------ */

  /**
   * 到期复查开启新轮：attemptsLeft=3、mode='independent'、answerSeen=false，保留可恢复草稿标记。
   * 刷新（同一未结束轮）继续同一轮，不新开一轮。
   */
  function beginReview(state, qid, today) {
    ensureLearning(state);
    var a = state.learning.attempts[qid];
    if (a && a.active) {
      a.hasDraft = a.hasDraft || !!state.sql[qid];
      return { id: qid, round: a.round, attemptsLeft: a.attemptsLeft, mode: a.mode, answerSeen: a.answerSeen, resumed: true, hasDraft: a.hasDraft };
    }
    var prevRound = a ? a.round : 0;
    var hasDraft = !!state.sql[qid];
    state.learning.attempts[qid] = {
      round: prevRound + 1,
      attemptsLeft: HEARTS_PER_LEVEL,
      mode: 'independent',
      answerSeen: false,
      wrongInRound: false,
      lastSql: str(state.sql[qid], ''),
      lastCheckedStamp: null,
      lastCheckedRound: 0,
      active: true,
      isReview: true,
      hasDraft: hasDraft
    };
    return { id: qid, round: prevRound + 1, attemptsLeft: HEARTS_PER_LEVEL, mode: 'independent', answerSeen: false, resumed: false, hasDraft: hasDraft };
  }

  /* ------------------------------------------------------------------ *
   * 唯一计分入口
   * ------------------------------------------------------------------ */

  function effectiveCheck(ev, sql) {
    if (ev.force) return true;
    if (!sql || !sql.trim()) return false;
    if (ev.referenceAvailable === false) return false;
    if (ev.execOk === false) return false;
    if (ev.pendingReview === true) return false;
    if (ev.initError === true) return false;
    return true;
  }

  /**
   * 记录一次作答事件。ev 至少含 { id, kind('run'/'check'/'answer'/'guidedReset'), sql, ok, stamp }。
   * 由它决定扣次数、置 needsFix、切 guided、置 answerSeen，并返回渲染需要的反馈。
   * 不在此处发 XP / 记今日集合 —— 那是 creditLearningEvent 的职责，避免一次事件计两次。
   */
  function recordLearningAttempt(state, ev) {
    ensureLearning(state);
    ev = ev || {};
    var id = ev.id;
    var kind = ev.kind || 'check';
    if (typeof id !== 'string' || !id) {
      return { id: null, kind: kind, counted: false, correct: false, error: 'missing-id' };
    }
    var a = state.learning.attempts[id];
    if (!a) {
      a = state.learning.attempts[id] = freshAttempt();
      var rv0 = state.learning.review[id];
      a.isReview = !!(rv0 && rv0.status === 'due');
    }
    var today = ev.stamp || state.learning.daily.day || state.lastDay || todayStamp();
    /* 午夜后第一次动作：先结算旧日再按新日计 */
    if (typeof ev.stamp === 'string' && ev.stamp) ensureLearningDay(state, ev.stamp);

    if (kind === 'run') {
      if (typeof ev.sql === 'string') { state.sql[id] = ev.sql; a.lastSql = ev.sql; a.hasDraft = true; }
      return { id: id, kind: kind, counted: false, correct: false, execOk: ev.ok !== false,
        attemptsLeft: a.attemptsLeft, mode: a.mode, duplicate: false };
    }

    if (kind === 'answer') {
      a.answerSeen = true;
      var rvA = state.learning.review[id];
      if (rvA && rvA.status === 'due') rvA.status = 'needsFix';
      return { id: id, kind: kind, counted: false, correct: false, answerSeen: true,
        attemptsLeft: a.attemptsLeft, mode: a.mode, reviewStatus: rvA ? rvA.status : null };
    }

    if (kind === 'guidedReset') {
      a.attemptsLeft = HEARTS_PER_LEVEL;
      a.mode = 'guided';
      return { id: id, kind: kind, counted: false, correct: false, attemptsLeft: a.attemptsLeft, mode: a.mode };
    }

    /* kind === 'check' */
    var sql = typeof ev.sql === 'string' ? ev.sql : '';
    if (typeof ev.sql === 'string') state.sql[id] = ev.sql;
    if (!ev.force && sql && a.lastSql === sql && a.lastCheckedStamp && a.lastCheckedRound === a.round) {
      return { id: id, kind: kind, counted: false, correct: ev.ok === true, duplicate: true, showPrevious: true,
        attemptsLeft: a.attemptsLeft, mode: a.mode };
    }
    if (!effectiveCheck(ev, sql)) {
      return { id: id, kind: kind, counted: false, correct: false, skipped: true,
        reason: (sql && sql.trim()) ? (ev.execOk === false ? 'sql-error' : 'question-unavailable') : 'empty-sql',
        attemptsLeft: a.attemptsLeft, mode: a.mode };
    }
    a.lastSql = sql;
    a.lastCheckedStamp = today;
    a.lastCheckedRound = a.round;

    var rv = state.learning.review[id];
    if (ev.ok === true) {
      var firstTime = !state.passed[id];
      if (firstTime) state.passed[id] = true;
      var modeAtPass = a.mode;
      var seenAtPass = a.answerSeen;
      var wrongAtPass = a.wrongInRound;
      var completionType = (modeAtPass === 'guided' || seenAtPass) ? 'guided' : 'independent';
      if (ev.legacy === true) completionType = 'unknown';   // 旧兼容入口不推断独立完成
      var scheduled = (rv && rv.status === 'needsFix') || wrongAtPass || modeAtPass === 'guided' || seenAtPass;
      var reviewResolved = false;
      if (scheduled) {
        state.learning.review[id] = {
          status: 'due', dueDay: shiftDay(today, 1),
          lastErrorKind: (rv && rv.lastErrorKind) || (wrongAtPass ? 'wrong' : 'guided'),
          note: rv ? rv.note : null,
          lastIndependentPassDay: (rv && rv.lastIndependentPassDay) || null
        };
      } else if (a.isReview && !seenAtPass && !wrongAtPass) {
        reviewResolved = true;
        state.learning.review[id] = {
          status: 'resolved', dueDay: null,
          lastErrorKind: rv ? rv.lastErrorKind : null,
          note: rv ? rv.note : null,
          lastIndependentPassDay: today
        };
      } else if (rv && rv.status === 'due') {
        state.learning.review[id] = {
          status: 'due', dueDay: shiftDay(today, 1),
          lastErrorKind: rv.lastErrorKind, note: rv.note, lastIndependentPassDay: rv.lastIndependentPassDay
        };
      }
      a.wrongInRound = false;
      a.active = false;
      a.attemptsLeft = HEARTS_PER_LEVEL;
      a.mode = 'independent';
      a.answerSeen = false;
      a.isReview = false;
      delete state.attemptWrong[id];
      return {
        id: id, kind: kind, counted: true, correct: true, duplicate: false,
        firstTime: firstTime, xpEligible: firstTime, reviewResolved: reviewResolved,
        completionType: completionType, attemptsLeft: a.attemptsLeft, mode: a.mode,
        needsFix: false, shouldRefill: false
      };
    }

    /* 有效判错 */
    if (a.attemptsLeft > 0) a.attemptsLeft -= 1;
    a.wrongInRound = true;
    state.wrong[id] = true;
    state.attemptWrong[id] = true;
    state.learning.review[id] = {
      status: 'needsFix', dueDay: null,
      lastErrorKind: ev.errorKind || 'wrong',
      note: rv ? rv.note : null,
      lastIndependentPassDay: (rv && rv.lastIndependentPassDay) || null
    };
    var shouldRefill = a.attemptsLeft === 0;
    if (shouldRefill) a.mode = 'guided';
    return {
      id: id, kind: kind, counted: true, correct: false, duplicate: false,
      attemptsLeft: a.attemptsLeft, mode: a.mode, needsFix: true,
      shouldRefill: shouldRefill, needsStrategyChange: shouldRefill, wrongInRound: true, firstTime: false
    };
  }

  /* ------------------------------------------------------------------ *
   * 奖励 / 今日集合 / 活跃天数
   * ------------------------------------------------------------------ */

  function updateActivity(state, today) {
    var act = state.learning.activity;
    if (act.lastPracticeDay === today) return act;
    var gap = act.lastPracticeDay ? daysBetween(act.lastPracticeDay, today) : null;
    act.activeDays = (gap === 1) ? (act.activeDays + 1) : 1;
    act.lastPracticeDay = today;
    return act;
  }

  function addCredited(d, id) {
    if (d.creditedIds.indexOf(id) !== -1) return false;
    d.creditedIds = d.creditedIds.concat([id]);
    return true;
  }

  /**
   * 结算一次事件：XP / 今日去重集合 / 活跃天数 / 目标庆祝。
   * 传入 recordLearningAttempt 的反馈（合并 id/stamp），或等价的 { id, kind, ok, stamp }。
   */
  function creditLearningEvent(state, ev) {
    ensureLearning(state);
    ev = ev || {};
    var today = ev.stamp || state.learning.daily.day || state.lastDay || todayStamp();
    if (typeof ev.stamp === 'string' && ev.stamp) ensureLearningDay(state, ev.stamp);
    var d = state.learning.daily;
    var out = {
      id: ev.id || null, xpGained: 0, credited: false,
      creditedCount: d.creditedIds.length, goal: d.goal,
      goalMet: false, goalCelebrated: d.goalCelebrated,
      activeDays: state.learning.activity.activeDays, lastPracticeDay: state.learning.activity.lastPracticeDay
    };
    if (ev.correct !== true || ev.duplicate === true || ev.skipped === true) return out;
    var id = ev.id;
    if (typeof id !== 'string' || !id) return out;

    if (ev.firstTime === true) {
      var gain = XP_PER_LEVEL;
      if (state.xp + gain > XP_CAP) gain = Math.max(0, XP_CAP - state.xp);
      state.xp += gain;
      out.xpGained = gain;
      state.learning.completions[id] = {
        firstPassDay: today,
        completionType: ev.completionType || 'independent',
        lastPassDay: today
      };
      out.credited = addCredited(d, id);
    } else if (ev.reviewResolved === true) {
      var comp = state.learning.completions[id];
      if (comp) comp.lastPassDay = today;
      else state.learning.completions[id] = { firstPassDay: null, completionType: 'unknown', lastPassDay: today };
      out.credited = addCredited(d, id);   // 到期复查干净通过：同日同题最多计 1
    } else {
      var c2 = state.learning.completions[id];
      if (c2) c2.lastPassDay = today;
    }

    if (out.credited) {
      if (d.goal > 0 && !d.goalCelebrated && d.creditedIds.length >= d.goal) d.goalCelebrated = true;
      updateActivity(state, today);
    }
    syncCounts(state);
    out.creditedCount = d.creditedIds.length;
    out.goal = d.goal;
    out.goalMet = d.goal > 0 && d.creditedIds.length >= d.goal;
    out.goalCelebrated = d.goalCelebrated;
    out.activeDays = state.learning.activity.activeDays;
    out.lastPracticeDay = state.learning.activity.lastPracticeDay;
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 段进度
   * ------------------------------------------------------------------ */

  /**
   * 段完成度：分子用 passed，分母用该段题数；「待复查 n 题」与「已完成」并列，不互相遮盖。
   * @returns {{sections:Array, recommendedSection:(number|null)}}
   */
  function sectionProgress(state, sections) {
    ensureLearning(state);
    var review = state.learning.review;
    var list = (sections || []).map(function (sec) {
      var total = (sec.questions || []).length;
      var passed = 0;
      var needsFix = 0;
      var due = 0;
      (sec.questions || []).forEach(function (q) {
        if (state.passed[q.id]) passed += 1;
        var rv = review[q.id];
        if (!rv) return;
        if (rv.status === 'needsFix') needsFix += 1;
        else if (rv.status === 'due') due += 1;
      });
      return {
        section: sec.section, title: sec.title,
        total: total, passed: passed, needsFix: needsFix, due: due,
        completed: total > 0 && passed === total
      };
    });
    var recommendedSection = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].completed && i + 1 < list.length && !list[i + 1].completed) {
        recommendedSection = list[i + 1].section;
        break;
      }
    }
    return { sections: list, recommendedSection: recommendedSection };
  }

  /* ------------------------------------------------------------------ *
   * 兼容包装（旧签名 / 旧返回值保持可用，内部走同一套新规则）
   * ------------------------------------------------------------------ */

  /**
   * 判错兼容入口。返回旧字段 { reset, hearts, streak }，另附新机制 { attemptsLeft, mode }。
   */
  function recordWrong(state, id) {
    ensureLearning(state);
    var today = state.learning.daily.day || state.lastDay || todayStamp();
    var fb = recordLearningAttempt(state, {
      id: id, kind: 'check', sql: str(state.sql[id], ''), ok: false, stamp: today,
      referenceAvailable: true, execOk: true, force: true, legacy: true
    });
    state.hearts -= 1;
    var reset = false;
    if (state.hearts <= 0) {
      state.hearts = HEARTS_PER_LEVEL;
      delete state.attemptWrong[id];
      reset = true;
    }
    return {
      reset: reset, hearts: state.hearts, streak: state.streak,
      attemptsLeft: fb.attemptsLeft, mode: fb.mode
    };
  }

  /**
   * 判对兼容入口。返回旧字段 { firstTime, xpGained, streak, goalMet }，另附 credited。
   */
  function recordPass(state, id) {
    ensureLearning(state);
    var today = state.learning.daily.day || state.lastDay || todayStamp();
    var fb = recordLearningAttempt(state, {
      id: id, kind: 'check', sql: str(state.sql[id], ''), ok: true, stamp: today,
      referenceAvailable: true, execOk: true, force: true, legacy: true
    });
    var credit = creditLearningEvent(state, {
      id: id, kind: 'check', ok: true, correct: true, stamp: today,
      firstTime: fb.firstTime, reviewResolved: fb.reviewResolved, completionType: fb.completionType
    });
    delete state.attemptWrong[id];
    return {
      firstTime: fb.firstTime, xpGained: credit.xpGained, streak: state.streak,
      goalMet: goalMet(state), credited: credit.credited
    };
  }

  function goalMet(state) {
    var goal = (state.learning && typeof state.learning.daily.goal === 'number')
      ? state.learning.daily.goal
      : (state.dailyGoal || DEFAULT_DAILY_GOAL);
    if (goal <= 0) return false;
    var count = (state.learning && state.learning.daily.creditedIds)
      ? state.learning.daily.creditedIds.length + (state.learning.daily.legacyCarry || 0)
      : state.todayCount;
    return count >= goal;
  }

  /* ------------------------------------------------------------------ *
   * 多标签页：只做「检测到较新版本」的纯比较，不实现自动合并
   * ------------------------------------------------------------------ */

  function readUpdatedAt(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    try {
      var o = JSON.parse(raw);
      if (!o || typeof o !== 'object') return null;
      if (o.learning && typeof o.learning.updatedAt === 'string') return o.learning.updatedAt;
      if (typeof o.updatedAt === 'string') return o.updatedAt;
      return null;
    } catch (e) {
      return null;
    }
  }

  /** otherRaw 是否比 currentRaw 新（ISO 字符串可直接字典序比较）。 */
  function isStale(otherRaw, currentRaw) {
    var a = readUpdatedAt(otherRaw);
    var b = readUpdatedAt(currentRaw);
    if (a === null) return false;
    if (b === null) return true;
    return a > b;
  }

  /* ------------------------------------------------------------------ *
   * 状态读写
   * ------------------------------------------------------------------ */

  /* storage 由调用方注入（浏览器传 localStorage，测试传内存 stub）。
     写入成功才标记为 'persisted'；失败降级为 'memoryOnly'，下次成功解除。 */
  function saveState(storage, state) {
    ensureLearning(state);
    try {
      state.learning.updatedAt = new Date().toISOString();
      storage.setItem(STORAGE_KEY, JSON.stringify(state));
      state.learning.persistence = 'persisted';
      return true;
    } catch (e) {
      state.learning.persistence = 'memoryOnly';
      return false;
    }
  }

  function loadState(storage) {
    try {
      var raw = storage.getItem(STORAGE_KEY);
      if (!raw) return freshState();
      return normalizeState(JSON.parse(raw));
    } catch (e) {
      return freshState();
    }
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    DEFAULT_DAILY_GOAL: DEFAULT_DAILY_GOAL,
    HEARTS_PER_LEVEL: HEARTS_PER_LEVEL,
    XP_PER_LEVEL: XP_PER_LEVEL,
    XP_CAP: XP_CAP,
    MAINTENANCE_REVIEW_DAYS: MAINTENANCE_REVIEW_DAYS,
    SECTION_TITLES: SECTION_TITLES,
    buildSections: buildSections,
    validSyntaxItem: validSyntaxItem,
    syntaxIntrosFor: syntaxIntrosFor,
    hintList: hintList,
    freshState: freshState,
    normalizeState: normalizeState,
    todayStamp: todayStamp,
    shiftDay: shiftDay,
    daysBetween: daysBetween,
    ensureDay: ensureDay,
    ensureLearningDay: ensureLearningDay,
    buildDailyPlan: buildDailyPlan,
    nextQuestion: nextQuestion,
    beginReview: beginReview,
    recordLearningAttempt: recordLearningAttempt,
    creditLearningEvent: creditLearningEvent,
    sectionProgress: sectionProgress,
    recordWrong: recordWrong,
    recordPass: recordPass,
    goalMet: goalMet,
    isStale: isStale,
    saveState: saveState,
    loadState: loadState
  };
});
