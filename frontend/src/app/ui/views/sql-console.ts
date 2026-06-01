import { LitElement, html, css, nothing } from "lit";
import { sharedBtnStyles } from "../../styles/shared-btn-styles.ts";
import { customElement, state } from "lit/decorators.js";
import { basicSetup } from "codemirror";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { sql, MySQL, SQLDialect } from "@codemirror/lang-sql";
import { autocompletion, CompletionContext, Completion } from "@codemirror/autocomplete";
import { oneDark } from "@codemirror/theme-one-dark";
import { icons } from "../../../icons.js";

// Dameng DM8 SQL dialect for CodeMirror
const DamengDialect = SQLDialect.define({
  keywords: `
    ABORT ABS ABSOLUTE ACCESS ACTION ACTIVE ADD ADMIN AFTER AGGREGATE
    ALL ALLOCATE ALTER ANALYZE AND ANY ARCHIVELOG ARE ARRAY AS ASC
    ASSERTION AT AUTHORIZATION AUTO BACKUP BACKWARD BATCH BEFORE BEGIN
    BETWEEN BIGINT BINARY BIT BLOB BLOCK BODY BOOLEAN BOTH BREADTH
    BREAK BROWSE BULK BY CACHE CALL CALLED CASCADE CASCADED CASE CAST
    CATALOG CHANGE CHAR CHARACTER CHECK CHECKPOINT CLASS CLOB CLOSE
    CLUSTER CLUSTERED COALESCE COLLATE COLUMN COLUMNS COMMENT COMMIT
    COMMITTED COMPUTE CONNECT CONNECTION CONSTRAINT CONSTRAINTS
    CONTAINS CONTAINSTABLE CONTINUE CONVERT CORRESPONDING COUNT CREATE
    CROSS CUBE CURRENT CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP
    CURRENT_USER CURSOR CYCLE DATA DATABASE DATABASES DATE DAY DBCC
    DEALLOCATE DEC DECIMAL DECLARE DEFAULT DEFERRABLE DEFERRED
    DELETE DENY DEPTH DESC DESCRIBE DESCRIPTOR DETERMINISTIC DIAGNOSTICS
    DIRECTORY DISABLE DISCONNECT DISK DISTINCT DISTRIBUTED DM DOMAIN
    DOUBLE DROP DUMMY DUMP DYNAMIC EACH ELSE ENABLE ENCLOSED END
    ERRLVL ERROR ERRORS ESCAPE ESTIMATE EVENT EXCEPT EXCEPTION EXEC
    EXECUTE EXISTS EXIT EXPLAIN EXTERNAL EXTRACT FALSE FETCH FILE
    FILLFACTOR FIRST FLOAT FLUSH FOLLOWING FOR FOREIGN FORTRAN FOUND
    FREE FREEPAGECLS FREETEXT FREETEXTTABLE FROM FULL FUNCTION
    GENERAL GENERATED GET GLOBAL GO GOTO GRANT GROUP GROUPING HAVING
    HOLD HOUR IDENTITY IF IMMEDIATE IN INDEX INDEXES INDICATOR INFILE
    INHERIT INITIAL INITIALLY INNER INOUT INPUT INSENSITIVE INSERT
    INSTEAD INT INTEGER INTERSECT INTERVAL INTO IS ISOLATION ITERATE
    JOIN KEY KILL LANGUAGE LARGE LAST LATERAL LDR LEAKPROOF LEFT
    LEVEL LIKE LIMIT LINEAR LINENO LOAD LOCAL LOCALTRANS LOCATION
    LOCK LOGFILE LOGIN LOOP LOW_PRIORITY MAIN MANUAL MATCH MAXVALUE
    MESSAGE_BYTE_MULTIPLIER MERGE MINVALUE MINUS MODE MODIFIES
    MODIFY MODULE MONTH MOVE MULTISET NATURAL NCHAR NEW NEXT NO NODE
    NOCHECK NONCLUSTERED NONE NOT NULL NULLIF NUMBER NUMERIC OF OFFLINE
    OFFSET OFFSETROWS OLD ON ONLINE ONLY OPEN OPENDATASOURCE
    OPENQUERY OPENROWSET OPENXML OPERATION OPTION OR ORDER OUTER
    OUTPUT OVER OVERLAPS OVERRIDE OWNER PACKAGE PAGE PAGES PARAMETER
    PARTIAL PARTITION PARTITIONS PASSWORD PATH PERCENT PERCENTILE_CONT
    PERCENTILE_DISC PERM PERMANENT PIVOT PLAN PLSQL PRECISION
    PREDICT PREPARE PRESERVE PRIMARY PRINT PRIOR PRIVILEGES PROC
    PROCEDURE PROCESSAUTHID PUBLIC PURGE QUERY QUOTES RAISERROR RANGE
    READ READS READTEXT REAL REBUILD RECONFIGURE RECOVER RECURSIVE
    REF REFERENCES REFERENCING REGEXP REINDEX REJECT RELATIVE RELEASE
    RELOCATE RENAME REPEATABLE REPLICATION REQUIRE RES RESET RESIGNAL
    RESOURCE RESTART RESTORE RESTRICT RESULT RETURN RETURNS REVERSE
    REVOKE RIGHT ROLE ROLLBACK ROLLUP ROUTINE ROW ROWCOUNT ROWGUIDCOL
    ROWS RULE SAVE SAVEPOINT SCHEMA SCHEMAS SCOPE SCROLL SEARCH
    SECOND SECTION SECURITY SEGMENT SELECT SEQUENCE SESSION SESSION_USER
    SET SETUSER SHOW SHUTDOWN SIBLINGS SIGNAL SIMILAR SIZE SMALLINT
    SNAPSHOT SOME SORT SPACE SPECIFIC SPECIFICTYPE SQL SQLCODE SQLERROR
    SQLEXCEPTION SQLSTATE SQLWARNING STABLE STANDARD START STARTPOINT
    STATEMENT STATIC STATISTICS STATUS STAY STORAGE STRAIGHT_JOIN
    STRING STRUCTURE STYLE SUBCLASS_ORIGIN SUBJECT SUBTYPE SUPERUSER
    SUSPEND SWITCH SYMMETRIC SYNONYM SYSBACKUP SYSDBA SYSDG SYSOPR
    SYSOUT SYSTEM_USER TABLE TABLES TABLESAMPLE TABLESPACE TEMP TEMPLATE
    TEMPORARY TERMINATE TEXT TEXTSIZE THEN TIME TIMESTAMP TIMESTAMPADD
    TIMESTAMPDIFF TINYINT TO TOP TRAILING TRAN TRANSACTION TRANSFORM
    TRIGGER TRIGGERS TRUE TRUNCATE TRY TSEQUAL TYPE UNBOUNDED
    UNCOMMITTED UNDER UNDO UNION UNIQUE UNKNOWN UNLIMITED UNLOCK UNPIVOT
    UNTIL UPDATE UPDATETEXT UPGRADE UPPER USAGE USE USER USING VALUE
    VALUES VARBINARY VARCHAR VARIABLE VARYING VERIFY VERSION VIEW
    VIEWS WAIT WHEN WHENEVER WHERE WHILE WINDOW WITH WITHIN WITHOUT
    WORK WRITE WRITETEXT XACT_ABORT YEAR ZONE
  `,
  builtin: `
    AVG COUNT MAX MIN SUM
    ABS CEIL CEILING COALESCE CONCAT CONVERT COS COSH CURDATE CURTIME
    DATABASE DATADIFF DATENAME DATEPART DAY DB_NAME DEFAULT DELETE
    DIFFERENCE DISTINCT DM_SQL_CREATE_HUGE_TABLE DUAL
    EXISTS EXP FLOOR GETDATE GETUTCDATE GREATEST GROUPING
    HASH_BYTES IDENT_CURRENT IDENT_INCR IDENT_SEED IDENTITY INDEX
    ISDATE ISNULL ISNUMERIC LAG LEAD LEFT LEN LOG LOG10 LOWER LTRIM
    MONTH NCHAR NEWID NEWSEQUENTIALID NVL OPENQUERY OPENROWSET
    PARSE PATINDEX POWER QUOTENAME RAND REPLACE REPLICATE REVERSE
    RIGHT ROUND ROW_NUMBER RTRIM SESSION_USER SIGN SIN SINH SPACE
    SQRT SQUARE STUFF SUBSTRING SUM SUSER_SNAME SYSDATETIME
    SESSIONPREFIX SOUNDEX SPACE SQRT SQUARE STUFF SUBSTRING
    SYSTEM_USER TAN TANH TEXTVALID TO_CHAR TO_DATE TO_NUMBER
    TRANSACTION TRIM TYPE UPDATE UPPER USER USER_NAME VAR VARIANCE
    V$BUFFER_POOL_STATISTICS V$DATAFILE V$DEADLOCK_HISTORY V$INSTANCE
    V$LOCK V$MEMORY_INFO V$PARAMETER V$SESSION V$SESSIONS
    V$SQLAREA V$SQL_HISTORY V$SYSSTAT V$VERSION
    DBA_DATA_FILES DBA_SEGMENTS DBA_TABLES DBA_TABLESPACES
    ALL_TABLES ALL_TAB_COLUMNS USER_TABLES
    DM_INI DBMS_XPLAN PLAN_TABLE
  `,
  types: `
    BIGINT BINARY BIT BLOB BOOLEAN CHAR CLOB DATE DATETIME
    DEC DECIMAL DOUBLE FLOAT IDENTITY INT INTEGER INTERVAL
    MEDIUMINT NATIONAL NCHAR NUMBER NUMERIC NVARCHAR RAW
    REAL ROWID SERIAL SMALLINT TEXT TIME TIMESTAMP TINYINT
    VARCHAR VARCHAR2 VARRAY VARYING XML
  `,
  plsqlQuotingMechanism: true,
  doubleQuotedStrings: false,
  spaceAfterDashes: false,
  identifierQuotes: '"',
  caseInsensitiveIdentifiers: true,
});

/**
 * Oracle PL/SQL dialect for CodeMirror
 */
const OracleDialect = SQLDialect.define({
  keywords: `
    ABORT ABS ACCESS ADD AFTER ALL ALTER ANALYZE AND ANY ARCHIVE ARCHIVELOG AS
    ASC ASSOCIATE AT AUDIT AUTHORIZATION AUTOEXTEND BACKUP BECOME BEFORE BEGIN
    BETWEEN BLOCK BODY BULK BY CACHE CALL CANCEL CASCADE CASE CHANGE CHECK
    CHECKPOINT CLOSE CLUSTER COALESCE COLUMN COLUMNS COMMENT COMMIT COMMITTED
    COMPILE COMPOUND COMPUTE CONNECT CONNECTION CONSTRAINT CONSTRAINTS CONTAINS
    CONTENT CONTINUE CONTROLFILE CONVERT CORRUPTION COST COUNT CREATE CROSS
    CUBE CURRENT CURSOR CYCLE DATA DATABASE DATAFILE DATAFILES DAY DBA DEALLOCATE
    DEBUG DECLARE DEFAULT DEFERRABLE DEFERRED DELETE DENSE_RANK DESC DIRECTORY
    DISABLE DISCONNECT DISK DISMOUNT DISTINCT DISTRIBUTED DROP DUMP EACH ELSE
    ENABLE ENCRYPT END ESCAPE EVENT EXCEPT EXCEPTION EXCEPTIONS EXCLUDE EXECUTE
    EXISTS EXIT EXPLAIN EXTENT EXTERNALLY FAILED FETCH FILE FLASHBACK FOR FORALL
    FORCE FOREIGN FREELIST FREELISTS FREEPOOL FROM FULL FUNCTION GLOBAL GO GOTO
    GRANT GROUP GROUPING HASH HAVING HEAP HOUR IDENTIFIED IDENTITY IF IMMEDIATE
    IN INACTIVE INCLUDING INCREMENT INDEX INDEXES INDICATOR INITIAL INITIALLY
    INITRANS INSERT INSTANCE INSTEAD INT INTERSECT INTO INVALIDATE IS ISOLATION
    JAVA JOIN KEY KILL LANGUAGE LATERAL LEVEL LIBRARY LIKE LIMIT LINK LIST
    LOB LOCAL LOCK LOG LOGFILE LOGGING LOGICAL LOGON LOOP MAIN MANAGE MANAGED
    MASTER MATCHED MATERIALIZED MAXEXTENTS MAXSIZE MAXVALUE MEMBER MERGE MINEXTENTS
    MINIMIZE MINUS MINUTE MINVALUE MLSLABEL MODE MODEL MODIFY MONITOR MONTH
    MOUNT MOVE MOVEMENT MULTISET NATIONAL NATURAL NESTED NEW NEXT NO NOARCHIVELOG
    NOAUDIT NOCACHE NOCOMPRESS NOCYCLE NOFORCE NOLOGGING NOMAXVALUE NOMINVALUE
    NONE NOORDER NORELY NORESETLOGS NORMAL NOSORT NOT NOTFOUND NOWAIT NULL
    NULLS NUMBER NUMERIC OBJECT OF OFFLINE OFFSET OID OLTP ON ONLINE ONLY OPEN
    OPERATOR OPTIMAL OPTION OR ORDER ORACLE ORGANIZATION OTHERS OUT OUTLINE
    OVER OVERFLOW OVERLAPS OWN PACKAGE PARALLEL PARTITION PARTITIONS PASSWIDTH
    PASSWORD PCTFREE PCTINCREASE PCTTHRESHOLD PCTUSED PCTVERSION PERCENT PERCENTILE
    PERMANENT PFILE PIPELINED PIVOT PLAN PLS_INTEGER PRECISION PRESERVE PRIMARY
    PRIVATE PRIVILEGES PROCEDURE PROFILE PUBLIC PURGE QUERY QUOTA RANGE READ
    READS REBUILD RECOVER RECOVERY RECYCLE REDO REDUCED REF REFERENCES REFERENCING
    REGEXP REJECT RELY RENAME REPLACE RESET RESETLOGS RESOURCE RESTRICT RESTRICTED
    RESULT RESUMABLE RETURN RETURNING REUSE REVOKE RIGHT ROLE ROLLBACK ROLLUP
    ROW ROWID ROWNUM ROWS RULE SAMPLE SAVE SAVEPOINT SCAN SCHEMA SCHEMAS SCOPE
    SCN SEARCH SECOND SECTION SECURE SEGMENT SELECT SEQUENCE SEQUENTIAL SERIALIZABLE
    SESSION SET SHARED SHARD SHOW SHUTDOWN SIBLINGS SID SIGNAL SIZE SKIP SMALLFILE
    SNAPSHOT SOME SORT SPECIFICATION SPLIT SQL SQLCODE SQLDATA SQLERROR SQLEXCEPTION
    SQLSTATE SQLWARNING STANDBY START STATEMENT STATIC STATISTICS STORAGE STORE
    SUBTYPE SUCCESSFUL SWITCH SYNONYM SYSDATE SYSTEM TABLE TABLES TABLESPACE
    TABLESPACES TEMPFILE TEMPLATE TEMPORARY TEST THAN THE THEN THROUGH TIES TIME
    TIMESTAMP TO TRACE TRACKING TRANSACTION TRIGGER TRUNCATE TRUST TYPE UB2 UB4
    UGA UID UNARCHIVED UNBOUNDED UNDER UNDO UNION UNIQUE UNLIMITED UNLOCK UNPIVOT
    UNTIL UNUSABLE UPDATE UPPER UPSERT USAGE USE USER USING VALIDATE VALIDATION
    VALUE VALUES VARRAY VARYING VERSION VIEW WAIT WHEN WHENEVER WHERE WHILE WITH
    WITHIN WITHOUT WORK WRITE WRITES XID YEAR ZONE
  `,
  builtin: `
    ABS ADD_MONTHS ASCII ASIN ATAN AVG BFILENAME BIN_TO_NUM BITAND
    CAST CEIL CHARTOROWID CHR COALESCE COMPOSE CONCAT CONVERT CORR
    COSH COUNT COVAR_POP COVAR_SAMP CUME_DIST CURRENT_DATE CURRENT_TIMESTAMP
    CV DATE DAYS_BETWEEN DBTIMEZONE DECODE DECOMPOSE DENSE_RANK
    DEREF DUAL DUMP EMPTY_BLOB EMPTY_CLOB EXISTS EXP EXTRACT
    FIRST FIRST_VALUE FLOOR FOLLOWING GREATER GREATEST GROUPING GROUPING_ID
    HEXTORAW INITCAP INSTR INSTRB LAST LAST_DAY LAST_VALUE LATERAL
    LEAST LENGTH LENGTHB LN LOCALTIMESTAMP LOWER LPAD LTRIM
    MAKE_REF MAX MEDIAN MIN MOD MONTHS_BETWEEN NANVL NEW_TIME NEXT_DAY
    NLS_CHARSET_DECL_LEN NLS_CHARSET_ID NLS_CHARSET_NAME NLS_INITCAP NLS_LOWER
    NLS_SORT NLS_UPPER NLSSORT NULLIF NUMTODSINTERVAL NUMTOYMINTERVAL
    NVL NVL2 ORA_DST_AFFECT ORA_DST_CONVERT ORA_DST_ERROR ORA_HASH
    PATH PERCENT_RANK PERCENTILE_CONT PERCENTILE_DISC POWER PREDICTION
    PREDICTION_BOUNDS PREDICTION_COST PREDICTION_DETAILS PREDICTION_PROBABILITY
    PREDICTION_SET PRESENTNNV PRESENTV PREVIOUS PTF RANK RATIO_TO_REPORT
    RAWTOHEX RAWNUM RAWTOCHAR RAWTONHEX REMAINDER REPLACE
    ROUND ROW_NUMBER RPAD RTRIM SESSIONTIMEZONE SHA1 SHA2 SIGN SIN
    SINH SOUNDEX SQRT STDDEV STDDEV_POP STDDEV_SAMP SUBSTR SUBSTRB
    SUM SYSDATE SYSTIMESTAMP TABLE TAN TANH TIME TIMESTAMP
    TO_BINARY_DOUBLE TO_BINARY_FLOAT TO_CHAR TO_CLOB TO_DATE TO_DSINTERVAL
    TO_LOB TO_MULTI_BYTE TO_NCHAR TO_NCLOB TO_NUMBER TO_RAW TO_SINGLE_BYTE
    TO_TIMESTAMP TO_TIMESTAMP_TZ TO_YMINTERVAL TRANSLATE TRIM TRUNC TZ_OFFSET
    UI UID UNISTR UPDATEXML UPPER USER USERENV UUID VALUE VAR_POP
    VAR_SAMP VARIANCE VARYING VSIZE WIDTH_BUCKET XMLAGG XMLCAST XMLCOLATTVAL
    XMLCOMMENT XMLCONCAT XMLDIFF XMLELEMENT XMLEXISTS XMLFOREST XMLISVALID
    XMLNAMESPACES XMLPARSE XMLPI XMLQUERY XMLROOT XMLSEQUENCE XMLSERIALIZE
    XMLTABLE XMLTRANSFORM XMLWRITE YEAR
    V$ARCHIVE_DEST V$ARCHIVED_LOG V$ASM_DISK V$ASM_DISKGROUP V$BACKUP
    V$DATABASE V$DATAFILE V$DBLINK V$DIAG_INFO V$EVENT_NAME V$INSTANCE
    V$LOCK V$LOG V$LOGFILE V$LOG_HISTORY V$MYSTAT V$NLS_PARAMETERS
    V$PARAMETER V$PGASTAT V$PROCESS V$RECOVERY_FILE_DEST V$RECOVERY_LOG
    V$RESERVED_WORDS V$SESSION V$SESSION_LONGOPS V$SESSION_WAIT
    V$SGA V$SGASTAT V$SEGMENT_STATISTICS V$SQL V$SQL_PLAN V$SQLAREA
    V$SYSSTAT V$SYSTEM_EVENT V$TABLESPACE V$TEMPFILE V$THREAD
    V$TRANSACTION V$UNDOSTAT V$VERSION V$WAITSTAT
    ALL_ALL_TABLES ALL_CONS_COLUMNS ALL_CONSTRAINTS ALL_DB_LINKS ALL_DEF_AUDIT_OPTS
    ALL_INDEXES ALL_IND_COLUMNS ALL_OBJECTS ALL_SEQUENCES ALL_SOURCE ALL_SYNONYMS
    ALL_TAB_COLUMNS ALL_TAB_COMMENTS ALL_TAB_PRIVS ALL_TABLES ALL_TRIGGERS ALL_USERS
    ALL_VIEWS
    DBA_AUDIT_EXISTS DBA_AUDIT_OBJECT DBA_AUDIT_SESSION DBA_AUDIT_STATEMENT
    DBA_AUDIT_TRAIL DBA_DATA_FILES DBA_DDL_LOCKS DBA_DML_LOCKS
    DBA_ERRORS DBA_EXP_FILES DBA_EXP_OBJECTS DBA_EXTENTS DBA_FREE_SPACE
    DBA_HIST_ACTIVE_SESS_HISTORY DBA_HIST_SNAPSHOT DBA_HIST_SQLTEXT
    DBA_INDEXES DBA_IND_COLUMNS DBA_JOBS DBA_OBJECTS DBA_OBJ_AUDIT_OPTS
    DBA_PRIV_AUDIT_OPTS DBA_PROFILES DBA_ROLES DBA_ROLE_PRIVS DBA_SEGMENTS
    DBA_SEQUENCES DBA_SOURCE DBA_SYNONYMS DBA_SYS_AUDIT_OPTS DBA_SYS_PRIVS
    DBA_TAB_COLUMNS DBA_TAB_COMMENTS DBA_TAB_PRIVS DBA_TABLES DBA_TABLESPACES
    DBA_TRIGGERS DBA_TS_QUOTAS DBA_USERS DBA_VIEWS
    USER_ARGUMENTS USER_AUDIT_OBJECT USER_AUDIT_SESSION USER_AUDIT_STATEMENT
    USER_AUDIT_TRAIL USER_CATALOG USER_CLUSTERS USER_COL_COMMENTS USER_COL_PRIVS
    USER_CONSTRAINTS USER_CONS_COLUMNS USER_DB_LINKS USER_DEPENDENCIES
    USER_ERRORS USER_EXTENTS USER_FREE_SPACE USER_INDEXES USER_IND_COLUMNS
    USER_JOBS USER_OBJECTS USER_OBJ_AUDIT_OPTS USER_PASSWORD_LIMITS
    USER_PROCEDURES USER_ROLE_PRIVS USER_SEGMENTS USER_SEQUENCES USER_SNAPSHOTS
    USER_SOURCE USER_SYNONYMS USER_SYS_PRIVS USER_TAB_COLUMNS USER_TAB_COMMENTS
    USER_TAB_PRIVS USER_TABLES USER_TABLESPACES USER_TRIGGERS USER_TS_QUOTAS
    USER_TYPES USER_USERS USER_VIEWS
    DBMS_OUTPUT DBMS_SQL DBMS_XPLAN DBMS_WORKLOAD_REPOSITORY
    UTL_FILE UTL_HTTP UTL_SMTP UTL_TCP
    PLAN_TABLE DUAL
  `,
  types: `
    BFILE BINARY_BIGINT BINARY_DOUBLE BINARY_FLOAT BINARY_INTEGER
    BLOB BOOLEAN CHAR CHARACTER CLOB DATE DEC DECIMAL DOUBLE
    FIXED FLOAT INT INTEGER INTERVAL LARGE LONG MATERIALIZED
    MONTH NCHAR NCLOB NUMBER NUMERIC NVARCHAR2 NVARCHAR
    PLS_INTEGER PRECISION RAW REAL ROWID SECOND SIGNSMALLINT
    SMALLINT STRING TIMESTAMP TIME UROWID VARCHAR VARCHAR2 YEAR
    SYS_REFCURSOR XMLTYPE
  `,
  plsqlQuotingMechanism: true,
  doubleQuotedStrings: false,
  spaceAfterDashes: false,
  identifierQuotes: '"',
  caseInsensitiveIdentifiers: true,
});

interface InstanceOption { id: number; name: string; db_type: string; host: string; port: number; }
interface SchemaObject { schema: string; tables: Array<{ name: string; columns: Array<{ name: string; type: string; nullable: boolean }> }>; }
interface ExecuteResult { columns?: string[]; rows?: any[]; rowCount?: number; duration_ms?: number; error?: string; }

interface HistoryItem {
  id: string;
  sql: string;
  instanceName: string;
  instanceId: string;
  durationMs: number;
  rowCount: number;
  status: string;
  timestamp: number;
}

interface PlanNode {
  operation: string;
  rows: number;
  cost: number;
  children: PlanNode[];
  details: Record<string, any>;
}

interface Tab {
  id: string;
  name: string;
  sql: string;
  editorView: EditorView | null;
  result: ExecuteResult | null;
}

@customElement("sql-console-page")
export class SqlConsolePage extends LitElement {
  static styles = [sharedBtnStyles, css`
    :host { display: flex; flex-direction: column; height: calc(100vh - 120px); gap: var(--space-md); }
    .tab-bar { display: flex; align-items: center; gap: 2px; padding: var(--space-xs) var(--space-sm); background: var(--bg-elevated, #f9fafb); border: 1px solid var(--border, #e5e7eb); border-radius: var(--radius-md); overflow-x: auto; flex-shrink: 0; min-height: 36px; }
    .tab { display: flex; align-items: center; gap: var(--space-xs); padding: var(--space-xs) var(--space-md); border-radius: var(--radius-sm); cursor: pointer; font-size: var(--text-sm); color: var(--muted, #6b7280); white-space: nowrap; max-width: 160px; background: transparent; border: none; }
    .tab:hover { background: var(--bg-hover, rgba(0,0,0,0.04)); }
    .tab.active { color: var(--text-strong, #1a1a1e); background: var(--card, #fff); border: 1px solid var(--border, #e5e7eb); border-bottom: none; }
    .tab-label { overflow: hidden; text-overflow: ellipsis; cursor: text; }
    .tab-close { display: flex; align-items: center; justify-content: center; width: 16px; height: 16px; border: none; background: none; cursor: pointer; color: var(--muted, #9ca3af); padding: 0; font-size: var(--text-md); border-radius: var(--radius-sm); }
    .tab-close:hover { background: var(--danger-subtle, rgba(239,68,68,0.1)); color: var(--destructive, #ef4444); }
    .tab-add { display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; border: none; background: none; cursor: pointer; color: var(--muted, #6b7280); font-size: 16px; font-weight: 600; border-radius: var(--radius-sm); flex-shrink: 0; }
    .tab-add:hover { background: var(--accent-subtle, rgba(124,92,255,0.12)); color: var(--accent, #7c5cff); }
    .tab-rename-input { font-size: var(--text-sm); padding: 1px 4px; border: 1px solid var(--accent, #7c5cff); border-radius: var(--radius-sm); background: var(--card, #fff); color: var(--text, #3c3c43); outline: none; width: 120px; }
    .tab-warning { font-size: var(--text-xs); color: var(--warn, #b45309); margin-left: 8px; white-space: nowrap; }

    .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; }
    .modal { background: var(--card, #fff); border: 1px solid var(--border, #e5e7eb); border-radius: var(--radius-lg); width: 90%; max-width: 400px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
    .modal-header { display: flex; justify-content: space-between; align-items: center; padding: var(--space-lg) 20px; border-bottom: 1px solid var(--border, #e5e7eb); }
    .modal-title { font-size: var(--text-lg); font-weight: 600; color: var(--text-strong, #1a1a1e); }
    .modal-close { background: none; border: none; font-size: 20px; cursor: pointer; color: var(--muted, #6b7280); padding: 4px; line-height: 1; }
    .modal-body { padding: 20px; font-size: var(--text-md); color: var(--text, #3c3c43); }
    .modal-footer { display: flex; justify-content: flex-end; gap: var(--space-sm); padding: var(--space-lg) 20px; border-top: 1px solid var(--border, #e5e7eb); }

    .toolbar { display: flex; gap: var(--space-md); align-items: center; flex-shrink: 0; flex-wrap: wrap; background: var(--bg-elevated); }
    .toolbar select { padding: var(--space-sm) var(--space-md); border: 1px solid var(--border, #e5e7eb); border-radius: var(--radius-sm); font-size: var(--text-base); background: var(--card, #fff); color: var(--text, #333); min-width: 200px; }
    .shortcut { font-size: var(--text-xs); color: var(--muted, #6b7280); margin-left: 6px; }

    .main-area { display: flex; flex: 1; gap: var(--space-md); min-height: 0; }
    .browser { width: 240px; flex-shrink: 0; border: 1px solid var(--border, #e5e7eb); border-radius: var(--radius-md); overflow: auto; background: var(--card, #fff); }
    .browser-header { padding: var(--space-sm) var(--space-md); font-size: var(--text-sm); font-weight: 600; color: var(--muted, #6b7280); border-bottom: 1px solid var(--border, #e5e7eb); position: sticky; top: 0; background: var(--card, #fff); z-index: 1; }
    .editor-area { flex: 1; display: flex; flex-direction: column; min-width: 0; gap: var(--space-md); }
    .cm-wrap { border: 1px solid var(--border, #e5e7eb); border-radius: var(--radius-md); overflow: hidden; flex: 1; min-height: 150px; }
    .cm-wrap .cm-editor { height: 100%; }
    .cm-wrap .cm-editor .cm-scroller { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: var(--text-base); }

    /* Object tree */
    .tree-node { user-select: none; }
    .schema-name { padding: 6px 12px; font-size: var(--text-sm); font-weight: 700; color: var(--text-strong, #111); cursor: pointer; display: flex; align-items: center; gap: var(--space-xs); }
    .schema-name:hover { background: var(--bg-hover, #f3f4f6); }
    .table-name { padding: var(--space-xs) var(--space-md) 4px 24px; font-size: var(--text-sm); color: var(--text, #333); cursor: pointer; display: flex; align-items: center; gap: var(--space-xs); }
    .table-name:hover { background: var(--bg-hover, #f3f4f6); }
    .col-name { padding: 3px 12px 3px 36px; font-size: var(--text-xs); color: var(--muted, #6b7280); cursor: pointer; display: flex; justify-content: space-between; }
    .col-name:hover { background: var(--accent-subtle, #eff6ff); color: var(--accent, #3b82f6); }
    .col-type { font-size: 10px; color: var(--muted, #9ca3af); }
    .icon { width: 14px; height: 14px; opacity: .6; }

    .results { border: 1px solid var(--border, #e5e7eb); border-radius: var(--radius-md); overflow: hidden; max-height: 300px; display: flex; flex-direction: column; background: var(--card, #fff); }
    .results-header { padding: var(--space-sm) var(--space-md); font-size: var(--text-sm); border-bottom: 1px solid var(--border, #e5e7eb); display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }
    .results-scroll { overflow: auto; flex: 1; }
    .results table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
    .results th { position: sticky; top: 0; background: var(--bg-elevated, #f9fafb); padding: var(--space-sm) var(--space-md); text-align: left; font-weight: 600; border-bottom: 1px solid var(--border, #e5e7eb); z-index: 1; }
    .results th:hover { background: var(--accent-subtle, rgba(124,92,255,0.08)); }
    .results td { padding: var(--space-xs) var(--space-md); border-bottom: 1px solid var(--border, #e5e7eb); max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .results td.null { color: var(--muted, #9ca3af); font-style: italic; }
    .results-header-right { display: flex; align-items: center; gap: var(--space-md); }
    .page-info { font-size: var(--text-sm); color: var(--muted, #6b7280); white-space: nowrap; }
    .page-size-select { padding: var(--space-xs) var(--space-sm); border: 1px solid var(--border, #e5e7eb); border-radius: var(--radius-sm); font-size: var(--text-sm); background: var(--card, #fff); color: var(--text, #333); }
    .page-nav { display: flex; align-items: center; gap: var(--space-xs); }
    .page-btn { padding: 2px 8px; border: 1px solid var(--border, #e5e7eb); border-radius: var(--radius-sm); background: var(--card, #fff); color: var(--text, #333); font-size: var(--text-md); cursor: pointer; line-height: 1.4; }
    .page-btn:disabled { opacity: .4; cursor: not-allowed; }
    .page-btn:hover:not(:disabled) { background: var(--bg-elevated, #f9fafb); }
    .page-num { font-size: var(--text-sm); color: var(--muted, #6b7280); min-width: 40px; text-align: center; }
    .error-box { padding: var(--space-md) 16px; background: var(--danger-subtle, #fef2f2); border: 1px solid var(--destructive, #ef4444); border-radius: var(--radius-md); color: var(--destructive, #ef4444); font-size: var(--text-base); font-family: monospace; white-space: pre-wrap; }
    .approval-notice { padding: var(--space-md); background: var(--warn-subtle, #fffbeb); border: 1px solid var(--warn, #f59e0b); border-radius: var(--radius-md); font-size: var(--text-base); }
    .empty-state { padding: 40px; text-align: center; color: var(--muted, #6b7280); }
    .loading { padding: var(--space-lg); text-align: center; color: var(--muted, #6b7280); }

    /* Browser tabs (Schema/History toggle) */
    .browser-tabs { display: flex; border-bottom: 1px solid var(--border, #e5e7eb); flex-shrink: 0; }
    .browser-tab { flex: 1; padding: var(--space-sm) var(--space-md); font-size: var(--text-sm); font-weight: 600; cursor: pointer; border: none; background: none; color: var(--muted, #6b7280); border-bottom: 2px solid transparent; }
    .browser-tab.active { color: var(--accent, #7c5cff); border-bottom-color: var(--accent, #7c5cff); background: var(--accent-subtle, rgba(124,92,255,0.06)); }

    /* History panel */
    .history-panel { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
    .history-search { padding: var(--space-sm); flex-shrink: 0; }
    .history-search-input { width: 100%; padding: var(--space-sm) var(--space-md); border: 1px solid var(--border, #e5e7eb); border-radius: var(--radius-sm); font-size: var(--text-sm); background: var(--bg-elevated, #f9fafb); color: var(--text, #333); outline: none; box-sizing: border-box; }
    .history-search-input:focus { border-color: var(--accent, #7c5cff); }
    .history-instance-filter { width: 100%; padding: var(--space-sm) var(--space-md); border: 1px solid var(--border, #e5e7eb); border-radius: var(--radius-sm); font-size: var(--text-sm); background: var(--bg-elevated, #f9fafb); color: var(--text, #333); outline: none; box-sizing: border-box; margin-top: 6px; }
    .history-list { flex: 1; overflow-y: auto; padding: var(--space-xs) 0; }
    .history-item { padding: var(--space-sm) var(--space-md); cursor: pointer; border-bottom: 1px solid var(--border, #e5e7eb); transition: background .15s; }
    .history-item:hover { background: var(--accent-subtle, rgba(124,92,255,0.06)); }
    .history-sql { font-family: var(--mono, 'JetBrains Mono', monospace); font-size: var(--text-xs); color: var(--text, #333); white-space: pre; overflow: hidden; text-overflow: ellipsis; margin-bottom: 4px; }
    .history-meta { display: flex; gap: var(--space-sm); font-size: 10px; color: var(--muted, #6b7280); flex-wrap: wrap; }
    .history-time { margin-left: auto; }
    .history-empty { padding: 32px var(--space-lg); text-align: center; }
    .history-empty-icon { font-size: 18px; color: var(--muted, #9ca3af); margin-bottom: 6px; }
    .history-empty-text { font-size: var(--text-base); color: var(--muted, #6b7280); margin-bottom: 4px; }
    .history-empty-hint { font-size: var(--text-xs); color: var(--muted, #9ca3af); }
    .history-end { padding: var(--space-md); text-align: center; font-size: var(--text-xs); color: var(--muted, #9ca3af); }

    /* Plan tree */
    .plan-tree { font-family: var(--mono, 'JetBrains Mono', monospace); font-size: var(--text-sm); }
    .plan-node-row { display: flex; align-items: center; gap: var(--space-sm); padding: 6px 8px; cursor: pointer; border-radius: var(--radius-sm); margin: 2px 4px; transition: background .1s; }
    .plan-node-row:hover { background: var(--accent-subtle, rgba(124,92,255,0.08)); }
    .plan-chevron { width: 14px; flex-shrink: 0; color: var(--muted, #6b7280); font-size: 10px; }
    .plan-chevron-empty { width: 14px; }
    .plan-op { flex: 1; font-weight: 500; color: var(--text-strong, #1a1a1e); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .plan-stat { font-size: var(--text-xs); color: var(--muted, #6b7280); white-space: nowrap; flex-shrink: 0; }
    .plan-detail-badge { font-size: 10px; padding: 1px 6px; border-radius: 10px; background: var(--bg-elevated, #f9fafb); color: var(--muted, #6b7280); flex-shrink: 0; }
    .plan-children { margin-left: 22px; border-left: 1px solid var(--border, #e5e7eb); }

    /* Explain container */
    .explain-container { border: 1px solid var(--border, #e5e7eb); border-radius: var(--radius-md); overflow: hidden; background: var(--card, #fff); max-height: 400px; display: flex; flex-direction: column; }
    .explain-summary { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; background: var(--bg-elevated, #f9fafb); border-bottom: 1px solid var(--border, #e5e7eb); flex-shrink: 0; }
    .explain-summary-stats { display: flex; gap: 16px; font-size: var(--text-sm); color: var(--text, #333); }
    .explain-summary-stats strong { font-weight: 600; color: var(--text-strong, #1a1a1e); }
    .explain-grade { font-size: var(--text-sm); font-weight: 600; }
    .explain-toolbar { display: flex; justify-content: space-between; align-items: center; padding: 6px 14px; border-bottom: 1px solid var(--border, #e5e7eb); flex-shrink: 0; }
    .explain-toggle { display: flex; gap: 2px; background: var(--bg-elevated, #f9fafb); border-radius: var(--radius-sm); padding: 2px; }
    .explain-toggle-btn { padding: var(--space-xs) var(--space-md); font-size: var(--text-sm); font-weight: 500; border: none; background: transparent; color: var(--muted, #6b7280); cursor: pointer; border-radius: var(--radius-sm); }
    .explain-toggle-btn.active { background: var(--card, #fff); color: var(--text-strong, #1a1a1e); box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
    /* Plan table */
    .plan-table-scroll { overflow: auto; flex: 1; }
    .plan-table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
    .plan-table th { position: sticky; top: 0; background: var(--bg-elevated, #f9fafb); padding: var(--space-sm) var(--space-md); text-align: left; font-weight: 600; border-bottom: 1px solid var(--border, #e5e7eb); z-index: 1; font-size: var(--text-xs); }
    .plan-table td { padding: var(--space-xs) var(--space-md); border-bottom: 1px solid var(--border, #e5e7eb); font-family: var(--mono, 'JetBrains Mono', monospace); font-size: var(--text-xs); }
    .plan-table-detail { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted, #6b7280); }
    .plan-table tr:hover td { background: var(--accent-subtle, rgba(124,92,255,0.04)); }
  `];

  @state() private instances: InstanceOption[] = [];
  @state() private selectedId = 0;
  @state() private selectedDatabase: string = '';
  @state() private databases: string[] = [];
  @state() private schemas: SchemaObject[] = [];
  @state() private expandedSchemas = new Set<string>();
  @state() private expandedTables = new Set<string>();
  @state() private error: string | null = null;
  @state() private loading = false;
  @state() private approvalResult: any = null;
  @state() private objectsLoading = false;

  @state() private tabs: Tab[] = [];
  @state() private activeTabId: string = '';
  @state() private _editingTabId: string | null = null;
  @state() private _editingTabName: string = '';
  @state() private _showTabConfirm: string | null = null;
  @state() private sortColumn: string | null = null;
  @state() private sortDirection: 'asc' | 'desc' | null = null;
  @state() private pageSize: number | 'all' = 50;
  @state() private currentPage: number = 1;

  @state() private sidebarView: 'schema' | 'history' = 'schema';
  @state() private historyItems: HistoryItem[] = [];
  @state() private historyLoading = false;
  @state() private historySearch = '';
  @state() private historyInstanceFilter = 0;
  @state() private historyOffset = 0;
  @state() private historyTotal = 0;
  @state() private historyHasMore = true;

  @state() private explainData: PlanNode | null = null;
  @state() private explainViewMode: 'tree' | 'table' = 'tree';
  @state() private explainLoading = false;
  @state() private explainError: string | null = null;
  private _expandedNodes: Set<PlanNode> = new Set();

  private readonly STORAGE_KEY = 'sql-console-tabs';

  private get activeTab(): Tab | undefined {
    return this.tabs.find(t => t.id === this.activeTabId);
  }

  private _headers() {
    const t = localStorage.getItem("token");
    return t ? { "Content-Type": "application/json", Authorization: `Bearer ${t}` } : { "Content-Type": "application/json" };
  }

  override connectedCallback() {
    super.connectedCallback();
    this.loadInstances();
    document.addEventListener("keydown", this._globalKeyHandler);
    this._restoreTabs();
  }
  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("keydown", this._globalKeyHandler);
  }

  private _globalKeyHandler = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && this.selectedId) {
      e.preventDefault(); this._execute();
    }
  };

  override firstUpdated() {
    if (this.tabs.length > 0 && this.activeTabId) {
      this._switchTab(this.activeTabId);
    } else if (this.tabs.length > 0) {
      this._switchTab(this.tabs[0].id);
    }
  }

  private _switchTab(tabId: string) {
    const container = this.renderRoot.querySelector(".cm-wrap") as HTMLElement;
    if (!container) return;

    container.innerHTML = "";

    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;
    this.activeTabId = tabId;

    if (!tab.editorView) {
      const instance = this.instances.find(i => i.id === this.selectedId);
      const selectedDialect = instance?.db_type === 'oracle' ? OracleDialect
        : instance?.db_type === 'dameng' ? DamengDialect
        : MySQL;
      tab.editorView = new EditorView({
        state: EditorState.create({
          doc: tab.sql,
          extensions: [
            basicSetup,
            sql({ dialect: selectedDialect, upperCaseKeywords: selectedDialect === OracleDialect || selectedDialect === DamengDialect }),
            oneDark,
            autocompletion({ override: [this._sqlCompletions.bind(this)] }),
            EditorView.updateListener.of((update) => { this.requestUpdate(); if (update.docChanged) this._saveTabs(); }),
          ],
        }),
        parent: container as HTMLElement,
      });
      this.tabs = [...this.tabs];
    } else {
      container.appendChild(tab.editorView.dom);
    }
    tab.editorView.focus();
  }

  private _createTab(sql?: string) {
    const id = 'tab_' + Date.now();
    let name: string;
    if (sql && sql.trim()) {
      const firstLine = sql.trim().split('\n')[0];
      name = firstLine.length > 40 ? firstLine.slice(0, 40) + '...' : firstLine;
    } else {
      name = `标签 ${this.tabs.length + 1}`;
    }
    const newTab: Tab = { id, name, sql: sql || '', editorView: null, result: null };
    this.tabs = [...this.tabs, newTab];
    this._switchTab(id);

    if (this.tabs.length >= 10) {
      // Warning rendered in template
    }
    this._saveTabs();
  }

  private _closeTab(tabId: string, force = false) {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;

    const hasContent = tab.editorView && tab.editorView.state.doc.toString().trim().length > 0;

    if (hasContent && !force) {
      this._showTabConfirm = tabId;
      return;
    }

    if (tab.editorView) {
      tab.editorView.destroy();
      tab.editorView = null;
    }

    this.tabs = this.tabs.filter(t => t.id !== tabId);

    if (this.tabs.length === 0) {
      this._createTab('');
      return;
    }

    if (this.activeTabId === tabId) {
      this._switchTab(this.tabs[0].id);
    }

    this._saveTabs();
  }

  private _saveTabs() {
    const data = {
      tabs: this.tabs.map(t => ({
        id: t.id,
        name: t.name,
        sql: t.editorView ? t.editorView.state.doc.toString() : (t.sql || ''),
      })),
      activeId: this.activeTabId,
      instanceId: this.selectedId,
    };
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(data));
  }

  private _restoreTabs() {
    const raw = localStorage.getItem(this.STORAGE_KEY);
    if (!raw) {
      this._createTab('');
      return;
    }
    try {
      const data = JSON.parse(raw);
      if (data.instanceId) this._selectInstance(data.instanceId);
      this.tabs = data.tabs.map((t: any) => ({
        id: t.id,
        name: t.name,
        sql: t.sql,
        editorView: null,
        result: null,
      }));
      this.activeTabId = data.activeId || (this.tabs.length > 0 ? this.tabs[0].id : '');
      if (this.tabs.length === 0) {
        this._createTab('');
      }
    } catch {
      this._createTab('');
    }
  }

  private _startRename(tabId: string, currentName: string) {
    this._editingTabId = tabId;
    this._editingTabName = currentName;
  }

  private _finishRename() {
    if (this._editingTabId) {
      const tab = this.tabs.find(t => t.id === this._editingTabId);
      if (tab) {
        tab.name = this._editingTabName || tab.name;
        this.tabs = [...this.tabs];
        this._saveTabs();
      }
      this._editingTabId = null;
    }
  }

  private _sqlCompletions(context: CompletionContext): import("@codemirror/autocomplete").CompletionResult | null {
    const word = context.matchBefore(/[\w$.一-鿿]+/);
    if (!word) return null;
    const from = word.from;
    const textBefore = context.state.sliceDoc(0, context.pos);

    const completions: Completion[] = [];
    for (const schema of this.schemas || []) {
      for (const table of (schema as any).tables || []) {
        completions.push({
          label: table.name,
          type: 'keyword',
          detail: `${(schema as any).schema || table.schema || 'public'}.${table.name}`,
        });
        const afterDot = textBefore.match(/(\w+)\.\w*$/);
        if (afterDot) {
          const tableAlias = afterDot[1];
          const matchedTable = (schema as any).tables?.find((t: any) =>
            t.name === tableAlias || t.alias === tableAlias
          );
          if (matchedTable) {
            for (const col of (matchedTable.columns || [])) {
              completions.push({
                label: col.name,
                type: 'property',
                detail: col.type || 'column',
              });
            }
          }
        }
      }
    }

    if (completions.length === 0) {
      completions.push(
        { label: 'SELECT', type: 'keyword' }, { label: 'FROM', type: 'keyword' },
        { label: 'WHERE', type: 'keyword' }, { label: 'JOIN', type: 'keyword' },
        { label: 'LEFT JOIN', type: 'keyword' }, { label: 'INNER JOIN', type: 'keyword' },
        { label: 'INSERT', type: 'keyword' }, { label: 'UPDATE', type: 'keyword' },
        { label: 'DELETE', type: 'keyword' }, { label: 'GROUP BY', type: 'keyword' },
        { label: 'ORDER BY', type: 'keyword' }, { label: 'HAVING', type: 'keyword' },
        { label: 'LIMIT', type: 'keyword' }, { label: 'OFFSET', type: 'keyword' },
        { label: 'AS', type: 'keyword' }, { label: 'ON', type: 'keyword' },
        { label: 'AND', type: 'keyword' }, { label: 'OR', type: 'keyword' },
        { label: 'IN', type: 'keyword' }, { label: 'BETWEEN', type: 'keyword' },
        { label: 'LIKE', type: 'keyword' }, { label: 'IS NULL', type: 'keyword' },
        { label: 'IS NOT NULL', type: 'keyword' }, { label: 'DISTINCT', type: 'keyword' },
        { label: 'UNION', type: 'keyword' }, { label: 'EXPLAIN', type: 'keyword' },
      );
    }

    return { from, options: completions };
  }

  private getSQL(): string {
    return this.activeTab?.editorView?.state.doc.toString() || "";
  }

  private setSQL(sql: string) {
    const editor = this.activeTab?.editorView;
    if (!editor) return;
    const tx = editor.state.update({
      changes: { from: 0, to: editor.state.doc.length, insert: sql },
      selection: { anchor: sql.length },
    });
    editor.dispatch(tx);
    editor.focus();
  }

  private async _loadHistory(reset: boolean = false) {
    if (this.historyLoading || (!this.historyHasMore && !reset)) return;
    if (reset) { this.historyOffset = 0; this.historyItems = []; this.historyHasMore = true; }
    this.historyLoading = true;
    try {
      const instanceFilter = this.historyInstanceFilter;
      const params = new URLSearchParams({
        limit: '50',
        offset: String(this.historyOffset),
        search: this.historySearch,
      });
      const res = await fetch(`/api/database/instances/${instanceFilter}/query-history?${params}`, {
        headers: this._headers(),
      });
      if (!res.ok) throw new Error('加载失败');
      const data = await res.json();
      if (reset) {
        this.historyItems = data.items;
      } else {
        this.historyItems = [...this.historyItems, ...data.items];
      }
      this.historyTotal = data.total;
      this.historyOffset += data.items.length;
      this.historyHasMore = this.historyItems.length < data.total;
    } catch {
      // silently fail — history is best-effort
    }
    this.historyLoading = false;
  }

  private _onHistoryScroll(e: Event) {
    const el = e.target as HTMLElement;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 100) {
      this._loadHistory(false);
    }
  }

  private _loadHistorySQL(sql: string) {
    const activeTab = this.tabs.find(t => t.id === this.activeTabId);
    if (!activeTab || !activeTab.editorView) return;
    const editor = activeTab.editorView;
    const tx = editor.state.update({
      changes: { from: 0, to: editor.state.doc.length, insert: sql },
      selection: { anchor: sql.length },
    });
    editor.dispatch(tx);
    editor.focus();
    this.requestUpdate();
  }

  private async loadInstances() {
    try {
      const res = await fetch("/api/database/instances", { headers: this._headers() });
      if (res.ok) this.instances = await res.json();
    } catch { /* */ }
  }

  private async _selectInstance(id: number) {
    this.selectedId = id;
    this.selectedDatabase = '';
    this.schemas = [];
    this.databases = [];
    if (!id) return;
    this.objectsLoading = true;
    this._loadDatabases();
    try {
      const res = await fetch(`/api/database/instances/${id}/schema-objects`, { headers: this._headers() });
      if (res.ok) {
        this.schemas = await res.json();
        this.expandedSchemas = new Set(this.schemas.map(s => s.schema));
      }
    } catch { /* */ }
    this.objectsLoading = false;
  }

  private async _loadDatabases() {
    if (!this.selectedId) return;
    try {
      const res = await fetch(`/api/database/instances/${this.selectedId}/databases`, { headers: this._headers() });
      if (res.ok) this.databases = await res.json();
    } catch (_) { this.databases = []; }
  }

  private _toggleSchema(schema: string) {
    const s = new Set(this.expandedSchemas);
    s.has(schema) ? s.delete(schema) : s.add(schema);
    this.expandedSchemas = s;
  }
  private _toggleTable(key: string) {
    const s = new Set(this.expandedTables);
    s.has(key) ? s.delete(key) : s.add(key);
    this.expandedTables = s;
  }

  private _quoteIdentifier(name: string): string {
    const instance = this.instances.find(i => i.id === this.selectedId);
    const dbType = instance?.db_type;
    if (dbType === 'mysql') return `\`${name}\``;
    if (dbType === 'postgresql' || dbType === 'oracle' || dbType === 'dameng') return `"${name}"`;
    return `"${name}"`;
  }
  private _insertTable(table: string) { this.setSQL(this.getSQL() + this._quoteIdentifier(table)); }
  private _insertColumn(col: string) { this.setSQL(this.getSQL() + this._quoteIdentifier(col)); }

  private isDangerous(sql: string) {
    return /\b(DROP|TRUNCATE|ALTER\s+(TABLE|DATABASE|SCHEMA)|CREATE\s+(TABLE|DATABASE|SCHEMA|INDEX)|GRANT|REVOKE|DELETE\b(?!\s+FROM\s*$)|UPDATE\b(?!\s+\w+\s+SET\s*$)|INSERT\b(?!\s+INTO\s*$))\b/i.test(sql);
  }

  private async _execute() {
    if (!this.selectedId) return;
    const sql = this.getSQL().trim();
    if (!sql) return;
    this.loading = true;
    this.sortColumn = null;
    this.sortDirection = null;
    this.currentPage = 1;
    this.error = null;
    this.approvalResult = null;
    if (this.activeTab) {
      this.activeTab.result = null;
      this.tabs = [...this.tabs];
    }

    if (this.isDangerous(sql)) {
      await this._submitApproval(sql);
    } else {
      await this._directExecute(sql);
    }
    this.loading = false;
  }

  private async _directExecute(sql: string) {
    try {
      const res = await fetch(`/api/database/instances/${this.selectedId}/execute`, {
        method: "POST", headers: this._headers(), body: JSON.stringify({ sql, database: this.selectedDatabase || undefined }),
      });
      const data = await res.json();
      if (data.success && this.activeTab) {
        this.activeTab.result = data;
        this.tabs = [...this.tabs];
        this._loadHistory(true);
      } else {
        this.error = data.error || "执行失败";
      }
    } catch (e: any) { this.error = e.message; }
  }

  private async _submitApproval(sql: string) {
    try {
      const res = await fetch("/api/approval/submit", {
        method: "POST", headers: this._headers(),
        body: JSON.stringify({ instance_id: this.selectedId, sql_text: sql, database_name: this.selectedDatabase || undefined }),
      });
      const data = await res.json();
      if (data.requires_approval) this.approvalResult = data;
      else if (data.auto_approved) await this._directExecute(sql);
    } catch (e: any) { this.error = e.message; }
  }

  private _formatSQL() {
    const sql = this.getSQL();
    const formatted = sql
      .replace(/\b(SELECT|FROM|WHERE|AND|OR|ORDER BY|GROUP BY|HAVING|LIMIT|JOIN|LEFT JOIN|INNER JOIN|ON|SET|VALUES)\b/gi, '\n$1')
      .replace(/\n\s*\n/g, '\n').trim();
    this.setSQL(formatted);
  }

  private _toggleSort(column: string) {
    if (this.sortColumn !== column) {
      this.sortColumn = column;
      this.sortDirection = 'asc';
    } else if (this.sortDirection === 'asc') {
      this.sortDirection = 'desc';
    } else if (this.sortDirection === 'desc') {
      this.sortColumn = null;
      this.sortDirection = null;
    }
    this.requestUpdate();
  }

  private _sortRows(rows: any[]): any[] {
    if (!this.sortColumn || !this.sortDirection) return rows;
    const col = this.sortColumn;
    const dir = this.sortDirection;
    const sorted = [...rows];
    sorted.sort((a, b) => {
      const va = a[col], vb = b[col];
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      const na = Number(va), nb = Number(vb);
      const cmp = !isNaN(na) && !isNaN(nb) ? na - nb : String(va).localeCompare(String(vb));
      return dir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }

  private _changePageSize(size: number | 'all') {
    this.pageSize = size;
    this.currentPage = 1;
    this.requestUpdate();
  }

  private _goToPage(page: number) {
    this.currentPage = page;
    this.requestUpdate();
  }

  private _exportCSV() {
    const r = this.activeTab?.result;
    if (!r?.columns || !r?.rows) return;
    try {
      const cols = r.columns;
      const rows = this._sortRows(r.rows);
      const escape = (v: any): string => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        if (/[",\n\r]/.test(s)) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      };
      const header = cols.map(c => escape(c)).join(',');
      const data = rows.map(row =>
        cols.map(c => escape(row[c])).join(',')
      );
      const csv = [header, ...data].join('\r\n');

      const BOM = '﻿';
      const blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8;' });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const instanceName = this.instances.find(i => i.id === this.selectedId)?.name || 'unknown';
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
      a.download = `query-result-${instanceName}-${timestamp}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      // CSV export failure — silently handled
    }
  }

  /* ---- EXPLAIN normalizer ---- */

  private _explainNormalizer(plan: any, dbType: string): PlanNode {
    if (dbType === 'mysql' || dbType === 'mariadb') {
      const result = this._normalizeMySQLPlan(plan);
      if (result.operation !== 'No plan data available') return result;
      const fallback = this._tryGenericPlan(plan, dbType);
      if (fallback) return fallback;
      return result;
    }
    if (dbType === 'postgresql') {
      const result = this._normalizePGPlan(plan);
      if (result.operation !== 'unknown') return result;
      const fallback = this._tryGenericPlan(plan, dbType);
      if (fallback) return fallback;
      return result;
    }
    const fallback = this._tryGenericPlan(plan, dbType);
    if (fallback) return fallback;
    return { operation: 'unknown', rows: 0, cost: 0, children: [], details: {} };
  }

  private _normalizeMySQLPlan(plan: any): PlanNode {
    const qb = plan.query_block;
    if (!qb) {
      const qp = plan.query_plan;
      if (qp && Object.keys(qp).length > 0) {
        const rows = Number(qp.estimated_rows || qp.rows || qp.rows_examined_per_scan || 0);
        const cost = Number(qp.estimated_total_cost || qp.cost || qp.query_cost || 0);
        const details = {};
        if (qp.index_used) details['Index'] = qp.index_used;
        if (qp.key_len) details['Key Length'] = qp.key_len;
        return { operation: qp.operation || qp.type || qp.access_type || 'Table Scan', rows, cost, children: [], details };
      }
      return { operation: 'No plan data available', rows: 0, cost: 0, children: [], details: {} };
    }
    return this._normalizeMySQLNode(qb);
  }

  private _normalizeMySQLNode(node: any): PlanNode {
    const operation = node.materialized ? 'Materialize' :
                      node.union_result ? 'UNION RESULT' :
                      node.table?.table_name || (node.select_id ? 'Query #' + node.select_id : 'Table Scan');
    const accessType = node.table?.access_type || '';
    const fullOp = accessType ? `${accessType}${node.table?.table_name ? ' on ' + node.table.table_name : ''}` : operation;
    const rows = node.table?.rows_examined_per_scan || node.rows || 0;
    const cost = node.cost_info?.query_cost ? parseFloat(node.cost_info.query_cost) : (node.query_cost ? parseFloat(node.query_cost) : 0);
    const details: Record<string, any> = {};
    if (node.table?.key) details['Index'] = node.table.key;
    else if (node.key) details['Index'] = node.key;
    if (node.table?.key_len) details['Key Length'] = node.table.key_len;
    else if (node.key_len) details['Key Length'] = node.key_len;
    if (node.table?.ref) details['Ref'] = node.table.ref;
    else if (node.ref) details['Ref'] = node.ref;
    if (node.table?.filtered) details['Filtered %'] = node.table.filtered;
    if (node.table?.using_index) details['Using Index'] = true;
    if (node.table?.using_where) details['Using Where'] = true;
    if (node.table?.using_temporary) details['Using Temporary'] = true;
    if (node.table?.using_filesort) details['Using Filesort'] = true;
    if (node.possible_keys) details['Possible Keys'] = node.possible_keys;

    const children: PlanNode[] = [];
    if (node.union_result?.table_list) {
      for (const tbl of node.union_result.table_list) {
        children.push(this._normalizeMySQLNode(tbl));
      }
    }
    if (node.table?.table_name && node.nested_loop) {
      for (const nl of node.nested_loop) {
        children.push(this._normalizeMySQLNode(nl));
      }
    }

    return {
      operation: accessType ? `${accessType.toUpperCase()}${node.table?.table_name ? ' ' + node.table.table_name : ''}` : fullOp,
      rows: Number(rows),
      cost: cost,
      children,
      details,
    };
  }

  private _normalizePGPlan(plan: any): PlanNode {
    const pgRoot = Array.isArray(plan) ? plan[0] : plan;
    const planRoot = pgRoot?.Plan || pgRoot;
    if (!planRoot) return { operation: 'unknown', rows: 0, cost: 0, children: [], details: {} };
    return this._normalizePGNode(planRoot);
  }

  private _normalizePGNode(node: any): PlanNode {
    const operation = node['Node Type'] || 'unknown';
    const rows = node['Plan Rows'] || 0;
    const cost = node['Total Cost'] || node['Startup Cost'] || 0;
    const details: Record<string, any> = {};
    if (node['Relation Name']) details['Relation'] = node['Relation Name'];
    if (node['Alias']) details['Alias'] = node['Alias'];
    if (node['Index Name']) details['Index'] = node['Index Name'];
    if (node['Join Type']) details['Join Type'] = node['Join Type'];
    if (node['Filter']) details['Filter'] = node['Filter'];
    if (node['Index Cond']) details['Index Cond'] = node['Index Cond'];
    if (node['Subplan Name']) details['Subplan'] = node['Subplan Name'];
    if (node['Operation']) details['Operation'] = node['Operation'];

    const children: PlanNode[] = (node['Plans'] || []).map((child: any) => this._normalizePGNode(child));
    return { operation, rows: Number(rows), cost: Number(cost), children, details };
  }

  /* ---- Generic fallback normalizer (2d) ---- */

  private _tryGenericPlan(plan: any, dbType: string): PlanNode | null {
    if (!plan || typeof plan !== 'object') return null;

    if (plan.query) {
      return this._explainNormalizer(plan.query, 'mysql');
    }
    if (plan.execution_plan) {
      return this._explainNormalizer(plan.execution_plan, 'postgresql');
    }
    if (plan.executionPlan) {
      return this._explainNormalizer(plan.executionPlan, 'postgresql');
    }
    if (Array.isArray(plan)) {
      if (plan.length > 0) {
        const root = this._explainNormalizer(plan[0], dbType);
        for (let i = 1; i < plan.length; i++) {
          const child = this._explainNormalizer(plan[i], dbType);
          if (child.operation !== 'unknown') {
            root.children.push(child);
          }
        }
        return root;
      }
    }

    return null;
  }

  /* ---- Efficiency grade ---- */

  private _efficiencyGrade(node: PlanNode): { grade: string; color: string; label: string } {
    const op = node.operation.toLowerCase();
    if (op.includes('index') && !op.includes('full scan')) {
      return { grade: 'good', color: 'var(--ok, #15803d)', label: '索引扫描 — 效率高' };
    }
    if (op.includes('full table scan') || op.includes('seq scan')) {
      return { grade: 'warn', color: 'var(--warn, #b45309)', label: '全表扫描 — 需检查索引' };
    }
    if (op.includes('temporary') || op.includes('temp')) {
      return { grade: 'warn', color: 'var(--warn, #b45309)', label: '临时表 — 需优化' };
    }
    if (op.includes('filesort') || op.includes('sort')) {
      return { grade: 'warn', color: 'var(--warn, #b45309)', label: '文件排序 — 可优化' };
    }
    if (op.includes('const') || op.includes('eq_ref')) {
      return { grade: 'good', color: 'var(--ok, #15803d)', label: '等值匹配 — 高效' };
    }
    if (node.children.length > 0) {
      const childGrades = node.children.map(c => this._efficiencyGrade(c));
      const worst = childGrades.reduce((worst, cur) => cur.grade === 'warn' ? cur : worst, childGrades[0]);
      return worst;
    }
    return { grade: 'good', color: 'var(--ok, #15803d)', label: '常规扫描 — 效率良好' };
  }

  private _calculateSummary(node: PlanNode): { totalCost: number; totalRows: number; grade: string } {
    let totalCost = node.cost;
    let totalRows = node.rows;
    for (const child of node.children) {
      const childSummary = this._calculateSummary(child);
      totalCost += childSummary.totalCost;
      totalRows += childSummary.totalRows;
    }
    return { totalCost, totalRows, grade: this._efficiencyGrade(node).label };
  }

  /* ---- Tree view renderer ---- */

  private _togglePlanNode(node: PlanNode) {
    const s = new Set(this._expandedNodes);
    s.has(node) ? s.delete(node) : s.add(node);
    this._expandedNodes = s;
    this.requestUpdate();
  }

  private _renderPlanTree(node: PlanNode, depth: number = 0) {
    const isExpanded = this._expandedNodes.has(node);
    return html`
      <div class="plan-node" style="--depth: ${depth}">
        <div class="plan-node-row" @click=${() => this._togglePlanNode(node)}>
          ${node.children.length > 0 ? html`
            <span class="plan-chevron">${isExpanded ? '▾' : '▸'}</span>
          ` : html`<span class="plan-chevron plan-chevron-empty"></span>`}
          <span class="plan-op">${node.operation}</span>
          <span class="plan-stat">${Number(node.rows).toLocaleString()} 行</span>
          <span class="plan-stat">成本 ${Number(node.cost).toLocaleString()}</span>
          ${node.details && Object.keys(node.details).length > 0 ? html`
            <span class="plan-detail-badge" title=${Object.entries(node.details).map(([k, v]) => `${k}: ${v}`).join(' | ')}>
              ${Object.keys(node.details).length} 详情
            </span>
          ` : ''}
        </div>
        ${isExpanded && node.children.length > 0 ? html`
          <div class="plan-children">
            ${node.children.map(child => this._renderPlanTree(child, depth + 1))}
          </div>
        ` : ''}
      </div>
    `;
  }

  /* ---- EXPLAIN fetch ---- */

  private async _fetchExplain() {
    const sql = this.getSQL().trim();
    if (!sql || !this.selectedId) return;
    this.explainLoading = true;
    this.explainError = null;
    this.explainData = null;
    try {
      const res = await fetch(`/api/database/instances/${this.selectedId}/explain?sql=${encodeURIComponent(sql)}`, {
        headers: this._headers(),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || '获取执行计划失败');
      }
      const resp = await res.json();
      const plan = resp.plan || resp;
      if (plan.error) throw new Error(plan.error || '无法获取执行计划');
      const instance = this.instances.find(i => i.id === this.selectedId);
      const dbType = resp.db_type || instance?.db_type || 'mysql';
      this.explainData = this._explainNormalizer(plan, dbType);
      this._expandedNodes = new Set([this.explainData]); // root expanded by default
    } catch (e: any) {
      this.explainError = e.message;
    }
    this.explainLoading = false;
  }

  /* ---- Table view ---- */

  private _flattenPlan(node: PlanNode, depth: number = 0): Array<{ operation: string; rows: number; cost: number; details: string; depth: number }> {
    const items: Array<{ operation: string; rows: number; cost: number; details: string; depth: number }> = [];
    const detailStr = Object.entries(node.details).map(([k, v]) => `${k}: ${v}`).join('; ');
    items.push({ operation: node.operation, rows: node.rows, cost: node.cost, details: detailStr, depth });
    for (const child of node.children) {
      items.push(...this._flattenPlan(child, depth + 1));
    }
    return items;
  }

  private _renderPlanTable(node: PlanNode) {
    const flatItems = this._flattenPlan(node);
    return html`
      <div class="plan-table-scroll">
        <table class="plan-table">
          <thead>
            <tr>
              <th>操作</th>
              <th style="text-align:center">行数</th>
              <th style="text-align:center">成本</th>
              <th>详情</th>
            </tr>
          </thead>
          <tbody>
            ${flatItems.map(item => html`
              <tr>
                <td style="padding-left: ${item.depth * 20 + 8}px">${item.operation}</td>
                <td style="text-align:center">${Number(item.rows).toLocaleString()}</td>
                <td style="text-align:center">${Number(item.cost).toLocaleString()}</td>
                <td class="plan-table-detail" title=${item.details}>${item.details || '-'}</td>
              </tr>
            `)}
          </tbody>
        </table>
      </div>
    `;
  }

  override render() {
    const instance = this.instances.find(i => i.id === this.selectedId);
    const r = this.activeTab?.result;
    return html`
      <div class="tab-bar">
        ${this.tabs.map(tab => html`
          <div class="tab ${tab.id === this.activeTabId ? 'active' : ''}" @click=${() => this._switchTab(tab.id)}>
            ${this._editingTabId === tab.id
              ? html`<input class="tab-rename-input" .value=${this._editingTabName}
                  @input=${(e: InputEvent) => { this._editingTabName = (e.target as HTMLInputElement).value; }}
                  @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') this._finishRename(); if (e.key === 'Escape') this._editingTabId = null; }}
                  @blur=${this._finishRename} @click=${(e: Event) => e.stopPropagation()} />`
              : html`<span class="tab-label" @dblclick=${() => this._startRename(tab.id, tab.name)}>${tab.name}</span>`
            }
            <button class="tab-close" @click=${(e: Event) => { e.stopPropagation(); this._closeTab(tab.id); }}>${icons['x']}</button>
          </div>
        `)}
        <button class="tab-add" @click=${() => this._createTab('')}>+</button>
        ${this.tabs.length >= 10 ? html`<span class="tab-warning">已打开 ${this.tabs.length} 个标签页，建议关闭不再使用的标签</span>` : ''}
      </div>

      ${this._showTabConfirm ? html`
        <div class="modal-overlay" @click=${(e: Event) => { if ((e.target as HTMLElement).classList.contains('modal-overlay')) this._showTabConfirm = null; }}>
          <div class="modal">
            <div class="modal-header">
              <span class="modal-title">确认关闭</span>
              <button class="modal-close" @click=${() => this._showTabConfirm = null}>${icons['x']}</button>
            </div>
            <div class="modal-body">
              <p>关闭标签页后将丢失未保存的 SQL 内容，确认关闭？</p>
            </div>
            <div class="modal-footer">
              <button class="btn" @click=${() => this._showTabConfirm = null}>取消</button>
              <button class="btn primary" @click=${() => { const id = this._showTabConfirm; this._showTabConfirm = null; this._closeTab(id!, true); }}>确认关闭</button>
            </div>
          </div>
        </div>
      ` : ''}

      <div class="toolbar">
        <select @change=${(e: Event) => this._selectInstance(Number((e.target as HTMLSelectElement).value))}>
          <option value="0">选择数据库实例...</option>
          ${this.instances.map(i => html`
            <option value=${i.id} ?selected=${i.id === this.selectedId}>${i.name} (${i.db_type?.toUpperCase()} @ ${i.host}:${i.port})</option>
          `)}
        </select>
        <select @change=${(e: Event) => { this.selectedDatabase = (e.target as HTMLSelectElement).value; }}
                ?disabled=${!this.selectedId}>
          <option value="">选择数据库...</option>
          ${this.databases.map(db => html`
            <option value=${db} ?selected=${this.selectedDatabase === db}>${db}</option>
          `)}
        </select>
        <button class="btn btn-execute" ?disabled=${this.loading || !this.selectedId} @click=${this._execute}>
          ${this.loading ? "执行中..." : "执行"} <span class="shortcut">Ctrl+Enter</span>
        </button>
        <button class="btn btn-explain" ?disabled=${this.explainLoading || !this.selectedId || !this.getSQL().trim()} @click=${this._fetchExplain}>
          ${this.explainLoading ? "分析中..." : html`${icons['eye']} 分析计划`}
        </button>
        <button class="btn btn-format" @click=${this._formatSQL}>格式化</button>
        <span style="font-size:12px;color:var(--muted)">${instance ? `${instance.db_type?.toUpperCase()} SQL` : ""}</span>
      </div>

      <div class="main-area">
        <div class="browser">
          <div class="browser-tabs">
            <button class="browser-tab ${this.sidebarView === 'schema' ? 'active' : ''}"
              @click=${() => { this.sidebarView = 'schema'; }}>
              结构
            </button>
            <button class="browser-tab ${this.sidebarView === 'history' ? 'active' : ''}"
              @click=${() => { this.sidebarView = 'history'; this._loadHistory(true); }}>
              历史
            </button>
          </div>
          ${this.sidebarView === 'schema' ? html`
            <div class="browser-header">${instance?.name || ''}</div>
            ${this.objectsLoading ? html`<div class="loading">加载中...</div>` :
              this.schemas.map(schema => html`
              <div class="tree-node">
                <div class="schema-name" @click=${() => this._toggleSchema(schema.schema)}>
                  ${this.expandedSchemas.has(schema.schema) ? '▾' : '▸'} ${schema.schema}
                </div>
                ${this.expandedSchemas.has(schema.schema) ? schema.tables.map(table => {
                  const key = `${schema.schema}.${table.name}`;
                  return html`
                  <div class="tree-node">
                    <div class="table-name" @click=${() => this._toggleTable(key)} @dblclick=${() => this._insertTable(table.name)}>
                      ${this.expandedTables.has(key) ? '▾' : '▸'} ${table.name}
                    </div>
                    ${this.expandedTables.has(key) ? table.columns.map(col => html`
                      <div class="col-name" @dblclick=${() => { this._insertColumn(col.name); this._toggleTable(key); }}>
                        <span>${col.name}</span>
                        <span class="col-type">${col.type}${col.nullable ? '?' : ''}</span>
                      </div>
                    `) : ""}
                  </div>`;
                }) : ""}
              </div>
            `)}
          ` : html`
            <div class="history-panel">
              <div class="history-search">
                <input class="history-search-input" type="text" placeholder="搜索 SQL..."
                  .value=${this.historySearch}
                  @input=${(e: InputEvent) => {
                    this.historySearch = (e.target as HTMLInputElement).value;
                    this._loadHistory(true);
                  }} />
                <select class="history-instance-filter"
                  @change=${(e: Event) => {
                    this.historyInstanceFilter = parseInt((e.target as HTMLSelectElement).value);
                    this._loadHistory(true);
                  }}>
                  <option value="0">全部实例</option>
                  ${this.instances.map(inst => html`
                    <option value=${inst.id} ?selected=${inst.id === this.selectedId}>${inst.name}</option>
                  `)}
                </select>
              </div>
              <div class="history-list" @scroll=${this._onHistoryScroll}>
                ${this.historyItems.length === 0 && !this.historyLoading ? html`
                  <div class="history-empty">
                    ${this.historySearch ? '' : html`<div class="history-empty-icon">${icons['clock']}</div>`}
                    <div class="history-empty-text">${this.historySearch ? '无匹配结果' : '暂无查询记录'}</div>
                    <div class="history-empty-hint">${this.historySearch ? '试试其他搜索词' : '执行查询后，历史记录将自动保存于此'}</div>
                  </div>
                ` : html`
                  ${this.historyItems.map(item => html`
                    <div class="history-item" @click=${() => this._loadHistorySQL(item.sql)}>
                      <div class="history-sql" title=${item.sql}>${item.sql.slice(0, 80)}${item.sql.length > 80 ? '...' : ''}</div>
                      <div class="history-meta">
                        <span>${item.instanceName}</span>
                        <span>${item.durationMs}ms</span>
                        <span>${item.rowCount} 行</span>
                        <span class="history-time">${new Date(item.timestamp).toLocaleString()}</span>
                      </div>
                    </div>
                  `)}
                  ${this.historyLoading ? html`<div class="loading">加载中...</div>` : ''}
                  ${!this.historyHasMore && this.historyItems.length > 0 ? html`<div class="history-end">已加载全部历史记录</div>` : ''}
                `}
              </div>
            </div>
          `}
        </div>

        <div class="editor-area">
          <div class="cm-wrap"></div>
          ${this.approvalResult ? html`
            <div class="approval-notice">
              ⚠ 已提交审批 (ID: ${this.approvalResult.request_id}, 风险: ${this.approvalResult.risk_level})
              ${this.approvalResult.ai_recommendation ? ` — AI建议: ${this.approvalResult.ai_recommendation.recommendation}` : ""}
            </div>` : ""}
          ${this.error ? html`<div class="error-box">❌ ${this.error}</div>` : ""}
          ${this.explainData ? html`
            <div class="explain-container">
              ${(() => {
                const summary = this._calculateSummary(this.explainData!);
                const grade = this._efficiencyGrade(this.explainData!);
                return html`
                  <div class="explain-summary">
                    <div class="explain-summary-stats">
                      <span>总成本: <strong>${Number(summary.totalCost).toLocaleString()}</strong></span>
                      <span>扫描行数: <strong>${Number(summary.totalRows).toLocaleString()}</strong></span>
                    </div>
                    <span class="explain-grade" style="color: ${grade.color}">${grade.label}</span>
                  </div>
                `;
              })()}

              <div class="explain-toolbar">
                <div class="explain-toggle">
                  <button class="explain-toggle-btn ${this.explainViewMode === 'tree' ? 'active' : ''}"
                    @click=${() => { this.explainViewMode = 'tree'; this.requestUpdate(); }}>树形</button>
                  <button class="explain-toggle-btn ${this.explainViewMode === 'table' ? 'active' : ''}"
                    @click=${() => { this.explainViewMode = 'table'; this.requestUpdate(); }}>表格</button>
                </div>
                <button class="btn btn-back" @click=${() => { this.explainData = null; this.explainError = null; }}>返回结果</button>
              </div>

              ${this.explainViewMode === 'tree' ? html`
                <div class="plan-tree">${this._renderPlanTree(this.explainData, 0)}</div>
              ` : html`
                ${this._renderPlanTable(this.explainData)}
              `}
            </div>
          ` : this.explainLoading ? html`
            <div class="explain-container">
              <div class="loading">正在分析执行计划...</div>
            </div>
          ` : this.explainError ? html`
            <div class="error-box">获取执行计划失败: ${this.explainError}</div>
          ` : r ? (() => {
            const allRows = this._sortRows(r.rows || []);
            const total = allRows.length;
            const ps = this.pageSize === 'all' ? total : Number(this.pageSize);
            const start = total > 0 ? (this.currentPage - 1) * ps + 1 : 0;
            const end = Math.min(this.currentPage * ps, total);
            const pageRows = allRows.slice(start - 1, end);
            const totalPages = this.pageSize === 'all' ? 1 : Math.max(1, Math.ceil(total / ps));
            return html`
              <div class="results">
                <div class="results-header">
                  <span>✅ ${r.rowCount ?? 0} 行 · ${r.duration_ms ?? 0}ms · ${r.columns?.length ?? 0} 列</span>
                  <div class="results-header-right">
                    <button class="btn-export" @click=${this._exportCSV} ?disabled=${total === 0}>
                      ${icons['download']} 导出 CSV
                    </button>
                    <span class="page-info">${start}–${end} / ${total} 行</span>
                    ${this.pageSize !== 'all' ? html`
                      <select class="page-size-select" .value=${String(this.pageSize)} @change=${(e: Event) => this._changePageSize(Number((e.target as HTMLSelectElement).value))}>
                        <option value="25">25</option>
                        <option value="50">50</option>
                        <option value="100">100</option>
                        <option value="all">全部</option>
                      </select>
                      <div class="page-nav">
                        <button class="page-btn" ?disabled=${this.currentPage <= 1} @click=${() => this._goToPage(this.currentPage - 1)}>‹</button>
                        <span class="page-num">${this.currentPage} / ${totalPages}</span>
                        <button class="page-btn" ?disabled=${this.currentPage >= totalPages} @click=${() => this._goToPage(this.currentPage + 1)}>›</button>
                      </div>
                    ` : ''}
                  </div>
                </div>
                <div class="results-scroll">
                  <table>
                    <thead><tr>${(r.columns || []).map(c => html`
                      <th @click=${() => this._toggleSort(c)}
                          style="cursor:pointer;user-select:none;white-space:nowrap;text-align:center">
                        ${c}
                        ${this.sortColumn === c
                          ? html`<span style="margin-left:4px;color:var(--accent, #7c5cff);font-size:10px">${this.sortDirection === 'asc' ? '▲' : '▼'}</span>`
                          : ''}
                      </th>`)}</tr></thead>
                    <tbody>
                      ${pageRows.map(row => html`
                        <tr>${(r.columns || []).map(c => {
                          const v = row[c];
                          return html`<td class=${v === null ? "null" : ""} title=${v === null ? "NULL" : String(v)} style="text-align:center">${v === null ? "NULL" : String(v)}</td>`;
                        })}</tr>
                      `)}
                    </tbody>
                  </table>
                </div>
              </div>`;
          })() : ""}
        </div>
      </div>
    `;
  }
}
