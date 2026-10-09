-- ============================================================================
-- HR SQL practice platform - SQLite schema
-- Transpiled from in/schema_mssql.sql by out/run_check.mjs (do not edit by hand)
-- Base date: 2026-06-30
-- ============================================================================

DROP VIEW IF EXISTS V_ORG_HEADCOUNT;
DROP VIEW IF EXISTS V_EMP_ASSIGNMENT;
DROP VIEW IF EXISTS V_ORG_TREE;

DROP TABLE IF EXISTS HR_ASSIGNMENT;
DROP TABLE IF EXISTS HR_SALARY;
DROP TABLE IF EXISTS HR_ATTENDANCE;
DROP TABLE IF EXISTS HR_PERFORMANCE;
DROP TABLE IF EXISTS HR_CANDIDATE;
DROP TABLE IF EXISTS HR_RECRUIT_REQ;
DROP TABLE IF EXISTS HR_POSITION;
DROP TABLE IF EXISTS HR_EMPLOYEE;
DROP TABLE IF EXISTS HR_JOB;
DROP TABLE IF EXISTS HR_ORG;
DROP TABLE IF EXISTS HR_DICT;

CREATE TABLE HR_DICT
(
    ID          INTEGER             PRIMARY KEY AUTOINCREMENT NOT NULL,
    DictType    TEXT     NOT NULL,
    Code        TEXT     NOT NULL,
    Title       TEXT    NOT NULL,
    SortNo      INTEGER             NULL,
    IsDisabled  INTEGER             NULL,
    Remark      TEXT   NULL,
    CONSTRAINT UQ_HR_DICT_Code UNIQUE (DictType, Code)
);

CREATE TABLE HR_ORG
(
    ID            INTEGER            PRIMARY KEY AUTOINCREMENT NOT NULL,
    OrgCode       TEXT    NOT NULL,
    OrgName       TEXT  NOT NULL,
    ParentID      INTEGER            NULL,
    OrgLevel      INTEGER            NOT NULL,
    OrgTypeCode   TEXT    NULL,
    ManagerEmpNo  TEXT    NULL,
    CostCenter    TEXT    NULL,
    ValidFrom     TEXT           NOT NULL,
    ValidTo       TEXT           NULL,
    IsActive      INTEGER            NULL,
    Remark        TEXT  NULL,
    CONSTRAINT UQ_HR_ORG_OrgCode  UNIQUE (OrgCode),
    CONSTRAINT FK_HR_ORG_Parent   FOREIGN KEY (ParentID) REFERENCES HR_ORG (ID)
);

CREATE INDEX IX_HR_ORG_ParentID ON HR_ORG (ParentID);

CREATE TABLE HR_JOB
(
    JobCode        TEXT   NOT NULL,
    JobName        TEXT  NOT NULL,
    JobFamilyCode  TEXT   NULL,
    JobLevelCode   TEXT   NULL,
    IsActive       INTEGER           NULL,
    CONSTRAINT PK_HR_JOB PRIMARY KEY (JobCode)
);

CREATE TABLE HR_EMPLOYEE
(
    EmpNo          TEXT   NOT NULL,
    EmpName        TEXT  NOT NULL,
    GenderCode     TEXT   NULL,
    BirthDate      TEXT          NULL,
    EducationCode  TEXT   NULL,
    SchoolName     TEXT NULL,
    MajorName      TEXT NULL,
    HireDate       TEXT          NOT NULL,
    TermDate       TEXT          NULL,
    EmpTypeCode    TEXT   NULL,
    Mobile         TEXT   NULL,
    IsActive       INTEGER           NULL,
    CONSTRAINT PK_HR_EMPLOYEE          PRIMARY KEY (EmpNo),
    CONSTRAINT CK_HR_EMPLOYEE_TermDate CHECK (TermDate IS NULL OR TermDate >= HireDate)
);

CREATE INDEX IX_HR_EMPLOYEE_TermDate ON HR_EMPLOYEE (TermDate);

CREATE TABLE HR_POSITION
(
    PositionCode   TEXT   NOT NULL,
    OrgID          INTEGER           NOT NULL,
    JobCode        TEXT   NOT NULL,
    HeadCountPlan  INTEGER           NOT NULL,
    ValidFrom      TEXT          NOT NULL,
    ValidTo        TEXT          NULL,
    IsActive       INTEGER           NULL,
    CONSTRAINT PK_HR_POSITION        PRIMARY KEY (PositionCode),
    CONSTRAINT FK_HR_POSITION_Org    FOREIGN KEY (OrgID)   REFERENCES HR_ORG (ID),
    CONSTRAINT FK_HR_POSITION_Job    FOREIGN KEY (JobCode) REFERENCES HR_JOB (JobCode)
);

CREATE INDEX IX_HR_POSITION_OrgID_JobCode ON HR_POSITION (OrgID, JobCode);

CREATE TABLE HR_ASSIGNMENT
(
    ID                  INTEGER           PRIMARY KEY AUTOINCREMENT NOT NULL,
    EmpNo               TEXT   NOT NULL,
    OrgID               INTEGER           NOT NULL,
    PositionCode        TEXT   NULL,
    JobCode             TEXT   NULL,
    AssignmentTypeCode  TEXT   NULL,
    IsPrimary           INTEGER           NULL,
    ActionCode          TEXT   NULL,
    StartDate           TEXT          NOT NULL,
    EndDate             TEXT          NULL,
    CONSTRAINT FK_HR_ASSIGNMENT_Emp         FOREIGN KEY (EmpNo)        REFERENCES HR_EMPLOYEE (EmpNo),
    CONSTRAINT FK_HR_ASSIGNMENT_Org         FOREIGN KEY (OrgID)        REFERENCES HR_ORG (ID),
    CONSTRAINT FK_HR_ASSIGNMENT_Position    FOREIGN KEY (PositionCode) REFERENCES HR_POSITION (PositionCode),
    CONSTRAINT FK_HR_ASSIGNMENT_Job         FOREIGN KEY (JobCode)      REFERENCES HR_JOB (JobCode),
    CONSTRAINT CK_HR_ASSIGNMENT_DateOrder   CHECK (EndDate IS NULL OR EndDate >= StartDate)
);

CREATE INDEX IX_HR_ASSIGNMENT_Emp_Start  ON HR_ASSIGNMENT (EmpNo, StartDate);
CREATE INDEX IX_HR_ASSIGNMENT_Org_Date   ON HR_ASSIGNMENT (OrgID, StartDate, EndDate);
CREATE INDEX IX_HR_ASSIGNMENT_Job        ON HR_ASSIGNMENT (JobCode);

CREATE TABLE HR_SALARY
(
    ID             INTEGER            PRIMARY KEY AUTOINCREMENT NOT NULL,
    EmpNo          TEXT    NOT NULL,
    SalaryMonth    TEXT        NOT NULL,
    BaseSalary     NUMERIC  NOT NULL,
    PerfBonus      NUMERIC  NULL,
    Allowance      NUMERIC  NULL,
    OvertimePay    NUMERIC  NULL,
    GrossPay       NUMERIC  NOT NULL,
    Deduction      NUMERIC  NULL,
    NetPay         NUMERIC  NOT NULL,
    CurrencyCode   TEXT    NOT NULL,
    CONSTRAINT UQ_HR_SALARY_Emp_Month  UNIQUE (EmpNo, SalaryMonth),
    CONSTRAINT FK_HR_SALARY_Emp        FOREIGN KEY (EmpNo) REFERENCES HR_EMPLOYEE (EmpNo)
);

CREATE INDEX IX_HR_SALARY_Month ON HR_SALARY (SalaryMonth);

CREATE TABLE HR_ATTENDANCE
(
    ID             INTEGER            PRIMARY KEY AUTOINCREMENT NOT NULL,
    EmpNo          TEXT    NOT NULL,
    AttMonth       TEXT        NOT NULL,
    WorkDays       NUMERIC   NOT NULL,
    ActualDays     NUMERIC   NOT NULL,
    LeaveDays      NUMERIC   NULL,
    OvertimeHours  NUMERIC   NULL,
    AbsentDays     NUMERIC   NULL,
    LateCount      INTEGER            NULL,
    CONSTRAINT UQ_HR_ATTENDANCE_Emp_Month  UNIQUE (EmpNo, AttMonth),
    CONSTRAINT FK_HR_ATTENDANCE_Emp        FOREIGN KEY (EmpNo) REFERENCES HR_EMPLOYEE (EmpNo)
);

CREATE INDEX IX_HR_ATTENDANCE_Month ON HR_ATTENDANCE (AttMonth);

CREATE TABLE HR_RECRUIT_REQ
(
    ReqNo         TEXT    NOT NULL,
    OrgID         INTEGER            NOT NULL,
    JobCode       TEXT    NOT NULL,
    HeadCount     INTEGER            NOT NULL,
    PriorityCode  TEXT    NULL,
    StatusCode    TEXT    NOT NULL,
    OpenDate      TEXT           NOT NULL,
    CloseDate     TEXT           NULL,
    OwnerEmpNo    TEXT    NULL,
    CONSTRAINT PK_HR_RECRUIT_REQ         PRIMARY KEY (ReqNo),
    CONSTRAINT FK_HR_RECRUIT_REQ_Org     FOREIGN KEY (OrgID)   REFERENCES HR_ORG (ID),
    CONSTRAINT FK_HR_RECRUIT_REQ_Job     FOREIGN KEY (JobCode) REFERENCES HR_JOB (JobCode)
);

CREATE INDEX IX_HR_RECRUIT_REQ_Status ON HR_RECRUIT_REQ (StatusCode, OpenDate);

CREATE TABLE HR_CANDIDATE
(
    CandNo          TEXT    NOT NULL,
    ReqNo           TEXT    NOT NULL,
    CandName        TEXT   NOT NULL,
    SourceCode      TEXT    NULL,
    StageCode       TEXT    NULL,
    ApplyDate       TEXT           NOT NULL,
    OfferDate       TEXT           NULL,
    HireDate        TEXT           NULL,
    ExpectedSalary  NUMERIC  NULL,
    ResultCode      TEXT    NULL,
    CONSTRAINT PK_HR_CANDIDATE      PRIMARY KEY (CandNo),
    CONSTRAINT FK_HR_CANDIDATE_Req  FOREIGN KEY (ReqNo) REFERENCES HR_RECRUIT_REQ (ReqNo)
);

CREATE INDEX IX_HR_CANDIDATE_Req_Stage ON HR_CANDIDATE (ReqNo, StageCode);

CREATE TABLE HR_PERFORMANCE
(
    ID              INTEGER            PRIMARY KEY AUTOINCREMENT NOT NULL,
    EmpNo           TEXT    NOT NULL,
    PeriodCode      TEXT    NOT NULL,
    ScoreValue      NUMERIC   NULL,
    GradeCode       TEXT    NULL,
    RankInOrg       INTEGER            NULL,
    EvaluatorEmpNo  TEXT    NULL,
    IsFinal         INTEGER            NOT NULL,
    CONSTRAINT UQ_HR_PERFORMANCE_Emp_Period UNIQUE (EmpNo, PeriodCode),
    CONSTRAINT FK_HR_PERFORMANCE_Emp        FOREIGN KEY (EmpNo) REFERENCES HR_EMPLOYEE (EmpNo)
);

CREATE INDEX IX_HR_PERFORMANCE_Period ON HR_PERFORMANCE (PeriodCode, GradeCode);

CREATE VIEW V_ORG_TREE
AS
WITH RECURSIVE OrgTree AS
(

    SELECT
        o.ID,
        o.OrgCode,
        o.OrgName,
        o.ParentID,
        o.OrgLevel,
        CAST(o.OrgName AS TEXT) AS OrgPath,
        CAST(1 AS INTEGER)                   AS Depth
    FROM HR_ORG AS o
    WHERE o.ParentID IS NULL

    UNION ALL

    SELECT
        c.ID,
        c.OrgCode,
        c.OrgName,
        c.ParentID,
        c.OrgLevel,
        CAST(p.OrgPath || ' / ' || c.OrgName AS TEXT) AS OrgPath,
        CAST(p.Depth + 1 AS INTEGER)                              AS Depth
    FROM HR_ORG AS c
    JOIN OrgTree   AS p ON c.ParentID = p.ID
)
SELECT ID, OrgCode, OrgName, ParentID, OrgLevel, OrgPath, Depth
FROM OrgTree;

CREATE VIEW V_EMP_ASSIGNMENT
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
FROM HR_ASSIGNMENT AS a
JOIN HR_EMPLOYEE  AS e ON e.EmpNo   = a.EmpNo
JOIN HR_ORG       AS o ON o.ID      = a.OrgID
LEFT JOIN HR_JOB  AS j ON j.JobCode = a.JobCode;

CREATE VIEW V_ORG_HEADCOUNT
AS
SELECT
    p.PositionCode,
    p.OrgID,
    o.OrgName,
    p.JobCode,
    j.JobName,
    p.HeadCountPlan                              AS PlanCount,
    IFNULL(a.ActualCount, 0)                     AS ActualCount,
    p.HeadCountPlan - IFNULL(a.ActualCount, 0)   AS GapCount
FROM HR_POSITION AS p
JOIN HR_ORG      AS o ON o.ID      = p.OrgID
JOIN HR_JOB      AS j ON j.JobCode = p.JobCode
LEFT JOIN
(
    SELECT
        OrgID,
        JobCode,
        COUNT(*) AS ActualCount
    FROM HR_ASSIGNMENT
    WHERE StartDate <= '2026-06-30'
      AND (EndDate IS NULL OR EndDate >= '2026-06-30')
      AND IsPrimary = 1
    GROUP BY OrgID, JobCode
) AS a ON a.OrgID = p.OrgID AND a.JobCode = p.JobCode;
