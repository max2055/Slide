---
phase: 130-remove-metric-templates
reviewed: 2026-07-10T23:30:00Z
depth: standard
files_reviewed: 9
files_reviewed_list:
  - apps/db-ops-api/server.ts
  - apps/db-ops-api/sql/schema.sql
  - apps/db-ops-api/src/alert-database-service.ts
  - apps/db-ops-api/src/alert-evaluator.ts
  - frontend/src/app/i18n/locales/en.ts
  - frontend/src/app/i18n/locales/zh-CN.ts
  - frontend/src/app/ui/app-render.ts
  - frontend/src/app/ui/app.ts
  - frontend/src/app/ui/navigation.ts
findings:
  critical: 0
  warning: 3
  info: 1
  total: 4
status: issues_found
---

# Phase 130: Code Review Report — Remove Metric Templates

**Reviewed:** 2026-07-10T23:30:00Z
**Depth:** standard
**Files Reviewed:** 9 (excl. 2 deleted)
**Status:** issues_found

## Summary

Reviewed Phase 130's removal of the `metric_templates` system, including its backend service (`template-database-service.ts`), frontend view (`metric-templates.ts`), and all navigation/routing/i18n references. The deleted files are correctly absent and no source imports remain for them. Frontend navigation, routing, and i18n files are clean of metric-templates references. The schema.sql tables for `metric_templates` and `instance_templates` are properly documented as deprecated/retained-for-compat.

Three warnings were found: two pertain to unused function parameters left after the metric_templates lookup removal in `resolveMacrosForRule` and `loadMetricDefaultMacros`; one is a latent reliability concern where `require()` is used inside an ESM-declared module with a silent catch. One info-level issue flags missing body validation on the `POST /api/alert-rule-templates` route (pre-existing).

## Warnings

### WR-01: `resolveMacrosForRule` has unused `instanceId` parameter after metric_templates removal

**File:** `apps/db-ops-api/src/alert-evaluator.ts:416`
**Issue:** The `instanceId` parameter was previously used to query `instance_templates.macro_overrides` for instance-specific macro substitutions. After Phase 130 removed all metric_templates lookups, this parameter is no longer referenced in the function body. Both callers still pass it unnecessarily:
  - `alert-evaluator.ts:385` — `await resolveMacrosForRule(rule, instance.id)`
  - `alert-engine.ts:137` — `await resolveMacrosForRule(rule, alert.instance_id)`

Dead parameter creates confusion for future maintainers and wastes a CPU cycle (admittedly negligible) at each evaluation. More importantly, it signals that the callers believe they are doing something that is no longer happening — a maintenance hazard.

**Fix:** Remove the `instanceId` parameter and update both callers.

For `alert-evaluator.ts`:
```typescript
// line 416 — remove instanceId param
export async function resolveMacrosForRule(rule: AlertRule): Promise<Record<string, number>> {
```

For `alert-evaluator.ts:385`:
```typescript
const macroCtx = await resolveMacrosForRule(rule);
```

For `alert-engine.ts:137`:
```typescript
const macros = await resolveMacrosForRule(rule);
```

---

### WR-02: `loadMetricDefaultMacros` has unused `metricName` parameter

**File:** `apps/db-ops-api/src/alert-evaluator.ts:435`
**Issue:** The `metricName` parameter is declared but never used in the function body. This pre-dates Phase 130 but should be cleaned up while modifying the same file. The test file at `alert-evaluator.test.ts:84` also passes a first argument that is immediately discarded.

**Fix:** Remove the `metricName` parameter from the signature and the test calls.

```typescript
// line 435 — remove metricName param
export function loadMetricDefaultMacros(thresholdTemplate: { warning?: number; error?: number; critical?: number } | null): Record<string, number> {
```

---

### WR-03: `require()` call in ESM module with silent error catch

**File:** `apps/db-ops-api/src/alert-evaluator.ts:421`
**Issue:** The function `resolveMacrosForRule` uses a CommonJS `require()` call (`const { metricRegistry } = require('./metric-registry')`) inside a package declared as ESM (`"type": "module"`). While the project runs via `tsx` (which provides CJS interop in development), this pattern is fragile:
  - Any Node.js runtime change that tightens ESM strictness could break this silently — the error is swallowed by `catch { /* skip */ }`.
  - If `require` fails or `metricRegistry` throws, `resolveMacrosForRule` returns an empty macros object. This causes `${var}` placeholders in `rule.threshold_template` to resolve to `NaN`, which means that threshold level is never triggered, falling back to single-threshold evaluation. Alerts based on multi-level threshold templates could silently cease to fire.
  - The pattern is inconsistent with the top-of-file ESM imports used for the other dependencies (`alertDatabaseService`, `metricsDatabaseService`, `instanceDatabaseService`, `baselineCalculator`).

The `metricRegistry` should be imported via ESM at the top of the file (if no circular dependency exists) or via dynamic `import()` (if circular dependency is a concern). If the dynamic `require` was chosen deliberately to avoid a circular import cycle, that rationale should be documented.

**Fix:** Replace the `require()` with a top-level ESM import:

```typescript
// Add to top of file with other imports
import { metricRegistry } from './metric-registry';
```

Then replace lines 420-429 with:
```typescript
  try {
    const def = metricRegistry.getById(rule.metric_name);
    if (def?.threshold_template) {
      const tt = def.threshold_template;
      if (tt.warning != null) macros.warning = Number(tt.warning);
      if (tt.error != null) macros.error = Number(tt.error);
      if (tt.critical != null) macros.critical = Number(tt.critical);
    }
  } catch { /* skip */ }
```

If `metric-registry.ts` imports from `alert-evaluator.ts` (creating a cycle), use dynamic import instead:
```typescript
  try {
    const { metricRegistry } = await import('./metric-registry');
    // ... rest unchanged
  } catch { /* skip */ }
```

## Info

### IN-01: Missing `warnUnknown` / `strictBody` validation in `POST /api/alert-rule-templates`

**File:** `apps/db-ops-api/server.ts:2802-2829`
**Issue:** The route handler for creating alert rule templates accepts the raw request body as `request.body as any` and destructures fields without any validation. Unlike other POST routes in the same file (e.g., `POST /api/llm/configs` at line 646 which uses `warnUnknown`, or `POST /api/database/instances` at line 1168 which validates required fields), this route:
  - Does not use `strictBody` to ensure required fields are present
  - Does not use `warnUnknown` to detect extraneous/malicious fields
  - Required fields (`name`, `metric_name`, `operator`) are not checked before being passed to the service

This can be addressed by adding both `strictBody` and `warnUnknown` calls similar to other CRUD routes.

---

## Files Not Reviewed

The following two files were deleted as part of Phase 130 and excluded from review:
- `apps/db-ops-api/src/template-database-service.ts` (deleted)
- `frontend/src/app/ui/views/metric-templates.ts` (deleted)

Verification confirmed both files are absent and no source-level imports for them remain.

---

_Reviewed: 2026-07-10T23:30:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
