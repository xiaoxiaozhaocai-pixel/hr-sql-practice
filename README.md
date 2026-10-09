# HR 语境 SQL 练习台（单文件 HTML）

一个**完全离线、零后端、零依赖**的 SQL 练习台：把数据库结构、种子数据、20 道 HR 业务场景题目和判题引擎
全部打成一个 HTML 文件，双击即可做题。构建产物 `dist/hr-sql-practice.html` 不发起任何网络请求。

- 网页端执行引擎：**SQLite**（由内联的 sql.js 1.14.2 / WebAssembly 提供，WASM 以 base64 内联进 HTML）
- 权威写法：**SQL Server（T-SQL）**，题库里以 `reference_sql` 字段保留，**只展示、不执行**
- 基准日：写死 `2026-06-30`，全库不使用任何动态时间函数
- 题目全部虚构，不含任何真实单位、组织、系统或人名

---

## 1. 怎么用

### 直接做题（使用者）

1. 双击打开 `dist/hr-sql-practice.html`（Chrome / Edge / Firefox 任一新版浏览器）。
2. 左侧选一道题 → 在文本框写 SQL → 点「运行」看结果、点「判题」看结论。
3. 想不出来点「提示」；实在不会再点「查看答案」，会**同时**给出 SQL Server 权威写法与 SQLite 可跑写法。
4. 通过之后自动解锁该题的「易错点」与「方言提示」。
5. 进度（每题写的 SQL + 是否通过）存在浏览器 `localStorage`，刷新不丢；顶部「重置进度」清空。

> 首次打开需要初始化数据库（建表 + 灌 4842 行 + 11 表行数自检），通常 1~3 秒。自检不通过时页面顶部会红条提示。

### 构建（开发者）

```bash
node build.mjs
```

零依赖，不需要 `npm install`。产物：`dist/hr-sql-practice.html`。

### 跑判题引擎单测

```bash
node --test test/judge.test.mjs
```

用的是 node 原生 test runner，不引任何测试框架。

---

## 2. 目录结构

```
data/                      只读输入（不要改）
  schema_sqlite.sql        SQLite 建表 + 3 个视图
  seed_sqlite.sql          SQLite 插数（11 表 4842 行）
  rowcount_expected.json   11 表期望行数
  questions.json           20 题题库（唯一的题库来源）
docs/                      只读文档（题目契约、口径裁定、转译说明）
vendor/sqljs/              只读的 sql.js 发行文件
src/
  judge.js                 判题引擎（纯函数，node 可直接 import）
  db.js                    sql.js 加载 + 建库灌数 + 11 表自检
  app.js                   UI 逻辑
  index.html               模板（含占位符）
  style.css                样式
test/judge.test.mjs        判题引擎单测
build.mjs                  打包脚本（纯 fs，不 spawn 子进程）
dist/hr-sql-practice.html  构建产物（单文件）
```

---

## 3. 怎么加题

题库与逻辑完全分离：**所有题目都在 `data/questions.json`**，加题不需要改任何 JS。

顶层结构：

```json
{
  "schema_version": "1.0",
  "db": { "dialect": "sqlite", "baseline_date": "2026-06-30",
          "source": ["schema_sqlite.sql", "seed_sqlite.sql"] },
  "questions": [ { "id": "q001", "...": "..." } ]
}
```

题目字段（消费端**必须忽略未知字段**，加字段不算破坏兼容）：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | ✔ | 唯一，形如 `q001`；发布后不复用、不改语义 |
| `seq` | int | ✔ | 展示序号（1 起），可与 id 顺序不一致 |
| `title` | string | ✔ | 一句话标题，列表里显示 |
| `subject` | string | ✔ | 业务域：`组织`/`员工`/`薪酬`/`考勤`/`招聘`/`绩效`/`综合` |
| `level` | int | ✔ | 1–4（L1 单表 → L2 连接聚合 → L3 子查询/窗口 → L4 综合口径） |
| `knowledge_point` | string | ✔ | 主考点，如 `GROUP BY` |
| `secondary_points` | string[] | — | 次要考点 |
| `stem` | string | ✔ | 业务背景 + 现象 |
| `requirement` | string | ✔ | 任务与口径（必须无歧义） |
| `output_hint` | string | ✔ | 要哪些列、是否排序、口径提示 |
| `hint` | string | — | 渐进提示，**不得含答案写法** |
| `reference_sql` | string | ✔ | SQL Server 权威写法（可含 `dbo.`），**只展示不执行** |
| `reference_sql_sqlite` | string | — | SQLite 等价写法；与上文相同可省略 |
| `expected.columns` | string[] | ✔ | 预期列名（仅展示与对账，判题不依赖列序） |
| `expected.row_count` | int \| null | ✔ | 预期行数；`null` = 未固化 |
| `expected.rows` | array \| null | — | 展示用样本，最多前 50 行，**不参与判题** |
| `expected.order_sensitive` | bool | — | 默认 `false`（全库默认不要求行序） |
| `pitfalls` | string[] | ✔ | 坑位，写清「错在哪、为什么错」；通过后才展示 |
| `forbidden_syntax` | string[] | — | 本题禁用语法；命中时在提交前给**警告**（不阻断） |
| `dialect_note` | string | — | 本题的 SQL Server ↔ SQLite 差异提示；通过后才展示 |
| `tags` | string[] | — | 检索/筛选用 |
| `status` | string | — | `draft`/`ready`/`retired`，默认 `ready` |
| `version` | string | — | 题目自身修订号 |
| `updated_at` | string | — | `YYYY-MM-DD` |

**加题步骤**：

1. 在 `data/questions.json` 的 `questions` 数组里追加一条，`id`/`seq` 取未用过的值。
2. `reference_sql` 写 SQL Server 版，`reference_sql_sqlite` 写能在本库直接跑的 SQLite 版（去掉 `dbo.`、
   `TOP n` → `LIMIT n`、`ISNULL` → `IFNULL`、`+` 拼串 → `||`）。
3. 把 `reference_sql_sqlite` 在库里实跑一次，把真实行数写进 `expected.row_count`，列名写进 `expected.columns`。
   **不要手算行数。**
4. 运行 `node build.mjs` 重新打包。

> 判题时预期结果是**现场**在同一个 SQLite 实例上跑 `reference_sql_sqlite` 得到的，不依赖写死的结果行。
> `expected.row_count` 只用于**对账**：跑出来对不上就打「⚠ 题库待复核」标记，并且**不判用户错**。

---

## 4. build.mjs 做了什么

1. 读 `vendor/sqljs/sql-wasm.js`（loader）与 `sql-wasm.wasm`（转 base64）。
2. 读 `data/schema_sqlite.sql`、`data/seed_sqlite.sql`、`data/questions.json`、`data/rowcount_expected.json`。
3. 读 `src/style.css`、`src/judge.js`、`src/db.js`、`src/app.js`。
4. 全部按字面量塞进 `src/index.html` 的占位符，写出 `dist/hr-sql-practice.html`。
5. **自检**：扫产物里的 `http://`、`https://`、`<script src=`、`<link href=`、`<img src=`、CSS `@import`、
   `url(//` 外链。命中则**非零退出且不写产物**。

内联的两个易错点，写在 `build.mjs` 注释里：占位符替换用 `split/join`（避免 `$&` 被当替换模式）；内联脚本里的
`</script` 一律改写成 `<\/script`（否则 script 标签被提前闭合）。

vendor 的 `sql-wasm.js` 注释里有两条 github URL（无功能），构建时中性化，好让「零外链」自检能过；
`vendor/` 源文件本身保持只读未改。

---

## 5. 方言与判题口径

### 5.1 方言差异（页面首屏常驻，可折叠）

| SQL Server | SQLite |
| --- | --- |
| `SELECT TOP 10 ...` | `SELECT ... LIMIT 10`（写在 `ORDER BY` 之后） |
| `GETDATE()` | 本题库禁用动态时间，基准日写死 `2026-06-30` |
| `IDENTITY(1,1)` | `INTEGER PRIMARY KEY AUTOINCREMENT` |
| `NVARCHAR(n)` / `VARCHAR(n)` | `TEXT` |
| `'a' + 'b'` → `'ab'` | `'a' \|\| 'b'` → `'ab'`（`+` 会静默得 `0`） |
| `dbo.TableName` | `TableName` |
| `ISNULL(a,b)` | `IFNULL(a,b)`（通用：`COALESCE(a,b)`） |
| 裸 `=` 忽略大小写与尾空格 | 逐字精确，需 `UPPER()`/`TRIM()`/`LIKE` |
| `CONVERT(...)` | `CAST(...)` / `strftime(...)` |

**网页端引擎 = SQLite；权威源 = SQL Server。** 两者冲突时以 SQL Server 为准；因为判题预期结果是在同一个
SQLite 实例上现场跑出来的，所以两方言的字符串比较差异不会造成误判。

### 5.2 判题口径（`src/judge.js`）

入口（纯函数，无 DOM 依赖）：

```js
judgeResult(userRows, userColumns, refRows, refColumns, options) -> verdict
```

返回：

```js
{
  pass: boolean,           // 是否通过
  reason: string,          // 人可读的结论
  columnIssue: null | {    // 列名/列数提示；null 表示无问题
    kind: 'count' | 'name',
    message: string,
    extra: string[],
    missing: string[]
  },
  diffRows: [ { kind: 'extra'|'missing'|'changed', row: [...] } ],  // 最多 10 条
  userRowCount: number,
  refRowCount: number,
  alignMode: 'name' | 'position' | 'both' | 'none'
}
```

比对规则：

1. **只比结果集，绝不比对 SQL 文本。**
2. **列数必须一致**，否则不通过（结论里列出两边列数）。
3. **列名默认不比**；列名与预期不同时只在 `columnIssue` 里提示「列名与预期不同」。
4. **列对齐**：优先按列名一一匹配（列名去首尾空格、大小写不敏感），匹配不上退回按列序；
   两种对齐**任一通过即判通过**，`alignMode` 反映实际用了哪种。
5. **行序不敏感**；行按**多重集**比较（重复行数量也必须一致）。`expected.order_sensitive` 为 `true` 时才按顺序比。
6. **数值四舍五入到小数点后 2 位**再比，`1` 与 `1.00` 相等。
   四舍五入基于数字的**最短十进制表示**逐位进位，例如 `1.005 → 1.01`（若用 `Math.round(x*100)/100`，
   `1.005` 会因 IEEE754 表示被吞成 `1.00`，与「四舍五入」语义不符）。
7. `NULL = NULL` 视为相等；`NULL` 与 `0`、`NULL` 与 `''` 必须**不等**（三种值各占独立 key）。
8. 字符串**大小写不敏感、忽略首尾空格**；无前导零的纯十进制字面量按数值处理（`'1.00'` 等于 `1`，
   但 `'007'` 仍是字符串）。
9. 日期按 ISO 文本 `YYYY-MM-DD` **直接比较**，绝不转时间戳（所以 `'2026-6-30'` 与 `'2026-06-30'` 不等）。
10. SQLite 里布尔即 `1`/`0`，按数值处理。
11. 执行错误原样展示，不做任何包装。

---

## 6. 已知限制

- 判题只覆盖「结果集是否等价」，**不检查写法**：用不用窗口函数、是不是相关子查询、性能如何，一概不管。
- 只对**最后一条产生结果集的语句**判题；用户写多条语句时以最后一条的结果为准。
- 运行结果表最多渲染 200 行（超出只提示总行数），判题本身不受此限制。
- 参考 SQL 若在当前库上跑不动（方言没转干净），该题会标「题库待复核」并跳过判题，不会判用户错。
- `expected.content_hash` 未启用；目前只做 `row_count` 对账（方案 A 为主 + B 对账）。
- 进度存在 `localStorage`；浏览器隐私模式或被策略禁用时，进度只在当前会话有效（代码已静默降级，不报错）。
- 未做移动端布局优化（窄屏可用，但编辑器体验一般）。
- 暂不支持错题本、导出、按题目包分组等扩展功能。

---

## 7. 待业务侧钉死的点

1. **列名到底比不比？** 题目契约 §5.2 要求「列集合必须一致」，而本次交付口径是「列名默认不比，只在差异区提示」。
   工程侧暂按**默认不比**实现（更利于练习）。两处口径冲突，需要业务侧给一个最终裁决。
   一旦裁决「必须比」，改动点只有 `src/judge.js` 里的 `namesSetEqual` / `columnIssue` 分支。
2. `expected.row_count` 的固化范围：目前 20 题都有值，是不是所有新题都必须回填？
3. `order_sensitive` 是否需要按题目可配（当前字段已支持，题库里都是默认 `false`）。
4. 数值口径的边界：`1.005` 这类恰好落在半分位上的值，是「十进制四舍五入到 1.01」（当前实现）还是
   「按 IEEE754 实际值截断到 1.00」？契约只写了「四舍五入」，未给边界例子。
5. `content_hash` 是否启用（当前不启用，只做行数对账）。

---

## 8. 许可

MIT，见 `LICENSE`。内联的 sql.js 发行文件同为 MIT。
