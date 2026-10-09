/* ============================================================================
   HR 语境 SQL 练习平台 · 建库脚本 schema.sql
   ----------------------------------------------------------------------------
   数据库   ：HRSQLPractice
   语法基准 ：SQL Server (T-SQL)
   基准日   ：2026-06-30        数据范围：2025-07-01 ~ 2026-06-30
   版本     ：v1 · 2026-10-09
   ----------------------------------------------------------------------------
   【权威源约定】
   本脚本是整套练习库的**唯一权威源**。网页端（SQLite）中的表结构与数据均为
   其派生物；任何结构改动必须先改本脚本，再由工程侧重新转译生成，禁止两处各改。

   【两条硬约定】
   1. 所有涉及"当前/今天"的判断，一律使用固定基准日 '2026-06-30' 写死，
      全库不使用 GETDATE()。否则同一道题每天答案都变，预期结果无法固定。
   2. 字段只用通用 HR 业务概念，不含任何真实单位的库名、表名、字段名、
      系统名、组织名或人员信息。

   【网页端提示】
   工程侧转译时，只需取 SECTION 1 / SECTION 2 / SECTION 3；
   SECTION 0 为 SQL Server 库级语句，不参与网页端执行。
   ============================================================================ */


/* ============================================================================
   SECTION 0 · 库级（网页端可跳过）
   ============================================================================ */

IF DB_ID(N'HRSQLPractice') IS NULL
    CREATE DATABASE HRSQLPractice;
GO

USE HRSQLPractice;
GO


/* ============================================================================
   SECTION 1 · 清理（按依赖倒序：先视图，再子表，最后父表）
   ============================================================================ */

DROP VIEW IF EXISTS dbo.V_ORG_HEADCOUNT;
DROP VIEW IF EXISTS dbo.V_EMP_ASSIGNMENT;
DROP VIEW IF EXISTS dbo.V_ORG_TREE;
GO

DROP TABLE IF EXISTS dbo.HR_ASSIGNMENT;
DROP TABLE IF EXISTS dbo.HR_SALARY;
DROP TABLE IF EXISTS dbo.HR_ATTENDANCE;
DROP TABLE IF EXISTS dbo.HR_PERFORMANCE;
DROP TABLE IF EXISTS dbo.HR_CANDIDATE;
DROP TABLE IF EXISTS dbo.HR_RECRUIT_REQ;
DROP TABLE IF EXISTS dbo.HR_POSITION;
DROP TABLE IF EXISTS dbo.HR_EMPLOYEE;
DROP TABLE IF EXISTS dbo.HR_JOB;
DROP TABLE IF EXISTS dbo.HR_ORG;
DROP TABLE IF EXISTS dbo.HR_DICT;
GO


/* ============================================================================
   SECTION 2 · 建表
   ----------------------------------------------------------------------------
   说明：刻意**不**给状态类列（IsActive / IsDisabled / 各类可选数值列）加 CHECK
   约束，以保留真实系统里的脏数据形态（1 / 0 / NULL 混用、NULL 与 0 并存）。
   这是设计意图，不是疏漏——练习库要练的正是这些。
   ============================================================================ */

/* ---------------------------------------------------------------------------
   2.1  HR_DICT  字典（码值表）
        全库所有 *Code 字段的翻译源。字典表先建，其余表随后引用其码值。
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.HR_DICT
(
    ID          int             IDENTITY(1,1) NOT NULL,
    DictType    varchar(30)     NOT NULL,               -- 字典类型：ORG_TYPE / JOB_FAMILY / ...
    Code        varchar(20)     NOT NULL,               -- 码值
    Title       nvarchar(50)    NOT NULL,               -- 显示名称
    SortNo      int             NULL,                   -- 排序号（大量为 NULL）
    IsDisabled  int             NULL,                   -- 状态（1/0/NULL 混用）
    Remark      nvarchar(200)   NULL,
    CONSTRAINT PK_HR_DICT      PRIMARY KEY (ID),
    CONSTRAINT UQ_HR_DICT_Code UNIQUE (DictType, Code)
);
GO


/* ---------------------------------------------------------------------------
   2.2  HR_ORG  组织
        ParentID 自关联，构成组织树；带生效/失效日期。
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.HR_ORG
(
    ID            int            IDENTITY(1,1) NOT NULL,
    OrgCode       varchar(20)    NOT NULL,              -- 组织编码（字符型，长短不一）
    OrgName       nvarchar(100)  NOT NULL,              -- 组织名称
    ParentID      int            NULL,                  -- 上级组织（顶级为 NULL）
    OrgLevel      int            NOT NULL,              -- 1 公司 / 2 厂·中心 / 3 部门 / 4 班组
    OrgTypeCode   varchar(20)    NULL,                  -- -> HR_DICT (ORG_TYPE)
    ManagerEmpNo  varchar(20)    NULL,                  -- 负责人（弱引用 HR_EMPLOYEE，不建外键）
    CostCenter    varchar(20)    NULL,                  -- 成本中心
    ValidFrom     date           NOT NULL,              -- 生效日
    ValidTo       date           NULL,                  -- 失效日（NULL = 至今）
    IsActive      int            NULL,                  -- 状态（1/0/NULL 混用）
    Remark        nvarchar(200)  NULL,
    CONSTRAINT PK_HR_ORG          PRIMARY KEY (ID),
    CONSTRAINT UQ_HR_ORG_OrgCode  UNIQUE (OrgCode),
    CONSTRAINT FK_HR_ORG_Parent   FOREIGN KEY (ParentID) REFERENCES dbo.HR_ORG (ID)
);
GO

CREATE INDEX IX_HR_ORG_ParentID ON dbo.HR_ORG (ParentID);
GO


/* ---------------------------------------------------------------------------
   2.3  HR_JOB  岗位标准
        与组织无关的"岗位定义"，如"人力资源专员（P4）"。
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.HR_JOB
(
    JobCode        varchar(20)   NOT NULL,
    JobName        nvarchar(50)  NOT NULL,              -- 岗位名称（大小写不一致）
    JobFamilyCode  varchar(20)   NULL,                  -- 职族 -> HR_DICT (JOB_FAMILY)
    JobLevelCode   varchar(20)   NULL,                  -- 职级 -> HR_DICT (JOB_LEVEL)
    IsActive       int           NULL,
    CONSTRAINT PK_HR_JOB PRIMARY KEY (JobCode)
);
GO


/* ---------------------------------------------------------------------------
   2.4  HR_EMPLOYEE  员工（花名册）
        刻意不存"当前部门 / 当前岗位 / 在职状态"——这三样必须从 HR_ASSIGNMENT
        按时间算出来。冗余存储是 HRIS 报表口径打架的头号来源。
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.HR_EMPLOYEE
(
    EmpNo          varchar(20)   NOT NULL,              -- 工号
    EmpName        nvarchar(50)  NOT NULL,              -- 姓名
    GenderCode     varchar(10)   NULL,                  -- 性别 -> HR_DICT (GENDER)
    BirthDate      date          NULL,                  -- 出生日期（有 NULL）
    EducationCode  varchar(20)   NULL,                  -- 学历 -> HR_DICT (EDUCATION)
    SchoolName     nvarchar(100) NULL,                  -- 毕业院校
    MajorName      nvarchar(100) NULL,                  -- 专业
    HireDate       date          NOT NULL,              -- 入职日期
    TermDate       date          NULL,                  -- 离职日期（NULL = 在职）
    EmpTypeCode    varchar(20)   NULL,                  -- 雇佣类型 -> HR_DICT (EMP_TYPE)
    Mobile         varchar(20)   NULL,                  -- 手机号（假数据，约 15% 为 NULL）
    IsActive       int           NULL,
    CONSTRAINT PK_HR_EMPLOYEE          PRIMARY KEY (EmpNo),
    CONSTRAINT CK_HR_EMPLOYEE_TermDate CHECK (TermDate IS NULL OR TermDate >= HireDate)
);
GO

CREATE INDEX IX_HR_EMPLOYEE_TermDate ON dbo.HR_EMPLOYEE (TermDate);
GO


/* ---------------------------------------------------------------------------
   2.5  HR_POSITION  组织岗位与编制
        某个组织下某个岗位有多少编制。实配人数不落字段，由视图现算。
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.HR_POSITION
(
    PositionCode   varchar(20)   NOT NULL,              -- 岗位实例编码
    OrgID          int           NOT NULL,              -- -> HR_ORG
    JobCode        varchar(20)   NOT NULL,              -- -> HR_JOB
    HeadCountPlan  int           NOT NULL,              -- 编制数
    ValidFrom      date          NOT NULL,
    ValidTo        date          NULL,
    IsActive       int           NULL,
    CONSTRAINT PK_HR_POSITION        PRIMARY KEY (PositionCode),
    CONSTRAINT FK_HR_POSITION_Org    FOREIGN KEY (OrgID)   REFERENCES dbo.HR_ORG (ID),
    CONSTRAINT FK_HR_POSITION_Job    FOREIGN KEY (JobCode) REFERENCES dbo.HR_JOB (JobCode)
);
GO

CREATE INDEX IX_HR_POSITION_OrgID_JobCode ON dbo.HR_POSITION (OrgID, JobCode);
GO


/* ---------------------------------------------------------------------------
   2.6  HR_ASSIGNMENT  任职记录  ★ 整套模型的枢纽
        人 × 组织 × 岗位 × 时间。一人可有多段（入职/转正/调动/晋升/离职/兼岗），
        查询"某人在某时点属于哪个组织"必须带时间条件，否则会数重。
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.HR_ASSIGNMENT
(
    ID                  int           IDENTITY(1,1) NOT NULL,
    EmpNo               varchar(20)   NOT NULL,         -- -> HR_EMPLOYEE
    OrgID               int           NOT NULL,         -- -> HR_ORG
    PositionCode        varchar(20)   NULL,             -- -> HR_POSITION
    JobCode             varchar(20)   NULL,             -- -> HR_JOB
    AssignmentTypeCode  varchar(20)   NULL,             -- 任职类型 -> HR_DICT (ASSIGN_TYPE)
    IsPrimary           int           NULL,             -- 是否主职（1/0）
    ActionCode          varchar(20)   NULL,             -- 异动类型 -> HR_DICT (ACTION_TYPE)
    StartDate           date          NOT NULL,         -- 起始日
    EndDate             date          NULL,             -- 结束日（NULL = 至今）
    CONSTRAINT PK_HR_ASSIGNMENT             PRIMARY KEY (ID),
    CONSTRAINT FK_HR_ASSIGNMENT_Emp         FOREIGN KEY (EmpNo)        REFERENCES dbo.HR_EMPLOYEE (EmpNo),
    CONSTRAINT FK_HR_ASSIGNMENT_Org         FOREIGN KEY (OrgID)        REFERENCES dbo.HR_ORG (ID),
    CONSTRAINT FK_HR_ASSIGNMENT_Position    FOREIGN KEY (PositionCode) REFERENCES dbo.HR_POSITION (PositionCode),
    CONSTRAINT FK_HR_ASSIGNMENT_Job         FOREIGN KEY (JobCode)      REFERENCES dbo.HR_JOB (JobCode),
    CONSTRAINT CK_HR_ASSIGNMENT_DateOrder   CHECK (EndDate IS NULL OR EndDate >= StartDate)
);
GO

CREATE INDEX IX_HR_ASSIGNMENT_Emp_Start  ON dbo.HR_ASSIGNMENT (EmpNo, StartDate);
CREATE INDEX IX_HR_ASSIGNMENT_Org_Date   ON dbo.HR_ASSIGNMENT (OrgID, StartDate, EndDate);
CREATE INDEX IX_HR_ASSIGNMENT_Job        ON dbo.HR_ASSIGNMENT (JobCode);
GO


/* ---------------------------------------------------------------------------
   2.7  HR_SALARY  薪酬（按月）
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.HR_SALARY
(
    ID             int            IDENTITY(1,1) NOT NULL,
    EmpNo          varchar(20)    NOT NULL,             -- -> HR_EMPLOYEE
    SalaryMonth    char(6)        NOT NULL,             -- 期间 YYYYMM
    BaseSalary     decimal(12,2)  NOT NULL,             -- 基本工资
    PerfBonus      decimal(12,2)  NULL,                 -- 绩效奖金
    Allowance      decimal(12,2)  NULL,                 -- 津贴
    OvertimePay    decimal(12,2)  NULL,                 -- 加班费
    GrossPay       decimal(12,2)  NOT NULL,             -- 应发合计
    Deduction      decimal(12,2)  NULL,                 -- 扣款（NULL 与 0 混用）
    NetPay         decimal(12,2)  NOT NULL,             -- 实发
    CurrencyCode   varchar(10)    NOT NULL,             -- 币种 -> HR_DICT (CURRENCY)
    CONSTRAINT PK_HR_SALARY            PRIMARY KEY (ID),
    CONSTRAINT UQ_HR_SALARY_Emp_Month  UNIQUE (EmpNo, SalaryMonth),
    CONSTRAINT FK_HR_SALARY_Emp        FOREIGN KEY (EmpNo) REFERENCES dbo.HR_EMPLOYEE (EmpNo)
);
GO

CREATE INDEX IX_HR_SALARY_Month ON dbo.HR_SALARY (SalaryMonth);
GO


/* ---------------------------------------------------------------------------
   2.8  HR_ATTENDANCE  考勤（按月）
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.HR_ATTENDANCE
(
    ID             int            IDENTITY(1,1) NOT NULL,
    EmpNo          varchar(20)    NOT NULL,             -- -> HR_EMPLOYEE
    AttMonth       char(6)        NOT NULL,             -- 期间 YYYYMM
    WorkDays       decimal(5,1)   NOT NULL,             -- 应出勤天数
    ActualDays     decimal(5,1)   NOT NULL,             -- 实出勤天数
    LeaveDays      decimal(5,1)   NULL,                 -- 请假天数（NULL = 无请假）
    OvertimeHours  decimal(6,1)   NULL,                 -- 加班小时
    AbsentDays     decimal(5,1)   NULL,                 -- 缺勤天数
    LateCount      int            NULL,                 -- 迟到次数
    CONSTRAINT PK_HR_ATTENDANCE            PRIMARY KEY (ID),
    CONSTRAINT UQ_HR_ATTENDANCE_Emp_Month  UNIQUE (EmpNo, AttMonth),
    CONSTRAINT FK_HR_ATTENDANCE_Emp        FOREIGN KEY (EmpNo) REFERENCES dbo.HR_EMPLOYEE (EmpNo)
);
GO

CREATE INDEX IX_HR_ATTENDANCE_Month ON dbo.HR_ATTENDANCE (AttMonth);
GO


/* ---------------------------------------------------------------------------
   2.9  HR_RECRUIT_REQ  招聘需求
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.HR_RECRUIT_REQ
(
    ReqNo         varchar(20)    NOT NULL,              -- 需求编号
    OrgID         int            NOT NULL,              -- 需求组织 -> HR_ORG
    JobCode       varchar(20)    NOT NULL,              -- 需求岗位 -> HR_JOB
    HeadCount     int            NOT NULL,              -- 需求人数
    PriorityCode  varchar(20)    NULL,                  -- 紧急度 -> HR_DICT (PRIORITY)
    StatusCode    varchar(20)    NOT NULL,              -- 状态 -> HR_DICT (REQ_STATUS)
    OpenDate      date           NOT NULL,              -- 开启日
    CloseDate     date           NULL,                  -- 关闭日（NULL = 仍开启）
    OwnerEmpNo    varchar(20)    NULL,                  -- 负责 HR（弱引用）
    CONSTRAINT PK_HR_RECRUIT_REQ         PRIMARY KEY (ReqNo),
    CONSTRAINT FK_HR_RECRUIT_REQ_Org     FOREIGN KEY (OrgID)   REFERENCES dbo.HR_ORG (ID),
    CONSTRAINT FK_HR_RECRUIT_REQ_Job     FOREIGN KEY (JobCode) REFERENCES dbo.HR_JOB (JobCode)
);
GO

CREATE INDEX IX_HR_RECRUIT_REQ_Status ON dbo.HR_RECRUIT_REQ (StatusCode, OpenDate);
GO


/* ---------------------------------------------------------------------------
   2.10 HR_CANDIDATE  候选人
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.HR_CANDIDATE
(
    CandNo          varchar(20)    NOT NULL,            -- 候选人编号
    ReqNo           varchar(20)    NOT NULL,            -- -> HR_RECRUIT_REQ
    CandName        nvarchar(50)   NOT NULL,            -- 姓名（假名）
    SourceCode      varchar(20)    NULL,                -- 来源渠道 -> HR_DICT (SOURCE)
    StageCode       varchar(20)    NULL,                -- 当前阶段 -> HR_DICT (STAGE)
    ApplyDate       date           NOT NULL,            -- 投递日
    OfferDate       date           NULL,                -- Offer 日
    HireDate        date           NULL,                -- 入职日（NULL = 未入职）
    ExpectedSalary  decimal(12,2)  NULL,                -- 期望薪资
    ResultCode      varchar(20)    NULL,                -- 结果 -> HR_DICT (CAND_RESULT)
    CONSTRAINT PK_HR_CANDIDATE      PRIMARY KEY (CandNo),
    CONSTRAINT FK_HR_CANDIDATE_Req  FOREIGN KEY (ReqNo) REFERENCES dbo.HR_RECRUIT_REQ (ReqNo)
);
GO

CREATE INDEX IX_HR_CANDIDATE_Req_Stage ON dbo.HR_CANDIDATE (ReqNo, StageCode);
GO


/* ---------------------------------------------------------------------------
   2.11 HR_PERFORMANCE  绩效
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.HR_PERFORMANCE
(
    ID              int            IDENTITY(1,1) NOT NULL,
    EmpNo           varchar(20)    NOT NULL,            -- -> HR_EMPLOYEE
    PeriodCode      varchar(10)    NOT NULL,            -- 考核周期 -> HR_DICT (PERIOD)
    ScoreValue      decimal(5,2)   NULL,                -- 分数（有 NULL，非全员都评）
    GradeCode       varchar(10)    NULL,                -- 等级 -> HR_DICT (GRADE)
    RankInOrg       int            NULL,                -- 组织内排名
    EvaluatorEmpNo  varchar(20)    NULL,                -- 评估人（弱引用）
    IsFinal         int            NOT NULL,            -- 是否终评（1/0）
    CONSTRAINT PK_HR_PERFORMANCE            PRIMARY KEY (ID),
    CONSTRAINT UQ_HR_PERFORMANCE_Emp_Period UNIQUE (EmpNo, PeriodCode),
    CONSTRAINT FK_HR_PERFORMANCE_Emp        FOREIGN KEY (EmpNo) REFERENCES dbo.HR_EMPLOYEE (EmpNo)
);
GO

CREATE INDEX IX_HR_PERFORMANCE_Period ON dbo.HR_PERFORMANCE (PeriodCode, GradeCode);
GO


/* ============================================================================
   SECTION 3 · 视图（教学用）

   三个视图都在刻意示范同一件事：**"当前状态"是算出来的，不是存出来的**。
   基准日一律写死 '2026-06-30'。
   ============================================================================ */

/* ---------------------------------------------------------------------------
   3.1  V_ORG_TREE  组织树（递归 CTE）
        输出每个组织及其完整路径与深度。练递归、练自连接。
   --------------------------------------------------------------------------- */
CREATE VIEW dbo.V_ORG_TREE
AS
WITH OrgTree AS
(
    -- 锚点：顶级组织
    SELECT
        o.ID,
        o.OrgCode,
        o.OrgName,
        o.ParentID,
        o.OrgLevel,
        CAST(o.OrgName AS nvarchar(400)) AS OrgPath,
        CAST(1 AS int)                   AS Depth
    FROM dbo.HR_ORG AS o
    WHERE o.ParentID IS NULL

    UNION ALL

    -- 递归：逐层往下拼路径
    SELECT
        c.ID,
        c.OrgCode,
        c.OrgName,
        c.ParentID,
        c.OrgLevel,
        CAST(p.OrgPath + N' / ' + c.OrgName AS nvarchar(400)) AS OrgPath,
        CAST(p.Depth + 1 AS int)                              AS Depth
    FROM dbo.HR_ORG AS c
    JOIN OrgTree   AS p ON c.ParentID = p.ID
)
SELECT ID, OrgCode, OrgName, ParentID, OrgLevel, OrgPath, Depth
FROM OrgTree;
GO


/* ---------------------------------------------------------------------------
   3.2  V_EMP_ASSIGNMENT  任职宽表
        人 + 组织 + 岗位 + 起止。想查"某人在某时点在哪"，从这张表下手。
        注意：这是**宽表不是事实快照**，一人可能有多行，用前必须加时间条件。
   --------------------------------------------------------------------------- */
CREATE VIEW dbo.V_EMP_ASSIGNMENT
AS
SELECT
    a.ID                 AS AssignmentID,
    e.EmpNo,
    e.EmpName,
    e.HireDate,
    e.TermDate,
    a.OrgID,
    o.OrgName,
    o.OrgLevel,
    a.PositionCode,
    a.JobCode,
    j.JobName,
    a.AssignmentTypeCode,
    a.IsPrimary,
    a.ActionCode,
    a.StartDate,
    a.EndDate
FROM dbo.HR_ASSIGNMENT AS a
JOIN dbo.HR_EMPLOYEE  AS e ON e.EmpNo   = a.EmpNo
JOIN dbo.HR_ORG       AS o ON o.ID      = a.OrgID
LEFT JOIN dbo.HR_JOB  AS j ON j.JobCode = a.JobCode;
GO


/* ---------------------------------------------------------------------------
   3.3  V_ORG_HEADCOUNT  编制 vs 实配
        实配 = 基准日在职且为主职的任职记录数（按 组织 + 岗位 汇总）。
        GapCount > 0 为缺编，< 0 为超编。
   --------------------------------------------------------------------------- */
CREATE VIEW dbo.V_ORG_HEADCOUNT
AS
SELECT
    p.PositionCode,
    p.OrgID,
    o.OrgName,
    p.JobCode,
    j.JobName,
    p.HeadCountPlan                              AS PlanCount,
    ISNULL(a.ActualCount, 0)                     AS ActualCount,
    p.HeadCountPlan - ISNULL(a.ActualCount, 0)   AS GapCount
FROM dbo.HR_POSITION AS p
JOIN dbo.HR_ORG      AS o ON o.ID      = p.OrgID
JOIN dbo.HR_JOB      AS j ON j.JobCode = p.JobCode
LEFT JOIN
(
    SELECT
        OrgID,
        JobCode,
        COUNT(*) AS ActualCount
    FROM dbo.HR_ASSIGNMENT
    WHERE StartDate <= '2026-06-30'                             -- 基准日前已开始
      AND (EndDate IS NULL OR EndDate >= '2026-06-30')          -- 基准日时未结束
      AND IsPrimary = 1                                          -- 只算主职
    GROUP BY OrgID, JobCode
) AS a ON a.OrgID = p.OrgID AND a.JobCode = p.JobCode;
GO


/* ============================================================================
   END OF SCHEMA — 下一步：执行 seed.sql 灌入假数据
   ============================================================================ */
