# Phase 103: Report Restructuring - Research

**Researched:** 2026-05-21
**Domain:** Backend template refactoring, scheduled task CRUD, data migration
**Confidence:** HIGH

## Summary

Phase 103 involves three tightly scoped technical workstreams: (1) extracting four inline HTML template strings from report-service.ts into EJS template files, (2) adding a report_configs table with CRUD API and CronJob scheduler following the existing alert_rules pattern, and (3) unifying the report type naming inconsistency where `ReportType` uses `'slow-query'` (hyphen) while every other code path including the database schema uses `'slow_query'` (underscore). The fourth requirement (RPT-04) is already satisfied by Phase 102.

The codebase has a mature CronJob pattern (10+ instances in server.ts) and a complete CRUD template (alert_rules) that makes RPT-02 mostly mechanical. RPT-01 requires careful template splitting (layout.ejs + 4 type-specific templates) but the HTML structure is uniform and well-understood. RPT-03 is a 3-file type fix plus optional data migration SQL.

**Primary recommendation:** Execute as 3-4 plans: (1) migration SQL + EJS templates + report-service refactor, (2) report_configs CRUD (DB + service + API), (3) scheduler CronJob + report frontend UI extension, (4) optional: type unification as part of plan 1 since it touches report-database-service.ts.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions (D-01 through D-13)

- **D-01:** Template directory `apps/db-ops-api/src/templates/reports/`
- **D-02:** Architecture: shared `layout.ejs` (common HTML structure + base styles) + per-type templates (`health.ejs`, `performance.ejs`, `slow-query.ejs`, `capacity.ejs`), each defining only content area and differentiated styles
- **D-03:** Unified `ReportContext` TypeScript interface -- layout.ejs consumes common fields (title, generatedAt, instanceName), each template extends its own data fields
- **D-04:** New npm dependency `ejs@^5.0.2`
- **D-05:** New `report_configs` table with fields: id, name, cron, type, instance_id, format, enabled, created_at, updated_at
- **D-06:** Scheduler: one CronJob (scan every 60s, WHERE enabled=1), match current minute to cron expression, call `reportService.generateReport()`, store result in existing `reports` table
- **D-07:** API: `/api/reports/configs` CRUD routes (GET/POST/PUT/DELETE), permissions reuse `report:create` / `report:view`
- **D-08:** Frontend: add "Scheduled Report Configs" card area in reports.ts between generate card and history list
- **D-09:** Canonical name unified to `slow_query` (underscore) -- consistent with validTypes, report-service.ts writes, frontend requests
- **D-10:** Migration SQL: UPDATE reports SET type = 'slow_query' WHERE type = 'slow-query'; fix ReportType type definition and frontend label map
- **D-11:** Full audit of all report type references (health/performance/capacity) ensuring no hidden inconsistency in URL query params and export filenames
- **D-12:** RPT-04 satisfied by Phase 102, reports.ts already uses `<stat-card>`
- **D-13:** RPT-04 is cross-validated, Phase 103 does not repeat this work

### Claude's Discretion
- report_configs table schema design and indexes
- EJS layout.ejs HTML structure and CSS design
- CronJob scan dedup logic (prevent same-minute re-trigger)
- Edge inconsistencies found during naming audit

### Deferred Ideas (OUT OF SCOPE)
- None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| RPT-01 | Extract inline HTML to EJS templates | 4 template methods identified (health/performance/slow-query/capacity), share ~70% common structure suitable for layout.ejs pattern. EJS v5.0.2 verified at npm. `renderFile()` API confirmed via ejs.co docs. Pattern for adding EJS dependency and importing template path known. |
| RPT-02 | Report configs table + scheduled generation | alert_rules pattern fully documented (CRUD routes + service + timeline). report_service.generateReport() exists as unified entry point. CronJob pattern with 10+ examples at server.ts:3240-3503. CronJob dedup can use in-memory last-run map. |
| RPT-03 | Unify slow-query -> slow_query | Source of truth mismatch found: report-database-service.ts:7 uses 'slow-query', everything else (schema, server.ts, report-service.ts, frontend) uses 'slow_query'. 3 files need changes + optional migration SQL. |
| RPT-04 | stat-card coverage in reports view | Confirmed satisfied: reports.ts imports stat-card.js, uses `<stat-card>` elements (lines 427-431), no ov-card references remain in reports.ts. |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| EJS template rendering | Backend | -- | Templates are server-side rendered, stored as files in apps/db-ops-api. Browser receives rendered HTML string as report.content |
| Report config CRUD | Backend | Frontend | Data persists in MySQL, served via Fastify API. Frontend provides management UI |
| Cron scheduling | Backend | -- | CronJob runs in the Node.js server process, same pattern as 10+ existing scheduled jobs |
| Report type name storage | Database | Backend, Frontend | Schema ENUM defines allowed values. TypeScript type and frontend labels must match |
| Report config UI | Frontend | -- | New card area in existing reports.ts view, follows existing LitElement pattern |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| ejs | 5.0.2 | Template engine for HTML report generation | Verified on npm. Simple API (renderFile), zero external dependencies, natural JS template syntax matches current inline template structure |
| cron | 4.4.0 | Scheduled job execution | Already installed and used by 10+ CronJobs in server.ts (topsql, rca, capacity, baseline, etc.). No change needed |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| mysql2 | 3.x | Database queries for report_configs CRUD | Already installed, used by all database services |
| Fastify | 4.x | HTTP routing for report configs API | Already installed, all API routes follow this pattern |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| ejs | Handlebars (hbs) | EJS is syntactically closer to the current inline template strings (`<%= expr %>` vs `{{ expr }}`). EJS also has simpler API for file-based rendering (`renderFile`). Both have similar performance. EJS chosen by user (D-04). |
| ejs | pug | Pug uses whitespace-significant syntax which would be a complete rewrite of the template structure. Not appropriate for this extraction task. |
| mysql2 raw | TypeORM / Knex | Project consistently uses raw mysql2 queries. No ORM abstraction would be consistent with existing patterns. |

**Installation:**
```bash
npm install ejs@^5.0.2
```

**Version verification:** ejs@5.0.2 confirmed via `npm view ejs version` (registry reports 5.0.2). No other new dependencies needed -- `cron@4.4.0` already in package.json.

## Package Legitimacy Audit

> slopcheck was not available at research time. All packages are tagged `[ASSUMED]` and the planner must gate each install behind a `checkpoint:human-verify` task.

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| ejs | npm | 15+ years | 30M+/week | github.com/mde/ejs | unavailable | [ASSUMED] -- planner: add checkpoint:human-verify before install |
| cron | npm | 12+ years | 10M+/week | github.com/kelektiv/node-cron | unavailable | Already in package.json |

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none
*slopcheck was unavailable -- all new packages tagged [ASSUMED]. Planner must gate ejs installation behind checkpoint:human-verify.*

## Architecture Patterns

### System Architecture Diagram

```
                 User (Browser)
                      |
                 reports.ts view
                (LitElement page)
                      |
        +-------------+-------------+
        |           |               |
   Generate Report  |         Configs UI
   (POST /api/      |         (CRUD /api/
    reports/        |          reports/configs)
    generate)       |               |
        |           |               |
        v           v               v
    report-service     +-> report-config-database-service
    (EJS renderFile)   |       (MySQL: report_configs)
        |              |
        v              v
    reports table   CronJob (60s scan)
    (MySQL)         WHERE enabled=1
                        |
                        v
                reportService.generateReport()
                        |
                        v
                reports table (insert result)
```

### Recommended Project Structure
```
apps/db-ops-api/
├── src/
│   ├── report-service.ts                 # Modified: use EJS instead of inline HTML
│   ├── report-database-service.ts        # Modified: fix ReportType to use 'slow_query'
│   ├── report-config-database-service.ts # NEW: report_configs CRUD
│   ├── templates/
│   │   └── reports/
│   │       ├── layout.ejs                # NEW: shared HTML shell
│   │       ├── health.ejs                # NEW: body content only
│   │       ├── performance.ejs           # NEW: body content only
│   │       ├── slow-query.ejs            # NEW: body content only
│   │       └── capacity.ejs              # NEW: body content only
├── sql/
│   └── migrations/
│       └── 006_add_report_configs.sql    # NEW: report_configs table
├── server.ts                             # Modified: add CRUD routes + CronJob
frontend/
└── src/
    └── openclaw/
        └── ui/
            └── views/
                └── reports.ts            # Modified: add configs CRUD UI
```

### Pattern 1: EJS Template Rendering

**What:** Use `ejs.renderFile()` in report-service.ts to render templates from file paths instead of generating HTML strings inline. Use a shared `layout.ejs` with `<%- body %>` injection point for per-type content.

**When to use:** All 4 generate*ReportHTML private methods in report-service.ts (lines 372-585).

**Shared layout.ejs structure:**
```ejs
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title><%= title %> - <%= instanceName %></title>
  <style>
    body { font-family: -apple-system, ...; padding: 20px; }
    h1 { color: #333; border-bottom: 2px solid <%= accentColor %>; ... }
    /* shared styles */
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 10px; border-bottom: 1px solid #ddd; }
    th { background: #f5f5f5; }
    /* type-specific styles injected via <style> in body block */
  </style>
</head>
<body>
  <h1><%= icon %> <%= title %></h1>
  <p><strong>实例:</strong> <%= instanceName %></p>
  <p><strong>生成时间:</strong> <%= generatedAt %></p>
  <%- body %>
</body>
</html>
```

**Per-type template example (health.ejs):**
```ejs
<%- include('layout', { ..., body: `
<div class="summary">
  <div class="card ${metrics.health_score >= 80 ? 'ok' : ...}">
    <div class="label">健康评分</div>
    <div class="metric">${metrics.health_score}</div>
  </div>
  ...
</div>
` }) %>
```

**Refactored call in report-service.ts:**
```typescript
// Source: ejs.co documentation [VERIFIED: npm registry]
import ejs from 'ejs';
import path from 'path';

const TEMPLATE_DIR = path.resolve(__dirname, '../templates/reports');

// Inside generateHealthReport:
const htmlContent = await ejs.renderFile(
  path.join(TEMPLATE_DIR, 'health.ejs'),
  {
    instanceName,
    metrics,
    generatedAt: new Date().toISOString(),
    title: '健康检查报告',
    accentColor: '#4CAF50',
    icon: '🏥',
  }
);
```

### Pattern 2: CRUD with CronJob Consumer (alert_rules Pattern)

**What:** Full CRUD API routes + database service + CronJob consumer, matching the existing alert_rules pattern (server.ts:1536-1627, alert-database-service.ts).

**When to use:** RPT-02 -- report_configs creation, reading, updating, deletion + scheduled consumption.

**Database service pattern:**
```typescript
// report-config-database-service.ts -- NEW
class ReportConfigDatabaseService {
  async getConfigs(): Promise<ReportConfig[]>
  async getConfigById(id: number): Promise<ReportConfig | null>
  async createConfig(data: CreateReportConfigData): Promise<ReportConfig>
  async updateConfig(id: number, data: UpdateReportConfigData): Promise<boolean>
  async deleteConfig(id: number): Promise<boolean>
  async getDueConfigs(): Promise<ReportConfig[]>  // WHERE enabled=1 AND cron matches
}
```

**API routes (server.ts at line 1410, adjacent to existing reports routes):**
```typescript
fastify.get('/api/reports/configs', { preHandler: [verifyToken, requirePermission('report:view')] }, ...)
fastify.post('/api/reports/configs', { preHandler: [verifyToken, requirePermission('report:create')] }, ...)
fastify.put('/api/reports/configs/:id', { preHandler: [verifyToken, requirePermission('report:create')] }, ...)
fastify.delete('/api/reports/configs/:id', { preHandler: [verifyToken, requirePermission('report:create')] }, ...)
```

**CronJob (server.ts near line 3461):**
```typescript
const reportScheduleJob = new CronJob('*/60 * * * * *', async () => {
  try {
    const configs = await reportConfigService.getDueConfigs();
    for (const config of configs) {
      await reportService.generateReport(config.type, config.instance_id, {
        format: config.format,
      });
    }
  } catch (error) {
    console.error('定时报表生成失败:', error);
  }
}, null, true, 'Asia/Shanghai');
```

### Anti-Patterns to Avoid
- **EJS caching with `cache: true`** without setting `filename`: EJS cache requires a `filename` option as the cache key. Since templates are small and called on-demand, caching is unnecessary and adds complexity. Do not enable cache.
- **Using `ejs.render()` instead of `ejs.renderFile()`**: `render()` compiles a string every call. `renderFile()` reads from disk and compiles. Both have similar perf for infrequent calls. Use `renderFile()` for clarity.
- **Inlining shared HTML in each template**: Each template should only define its content body. All shared HTML structure goes in `layout.ejs`. Review generated HTML to ensure no duplicated DOCTYPE/html/head/body tags.
- **Blocking CronJob execution**: The callback is async, but the CronJob library can queue next tick if one is still running. Use try/catch inside the loop to prevent one config failure from blocking others.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Cron expression parsing/next-time calculation | Custom cron matcher | `cron` package's `CronJob.nextDates()` or `node-cron/src/pattern` | cron@4.4.0 already installed. Use `new CronJob(cronExp).nextDates(1)` to compute next run time. Avoid parsing cron expressions manually. |
| HTML template engine | String interpolation or template literals | EJS (via `renderFile`) | Template literals inline in TypeScript cannot be syntax-highlighted, tested, or edited separately. EJS files can be edited by any HTML tool and support includes for layouts. |

**Key insight:** The four inline HTML templates in report-service.ts (lines 372-585) each contain ~70% identical boilerplate (DOCTYPE, html, head, styles, body wrapper, metadata display). Extracting to EJS with layout.ejs eliminates this duplication and makes template maintenance independent of the TypeScript service code.

## Don't Hand-Roll (RPT-02 specific)

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Cron scheduling from scratch | Custom setInterval-based polling | `cron` CronJob | Already used by 10+ jobs. Handles timezone, DST, and cron expression parsing. |
| Report config dedup per minute | Complex DB locking or distributed mutex | Simple in-memory Map<number, number> of configId -> lastTriggeredMinute | The CronJob runs every 60s in a single process. An in-memory Map resetting at minute boundary is sufficient. If the process restarts, the 60s window is negligible. |
| Permission system for new API routes | Custom role checking | Existing `preHandler: [verifyToken, requirePermission('report:view')]` | Already integrated with Fastify middleware chain. No new permission codes needed. |

## Common Pitfalls

### Pitfall 1: EJS `renderFile` throws on missing template
**What goes wrong:** Server crashes at startup if the EJS template directory path is wrong or a template file is missing.
**Why it happens:** `renderFile` is called at runtime, not startup. Missing templates fail at first report generation, not during server initialization.
**How to avoid:** Validate template directory at startup: `fs.existsSync(TEMPLATE_DIR)` and log a warning. Wrap `renderFile` calls in try/catch with fallback to the old inline HTML string (kept as a constant for emergency fallback).
**Warning signs:** Late failures during report generation that don't surface during server boot.

### Pitfall 2: CronJob dedup drift
**What goes wrong:** The 60-second scan runs at `:00` of each 60-second clock interval. A config scheduled for `0 * * * *` (every hour at minute 0) might trigger in two consecutive scans if the scan at `:00` takes >= 3 seconds to complete.
**Why it happens:** The CronJob fires at `0s`, `60s`, `120s` etc. If scan at second 0 starts at 12:00:00 and finishes at 12:00:03, the next scan at 12:01:00 is valid. But if processing takes >= 60s, the cron expression match window is still open.
**How to avoid:** Track `lastTriggeredMinute` per config in a Map. Before calling `generateReport`, check `currentMinute > lastTriggeredMinute.get(configId)`. Reset entries that are more than 5 minutes old.
**Warning signs:** Duplicate reports with identical type/instance_id/timestamps within same minute.

### Pitfall 3: ReportType type mismatch after migration
**What goes wrong:** After the migration changes `ReportType` from `'slow-query'` to `'slow_query'`, runtime code in report-exporter.ts or other consumers that uses `report.type` for display logic may still reference the old value.
**Why it happens:** The type is exported from report-database-service.ts but consumed by report-exporter.ts, server.ts (routes), and frontend reports.ts (label map). Not all consumers are obvious.
**How to avoid:** After changing ReportType in report-database-service.ts, run a full grep of all `slow-query` and `slow_query` patterns across the entire project. Check the compile step (tsc) for type errors before runtime testing.
**Warning signs:** Runtime branch comparison against string `'slow-query'` evaluates false for all stored data.

## Runtime State Inventory

> Phase 103 involves a data migration (RPT-03) as a minor component. Inventory items specific to renaming slow-query to slow_query.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `reports` table rows with `type = 'slow-query'` (if any exist) | Data migration: `UPDATE reports SET type = 'slow_query' WHERE type = 'slow-query'` |
| Live service config | None -- report_configs is being created fresh, has no old names | -- |
| OS-registered state | None verified -- no OS-level registrations reference report type names | -- |
| Secrets/env vars | None -- report types are not stored in environment variables | -- |
| Build artifacts | Potential stale compiled JS if report-database-service.ts compiled before migration | Re-run `npx tsc` or `tsx` after changing type definition |

**Nothing found in other categories:** No OS-registered state, live service configs, or secrets reference report type names.

## Code Examples

### EJS renderFile with layout (RPT-01)
```typescript
// Source: ejs.co documentation [VERIFIED: npm registry]
import ejs from 'ejs';
import path from 'path';

const TEMPLATE_DIR = path.resolve(__dirname, '../templates/reports');

// In report-service.ts, replace generateHealthReportHTML:
private async generateHealthReportHTML(
  instanceName: string,
  metrics: HealthMetrics,
  generatedAt: string
): Promise<string> {
  return ejs.renderFile(
    path.join(TEMPLATE_DIR, 'health.ejs'),
    {
      instanceName,
      metrics,
      generatedAt,
      title: '健康检查报告',
      accentColor: '#4CAF50',
      icon: '🏥',
      topN: options.topN || 20,
    }
  );
}
```

### CRUD Route Pattern (RPT-02)
```typescript
// Source: alert_rules CRUD pattern at server.ts:1536-1627 [VERIFIED: codebase]
// Add adjacent to existing reports routes at server.ts ~line 1410:

// GET all configs
fastify.get('/api/reports/configs', {
  preHandler: [verifyToken, requirePermission('report:view')],
  handler: async (request, reply) => {
    const configs = await reportConfigService.getConfigs();
    reply.send(configs);
  }
});

// POST create config
fastify.post('/api/reports/configs', {
  preHandler: [verifyToken, requirePermission('report:create')],
  handler: async (request, reply) => {
    const data = request.body as any;
    const config = await reportConfigService.createConfig({
      name: data.name,
      cron: data.cron,
      type: data.type,
      instance_id: Number(data.instance_id),
      format: data.format || 'html',
      enabled: data.enabled !== undefined ? data.enabled : true,
    });
    reply.send({ id: config.id, message: '创建成功' });
  }
});
```

### CronJob Pattern with Dedup (RPT-02)
```typescript
// Source: topsqlProcessedKeys dedup pattern at server.ts:3244-3255 [VERIFIED: codebase]
const lastRunMinute = new Map<number, number>();

const reportScheduleJob = new CronJob('*/60 * * * * *', async () => {
  try {
    const configs = await reportConfigService.getEnabledConfigs();
    const now = new Date();
    const currentMinute = Math.floor(now.getTime() / 60000);

    for (const config of configs) {
      // Skip if already triggered this minute
      const lastRun = lastRunMinute.get(config.id);
      if (lastRun === currentMinute) continue;

      // Check if the cron expression matches the current time
      const job = new CronJob(config.cron, () => {});
      if (job.nextDates(1).getTime() <= now.getTime()) {
        await reportService.generateReport(config.type, config.instance_id, {
          format: config.format,
        });
        lastRunMinute.set(config.id, currentMinute);
      }
    }

    // Cleanup stale entries (older than 10 minutes)
    for (const [id, minute] of lastRunMinute.entries()) {
      if (currentMinute - minute > 10) lastRunMinute.delete(id);
    }
  } catch (error) {
    console.error('定时报表生成失败:', error);
  }
}, null, true, 'Asia/Shanghai');
```

### Report Type Label Map Fix (RPT-03)
```typescript
// Source: reports.ts:528-536 [VERIFIED: codebase]
// Change from:
private _reportTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    health: "健康检查",
    performance: "性能分析",
    "slow-query": "慢查询",  // BUG: key uses hyphenated form
    capacity: "容量规划",
  };
  return labels[type] || type;
}

// Change to:
private _reportTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    health: "健康检查",
    performance: "性能分析",
    slow_query: "慢查询",    // FIXED: key uses underscore, matching canonical name
    capacity: "容量规划",
  };
  return labels[type] || type;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Inline HTML strings in report-service.ts (4 private methods, 220 lines) | EJS template files in dedicated directory | Phase 103 | Templates independently editable, syntax-highlighted, testable without running service |
| No scheduled report generation | report_configs CRUD + CronJob scanner | Phase 103 | Users can configure automatic periodic report generation |
| Report type `slow-query` in TypeScript type but `slow_query` in schema and code | `slow_query` everywhere | Phase 103 | Eliminates runtime branch mismatch when comparing `report.type === 'slow_query'` |

**Deprecated/outdated:**
- The 4 `generate*ReportHTML` private methods after extraction: can be replaced with a single `renderTemplate(templateName, context)` method. Keep the old HTML as inline constants in a comment for emergency fallback.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | ejs@5.0.2 API compatible with documented usage (renderFile, include) | Standard Stack | LOWER -- EJS has maintained backward compatibility for major versions. v5 changelog shows only minor breaking changes (removed legacy `compile` options). |
| A2 | `cron` package CronJob.nextDates() returns correct next execution | Code Examples | LOW -- widely used feature of a well-tested package. The dedup pattern using nextDates comparison is a common approach. |
| A3 | No existing DB rows with `type='slow-query'` (hyphen) exist | Runtime State Inventory | MEDIUM -- if production data exists with hyphenated type, the migration SQL must include the UPDATE statement. The research scanned schema and TS types but could not query live DB. |
| A4 | reports.ts has no remaining ov-card references | stat-card Coverage | LOW -- manual review of reports.ts confirmed `<stat-card>` usage and no `ov-card` strings. RPT-04 confirmed as satisfied. |

## Open Questions (RESOLVED)

1. **Does the reports table currently contain rows with type = 'slow-query' (hyphen)?**
   - What we know: The schema.sql ENUM uses 'slow_query'. The TypeScript type used 'slow-query' until now. Existing rows could have either value depending on what was stored at insert time (report-service.ts line 173 uses 'slow_query' for new reports).
   - What's unclear: Whether any existing DB rows have the hyphenated value from earlier inserts.
   - Recommendation: Include the UPDATE migration SQL as a precaution. It is idempotent (no-op if no matching rows).

2. **Should the EJS template files use `.ejs` extension or be treated as raw HTML with embedded JS?**
   - What we know: Standard EJS convention uses `.ejs` extension. The planner should specify this.
   - What's unclear: No ambiguity -- standard `.ejs` extension. This is the convention.

3. **What format should the report_configs `cron` column use for storage?**
   - What we know: Cron expressions are stored as VARCHAR and passed to the `cron` package. Standard 5-field cron (minute hour day-of-month month day-of-week).
   - What's unclear: Whether to support 6-field (with seconds). The existing CronJobs use 5-field or 6-field depending on need. The scheduler scans every 60 seconds, so 5-field (minute granularity) is appropriate for scheduled reports.
   - Recommendation: Store 5-field cron expressions (standard UNIX cron format). The scanner runs every 60 seconds and evaluates whether the current time matches.

## Environment Availability

> Step 2.6: SKIPPED (all dependencies are runtime Node.js packages managed via npm -- no external CLIs, services, or databases beyond what the project already requires)

## Validation Architecture

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| RPT-01 | Report HTML generated from EJS template produces valid HTML with correct data | unit | `npx vitest run apps/db-ops-api/tests/report-ejs.test.ts` | Needs creation |
| RPT-02 | report_configs CRUD creates, reads, updates, deletes configs | integration | `npx vitest run apps/db-ops-api/tests/report-config.test.ts` | Needs creation |
| RPT-02 | CronJob scanner identifies due configs | unit | `npx vitest run apps/db-ops-api/tests/report-scheduler.test.ts` | Needs creation |
| RPT-03 | ReportType type uses `slow_query` consistently | unit | `npx tsc --noEmit` (compile check) | Already exists (tsconfig.json) |

### Sampling Rate
- **Per task commit**: `npx tsc --noEmit` + `npx vitest run apps/db-ops-api/tests/report-ejs.test.ts -x`
- **Per wave merge**: Full report test suite
- **Phase gate**: Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `apps/db-ops-api/tests/report-ejs.test.ts` -- test that EJS renderFile with layout.ejs produces content containing expected fields
- [ ] `apps/db-ops-api/tests/report-config.test.ts` -- test CRUD operations on report_configs
- [ ] `apps/db-ops-api/tests/report-scheduler.test.ts` -- test cron expression evaluation against configs

## Sources

### Primary (HIGH confidence)
- [ejs.co documentation](https://ejs.co/) -- EJS API (render, renderFile, compile, options)
- npm registry (`npm view ejs version` = 5.0.2, `npm view cron version` = 4.4.0)
- Codebase: report-service.ts (638 lines, 4 inline HTML templates) -- full reading
- Codebase: report-database-service.ts (289 lines, ReportType type definition) -- full reading
- Codebase: server.ts reports routes (lines 1410-1534) -- full reading
- Codebase: server.ts CronJob instances (lines 3240-3503, 10+ examples) -- full reading
- Codebase: frontend reports.ts (622 lines, stat-card usage confirmed) -- full reading

### Secondary (MEDIUM confidence)
- alert_rules CRUD pattern at server.ts:1536-1627 -- verified as working pattern for report_configs
- Existing migrations (004, 005) -- verified migration file format and directory location

### Tertiary (LOW confidence)
- No LOW confidence claims in this research

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- ejs@5.0.2 verified on npm, cron@4.4.0 already installed
- Architecture: HIGH -- 4 template methods fully analyzed, CRUD pattern verified
- Pitfalls: HIGH -- all based on codebase-specific patterns (EJS path resolution, CronJob dedup, type mismatch)
- Assumptions: LOW -- all 4 assumptions are low-risk edge cases, documented for due diligence

**Research date:** 2026-05-21
**Valid until:** 2026-06-21 (30 days -- ejs@5.x is stable; none of the researched patterns change rapidly)
