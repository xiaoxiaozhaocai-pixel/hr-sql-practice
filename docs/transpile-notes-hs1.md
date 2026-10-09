# SQL Server → SQLite 转译说明（HS1）

- 权威源：`in/schema_mssql.sql`、`in/seed_mssql.sql`（只读，未改动）
- 产物：`out/schema_sqlite.sql`、`out/seed_sqlite.sql`、`out/rowcount_expected.json`
- 生成器：`out/run_check.mjs`（单进程 node，无 npm 依赖，可重复生成）
- 目标引擎：SQLite 3.35+；实测 3.45.3（Python 3.12.4 内置 `sqlite3`）
- 基准日：`2026-06-30`（源脚本已写死，未出现 `GETDATE()` 调用）

---

## 1. 已按任务规则执行的转译

| # | 规则 | 命中次数 | 结果 |
|---|---|---:|---|
| 1 | `dbo.` 前缀（表 / 视图 / 引用） | 全部 | 去掉 |
| 2 | `IDENTITY(1,1)` → `INTEGER PRIMARY KEY AUTOINCREMENT` | 6 | 已转 |
| 3 | `int`/`bigint`/`smallint`/`tinyint` → `INTEGER` | — | 已转（源中仅 `int`） |
| 4 | `varchar(n)`/`nvarchar(n)`/`char(n)`/`nchar(n)` → `TEXT` | `NVARCHAR` 11 次 + `varchar`/`char` | 已转 |
| 5 | `decimal(p,s)`/`numeric(p,s)`/`money`/`float` → `NUMERIC` | 源中仅 `decimal` | 已转 |
| 6 | `bit` → `INTEGER` | 0 | 未出现 |
| 7 | `datetime`/`date`/`datetime2` → `TEXT` | `date` | 已转 |
| 8 | `ISNULL(a,b)` → `IFNULL(a,b)` | 2 | 已转 |
| 9 | `N'...'` 前缀去掉 | 全库字面量前缀 | 已去（字符串内容逐字保留） |
| 10 | `GETDATE()` → `'2026-06-30'` | **0（调用）** | 规则已备，未触发；`GETDATE` 字样仅出现在源注释里，注释已剥离 |
| 11 | `GO` 批处理分隔符 | 全部 | 删整行 |
| 12 | SECTION 0（`DB_ID` / `CREATE DATABASE` / `USE`） | 1 段 | 整段删除 |
| 13 | `DROP TABLE IF EXISTS dbo.X` → `DROP TABLE IF EXISTS X` | 11 | 已转（SQLite 3.35+ 支持，3.45.3 实测通过） |
| 14 | `DROP VIEW IF EXISTS dbo.X` → `DROP VIEW IF EXISTS X` | 3 | 已转 |

### 额外必查项（自复核，非主控预扫口径）

在 schema + seed 全文（大小写不敏感正则）扫描，**均为 0 次**：
`TOP n`、`DATEADD`、`DATEDIFF`、`CONVERT(`、`STRING_AGG`、`PIVOT`、`UNPIVOT`、`MERGE`、
`WITH SCHEMABINDING`、`sp_` 前缀、`#temp`、`SELECT ... INTO`、`COLLATE`、`RAISERROR`。
→ 与主控预扫一致；主控未列的 `DBCC`(6) / `SET NOCOUNT ON`(1) 也已在 seed 中清除（见 §2.5）。

---

## 2. 规则未覆盖 / 有损的项（逐条必须知悉）

### 2.1 `WITH OrgTree` → `WITH RECURSIVE OrgTree`（V_ORG_TREE）
SQL Server 的递归 CTE 写 `WITH name AS`；SQLite 必须显式 `WITH RECURSIVE`。
不改则视图报 `no such table: OrgTree`。已定向改写，仅这一处。

### 2.2 字符串拼接 `+` → `||`（V_ORG_TREE）
SQL Server 用 `+` 连接字符串；SQLite 的 `+` 做数值加，`'a' + 'b'` 得 `0`。
源表达式 `CAST(p.OrgPath + N' / ' + c.OrgName AS nvarchar(400))` 已改为
`CAST(p.OrgPath || ' / ' || c.OrgName AS TEXT)`。
**若漏改，视图能建但结果是错的（数字 0），不会报错**——属静默错误，已由 `V_ORG_TREE` 行数=40 且路径可读验证。

### 2.3 主键重复（IDENTITY 列的表）
`IDENTITY(1,1)` 展开为列级 `INTEGER PRIMARY KEY AUTOINCREMENT` 后，与源里同时存在的表级
`CONSTRAINT PK_x PRIMARY KEY (ID)` 冲突。SQLite 直接报
`table "x" has more than one primary key`（已实测）。因此**删除这 6 张表的表级 PK(ID) 约束**
（HR_DICT / HR_ORG / HR_ASSIGNMENT / HR_SALARY / HR_ATTENDANCE / HR_PERFORMANCE），
主键语义完整保留在列级。非 IDENTITY 表的表级主键（HR_JOB / HR_EMPLOYEE / HR_POSITION /
HR_RECRUIT_REQ / HR_CANDIDATE）原样保留。

### 2.4 注释整体剥离（有损，但只损失注释）
源脚本的中文注释、章节标题、（`seed` 末尾的体检 SQL 注释块）全部删除。原因有两条：
① 保持产物干净、避免 §5 残留扫描把注释里的 `GETDATE` / `NVARCHAR` / `dbo.` 误计为残留；
② 注释里的 `dbo.` 若保留，残留数不可能为 0。
**未丢失任何可执行语义。**

### 2.5 `DBCC CHECKIDENT(...) WITH NO_INFOMSGS`（6 条）与 `SET NOCOUNT ON` / `USE` 删除
SQLite 无对应语句。`DBCC CHECKIDENT(..., RESEED, 0)` 的语义是「下次插入 ID 从 1 开始」，
在**全新建库**路径下 SQLite 的 `AUTOINCREMENT` 首次插入天然从 1 起，效果等价。
⚠️ 差异点：**对已存在的库重跑 seed 时，SQLite 不会把自增计数器重置为 0**，
而 SQL Server 会。这会影响 `seed` 末尾 `UPDATE HR_ORG SET ManagerEmpNo=... WHERE ID=12..36`
（依赖 HR_ORG 的 ID 恰为 1..40）。**验收请务必在新建的空库上跑**。

### 2.6 ⚠️ 强制偏离：`PRAGMA ignore_check_constraints`（源数据缺陷，非方言问题）
**权威源 seed 本身有 3 行违反源 schema 自己的 CHECK 约束** `CK_HR_ASSIGNMENT_DateOrder`
（`EndDate IS NULL OR EndDate >= StartDate`）：

| 源 seed 行号 | EmpNo | StartDate | EndDate | 问题 |
|---:|---|---|---|---|
| 530 | 10055 | 2026-05-25 | 2026-02-27 | End < Start |
| 669 | 10158 | 2026-05-25 | 2026-04-14 | End < Start |
| 681 | 10169 | 2026-03-23 | 2026-01-15 | End < Start |

这 3 行在 SQL Server 上执行同样会被 CHECK 拒绝（不是转译引入的）。另一条 CHECK
`CK_HR_EMPLOYEE_TermDate` 违规 0 行。

处理方式（取舍已显式化）：
- **schema 原样保留两条 CHECK 约束**（SQLite 支持 CHECK，不应因数据脏而删约束）；
- 只在 `seed_sqlite.sql` 里，把那 **2 条 `INSERT INTO HR_ASSIGNMENT`** 语句用
  `PRAGMA ignore_check_constraints = ON;` … `= OFF;` 包住，使这 3 行能被灌入、
  行数与权威源**逐字一致（243）**；
- 该 PRAGMA 在产物内联了注释说明，范围严格限定在 HR_ASSIGNMENT 的两条 INSERT，其余语句照常受约束。

**未做的事**：没有改动那 3 行的值，没有删 CHECK，没有动 `in/`。
请上游确认这三行是「刻意埋的脏数据（若是，需同步修源 schema 的 CHECK）」还是「造数 bug」。

### 2.7 `date` 变 `TEXT` 的比较语义
源为 `date` 类型，`TEXT` 下 `'YYYY-MM-DD'` 的字典序等于时间序，所以视图/查询里的
`StartDate <= '2026-06-30'`、`EndDate >= StartDate` 等比较**语义等价**（前提：日期一律 ISO 定长格式，源自数据满足）。

### 2.8 `decimal` 变 `NUMERIC` 的精度
SQLite 的 `NUMERIC` 是动态类型，浮点表示可能与 SQL Server `decimal(12,2)` 的精确十进制在
极端小数上有末位差异。行数对账不受影响；若练习答案涉及金额精确比较（如 `= 18682.09`），请上游确认口径。

### 2.9 §5 残留扫描的种子侧 286 次 `N'` 属**误报**（必须说明）
`node -e` 里的种子正则 `/dbo\.|N'|.../` 会把**以字母 N 结尾的字符串字面量收尾**当成 `N` 前缀残留，
例如 `'EDUCATION'`（N + 收尾引号）、`'INTERN'`、`'MAIN'`，共 286 处，**全部是数据**。
`run_check.mjs` 增加了「先剥掉字符串内容再扫」的口径：**字符串外真实残留 = 0**，
schema 侧原始扫描 = 0。这条已用状态机验证，不是靠眼看。

### 2.10 ID / 自增依赖插入顺序
6 张 IDENTITY 表未显式插入 ID，依赖 SQLite 按插入顺序分配 1..N（与 SQL Server `IDENTITY(1,1)` 同序）。
因此 `HR_ORG` 的 ID 为 1..40，`ParentID` 与 seed 末尾的 `UPDATE ... WHERE ID=12..36` 都能对上
（实测回填 20 行，与源里 20 条 UPDATE 一致）。

---

## 3. 做了什么验证（真实执行）

1. `node out/run_check.mjs`：转译 3 个产物 + 残留扫描 → 期望元组数 11 表合计 4842。
2. **真引擎执行**（Python 3.12 内置 `sqlite3` 3.45.3，单进程，非 npm）：
   在 `:memory:` 上依次 `executescript(schema_sqlite.sql)` + `executescript(seed_sqlite.sql)`，
   逐表 `COUNT(*)` **11/11 与 `rowcount_expected.json` 完全一致**；
   3 个视图均可 `SELECT`（V_ORG_HEADCOUNT 60 行 / V_EMP_ASSIGNMENT 243 行 / V_ORG_TREE 40 行，树深 4）；
   `PRAGMA foreign_key_check` 违规 0。
3. **交叉核对**：`in/model_notes.json` 的 `row_counts` 与 `rowcount_expected.json` **逐表一致（11/11）**。
   期望值由脚本解析 seed 得到，非手算。

> 注：任务卡 §5 写 `node run_check.mjs`，但 §2 要求该文件落在 `out\`。实际命令为
> `node out\run_check.mjs`（见汇报第 3 段待验收清单）。
