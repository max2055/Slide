# Phase 96: Oracle Database Support — Research

**Researched:** 2026-05-19
**Domain:** Oracle database management — connection, metrics, SQL console, instance detail, agent tools
**Confidence:** HIGH

## Summary

This phase adds full Oracle database management to Slide. The Oracle backend implementation is already complete in `database-service.ts` (connection, metrics, slow queries, health check, EXPLAIN plan, capacity, active sessions) — all dispatch methods handle `db_type === 'oracle'`. The phase is primarily about REGISTERING/ENABLING Oracle at remaining touchpoints: `metric-registry.ts` (add 'oracle' to db_types), frontend CodeMirror dialect for PL/SQL, agent tool type unions, add-instance form field (SID/Service Name), and instance detail overview (Oracle-specific info).

**Two significant fixes also required:**
1. `checkOracleHealth()` references undeclared variables `dbVersion` and `dataSizeGB` (will return undefined)
2. `getOracleMetrics()` should use delta-based QPS/TPS calculation (currently uses rough static ratios)

**Key risk:** Oracle EXPLAIN PLAN requires `PLAN_TABLE` to exist in the target database. This is not auto-created — `utlxplan.sql` (ORACLE_HOME/rdbms/admin/) must have been run by a DBA. If `PLAN_TABLE` does not exist, `getOracleExplainPlan()` will throw an error.

**Primary recommendation:** Apply Phase 95 Dameng pattern: add 'oracle' to metric-registry and agent tool enums, create OracleDialect in sql-console.ts, add SID/Service Name field to add-instance form, add Oracle-specific cards to instance detail overview, and upgrade from single `oracledb.getConnection()` to `oracledb.createPool()`.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Oracle 添加到全部 8 个内置指标的 db_types 数组（connections, qps, tps, cpu_usage, memory_usage, disk_usage, health_score, slow_queries）
- **D-02:** 新增 3 个 Oracle 专属内置指标：tablespace_usage（表空间使用率 %）、sga_hit_rate（SGA 命中率 %）、deadlock_count（死锁数）。注册模式对齐 buffer_pool_hit_rate
- **D-03:** 间隔/阈值按 metric-registry 各自定义管理，沿用默认配置
- **D-04:** 创建独立 OracleDialect（SQLDialect.define()），包含完整 PL/SQL 关键字 + Oracle 系统视图（V$SESSION, V$SQL, DBA_TABLESPACES, DBA_DATA_FILES 等）+ 常用函数（NVL, DECODE, TO_CHAR, TO_DATE 等）。结构对齐 DamengDialect
- **D-05:** sql-console.ts 实例选择逻辑新增 db_type === 'oracle' → OracleDialect 分支
- **D-06:** autocomplete 基于 OracleDialect 增强：系统视图、函数、PL/SQL 关键字补全
- **D-07:** 复用现有 6 tab 布局（概览、监控、TopSQL、慢查询、容量、会话），与 Dameng D-03 一致。不新增 Oracle 专属 tab
- **D-08:** 概览 tab 展示 Oracle 版本 + SGA 大小 + PGA 大小 + 表空间总数/使用率
- **D-09:** 扩展 4 个现有工具的 db_type 枚举添加 oracle：test_connection、add_database、update_db_config、get_instance_summary
- **D-10:** 新增 3 个 Oracle 专属 Agent 工具：oracle_ash_report（ASH 活跃会话历史报告）、oracle_awr_report（AWR 自动工作负载报告）、oracle_tablespace_detail（表空间使用详情）
- **D-11:** ASH/AWR 报告保留 Oracle 原生 HTML 格式，支持在线分析和下载
- **D-12:** add-instance 表单新增单一"Oracle 数据库标识"字段，支持 SID 或 Service Name。oracledb Easy Connect 格式（host:port/database_identifier）自动判断
- **D-13:** 强制 TCPS 加密连接（TLS）。代码支持但不强制证书验证 — 开发/测试环境可跳过 wallet 配置
- **D-14:** 显式使用 oracledb.createPool() 替代单连接 getConnection()，使用默认池参数（poolMax=4, poolMin=0, poolTimeout=60s）
- **D-15:** 全部已有 Oracle 功能直接启用 — 慢查询、EXPLAIN、容量、会话查询、健康检查均在 database-service.ts 中已实现
- **D-16:** monitor-collector 无需额外修改。Oracle 实例连接建立后通过 getAllInstances() → getRealtimeMetrics() → getOracleMetrics() 自动进入采集循环
- **D-17:** 数据类型使用 oracledb 配置处理：fetchAsString 处理 NUMBER（避免精度丢失），fetchAsBuffer 处理 CLOB
- **D-18:** 字符集依赖 oracledb 默认 NLS_LANG=AMERICAN_AMERICA.AL32UTF8，不做额外转换
- **D-19:** 支持 Oracle 11g / 12c / 19c。11g 需要 oracledb Thick mode（Thin mode 最低 12.1），12c/19c 使用 Thin mode
- **D-20:** 不支持 PDB/CDB 多租户架构。连接直接针对数据库实例
- **D-21:** 用户本地 Oracle 19c Docker 容器用于端到端验证。11g/12c 代码路径由单元测试和 schema 校验自行保证

### Claude's Discretion
- Oracle 默认端口 1521（前端已有），db_type 标识使用 'oracle'
- CodeMirror OracleDialect 结构对齐 DamengDialect 模式（SQLDialect.define + keywords/builtin 两段）
- metric-registry 专属指标结构对齐 buffer_pool_hit_rate 注册模式
- oracle_ash_report / oracle_awr_report 工具内部使用 DBMS_WORKLOAD_REPOSITORY 包（Oracle 内置）

### Deferred Ideas (OUT OF SCOPE)
- **PDB/CDB 多租户支持**: 用户确认目标客户环境未使用，暂不支持
- **Oracle RAC 集群**: 多节点连接管理和负载均衡，后续单独规划
- **Oracle Data Guard**: 主备切换和灾备监控，后续单独规划
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DB-02 | Oracle database management support — instance connection, SQL console, metrics, instance detail | Full research below covers metric-registry registration, CodeMirror OracleDialect, agent tools, add-instance form changes, pool upgrade, TCPS support, and bug fixes needed |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Database connection | API / Backend | — | oracledb driver runs in db-ops-api; D-14 requires upgrade to createPool() |
| Connection pool | API / Backend | — | oracledb.createPool() replaces single getConnection(); poolMax=4, poolMin=0, poolTimeout=60s |
| Metric collection | API / Backend | Database / Storage | getOracleMetrics() queries V$ views, stores via metricsDatabaseService |
| SQL execution | API / Backend | — | sql-executor.ts dispatches to conn.oracleConnection.execute() at L49-51 |
| EXPLAIN plan | API / Backend | — | getOracleExplainPlan() requires PLAN_TABLE existence |
| Schema browser | API / Backend | — | getSchemaObjects() needs Oracle branch added |
| SQL Console UI | Browser / Client | — | CodeMirror 6 runs in browser; OracleDialect definition for PL/SQL highlighting |
| Instance detail UI | Browser / Client | API / Backend | Overview tab shows Oracle-specific info; data from /api/metrics and /api/capacity |
| AI agent tools | API / Backend | — | 4 existing tools need 'oracle' in enum; 3 new Oracle-only tool files |
| Slow query / QAN | API / Backend | — | Already fully implemented and dispatched — direct enable |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `oracledb` | ^6.10.0 | Oracle Database Node.js driver | Official Oracle driver; already a dependency; Thin mode default for 12c+; Thick mode for 11g |

### Supporting

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@codemirror/lang-sql` | ^6.10.0 | CodeMirror 6 SQL language support | Provides `SQLDialect.define()` for creating custom Oracle PL/SQL dialect; already a frontend dependency |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| oracledb (existing) | — | Already installed and working; no alternative needed |
| `@codemirror/lang-sql` PLSQL built-in dialect | Custom OracleDialect via SQLDialect.define() | PLSQL dialect exists in @codemirror/lang-sql but is generic. OracleDialect with full PL/SQL keywords + system views + functions gives better autocomplete |

**Version verification:** `oracledb` v6.10.0 confirmed from npm registry. `@codemirror/lang-sql` ^6.10.0 confirmed in frontend/package.json.

## Architecture Patterns

### System Architecture Diagram

```
Browser (Lit Component)
  │
  ├─ sql-console.ts ───────────────────────────┐
  │   ├─ @codemirror/lang-sql                   │
  │   │   └─ SQLDialect.define(OracleSpec)      │  PL/SQL syntax highlighting
  │   ├─ autocompletion (custom source)         │  V$*, DBA_*, function completions
  │   └─ executeSql/explainPlan API calls        │
  │                                             │
  ├─ instances-db.ts ───────────────────────────┤
  │   └─ Add-instance form: SID/service_name    │  New field for Oracle DB identifier
  │                                              │
  └─ instance-detail.ts ───────────────────────┤
      ├─ Overview tab: Oracle version + SGA     │
      │  size + PGA size + tablespace info       │
      ├─ Metrics tab: all 8 built-in + 3 new    │
      ├─ TopSQL: getSlowQueries (V$SQLAREA)      │
      ├─ Sessions: getActiveSessions (V$SESSION) │
      └─ Capacity: getCapacity (DBA_DATA_FILES) │

Backend (Fastify API Server)
  │
  ├─ database-service.ts ───────────────────────┘
  │   ├─ addConnection(oracle) ──── upgrade to oracledb.createPool()
  │   ├─ getOracleMetrics() ─────── V$SESSION, V$SYSSTAT, V$LIBRARYCACHE, V$SEGMENT_STATISTICS
  │   ├─ getOracleSlowQueries() ─── V$SQLAREA
  │   ├─ checkOracleHealth() ────── 6 checks + BUG FIX (dbVersion, dataSizeGB)
  │   ├─ getOracleExplainPlan() ─── PLAN_TABLE + DBMS_XPLAN
  │   ├─ getOracleCapacity() ────── DBA_DATA_FILES, DBA_SEGMENTS
  │   └─ getOracleActiveSessions() ─ V$SESSION
  │
  ├─ sql-executor.ts
  │   └─ executeSql(instanceId, sql) ───── conn.oracleConnection.execute() via oracledb
  │
  ├─ monitor-collector.ts
  │   └─ _tick() → getAllInstances() → collectInstanceMetrics()
  │       → getRealtimeMetrics() → getOracleMetrics()  (ALREADY WIRED)
  │
  ├─ metric-registry.ts
  │   └─ predefined metrics ─────── add 'oracle' to ALL 8 built-in db_types
  │                                  + add 3 new Oracle-specific metrics
  │
  ├─ instance-database-service.ts
  │   └─ testConnection(oracle) ─── already works via dynamic import oracledb
  │
  └─ tools/
      ├─ test_connection.ts ─────── add 'oracle' to enum
      ├─ add_database.ts ────────── add 'oracle' to enum
      ├─ update_db_config.ts ────── no changes needed (no db_type enum)
      ├─ get_instance_summary.ts ─── no changes needed (generic db_type)
      ├─ oracle_ash_report.ts ───── NEW: DBMS_WORKLOAD_REPOSITORY
      ├─ oracle_awr_report.ts ───── NEW: DBMS_WORKLOAD_REPOSITORY
      └─ oracle_tablespace_detail.ts ─ NEW: DBA_TABLESPACES + DBA_DATA_FILES
```

### Recommended Project Structure

No structural changes needed — Oracle follows the existing per-database-type pattern in `database-service.ts` (getOracleMetrics, checkOracleHealth, getOracleExplainPlan, getOracleSlowQueries, getOracleActiveSessions, getOracleCapacity).

| File | Change |
|------|--------|
| `apps/db-ops-api/src/database-service.ts` | Upgrade to oracledb.createPool() (D-14); fix dbVersion/dataSizeGB bug in checkOracleHealth; add fetchAsString/fetchAsBuffer config (D-17); TCPS connect string support (D-13) |
| `apps/db-ops-api/src/metric-registry.ts` | Add 'oracle' to all 8 built-in db_types (D-01); add 3 new Oracle-specific metrics (D-02) |
| `apps/db-ops-api/src/instance-database-service.ts` | Add SID/Service Name field handling to testConnection (D-12); TCPS support |
| `apps/db-ops-api/src/tools/generated/slide-self-mgmt/test_connection.ts` | Add 'oracle' to db_type enum |
| `apps/db-ops-api/src/tools/generated/slide-self-mgmt/add_database.ts` | Add 'oracle' to db_type enum + default port map |
| `apps/db-ops-api/src/tools/generated/slide-self-mgmt/oracle_ash_report.ts` | NEW — ASH report tool |
| `apps/db-ops-api/src/tools/generated/slide-self-mgmt/oracle_awr_report.ts` | NEW — AWR report tool |
| `apps/db-ops-api/src/tools/generated/slide-self-mgmt/oracle_tablespace_detail.ts` | NEW — Tablespace detail tool |
| `frontend/src/openclaw/ui/views/sql-console.ts` | Add OracleDialect via SQLDialect.define(); add 'oracle' → OracleDialect dispatch; enhance autocomplete |
| `frontend/src/openclaw/ui/views/instances-db.ts` | Add SID/Service Name field conditionally when db_type === 'oracle' |
| `frontend/src/openclaw/ui/views/instance-detail.ts` | Add Oracle-specific info to overview tab (version, SGA, PGA, tablespace) |

### Pattern 1: Oracle Connection Pool (Upgrade from Single Connection)

**What:** Upgrade Oracle connections from single `oracledb.getConnection()` to `oracledb.createPool()` with pool management. This follows the same pattern as MySQL's `mysql.createPool()`.

**When to use:** In `database-service.ts` `addConnection()` for Oracle database type.

**Current (single connection):** [VERIFIED: codebase database-service.ts L181-203]
```typescript
const oracleConnection = await oracledb.getConnection({
  user: config.user,
  password: config.password,
  connectString: `${config.host}:${config.port}/${config.database || 'ORCL'}`,
});
```

**Target (connection pool per D-14):**
```typescript
const pool = await oracledb.createPool({
  user: config.user,
  password: config.password,
  connectString: `${config.host}:${config.port}/${config.database || 'ORCL'}`,
  poolMax: 4,
  poolMin: 0,
  poolTimeout: 60,  // seconds
  queueRequests: true,
  queueMax: 500,
  queueTimeout: 60000,
});

// Get connection from pool
const connection = await pool.getConnection();
await connection.execute('SELECT 1 FROM DUAL');
await connection.close();  // returns to pool
```

**Connection cleanup needs update:** Current `removeConnection()` calls `conn.oracleConnection.close()` (L293-294). After pool upgrade, should call `pool.close(0)` to drain the pool.

### Pattern 2: Oracle CodeMirror Dialect via SQLDialect.define

**What:** Create a custom Oracle PL/SQL dialect for CodeMirror 6, following the same structure as DamengDialect.

**When to use:** In `sql-console.ts`, when the selected database is `db_type === 'oracle'`.

**Structure (align to DamengDialect pattern from Phase 95):** [VERIFIED: codebase sql-console.ts L12-L321]
```typescript
import { sql, SQLDialect } from '@codemirror/lang-sql';

const OracleDialect = SQLDialect.define({
  keywords: `
    VARCHAR2 PLS_INTEGER BINARY_INTEGER BOOLEAN
    PACKAGE PACKAGE BODY PROCEDURE FUNCTION
    DECLARE BEGIN EXCEPTION END
    CURSOR BULK COLLECT FORALL
    RETURN RETURNING ROWTYPE TYPE RECORD
    VARRAY NESTED TABLE PIPELINED
    AUTONOMOUS_TRANSACTION PRAGMA
    WHEN OTHERS RAISE SQLERRM SQLCODE
    SAVEPOINT ROLLBACK COMMIT
    TRUNCATE PURGE FLASHBACK ARCHIVE
    MATERIALIZED VIEW SYNONYM SEQUENCE
    TRIGGER INSTEAD OF EACH ROW
    LOB FILE UTL_FILE
    DBMS_OUTPUT DBMS_SQL DBMS_XPLAN DBMS_WORKLOAD_REPOSITORY
    -- plus standard SQL keywords (SELECT, FROM, WHERE, etc.)
  `,
  builtin: `
    NVL NVL2 DECODE TO_CHAR TO_DATE TO_NUMBER
    TO_TIMESTAMP TO_INTERVAL EXTRACT CAST
    GREATEST LEAST COALESCE NULLIF
    LISTAGG WM_CONCAT
    RANK DENSE_RANK ROW_NUMBER LAG LEAD
    FIRST_VALUE LAST_VALUE
    SYSDATE SYSTIMESTAMP CURRENT_DATE CURRENT_TIMESTAMP
    USER UPPER LOWER TRIM LENGTH SUBSTR INSTR
    REPLACE TRANSLATE REGEXP_REPLACE REGEXP_SUBSTR REGEXP_INSTR
    ADD_MONTHS MONTHS_BETWEEN NEXT_DAY LAST_DAY
    ROUND TRUNC CEIL FLOOR MOD POWER SQRT
    V$SESSION V$SQL V$SQLAREA V$SGA V$PGASTAT
    V$SYSSTAT V$PARAMETER V$INSTANCE V$DATABASE
    V$LOCK V$DEADLOCK V$SQL_PLAN V$VERSION
    V$LIBRARYCACHE V$SEGMENT_STATISTICS
    DBA_TABLESPACES DBA_DATA_FILES DBA_SEGMENTS DBA_USERS
    DBA_HIST_SQLTEXT DBA_HIST_ACTIVE_SESS_HISTORY
    ALL_TABLES ALL_TAB_COLUMNS USER_TABLES
    DUAL PLAN_TABLE
  `,
  types: `
    VARCHAR2 NVARCHAR2 CHAR NCHAR
    NUMBER BINARY_FLOAT BINARY_DOUBLE
    DATE TIMESTAMP TIMESTAMP WITH TIME ZONE
    CLOB BLOB NCLOB BFILE
    RAW LONG RAW ROWID UROWID
    PLS_INTEGER BINARY_INTEGER BOOLEAN
    SYS_REFCURSOR
  `,
  doubleQuotedStrings: false,
  identifierQuotes: '"',
  caseInsensitiveIdentifiers: true,
  plsqlQuotingMechanism: true,
});
```

**Usage in sql-console.ts (L358-359 pattern):**
```typescript
// Current:
const selectedDialect = instance?.db_type === 'dameng' ? DamengDialect : MySQL;
// Target:
const selectedDialect = instance?.db_type === 'oracle' ? OracleDialect
  : instance?.db_type === 'dameng' ? DamengDialect
  : MySQL;
```

### Pattern 3: TCPS Connection (D-13)

**What:** Force Oracle to use TCPS (TLS) for encrypted connections. In oracledb 6.x, this is done via the `connectString` using the TCPS protocol prefix or by setting `sslOptions`.

**Implementation approach:**
```typescript
// TCPS via connectString
const connection = await oracledb.getConnection({
  user: config.user,
  password: config.password,
  connectString: `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCPS)(HOST=${config.host})(PORT=${config.port}))(CONNECT_DATA=(SERVICE_NAME=${config.database || 'ORCL'})))`,
});

// Or set oracledb global SSL options before connection
oracledb.sslOptions = {
  // Development/testing: skip wallet verification
  // Production: point to Oracle wallet
};
```

For development/testing, TCPS can work without full wallet setup by setting `oracledb.sslOptions` to allow self-signed certificates. D-13 explicitly allows skipping wallet configuration in dev.

### Anti-Patterns to Avoid

- **Hardcoded slow_queries:0 in getOracleMetrics()**: Current code at L882 sets `slow_queries: 0` regardless of the actual value. While V$SQLAREA has elapsed_time data, getting real-time "new slow queries since last poll" is difficult without delta tracking. Consider either (a) using V$SQL_MONITOR for real-time monitoring, or (b) accepting the 0 and relying on the periodic collectSlowQueries() loop instead.
- **Not updating QPS/TPS to delta calculation**: Current `getOracleMetrics()` uses `Math.floor(executes / 100)` and `Math.floor(commits / 10)` (L879-880) rather than real delta calculations. Consider adding an `oracleDeltaCounter` similar to MySQL's `deltaCounter` for proper QPS/TPS.
- **Adding PLAN_TABLE queries without checking**: If the user running the application is not a DBA (common for monitoring tools), PLAN_TABLE may not exist and `utlxplan.sql` may need to be run by an admin. This should be handled gracefully with a fallback in getOracleExplainPlan().

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Oracle Database connectivity | Custom TCPS protocol | `oracledb` npm package | Official Oracle driver handles TCPS, connection pooling, auth, Thick/Thin modes |
| SQL syntax highlighting for PL/SQL | Custom Lezer grammar | `@codemirror/lang-sql` + `SQLDialect.define()` | CodeMirror 6's SQL language support already has parser infrastructure |
| Connection pool management | Custom pool implementation | `oracledb.createPool()` | Built-in with queue management, pool validation, timeout |
| ASH/AWR report generation | Custom report engine | `DBMS_WORKLOAD_REPOSITORY` built-in Oracle packages | Oracle provides DBMS_WORKLOAD_REPOSITORY.AWR_REPORT_HTML() and DBMS_WORKLOAD_REPOSITORY.ASH_REPORT_HTML() — just call them |
| Metric aggregation and delta calculation | Custom counter logic | Reuse `deltaCounter` pattern from MySQL | The same pattern exists in MySQL; Oracle can use an `oracleDeltaCounter` |

**Key insight:** The QPS/TPS in `getOracleMetrics()` should use delta tracking (like MySQL's `deltaCounter`) instead of hardcoded ratios. This is a gap from the initial implementation that should be fixed.

## Common Pitfalls

### Pitfall 1: checkOracleHealth() — Undeclared Variables Bug
**What goes wrong:** `checkOracleHealth()` references `dbVersion` and `dataSizeGB` at L1703-1704 that are never declared in the function scope.
**Why it happens:** These variables exist in `checkMySQLHealth()` (L1317, 1324) and `checkPostgreSQLHealth()` (L1464, 1471) but were omitted from `checkOracleHealth()`.
**How to avoid:** Add version query (V$VERSION) and data size calculation (DBA_DATA_FILES) to checkOracleHealth(). The version query already exists in getOracleMetrics() (L868-871) — reuse the pattern.
**Warning signs:** Health check responses show `db_version: null` and `data_size_gb: null` for Oracle instances.
**Severity:** MEDIUM — causes undefined values but does not crash the health check (the function still returns valid health_score and checks).

### Pitfall 2: PLAN_TABLE DNE (Does Not Exist)
**What goes wrong:** `getOracleExplainPlan()` runs `EXPLAIN PLAN SET STATEMENT_ID = :id FOR sql` which requires PLAN_TABLE to exist in the user's schema.
**Why it happens:** PLAN_TABLE is not created automatically by Oracle. It is created by running `$ORACLE_HOME/rdbms/admin/utlxplan.sql`. Monitoring applications often connect as non-DBA users who may not have this table.
**How to avoid:** Catch the error in getOracleExplainPlan() and return a clear message: "EXPLAIN PLAN requires PLAN_TABLE. Please ask a DBA to run @$ORACLE_HOME/rdbms/admin/utlxplan.sql." Alternatively, use `DBMS_XPLAN.DISPLAY_CURSOR()` which does not require PLAN_TABLE but requires diagnostics pack license.
**Warning signs:** "table or view does not exist" for PLAN_TABLE when running EXPLAIN PLAN.
**Severity:** HIGH — if PLAN_TABLE does not exist, the entire explain plan feature will throw an error for Oracle instances.

### Pitfall 3: DBA_* View Privileges
**What goes wrong:** `getOracleMetrics()` queries DBA_SEGMENTS (L846), DBA_DATA_FILES (L849). `getOracleCapacity()` also queries DBA_DATA_FILES (L2574) and DBA_SEGMENTS (L2583). These require DBA role or specific grants.
**Why it happens:** Monitoring users often connect with limited privileges. DBA_SEGMENTS requires `SELECT ANY DICTIONARY` or DBA role.
**How to avoid:** Add error handling to fall back to ALL_* or USER_* views when DBA_* fails. DBA_TABLESPACES can fall back to USER_TABLESPACES. DBA_DATA_FILES has no direct non-DBA equivalent — if this fails, tablespace metrics will be unavailable.
**Warning signs:** "ORA-00942: table or view does not exist" for DBA_* views.
**Severity:** MEDIUM — core monitoring features (tablespace, segment data) will fail for non-DBA users.

### Pitfall 4: oracledb 11g Thick Mode Setup
**What goes wrong:** oracledb Thin mode (default) supports Oracle Database 12.1+. For 11g, `oracledb.initOracleClient()` must be called with a path to Oracle Instant Client.
**Why it happens:** The Thin mode driver uses a pure JavaScript implementation of Oracle Net protocol. Oracle 11g uses an older protocol version not supported by Thin mode.
**How to avoid:** Before establishing a connection, check `oracledb.oracleClientVersion` (returns 0 in Thin mode). If 11g support is needed and version is 0, call `oracledb.initOracleClient({ libDir: '/path/to/instantclient' })`. D-19 says this is supported.
**Warning signs:** Connection error: "NJS-511: unsupported database server version" or "ORA-28040: No matching authentication protocol".
**Severity:** LOW for default (12c+), HIGH for 11g support — requires user to install Oracle Instant Client on the server.

### Pitfall 5: QPS/TPS Not Delta-Based
**What goes wrong:** `getOracleMetrics()` sets `qps: Math.floor(executes / 100)` and `tps: Math.floor(commits / 10)` (L879-880) — these are hardcoded ratios, not real delta calculations.
**Why it happens:** The getOracleMetrics() was implemented as a rough implementation without delta tracking like MySQL's `deltaCounter`.
**How to avoid:** Add an `oracleDeltaCounter` (similar to MySQL's `conn.deltaCounter`) that tracks snapshot values and calculates actual deltas per interval.
**Warning signs:** QPS/TPS values do not change meaningfully even under different query loads.
**Severity:** MEDIUM — provides misleading metrics but does not break functionality.

### Pitfall 6: getSchemaObjects() Missing Oracle Branch
**What goes wrong:** `getSchemaObjects()` (L1920-2000+) handles mysql, postgresql, dameng but has NO Oracle branch. If the frontend SQL console requests schema objects for an Oracle instance, it will fail.
**Why it happens:** Schema browser was added for Dameng (L1974) and Oracle was an oversight.
**How to avoid:** Add Oracle branch using ALL_TAB_COLUMNS query (same pattern as Dameng).
**Warning signs:** Schema browser shows nothing for Oracle instances.
**Severity:** MEDIUM — schema browser tab will be empty for Oracle instances.

## Code Examples

Verified patterns from official sources:

### Oracle Connection with Pool (D-14)

```typescript
// Source: oracledb v6.10.0 docs [VERIFIED: node_modules/oracledb/README.md]
import oracledb from 'oracledb';

// Create pool
const pool = await oracledb.createPool({
  user: config.user,
  password: config.password,
  connectString: `${config.host}:${config.port}/${config.database || 'ORCL'}`,
  poolMax: 4,
  poolMin: 0,
  poolTimeout: 60,
  queueRequests: true,       // wait when pool is busy
  queueMax: 500,             // max queued requests
  queueTimeout: 60000,       // max wait time (ms)
});

// Get connection
const conn = await pool.getConnection();
await conn.execute('SELECT 1 FROM DUAL');

// Return to pool
await conn.close();

// Close pool (on removeConnection)
await pool.close(0);  // 0 = drain immediately
```

### TCPS Connection (D-13)

```typescript
// Source: oracledb v6.10.0 documentation [CITED: node-oracledb.readthedocs.io]
import oracledb from 'oracledb';

// Option 1: TCPS in connectString
const pool = await oracledb.createPool({
  user: config.user,
  password: config.password,
  connectString: `(DESCRIPTION=
    (ADDRESS=(PROTOCOL=TCPS)(HOST=${config.host})(PORT=${config.port}))
    (CONNECT_DATA=(SERVICE_NAME=${config.database || 'ORCL'}))
  )`,
});

// Option 2: Set SSL options globally
oracledb.sslOptions = {
  // Dev/test: skip server certificate verification
  // In production, set rejectUnauthorized: true with proper wallet
};
```

### fetchAsString and fetchAsBuffer (D-17)

```typescript
// Source: oracledb v6.10.0 documentation [CITED: node-oracledb.readthedocs.io]
import oracledb from 'oracledb';

// Handle NUMBER as string (prevents precision loss)
oracledb.fetchAsString = [oracledb.NUMBER];

// Handle CLOB as buffer
oracledb.fetchAsBuffer = [oracledb.CLOB];

// Can also set per-connection:
const conn = await pool.getConnection();
conn.fetchAsString = [oracledb.NUMBER];
conn.fetchAsBuffer = [oracledb.CLOB];
```

### ASH/AWR Report (D-10, D-11)

```typescript
// Source: Oracle DBMS_WORKLOAD_REPOSITORY documentation [CITED: docs.oracle.com]
// Get AWR report as HTML
const result = await conn.execute(
  `SELECT * FROM TABLE(
    DBMS_WORKLOAD_REPOSITORY.AWR_REPORT_HTML(
      l_dbid    => :dbid,
      l_inst_num => :inst_num,
      l_bnstime => :begin_snap,
      l_instime => :end_snap
    )
  )`,
  { dbid: dbId, inst_num: 1, begin_snap: beginSnapId, end_snap: endSnapId }
);

// Get ASH report as HTML
const result = await conn.execute(
  `SELECT * FROM TABLE(
    DBMS_WORKLOAD_REPOSITORY.ASH_REPORT_HTML(
      l_dbid    => :dbid,
      l_inst_num => 1,
      l_bnstime  => :start_time,
      l_instime  => :end_time
    )
  )`,
  { dbid: dbId, start_time: startTs, end_time: endTs }
);
```

### TestConnection with SID/Service Name (D-12)

```typescript
// Source: oracledb v6.10.0 Easy Connect naming [CITED: node-oracledb.readthedocs.io]
// Easy Connect format: //host:port/service_name
// or: host:port/sid
const connectString = config.serviceName
  ? `${config.host}:${config.port}/${config.serviceName}`
  : `${config.host}:${config.port}/${config.database || 'ORCL'}`;
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Single connection per Oracle instance | Connection pool via oracledb.createPool() | Phase 96 | Concurrent health checks, metrics collection, and SQL queries no longer contend |
| No Oracle metrics in registry | 'oracle' in all 8 built-in db_types + 3 new | Phase 96 | Monitor collector starts collecting Oracle metrics |
| No Oracle dialect in SQL console | OracleDialect with PL/SQL keywords + V$ completions | Phase 96 | SQL syntax highlighting and autocomplete for Oracle users |
| No Oracle-specific agent tools | oracle_ash_report, oracle_awr_report, oracle_tablespace_detail | Phase 96 | Agent can diagnose Oracle performance |
| dbVersion/dataSizeGB undefined in health check | Proper version query + data size calc | Phase 96 | Correct health check data for Oracle |
| CHECKDB | CHECKORACLE | Phase 96 | — |

**Deprecated/outdated:**
- Single `oracledb.getConnection()` pattern in `addConnection()` — upgrade to `createPool()` per D-14
- Hardcoded `qps: Math.floor(executes / 100)` — should use delta tracking like MySQL

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | PLAN_TABLE exists in all Oracle target databases | Code Examples | HIGH — EXPLAIN PLAN fails. APPLICATION MUST HANDLE THIS GRACEFULLY. Consider using DBMS_XPLAN.DISPLAY_CURSOR as fallback (does not require PLAN_TABLE but requires Diagnostics Pack license) |
| A2 | DBA_TABLESPACES, DBA_DATA_FILES, DBA_SEGMENTS are accessible by monitoring user | Code Examples | MEDIUM — monitoring users often lack DBA role. Add fallback to ALL_*/USER_* views |
| A3 | V$VERSION.BANNER column contains version string | Code Examples | LOW — standard Oracle view, available since Oracle 8i |
| A4 | V$LIBRARYCACHE.PINHITS and V$LIBRARYCACHE.LOCKS columns exist | Code Examples | MEDIUM — Pinhits/locks exists but may need specific Oracle version checks |
| A5 | DBMS_WORKLOAD_REPOSITORY package is installed | Architecture Patterns | MEDIUM — requires Oracle Diagnostic Pack license. AWR/ASH are licensed features. Installation requires Oracle Enterprise Edition + Diagnostics Pack |
| A6 | DBMS_XPLAN.DISPLAY() function exists (used in getOracleExplainPlan) | Code Examples | LOW — available since Oracle 9i, included with all editions. Does not require Diagnostic Pack for explain plan |
| A7 | oracledb.createPool() API matches documented pattern | Code Examples | LOW — verified in installed node_modules/oracledb/README.md |
| A8 | TCPS can work without full Oracle Wallet in development | Code Examples | MEDIUM — oracledb node-oracledb 6.x supports sslOptions, but TCPS connection string format is complex and error-prone without wallet |

## Risk Mitigations (RESOLVED)

1. **Does the target environment have Oracle Diagnostic/Performance packs licensed?** (RESOLVED)
   - What we know: AWR and ASH use DBMS_WORKLOAD_REPOSITORY which requires Oracle Enterprise Edition + Diagnostics Pack license
   - What's unclear: Whether target Oracle instances have this licensed
   - RESOLVED: ASH/AWR tools wrap DBMS_WORKLOAD_REPOSITORY calls in try/catch returning "Diagnostics Pack required" message if unavailable (Plan 01 Task 3)

2. **Does PLAN_TABLE exist in the target Oracle schemas?** (RESOLVED)
   - What we know: PLAN_TABLE is required for EXPLAIN PLAN. Created by running utlxplan.sql
   - What's unclear: Whether each target Oracle instance has this table set up
   - RESOLVED: getOracleExplainPlan() catches ORA-00942, returns DISPLAY_CURSOR instruction as fallback (Plan 01 Task 1)

3. **Is the V$SEGMENT_STATISTICS query in getOracleMetrics() correct?** (RESOLVED)
   - What we know: L835-839 queries V$SEGMENT_STATISTICS with a DB_BLOCK_GETS/CONSISTENT_GETS pattern
   - What's unclear: V$SEGMENT_STATISTICS is a performance view that may not be available in all editions/tuning configurations
   - RESOLVED: V$SEGMENT_STATISTICS query wrapped in try/catch with default hit rate fallback and warn log (Plan 01 Task 1)

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | oracledb driver | yes | v22.22.1 | — |
| npm | oracledb install | yes | — | Already installed |
| `oracledb` npm package | Connection, metrics, SQL execution | yes | ^6.10.0 (installed) | — |
| `@codemirror/lang-sql` | Frontend Oracle dialect | yes | ^6.10.0 (installed) | — |
| Oracle 19c Docker | E2E testing | confirmed (D-21) | 19c | — |
| Oracle Instant Client | 11g Thick mode | unknown | — | Cannot test 11g without Instant Client |

**Missing dependencies with no fallback:**
- None — all software dependencies are already installed.

**Missing dependencies with fallback:**
- Oracle 11g Instant Client for Thick mode — cannot fully test 11g without it. D-21 says tests for 11g/12c are via unit tests and schema validation.

## Validation Architecture

> Skipped: `workflow.nyquist_validation` is not configured in .planning/config.json. Phase 96 follows standard verification via manual smoke testing and code review per the project's established pattern.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | oracledb connection uses username/password; credentials stored encrypted (existing encryptData in instance-database-service.ts) |
| V5 Input Validation | yes | SQL execution uses parameterized queries via oracledb's `connection.execute(sql, bindParams)` — same pattern as all other DB types |
| V6 Cryptography | yes | TCPS (TLS) required per D-13; oracledb supports SSL/TLS via connectString PROTOCOL=TCPS or sslOptions |

### Known Threat Patterns for Oracle Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SQL injection via console | Tampering | oracledb supports bind parameters (`:name` syntax); user-entered SQL in the console is already a privileged operation — same risk as MySQL/PG consoles |
| Credential interception | Information Disclosure | TCPS encryption per D-13 prevents plaintext credential exposure on the wire |
| Unauthorized SID/service enumeration | Information Disclosure | TCPS encrypted connection prevents eavesdropping; SID/Service Name in the connection string is already as exposed as host:port |
| Privilege escalation via DBA views | Information Disclosure | Monitoring user should have minimal grants (SELECT on V$*, DBA_*). The application does not execute DDL through the console without approval |

## Sources

### Primary (HIGH confidence)
- [Codebase] `apps/db-ops-api/src/database-service.ts` — All Oracle methods verified (L181-203, L779-895, L1162-1196, L1547-1721, L2173-2209, L2360-2394, L2567-2613)
- [Codebase] `apps/db-ops-api/src/sql-executor.ts` — Oracle execution branch verified at L49-51
- [Codebase] `apps/db-ops-api/src/instance-database-service.ts` — Oracle testConnection at L361-375, db_type union at L11
- [Codebase] `apps/db-ops-api/src/metric-registry.ts` — Confirmed no 'oracle' in any db_types array (gap)
- [Codebase] `apps/db-ops-api/src/monitor-collector.ts` — Confirmed _tick iterates all active instances, no changes needed (D-16 validated)
- [Codebase] `apps/db-ops-api/src/tools/generated/slide-self-mgmt/test_connection.ts` — Enum missing 'oracle' at L51 (gap)
- [Codebase] `apps/db-ops-api/src/tools/generated/slide-self-mgmt/add_database.ts` — Enum missing 'oracle' at L16 (gap)
- [Codebase] `frontend/src/openclaw/ui/views/sql-console.ts` — Only DamengDialect defined, no OracleDialect (gap)
- [Codebase] `frontend/src/openclaw/ui/views/instances-db.ts` — Oracle option exists at L1307, port 1521 at L1299, but no SID/Service Name field (gap)
- [Codebase] `frontend/src/openclaw/ui/views/instance-detail.ts` — No Oracle-specific overview rendering (gap)
- [Codebase] `frontend/src/api/database.ts` — 'oracle' in db_type type union at L288, confirmed
- [npm registry] `oracledb` v6.10.0 — confirmed installed
- [npm registry] `@codemirror/lang-sql` — confirmed installed in frontend

### Secondary (MEDIUM confidence)
- [Codebase] `apps/db-ops-api/src/database-service.ts` getOracleMetrics() L879-880 — QPS/TPS are hardcoded ratios, not delta calculations (gap)
- [Codebase] `apps/db-ops-api/src/database-service.ts` checkOracleHealth() L1703-1704 — references undeclared dbVersion/dataSizeGB variables (confirmed bug)
- [Codebase] `apps/db-ops-api/src/database-service.ts` getSchemaObjects() L1974 — missing Oracle branch (gap)
- [node_modules] `oracledb/README.md` — confirmed createPool(), fetchAsString, fetchAsBuffer, sslOptions APIs

### Tertiary (LOW confidence)
- [Assumed] PLAN_TABLE existence in target Oracle databases — needs graceful error handling
- [Assumed] DBA_* view access for monitoring user — needs graceful fallback
- [Assumed] V$SEGMENT_STATISTICS availability — may require specific Oracle tuning configuration

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — oracledb v6.10.0 verified installed, @codemirror/lang-sql verified installed
- Architecture: HIGH — all patterns exist in current codebase for MySQL/PG/Dameng; Oracle follows same pattern
- Pitfalls: MEDIUM — some Oracle-specific behaviors (PLAN_TABLE, DBA privileges, Thick mode) depend on target database configuration

**Research date:** 2026-05-19
**Valid until:** 2026-07-30 (oracledb is stable; @codemirror/lang-sql follows semver)
