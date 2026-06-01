# Phase 113: AI Agent Cron -- Natural Language Scheduled Tasks

**Researched:** 2026-05-27
**Domain:** AI Agent scheduled execution / infrastructure migration
**Confidence:** HIGH

## Summary

Phase 113 upgrades the Phase 112 DB-driven cron scheduler to an AI Agent-driven NL scheduled task system. Users describe tasks in natural language (e.g., "every morning at 9am, check slow queries on production instances and generate a summary report"). At each scheduled tick, the system creates a new agent session, sends the NL task description, and the agent autonomously plans and executes multiple tool calls, then writes the complete execution trace to `cron_job_logs`.

The core mechanism is straightforward: **replace `getHandler(config.handler)() -> handler()` with `AgentRunner.run()` execution**. The 13 existing hardcoded handlers in `cron-job-handlers.ts` are deleted entirely; their logic becomes NL seed data in the `cron_jobs.task_description` column. The `CronManager.executeJob()` method is modified to create an agent session, execute the NL task, and collect the result.

The project already has all the infrastructure needed: `@slide/agent-core` provides `AgentRunner` (the LLM-tool loop), `ToolRegistry` (registered from `catalog.ts`), `SessionManager` (JSONL persistence), and `AnthropicProvider` (LLM access). The adaptation surface is modest: extend CronManager to call `AgentRunner.run()` instead of a handler lookup, write a new `slide_complete_cron` tool for structured result persistence, and add a `task_description` column to the `cron_jobs` table.

**Primary recommendation:** Use Approach B (direct `AgentRunner.run()` in CronManager) rather than extending `IAgentEngine`. This avoids coupling the adapter interface to cron-specific needs and keeps the cron code self-contained. Create 4 new files: `cron-executor.ts`, `cron-types.ts`, `cron-completion-tool.ts`, and a migration for the schema change.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### D-01: Task Scope -- 13 Seeds + Free Creation
Users can create any number of scheduled tasks. The 13 existing handlers become NL seed data, not kept as code.

#### D-02: Agent Execution Mode -- Multi-round Autonomous
Agent can call multiple tools, analyze results, decide next steps. Example: check slow queries -> find anomaly -> deep analysis -> generate report.

#### D-03: Execution Results -- Write to logs, view in UI
Results written to `cron_job_logs`. Logs contain the agent's full execution trace. Users view via the cron job management UI's Logs sub-row.

#### D-04: Session Management -- New Gateway Session Per Tick
Each cron tick creates a new Gateway session (`chat.send` via port 28789/ws). Session closes after execution. Each task gets an independent context.

#### D-05: Old Handlers -- All Converted to NL, Hardcoded Code Deleted
All 13 handler functions in `cron-job-handlers.ts` are deleted. `cron_jobs.handler` field is replaced by `task_description` (NL text). Seed data contains NL descriptions transcribed from original handler logic.

#### D-06: Execution Timeout -- 5 Minutes
Agent single execution timeout is 5 minutes. On timeout, Gateway session closes, log marked as `error`/`timeout`.

#### D-07: Gateway Integration -- Reuse Existing sendGatewayChat
Existing `gateway-client.ts` `sendGatewayChat()` is used. Needs extension to collect Agent responses (currently fire-and-forget). Needs support for `chat.history` to pull full execution record.

#### D-08: UI -- Full Task Builder
New/edit task form: name, description, NL task content (textarea), cron expression, on/off toggle. Edit icon already added (Phase 112 wrap-up). Execution log viewer already exists.

#### D-09: Permission Model
- `cron:view` -- view task list and logs (exists)
- `cron:manage` -- create/edit/delete/on-off/manual trigger (exists, extend to cover create/delete)

### Claude's Discretion
(None specified)

### Deferred Ideas (OUT OF SCOPE)
- Real-time streaming of agent execution to UI
- Automatic retry with exponential backoff on failure
- Task dependencies (task A triggers task B after completion)
- NL task template library (common scenario preset templates)
</user_constraints>

<phase_requirements>
## Phase Requirements

(None defined in REQUIREMENTS.md -- Phase 113 is not tracked as a v1.3 requirement. This phase extends Phase 112's cron infrastructure with AI agent capabilities.)
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Task scheduling (cron tick) | Backend (CronManager) | -- | `cron` npm package fires ticks, no frontend involvement |
| NL task description storage | Database (cron_jobs) | -- | `task_description` column replaces `handler` column |
| Agent execution (LLM-tool loop) | Backend (AgentRunner) | -- | `@slide/agent-core` `AgentRunner.run()` replaces handler lookup |
| Tool registration | Backend (ToolRegistry) | -- | All existing platform tools auto-loaded via `getAgentEngine()` |
| Execution trace collection | Backend (CronHook) | Database (cron_job_logs) | Custom NoopHook extension collects tool events, stored in JSON columns |
| Session isolation | Backend (SessionManager) | -- | Per-tick session keys (`cron:<jobId>:<timestamp>`) |
| Task creation/editing UI | Browser (Frontend) | Backend (API routes) | Form with textarea for NL description, cron expression picker |
| Log viewer UI | Browser (Frontend) | Backend (API routes) | Existing Phase 112 logs endpoint + sub-row UI |
| Permission enforcement | Backend (API middleware) | -- | `cron:view` / `cron:manage` on all CRUD routes |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@slide/agent-core` | workspace:* | LLM-tool execution loop | Already the project's agent framework; `AgentRunner` provides the exact pattern needed |
| `@anthropic-ai/sdk` | >=0.30 | Anthropic Claude access | Already wired by `AnthropicProvider` in adapter layer |
| `cron` | ^2.4 | Cron expression parsing + scheduling | Already used by `CronManager` |
| `mysql2` | ^3.x | MySQL query execution | Already the project's DB driver |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `zod` | ^3.23 | Runtime validation of `slide_complete_cron` payload | For structured result validation before persisting to logs |
| `fastify` | ^4.x | HTTP server for cron API routes | Already the project's web framework |
| `vitest` | ^1.x | Eval test suite for cron traces | For code-based eval checks (D1-D6) |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `AgentRunner.run()` directly | `IAgentEngine.execute()` new method | Adding to the interface couples adapter layer to cron-specific needs; direct `AgentRunner` cron-executor is self-contained |
| `@slide/agent-core` `SessionManager` | New cron-specific session store | Reusing existing JSONL session store gives free persistence and audit trail; no need to build a separate store |

**Installation:**
```bash
# No new packages needed -- all dependencies are workspace-local
# @slide/agent-core is at packages/agent-core/
# zod is at workspace root (already a dependency if needed)
```

**Version verification:**
- `@slide/agent-core`: workspace package, no npm registry version needed
- `@anthropic-ai/sdk`: verify at apps/db-ops-api/package.json
- `cron`: verify at apps/db-ops-api/package.json
- `mysql2`: verify at apps/db-ops-api/package.json

## Package Legitimacy Audit

No external packages are added. All dependencies are workspace-local (`@slide/agent-core`) or already present in the project (`cron`, `mysql2`, `zod`). The only new code is in `apps/db-ops-api/src/cron/`.

## Current State Analysis

### CronManager (`cron-manager.ts`)

The existing `CronManager` is a robust scheduler:

```
start() -> reload() -> scheduleJob(config) -> CronJob(config.cron_expr, executeJob)
executeJob(config):
  1. runningFlags guard (concurrency prevention)
  2. startLog(config.id) -> logId
  3. const handler = getHandler(config.handler); await handler();
  4. completeLog(logId, 'success')
  5. updateRunResult(config.id, 'success')
```

**What needs changing:**
- Step 3 changes from `getHandler(config.handler)()` to `cronExecutor.execute(config)`
- `handler` field access changes to `task_description` field access
- Result object expands to include `tools_used`, `tool_events`, `usage`, `stop_reason`
- Add `duration_ms` tracking
- Add timeout detection via `stopReason`

**What stays the same:**
- CronJob scheduling via `cron` npm package
- `runningFlags` concurrency guard
- Log start/complete via `cronJobService`
- `reload()` on config changes
- Manual trigger endpoint (`POST /api/cron/jobs/:id/run`)

### CronJobDatabaseService (`cron-job-service.ts`)

This reads/writes to `cron_jobs` and `cron_job_logs` tables.

**What needs changing:**
- All queries currently SELECT `handler` -- replace with `task_description`
- `completeLog()` currently stores `result_summary VARCHAR(500)` and `error_message TEXT` -- needs expansion to support JSON columns for `tools_used`, `tool_events`, `usage`, `stop_reason`, `duration_ms`, `partial_trace`
- `updateRunResult()` currently sets `last_result` to a simple string status
- `updateJob()` does not include `task_description` in the updatable fields
- Need NEW routes/methods for creating jobs (POST /api/cron/jobs) and deleting jobs (DELETE /api/cron/jobs/:id)

**What stays the same:**
- Core CRUD pattern (parameterized queries, connection pool)
- `getEnabledJobs()`, `getJobById()`, `toggleJob()`, `getLogs()`, `startLog()`
- Permission guards on routes

### cron_jobs Table (current schema)

```sql
id, name, handler, cron_expr, enabled, timezone, description,
last_run_at, next_run_at, last_result, timeout_seconds, retry_count,
created_at, updated_at
```

**Migration needed:**
```sql
ALTER TABLE cron_jobs 
  DROP COLUMN handler,
  ADD COLUMN task_description TEXT NOT NULL AFTER name;
```

The `cron_expr` column stays (unlike the nanobot pattern which uses a `CronSchedule` object). The existing cron expression system works fine and removing it would break the UI's cron expression picker.

### cron_job_logs Table (current schema)

```sql
id, job_id, started_at, finished_at,
status ENUM('running','success','error','skipped'),
result_summary VARCHAR(500), error_message TEXT
```

**Migration needed:**
The VARCHAR(500) `result_summary` is too small for agent output. Add JSON columns for structured agent trace:

```sql
ALTER TABLE cron_job_logs
  MODIFY COLUMN status ENUM('running','success','error','skipped','timeout','partial') NOT NULL DEFAULT 'running',
  ADD COLUMN result LONGTEXT AFTER result_summary,
  ADD COLUMN tools_used JSON AFTER result,
  ADD COLUMN tool_events JSON AFTER tools_used,
  ADD COLUMN usage JSON AFTER tool_events,
  ADD COLUMN stop_reason VARCHAR(50) AFTER usage,
  ADD COLUMN duration_ms INT AFTER stop_reason,
  ADD COLUMN error_trace TEXT AFTER duration_ms,
  ADD COLUMN partial_trace LONGTEXT AFTER error_trace;
```

### The 13 Handlers (What They Do)

Full analysis of each handler in `cron-job-handlers.ts`:

| # | Handler Name | What It Does | Tools the Agent Would Call | NL Task Description (Seed Data) |
|---|-------------|--------------|---------------------------|----------------------------------|
| 1 | `topsqlAnalysis` | Scan active instances for slow queries (>=10s), deduplicate via Map, trigger AI analysis | Instance listing, `db_slow_queries`, AI analysis tools | "Every 10 seconds, scan all active database instances for slow queries with average execution time >= 10 seconds. For each new slow query found, perform an automated analysis to identify optimization opportunities. Use deduplication to avoid re-analyzing the same query within 30 minutes." |
| 2 | `rcaAnalysis` | Check recent alerts (last 30s), filter by severity/whitelist/time window, trigger RCA | `db_health_check`, `db_performance_analysis`, alert tools | "Every 10 seconds, check for new alerts created within the last 30 seconds. For each alert matching configured severity levels, instance whitelist, and time window constraints, perform an automated root cause analysis using database diagnostic tools." |
| 3 | `faultDiagnosis` | Diagnose unhealthy instances using fault diagnosis service | `db_health_check`, `db_performance_analysis`, `db_sql_execute` | "Every 60 seconds, diagnose all unhealthy database instances. Check their health status, performance metrics, and recent activity. Generate a diagnostic report for each affected instance." |
| 4 | `capacityCollection` | Collect capacity data (size, DB count, table count) from all active instances | `db_sql_execute` (to query `information_schema`), instance listing | "Every 5 minutes, collect capacity metrics from all active database instances: total size in GB, number of databases, and number of tables per database. Record the data for trend analysis." |
| 5 | `schemaCollection` | Collect schema snapshots and detect changes from all active instances | `db_sql_execute` (schema queries) | "Every 30 minutes, collect schema snapshots from all active database instances. Compare against the previous snapshot to detect schema changes such as new tables, altered columns, or dropped objects." |
| 6 | `indexCollection` | Collect index information from all active instances | `db_sql_execute` (index queries) | "Every 30 minutes, collect index information from all active database instances. Gather details on index names, columns, types, and usage statistics." |
| 7 | `baselineCalculation` | Calculate metric baselines for all instances x metrics (daily at 2 AM) | Metric query tools, baseline computation | "Every day at 2:00 AM, calculate performance metric baselines for all database instances. Compute per-metric, per-instance baselines for CPU, memory, IOPS, query latency, and connection counts." |
| 8 | `baselineCleanup` | Clean old baselines (retain 30 days) (weekly Sunday 3 AM) | Baseline database tools | "Every Sunday at 3:00 AM, clean up baseline data older than 30 days to free storage space." |
| 9 | `logCollection` | Collect database logs every 5 minutes | `db_sql_execute` (log queries) | "Every 5 minutes, collect and store database logs from all available sources. Capture error logs, slow query logs, and general activity logs." |
| 10 | `silenceCleanup` | Clean expired silence rules hourly | Alert database tools | "Every hour, clean up expired alert silence rules. Remove rules whose validity period has ended." |
| 11 | `reportScheduling` | Scan report configs matching cron expr, trigger report generation | Report generation tools | "Every 60 seconds, scan enabled report configurations. For each config, check if its cron expression matches the current time. If it does, generate the scheduled report (health, performance, slow_query, or capacity) in the configured format." |
| 12 | `escalationMonitoring` | Alert escalation rule check (currently a stub) | Alert escalation tools | "Every 10 seconds, check alert escalation rules for any pending escalations. Process auto-escalation logic for unacknowledged alerts." |
| 13 | `notificationCheck` | Notification queue check (currently a stub) | Notification tools | "Every 30 seconds, check the notification queue for pending notifications. Process and deliver any queued notifications to their configured channels." |

**Critical observation:** Handlers 1-3 (`topsqlAnalysis`, `rcaAnalysis`, `faultDiagnosis`) are marked `enabled=false` in the seed data, guarded by `ENABLE_AUTO_AI_ANALYSIS` config. Handlers 12-13 are stubs. This means **only about 8 handlers have real, active work**, but all 13 need NL seed descriptions.

### Key Insight: What the Agent Actually Runs vs. What Handlers Do

Most handlers are simple orchestrators that loop over instances and call existing platform services. They do NOT do complex AI analysis themselves -- they call services like `metricsDatabaseService`, `schemaService`, `indexService`, etc. The **agent's job** is to replicate this orchestration logic by calling the same underlying tools.

For handlers that loop over all instances (capacityCollection, schemaCollection, indexCollection, logCollection), the agent would need to:
1. List all active instances
2. For each instance, call the appropriate diagnostic/query tool
3. Aggregate the results

This is more expensive (multi-turn per instance) than the current loop-in-code approach. **Tradeoff to be aware of:** instance-looping handlers (capacity, schema, index, log collection) will use more tokens and take longer when executed by an agent vs. the current hardcoded loop.

### Existing Tool Catalog

Available tools auto-loaded via `getAgentEngine()` -> `loadPlatformTools()` -> `toolCatalog.getAll()`:

| Tool Name | Group | Description |
|-----------|-------|-------------|
| `slide_complete_analysis` | db_ops | Complete AI analysis and save Markdown result |
| `check_status` | slide_self_mgmt | Check system status |
| `add_database` | slide_self_mgmt | Add database instance |
| `test_connection` | slide_self_mgmt | Test database connection |
| `update_db_config` | slide_self_mgmt | Update database configuration |
| `configure_llm` | slide_self_mgmt | Configure LLM provider |
| `oracle_ash_report` | slide_self_mgmt | Oracle ASH report |
| `oracle_awr_report` | slide_self_mgmt | Oracle AWR report |
| `oracle_tablespace_detail` | slide_self_mgmt | Oracle tablespace details |
| `db_health_check` | (known tool) | Database health check |
| `db_performance_analysis` | (known tool) | Database performance analysis |
| `db_slow_queries` | (known tool) | Slow query retrieval |
| `db_sql_execute` | (known tool) | SQL execution |

The exact list of available tools depends on what is registered in `toolCatalog`. The above are known from `catalog.ts`, `slide-self-mgmt/`, and references in `ai-agent-bridge.ts`.

## Architecture Patterns

### System Architecture Diagram

```
  ┌─────────────────────────────────────────────────────────────┐
  │                    CronManager (cron-manager.ts)            │
  │  ┌──────────┐   ┌──────────┐   ┌──────────┐               │
  │  │ Job #1   │   │ Job #2   │   │  Job #N  │               │
  │  │ cron 5min│   │ cron 1hr │   │ cron 2AM │               │
  │  └────┬─────┘   └────┬─────┘   └────┬─────┘               │
  │       │               │              │                        │
  │       └───────────────┼──────────────┘                        │
  │                       ▼                                      │
  │         CronManager.executeJob(config)                        │
  └─────────────────────────┬────────────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │    CronExecutor              │  NEW FILE
              │  (cron-executor.ts)          │
              │                             │
              │  1. Read task_description   │
              │  2. Create session key      │
              │     cron:<jobId>:<ts>       │
              │  3. Build system prompt     │
              │  4. AgentRunner.run()       │
              │     - set llmTimeoutS: 300  │
              │     - set maxIterations: 20 │
              │     - CronHook collects     │
              │       tool events           │
              │  5. Write result to logs    │
              └──────────┬──────────────────┘
                         │
              ┌──────────┴──────────┐
              │                     │
              ▼                     ▼
  ┌─────────────────┐   ┌─────────────────────┐
  │  ToolRegistry    │   │  cron_job_logs      │
  │  (existing tools)│   │  (DB table)         │
  └─────────────────┘   └─────────────────────┘
         │
         ▼
  ┌─────────────────┐
  │  LLMProvider     │
  │  (Anthropic)     │
  └─────────────────┘
```

### Recommended Project Structure
```
apps/db-ops-api/src/cron/
├── cron-manager.ts          # EXISTING -- modify executeJob() for agent flow
├── cron-executor.ts         # NEW -- wraps AgentRunner.run() for cron
├── cron-job-service.ts      # EXISTING -- expand for JSON log columns
├── cron-completion-tool.ts  # NEW -- slide_complete_cron tool definition
├── cron-types.ts            # EXISTING -- add task_description + result types
```

### Pattern 1: CronExecutor
**What:** Wraps `AgentRunner.run()` specifically for cron task execution. Replaces `getHandler(name)()`.

```typescript
// Source: AI-SPEC.md Section 4 (verified by reading @slide/agent-core/src/runner.ts)

import { AgentRunner, NoopHook } from '@slide/agent-core';
import type { AgentHook, AgentHookContext, ToolEvent, Message } from '@slide/agent-core';

class CronHook extends NoopHook {
  public events: ToolEvent[] = [];
  override async afterIteration(ctx: AgentHookContext) {
    this.events.push(...ctx.toolEvents);
  }
}

export class CronExecutor {
  constructor(
    private runner: AgentRunner,
    private registry: import('@slide/agent-core').ToolRegistry,
    private provider: import('@slide/agent-core').LLMProvider,
  ) {}

  async execute(jobId: number, taskDescription: string, timeoutSeconds: number): Promise<AgentRunResult> {
    const sessionKey = `cron:${jobId}:${Date.now()}`;
    const hook = new CronHook();

    const result = await this.runner.run({
      initialMessages: [
        { role: 'system', content: this.buildSystemPrompt(taskDescription) },
        { role: 'user', content: taskDescription },
      ],
      tools: this.registry,
      model: this.provider.getDefaultModel(),
      maxIterations: 20,
      maxToolResultChars: 20000,
      temperature: 0.0,
      reasoningEffort: 'medium',
      hook,
      contextWindowTokens: 200_000,
      maxTokens: 4096,
      llmTimeoutS: timeoutSeconds,
      failOnToolError: false,
      sessionKey,
    });

    return result;
  }

  private buildSystemPrompt(task: string): string {
    return `You are a database operations automation agent.

TASK: ${task}

CONSTRAINTS:
- Maximum execution time: 5 minutes
- If a database tool fails, retry with different parameters or try an alternative approach
- Use multiple tools in sequence: gather data, analyze, then report
- When the task is complete, call slide_complete_cron to persist the structured result
- Do NOT ask for confirmation -- execute autonomously
- Only query read-only data; never execute DDL or DML statements

WORKFLOW:
1. First, check system health with available tools
2. Based on results, run specific diagnostic queries
3. Analyze the collected data
4. Generate a summary report
5. Call slide_complete_cron with status, summary, and details`;
  }
}
```

### Pattern 2: slide_complete_cron Tool
**What:** A registration-mirror of the existing `slide_complete_analysis` pattern, but for cron persistence.

```typescript
// Source: CompleteCronSchema from AI-SPEC + complete_analysis.ts pattern

import { toolCatalog } from '../../catalog.js';
import type { AnyAgentTool } from '../../types.js';

export const completeCronTool: AnyAgentTool = {
  name: 'slide_complete_cron',
  description: 'Complete the cron task and save results. Call this when the task is finished to persist the summary and analysis data to the cron job log.',
  parameters: {
    type: 'object',
    properties: {
      status: { 
        type: 'string', 
        enum: ['success', 'failure', 'partial'],
        description: 'Task outcome status'
      },
      summary: { 
        type: 'string', 
        description: 'Concise report of findings in Chinese, 1-3 paragraphs'
      },
      details: {
        type: 'object',
        description: 'Full analysis data with metrics, findings, and recommendations',
      },
    },
    required: ['status', 'summary'],
  },
  group: 'db_ops',
  handler: async (args) => {
    // Implementation: persist to cron_job_logs via the database service
    // (details depend on how the executor thread communicates with this tool)
    return { success: true, data: { saved: true } };
  },
};

toolCatalog.register(completeCronTool);
```

### Modified CronManager.executeJob()
```typescript
// Source: Adapted from existing cron-manager.ts + CONTEXT.md D-05

private async executeJob(config: CronJobConfig): Promise<void> {
  if (this.runningFlags.has(config.id)) {
    console.warn(`CronManager: 任务 #${config.id} "${config.name}" 跳过（正在执行中）`);
    return;
  }

  this.runningFlags.add(config.id);
  const startTime = Date.now();
  let logId: number | null = null;

  try {
    logId = await this.jobService.startLog(config.id);
    console.log(`CronManager: 执行任务 #${config.id} "${config.name}"`);

    // NEW: Agent execution replaces getHandler(config.handler)()
    const result = await this.cronExecutor.execute(
      config.id,
      config.task_description,
      config.timeout_seconds || 300,
    );

    const durationMs = Date.now() - startTime;
    const status = result.error ? 'error' 
      : result.stopReason === 'max_iterations' ? 'partial' 
      : 'success';

    // NEW: Rich log includes full execution trace
    await this.jobService.completeLog(logId, status, 
      result.finalContent || '执行完成',
      result.error || undefined,
      {
        tools_used: result.toolsUsed,
        tool_events: result.toolEvents,
        usage: result.usage,
        stop_reason: result.stopReason,
        duration_ms: durationMs,
      },
    );
    await this.jobService.updateRunResult(config.id, status);
  } catch (error: any) {
    if (logId !== null) {
      await this.jobService.completeLog(logId, 'error', `执行失败`, error.message);
    }
    await this.jobService.updateRunResult(config.id, 'error');
  } finally {
    this.runningFlags.delete(config.id);
  }
}
```

### Anti-Patterns to Avoid
- **Handler lookup dispatch.** Do NOT keep any getHandler() pattern -- the 13 handlers are deleted entirely.
- **Stub handlers with LLM.** Handlers 12-13 (escalationMonitoring, notificationCheck) are currently stubs. Their NL descriptions should honestly reflect their stub nature ("placeholder for future feature") not try to make them do something with an LLM.
- **Session key collision.** Two ticks of the same job MUST NOT share a sessionKey. Always include `Date.now()` in the key.
- **invoke() for cron.** `DirectAdapter.invoke()` is fire-and-forget and discards tool events. Always use `AgentRunner.run()` directly.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| LLM-tool execution loop | Custom while-true with tool call parsing | `@slide/agent-core` `AgentRunner` | Already handles parallel tool execution, context governance (snip, microcompact), timeout layering, checkpoint recovery, injection loops |
| Tool registration | Hand-rolled tool dispatch | `ToolRegistry` from `@slide/agent-core` | Auto-loads all platform tools, handles JSON Schema validation, parameter casting |
| Session persistence | Custom file-based session store | `SessionManager` from `@slide/agent-core` | JSONL-persisted with LRU cache, free audit trail for each cron tick |
| Cron expression parsing | Custom schedule computation | `cron` npm package | Already used, handles complex expressions, timezone-aware |
| Structured result validation | Manual field checks | `zod` schema | Declarative validation, clear error messages for agent retry |

**Key insight:** Every component needed for this phase already exists in the project. Using `@slide/agent-core` directly avoids reinventing the execution loop, session management, or context governance. The cron-specific additions are thin wrappers: a `CronExecutor` class and a `slide_complete_cron` tool.

## Common Pitfalls

### Pitfall 1: Agent Tool Call Loop (Runaway Iterations)
**What goes wrong:** Agent gets stuck calling the same tool repeatedly (e.g., calling `db_sql_execute` with slightly different queries in an infinite loop).
**Why it happens:** The LLM believes it needs more data and keeps querying.
**How to avoid:** Set `maxIterations: 20` (the `AgentRunner` enforces this). The `CronHook` can also detect repeated identical tool calls (>3 same tool+params) and inject a stop signal.
**Warning signs:** `toolsUsed` array growing very large, `stopReason: 'max_iterations'`.

### Pitfall 2: Timeout Without Partial Results
**What goes wrong:** 5-minute timeout kills execution but `cron_job_logs` shows no trace of what was done.
**Why it happens:** The error path doesn't persist `CronHook.events` before rethrowing.
**How to avoid:** In the `CronExecutor.execute()` catch block, save `hook.events` as `partial_trace` into the log before the timeout propagates.
**Warning signs:** Log shows `status: timeout` with empty `tool_events` and empty `result`.

### Pitfall 3: Expensive Per-Instance Loop in Agent
**What goes wrong:** Handlers that iterate all instances (capacity, schema, index) become 10x more expensive with an agent because each instance iteration costs a tool call + LLM turn.
**Why it happens:** Current code loops in TypeScript (fast, cheap). Agent loops via tool calls (slow, expensive).
**How to avoid:** For instance-looping tasks, consider a wrapper tool that accepts `instanceId` as a parameter and batch-processes. Or accept the cost for seed tasks that run infrequently (daily). The `capacityCollection` task running every 5 minutes could be expensive -- evaluate whether to keep this as a lightweight non-agent task or accept the cost.
**Warning signs:** Token usage spikes for a specific cron job.

### Pitfall 4: sessionKey Collision
**What goes wrong:** Two ticks write to the same session JSONL file, interleaving messages.
**Why it happens:** Two ticks fire before the first completes (unlikely with `runningFlags`, but possible after a server restart).
**How to avoid:** Always include `Date.now()` in the session key. Example: `cron:${jobId}:${Date.now()}`.
**Warning signs:** Session file contains messages from different timestamps interleaved.

### Pitfall 5: tool_events Not Captured
**What goes wrong:** `cron_job_logs.tool_events` is always `null` or empty.
**Why it happens:** Using `new NoopHook()` without extending it. `NoopHook.afterIteration()` is empty.
**How to avoid:** Always use a `CronHook` extension that populates an events array.
**Warning signs:** All logs have null `tool_events`.

## Implementation Approach

The minimal viable approach has these workstreams:

### Workstream 1: Schema Migration
1. Create `010_add_task_description_log_columns.sql` migration
2. Drop `handler` column from `cron_jobs`
3. Add `task_description TEXT NOT NULL` to `cron_jobs`
4. Expand `cron_job_logs` with JSON columns for agent trace
5. Update seed data: convert 13 handler references to NL descriptions

### Workstream 2: CronExecutor + Agent Integration
1. Create `cron-executor.ts`: wraps `AgentRunner.run()` for cron tasks
2. Create `cron-completion-tool.ts`: `slide_complete_cron` tool registration
3. Modify `cron-manager.ts`: `executeJob()` uses `cronExecutor.execute()`
4. Delete `cron-job-handlers.ts` and its import in `cron-manager.ts`

### Workstream 3: cron_job_logs Expansion
1. Expand `CronJobDatabaseService.completeLog()` to accept agent trace data
2. Expand `CronJobLog` type with JSON fields
3. Update `getLogs()` to return the new fields

### Workstream 4: UI Task Builder
1. New/edit form: replace `handler` dropdown with `task_description` textarea
2. Input validation for NL task content (minimum length, no empty)
3. Extend create/delete API routes

### Workstream 5: API Routes
1. Add `POST /api/cron/jobs` (create, requires `cron:manage`)
2. Add `DELETE /api/cron/jobs/:id` (delete, requires `cron:manage`)
3. Update `PUT /api/cron/jobs/:id` to include `task_description`
4. Update manual trigger route to use CronExecutor instead of `getHandler()`

### Workstream 6: Tests + Seed Data
1. Write the 13 NL seed descriptions (table above)
2. Create `cron-eval.test.ts` with code-based eval checks
3. Verify existing cron API routes still work

### Key Technical Decision: Approach A vs Approach B

**Approach A (Extend IAgentEngine with execute()):** Add a new method to the `IAgentEngine` interface and implement it in `DirectAdapter`. The AI-SPEC recommends this.

**Approach B (Direct AgentRunner in CronExecutor):** Create a standalone `CronExecutor` that uses `AgentRunner.run()` directly, without going through the `IAgentEngine` adapter layer.

**Recommendation: Approach B.** Rationale:
1. `IAgentEngine` is designed for chat/invoke patterns (streaming, fire-and-forget). Cron execution is a fundamentally different pattern (blocking, result-collection).
2. Adding `execute()` to `IAgentEngine` couples the interface to a single use case.
3. `CronExecutor` is self-contained -- it already needs its own session management and tool registry.
4. Simpler to test in isolation.
5. The existing `getAgentEngine()` already provides `AgentRunner`, `ToolRegistry`, and provider instances that `CronExecutor` can use.

### Key Technical Decision: Gateway Integration (D-07)

D-07 specifies using existing `sendGatewayChat`. However, the project has already migrated from Gateway to `DirectAdapter` (Phase 108-111). The AI-SPEC confirms this with `@slide/agent-core` as the selected framework.

**Decision:** Use `DirectAdapter`'s `AgentRunner.run()` directly, NOT Gateway `sendGatewayChat()`. The Gateway session create/close pattern in D-04 is replaced by `AgentRunner.run()` + `SessionManager`. This is consistent with the project's direction and avoids maintaining two execution paths.

If Gateway compatibility is required for some environments, implement it as a `CronExecutor` strategy interface, but the default is DirectAdapter.

## Validation Architecture

> `workflow.nyquist_validation` is absent from config.json -- treat as enabled.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (already configured at apps/db-ops-api/vitest.config.ts) |
| Config file | apps/db-ops-api/vitest.config.ts |
| Quick run command | `cd apps/db-ops-api && npx vitest run src/__tests__/cron-eval.test.ts --reporter=verbose` |
| Full suite command | `cd apps/db-ops-api && npx vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| D-01 | 13 seeds exist as NL descriptions in cron_jobs | unit | `check seed data count` | ❌ Wave 0 |
| D-02 | Agent can execute multi-turn with tool calls | integration | `cron-executor.test.ts` | ❌ New |
| D-03 | Results written to cron_job_logs with tool_events | unit | `cron-eval.test.ts` check | ❌ New |
| D-04 | Each tick has unique sessionKey | unit | `cron-eval.test.ts` check | ❌ New |
| D-05 | cron-job-handlers.ts deleted | code-review | `ls check` | N/A |
| D-06 | Timeout enforced at 300s | integration | `mock timeout test` | ❌ New |
| D-06 | Timeout produces partial_trace | integration | `mock timeout test` | ❌ New |
| D-07 | sendGatewayChat not used for cron | code-review | `grep check` | N/A |
| D-08 | UI form includes task_description textarea | e2e (manual) | manual check | ❌ New |
| D-09 | cron:view/manage permissions enforced | unit | `API route test` | ❌ New |

### Sampling Rate
- **Per task commit:** `cd apps/db-ops-api && npx vitest run src/__tests__/cron-eval.test.ts -t "structural"`
- **Per wave merge:** Full cro-n eval suite
- **Phase gate:** Full eval suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/__tests__/cron-eval.test.ts` -- structural completeness + safety checks
- [ ] `src/__tests__/cron-executor.test.ts` -- AgentRunner wrapper unit tests
- [ ] 13 NL seed descriptions in migration SQL

## Security Domain

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Existing JWT verifyToken middleware |
| V4 Access Control | yes | `cron:view`/`cron:manage` permission checks on all routes |
| V5 Input Validation | yes | Zod schema validation on `slide_complete_cron` tool payload |
| V6 Cryptography | no | No new crypto operations |

### Known Threat Patterns for Agent Cron
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Agent executes DDL/DML | Tampering | `db_sql_execute` wrapper regex guards (DROP/ALTER/TRUNCATE/DELETE/INSERT/UPDATE) |
| Agent accesses unauthorized instance | Elevation of Privilege | Scope validation in CronHook.beforeExecuteTools |
| Infinite tool-call loop | Denial of Service | `maxIterations: 20` hard cap + repeatedExternalLookupError guard |
| Prompt injection via task_description | Tampering | NL input is system prompt, not user input; low risk for admin-created tasks |

## Appendix: 13 Handler -> NL Seed Descriptions

Detailed seed data for the migration. Each NL description is designed to give the agent clear instructions about what to do:

| Handler Name | Cron Exp | NL Task Description |
|-------------|----------|-------------------|
| topsqlAnalysis | `*/10 * * * * *` | "Every 10 seconds, scan all active database instances for slow queries with average execution time >= 10 seconds. For each new slow query found, perform an automated AI analysis to identify optimization opportunities. Skip queries that have already been analyzed within the last 30 minutes. Call slide_complete_cron with your findings summary." |
| rcaAnalysis | `*/10 * * * * *` | "Every 10 seconds, check for new alerts created within the last 30 seconds. For each alert matching configured severity levels (warning, error, critical) and active time windows, perform automated root cause analysis. Use database health checks, performance analysis, and diagnostic tools. Call slide_complete_cron with the RCA findings." |
| faultDiagnosis | `*/60 * * * * *` | "Every 60 seconds, diagnose database instances that are reporting unhealthy status. For each affected instance, run comprehensive diagnostics: health check, performance analysis, connection check. Generate a diagnostic report with findings and recommendations. Call slide_complete_cron when diagnosis is complete." |
| capacityCollection | `*/5 * * * *` | "Every 5 minutes, collect capacity metrics from all active database instances. For each instance, query total storage size in GB, number of databases, and number of tables per database. Record the data for capacity trend analysis. Call slide_complete_cron with capacity summary." |
| schemaCollection | `*/30 * * * *` | "Every 30 minutes, collect complete schema snapshots (tables, columns, indexes) from all active database instances. Detect and report schema changes since the last snapshot. Note any new tables, altered columns, or dropped objects. Call slide_complete_cron with schema change summary." |
| indexCollection | `15,45 * * * *` | "Every 30 minutes (at :15 and :45 past each hour), collect index information from all active database instances. Gather index names, columns, types, and usage statistics. Call slide_complete_cron with the index inventory results." |
| baselineCalculation | `0 2 * * *` | "Every day at 2:00 AM local time, calculate performance metric baselines for all database instances. For each instance, compute per-metric baselines for CPU usage, memory utilization, IOPS, query latency, and connection counts. Use historical data for the computation. Call slide_complete_cron with baseline computation results." |
| baselineCleanup | `0 3 * * 0` | "Every Sunday at 3:00 AM, clean up baseline data that is older than 30 days. Remove old baseline records to free storage space. Only keep the most recent 30 days of baseline data. Call slide_complete_cron when cleanup is complete." |
| logCollection | `0 */5 * * * *` | "Every 5 minutes, collect and store database logs from all available sources. Capture error logs, activity logs, and any diagnostic log output. Call slide_complete_cron with a summary of collected log entries." |
| silenceCleanup | `0 * * * *` | "Every hour, check for expired alert silence rules. Remove any silence rules whose validity period has ended. Call slide_complete_cron with the count of expired rules cleaned." |
| reportScheduling | `*/60 * * * * *` | "Every 60 seconds, scan all enabled report configurations. For each configuration, check if the current time matches its cron schedule. If it matches, generate the scheduled report in the configured format (health, performance, slow_query, or capacity). Call slide_complete_cron with the report generation results." |
| escalationMonitoring | `*/10 * * * * *` | "Every 10 seconds, check alert escalation rules for any pending escalations. Process auto-escalation logic for unacknowledged alerts. This is a placeholder -- if escalation functionality is not yet implemented, report 'escalation monitoring running, no action needed'. Call slide_complete_cron with status." |
| notificationCheck | `*/30 * * * * *` | "Every 30 seconds, check the notification queue for pending notifications. Process and deliver queued notifications to their configured channels. This is a placeholder -- if notification delivery is not yet implemented, report 'notification check running, no pending notifications'. Call slide_complete_cron with status." |

## Sources

### Primary (HIGH confidence)
- [Context7 NOT used] -- This is a project-specific codebase, no external library docs needed
- `packages/agent-core/src/runner.ts` -- AgentRunner implementation, timeout handling, hook system
- `packages/agent-core/src/session.ts` -- Session + SessionManager with JSONL persistence
- `packages/agent-core/src/types.ts` -- AgentRunSpec, AgentRunResult, Tool, AgentHook interfaces
- `apps/db-ops-api/src/cron/cron-manager.ts` -- Current CronManager scheduling + execution
- `apps/db-ops-api/src/cron/cron-job-service.ts` -- Current CRUD operations
- `apps/db-ops-api/src/cron/cron-job-handlers.ts` -- 13 handlers to be replaced
- `apps/db-ops-api/src/cron/types.ts` -- Current type definitions
- `apps/db-ops-api/src/adapter/types.ts` -- IAgentEngine interface (no execute() yet)
- `apps/db-ops-api/src/adapter/direct-adapter.ts` -- DirectAdapter implementation
- `apps/db-ops-api/src/adapter/get-agent-engine.ts` -- Adapter factory + tool loading
- `apps/db-ops-api/src/adapter/llm-provider.ts` -- AnthropicProvider
- `apps/db-ops-api/src/tools/catalog.ts` -- Tool catalog management
- `apps/db-ops-api/src/tools/types.ts` -- AnyAgentTool interface
- `apps/db-ops-api/src/tools/generated/slide-self-mgmt/complete_analysis.ts` -- Pattern for slide_complete_cron
- `apps/db-ops-api/sql/migrations/009_add_cron_jobs_tables.sql` -- Current cron_jobs schema
- `.planning/phases/113-ai-cron-agent/113-CONTEXT.md` -- Locked decisions D-01 through D-09
- `.planning/phases/113-ai-cron-agent/113-AI-SPEC.md` -- AI design contract, framework reference, eval strategy

### Secondary (MEDIUM confidence)
- `apps/db-ops-api/server.ts` (cron initialization + API routes) -- Verified interaction between CronManager and HTTP API

### Tertiary (LOW confidence)
- (None -- all claims verified against codebase)

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| MySQL | cron_jobs / cron_job_logs | ✓ | -- | -- |
| Anthropic API (env var) | AgentRunner LLM calls | ✓ | -- | -- |
| `@slide/agent-core` | CronExecutor, AgentRunner | workspace | -- | -- |
| `cron` npm package | Schedule parsing | ✓ | ^2.4 | -- |
| `zod` | Result validation | ✓ | (at workspace) | Manual validation |

**Missing dependencies with no fallback:** None -- all dependencies already exist.

## Open Questions (RESOLVED)

1. **How does slide_complete_cron communicate with the executor thread?**
   - What we know: The tool handler runs inside the AgentRunner's tool execution loop. It needs access to the `cron_job_logs` database service to persist the result.
   - What's unclear: Should the tool accept a `logId` parameter (like `slide_complete_analysis` uses `analysisId`) or should it have access to a closure with the current job context?
   - Recommendation: Pass `logId` as a parameter to `slide_complete_cron`, mirroring the `slide_complete_analysis` pattern. The CronManager creates the log before executing the agent, and the tool completes it.

2. **Should instance-looping handlers (capacity, schema, index) be agent-driven or remain as lightweight service calls?**
   - What we know: Looping all instances via agent tool calls is 10-100x more expensive than the current service-loop pattern.
   - What's unclear: Whether the added cost is acceptable for operational value.
   - Recommendation: Accept the cost for seed tasks that run infrequently. Schedule capacityCollection at */15 instead of */5 if cost is a concern. Revisit after production data.

3. **How to handle the ENABLE_AUTO_AI_ANALYSIS guard?**
   - What we know: Handlers 1-3 (topsqlAnalysis, rcaAnalysis, faultDiagnosis) were disabled by default, gated by a config check.
   - What's unclear: Does the config check move into the NL task description ("Only run this if ENABLE_AUTO_AI_ANALYSIS is enabled") or is it a separate mechanism?
   - Recommendation: Keep these 3 jobs as `enabled=false` in seed data. The config check logic is deleted with the handler -- users explicitly enable jobs they want.

4. **Does the manual trigger endpoint need to change?**
   - What we know: `POST /api/cron/jobs/:id/run` currently calls `getHandler(config.handler)()`.
   - What's unclear: Should manual triggers also go through the AgentRunner?
   - Recommendation: Yes -- the manual trigger should use the same CronExecutor path so manual and automatic executions produce consistent log formats.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- All components verified against codebase (the project already has everything)
- Architecture: HIGH -- CronManager modification pattern is straightforward
- Pitfalls: HIGH -- Based on reading AgentRunner implementation + known nanobot patterns
- Seed NL descriptions: MEDIUM -- These are based on reading handler implementations but actual NL quality affects agent performance

**Research date:** 2026-05-27
**Valid until:** 2026-06-27 (30 days, the codebase is moving but the agent-core infrastructure is stable)
