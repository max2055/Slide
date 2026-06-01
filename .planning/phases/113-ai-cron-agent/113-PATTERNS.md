# Phase 113: AI Agent Cron — Pattern Map

**Mapped:** 2026-05-27
**Files analyzed:** 11 (5 new, 5 modify, 1 delete)
**Analogs found:** 9 / 10 (1 no-analog: frontend task-builder dialog)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `apps/db-ops-api/src/cron/cron-executor.ts` | service | CRUD (agent execution) | `apps/db-ops-api/src/adapter/direct-adapter.ts` (`invoke()` method) | role-match+data-flow-match |
| `apps/db-ops-api/src/cron/cron-completion-tool.ts` | utility (tool) | CRUD (tool registration) | `apps/db-ops-api/src/tools/generated/slide-self-mgmt/complete_analysis.ts` | exact |
| `apps/db-ops-api/src/cron/cron-manager.ts` | controller | event-driven | `apps/db-ops-api/src/cron/cron-manager.ts` (existing, modify) | self |
| `apps/db-ops-api/src/cron/cron-job-service.ts` | service | CRUD | `apps/db-ops-api/src/cron/cron-job-service.ts` (existing, modify) | self |
| `apps/db-ops-api/src/cron/cron-types.ts` | config | static | `apps/db-ops-api/src/cron/types.ts` (existing, modify) | self |
| `apps/db-ops-api/sql/migrations/010_add_task_description_log_columns.sql` | migration | batch | `apps/db-ops-api/sql/migrations/009_add_cron_jobs_tables.sql` | exact |
| `apps/db-ops-api/server.ts` (cron routes) | route | request-response | `apps/db-ops-api/server.ts` lines 3679-3837 (existing routes) | self |
| `apps/db-ops-api/src/cron/cron-job-handlers.ts` | controller | CRUD | N/A — DELETE (replaced by agent) | N/A |
| `apps/db-ops-api/src/__tests__/cron-eval.test.ts` | test | static | `apps/db-ops-api/src/tools/generated/slide-self-mgmt/complete_analysis.test.ts` | role-match |
| `apps/db-ops-api/src/__tests__/cron-executor.test.ts` | test | static | `apps/db-ops-api/src/auth/migration.test.ts` | role-match |
| `frontend/src/app/ui/views/cron-jobs-settings.ts` | component | request-response | existing file (modify) + no analog for task-builder dialog | partial |

## Pattern Assignments

---

### `apps/db-ops-api/src/cron/cron-executor.ts` (service, CRUD)

**Analog:** `apps/db-ops-api/src/adapter/direct-adapter.ts` lines 440-468 (`invoke()` method) + lines 364-377 (`chat()` runner.run() call)

**Imports pattern** (direct-adapter.ts lines 23-35):
```typescript
import {
  AgentRunner,
  NoopHook,
  ToolRegistry,
  SessionManager,
} from '@slide/agent-core';
import type { AgentHook, AgentHookContext, ToolEvent, Message } from '@slide/agent-core';
```

**Core pattern — AgentRunner.run() call** (direct-adapter.ts lines 364-377):
```typescript
const result = await this.runner.run({
  initialMessages: contextMessages as Message[],
  tools: this.registry,
  model: this.provider.getDefaultModel(),
  maxIterations: 10,
  maxToolResultChars: 20000,
  temperature: 0.0,
  reasoningEffort: 'medium',
  hook,
  checkpointCallback,
  contextWindowTokens: 200_000,
  maxTokens: 4096,
  sessionKey,
});
```

**Core pattern — invoke() error handling** (direct-adapter.ts lines 461-467):
```typescript
const errorMessage = err instanceof Error ? err.message : String(err);
console.error(`[DirectAdapter] invoke() failed for session ${sessionKey}:`, errorMessage);
// Save session even on error so partial state is not lost
try { await this.sessionManager.save(session); } catch { /* best-effort */ }
throw err;
```

**Custom Hook pattern** (RESEARCH.md lines 330-335, to be written in cron-executor.ts):
```typescript
class CronHook extends NoopHook {
  public events: ToolEvent[] = [];
  override async afterIteration(ctx: AgentHookContext) {
    this.events.push(...ctx.toolEvents);
  }
}
```

**Key differences from analog:**
- CronExecutor does NOT need WebSocket transport; it's fire-and-forget
- Uses CronHook instead of mapHookEventToChatEvent
- Session key format: `cron:${jobId}:${Date.now()}`
- Sets `llmTimeoutS: timeoutSeconds` and `maxIterations: 20` for cron workloads
- Does NOT call `sessionManager.save()` — session persistence handled by AgentRunner internally
- Must capture partial_trace on timeout/error in catch block

---

### `apps/db-ops-api/src/cron/cron-completion-tool.ts` (utility, CRUD)

**Analog:** `apps/db-ops-api/src/tools/generated/slide-self-mgmt/complete_analysis.ts`

**Imports pattern** (complete_analysis.ts lines 4-6):
```typescript
import type { AnyAgentTool } from '../../types.js';
import { toolCatalog } from '../../catalog.js';
// import the specific database service needed
import { aiAnalysisDatabaseService } from '../../../ai-analysis-database-service.js';
```

**Tool definition pattern** (complete_analysis.ts lines 8-41):
```typescript
export const completeAnalysisTool: AnyAgentTool = {
  name: 'slide_complete_analysis',
  description: '完成 AI 分析并将结果保存到数据库。分析结束后必须调用，否则分析不会保存。',
  parameters: {
    type: 'object',
    properties: {
      analysisId: { type: 'number', description: '分析记录 ID' },
      markdown: { type: 'string', description: '分析结果 Markdown 内容' },
    },
    required: ['analysisId', 'markdown'],
  },
  group: 'db_ops',
  handler: async (args) => {
    const typedArgs = args as unknown as {
      analysisId: number;
      markdown: string;
    };

    try {
      await aiAnalysisDatabaseService.completeAnalysis(typedArgs.analysisId, {
        result: typedArgs.markdown,
      });
      return {
        success: true,
        data: { saved: true, analysisId: typedArgs.analysisId },
        summary: '分析结果已保存',
      };
    } catch (error: any) {
      return {
        success: false,
        error: `保存分析结果失败: ${error.message}`,
      };
    }
  },
};
```

**Registration pattern** (complete_analysis.ts line 44):
```typescript
toolCatalog.register(completeAnalysisTool);
```

**Key differences:**
- Tool name: `slide_complete_cron` instead of `slide_complete_analysis`
- Parameters: `status` (enum: success/failure/partial), `summary` (string), `details` (object — optional)
- Database service: `cronJobService` instead of `aiAnalysisDatabaseService`
- Group: same `db_ops`
- Import path: relative path to `cron-job-service` — `../../cron/cron-job-service.js`

---

### `apps/db-ops-api/src/cron/cron-manager.ts` (controller, event-driven) — MODIFY

**Analog:** Existing file at `apps/db-ops-api/src/cron/cron-manager.ts`

**Import change** — remove `getHandler`/`handlerNames`, add `CronExecutor` (lines 10-13 current, will become):
```typescript
import { CronJob } from 'cron';
import { CronJobDatabaseService } from './cron-job-service';
import { CronJobConfig } from './types';
import { CronExecutor } from './cron-executor';
```

**Constructor change** — add cronExecutor dependency (line 28-30 current):
```typescript
constructor(
  private jobService: CronJobDatabaseService,
  private cronExecutor: CronExecutor,
) {
  // ...
}
```

**executeJob() replacement** — the core modification (lines 113-148 current, modeled on RESEARCH.md lines 437-487):
```typescript
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

**reload() change** — remove `handlerNames` filter, use all jobs directly (lines 53-68 current):
```typescript
async reload(): Promise<void> {
  this.stopAllJobs();
  if (!this.running) return;

  try {
    const enabledJobs = await this.jobService.getEnabledJobs();
    for (const config of enabledJobs) {
      this.scheduleJob(config);
    }
    console.log(`CronManager: ${enabledJobs.length} 个任务已调度`);
  } catch (error) {
    console.error('CronManager 重载失败:', error);
  }
}
```

---

### `apps/db-ops-api/src/cron/cron-job-service.ts` (service, CRUD) — MODIFY

**Analog:** Existing file at `apps/db-ops-api/src/cron/cron-job-service.ts`

**Current completeLog()** (lines 240-255) — expand signature for agent trace:
```typescript
// Current:
async completeLog(logId: number, status: string, summary?: string, errorMessage?: string): Promise<boolean> {
  const pool = this.getPool();
  if (!pool) return false;
  try {
    const [result] = await pool.execute(
      'UPDATE cron_job_logs SET finished_at = NOW(), status = ?, result_summary = ?, error_message = ? WHERE id = ?',
      [status, summary || null, errorMessage || null, logId]
    );
    return (result as any).affectedRows > 0;
  } catch (error) {
    console.error('更新执行日志失败:', error);
    return false;
  }
}
```

**Expanded completeLog()** — accept optional agent trace columns:
```typescript
// New signature:
async completeLog(
  logId: number,
  status: string,
  summary?: string,
  errorMessage?: string,
  trace?: {
    tools_used?: string[];
    tool_events?: any[];
    usage?: Record<string, number>;
    stop_reason?: string;
    duration_ms?: number;
    partial_trace?: string;
  },
): Promise<boolean> {
  const pool = this.getPool();
  if (!pool) return false;
  try {
    const [result] = await pool.execute(
      `UPDATE cron_job_logs
       SET finished_at = NOW(), status = ?, result_summary = ?,
           error_message = ?,
           tools_used = ?,
           tool_events = ?,
           usage = ?,
           stop_reason = ?,
           duration_ms = ?,
           partial_trace = ?
       WHERE id = ?`,
      [
        status,
        summary || null,
        errorMessage || null,
        trace?.tools_used ? JSON.stringify(trace.tools_used) : null,
        trace?.tool_events ? JSON.stringify(trace.tool_events) : null,
        trace?.usage ? JSON.stringify(trace.usage) : null,
        trace?.stop_reason || null,
        trace?.duration_ms || null,
        trace?.partial_trace || null,
        logId,
      ]
    );
    return (result as any).affectedRows > 0;
  } catch (error) {
    console.error('更新执行日志失败:', error);
    return false;
  }
}
```

**New methods needed** — POST/DELETE for cron_jobs (following existing CRUD pattern, lines 101-153):
```typescript
// Create job (follows updateJob pattern but INSERT)
async createJob(data: {
  name: string;
  task_description: string;
  cron_expr: string;
  timezone?: string;
  description?: string;
  timeout_seconds?: number;
}): Promise<number> {
  const pool = this.getPool();
  if (!pool) throw new Error('数据库未连接');

  try {
    const [result] = await pool.execute(
      `INSERT INTO cron_jobs (name, task_description, cron_expr, timezone, description, timeout_seconds)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        data.name,
        data.task_description,
        data.cron_expr,
        data.timezone || 'Asia/Shanghai',
        data.description || null,
        data.timeout_seconds || 300,
      ]
    );
    return (result as any).insertId;
  } catch (error: any) {
    console.error('创建定时任务失败:', error);
    throw error;
  }
}

// Delete job (follows existing CASCADE pattern)
async deleteJob(id: number): Promise<boolean> {
  const pool = this.getPool();
  if (!pool) return false;

  try {
    const [result] = await pool.execute(
      'DELETE FROM cron_jobs WHERE id = ?',
      [id]
    );
    return (result as any).affectedRows > 0;
  } catch (error) {
    console.error('删除定时任务失败:', error);
    return false;
  }
}
```

**Query column changes** — all SELECT queries replace `handler` with `task_description`:
- Line 35: Change `handler,` to `task_description,`
- Line 57: Same change for getEnabledJobs()
- Line 79: Same change for getJobById()

**updateJob() field additions** — add task_description to updatable fields (around line 101):
```typescript
// Add to updateJob():
if (data.task_description !== undefined) {
  updates.push('task_description = ?');
  values.push(data.task_description);
}
```

---

### `apps/db-ops-api/src/cron/cron-types.ts` (config, static) — MODIFY

**Analog:** Existing file at `apps/db-ops-api/src/cron/types.ts`

**Current CronJobConfig** (lines 25-40) — replace `handler: string` with `task_description: string`:
```typescript
export interface CronJobConfig {
  id: number;
  name: string;
  task_description: string;  // was: handler: string
  cron_expr: string;
  enabled: boolean;
  timezone: string;
  description: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  last_result: string | null;
  timeout_seconds: number;
  retry_count: number;
  created_at: string;
  updated_at: string;
}
```

**Current CronJobLog** (lines 43-51) — expand with JSON columns:
```typescript
export interface CronJobLog {
  id: number;
  job_id: number;
  started_at: string;
  finished_at: string | null;
  status: CronJobStatus;           // extended: 'timeout' | 'partial' added
  result_summary: string | null;
  error_message: string | null;
  result: string | null;           // NEW: LONGTEXT for full agent output
  tools_used: string[] | null;     // NEW: JSON
  tool_events: any[] | null;       // NEW: JSON
  usage: Record<string, number> | null; // NEW: JSON
  stop_reason: string | null;      // NEW
  duration_ms: number | null;      // NEW
  error_trace: string | null;      // NEW
  partial_trace: string | null;    // NEW: LONGTEXT
}
```

**Remove HandlerName type** (lines 9-22) — no longer needed since handlers are deleted:
```typescript
// DELETE this entire type:
// export type HandlerName = 'topsqlAnalysis' | 'rcaAnalysis' | ...
```

**Replace CronJobStatus** (line 6) — extend with timeout and partial:
```typescript
export type CronJobStatus = 'success' | 'error' | 'running' | 'skipped' | 'timeout' | 'partial';
```

**Add AgentRunResult type** — for the CronExecutor return type:
```typescript
export interface AgentRunResult {
  finalContent: string | null;
  error: string | null;
  toolsUsed: any[];
  toolEvents: any[];
  usage: Record<string, number>;
  stopReason: string;
  durationMs: number;
}
```

---

### `apps/db-ops-api/sql/migrations/010_add_task_description_log_columns.sql` (migration, batch)

**Analog:** `apps/db-ops-api/sql/migrations/009_add_cron_jobs_tables.sql`

**Migration header pattern** (009 lines 1-11):
```sql
-- ============================================
-- Migration 010: Task Description + Log Columns
-- Phase 113 - AI Agent Cron
-- ============================================
-- Purpose: Replace handler column with task_description (NL text)
--          and expand cron_job_logs with JSON columns for agent trace.
-- ============================================

START TRANSACTION;
```

**Migration body** — ALTER TABLE pattern (009 lines 18-52 for reference):
```sql
-- 1. Replace handler with task_description
ALTER TABLE cron_jobs
  DROP COLUMN handler,
  ADD COLUMN task_description TEXT NOT NULL AFTER name;

-- 2. Expand cron_job_logs for agent trace
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

**Seed data pattern** — UPDATE existing seed with NL descriptions (009 lines 74-87):
```sql
-- 3. Update seed data with NL task descriptions
UPDATE cron_jobs SET task_description = 'Every 10 seconds, scan all active database instances for slow queries with average execution time >= 10 seconds...' WHERE name = 'TopSQL 自动分析';
UPDATE cron_jobs SET task_description = 'Every 10 seconds, check for new alerts created within the last 30 seconds...' WHERE name = '告警 RCA 分析';
-- ... (13 updates)

COMMIT;
```

---

### `apps/db-ops-api/server.ts` (route, request-response) — MODIFY

**Analog:** Existing cron routes at lines 3679-3837

**Route registration pattern** (lines 3680-3690):
```typescript
fastify.get('/api/cron/jobs', {
  preHandler: [verifyToken, requirePermission('cron:view')],
  handler: async (request, reply) => {
    try {
      const jobs = await cronJobService.getJobs();
      reply.send(jobs);
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  }
});
```

**New POST route** (following same pattern):
```typescript
// Create a new cron job
fastify.post('/api/cron/jobs', {
  preHandler: [verifyToken, requirePermission('cron:manage')],
  handler: async (request, reply) => {
    try {
      const body = request.body as any;

      // Validate required fields
      if (!body.name || !body.task_description || !body.cron_expr) {
        return reply.code(400).send({ error: '缺少必要参数：name, task_description, cron_expr' });
      }

      // Validate cron expression
      try {
        new CronJob(body.cron_expr, () => {});
      } catch {
        return reply.code(400).send({ error: '无效的 cron 表达式' });
      }

      const id = await cronJobService.createJob({
        name: body.name,
        task_description: body.task_description,
        cron_expr: body.cron_expr,
        timezone: body.timezone,
        description: body.description,
        timeout_seconds: body.timeout_seconds,
      });

      await cronManager.reload();
      reply.code(201).send({ id, message: '创建成功' });
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  }
});
```

**New DELETE route** (following same pattern):
```typescript
// Delete a cron job
fastify.delete('/api/cron/jobs/:id', {
  preHandler: [verifyToken, requirePermission('cron:manage')],
  handler: async (request, reply) => {
    try {
      const { id } = request.params as any;

      const existing = await cronJobService.getJobById(Number(id));
      if (!existing) return reply.code(404).send({ error: '定时任务不存在' });

      await cronJobService.deleteJob(Number(id));
      await cronManager.reload();
      reply.send({ message: '删除成功' });
    } catch (error: any) {
      reply.code(500).send({ error: error.message });
    }
  }
});
```

**Modify PUT route** — add task_description to updatable fields (around line 3727):
```typescript
// Add to the existing update fields:
const updated = await cronJobService.updateJob(Number(id), {
  task_description: body.task_description,  // NEW
  cron_expr: body.cron_expr,
  enabled: body.enabled,
  timezone: body.timezone,
  description: body.description,
  timeout_seconds: body.timeout_seconds,
  retry_count: body.retry_count,
});
```

**Manual trigger route change** (lines 3786-3797) — use CronExecutor instead of getHandler:
```typescript
// Replace lines 3789-3792:
// OLD:
// const handler = getHandler(config.handler);
// await handler();
// await cronJobService.completeLog(logId, 'success', '手动触发执行成功');
// NEW:
const result = await cronExecutor.execute(
  config.id,
  config.task_description,
  config.timeout_seconds || 300,
);
await cronJobService.completeLog(logId, 'success', 
  result.finalContent || '手动触发执行成功',
  undefined,
  {
    tools_used: result.toolsUsed,
    tool_events: result.toolEvents,
    usage: result.usage,
    stop_reason: result.stopReason,
    duration_ms: Date.now() - startTime,
  },
);
reply.send({ logId, status: 'success' });
```

---

### `frontend/src/app/ui/views/cron-jobs-settings.ts` (component, request-response) — MODIFY

**Analog:** Existing file (no exact analog for task builder — this is new UI)

**Current architecture pattern** — LitElement with @customElement, @state, authFetch (lines 1-7):
```typescript
import { LitElement, html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { authFetch } from "../../../api/index.js";
```

**New interface additions** — add to existing CronJobConfig:
```typescript
interface CronJobConfig {
  // ...existing fields...
  task_description: string;  // NEW — was handler: string
}
```

**Task builder dialog pattern** — modeled on existing trigger dialog (lines 614-630):
```typescript
// Trigger dialog pattern (reuse for create/edit form):
${this.createDialogOpen ? html`
  <div class="dialog-overlay" @click=${this.closeCreateDialog}>
    <div class="dialog" @click=${(e: Event) => e.stopPropagation()}>
      <h3 class="dialog-title">${this.editingJob ? '编辑定时任务' : '新建定时任务'}</h3>
      ${this.createError ? html`<div class="dialog-error">${this.createError}</div>` : nothing}
      <div class="dialog-body">
        <div style="display:flex;flex-direction:column;gap:12px;">
          <label style="font-size:12px;font-weight:500;color:var(--muted);">
            任务名称
            <input class="cron-input" style="width:100%;margin-top:4px;" .value=${this.formName} @input=${this.onNameInput} />
          </label>
          <label style="font-size:12px;font-weight:500;color:var(--muted);">
            任务描述 (NL)
            <textarea class="cron-input" style="width:100%;min-height:80px;margin-top:4px;font-family:inherit;" .value=${this.formTaskDescription} @input=${this.onTaskDescInput}></textarea>
          </label>
          <label style="font-size:12px;font-weight:500;color:var(--muted);">
            Cron 表达式
            <input class="cron-input" style="width:100%;margin-top:4px;" .value=${this.formCronExpr} @input=${this.onCronExprInput} />
          </label>
        </div>
      </div>
      <div class="dialog-actions">
        <button class="btn" @click=${this.closeCreateDialog}>取消</button>
        <button class="btn-primary" @click=${this.confirmCreate}>${this.editingJob ? '保存' : '创建'}</button>
      </div>
    </div>
  </div>
` : nothing}
```

**Key pattern to follow:**
- Use same `authFetch` pattern for create/update API calls (lines 271-278)
- Use same `dialog-overlay`/`dialog` structure (lines 614-630)
- Use same `showToast` pattern for success/error feedback (lines 241-244)
- Add new state properties for the form fields
- Add "新建任务" button in the table header area

---

## Shared Patterns

### Authentication / Permission Middleware
**Source:** `apps/db-ops-api/server.ts` lines 86-112 (verifyToken) + line 3709 (requirePermission)
**Apply to:** All cron API routes
```typescript
// Route handler pattern:
preHandler: [verifyToken, requirePermission('cron:view')]   // for GET routes
preHandler: [verifyToken, requirePermission('cron:manage')]  // for POST/PUT/DELETE routes
```

### Error Handling in Routes
**Source:** `apps/db-ops-api/server.ts` lines 3682-3688
**Apply to:** All cron API routes
```typescript
handler: async (request, reply) => {
  try {
    // ... business logic ...
    reply.send(result);
  } catch (error: any) {
    reply.code(500).send({ error: error.message });
  }
}
```

### Database Connection Pattern
**Source:** `apps/db-ops-api/src/cron/cron-job-service.ts` lines 13-16
**Apply to:** cron-job-service.ts (existing pattern, keep)
```typescript
private getPool(): mysql.Pool | null {
  return dbConnection.getPool();
}
```

### Test: Tool Registration Pattern
**Source:** `apps/db-ops-api/src/tools/generated/slide-self-mgmt/complete_analysis.test.ts`
**Apply to:** cron-eval.test.ts (tool registration test)
```typescript
it('tool is registered in catalog after module import', () => {
  expect(toolCatalog.has('slide_complete_cron')).toBe(true);
});
```

### Test: Migration SQL Pattern
**Source:** `apps/db-ops-api/src/auth/migration.test.ts` lines 136-168
**Apply to:** cron-eval.test.ts (migration integrity test)
```typescript
const fs = await import('fs');
const path = await import('path');
const migrationPath = path.resolve(__dirname, '../../sql/migrations/010_add_task_description_log_columns.sql');
let sql = fs.readFileSync(migrationPath, 'utf8');
const statements = sql.split(';').filter(s => s.trim().length > 0);
for (const statement of statements) {
  const trimmed = statement.trim();
  if (trimmed.length > 0) {
    await pool!.execute(trimmed);
  }
}
```

### Frontend: authFetch API Calls
**Source:** `frontend/src/app/ui/views/cron-jobs-settings.ts` lines 250-254, 271-278
**Apply to:** All frontend API calls in cron-jobs-settings.ts
```typescript
const res = await authFetch("/api/cron/jobs");
if (!res.ok) {
  throw new Error(`加载失败 (${res.status})`);
}

// For POST/PUT:
const res = await authFetch(`/api/cron/jobs/${job.id}`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ... }),
});
```

## No Analog Found

Files with no close match in the codebase (planner should use RESEARCH.md patterns instead):

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| Frontend task-builder dialog component (new form inside cron-jobs-settings.ts) | component | request-response | No existing create-form dialog for cron jobs; the existing code only has a trigger dialog. Use the trigger dialog template (lines 614-630) as the structural starting point, but the form fields (name, task_description textarea, cron_expr input) are new. |

## Metadata

**Analog search scope:**
- `apps/db-ops-api/src/cron/` — all 4 existing files
- `apps/db-ops-api/src/adapter/` — direct-adapter.ts, get-agent-engine.ts, llm-provider.ts
- `apps/db-ops-api/src/tools/generated/slide-self-mgmt/` — complete_analysis.ts + test
- `apps/db-ops-api/sql/migrations/` — 009_add_cron_jobs_tables.sql
- `apps/db-ops-api/server.ts` — lines 3655-3837 (cron initialization + routes)
- `apps/db-ops-api/src/auth/` — migration.test.ts
- `frontend/src/app/ui/views/` — cron-jobs-settings.ts

**Files scanned:** 20 (source files), 10 (relevant analog reads)
**Pattern extraction date:** 2026-05-27
