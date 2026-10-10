/*
 * src/tables.js — 表结构速查数据 + 纯逻辑查询（双模加载：node module.exports / 浏览器 globalThis.HRTables）
 * ---------------------------------------------------------------------------
 * 口径：
 *   - 只描述「结构」：表名 / 中文名 / 业务角色 / 字段名 / 类型 / 可空 / 业务含义。
 *     绝不包含任何数据行（无 INSERT、无样例行、无真实取值）。
 *   - 字段定义与 docs/data-model-v1.md 的 ### 2.N 小节逐字段对齐；test/tables.test.mjs
 *     会解析该 markdown 并逐表逐字段比对，防止两边漂移。
 *   - 表的中文名与业务角色与 docs/model-notes-v1.json 的 tables[] 对齐。
 *   - 本模块不碰 DOM / window / fs，可在 node 原生 test runner 里直接测。
 *   - 浏览器内联时由 build.mjs 注入（占位符 __HR_TABLES__ 标记），与 src/levels.js 同款。
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory();
  } else {
    root.HRTables = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* 11 张表；fields[] 顺序与 docs/data-model-v1.md 一致。nullable 为 true 表示「可空」。 */
  var TABLES = [
    {
      name: 'HR_ORG',
      cn_name: '组织',
      role: '组织树，ParentID 自关联，层级至少 4 层',
      fields: [
        { name: 'ID', type: 'int IDENTITY', nullable: false, note: '主键' },
        { name: 'OrgCode', type: 'varchar(20)', nullable: false, note: '组织编码，字符型，长短不一' },
        { name: 'OrgName', type: 'nvarchar(100)', nullable: false, note: '组织名称' },
        { name: 'ParentID', type: 'int', nullable: true, note: '上级组织 ID，自关联，顶级为 NULL' },
        { name: 'OrgLevel', type: 'int', nullable: false, note: '层级：1 公司 / 2 厂·中心 / 3 部门 / 4 班组' },
        { name: 'OrgTypeCode', type: 'varchar(20)', nullable: true, note: '组织类型，指向 HR_DICT 的 ORG_TYPE' },
        { name: 'ManagerEmpNo', type: 'varchar(20)', nullable: true, note: '负责人工号' },
        { name: 'CostCenter', type: 'varchar(20)', nullable: true, note: '成本中心' },
        { name: 'ValidFrom', type: 'date', nullable: false, note: '生效日' },
        { name: 'ValidTo', type: 'date', nullable: true, note: '失效日，NULL 表示至今' },
        { name: 'IsActive', type: 'int', nullable: true, note: '状态，混用 1 / 0 / NULL' },
        { name: 'Remark', type: 'nvarchar(200)', nullable: true, note: '说明' }
      ]
    },
    {
      name: 'HR_JOB',
      cn_name: '岗位标准',
      role: '与组织无关的岗位定义',
      fields: [
        { name: 'JobCode', type: 'varchar(20)', nullable: false, note: '主键，岗位编码' },
        { name: 'JobName', type: 'nvarchar(50)', nullable: false, note: '岗位名称，埋坑：大小写与空格不一致' },
        { name: 'JobFamilyCode', type: 'varchar(20)', nullable: true, note: '职族，指向 HR_DICT 的 JOB_FAMILY' },
        { name: 'JobLevelCode', type: 'varchar(20)', nullable: true, note: '职级，指向 HR_DICT 的 JOB_LEVEL' },
        { name: 'IsActive', type: 'int', nullable: true, note: '状态' }
      ]
    },
    {
      name: 'HR_POSITION',
      cn_name: '组织岗位与编制',
      role: '组织 × 岗位的落位与编制数，唯一键 (OrgID, JobCode)',
      fields: [
        { name: 'PositionCode', type: 'varchar(20)', nullable: false, note: '主键，岗位实例编码' },
        { name: 'OrgID', type: 'int', nullable: false, note: '所属组织，指向 HR_ORG' },
        { name: 'JobCode', type: 'varchar(20)', nullable: false, note: '岗位标准，指向 HR_JOB' },
        { name: 'HeadCountPlan', type: 'int', nullable: false, note: '编制数' },
        { name: 'ValidFrom', type: 'date', nullable: false, note: '生效日' },
        { name: 'ValidTo', type: 'date', nullable: true, note: '失效日' },
        { name: 'IsActive', type: 'int', nullable: true, note: '状态' }
      ]
    },
    {
      name: 'HR_EMPLOYEE',
      cn_name: '员工（花名册）',
      role: '人员主数据。刻意不存「当前部门 / 当前岗位 / 在职状态」',
      fields: [
        { name: 'EmpNo', type: 'varchar(20)', nullable: false, note: '主键，工号，字符型且长度不一' },
        { name: 'EmpName', type: 'nvarchar(50)', nullable: false, note: '姓名，埋坑：存在同名不同人' },
        { name: 'GenderCode', type: 'varchar(10)', nullable: true, note: '性别，指向字典' },
        { name: 'BirthDate', type: 'date', nullable: true, note: '出生日期，存在 NULL' },
        { name: 'EducationCode', type: 'varchar(20)', nullable: true, note: '学历，指向字典' },
        { name: 'SchoolName', type: 'nvarchar(100)', nullable: true, note: '毕业院校' },
        { name: 'MajorName', type: 'nvarchar(100)', nullable: true, note: '专业' },
        { name: 'HireDate', type: 'date', nullable: false, note: '入职日期' },
        { name: 'TermDate', type: 'date', nullable: true, note: '离职日期，NULL 表示在职' },
        { name: 'EmpTypeCode', type: 'varchar(20)', nullable: true, note: '雇佣类型，指向字典' },
        { name: 'Mobile', type: 'varchar(20)', nullable: true, note: '手机号，虚构数据，存在 NULL' },
        { name: 'IsActive', type: 'int', nullable: true, note: '状态，混用 1 / 0 / NULL' }
      ]
    },
    {
      name: 'HR_ASSIGNMENT',
      cn_name: '任职记录',
      role: '★ 整套模型的枢纽：人 × 组织 × 岗位 × 时间',
      fields: [
        { name: 'ID', type: 'int IDENTITY', nullable: false, note: '主键' },
        { name: 'EmpNo', type: 'varchar(20)', nullable: false, note: '员工，指向 HR_EMPLOYEE' },
        { name: 'OrgID', type: 'int', nullable: false, note: '组织，指向 HR_ORG' },
        { name: 'PositionCode', type: 'varchar(20)', nullable: true, note: '岗位实例，指向 HR_POSITION' },
        { name: 'JobCode', type: 'varchar(20)', nullable: true, note: '岗位标准，指向 HR_JOB' },
        { name: 'AssignmentTypeCode', type: 'varchar(20)', nullable: true, note: '任职类型，指向字典' },
        { name: 'IsPrimary', type: 'int', nullable: true, note: '是否主职，1 / 0' },
        { name: 'ActionCode', type: 'varchar(20)', nullable: true, note: '异动类型，指向字典' },
        { name: 'StartDate', type: 'date', nullable: false, note: '起始日' },
        { name: 'EndDate', type: 'date', nullable: true, note: '结束日，NULL 表示至今' }
      ]
    },
    {
      name: 'HR_SALARY',
      cn_name: '薪酬（按月）',
      role: '按月薪酬事实，唯一键 (EmpNo, SalaryMonth)',
      fields: [
        { name: 'ID', type: 'int IDENTITY', nullable: false, note: '主键' },
        { name: 'EmpNo', type: 'varchar(20)', nullable: false, note: '工号' },
        { name: 'SalaryMonth', type: 'char(6)', nullable: false, note: '薪酬期间 YYYYMM' },
        { name: 'BaseSalary', type: 'decimal(12,2)', nullable: false, note: '基本工资' },
        { name: 'PerfBonus', type: 'decimal(12,2)', nullable: true, note: '绩效奖金' },
        { name: 'Allowance', type: 'decimal(12,2)', nullable: true, note: '津贴' },
        { name: 'OvertimePay', type: 'decimal(12,2)', nullable: true, note: '加班费' },
        { name: 'GrossPay', type: 'decimal(12,2)', nullable: false, note: '应发合计' },
        { name: 'Deduction', type: 'decimal(12,2)', nullable: true, note: '扣款，NULL 与 0 混用' },
        { name: 'NetPay', type: 'decimal(12,2)', nullable: false, note: '实发' },
        { name: 'CurrencyCode', type: 'varchar(10)', nullable: false, note: '币种，指向字典，存在跨币种' }
      ]
    },
    {
      name: 'HR_ATTENDANCE',
      cn_name: '考勤（按月）',
      role: '按月考勤事实，唯一键 (EmpNo, AttMonth)',
      fields: [
        { name: 'ID', type: 'int IDENTITY', nullable: false, note: '主键' },
        { name: 'EmpNo', type: 'varchar(20)', nullable: false, note: '工号' },
        { name: 'AttMonth', type: 'char(6)', nullable: false, note: '考勤期间 YYYYMM' },
        { name: 'WorkDays', type: 'decimal(5,1)', nullable: false, note: '应出勤天数' },
        { name: 'ActualDays', type: 'decimal(5,1)', nullable: false, note: '实出勤天数' },
        { name: 'LeaveDays', type: 'decimal(5,1)', nullable: true, note: '请假天数，NULL 表示无请假' },
        { name: 'OvertimeHours', type: 'decimal(6,1)', nullable: true, note: '加班小时' },
        { name: 'AbsentDays', type: 'decimal(5,1)', nullable: true, note: '缺勤天数' },
        { name: 'LateCount', type: 'int', nullable: true, note: '迟到次数' }
      ]
    },
    {
      name: 'HR_RECRUIT_REQ',
      cn_name: '招聘需求',
      role: '招聘需求主表',
      fields: [
        { name: 'ReqNo', type: 'varchar(20)', nullable: false, note: '主键，需求编号' },
        { name: 'OrgID', type: 'int', nullable: false, note: '需求组织，指向 HR_ORG' },
        { name: 'JobCode', type: 'varchar(20)', nullable: false, note: '需求岗位，指向 HR_JOB' },
        { name: 'HeadCount', type: 'int', nullable: false, note: '需求人数' },
        { name: 'PriorityCode', type: 'varchar(20)', nullable: true, note: '紧急度，指向字典' },
        { name: 'StatusCode', type: 'varchar(20)', nullable: false, note: '状态，指向字典' },
        { name: 'OpenDate', type: 'date', nullable: false, note: '开启日' },
        { name: 'CloseDate', type: 'date', nullable: true, note: '关闭日，NULL 表示仍开启' },
        { name: 'OwnerEmpNo', type: 'varchar(20)', nullable: true, note: '负责 HR 工号' }
      ]
    },
    {
      name: 'HR_CANDIDATE',
      cn_name: '候选人',
      role: '候选人明细，挂在招聘需求下',
      fields: [
        { name: 'CandNo', type: 'varchar(20)', nullable: false, note: '主键，候选人编号' },
        { name: 'ReqNo', type: 'varchar(20)', nullable: false, note: '关联需求，指向 HR_RECRUIT_REQ' },
        { name: 'CandName', type: 'nvarchar(50)', nullable: false, note: '姓名，虚构' },
        { name: 'SourceCode', type: 'varchar(20)', nullable: true, note: '来源渠道，指向字典' },
        { name: 'StageCode', type: 'varchar(20)', nullable: true, note: '当前阶段，指向字典' },
        { name: 'ApplyDate', type: 'date', nullable: false, note: '投递日' },
        { name: 'OfferDate', type: 'date', nullable: true, note: 'Offer 日' },
        { name: 'HireDate', type: 'date', nullable: true, note: '入职日，NULL 表示未入职' },
        { name: 'ExpectedSalary', type: 'decimal(12,2)', nullable: true, note: '期望薪资' },
        { name: 'ResultCode', type: 'varchar(20)', nullable: true, note: '结果，指向字典' }
      ]
    },
    {
      name: 'HR_PERFORMANCE',
      cn_name: '绩效',
      role: '考核结果，唯一键 (EmpNo, PeriodCode)',
      fields: [
        { name: 'ID', type: 'int IDENTITY', nullable: false, note: '主键' },
        { name: 'EmpNo', type: 'varchar(20)', nullable: false, note: '工号' },
        { name: 'PeriodCode', type: 'varchar(10)', nullable: false, note: '考核周期，指向字典' },
        { name: 'ScoreValue', type: 'decimal(5,2)', nullable: true, note: '分数，存在 NULL 表示未参评' },
        { name: 'GradeCode', type: 'varchar(10)', nullable: true, note: '等级，由分数推导' },
        { name: 'RankInOrg', type: 'int', nullable: true, note: '同考核期同组织内排名，未参评为 NULL' },
        { name: 'EvaluatorEmpNo', type: 'varchar(20)', nullable: true, note: '评估人工号' },
        { name: 'IsFinal', type: 'int', nullable: false, note: '是否终评，1 / 0' }
      ]
    },
    {
      name: 'HR_DICT',
      cn_name: '字典（码值表）',
      role: '全库所有 *Code 字段的翻译源',
      fields: [
        { name: 'ID', type: 'int IDENTITY', nullable: false, note: '主键' },
        { name: 'DictType', type: 'varchar(30)', nullable: false, note: '字典类型' },
        { name: 'Code', type: 'varchar(20)', nullable: false, note: '码值' },
        { name: 'Title', type: 'nvarchar(50)', nullable: false, note: '显示名称' },
        { name: 'SortNo', type: 'int', nullable: true, note: '排序号，大量为 NULL' },
        { name: 'IsDisabled', type: 'int', nullable: true, note: '状态，混用 1 / 0 / NULL' },
        { name: 'Remark', type: 'nvarchar(200)', nullable: true, note: '说明' }
      ]
    }
  ];

  /* 3 个教学视图：只登记名字与作用，不含字段明细。 */
  var VIEWS = [
    { name: 'V_ORG_TREE', purpose: '组织树（递归 CTE，输出层级与完整路径）' },
    { name: 'V_EMP_ASSIGNMENT', purpose: '任职宽表（人 + 组织 + 岗位 + 起止）' },
    { name: 'V_ORG_HEADCOUNT', purpose: '编制 vs 实配（含超编 / 空缺）' }
  ];

  function cloneTable(t) {
    return {
      name: t.name,
      cn_name: t.cn_name,
      role: t.role,
      fields: t.fields.map(function (f) {
        return { name: f.name, type: f.type, nullable: f.nullable, note: f.note };
      })
    };
  }

  function allTables() {
    return TABLES.map(cloneTable);
  }

  function allViews() {
    return VIEWS.map(function (v) { return { name: v.name, purpose: v.purpose }; });
  }

  function getTable(name) {
    var key = String(name || '').trim().toUpperCase();
    for (var i = 0; i < TABLES.length; i++) {
      if (TABLES[i].name.toUpperCase() === key) return cloneTable(TABLES[i]);
    }
    return null;
  }

  function fieldNames(name) {
    var t = getTable(name);
    return t ? t.fields.map(function (f) { return f.name; }) : [];
  }

  function fieldCount(name) {
    return fieldNames(name).length;
  }

  /* 关键字过滤：命中表名 / 中文名 / 字段名 / 字段说明。返回带命中字段列表的结果。 */
  function searchTables(keyword) {
    var kw = String(keyword || '').trim().toLowerCase();
    if (!kw) {
      return allTables().map(function (t) { return { table: t, matchedFields: [] }; });
    }
    var out = [];
    TABLES.forEach(function (t) {
      var nameHit = t.name.toLowerCase().indexOf(kw) !== -1 || t.cn_name.toLowerCase().indexOf(kw) !== -1;
      var matched = t.fields.filter(function (f) {
        return f.name.toLowerCase().indexOf(kw) !== -1 || f.note.toLowerCase().indexOf(kw) !== -1;
      });
      if (nameHit || matched.length) {
        out.push({
          table: cloneTable(t),
          matchedFields: matched.map(function (f) { return f.name; })
        });
      }
    });
    return out;
  }

  /* 白名单：本模块已登记的表 + 视图（全大写），用于排除 CTE 名 / 别名 / 子查询伪表名。 */
  var KNOWN_NAMES = TABLES.map(function (t) { return t.name.toUpperCase(); })
    .concat(VIEWS.map(function (v) { return v.name.toUpperCase(); }));

  /* 题目的真实用表：从参考 SQL 解析 FROM / JOIN 后的标识符，再按白名单过滤。
     数据源 = 题目自带的参考 SQL，不再依赖 model-notes 的人工登记。
     返回按首次出现顺序去重的表/视图名数组；解析为空即返回 []。 */
  function questionTables(q) {
    if (!q || typeof q !== 'object') return [];
    var sql = q.reference_sql_sqlite || q.reference_sql || '';
    if (!sql) return [];
    var s = String(sql)
      .replace(/--[^\n]*/g, ' ')          /* 剥行注释 */
      .replace(/\/\*[\s\S]*?\*\//g, ' '); /* 剥块注释 */
    var ident = /\b(?:FROM|JOIN)\s+([A-Za-z_\[][A-Za-z0-9_.\[\]]*)/gi;
    var out = [];
    var m;
    while ((m = ident.exec(s)) !== null) {
      var raw = m[1].replace(/[\[\]]/g, '');       /* 去方括号 */
      var parts = raw.split('.');
      var name = parts[parts.length - 1].trim().toUpperCase(); /* 去 dbo. 前缀并转大写 */
      if (KNOWN_NAMES.indexOf(name) === -1) continue;          /* 白名单过滤 */
      if (out.indexOf(name) === -1) out.push(name);            /* 去重，保留首次出现顺序 */
    }
    return out;
  }

  /* 题目 seq -> 表名列表。数据源 = docs/model-notes-v1.json 的 questions[]（id 即 seq）。 */
  function questionTableMap(modelQuestions) {
    var map = {};
    (modelQuestions || []).forEach(function (q) {
      if (!q || q.id === undefined || q.id === null) return;
      map[Number(q.id)] = Array.isArray(q.tables) ? q.tables.slice() : [];
    });
    return map;
  }

  function tablesForSeq(modelQuestions, seq) {
    var map = questionTableMap(modelQuestions);
    return map[Number(seq)] || [];
  }

  return {
    TABLES: TABLES,
    VIEWS: VIEWS,
    allTables: allTables,
    allViews: allViews,
    getTable: getTable,
    fieldNames: fieldNames,
    fieldCount: fieldCount,
    searchTables: searchTables,
    questionTableMap: questionTableMap,
    tablesForSeq: tablesForSeq,
    questionTables: questionTables
  };
});
