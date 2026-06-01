# Pitfalls Research

**Domain:** Database Ops Platform — Alert System, Auth & Permissions, Reports, Data Quality, UI Unification
**Researched:** 2026-05-20
**Confidence:** HIGH

## Critical Pitfalls

### Pitfall 1: GET /api/alerts Route Missing Auth Middleware

**What goes wrong:**
The `/api/alerts` route at server.ts line 532 has NO `verifyToken` or `requirePermission` middleware. Any unauthenticated request can list all alerts, including instance names, metric values, threshold values, and severity levels. This exposes operational data about all database instances.

```
// server.ts line 532 — NO auth middleware
fastify.get('/api/alerts', async (request, reply) => { ... });
```

Compare with `/api/alert-rules` at line 1452 which correctly has `preHandler: [verifyToken, requirePermission('alert:view')]`.

**Why it happens:**
Alert routes were added incrementally. The alert-rule routes (1452+) were added later and correctly include auth. But `GET /api/alerts` (532) and `GET /api/metrics/:instanceId` (567) were among the earliest routes and were never retrofitted. The "it works" testing pattern — developers test the route from the same browser they're logged into — hides this gap because they are already authenticated.

**How to avoid:**
- Add `preHandler: [verifyToken, requirePermission('alert:view')]` to `GET /api/alerts`
- Similarly audit `GET /api/metrics/:instanceId`, `GET /api/chat/history`, and `GET /api/database/instances` — these also lack auth middleware
- Run a route audit script: `grep "fastify\.\(get\|post\|put\|delete\)" server.ts | grep -v "preHandler"` to find all unprotected routes
- Before marking any alert-related phase complete, verify ALL alert routes have auth

**Warning signs:**
- Any `GET /api/alerts` call from an incognito window returns data without a login prompt
- grep shows `fastify.get('/api/alerts'` with no `preHandler` in the same line or next 3 lines

**Phase to address:**
Phase: Alert System — this must be fixed BEFORE any alert UI work, because the UI will naturally authenticate and not catch this gap.

---

### Pitfall 2: monitor-collector.ts `checkAlerts()` Duplicates alert-engine Logic

**What goes wrong:**
`monitor-collector.ts` has its own `checkAlerts()` method (line 311) that reads alert rules and creates alert records independently. The `alert-engine.ts` does the same job via `evaluateAndCreateAlerts()`. When both run — the collector runs via setInterval every ~10 seconds, the engine runs via cron every 60 seconds — duplicate alerts are created for the same metric breaches. Worse, they use different status checks: the collector checks for existing "open" status alerts, while the engine checks a `silence_periods` table. The two systems disagree on deduplication.

```
// monitor-collector.ts checkAlerts() — checks existing.open
const existing = await alertDatabaseService.getAlerts({
  instance_id: instanceId, metric_name: rule.metric_name,
  status: 'open', limit: 1,
});
if (existing.length === 0) { createAlert(...) }

// alert-engine.ts createAlertFromRule() — checks silence_periods
const isSilenced = await alertSilenceService.isSilenced(instanceId, rule.metric_name);
```

**Why it happens:**
The monitor-collector was written first as a simple inline alert checker. Later, the alert-engine was added as a more sophisticated system with dynamic thresholds, maintenance windows, and proper silence management. But the old inline checker was never removed, so both paths coexist creating alerts for the same metrics.

**How to avoid:**
- Remove the `checkAlerts()` method from `monitor-collector.ts` entirely — it is dead code now that alert-engine exists
- The monitor-collector should ONLY collect metrics, never create alerts. That is the alert-engine's job
- If the collector needs to trigger immediate evaluation (vs waiting for cron), make it call `alertEngine.triggerEvaluation()` instead

**Warning signs:**
- Same instance+metric generates two alert records within 60 seconds of each other
- One alert has `source: 'monitor-collector'` (from collector), the other has `source: 'alert-engine'` (from engine)

**Phase to address:**
Phase: Alert System — Remove `checkAlerts()` from monitor-collector.ts as a first task. This prevents a class of bug that is extremely hard to detect later.

---

### Pitfall 3: Threshold Type Mismatch — Interface vs Database

**What goes wrong:**
The `AlertRule` interface in `alert-database-service.ts` (line 31-45) does NOT define a `threshold_type` column, but `alert-evaluator.ts` checks `rule.threshold_type === 'dynamic'` at line 126. The frontend alerts.ts interface (line 33-34) defines `threshold_type: 'static' | 'dynamic'` and `dynamic_config?: any`. This means:

1. The DB table has no `threshold_type` column defined in the backend interface
2. The evaluator silently treats null/undefined threshold_type as static (falls back, no error)
3. Changing a rule to 'dynamic' via the frontend sends `threshold_type: 'dynamic'` but the backend's `updateAlertRule()` doesn't save it
4. Dynamic thresholds are effectively broken — they work only if the baseline exists, but users can never configure a rule as "dynamic" through the UI

**Why it happens:**
The dynamic threshold feature was added incrementally: first the baseline calculator, then the evaluator, then the frontend UI. The DB schema migration and backend AlertRule interface were never updated to include `threshold_type`. This is a classic "half-integrated feature" — each piece works in isolation, but the full path is broken.

**How to avoid:**
- Add `threshold_type` to the `AlertRule` interface in `alert-database-service.ts`
- Add `threshold_type` and `dynamic_config` columns to the DB migration
- Update `updateAlertRule()` to persist both fields
- Write an integration test: create a rule with `threshold_type: 'dynamic'`, read it back, verify it's still dynamic
- Same issue exists for `silence_minutes` — present in frontend interface and alert-engine.ts (line 196) but not in backend AlertRule interface or updateAlertRule()

**Warning signs:**
- Frontend shows "Dynamic threshold" toggle but after save, reload shows "Static"
- A rule that should use dynamic thresholds never triggers (always falls back to static threshold_template)

**Phase to address:**
Phase: Alert System — Fix threshold_type AND silence_minutes persistence in the same pass. These are the same class of bug.

---

### Pitfall 4: JWT Token Refresh Lost — Mid-Session Logout

**What goes wrong:**
JWT tokens are stored in `localStorage` (checked at `event-management.ts` line 8: `localStorage.getItem("token")`) but there is no visible refresh mechanism. When the JWT expires (typically 1-24 hours depending on config), all API calls start returning 401. The user is silently logged out — the UI doesn't handle 401 responses by redirecting to login; it shows "permission denied" errors or blank data.

**Why it happens:**
The auth system was designed with short sessions in mind. Token expiry handling (intercept 401, redirect to login, try refresh token) is a standard pattern that was deferred. The result is that a user actively working (generating a report, reviewing alerts) may hit an expiry mid-operation with no recovery path.

**How to avoid:**
- Implement a Fastify preHandler that checks token expiry and returns a structured 401 response
- On the frontend, wrap all `fetch()` calls in an interceptor that catches 401, clears localStorage, and redirects to login
- OR: Implement refresh tokens — `/api/auth/refresh` endpoint issues new access token using a stored refresh token
- OR (simplest): Set JWT expiry to a very long duration (24h) and only require re-login on browser close (sessionStorage vs localStorage)

**Warning signs:**
- Intermittent "permission denied" errors that go away after page refresh
- "401" responses in browser DevTools network tab during active sessions

**Phase to address:**
Phase: Auth & Permissions — Token refresh or 401 intercept is a prerequisite for any feature that involves long user sessions (report generation, alert management, dashboard monitoring).

---

### Pitfall 5: ov-card Removal Blast Radius — 5+ Views with Duplicate CSS

**What goes wrong:**
The `ov-card` pattern is used across 5+ frontend views with near-identical inline CSS duplicated in each:
- `dashboard.ts` — 6 ov-cards, ~30 lines of CSS
- `alerts.ts` — 4 ov-cards, ~50 lines of CSS
- `reports.ts` — 4 ov-cards, ~50 lines of CSS
- `schema-management.ts` — 4 ov-cards, ~40 lines of CSS
- `instances-db.ts` — 4 ov-cards, ~50 lines of CSS
- `overview-cards.ts` — shared component but with different styling

Removing `ov-card` requires touching 6 files, each with slightly different CSS variants (`.ok`, `.warn`, `.danger`, `.red`, `.orange`, `.blue`). Any replacement shared component must handle ALL color variants and the stagger animation pattern.

**Why it happens:**
`ov-card` started as a dashboard-only pattern (dashboard.ts), then was copy-pasted to other views. Each copy added minor variants (`.red`, `.orange`, `.blue` color classes). By the time it was used in 5 views, converting to a shared component became a coordination problem — "which version of ov-card is canonical?"

**How to avoid:**
- Before removing ov-card, create a shared `<stat-card>` Lit component that supports ALL existing variants:
  ```typescript
  <stat-card label="Total Alerts" value="${stats.total}" variant="default"
             hint="All alerts" color="ok|warn|danger|red|orange|blue">
  ```
- Replace ov-card in all 6 views in a SINGLE commit (partial replacement leaves inconsistent UI)
- Remove the old CSS from each view's `static styles` after replacement
- Test each view's stat card section visually — stagger animations, colors, hover states

**Warning signs:**
- After refactoring, one view shows stat cards in the old style while others show the new style
- Removing ov-card CSS from one view "accidentally" removes it from another (if CSS leaks through shared shadow DOM — unlikely with Lit but possible with global styles)

**Phase to address:**
Phase: UI Unification — This is the core work item. Do NOT remove ov-card piecemeal across multiple phases; do it all at once.

---

### Pitfall 6: Report Type Inconsistency — 'slow-query' vs 'slow_query' vs 'slow_query'

**What goes wrong:**
The report system has THREE different naming conventions for the same report type:

1. Backend `ReportType` type: `'health' | 'performance' | 'slow-query' | 'capacity'` (report-database-service.ts line 7)
2. Backend route handler valid types: `['health', 'performance', 'slow_query', 'capacity']` (server.ts line 1391)
3. Frontend `Report` interface: `report_type?: string` (reports.ts line 8) — not even typed

Route `/api/reports/generate` checks against `slow_query` (with underscore) but the `reportDatabaseService.createReport()` accepts the DB-enforced `ReportType` which expects `slow-query` (with hyphen). The mismatch causes report generation to succeed (the route check passes both), but filtering or displaying by type will miss records because the stored value depends on which code path created the report.

**Why it happens:**
`slow-query` was the original type name (hyphenated for consistency with URL conventions). At some point, a route was added that validates against `slow_query` (underscore, matching variable naming conventions). Nobody noticed the mismatch because both paths write to the same `reports.type` column, just with different values, leading to inconsistent data.

**How to avoid:**
- Choose ONE convention and stick to it: `slow_query` (SQL-style, consistent with other enum values) or `slow-query` (URL-style)
- Update both `ReportType` and the route validator to use the SAME string
- Write a data migration script to normalize existing rows: `UPDATE reports SET type = 'slow_query' WHERE type = 'slow-query'`
- Add a DB constraint or application-level validation that rejects unknown types
- Type the frontend `Report` interface properly: `type: 'health' | 'performance' | 'slow_query' | 'capacity'`

**Warning signs:**
- Filtering reports by type shows incomplete results
- `SELECT DISTINCT type FROM reports` shows both `slow_query` and `slow-query`

**Phase to address:**
Phase: Reports Refactoring — Fix the type constant first, before any report UI refactoring. Data migration and type unification are prerequisites for the rest.

---

### Pitfall 7: health_score Hardcoded to 100 — All Instances Appear Perfect

**What goes wrong:**
In `report-service.ts` line 322-323:
```typescript
health_score: 100, // TODO: 实现健康评分逻辑
health_status: 'healthy', // TODO: 实现健康状态判断
```

The health score and status are hardcoded. Every health report says the instance is perfectly healthy (score 100). Users who trust this report will miss actual issues. The dashboard also uses this hardcoded score for its "Health Score" stat card.

Additionally, the `instanceDatabaseService.updateHealthStatus()` in `monitor-collector.ts` (line 283) sets the actual health score based on databaseService.checkHealth(), so there IS a real health score — but report-service.ts bypasses it.

**Why it happens:**
The report generation was built before the health check system was complete. The TODO was never resolved because "it works" (reports generate, they just always say healthy). This is a classic "shipped with TODOs" problem — once the feature ships, there's no user pressure to fix it because users don't know there's missing logic.

**How to avoid:**
- Replace the hardcoded values with actual metrics data:
  ```typescript
  health_score: this.calculateHealthScore(metrics),
  health_status: this.determineHealthStatus(metrics.health_score),
  ```
- `calculateHealthScore()` should consider: CPU (0-100, weight 25%), memory (0-100, weight 25%), disk (0-100, weight 25%), connections saturation (0-100, weight 15%), slow query rate (0-100, weight 10%)
- OR: Use the existing `databaseService.checkHealth()` result which already has a computed score

**Warning signs:**
- All health reports show "100" for health score
- A report for a known-dead instance still says "Healthy"

**Phase to address:**
Phase: Data Quality — This is the minimum deliverable for "instance score algorithm." The algorithm doesn't need to be perfect in v1.3, but it MUST NOT be hardcoded.

---

### Pitfall 8: Alert-Event Aggregation Window Collision

**What goes wrong:**
The event aggregator uses a hardcoded 5-minute aggregation window (`FLOOR(UNIX_TIMESTAMP(created_at) / 300) * 300 AS time_bucket`) in `event-aggregator.ts` line 39. Alerts created just outside the 5-minute boundary (e.g., at 00:04:59 and 00:05:01) fall into different buckets and are never aggregated together, even though they represent the same incident.

Worse: the aggregation runs on every alert-engine tick (every 60 seconds), querying alerts from the last 10 minutes. A batch of alerts created at T+0, T+1min, T+2min will be partially aggregated at T+5min (alerts from T+0..T+5 only), and the remaining alerts at T+6min..T+10min will form a separate event. One real incident becomes two events.

**Why it happens:**
The 5-minute window is a reasonable default (to avoid excessive aggregation), but hardcoding it without overlap handling means boundary cases split events. The real fix is either: (a) use a sliding window that checks for ANY gap > 5 minutes, not fixed buckets, or (b) at minimum, check continuity across bucket boundaries.

**How to avoid:**
- Replace the fixed time-bucket approach with a gap-based aggregation: group alerts where the time between consecutive alerts < threshold (e.g., 5 minutes)
- Or: Add a post-aggregation merge step that checks if new events overlap with existing ones within a configurable grace period

**Warning signs:**
- Two related events for the same instance+metric created within 6-10 minutes of each other
- Manual inspection shows the alerts should be one incident

**Phase to address:**
Phase: Alert System — Refine the aggregation algorithm. The fix is small but has high impact on alert quality.

---

### Pitfall 9: Two Icon Files with Overlapping But Different Sets

**What goes wrong:**
There are two icon files in the frontend:
1. `frontend/src/styles/icons.ts` — 470 lines, ~50 icons
2. `frontend/src/openclaw/ui/icons.ts` — 515 lines, ~50+ icons (including `icons.shield`)

These files have overlapping icons (both define `database`, `settings`, `bell`, `file-text`, `triangle-alert`, etc.) but with different SVG paths and different names. The `styles/icons.ts` uses names like `'layout-grid'`, `'heart-pulse'`, `'triangle-alert'` (kebab-case string keys), while `openclaw/ui/icons.ts` uses names like `messageSquare`, `fileText`, `trendingUp` (camelCase object property names).

Views import from different locations inconsistently. Adding new icons to one file doesn't make them available to views that import from the other. Any UI unification effort needs to decide which is canonical.

**Why it happens:**
The two files come from different development periods. `styles/icons.ts` is from the earlier OpenClaw-based UI layer. Later, `openclaw/ui/icons.ts` was created as part of the Slide-specific UI rewrite. Both are still actively imported because not all views were migrated to the new icons.

**How to avoid:**
- Designate ONE canonical icon file (recommended: `openclaw/ui/icons.ts` since it has more icons and is the Slide-specific one)
- Consolidate all icons into the canonical file, ensuring no icon is lost
- Update all imports across the entire frontend to use the canonical file
- Remove the deprecated file
- Add a lint rule: `no-restricted-imports` with pattern `*/styles/icons`

**Warning signs:**
- `grep -r "styles/icons" frontend/src --include="*.ts"` returns results
- An icon works in one view but renders as empty/blank in another

**Phase to address:**
Phase: UI Unification — This must be done BEFORE adding new icons for the alert/report features, otherwise new icons will be added to the wrong file.

---

### Pitfall 10: Alert Metric Type Map is Hardcoded — New Metrics Don't Map

**What goes wrong:**
In `alert-engine.ts` lines 154-163:
```typescript
const typeMap: Record<string, 'performance' | 'availability' | 'security' | 'capacity'> = {
  cpu_usage: 'performance',
  memory_usage: 'performance',
  disk_usage: 'capacity',
  connections: 'performance',
  qps: 'performance',
  tps: 'performance',
  health_score: 'availability',
  slow_queries: 'performance',
};
```

When a new metric is added to `metric-registry.ts` (e.g., `replication_lag_seconds`), the typeMap doesn't include it. The fallback `rule.metric_name` || 'performance' silently assigns 'performance' to every unknown metric. A replication lag alert labeled as 'performance' type is misleading.

**Why it happens:**
The typeMap is a lookup table that should be derived from the metric definition, not hardcoded. Since there's no dynamic mapping from `metric-registry.ts` categories to alert types, every new metric needs a manual update to the typeMap — and nobody remembers.

**How to avoid:**
- Add a `category` field to `MetricDefinition` in `metric-registry.ts`: `category: 'performance' | 'availability' | 'security' | 'capacity'`
- Replace hardcoded typeMap with `metricRegistry.getById(rule.metric_name)?.category || 'performance'`
- Remove the typeMap entirely — it becomes a derived property

**Warning signs:**
- New metrics always show as "performance" type in alerts regardless of what they measure

**Phase to address:**
Phase: Alert System — Add category to MetricDefinition and use it in alert creation. This is a small change that prevents a recurring bug.

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Inline alert check in monitor-collector.ts | Quick alert creation without building engine | Duplicate alerts, two code paths to maintain, inconsistent dedup | NEVER — remove immediately |
| Hardcoded health_score=100 in report-service.ts | Ship report feature faster | All health reports lie to users; data quality feature lacks baseline | NEVER — fix before v1.3 ships |
| Missing threshold_type in DB schema | Ship dynamic threshold UI quickly | Dynamic thresholds can never be saved; feature is broken | NEVER — fix persistence |
| Two icon files | Incremental migration without breaking existing views | Confusion about where to add new icons; inconsistent rendering | Only during active migration; collapse to one file in v1.3 |
| ov-card duplicate CSS across 5+ views | Quick stat card in each view | 200+ lines of identical CSS; any design change requires 5 edits | Only until shared component exists — create in v1.3 |
| Report type 'slow-query' vs 'slow_query' | Both values seemed reasonable | DB has inconsistent data; filtering breaks | Only if data migration script is queued to run |
| JWT stored in localStorage with no refresh | Simple auth implementation | Token expiry = silent logout; no recovery path | For short sessions only (<1h); unacceptable for long-running features like reports |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| metric-registry.ts -> alert-engine.ts typeMap | Hardcode metric-to-alert-type mapping in a lookup table | Derive alert type from MetricDefinition.category field |
| alert-engine.ts -> silence_periods table | Create silence without checking if existing silence is shorter | UPSERT silence with MAX(duration) or skip if existing silence is longer |
| monitor-collector.ts -> alert creation | Create alerts directly in the collector | Remove inline checkAlerts(); delegate to alert-engine |
| report-service.ts -> health score | Hardcode health_score to 100 with a TODO | Use databaseService.checkHealth() which already computes real scores |
| alert-routes [missing auth] | Add new alert route without preHandler | ALWAYS start with the preHandler template when adding any route |
| frontend icon import | Add new icon to whichever file you "find first" | Check which icon file the view already imports from; use the same |
| reports type filter | Validate report type in route handler with hardcoded array | Use a shared constant exported from report-database-service.ts |
| alerts frontend -> backend interface | Match AlertRule interface independently in frontend and backend | Export AlertRule type from backend and regenerate frontend types from it |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| PDF generation blocks event loop | Report download takes 5+ seconds; all other API requests hang | Use `setImmediate()` or worker pool for PDF generation | Single concurrent PDF with 50+ pages |
| alert-engine evaluateAllRules() N+1 queries | Each rule evaluation queries metrics_history, per instance per rule | Cache recent metrics; batch evaluation by instance | 50+ instances with 20+ rules each = 1000+ metric queries per tick |
| monitor-collector tick with 50+ instances | Each tick queries all instances and all metrics synchronously | Use Promise.allSettled() for concurrent instance collection | 50+ instances |
| Event aggregation GROUP_CONCAT overflow | Event creation fails silently with MySQL truncation warning | Set `group_concat_max_len=10000` in MySQL session | 500+ alerts per aggregation window |
| Frontend alert list with 10k+ rows | Table render causes long frame times | Server-side pagination (already done in getAlerts with limit/offset) | Already mitigated — verify frontend respects pagination |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| GET /api/alerts has no auth | Anyone can list all alert data including instance names and metric values | Add `preHandler: [verifyToken, requirePermission('alert:view')]` |
| GET /api/metrics/:instanceId has no auth | Anyone can read metrics for any instance | Add `preHandler: [verifyToken, requirePermission('instance:view'), requireInstanceAccess()]` |
| GET /api/database/instances has no auth | Anyone can list all database instances with host/port info | Add `preHandler: [verifyToken, requirePermission('instance:view')]` |
| GET /api/chat/history has no auth | Anyone can read chat history which may contain SQL queries and results | Add `preHandler: [verifyToken]` (requires auth but minimal permission) |
| JWT in localStorage without refresh | XSS vulnerability; no recovery on expiry | Use httpOnly cookies or implement refresh token with secure flag |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Alert list loads without auth error | User sees "loading..." spinner forever if JWT expired | Redirect to login on 401 from any alert API call |
| Report generation with no progress indicator | User clicks generate, nothing happens for 5+ seconds | Show progress states: "Collecting metrics", "Generating HTML", "Saving" |
| Threshold type toggle saves silently | User sets "Dynamic", reloads, sees "Static" again — thinks it's broken | After save, read back and show the actual saved value |
| JWT expires mid-report-download | Download fails, no error shown | Intercept 401 on all fetch responses; prompt re-login before retry |
| Aggregated events hide individual alerts | User dismisses event thinking it's fixed, but underlying alerts still firing | Event detail view should show all member alerts; resolved events should auto-resolve member alerts |
| Health report shows 100/100 | User believes instance is healthy when it's not | Show real health score or document "health score calculation pending" |

## "Looks Done But Isn't" Checklist

- [ ] **GET /api/alerts:** Often missing JWT auth — verify `preHandler: [verifyToken, requirePermission('alert:view')]` is present
- [ ] **Dynamic threshold toggle:** Often saves to frontend but not to DB — verify `threshold_type` is persisted in `alert_rules` table
- [ ] **silence_minutes configuration:** Often present in frontend UI but not saved to DB — verify `silence_minutes` column exists and is written by `updateAlertRule()`
- [ ] **Health report:** Often shows hardcoded 100/100 — verify actual health score is computed from metrics
- [ ] **Report type filter:** Often uses `'slow_query'` in one place and `'slow-query'` in another — verify single consistent value
- [ ] **Alert event aggregation:** Often misses boundary alerts due to fixed 5-min window — verify alerts within 10 minutes of each other are in the same event
- [ ] **Icon consolidation:** Often adds new icons to the wrong file — verify all views import from a single canonical icon file
- [ ] **ov-card removal:** Often leaves one view using old cards — verify ALL 5+ views use the new shared component

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Duplicate alerts from collector vs engine | LOW — delete duplicates and remove checkAlerts() | 1. `DELETE FROM alerts WHERE source='monitor-collector' AND id NOT IN (SELECT alert_id FROM alert_event_members)` 2. Remove checkAlerts() from monitor-collector.ts |
| Broken dynamic threshold persistence | MEDIUM — fix DB schema and data migration | 1. ALTER TABLE alert_rules ADD COLUMN threshold_type 2. UPDATE alert_rules SET threshold_type='static' WHERE threshold_type IS NULL 3. Fix backend interface and updateAlertRule() |
| Report type inconsistency | LOW — data migration | 1. `UPDATE reports SET type = 'slow_query' WHERE type = 'slow-query'` 2. Fix ReportType enum 3. Fix route validator |
| Two icon files with inconsistent names | MEDIUM — consolidating all imports | 1. Copy all unique icons from deprecated file to canonical file 2. Update imports across all files 3. Verify no broken icons in any view |
| ov-card refactor with missed views | LOW — fix remaining view | Check ALL views that import or use `ov-card`, `.ov-card`, `.ov-cards` |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| GET /api/alerts missing auth | Alert System | Incognito browser test: GET /api/alerts returns 401 |
| monitor-collector checkAlerts() duplicate | Alert System (remove first) | grep for `checkAlerts` in monitor-collector.ts returns nothing |
| threshold_type not persisted | Alert System | Integration test: save dynamic rule, read back, verify threshold_type |
| JWT refresh/lost session | Auth & Permissions | Simulate token expiry during active session, verify redirect to login |
| ov-card blast radius | UI Unification | All 6 views use `<stat-card>` component, no `.ov-card` CSS anywhere |
| Report type 'slow-query' vs 'slow_query' | Reports Refactoring | SELECT DISTINCT type FROM reports shows only canonical values |
| health_score hardcoded to 100 | Data Quality | Health report shows score != 100, verify matches real metrics |
| Event aggregation window collision | Alert System | Create test alerts at T+4min and T+6min, verify they aggregate into one event |
| Two icon files | UI Unification | grep for "styles/icons" in imports returns 0 results |
| Hardcoded metric typeMap | Alert System | metricRegistry.getById() used for type lookup, no hardcoded map |

## Sources

- Slide codebase `apps/db-ops-api/server.ts` lines 532, 567, 578, 388 — routes missing auth middleware
- Slide codebase `apps/db-ops-api/src/monitor-collector.ts` lines 311-341 — duplicate checkAlerts() method
- Slide codebase `apps/db-ops-api/src/alert-evaluator.ts` line 126 — threshold_type check on undefined field
- Slide codebase `apps/db-ops-api/src/alert-database-service.ts` line 31-45 — AlertRule interface missing threshold_type and silence_minutes
- Slide codebase `apps/db-ops-api/src/alert-engine.ts` lines 154-163, 183 — hardcoded typeMap
- Slide codebase `apps/db-ops-api/src/report-service.ts` lines 322-323 — hardcoded health_score=100
- Slide codebase `apps/db-ops-api/server.ts` lines 1391 vs `apps/db-ops-api/src/report-database-service.ts` line 7 — report type mismatch
- Slide codebase `apps/db-ops-api/src/event-aggregator.ts` line 39 — hardcoded 300-second bucket
- Slide codebase `frontend/src/styles/icons.ts` (470 lines) vs `frontend/src/openclaw/ui/icons.ts` (515 lines) — duplicate icon files
- Slide codebase `frontend/src/openclaw/ui/views/reports.ts`, `alerts.ts`, `dashboard.ts`, `schema-management.ts`, `instances-db.ts` — ov-card duplicates across 5+ views
- Slide codebase `frontend/src/openclaw/ui/views/event-management.ts` line 8 — localStorage token retrieval pattern
- Slide codebase milestone_context documented known issues: GET /api/alerts JWT auth, PDF concurrency, alert rate limiting

---
*Pitfalls research for: Slide v1.3 Alert System, Auth & Permissions, Reports Refactoring, Data Quality, UI Unification*
*Researched: 2026-05-20*
