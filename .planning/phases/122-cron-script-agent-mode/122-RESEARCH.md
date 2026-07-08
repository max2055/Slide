# Phase 122: 定时任务 Script/Agent 双模式 - Research

**Researched:** 2026-06-26
**Domain:** Cron Job System Extension -- adding SQL script execution capability alongside existing AI Agent mode
**Confidence:** HIGH

## Summary

Phase 122 adds a **script mode** to the cron job system. Currently, all cron jobs execute via the AI Agent engine (CronExecutor), which interprets natural language task descriptions and calls tools. The script mode bypasses the AI agent entirely -- it executes SQL scripts directly against managed database instances using the existing SqlExecutor infrastructure.

The key architectural change is adding a **branch in CronManager.executeJob()**: if the job's `task_type` is `'script'`, load the script from the new `cron_scripts` table and execute it via `sqlExecutor.executeSql()` against the `target_instance_id`. If `task_type` is `'agent'` (default), use the existing `CronExecutor` AI agent path.

**Primary recommendation:** Build the script execution path as a thin orchestration layer over the existing `sqlExecutor` and `databaseService` -- don't duplicate connection management, SQL execution, or audit logging. Reuse the CodeMirror editor from sql-console.ts for the frontend script editor.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Script storage (cron_scripts CRUD) | API / Backend | Database / Storage | New REST endpoints + new MySQL table; persistent storage |
| Script execution | API / Backend | -- | sqlExecutor runs server-side against managed DB connections |
| Script editing UI | Browser / Client | -- | CodeMirror editor lives entirely in frontend |
| Task scheduling (cron trigger) | API / Backend | -- | CronManager (server-side node-cron) uses OS scheduler, not browser timers |
| Instance selection UI | Browser / Client | API / Backend | UI renders dropdown; data fetched from /api/database/instances |
| Script mode vs agent mode branching | API / Backend | -- | CronManager.executeJob() is the single decision point |
| Result logging | API / Backend | -- | cron_job_logs table written by CronManager after execution |
| Dry-run test execution | API / Backend | -- | POST /api/cron/scripts/:id/test calls sqlExecutor directly |
| Seed script insertion | API / Backend | -- | Migration SQL, called at server startup |

## User Constraints (from CONTEXT.md)

### Locked Decisions
- D-01: Script content sourced from Phase 112 old handler logic, rewritten with current services. Do NOT restore old hardcoded handler code (that code has been deleted).
- D-02: Script mode is a generic SQL script engine, not 6 predefined handlers. Current scope: SQL scripts against managed DB instances. Future: Shell scripts.
- D-03: Scripts stored in new `cron_scripts` table with fields: id, name, description, script_type ('sql'|'shell'), content (TEXT), target_db_type (ENUM), created_at, updated_at.
- D-04: Instance binding via dropdown at job creation time (single instance, not multi-instance). Foreign key: target_instance_id -> database_instances.id.
- D-05: SQL dialect classification by target_db_type (mysql/postgresql/oracle/dameng). Editor auto-adapts dialect when instance is selected.
- D-06: Editor reuses frontend SQL console's CodeMirror component with syntax highlighting and dry-run test execution.
- D-07: Script version control: direct overwrite, no history.
- D-08: Read-write permissions: script mode allows DDL/DML (CREATE/ALTER/DROP/INSERT/UPDATE/DELETE).
- D-09: 6 predefined seed scripts: capacity_collection, schema_collection, index_collection, baseline_cleanup, silence_cleanup, log_collection.
- D-10: Existing 6 agent-mode tasks auto-migrate to script mode with task_type='script'.
- D-11: Two creation flows: Quick Create (pick template + instance) and Custom Create (write SQL + pick instance).
- D-12: Result format unified with agent mode (structured_result JSON). Frontend reuses existing log viewer.

### Deferred Ideas (OUT OF SCOPE)
- Shell script support
- Script version control
- Personal assistant cron tasks (OpenClaw integration)
- Script marketplace/sharing

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SCRIPT-01 | cron_scripts table + 6 seed scripts + migration | Defined in CONTEXT.md D-03, D-09. Migration SQL: new table + seed insert + cron_jobs ALTER. SQL sourced from Phase 112 collector logic [see Section "6 Predfined Script SQL"] |
| SCRIPT-02 | cron_jobs table: task_type + script_id + target_instance_id | Defined in CONTEXT.md D-03/Interfaces. ALTER TABLE migration. Existing types.ts CronJobConfig needs extension. |
| SCRIPT-03 | CronExecutor branch: script mode uses SqlExecutor | CronManager.executeJob() is the branch point. Script path uses sqlExecutor.executeSql(). Agent path unchanged. |
| SCRIPT-04 | New API endpoints: /api/cron/scripts CRUD + test | 5 endpoints as defined in CONTEXT.md. Reuse existing auth patterns (verifyToken, cron:manage). |
| SCRIPT-05 | Frontend: script/agent mode toggle + SQL editor + instance selector | cron-jobs-settings.ts extended with mode selector. CodeMirror reused from sql-console.ts. Instance dropdown populates from /api/database/instances. |
| SCRIPT-06 | Auto-migration of existing 6 tasks to script mode | Migration SQL UPDATEs rows by name: capacity_collection/schema_collection/index_collection/baseline_cleanup/silence_cleanup/log_collection to task_type='script'. |

## Standard Stack

### Core (Backend)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| node-cron | ^4.4.0 [VERIFIED: npm registry] | Cron scheduling (CronJob instances) | Already in project, used by CronManager |
| node-sql-parser | ^5.4.0 [VERIFIED: npm registry] | SQL AST parsing for validation | Already in project for sql-validator.ts |
| mysql2/promise | (project dep) [VERIFIED: project] | MySQL query execution | Used by SqlExecutor.executeSql() |
| pg (pg.Client) | (project dep) [VERIFIED: project] | PostgreSQL query execution | Used by SqlExecutor.executeSql() |
| oracledb | (project dep) [VERIFIED: project] | Oracle query execution | Used by SqlExecutor.executeSql() |
| dmdb | (project dep) [VERIFIED: project] | Dameng query execution | Used by SqlExecutor.executeSql() |

### Core (Frontend)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| codemirror | ^6.0.2 [VERIFIED: npm registry] | Code editor core | Already in project, used by sql-console.ts |
| @codemirror/lang-sql | ^6.10.0 [VERIFIED: npm registry] | SQL syntax highlighting, MySQL dialect | Already in project, includes Dameng custom dialect |
| @codemirror/autocomplete | ^6.20.2 [VERIFIED: npm registry] | SQL keyword completion | Already in project, used by sql-console.ts |
| @codemirror/theme-one-dark | ^6.1.3 [VERIFIED: npm registry] | Dark theme | Already in project |
| @codemirror/view | ^6.42.0 [VERIFIED: npm registry] | EditorView lifecycle | Already in project |
| @codemirror/state | ^6.6.0 [VERIFIED: npm registry] | EditorState management | Already in project |

### Supporting (no new packages needed)
All functionality can be built with existing project dependencies. No new npm packages required for this phase.

## Package Legitimacy Audit

No new packages are introduced in this phase. All core dependencies (node-cron, node-sql-parser, codemirror, @codemirror/*, mysql2, pg, oracledb, dmdb) are already installed and verified in the project. The phase builds on existing infrastructure.

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```
                          CronManager (scheduler)
                               │
                    executeJob(config)
                               │
                     config.task_type?
                        ┌──────┴──────┐
                        ▼              ▼
                     'agent'        'script'
                        │              │
                   CronExecutor    ScriptExecutor
                   (AI Agent)      (NEW — this phase)
                        │              │
                   AgentRunner    sqlExecutor.executeSql()
                        │              │
                   LLM + Tools    databaseService.getConnection()
                        │              │
                        ▼              ▼
                   ┌──────────────────────────┐
                   │   Managed DB Instances   │
                   │  (MySQL/PG/Oracle/DM)    │
                   └──────────────────────────┘
                              │
                              ▼
                   ┌──────────────────────────┐
                   │   cron_job_logs table    │
                   │  (unified result format) │
                   └──────────────────────────┘

  Script creation flow:
  Frontend (cron-jobs-settings.ts)
    │
    ├─ Quick Create: select template → pick instance → auto-fill SQL
    ├─ Custom Create: write SQL → pick instance → create job
    │
    └─ API: POST /api/cron/jobs { task_type:'script', script_id, target_instance_id, ... }
         API: POST /api/cron/scripts (create script first, then create job referencing it)
```

### Recommended Project Structure (new files only)

```
apps/db-ops-api/
├── src/
│   ├── cron/
│   │   ├── cron-executor.ts        # MODIFY: add ScriptExecutionResult type, script execution path
│   │   ├── cron-manager.ts         # MODIFY: branch on task_type in executeJob()
│   │   ├── cron-job-service.ts     # MODIFY: add script-related CRUD, update getJobs/getEnabledJobs SELECT
│   │   └── script-service.ts       # NEW: cron_scripts CRUD operations
│   └── sql/
│       └── migrations/
│           └── 017_add_cron_scripts.sql  # NEW: cron_scripts table + ALTER cron_jobs + seed data
├── server.ts                       # MODIFY: import scriptService, add /api/cron/scripts routes
frontend/
├── src/
│   └── app/
│       └── ui/
│           └── views/
│               └── cron-jobs-settings.ts  # MODIFY: add mode selector, script editor, instance picker
```

### Pattern 1: Branch on task_type in CronManager.executeJob()

**What:** CronManager.executeJob() is the single decision point. Before execution, check config.task_type. If 'script', load the script and execute it via SqlExecutor. If 'agent' (default), use existing CronExecutor path.

**When to use:** This is the core architectural change. The branch happens in executeJob(), not in CronExecutor (which should remain agent-only).

**Pseudo-code:**
```typescript
// CronManager.executeJob() — new branch
private async executeJob(config: CronJobConfig): Promise<void> {
  // ... existing runningFlags guard ...
  if (config.task_type === 'script' && config.script_id && config.target_instance_id) {
    await this.executeScriptJob(config);  // NEW path
    return;
  }
  // ... existing agent execution path ...
}

private async executeScriptJob(config: CronJobConfig): Promise<void> {
  const script = await this.scriptService.getScriptById(config.script_id!);
  const result = await sqlExecutor.executeSql(
    config.target_instance_id!,
    script.content,
  );
  // Format result as structured_result (unified with agent format)
  const structuredResult = {
    success: result.success,
    rowCount: result.rowCount,
    columns: result.columns,
    duration_ms: result.duration_ms,
    error: result.error || null,
  };
  // Write to cron_job_logs via jobService (same as agent path)
}
```

### Pattern 2: Unified Result Logging

**What:** Script execution results use the same `cron_job_logs` table and `structured_result` JSON format as agent mode. The frontend log viewer does not need modification.

**When to use:** D-12 requires unified format. Both paths write to the same completeLog() function.

### Pattern 3: CodeMirror Reuse (Frontend)

**What:** The script editor reuses CodeMirror from sql-console.ts. Create a `<script-editor>` Lit component that wraps EditorView with SQL dialect selection based on target_db_type.

**When to use:** When adding script editing UI to the cron job create/edit dialog.

**Key implementation details:**
- Import `basicSetup, EditorView, EditorState` from codemirror/@codemirror packages (same as sql-console.ts)
- Use `sql()` language with dialect switching: MySQL for mysql, SQLDialect for oracle (custom dialect already defined in sql-console.ts), DamengDialect for dameng
- PostgreSQL uses MySQL or a generic SQL dialect (PostgreSQL SQL is a superset)
- EditorView created/destroyed in LitElement lifecycle (connectedCallback/disconnectedCallback)

### Anti-Patterns to Avoid

- **Putting script execution in CronExecutor:** CronExecutor is an AI Agent wrapper. Keep it agent-only. Script execution belongs in CronManager or a new ScriptJobRunner.
- **Duplicating SqlExecutor logic:** sql-executor.ts already handles 4 DB types with proper connection management, audit logging, and error handling. Script mode calls it directly.
- **Re-implementing CodeMirror integration:** sql-console.ts has 200+ lines of CodeMirror setup with dialects, autocomplete, and lifecycle management. Extract shared patterns rather than duplicating.
- **Multi-instance script execution in v1:** D-04 specifies single instance binding. Don't build a "run against all instances" feature yet.
- **Storing passwords or connection strings in scripts:** Script content should be pure SQL. Instance binding (D-04) means the script doesn't need to know connection details.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| SQL execution against 4 DB types | New query runner | `sqlExecutor.executeSql()` in sql-executor.ts | Handles mysql/pg/oracle/dm with connection reuse, error handling, audit logging |
| SQL syntax highlighting | Custom syntax highlighter | CodeMirror 6 with @codemirror/lang-sql | Already in project (sql-console.ts), includes custom Dameng dialect, oneDark theme, autocomplete |
| SQL validation | Regex-based validation | `validateSqlIsSelectOnly()` in sql-validator.ts | Uses node-sql-parser AST (already installed); note: for D-08 read-write, skip validation for cron script execution |
| Cron expression parsing | Custom cron parser | `CronJob` from `cron` package | Already used by CronManager; validates expressions, computes next execution |
| Instance dropdown UI | Custom fetch+render | Reuse pattern from sql-console.ts instance selector | Consistent UX; authFetch already handles auth token refresh |
| Structured result formatting | Custom JSON schema | Reuse `structured_result` column in cron_job_logs | D-12 unified format; frontend already parses this for agent results |

**Key insight:** The script mode is an orchestration layer over 3 existing services: SqlExecutor (SQL execution), databaseService (connection management), and CronJobDatabaseService (logging). The only genuinely new systems are the cron_scripts table and its CRUD API.

## 6 Predefined Scripts — SQL Logic (D-09)

Based on Phase 112 handler names (from migration 009 seed data) and the collector logic in database-service.ts, here are the 6 scripts:

### 1. capacity_collection (容量数据采集)
**Target DB Types:** mysql, postgresql
**Logic:** Query total storage, database count, table count per instance.
```sql
-- MySQL version
SELECT 
  ROUND(SUM(data_length + index_length) / 1024 / 1024 / 1024, 2) AS total_storage_gb,
  COUNT(DISTINCT table_schema) AS total_databases,
  COUNT(*) AS total_tables
FROM information_schema.tables
WHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys');
```
**Source:** database-service.ts getMySQLMetrics lines 437-440, collector mysql.provider.ts lines 58-62. [VERIFIED: codebase]

### 2. schema_collection (Schema 快照采集)
**Target DB Types:** all 4
**Logic:** Collect table and column metadata snapshot, compare with previous snapshot.
```sql
-- MySQL version (generic collect)
SELECT table_schema, table_name, column_name, data_type, is_nullable, column_key
FROM information_schema.columns
WHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
ORDER BY table_schema, table_name, ordinal_position;
```
**Source:** database-service.ts getSchemaObjects lines 2132-2232. [VERIFIED: codebase]

### 3. index_collection (索引信息采集)
**Target DB Types:** all 4
**Logic:** Collect index names, columns, types, and cardinality.
```sql
-- MySQL version
SELECT table_schema, table_name, index_name, column_name, 
       non_unique, index_type, cardinality
FROM information_schema.statistics
WHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
ORDER BY table_schema, table_name, index_name, seq_in_index;
```
**Source:** database-service.ts (index usage from MySQL). Deduced from schema snapshot collector pattern. [CITED: codebase pattern]

### 4. baseline_cleanup (基线清理)
**Target DB Types:** mysql (Slide's own DB, not managed instances)
**Logic:** Delete baseline records older than 30 days.
```sql
DELETE FROM metric_baselines WHERE created_at < NOW() - INTERVAL 30 DAY;
```
**Source:** Phase 112 original seed data description: "每周日凌晨 3 点清理过期基线（保留 30 天）". [CITED: migration 009 seed data]

### 5. silence_cleanup (静默过期清理)
**Target DB Types:** mysql (Slide's own DB)
**Logic:** Delete expired silence rules.
```sql
DELETE FROM alert_silence_rules WHERE expire_at IS NOT NULL AND expire_at < NOW();
```
**Source:** Phase 112 original seed data description: "每小时清理过期静默规则". [CITED: migration 009 seed data]

### 6. log_collection (数据库日志采集)
**Target DB Types:** mysql (managed instances mysql.general_log/mysql.slow_log)
**Logic:** Collect recent error/warning logs from managed instances.
```sql
-- MySQL: collect slow query log entries from last 5 minutes
SELECT start_time, user_host, query_time, lock_time, rows_sent, rows_examined, sql_text
FROM mysql.slow_log
WHERE start_time >= NOW() - INTERVAL 5 MINUTE
ORDER BY start_time DESC
LIMIT 1000;
```
**Source:** database-service.ts getMySQLSlowQueries lines 1131-1179. [CITED: codebase]

**Important notes on seed scripts:**
- Scripts 4 and 5 (baseline_cleanup, silence_cleanup) operate on Slide's own MySQL database, not managed instances. They still go through SqlExecutor but target the Slide DB instance.
- Scripts 1, 2, 3, 6 operate on managed instances and need the `target_instance_id` binding.
- The seed scripts should be INSERTed with `script_type='sql'` and `target_db_type` matching their logic.
- D-01 says "reference Phase 112 logic, rewrite with current services" -- the SQL above is derived from the current collectors, not from deleted handler code.

## Runtime State Inventory

This is not a rename/refactor/migration phase -- it is a feature addition. No rename-related runtime state to migrate.

However, the auto-migration of 6 existing tasks (D-10) touches runtime state:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | 6 rows in cron_jobs table (names: 容量数据采集, Schema 快照采集, 索引信息采集, 基线清理, 数据库日志采集, 静默过期清理) | Migration SQL UPDATEs task_type to 'script'. New script rows inserted into cron_scripts, then script_id FK populated on each job. |
| Live service config | None — cron config is entirely in MySQL DB | No change |
| OS-registered state | None — CronManager is an in-process scheduler | No change |
| Secrets/env vars | None | No change |
| Build artifacts | None | No change |

**Nothing found in category:** All verified by codebase inspection. The migration SQL handles the only runtime state change.

## Common Pitfalls

### Pitfall 1: Branching too late in the execution chain
**What goes wrong:** If script execution logic is placed in CronExecutor instead of CronManager, CronExecutor becomes dual-purpose (agent + script). This couples the AgentRunner initialization to script execution, creating unnecessary dependencies. When shell scripts are added later, CronExecutor would need a third branch.
**Why it happens:** CronExecutor's `execute()` method is the only existing execution path. It's natural to want to extend it.
**How to avoid:** Add the `executeScriptJob()` method to CronManager. CronManager already has access to all dependencies (jobService, the config with task_type). CronExecutor stays agent-only.
**Warning signs:** If you find yourself adding DatabaseService or SqlExecutor imports to cron-executor.ts, you are in the wrong file.

### Pitfall 2: Breaking existing cron_jobs table SELECT queries
**What goes wrong:** Adding `task_type`, `script_id`, `target_instance_id` columns without updating the SELECT list in CronJobDatabaseService methods causes those columns to be silently absent from CronJobConfig objects. The DEFAULT 'agent' on task_type means existing rows will work, but the new columns won't appear in API responses.
**Why it happens:** The SELECT statements in getJobs(), getEnabledJobs(), getJobById() explicitly list column names. New columns added to the table but not to the SELECT are invisible to the application.
**How to avoid:** Update all 3 SELECT queries in cron-job-service.ts to include the new columns. Also update the CronJobConfig type in types.ts. Add integration tests that verify new fields appear in API responses.

### Pitfall 3: Script execution timeout without connection release
**What goes wrong:** A long-running SQL script (e.g., a full-table scan) hangs the database connection without proper timeout handling. Unlike agent mode (which has llmTimeoutS + wall-clock timeout), SqlExecutor has no built-in execution timeout.
**Why it happens:** sqlExecutor.executeSql() calls pool.query() / pgClient.query() / connection.execute() without a statement_timeout guard.
**How to avoid:** Before executing script SQL, set session-level timeout guards:
- MySQL: `SET SESSION max_execution_time = <timeout_ms>`
- PostgreSQL: `SET statement_timeout = '<timeout_s>s'`
- Oracle: connection.execute() has no built-in timeout; wrap in Promise.race with setTimeout
- Dameng: dmdb has no built-in timeout; wrap in Promise.race
**Warning signs:** Script execution never returns; CPU on the managed instance spikes; connection pool exhausted.

### Pitfall 4: Scripts 4 and 5 should not block on managed instance connectivity
**What goes wrong:** baseline_cleanup and silence_cleanup operate on Slide's own MySQL DB, not managed instances. If we route them through the same instance-selection logic as scripts 1/2/3/6, they would fail when no managed instances are configured.
**Why it happens:** D-04 says "user selects target instance at creation time." The natural implementation would enforce a target_instance_id FK for all script jobs.
**How to avoid:** Allow `target_instance_id` to be NULL for scripts that target Slide's own database. The script execution path should check: if target_instance_id is set, execute against that managed instance; if NULL, execute against Slide's internal MySQL pool (dbConnection.getPool()).
**Warning signs:** Baseline cleanup or silence cleanup cron jobs fail with "no instance selected" errors.

### Pitfall 5: front-end CodeMirror instance creation/destruction lifecycle
**What goes wrong:** Creating a new EditorView on every render call causes memory leaks, duplicate editor instances, and loss of editor content.
**Why it happens:** LitElement's render() can be called many times. EditorView is a stateful DOM object that must be managed outside the reactive render cycle.
**How to avoid:** Follow sql-console.ts pattern: create EditorView in a lifecycle method (or after first render), store reference as a class property, destroy in disconnectedCallback(). Use `requestUpdate()` to re-render only the non-editor parts of the component.
**Warning signs:** Multiple editor instances stacked on top of each other; typing in the editor doesn't change the visible content; memory usage grows over time.

## Code Examples

### CronManager: Script execution path
```typescript
// CronManager.ts — new private method
private async executeScriptJob(config: CronJobConfig): Promise<void> {
  const scriptService = new ScriptService(); // or dependency-injected
  const script = await scriptService.getScriptById(config.script_id!);
  if (!script) {
    throw new Error(`Script not found: ${config.script_id}`);
  }

  // Resolve target: managed instance or internal MySQL
  const instanceId = config.target_instance_id;
  
  let result: { success: boolean; columns?: string[]; rows?: any[]; rowCount?: number; duration_ms?: number; error?: string };
  
  if (instanceId) {
    // Execute against managed DB instance
    result = await sqlExecutor.executeSql(instanceId, script.content);
  } else {
    // Execute against Slide's own MySQL
    result = await this.executeInternalSql(script.content);
  }

  const structuredResult = {
    success: result.success,
    rowCount: result.rowCount ?? 0,
    columns: result.columns ?? [],
    duration_ms: result.duration_ms ?? 0,
    error: result.error ?? null,
  };

  // Log via same path as agent mode
  const status = result.success ? 'success' : 'error';
  await this.jobService.completeLog(logId, status,
    result.success ? `Script executed: ${result.rowCount} rows in ${result.duration_ms}ms` : `Script failed`,
    result.error,
    structuredResult,
    { duration_ms: result.duration_ms },
  );
}
```

### CronJobConfig type extension
```typescript
// types.ts — add new fields
export interface CronJobConfig {
  // ... existing fields ...
  task_type: 'script' | 'agent';           // NEW (default: 'agent')
  script_id: number | null;                // NEW FK -> cron_scripts.id
  target_instance_id: number | null;       // NEW FK -> database_instances.id
}
```

### ScriptService skeleton
```typescript
// script-service.ts — new file
export class ScriptService {
  private getPool(): mysql.Pool | null { return dbConnection.getPool(); }

  async getAllScripts(): Promise<CronScript[]> { /* SELECT * FROM cron_scripts */ }
  async getScriptById(id: number): Promise<CronScript | null> { /* SELECT WHERE id = ? */ }
  async createScript(data: CreateScriptInput): Promise<number> { /* INSERT */ }
  async updateScript(id: number, data: UpdateScriptInput): Promise<boolean> { /* UPDATE */ }
  async deleteScript(id: number): Promise<boolean> { /* DELETE WHERE id = ? */ }
}

export interface CronScript {
  id: number; name: string; description: string | null;
  script_type: 'sql' | 'shell'; content: string;
  target_db_type: 'mysql' | 'postgresql' | 'oracle' | 'dameng' | 'mongodb' | 'redis' | 'elasticsearch';
  created_at: string; updated_at: string;
}
```

### Frontend: Mode selector in cron job form
```typescript
// In cron-jobs-settings.ts create/edit dialog — add mode selector
render() {
  return html`
    <!-- NEW: task_type selector -->
    <div class="form-group">
      <label class="form-label">执行模式</label>
      <select class="form-input" .value=${this.formTaskType} @change=${this.onTaskTypeChange}>
        <option value="agent">🤖 Agent 模式（AI 自然语言驱动）</option>
        <option value="script">📝 Script 模式（SQL 脚本执行）</option>
      </select>
    </div>

    ${this.formTaskType === 'agent' ? html`
      <!-- Existing: task_description textarea -->
    ` : html`
      <!-- NEW: script editor + instance selector -->
      <div class="form-group">
        <label class="form-label">SQL 脚本</label>
        <div class="script-editor-wrap"></div> <!-- CodeMirror mount point -->
      </div>
      <div class="form-group">
        <label class="form-label">目标实例</label>
        <select class="form-input" .value=${this.formTargetInstanceId}>
          ${this.instances.map(i => html`<option value=${i.id}>${i.name} (${i.db_type})</option>`)}
        </select>
      </div>
    `}
  `;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Phase 112: hardcoded handler functions (cron-job-handlers.ts) | Phase 113: AI Agent natural language descriptions | Phase 113 migration | Handler file deleted; tasks use NL descriptions |
| Phase 113: all 13 cron jobs use AI Agent | Phase 122: 6 data-collection jobs use script mode, 7 AI-analysis jobs stay agent | Phase 122 | Data collection jobs skip LLM cost; analysis jobs still use AI |
| cron_jobs table: handler column (string) | cron_jobs table: task_description column (TEXT, NL) | Phase 113 migration 010 | Decoupled from code |
| cron_jobs table: agent-only | cron_jobs table: task_type + script_id + target_instance_id | Phase 122 migration | Dual mode |
| No script storage | cron_scripts table with CRUD API | Phase 122 migration | Reusable script library |

**Deprecated/outdated:**
- `cron-job-handlers.ts` -- already deleted in Phase 113. Do not restore.
- `cron_jobs.handler` column -- already dropped in Phase 113 migration 010. Do not re-add.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Backend runtime | Yes | v22.22.1 | -- |
| npm | Package management | Yes | 10.9.4 | -- |
| node-cron | CronManager scheduler | Yes [VERIFIED] | ^4.4.0 | -- |
| node-sql-parser | SQL validation (optional for script mode) | Yes [VERIFIED] | ^5.4.0 | Skip validation for script mode (D-08 allows read-write) |
| mysql2 | MySQL query execution | Yes [VERIFIED] | project dep | -- |
| pg (pg.Client) | PostgreSQL query execution | Yes [VERIFIED] | project dep | -- |
| oracledb | Oracle query execution | Yes [VERIFIED] | project dep | -- |
| dmdb | Dameng query execution | Yes [VERIFIED] | project dep | -- |
| codemirror | Frontend SQL editor | Yes [VERIFIED] | ^6.0.2 | -- |
| @codemirror/lang-sql | SQL syntax highlighting | Yes [VERIFIED] | ^6.10.0 | -- |
| @codemirror/autocomplete | SQL keyword completion | Yes [VERIFIED] | ^6.20.2 | -- |

**Missing dependencies with no fallback:** none
**Missing dependencies with fallback:** none

All required dependencies are already installed in the project. No new packages needed.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (project standard for backend) + existing test patterns |
| Config file | `apps/db-ops-api/src/__tests__/` directory |
| Quick run command | `cd apps/db-ops-api && npx vitest run src/__tests__/script-service.test.ts` (new file) |
| Full suite command | `cd apps/db-ops-api && npx vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SCRIPT-01 | Migration creates cron_scripts table + 6 seed scripts | integration | `cd apps/db-ops-api && npx tsx -e "require('./src/script-service').testSeed()"` | No -- Wave 0 |
| SCRIPT-02 | cron_jobs table has task_type/script_id/target_instance_id | unit | `cd apps/db-ops-api && npx vitest run src/__tests__/cron-executor.test.ts` (extend) | No -- Wave 0 |
| SCRIPT-03 | Script mode execution path returns structured_result | unit | `npx vitest run src/__tests__/cron-manager.test.ts` (new test) | No -- Wave 0 |
| SCRIPT-04 | /api/cron/scripts CRUD endpoints | integration | `npx vitest run src/__tests__/cron-scripts-api.test.ts` | No -- Wave 0 |
| SCRIPT-05 | Frontend mode selector renders + switches UI | E2E/smoke | Manual browser verification OR `npx vitest run frontend/src/app/ui/views/__tests__/cron-jobs-settings.test.ts` | No -- Wave 0 |
| SCRIPT-06 | Existing 6 tasks have task_type='script' after migration | integration | SQL query verification in migration tests | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `cd apps/db-ops-api && npx vitest run --reporter=verbose` (changed files only)
- **Per wave merge:** `cd apps/db-ops-api && npx vitest run`
- **Phase gate:** Full test suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `apps/db-ops-api/src/__tests__/script-service.test.ts` -- covers SCRIPT-01 (seed data verification)
- [ ] `apps/db-ops-api/src/__tests__/cron-manager.test.ts` -- covers SCRIPT-03 (script execution path)
- [ ] `apps/db-ops-api/src/__tests__/cron-scripts-api.test.ts` -- covers SCRIPT-04 (API endpoints)
- [ ] `frontend/src/app/ui/views/__tests__/cron-jobs-settings.test.ts` -- covers SCRIPT-05 (mode selector UI)
- [ ] Test framework config: `vitest.config.ts` already exists in `apps/db-ops-api/`

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | yes | verifyToken middleware (existing) on all new /api/cron/scripts routes |
| V3 Session Management | yes | JWT via authFetch (existing) |
| V4 Access Control | yes | requirePermission('cron:manage') on POST/PUT/DELETE /api/cron/scripts/*; requirePermission('cron:view') on GET |
| V5 Input Validation | yes | Script content validated via node-sql-parser for syntax (not SELECT-only restriction per D-08); name max 100 chars; content TEXT type |
| V6 Cryptography | no (not applicable) | No cryptographic operations in this phase |

### Known Threat Patterns for cron script execution

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SQL injection via script content | Tampering | node-sql-parser parses SQL to detect multi-statement injection; executeSql() uses parameterized queries where possible; audit logging captures full SQL text |
| Unauthorized script execution | Elevation of Privilege | cron:manage permission required for create/update/delete/trigger; cron:view for list; JWT verification on all endpoints |
| Data exfiltration via SELECT INTO OUTFILE | Information Disclosure | SqlExecutor does not parse/modify SQL content (D-08 read-write); however audit logging captures the SQL text for post-hoc review |
| Denial of service via expensive queries | Denial of Service | Script execution wraps in timeout guard (5 min default from cron.timeout_seconds); session-level statement_timeout set before execution |
| Script content stored as plaintext at rest | Information Disclosure | TEXT column in MySQL; no encryption at rest for script content (same as task_description column); acceptable for internal ops tool |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The 6 predefined scripts' SQL logic can be derived from the current collector/database-service code | 6 Predefined Scripts | If Phase 112 handler logic differed significantly, SQL may not match expected behavior. Mitigation: D-01 says "rewrite with current services" -- exact match not required. |
| A2 | `sqlExecutor.executeSql()` does not enforce SELECT-only; it passes through any SQL type | Architecture | If executeSql() has SELECT-only validation added between now and implementation, the script mode would break for DDL/DML. Verified: current code has no SELECT-only check in sql-executor.ts (only in sql-validator.ts which is separate). |
| A3 | baseline_cleanup and silence_cleanup scripts target Slide's own MySQL (table names exist: metric_baselines, alert_silence_rules) | 6 Predefined Scripts | If these tables don't exist or have different names, scripts will fail. Mitigation: check table existence in migration SQL. |
| A4 | Frontend CodeMirror instance can be extracted/reused without deep modification of sql-console.ts | Architecture Patterns | If sql-console.ts has tight coupling between editor and its tab/result logic, extraction may be non-trivial. Mitigation: create a standalone `<script-editor>` Lit component that wraps the same CodeMirror imports but with simpler lifecycle. |
| A5 | The cron_jobs table currently has 13 rows from seed data; the 6 auto-migration targets exist by name | Runtime State | If any of the 6 tasks were deleted or renamed by users, auto-migration would miss them. Mitigation: migration uses WHERE name IN (...) with exact names from migration 009 seed data. |

## Open Questions (RESOLVED)

1. **Should script execution propagate to Oracle/Dameng?** RESOLVED: Seed MySQL versions for all 6 scripts. Add PG versions where applicable. Oracle/Dameng variants can be user-created.

2. **Should the dry-run test endpoint (POST /api/cron/scripts/:id/test) require a target_instance_id in the request body?** RESOLVED: Accept `instance_id` in the request body: `POST /api/cron/scripts/:id/test { instance_id: number }`. This keeps scripts instance-agnostic.

## Sources

### Primary (HIGH confidence)
- [codebase] apps/db-ops-api/src/cron/cron-executor.ts -- CronExecutor class, CronHook, AgentRunner integration
- [codebase] apps/db-ops-api/src/cron/cron-manager.ts -- CronManager scheduling, executeJob(), runningFlags
- [codebase] apps/db-ops-api/src/cron/cron-job-service.ts -- cron_jobs/cron_job_logs/cron_job_params CRUD, seed data
- [codebase] apps/db-ops-api/src/cron/types.ts -- CronJobConfig, CronJobLog, CronJobParam type definitions
- [codebase] apps/db-ops-api/src/sql-executor.ts -- SqlExecutor class, executeSql() for 4 DB types, audit logging
- [codebase] apps/db-ops-api/src/database-service.ts -- DatabaseService connection management, 4 DB type collectors
- [codebase] apps/db-ops-api/src/instance-database-service.ts -- DecryptedInstance, InstanceDatabaseService CRUD
- [codebase] apps/db-ops-api/src/sql-validator.ts -- validateSqlIsSelectOnly using node-sql-parser
- [codebase] apps/db-ops-api/src/collectors/mysql.provider.ts -- MySQL metric collection logic (Phase 112 pattern)
- [codebase] apps/db-ops-api/src/collectors/custom-sql.provider.ts -- Custom SQL execution wrapper
- [codebase] apps/db-ops-api/sql/migrations/009_add_cron_jobs_tables.sql -- Original cron_jobs table schema + seed data with handler names
- [codebase] apps/db-ops-api/sql/migrations/010_add_task_description_log_columns.sql -- Migration dropping handler, adding task_description + log columns
- [codebase] apps/db-ops-api/sql/migrations/015_add_output_schema.sql -- output_schema column + seed schemas for existing jobs
- [codebase] apps/db-ops-api/server.ts (lines 4075-4275) -- /api/cron/jobs routes and CronManager initialization
- [codebase] frontend/src/app/ui/views/sql-console.ts -- CodeMirror 6 + custom Dameng dialect implementation
- [codebase] frontend/src/app/ui/views/cron-jobs-settings.ts -- Current cron job management UI
- [CONTEXT.md] Phase 122 CONTEXT.md -- All locked decisions (D-01 through D-12)

### Secondary (MEDIUM confidence)
- [codebase] apps/db-ops-api/src/collectors/postgresql.provider.ts -- PostgreSQL metric collection (pattern reference)
- [codebase] apps/db-ops-api/src/collectors/oracle.provider.ts -- Oracle metric collection (pattern reference)
- [codebase] apps/db-ops-api/src/collectors/dameng.provider.ts -- Dameng metric collection (pattern reference)
- [codebase] apps/db-ops-api/src/consistency-checker.ts lines 369-600 -- Uses cron_jobs/cron_job_logs in consistency checks

### Tertiary (LOW confidence)
- [ASSUMED] Exact SQL for 6 seed scripts (derived from collector patterns, not from original Phase 112 handler code which has been deleted)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all dependencies already installed; no new packages needed
- Architecture: HIGH -- all patterns verified against existing codebase
- Pitfalls: HIGH -- 3 of 5 pitfalls are from recurring bug patterns in this project's memory; 2 are from direct code inspection
- Seed script SQL: MEDIUM -- derived from collector patterns; original Phase 112 handler code is deleted (D-01 prohibits restoration)

**Research date:** 2026-06-26
**Valid until:** 2026-07-10 (14 days -- the existing infrastructure is stable; seed SQL logic is the least certain component)
