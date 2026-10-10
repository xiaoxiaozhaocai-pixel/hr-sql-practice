# HR 语境 SQL 练习平台 · 题目 JSON 契约 v1

- 版本：v1（2026-10-09）
- 提出方：本线（业务侧）
- 状态：**本线提案**，工程侧可提修改意见；未确认前本线按本契约产出题库
- 权威源：`schema.sql` / `seed.sql`（SQL Server 语法）。网页端 SQLite 版是**派生物**，冲突时以 SQL Server 版为准
- 基准日：`2026-06-30`（全库禁用 `GETDATE()`）；数据范围 2025-07-01 ~ 2026-06-30

---

## 1. 三个消费方

| 消费方 | 用途 |
| --- | --- |
| 网页端（练习台） | 加载题库渲染题目、取参考 SQL 算预期结果、按第 5 节口径判题 |
| 题库维护（本线） | 新增／修订题目，字段只增不改义 |
| 工程侧（小职线） | 判题引擎、题库导入、扩展功能（错题本、进度统计等） |

## 2. 顶层结构

```json
{
  "schema_version": "1.0",
  "db": {
    "dialect": "sqlite",
    "baseline_date": "2026-06-30",
    "source": ["schema_sqlite.sql", "seed_sqlite.sql"]
  },
  "questions": [
    { "id": "q001", "...": "见第 3 节" }
  ]
}
```

- 用 `questions` 包一层而不是直接给数组，便于后续加 `db`、`meta`、`packs` 等字段。
- 消费端**必须忽略未知字段**：加字段不算破坏兼容。

## 3. 题目字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | ✔ | 唯一，形如 `q001`；**发布后不复用、不改语义** |
| `seq` | int | ✔ | 展示序号（1 起），允许与 id 顺序不一致 |
| `title` | string | ✔ | 一句话标题，列表里显示 |
| `subject` | string | ✔ | 业务域：`组织` / `员工` / `薪酬` / `考勤` / `招聘` / `绩效` / `综合` |
| `level` | int | ✔ | 1–4（L1 单表筛选 → L2 多表连接/聚合 → L3 子查询/窗口/递归 → L4 项目侧综合口径） |
| `knowledge_point` | string | ✔ | 主考点，如 `GROUP BY`、`LEFT JOIN 保持主表`、`时间区间任职去重` |
| `secondary_points` | string[] | — | 次要考点 |
| `stem` | string | ✔ | 业务背景＋现象，说明"为什么业务要看这个" |
| `requirement` | string | ✔ | 明确任务，口径必须无歧义 |
| `output_hint` | string | ✔ | 输出要求：要哪些列、是否排序、口径提示 |
| `hint` | string | — | 渐进提示（**不得含答案写法**） |
| `reference_sql` | string | ✔ | 参考答案，**SQL Server 语法**（权威写法） |
| `reference_sql_sqlite` | string | — | SQLite 可直接执行的等价写法；与上文相同则省略 |
| `expected` | object | ✔ | 见第 4 节 |
| `pitfalls` | string[] | ✔ | 坑位（至少 1 条），写清"错在哪、为什么错" |
| `forbidden_syntax` | string[] | — | 本题禁用语法（见第 6 节） |
| `dialect_note` | string | — | 本题需提醒的 SQL Server ↔ SQLite 差异 |
| `tags` | string[] | — | 检索用 |
| `status` | string | — | `draft` / `ready` / `retired`，默认 `ready` |
| `version` | string | — | 题目自身修订号，如 `1.1` |
| `updated_at` | string | — | `YYYY-MM-DD` |

## 4. `expected` 结构 与 预期结果的来源（**请工程侧确认**）

两种取预期结果的做法：

- **方案 A（本线推荐，默认）**：不把结果写死。判题时在同一题库实例上跑 `reference_sql_sqlite`（缺省时用 `reference_sql` 的 SQLite 等价写法）得到预期结果集，再与用户结果按第 5 节口径比对。**优点：数据改过也不会判错**。
- **方案 B**：把预期结果固化在 `expected.rows` / `content_hash`，不依赖参考 SQL 执行。用于参考 SQL 不便客户端执行、或需要冻结答案的场景。

本线建议 **A 为主 + B 对账**：启动时用参考 SQL 算出结果，与 `expected.row_count` / `columns` / `content_hash` 对账；不一致就在题目上打「题库待复核」标记，提示本线修题，而不是直接判用户错。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `columns` | string[] | ✔ | 预期列名（按参考 SQL 顺序给出，**仅供展示与对账**，判题不依赖列序；**列数必须一致；列名不比对**，依据 `docs/caliber-ruling-v1.md` 裁定 6） |
| `row_count` | int \| null | ✔ | 预期行数；`null` = 尚未固化，此时期望结果以方案 A 现场跑为准 |
| `rows` | array \| null | — | 展示用样本，**最多前 50 行**，不参与判题计算 |
| `content_hash` | string | — | 预期结果集按第 5 节归一化后的 sha256，用于 B 方案判题与 A/B 对账 |
| `order_sensitive` | bool | — | 默认 `false`；`true` 表示**逐行比对**（行序算分）。取值口径见下方「行序口径」 |

### 行序口径（2026-10-10 口径对齐，权威源：HRIS《修订说明_行序口径对齐_20261010》）

- **判定规则**：**题面（`requirement`）或输出提示（`output_hint`）写明排序**——出现「排序 / 升序 / 降序 / 顺序排列 / 按时点升序 / 依次 / 按 ① ② ③ 的顺序」等表述——即置 `order_sensitive = true`，判题逐行比对；其余置 `false`，行集合比对。
- **当前分布**：120 题中 **94 题逐行判**、26 题集合比对（v1 14 / 批1 10 / 批2 10 / 批3 15 / 批4 10 / 批5 16 / 批6 19 = 94）。
- **不变式（平台侧守门，`test/display.test.mjs`）**：
  1. `order_sensitive = true` ⟹ 题面或输出提示必含行序表述（防「判得比说的严」：内容对、顺序错被判错却事先无提示）；
  2. `order_sensitive = false` ⟹ 输出提示不得含行序表述（防「说的比判的严」：提示要求排序却不判）。
  违反任一条即测试红，禁止入库。
- **参考写法**：凡 `order_sensitive = true` 的题，参考 SQL 必须自带 `ORDER BY`（多结果块拼接用排序键列钉住顺序），`npm run verify` 会逐题断言。

## 5. 归一化与比对口径（判题引擎实现依据）

1. **比的是结果集，绝不比对 SQL 文本。**
2. **列数必须一致；列名不比对**（列名比较仅用于展示与对账；列顺序不敏感），依据 `docs/caliber-ruling-v1.md` 裁定 6。
3. **行顺序**：`order_sensitive = false` 时行顺序不敏感，行按**多重集**比较（重复行数量也要一致）；`order_sensitive = true` 时**逐行比对**（行序算分，见第 4 节「行序口径」）。
4. 数值：**四舍五入到小数点后 2 位**后比较；`1` 与 `1.00` 视为相等。
5. `NULL = NULL` 视为相等；`NULL` 与 `0`、`NULL` 与空串必须判为**不相等**。
6. 字符串：大小写不敏感、忽略首尾空格。
7. 整型 `1` / `0` 按数值处理（SQLite 中布尔即以 INTEGER 存储）。
8. 日期：按 ISO 文本 `YYYY-MM-DD` 直接比较（SQLite 日期即文本），**不要**转时间戳再比。

判题结论要能给人看：通过 / 不通过 ＋ 具体差异（列数不一致时给出列数差异提示；行集合不一致给差异行样例，最多 10 行）。

## 6. 题库与库的约定

- 库结构：`HR_DICT`、`HR_ORG`、`HR_JOB`、`HR_EMPLOYEE`、`HR_POSITION`、`HR_ASSIGNMENT`、`HR_SALARY`、`HR_ATTENDANCE`、`HR_RECRUIT_REQ`、`HR_CANDIDATE`、`HR_PERFORMANCE`；视图 `V_ORG_TREE`、`V_EMP_ASSIGNMENT`、`V_ORG_HEADCOUNT`。
- **v1 前 20 题**禁用语法（写进 `forbidden_syntax`）：`CONVERT`、`PIVOT` / `UNPIVOT`、`MERGE`、`TOP n PERCENT`、存储过程 / 触发器 / 游标、临时表 `#temp`、`GO` 批处理。
- **v1 前 20 题**的 `level` 分布建议：L1 五题、L2 七题、L3 六题、L4 两题；视图只在 q13 之后出现。
- 题目数据全部虚构：不得出现任何真实单位、库名、表名、字段名、组织名、人名。

## 7. 版本与兼容

- `schema_version` 用 `主.次`：字段只增不改义升次号；删字段或改义升主号。
- 消费端对可选字段必须有默认值；缺 `reference_sql` 时禁用「查看答案」。
- 修订题目只改内容并升 `version`，**id 不变**。

## 8. 示例（可直接作为 q001）

```json
{
  "id": "q001",
  "seq": 1,
  "title": "现在还有多少人在职",
  "subject": "员工",
  "level": 1,
  "knowledge_point": "单表筛选 + NULL 判断",
  "stem": "老板问「现在总部还有多少人」，你发现花名册里有离职日期这一列，很多行是空的。",
  "requirement": "统计当前在职员工总数。口径：离职日期为空的视为在职。",
  "output_hint": "输出一列「在职人数」。",
  "hint": "注意区分「离职日期为空」和「离职日期为某个具体日期」。",
  "reference_sql": "SELECT COUNT(*) AS 在职人数\nFROM dbo.HR_EMPLOYEE\nWHERE TermDate IS NULL;",
  "reference_sql_sqlite": "SELECT COUNT(*) AS 在职人数\nFROM HR_EMPLOYEE\nWHERE TermDate IS NULL;",
  "expected": {
    "columns": ["在职人数"],
    "row_count": null,
    "rows": null,
    "order_sensitive": false
  },
  "pitfalls": [
    "用 TermDate = '' 或 TermDate IS NULL 混用会导致计数错误——空字符串在 SQLite 里不等于 NULL",
    "误用 IsActive = 1 当在职：IsActive 是 1/0/NULL 混用的脏字段，不代表在职"
  ],
  "forbidden_syntax": [],
  "tags": ["NULL", "COUNT"]
}
```

> 说明：`row_count: null` 表示尚未固化，灌库后由脚本回填；`reference_sql` 保留 SQL Server 写法（`dbo.` 前缀），`reference_sql_sqlite` 才是网页端可直接跑的写法。
