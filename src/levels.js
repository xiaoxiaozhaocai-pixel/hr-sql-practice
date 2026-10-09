/*
 * src/levels.js — 关卡编排 + 游戏化状态机（纯逻辑：不碰 DOM / window / localStorage）
 * ---------------------------------------------------------------------------
 * 为什么单独成文件（开源第 1 条「题库与逻辑分离」）：
 *   1) 段/关的定义只依赖题目自带的 level / seq / title / knowledge_point，
 *      渲染层不再写死任何段号与关数；别人往 data/questions.json 里加题即可自动进段。
 *   2) 纯函数 + 显式传入 storage，使得 node 原生 test runner 能直接用内存 stub 验证
 *      「扣心 / XP / 连胜 / 跨天 / 读写往返」，不必启动浏览器。
 *
 * 双模加载：node 下 module.exports；浏览器内联时挂 globalThis.HRLevels（与 src/judge.js 同款）。
 *
 * 游戏化口径（对应任务卡 §3）：
 *   - 心：每关 3 次尝试，判错扣 1；扣光只重置「本关」，已通过其它关不受影响（记录不删）。
 *   - XP：首次过关 +10；同一关重复通过不重复计分（passed 只增不减）。
 *   - 连胜：只有「首次过关且本次尝试一次没判错」才 +1；任何一次判错立即归零。
 *   - 每日目标：默认 3 关；跨天（lastDay 变化）时心回 3、今日计数归零，XP 与通过记录保留。
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

  /* 段标题：20 题按 level 字段天然分成 4 段（5 / 7 / 6 / 2 关）。
     这里只登记标题；段的成员完全由题目 level 决定，新增题目无需改这张表。 */
  var SECTION_TITLES = {
    1: '入门 · 单表查询',
    2: '进阶 · 分组与多表',
    3: '实战 · 子查询与口径',
    4: '挑战 · 视图与递归'
  };

  /**
   * 把题目编排成段：section = { level, title, questions[] }。
   * 段内严格按 seq 升序 —— 题库作者已排好循序渐进的坡度，编排层不得重排。
   */
  function buildSections(questions, titles) {
    titles = titles || SECTION_TITLES;
    var byLevel = {};
    (questions || []).forEach(function (q) {
      if (!q || q.level === undefined || q.level === null) return;
      var lv = Number(q.level);
      if (!byLevel[lv]) byLevel[lv] = [];
      byLevel[lv].push(q);
    });
    return Object.keys(byLevel)
      .map(Number)
      .sort(function (a, b) { return a - b; })
      .map(function (lv) {
        var qs = byLevel[lv].slice().sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
        return { level: lv, title: titles[lv] || ('第 ' + lv + ' 段'), questions: qs };
      });
  }

  /**
   * 渐进提示归一化：题库当前把 hint 写成单条字符串，这里统一成数组。
   * 字符串按换行拆条（当前题库无换行 → 恰好 1 条）；数组则直接使用。
   * 这样「第一次错给第 1 条、第二次错给第 2 条」的推进逻辑只写一遍，
   * 未来题目改写成 hint: ["...", "..."] 立刻生效，无需改渲染代码。
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

  function freshState() {
    return {
      version: 2,
      passed: {},       // id -> true：通过记录，只增不减（重复通过不重复计分）
      xp: 0,
      hearts: HEARTS_PER_LEVEL,
      streak: 0,        // 「一次就过」连胜
      todayCount: 0,
      dailyGoal: DEFAULT_DAILY_GOAL,
      lastDay: null,    // 'YYYY-MM-DD'，跨天检测用
      wrong: {},        // id -> true：错题本
      current: null,    // 当前关卡 id
      sql: {},          // id -> 最近一次作答（沿用 v1 能力，不算新增）
      hintSeen: {},     // id -> 已解锁提示条数（渐进提示）
      attemptWrong: {}  // id -> true：本次尝试判错过（决定是否算「一次就过」）
    };
  }

  /* 从任意（含损坏 / 旧版本）对象恢复出一个结构完整的 state，坏字段回落到默认值。 */
  function normalizeState(obj) {
    var s = freshState();
    if (!obj || typeof obj !== 'object') return s;
    ['passed', 'wrong', 'sql', 'hintSeen', 'attemptWrong'].forEach(function (k) {
      if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) s[k] = obj[k];
    });
    if (typeof obj.xp === 'number' && isFinite(obj.xp) && obj.xp >= 0) s.xp = obj.xp;
    if (typeof obj.hearts === 'number' && obj.hearts > 0 && obj.hearts <= HEARTS_PER_LEVEL) s.hearts = obj.hearts;
    if (typeof obj.streak === 'number' && isFinite(obj.streak) && obj.streak >= 0) s.streak = obj.streak;
    if (typeof obj.todayCount === 'number' && isFinite(obj.todayCount) && obj.todayCount >= 0) s.todayCount = obj.todayCount;
    if (typeof obj.dailyGoal === 'number' && obj.dailyGoal > 0) s.dailyGoal = obj.dailyGoal;
    if (typeof obj.lastDay === 'string') s.lastDay = obj.lastDay;
    if (typeof obj.current === 'string') s.current = obj.current;
    return s;
  }

  function todayStamp(d) {
    d = d || new Date();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }

  /* 跨天重置：只回血与清今日计数，已通过的关、XP、错题本都保留。 */
  function ensureDay(state, today, goal) {
    goal = goal || state.dailyGoal || DEFAULT_DAILY_GOAL;
    state.dailyGoal = state.dailyGoal || goal;
    if (state.lastDay !== today) {
      state.lastDay = today;
      state.hearts = HEARTS_PER_LEVEL;
      state.todayCount = 0;
    }
    return state;
  }

  /**
   * 判错：扣 1 颗心、记入错题本、连胜归零。
   * 扣光（hearts 到 0）只重置本关：心回满，其它关的通过记录与 XP 原样不动。
   * @returns {{reset:boolean, hearts:number, streak:number}}
   */
  function recordWrong(state, id) {
    state.wrong[id] = true;
    state.attemptWrong[id] = true;
    state.streak = 0;
    state.hearts -= 1;
    var reset = false;
    if (state.hearts <= 0) {
      state.hearts = HEARTS_PER_LEVEL;
      delete state.attemptWrong[id];   // 本关重新开始 → 「一次就过」的机会也重置
      reset = true;
    }
    return { reset: reset, hearts: state.hearts, streak: state.streak };
  }

  /**
   * 判对：首次通过才加分/加今日计数/记通过；重复通过一律不计。
   * 连胜只在「首次通过 && 本次尝试没判错过」时 +1。
   * @returns {{firstTime:boolean, xpGained:number, streak:number, goalMet:boolean}}
   */
  function recordPass(state, id) {
    var firstTime = !state.passed[id];
    var clean = !state.attemptWrong[id];
    if (firstTime) {
      state.passed[id] = true;
      state.xp += XP_PER_LEVEL;
      state.todayCount += 1;
    }
    if (firstTime && clean) state.streak += 1;
    delete state.attemptWrong[id];
    return {
      firstTime: firstTime,
      xpGained: firstTime ? XP_PER_LEVEL : 0,
      streak: state.streak,
      goalMet: state.todayCount >= state.dailyGoal
    };
  }

  function goalMet(state) {
    return state.todayCount >= (state.dailyGoal || DEFAULT_DAILY_GOAL);
  }

  /* 状态读写：storage 由调用方注入（浏览器传 localStorage，测试传内存 stub）。
     任何写失败都静默降级为「仅本次会话有效」，不抛错、不阻断做题。 */
  function saveState(storage, state) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
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
    SECTION_TITLES: SECTION_TITLES,
    buildSections: buildSections,
    hintList: hintList,
    freshState: freshState,
    normalizeState: normalizeState,
    todayStamp: todayStamp,
    ensureDay: ensureDay,
    recordWrong: recordWrong,
    recordPass: recordPass,
    goalMet: goalMet,
    saveState: saveState,
    loadState: loadState
  };
});
