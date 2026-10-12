# 「问一问」本地问答面板 v0

题区里的一个可折叠小面板：输入一个问题，用站内既有数据回答，并指明来源。默认收起。

## 覆盖范围（四类 + 报错）

| 类型 | 命中什么 | 回答里的来源 |
| :-- | :-- | :-- |
| 表 | 表英文名（`HR_EMPLOYEE`）、中文名（`薪酬`）、业务角色描述 | `表 HR_SALARY` |
| 字段 | 英文字段名（`NetPay`）、字段 note 里的业务词（`实发`、`在职`） | `字段 HR_SALARY.NetPay` |
| 题目 | 当前题的考点 / 易错点 / 提示 / 方言 / 要求 / 涉及的表 | `题 q001` |
| 语法卡 | 语法名精确或模糊（`GROUP BY`、`IS NULL`），说明 / 何时用 / 示例 / 常见误用 | `语法卡 GROUP BY` |
| 报错（`kind=error`） | SQLite 报错原文 → 一句中文解释（本地映射表，≥7 种） | `本地报错映射表` |

未命中一律明确回「本地知识里没有这条」，并说明本面板只认哪几类来源。

另有「对比我的 SQL」：把编辑器里的 SQL 与当前题参考 SQL 做**保守的结构化对比**（用到的表、JOIN 数、聚合函数集合、有无 GROUP BY / ORDER BY、`SELECT *` 提示、列数粗算）。解析不确定时（子查询、`SELECT *`）不下结论；只对比结构，不判对错。

## 数据来源（全部站内既有，零新增）

- 表结构：`src/tables.js` → `HRTables.allTables()`（11 表；仅结构，无数据行）。
- 题库：`boot.questions`（= `data/questions.json` 的 `questions[]`）。
- 语法卡：`HRLevels.syntaxIntrosFor(questions)` 的产物（即 `renderSyntaxCards` 用的同一数据源）。
- 报错映射表：写在 `src/qa.js` 里，不联网、不调模型。

内核 `src/qa.js` 是纯逻辑 UMD（node `module.exports` / 浏览器 `globalThis.HRQa`），不碰 DOM / `window` / `fs` / 网络。

## 明确不做的事

- 不联网、不发任何请求、不引外部资源或新依赖。
- 不调模型、不做生成式回答。
- 不答站外问题；未命中就说没有，不编造。
- 不解析 `docs/*.md`（v0 只用内存里的结构化数据）。
- 不替学生写完整答案：只给考点 / 易错点 / 结构提示与卡片引用，完整写法仍走「查看答案」。
- 不读不写学习进度（`localStorage 'dbquest.v2'`），不参与判题。
