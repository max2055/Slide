# Infrastructure Operations Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade the default dashboard from a database-specific view into a permission-aware infrastructure operations overview for databases, servers, and network devices.

**Architecture:** Use the existing permission-filtered `/api/resources/overview` snapshot as the dashboard source of truth. Add a small backend metrics-summary endpoint that aggregates the latest observations already collected for each resource type. Refactor the Lit dashboard so global health, risk, and data freshness are first-class, while database capacity/type charts render only in the database scope. Each data source loads independently and can show partial failure without blanking the page.

**Tech Stack:** Lit 3 web component, TypeScript, Fastify, Vitest, existing `app-card`, `stat-card`, `app-badge`, and `app-data-table` components.

---

### Task 1: Lock the dashboard contracts with focused tests

**Files:**
- Modify: `frontend/src/app/ui/views/dashboard.test.ts`
- Modify: `frontend/src/app/ui/views/dashboard.ts`
- Modify: `frontend/src/app/ui/navigation.ts`
- Modify: `frontend/src/app/ui/views/__tests__/navigation-cleanup.test.ts`
- Create: `apps/db-ops-api/src/resources/resource-metrics-summary.test.ts`

- [ ] **Step 1: Add failing frontend behavior tests**

  Add tests for the dashboard's resource-scope helper and summary classification:

  ```ts
  it('filters the unified resource snapshot by the selected scope', () => {
    const dashboard = document.createElement('dashboard-page') as any;
    dashboard.resourceOverview = {
      items: [
        { resource: { type: 'instance', id: 1 }, label: 'mysql', status: 'active', quality: 'good', freshness: 'fresh', observedAt: null, unresolvedAlerts: 0, relationCount: 0, impactScope: [], gaps: [] },
        { resource: { type: 'server', id: 2 }, label: 'app-01', status: 'online', quality: 'good', freshness: 'fresh', observedAt: null, unresolvedAlerts: 1, relationCount: 1, impactScope: [], gaps: [] },
      ],
    };
    dashboard.resourceScope = 'server';
    expect(dashboard._visibleResourceItems()).toHaveLength(1);
    expect(dashboard._visibleResourceItems()[0].label).toBe('app-01');
  });

  it('uses view_dashboard instead of database permission for the dashboard tab', async () => {
    expect(TAB_REQUIRED_PERMISSIONS.dashboard).toBe('view_dashboard');
  });
  ```

- [ ] **Step 2: Run the focused frontend tests and verify they fail**

  Run: `cd frontend && npm test -- --run src/app/ui/views/dashboard.test.ts src/app/ui/views/__tests__/navigation-cleanup.test.ts`

  Expected: FAIL because the scope helper and permission contract do not exist yet.

- [ ] **Step 3: Add the backend aggregation contract test**

  Test a `ResourceDiagnosticService.metricsSummary()` dependency with instance, server, and network-device observations. Assert that database `qps`/`connections` are summed, utilization metrics are averaged, and unknown/null values are excluded from the aggregate while preserving `dataQuality: 'partial'`.

- [ ] **Step 4: Run the backend contract test and verify it fails**

  Run: `cd apps/db-ops-api && npm test -- --run src/resources/resource-metrics-summary.test.ts`

  Expected: FAIL because `metricsSummary()` is not implemented.

### Task 2: Add permission-aware latest-metrics aggregation

**Files:**
- Modify: `apps/db-ops-api/src/resources/resource-diagnostic-service.ts`
- Modify: `apps/db-ops-api/src/resources/resource-routes.ts`
- Modify: `apps/db-ops-api/src/contracts/public-api.ts`
- Modify: `apps/db-ops-api/src/contracts/generate-public-api.ts`
- Modify: `apps/db-ops-api/src/contracts/public-api.test.ts`
- Test: `apps/db-ops-api/src/resources/resource-metrics-summary.test.ts`

- [ ] **Step 1: Define the response shape**

  Add `ResourceMetricsSummaryResponse` with `schemaVersion`, `collectedAt`, `dataQuality`, and one `scopes` entry per visible resource type. Each scope returns metric aggregates with `value`, `resourceCount`, and `observedAt`.

- [ ] **Step 2: Implement `metricsSummary(actor)`**

  Reuse `dependencies.list()` and `dependencies.observations()` so resource permissions remain enforced. Use the canonical metric groups `cpu_usage`, `memory_usage`, `disk_usage`, `connections`, `qps`, `load_1min`, and `device_reachability`. Sum count/rate metrics, average percentage/load metrics, and mark the response partial when observations are unavailable or missing.

- [ ] **Step 3: Expose `GET /api/resources/metrics/summary`**

  Register the route beside `/api/resources/overview`, return a bounded response, and map service errors to the existing resource route error handling.

- [ ] **Step 4: Update the public API contract and tests**

  Add the route and schema to the contract generator and assert the generated contract includes the new path.

- [ ] **Step 5: Run backend focused tests**

  Run: `cd apps/db-ops-api && npm test -- --run src/resources/resource-metrics-summary.test.ts src/contracts/public-api.test.ts`

  Expected: PASS.

### Task 3: Refactor the Lit dashboard around unified operations state

**Files:**
- Modify: `frontend/src/app/ui/views/dashboard.ts`
- Modify: `frontend/src/app/i18n/locales/zh-CN.ts`
- Modify: `frontend/src/app/i18n/locales/en.ts`
- Test: `frontend/src/app/ui/views/dashboard.test.ts`

- [ ] **Step 1: Add dashboard state and helpers**

  Add `resourceScope: 'all' | 'instance' | 'server' | 'network_device'`, `metricsSummary`, independent loading/error state, `_visibleResourceItems()`, `_visibleResourceSummary()`, and `_resourceMetricRows()`. Keep the existing capacity trend state only for the `instance` scope.

- [ ] **Step 2: Replace coupled loading with independent requests**

  Fetch `/api/resources/overview`, `/api/resources/metrics/summary`, and `/api/alerts` independently with `Promise.allSettled`. The dashboard must render the available modules when database, capacity, AI, or alert data is unavailable. Preserve the current focused capacity reload behavior for database scope.

- [ ] **Step 3: Reorder the first viewport**

  Render a scope segmented control and refresh/data-quality line first, followed by six general KPI cards: total resources, healthy/online, degraded, critical/offline, active incidents, and stale/missing data. Make the cards derive from the filtered resource snapshot.

- [ ] **Step 4: Make risk and collection quality primary panels**

  Promote the unresolved resource/alert list above charts. Include resource type, label, status, freshness, alert count, and impact count. Add a collection-quality panel using `fresh`, `stale`, `missing`, and `dataQuality`.

- [ ] **Step 5: Add unified metric snapshot panel**

  Render the new aggregate metrics for the selected scope with units and resource counts. Use the existing database type and capacity charts only when the selected scope is `all` or `instance`; label them explicitly as database-specific.

- [ ] **Step 6: Add i18n labels and remove database-first copy**

  Add Chinese and English labels for scope names, general KPI labels, freshness states, collection quality, risk queue, and metric panel. Keep sentence-case labels and existing design tokens/components.

- [ ] **Step 7: Run focused frontend tests**

  Run: `cd frontend && npm test -- --run src/app/ui/views/dashboard.test.ts src/app/ui/views/__tests__/navigation-cleanup.test.ts`

  Expected: PASS.

### Task 4: Validate integration and visual behavior

**Files:**
- Modify: `frontend/e2e/smoke.spec.ts` only if selectors need stable dashboard assertions
- Modify: `frontend/e2e/interaction.spec.ts` only if the existing dashboard selectors need updated expectations

- [ ] **Step 1: Run type checks and builds**

  Run: `cd apps/db-ops-api && npm run typecheck`

  Run: `cd frontend && npm run typecheck && npm run build`

  Expected: all commands exit 0.

- [ ] **Step 2: Run dashboard and resource regression tests**

  Run: `cd apps/db-ops-api && npm test -- --run tests/dashboard.test.ts src/resources/resource-diagnostic-service.test.ts src/resources/resource-metrics-summary.test.ts src/contracts/public-api.test.ts`

  Run: `cd frontend && npm test -- --run src/app/ui/views/dashboard.test.ts src/app/ui/views/__tests__/navigation-cleanup.test.ts`

  Expected: all selected tests pass.

- [ ] **Step 3: Run the frontend smoke path**

  Run: `cd frontend && npm run smoke -- e2e/smoke.spec.ts --grep dashboard`

  Expected: the dashboard route renders without a blank/error page and existing navigation remains functional.

- [ ] **Step 4: Review the diff against the acceptance contract**

  Confirm that no unrelated user changes were modified, no database-only KPI appears in the general KPI row, server-only and network-only permissions can see the dashboard, and partial API failures leave usable modules visible.

- [ ] **Step 5: Record verification evidence and finish**

  Run `git diff --check` and report the exact test/build results. Do not claim completion if any required command fails.
