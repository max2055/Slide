---
phase: 129-unified-observability
reviewed: 2026-07-08T20:00:00Z
depth: quick
files_reviewed: 13
files_reviewed_list:
  - apps/db-ops-api/server.ts
  - apps/db-ops-api/sql/migrations/022_unified_observability.sql
  - apps/db-ops-api/src/alert-rule-template-service.ts
  - apps/db-ops-api/src/metric-database-service.ts
  - apps/db-ops-api/src/metric-registry.ts
  - apps/db-ops-api/src/report-config-database-service.ts
  - apps/db-ops-api/src/report-database-service.ts
  - apps/db-ops-api/src/server-report-service.ts
  - frontend/src/app/ui/components/alert-list.ts
  - frontend/src/app/ui/components/alert-rule-editor.ts
  - frontend/src/app/ui/views/alerts.ts
  - frontend/src/app/ui/views/reports.ts
  - frontend/src/app/ui/views/server-detail.ts
findings:
  critical: 4
  warning: 3
  info: 1
  total: 8
status: issues_found
---

# Phase 129: Code Review Report — Unified Observability

**Reviewed:** 2026-07-08T20:00:00Z
**Depth:** quick
**Files Reviewed:** 13
**Status:** issues_found

## Summary

This phase unified the instance/server pipelines across metric definitions, alert rules/templates, reports, and frontend components. The implementation introduces `target_type` on metric definitions and `alert_rule_templates` table for server-scoped preset templates, plus report support for server-scoped data. Four critical issues were found: two blocking server_health report generation, one permission naming inconsistency that prevents template management, and dead code in the metric registry.

## Critical Issues

### CR-01: Server health report generation from Reports page always fails

**File:** `frontend/src/app/ui/views/reports.ts:684-702`
**File:** `apps/db-ops-api/server.ts:2549-2577`

**Issue:** The frontend `_generateReport()` function, when `type === 'server_health'`, sends a POST to `/api/reports/generate` with `{ type: 'server_health', server_id }`. However, the backend route at `POST /api/reports/generate` (server.ts line 2549) requires `instanceId` as a mandatory parameter and validates `type` against `['health', 'performance', 'slow_query', 'capacity']` — `server_health` is not in this list. The correct endpoint for server health reports is `POST /api/servers/reports/generate` (server.ts line 1559), which calls `serverReportService.generateAndPersist()`. The frontend always calls the wrong endpoint, so server health report generation is broken end-to-end.

**Fix:** In the frontend `_generateReport()` method, when `type === 'server_health'`, change the API path from `/api/reports/generate` to `/api/servers/reports/generate`. Additionally, the `/api/servers/reports/generate` route handler should accept and pass through `server_id` from the request body so reports can be generated for a single server:

```typescript
// server.ts line 1558-1570 — update to accept server_id
fastify.post('/api/servers/reports/generate', { preHandler: [verifyToken, requirePermission('servers:manage')] }, async (request, reply) => {
  try {
    const { server_id } = request.body as { server_id?: number };
    const result = await serverReportService.generateAndPersist(server_id ? [server_id] : undefined);
    // ...rest
```

### CR-02: Report config create/update routes do not pass `server_id`

**File:** `apps/db-ops-api/server.ts:2422-2457` (POST /api/reports/configs)
**File:** `apps/db-ops-api/server.ts:2461-2508` (PUT /api/reports/configs/:id)

**Issue:** The `POST /api/reports/configs` route handler (line 2427) destructures `{ name, cron, type, instance_id, format, enabled }` from the body but never extracts `server_id`. Similarly, the `PUT /api/reports/configs/:id` handler (line 2490-2497) only passes `instance_id` and never `server_id`. The service layer (`report-config-database-service.ts`) supports `server_id` in both `createConfig()` and `updateConfig()`, and the table column `server_id` was added by migration 022, but the route handler drops it. Users cannot create or update report configs scoped to servers through the API.

**Fix:** Add `server_id` extraction and passing in both route handlers:

```typescript
// Line 2427 — POST /api/reports/configs
const { name, cron, type, instance_id, server_id, format, enabled } = body;
// ...
const result = await reportConfigService.createConfig({
  name, cron, type,
  instance_id: Number(instance_id),
  server_id: server_id ? Number(server_id) : undefined,
  format: format || 'html',
  enabled: enabled !== undefined ? enabled : true,
});

// Line 2490-2497 — PUT /api/reports/configs/:id
const updated = await reportConfigService.updateConfig(Number(id), {
  name: body.name, cron: body.cron, type: body.type,
  instance_id: body.instance_id !== undefined ? Number(body.instance_id) : undefined,
  server_id: body.server_id !== undefined ? Number(body.server_id) : undefined,
  format: body.format, enabled: body.enabled !== undefined ? body.enabled : undefined,
});
```

### CR-03: `server_health` type excluded from validTypes in reports generate and config routes

**File:** `apps/db-ops-api/server.ts:2434` (POST /api/reports/configs)
**File:** `apps/db-ops-api/server.ts:2563-2565` (POST /api/reports/generate)
**File:** `apps/db-ops-api/sql/migrations/022_unified_observability.sql:144-146` (adds `server_health` to ENUM)

**Issue:** Migration 022 adds `'server_health'` to the `report_configs.type` ENUM, and the `ReportType` type in `report-database-service.ts` (line 7) includes `'server_health'`. However, the route-level validation in both `POST /api/reports/configs` and `POST /api/reports/generate` uses hardcoded validTypes arrays `['health', 'performance', 'slow_query', 'capacity']` that exclude `server_health`. The `POST /api/reports/configs` route cannot create configs with `type='server_health'`, and `POST /api/reports/generate` correctly rejects `server_health` since it should use the servers-specific route — but the config route should allow it since configs are persisted.

**Fix:** Add `'server_health'` to the validTypes array in `POST /api/reports/configs` (line 2434) so scheduled server health reports can be configured:

```typescript
// line 2434
const validTypes = ['health', 'performance', 'slow_query', 'capacity', 'server_health'];
```

The `POST /api/reports/generate` route should keep excluding `server_health` since that endpoint handles instance-based reports only, but add a clear error message directing users to `/api/servers/reports/generate` instead.

### CR-04: Dead code after return in MetricRegistry._getPredefinedMetrics()

**File:** `apps/db-ops-api/src/metric-registry.ts:590-594`

**Issue:** The `_getPredefinedMetrics()` method returns the metric definitions array at line 591 (the closing `];` of the array literal), but lines 592-594 contain a registration loop:

```typescript
    for (const metric of metrics) {
      this.definitions.set(metric.id, metric);
    }
  }
```

This loop is unreachable because it appears after the `return` statement. The `loadPredefinedMetrics()` method at line 597-602 correctly performs this registration, so the defect has no runtime impact — but the dead code indicates a copy-paste error. The same pattern is correctly implemented in `loadPredefinedMetrics()` and during `initialize()`.

**Fix:** Remove the dead code at lines 592-594:

```typescript
    ];
    // DELETE lines 592-594 (unreachable dead code)
  }
```

## Warnings

### WR-01: Permission key inconsistency: `alerts:manage` vs `alert:manage`

**File:** `apps/db-ops-api/server.ts:2797,2827,2858`
**File:** `apps/db-ops-api/server.ts:2641,2691,2743`

**Issue:** The alert **template** routes (`/api/alert-rule-templates`) use `requirePermission('alerts:manage')` (note the "s" — `alerts:manage`), while the alert **rule** routes (`/api/alert-rules`) use `requirePermission('alert:manage')` (without "s"). If the RBAC system treats these as distinct permissions, users with `alert:manage` permission cannot manage templates. If `alerts:manage` was a typo and the expected permission is `alert:manage`, the template routes will always return 403 for legitimate users.

**Fix:** Standardize on one permission key. Either use `alert:manage` consistently (matching the existing rule routes) or define `alerts:manage` as an alias. Audit which permission is assigned to roles and align accordingly:

```typescript
// Change lines 2797, 2827, 2858 from:
requirePermission('alerts:manage')
// to:
requirePermission('alert:manage')
```

### WR-02: Duplicate metric IDs overwrite instance metrics with server metrics

**File:** `apps/db-ops-api/src/metric-registry.ts:468-509`

**Issue:** Server-level predefined metrics use the same `id` values as instance-level metrics: `cpu_usage` (line 139 instance, line 469 server), `memory_usage` (line 151 instance, line 483 server), `disk_usage` (line 163 instance, line 497 server). The registry uses `Map<string, MetricDefinition>` keyed by `id`. Since server metrics are defined later in the `_getPredefinedMetrics()` array, `Map.set()` overwrites the instance version with the server version. Calling `metricRegistry.getById('cpu_usage')` returns the server metric definition even when querying for an instance context. Instance-level metric lookups will show `target_type: 'server'`, empty `db_types: []`, and server-oriented descriptions.

**Fix:** Use distinct IDs for server-level metrics (e.g., `server_cpu_usage`, `server_memory_usage`, `server_disk_usage`) to avoid collision, or filter by `target_type` in all lookups to ensure the correct variant is returned:

```typescript
// Option A: Unique IDs
{ id: 'server_cpu_usage', name: 'CPU 使用率(OS)', ... target_type: 'server' }

// Option B: Add getById that respects target_type context
getById(id: string, targetType?: string): MetricDefinition | null { ... }
```

### WR-03: Report config route requires `instance_id` but frontend may not send it for server type

**File:** `apps/db-ops-api/server.ts:2430`

**Issue:** The `POST /api/reports/configs` route validates `instance_id === undefined` as a required parameter. When creating a report config for server type, the frontend may not send `instance_id` (or may send `undefined`), causing false validation failures. The route should accept `instance_id` as optional when `type === 'server_health'` or when `server_id` is provided.

**Fix:** Make the instance_id validation conditional on target type:

```typescript
// line 2430
if (!name || !cron || !type) {
  return reply.code(400).send({ error: '缺少必要参数：name, cron, type' });
}
if (!server_id && instance_id === undefined) {
  return reply.code(400).send({ error: 'instance_id 或 server_id 必须提供其一' });
}
```

## Info

### IN-01: Duplicate server_name mapping block in alerts page

**File:** `frontend/src/app/ui/views/alerts.ts:745-759`

**Issue:** The identical block of code mapping `server_name` from the servers list appears twice consecutively (lines 745-751 and 752-759). Both blocks iterate `this.alerts` and set `server_name` from the server map. The second pass is a no-op since the first pass already populated the values. This is code duplication from a copy-paste.

**Fix:** Remove the duplicate block (lines 752-759):

```typescript
// Keep one copy of the mapping block (lines 745-751), delete the duplicate
this.alerts = this.alerts.map(a => ({
  ...a,
  server_name: a.server_name || (a.server_id ? serverMap.get(a.server_id) : undefined),
}));
```

---

_Reviewed: 2026-07-08T20:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: quick_
