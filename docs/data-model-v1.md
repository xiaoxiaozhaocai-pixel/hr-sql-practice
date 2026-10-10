# HR 练习库 · 数据模型 v1

> 项目：《HR 语境 SQL 练习平台》 · 业务侧交付物（可读版）
> 版本：v1 定稿｜2026-10-09
> 配套交付：`schema.sql`（建表） / `seed.sql`（造数） / `model_notes.json`（造数意图）
> 权威口径：**以 SQL Server 语法脚本为唯一权威源**，网页端与网页数据均为其派生物。
> 下表行数为 `seed.sql` 实际生成值，与 `model_notes.json` 的 `row_counts` 一致，可作验收对账。

---

## 0. 三条设计原则

1. **通用 HR 概念，不碰任何单位真实系统**。只用"人／组织／岗位／薪酬／考勤／招聘／绩效"这些所有 HR 系统共通的业务概念。交付物中不出现任何真实库名、表名、字段名、系统名、组织名、人员信息。
2. **一切以时间为轴**。主数据全部带 `ValidFrom` / `ValidTo`；任职记录带 `StartDate` / `EndDate`。没有时间维度的 HR 练习库，练不出 HRIS 的核心本事（"某人在某月属于哪个部门"）。
3. **固定基准日，不用 `GETDATE()`**。全库时点统一为 **`2026-06-30`**，题目中一律写死日期。
   > 这条不只是为了判题——`GETDATE()` 会让同一道题每天答案都变，**预期结果无法固定，判题直接失效**。

---

## 1. 表清单

库名：`HRSQLPractice`　表前缀：`HR_`　视图前缀：`V_`

| # | 表名 | 中文名 | 归类 | 行数 |
|---|---|---|---|---|
| 1 | `HR_ORG` | 组织 | 主数据 | 40 |
| 2 | `HR_JOB` | 岗位标准 | 主数据 | 25 |
| 3 | `HR_POSITION` | 组织岗位与编制 | 主数据 | 60 |
| 4 | `HR_EMPLOYEE` | 员工（花名册） | 主数据 | 200 |
| 5 | `HR_ASSIGNMENT` | 任职记录 ★核心 | 关系 | 243 |
| 6 | `HR_SALARY` | 薪酬（按月） | 业务事实 | 1868 |
| 7 | `HR_ATTENDANCE` | 考勤（按月） | 业务事实 | 1868 |
| 8 | `HR_RECRUIT_REQ` | 招聘需求 | 业务事实 | 30 |
| 9 | `HR_CANDIDATE` | 候选人 | 业务事实 | 120 |
| 10 | `HR_PERFORMANCE` | 绩效 | 业务事实 | 315 |
| 11 | `HR_DICT` | 字典（码值表） | 字典 | 73 |

视图（教学用）：

| # | 视图名 | 作用 |
|---|---|---|
| V1 | `V_ORG_TREE` | 组织树（递归 CTE，输出层级与完整路径） |
| V2 | `V_EMP_ASSIGNMENT` | 任职宽表（人 + 组织 + 岗位 + 起止） |
| V3 | `V_ORG_HEADCOUNT` | 编制 vs 实配（含超编/空缺） |

> **七块业务落在哪**：组织架构 → `HR_ORG`；岗位编制 → `HR_JOB` + `HR_POSITION`；花名册 → `HR_EMPLOYEE` + `HR_ASSIGNMENT`；薪酬/考勤/招聘/绩效 → 后五张。
> 前四张是**主数据**，后五张全部靠"**人 + 时间 + 组织**"三个键挂上去。

---

## 2. 字段定义

### 2.1 `HR_ORG` 组织

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| ID | int IDENTITY | 否 | 主键 |
| OrgCode | varchar(20) | 否 | 组织编码（**字符型**，故意长短不一） |
| OrgName | nvarchar(100) | 否 | 组织名称 |
| ParentID | int | 是 | 上级组织 ID（自关联，顶级为 NULL） |
| OrgLevel | int | 否 | 层级（1 公司 / 2 厂·中心 / 3 部门 / 4 班组） |
| OrgTypeCode | varchar(20) | 是 | 组织类型 → `HR_DICT` 的 `ORG_TYPE` |
| ManagerEmpNo | varchar(20) | 是 | 负责人工号 |
| CostCenter | varchar(20) | 是 | 成本中心 |
| ValidFrom | date | 否 | 生效日 |
| ValidTo | date | 是 | 失效日（NULL = 至今；恰有 2 条为已失效） |
| IsActive | int | 是 | 状态（**故意混用 1 / 0 / NULL**） |
| Remark | nvarchar(200) | 是 | 说明（2 行非空，其中一行照真实习惯写：**"组织主数据，新增组织需走审批流程"**） |

### 2.2 `HR_JOB` 岗位标准

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| JobCode | varchar(20) | 否 | 主键，岗位编码 |
| JobName | nvarchar(50) | 否 | 岗位名称（**埋坑：大小写不一致**） |
| JobFamilyCode | varchar(20) | 是 | 职族 → `HR_DICT` 的 `JOB_FAMILY`（技术/职能/管理/操作） |
| JobLevelCode | varchar(20) | 是 | 职级 → `HR_DICT` 的 `JOB_LEVEL`（P1–P6 / M1–M4） |
| IsActive | int | 是 | 状态 |

### 2.3 `HR_POSITION` 组织岗位与编制

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| PositionCode | varchar(20) | 否 | 主键，岗位实例编码 |
| OrgID | int | 否 | 所属组织 → `HR_ORG` |
| JobCode | varchar(20) | 否 | 岗位标准 → `HR_JOB` |
| HeadCountPlan | int | 否 | **编制数** |
| ValidFrom | date | 否 | 生效日 |
| ValidTo | date | 是 | 失效日 |
| IsActive | int | 是 | 状态 |

> **实配人数不存字段**，由 `V_ORG_HEADCOUNT` 从 `HR_ASSIGNMENT` 现算——这是刻意的：**编制是"计划"，实配是"结果"，结果不该被冗余存储**。
> 60 行中：25 个岗位超编（例：某岗位编制 3 人、基准日实配 5 人）；9 个岗位零实配；2 个岗位挂在已停用组织下（历史遗留）（实测，依据 `docs/caliber-ruling-v1.md` 裁定 5）。

### 2.4 `HR_EMPLOYEE` 员工（花名册）

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| EmpNo | varchar(20) | 否 | 主键，工号（**字符型，长度不一**） |
| EmpName | nvarchar(50) | 否 | 姓名（**埋坑：两个同名"张伟"**） |
| GenderCode | varchar(10) | 是 | 性别 → 字典 |
| BirthDate | date | 是 | 出生日期（**埋坑：恰有 3 条为 NULL**） |
| EducationCode | varchar(20) | 是 | 学历 → 字典 |
| SchoolName | nvarchar(100) | 是 | 毕业院校 |
| MajorName | nvarchar(100) | 是 | 专业 |
| HireDate | date | 否 | 入职日期 |
| TermDate | date | 是 | 离职日期（NULL = 在职） |
| EmpTypeCode | varchar(20) | 是 | 雇佣类型 → 字典（正式/实习/外包/派遣） |
| Mobile | varchar(20) | 是 | 手机号（**假数据**，30 条为 NULL） |
| IsActive | int | 是 | 状态（混用 1/0/NULL） |

> **刻意不存的字段**：`当前部门` / `当前岗位` / `在职状态`。
> 这三样都必须从 `HR_ASSIGNMENT` 按时间算出来。**冗余存储是 HRIS 报表口径打架的第一大来源**——所以练习库从设计上就逼你走正规路径。

### 2.5 `HR_ASSIGNMENT` 任职记录 ★

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| ID | int IDENTITY | 否 | 主键 |
| EmpNo | varchar(20) | 否 | 员工 → `HR_EMPLOYEE` |
| OrgID | int | 否 | 组织 → `HR_ORG` |
| PositionCode | varchar(20) | 是 | 岗位实例 → `HR_POSITION` |
| JobCode | varchar(20) | 是 | 岗位标准 → `HR_JOB` |
| AssignmentTypeCode | varchar(20) | 是 | 任职类型 → 字典（主职/兼岗/借调/代理） |
| IsPrimary | int | 是 | 是否主职（1/0） |
| ActionCode | varchar(20) | 是 | 异动类型 → 字典（入职/转正/调动/晋升/离职） |
| StartDate | date | 否 | 起始日 |
| EndDate | date | 是 | 结束日（NULL = 至今） |

> **这张表是整套模型的枢纽**。所有人的问题"他现在在哪个部门、什么岗位"，答案都在这里，而且**必须带时间条件**。一人可有多段（调动、晋升、兼岗），**不加时间过滤就会数重**。
> 共 243 段：157 人各 1 段 + 43 人各 2 段；其中兼岗段（`IsPrimary=0`）13 段（实测，依据 `docs/caliber-ruling-v1.md` 裁定 5）。

### 2.6 `HR_SALARY` 薪酬（按月）

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| ID | int IDENTITY | 否 | 主键 |
| EmpNo | varchar(20) | 否 | 工号 |
| SalaryMonth | char(6) | 否 | 薪酬期间 `YYYYMM` |
| BaseSalary | decimal(12,2) | 否 | 基本工资 |
| PerfBonus | decimal(12,2) | 是 | 绩效奖金 |
| Allowance | decimal(12,2) | 是 | 津贴 |
| OvertimePay | decimal(12,2) | 是 | 加班费 |
| GrossPay | decimal(12,2) | 否 | 应发合计 |
| Deduction | decimal(12,2) | 是 | 扣款（**埋坑：NULL 与 0 混用**） |
| NetPay | decimal(12,2) | 否 | 实发 |
| CurrencyCode | varchar(10) | 否 | 币种 → 字典（**埋坑：海外组织为 USD/INR，直接 SUM 会错**；币种按人固定，同一个人不逐月跳币种） |

### 2.7 `HR_ATTENDANCE` 考勤（按月）

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| ID | int IDENTITY | 否 | 主键 |
| EmpNo | varchar(20) | 否 | 工号 |
| AttMonth | char(6) | 否 | 考勤期间 `YYYYMM` |
| WorkDays | decimal(5,1) | 否 | 应出勤天数 |
| ActualDays | decimal(5,1) | 否 | 实出勤天数 |
| LeaveDays | decimal(5,1) | 是 | 请假天数（NULL = 无请假） |
| OvertimeHours | decimal(6,1) | 是 | 加班小时 |
| AbsentDays | decimal(5,1) | 是 | 缺勤天数 |
| LateCount | int | 是 | 迟到次数 |

### 2.8 `HR_RECRUIT_REQ` 招聘需求

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| ReqNo | varchar(20) | 否 | 主键，需求编号 |
| OrgID | int | 否 | 需求组织 → `HR_ORG` |
| JobCode | varchar(20) | 否 | 需求岗位 → `HR_JOB` |
| HeadCount | int | 否 | 需求人数 |
| PriorityCode | varchar(20) | 是 | 紧急度 → 字典 |
| StatusCode | varchar(20) | 否 | 状态 → 字典（待审批/进行中/已暂停/已关闭） |
| OpenDate | date | 否 | 开启日 |
| CloseDate | date | 是 | 关闭日（NULL = 仍开启） |
| OwnerEmpNo | varchar(20) | 是 | 负责 HR |

> 状态分布：待审批 4 / 进行中 12 / 已暂停 3 / 已关闭 11。`CloseDate` 为 NULL 的共 19 条——其中 1 条状态是"已关闭"却没有关闭日（脏数据）。

### 2.9 `HR_CANDIDATE` 候选人

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| CandNo | varchar(20) | 否 | 主键，候选人编号 |
| ReqNo | varchar(20) | 否 | 关联需求 → `HR_RECRUIT_REQ` |
| CandName | nvarchar(50) | 否 | 姓名（**假名**） |
| SourceCode | varchar(20) | 是 | 来源渠道 → 字典（内推/招聘网站/猎头/校招） |
| StageCode | varchar(20) | 是 | 当前阶段 → 字典（简历筛选/初试/复试/Offer/入职/淘汰） |
| ApplyDate | date | 否 | 投递日 |
| OfferDate | date | 是 | Offer 日 |
| HireDate | date | 是 | 入职日（NULL = 未入职） |
| ExpectedSalary | decimal(12,2) | 是 | 期望薪资 |
| ResultCode | varchar(20) | 是 | 结果 → 字典（录用/淘汰/放弃/流程中） |

> 其中 `REQ250001` ~ `REQ250003` 三个需求零候选人（"有需求、没人投"的典型口径题）。

### 2.10 `HR_PERFORMANCE` 绩效

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| ID | int IDENTITY | 否 | 主键 |
| EmpNo | varchar(20) | 否 | 工号 |
| PeriodCode | varchar(10) | 否 | 考核周期 → 字典（`2025H2` / `2026H1`） |
| ScoreValue | decimal(5,2) | 是 | 分数（**埋坑：34 条为 NULL，非全员都评**） |
| GradeCode | varchar(10) | 是 | 等级 → 字典（S/A/B/C/D），**严格由分数推导**（≥95 S / ≥90 A / ≥80 B / ≥70 C / <70 D） |
| RankInOrg | int | 是 | 同一考核期、同一"当期所属组织"内按分数降序的 1..N 排名；未参评者为 NULL |
| EvaluatorEmpNo | varchar(20) | 是 | 评估人工号 |
| IsFinal | int | 否 | 是否终评（1/0） |

> 315 行 = 2025H2 的 149 行 + 2026H1 的 166 行。未参评 34 条（8 名在职者从未参加 + 入职不足 90 天者）。

### 2.11 `HR_DICT` 字典（码值表）

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| ID | int IDENTITY | 否 | 主键 |
| DictType | varchar(30) | 否 | 字典类型（ORG_TYPE / GENDER / EDUCATION …） |
| Code | varchar(20) | 否 | 码值 |
| Title | nvarchar(50) | 否 | 显示名称 |
| SortNo | int | 是 | 排序号（**埋坑：大量为 NULL**） |
| IsDisabled | int | 是 | 状态（**故意混用 1 / 0 / NULL，照真实世界的乱**） |
| Remark | nvarchar(200) | 是 | 说明 |

> 这张表就是"界面把代码翻译成中文"的数据源头。练习库里的组织类型、学历、职族、币种……全部走它（17 类共 73 行）。

---

## 3. 表间关系

```
HR_ORG ──┐(ParentID 自关联)
         ├──< HR_POSITION >── HR_JOB
         │
         ├──< HR_RECRUIT_REQ >── HR_JOB
         │            └──< HR_CANDIDATE
         │
HR_EMPLOYEE ──< HR_ASSIGNMENT >── HR_ORG / HR_POSITION / HR_JOB
   │
   ├──< HR_SALARY
   ├──< HR_ATTENDANCE
   └──< HR_PERFORMANCE

HR_DICT  ←── 以上各表的 *Code 字段（按 DictType 关联）
```

**三层结构（读表顺序）**：

1. **主数据层**：组织 / 岗位标准 / 组织岗位 / 员工
2. **关系层**：任职记录（把人和组织、岗位按时间连起来）
3. **事实层**：薪酬 / 考勤 / 招聘 / 绩效（上面都写"人 + 时间"）
4. **字典层**：横向翻译所有 `*Code`

---

## 4. 造数规则

- 时点：`2026-06-30`；数据范围：`2025-07-01` ~ `2026-06-30`（整 12 个月）
- 生成方式：`gen_seed.py`，固定随机种子 `20261009` —— 任何人重跑都得到完全相同的 `seed.sql`
- 组织：1 公司 → 4 厂/中心 → 12 部门 → 23 班组，共 40 行；**层级 4 层**
- 员工：200 人，其中在职 170、离职 30
- 任职：243 段；**43 人有多段任职**（157 人各 1 段 + 43 人各 2 段；兼岗段 `IsPrimary=0` 13 段）——保证"时间维度"是硬需求而不是摆设（实测，依据 `docs/caliber-ruling-v1.md` 裁定 5）
- 薪酬/考勤：覆盖 `202507` ~ `202606`，各 1868 行；**每月人数不等**（约 150 ~ 170，随入职离职变化）
- 招聘：30 个需求（待审批 4 / 进行中 12 / 已暂停 3 / 已关闭 11）；120 名候选人，其中 3 个需求零候选人
- 绩效：2 个周期（`2025H2` / `2026H1`），共 315 行，34 条未参评

---

## 5. 故意埋的坑（★ 教学价值所在）

**干净的练习库练不出真本事。** 下面 10 个坑是刻意设计的，每一题都会踩到其中一个：

| # | 坑 | 表现 |
|---|---|---|
| 1 | 空值 | `Mobile` 30 条 NULL；`ScoreValue` 34 条 NULL（非全员有值） |
| 2 | NULL vs 0 vs 空串 | `IsActive`、`Deduction`（NULL 约 20% + 显式 0 约 10%）三者混用 |
| 3 | 字符型数字 | `OrgCode`、`EmpNo` 是 varchar 且长度不一 → `'10' < '9'` |
| 4 | 日期边界 | 30 名离职者中 26 人的 `TermDate` 落在月中，其离职当月薪酬与考勤仍在（离职当月照发薪） |
| 5 | 同名不同人 | 两个"张伟"，`EmpNo` 不同 |
| 6 | 大小写/空格不一致 | `JobName` 里 `HRBP` 与 `hrbp`；`Title` 有 3 条带尾空格 |
| 7 | 一人多段任职 | 43 人有 2 段及以上 → 不加时间过滤就数重（实测，依据 `docs/caliber-ruling-v1.md` 裁定 5） |
| 8 | 编制与实配不符 | 某岗位编制 3 人、实配 5 人（超编），全库共 25 个超编岗位；另有 9 个零实配岗位（实测，依据 `docs/caliber-ruling-v1.md` 裁定 5） |
| 9 | 孤儿数据 | 1 条任职记录指向已停用组织（模拟历史遗留） |
| 10 | 币种不一致 | 海外组织 7 名员工共 60 条薪酬为 USD/INR，直接 `SUM` 会错（实测，依据 `docs/caliber-ruling-v1.md` 裁定 5） |

---

## 6. v1 题库（33 题）考点地图

> 题干与参考 SQL 见 `data/questions.json`；本表不含手写表名——「用到的表」由 `src/tables.js` 的 `questionTables()` 从每题参考 SQL 现算（按首次出现顺序、以 ` + ` 连接）。
> 语法约定：**避开** `CONVERT`、`PIVOT/UNPIVOT`、`MERGE`、`TOP n PERCENT`、存储过程/触发器/游标（工程侧转译层覆盖不到）。

| 题号(seq) | id | 考点(knowledge_point) | 用到的表 |
|---|---|---|---|
| 1 | q001 | 单表筛选 + NULL 判断 | HR_EMPLOYEE |
| 2 | q002 | WHERE 多条件 + AND / OR 优先级 | HR_EMPLOYEE |
| 3 | q003 | ORDER BY 多键排序（字符型数字陷阱） | HR_ORG |
| 4 | q004 | BETWEEN / 日期区间 | HR_EMPLOYEE |
| 5 | q005 | IN / NOT IN 与 NULL 陷阱 | HR_EMPLOYEE |
| 6 | q006 | COUNT(*) 与 COUNT(列) 的差异 | HR_EMPLOYEE |
| 7 | q007 | 分组 + HAVING 找重复（一人多段任职） | HR_ASSIGNMENT + HR_EMPLOYEE |
| 8 | q008 | 多表 JOIN + 分组聚合（当前主职口径） | HR_ASSIGNMENT + HR_ORG + HR_EMPLOYEE |
| 9 | q009 | 数据质量排查（日期异常） | HR_ASSIGNMENT + HR_EMPLOYEE + HR_ORG |
| 10 | q010 | GROUP BY + SUM | HR_SALARY |
| 11 | q011 | GROUP BY + HAVING | HR_ATTENDANCE |
| 12 | q012 | AVG + 四舍五入 + NULL 影响 | HR_PERFORMANCE |
| 13 | q013 | 某时点在职口径（时间区间去重） | V_EMP_ASSIGNMENT |
| 14 | q014 | LEFT JOIN / NOT EXISTS 找“没有 XX 的人” | HR_EMPLOYEE + HR_PERFORMANCE |
| 15 | q015 | JOIN 字典表做代码翻译（码值表尾空格陷阱） | HR_ORG + HR_DICT |
| 16 | q016 | 标量子查询（与聚合结果比较） | HR_SALARY |
| 17 | q017 | 相关子查询 / NOT EXISTS | HR_RECRUIT_REQ + HR_CANDIDATE |
| 18 | q018 | ROW_NUMBER() 取每组第一条 | HR_SALARY |
| 19 | q019 | 聚合 + JOIN 求编制 vs 实配（视图） | V_ORG_HEADCOUNT |
| 20 | q020 | 递归 CTE / 组织树（视图 V_ORG_TREE） | V_ORG_TREE |
| 21 | q021 | 多列分组（GROUP BY 多列） | HR_EMPLOYEE |
| 22 | q022 | 条件聚合 SUM(CASE WHEN …) | HR_EMPLOYEE |
| 23 | q023 | LEFT JOIN + 空组补 0（NULL 陷阱） | HR_ORG + HR_ASSIGNMENT |
| 24 | q024 | COUNT(*) 与 COUNT(DISTINCT) 的差异（去重计数） | HR_ASSIGNMENT |
| 25 | q025 | 占比计算 + 整数除法陷阱 | HR_EMPLOYEE |
| 26 | q026 | 分组 + 排序 + 取前 N | HR_SALARY |
| 27 | q027 | 分组小计与总计对比（占比） | HR_ORG |
| 28 | q028 | 多维汇总（按岗位族 × 职级多列分组） | HR_ASSIGNMENT + HR_JOB |
| 29 | q029 | 分档计数 + NULL 作为独立分组 | HR_PERFORMANCE |
| 30 | q030 | 口径陷阱：跨币种直接 AVG | HR_SALARY |
| 31 | q031 | 口径陷阱：比率的简单平均 vs 天数加权 | HR_ATTENDANCE |
| 32 | q032 | 口径陷阱：NULL 与 0 的计数差异 | HR_ATTENDANCE |
| 33 | q033 | CASE WHEN 分桶聚合 | HR_SALARY |

## 7. 交给工程侧的三个提醒

1. **数据只能来自 `seed.sql`**，不得随机生成——预期结果绑定在具体数据上。
2. `schema.sql` 与 `seed.sql` 用 **SQL Server 语法**写；网页端（SQLite）为派生物。
3. 判题**比对结果集，不比对 SQL 文本**；口径按已确认的七条执行。
