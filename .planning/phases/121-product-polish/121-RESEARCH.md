# Phase 121: 可信闭环与体验打磨 - Research

**Researched:** 2026-06-24
**Domain:** System health/consistency checking, UI polish, onboarding readiness
**Confidence:** HIGH

## Summary

This phase adds a backend consistency checker service with a `GET /api/health/consistency` endpoint, a frontend "health center" page in the settings area, a first-start readiness check, a final UI consistency verification pass, and a manual golden-flow verification checklist. The notification closure check is explicitly deferred (returns fixed `deferred` status with explanation).

The backend work is straightforward — a new `consistency-checker.ts` service registered as a single route in server.ts. The frontend work follows the established settings page template (Template A: max-width 800px, page-header, app-card). The frontend health center page registers as a new sub-tab in settings-shell.ts.

**Primary recommendation:** Execute in spec order (01a backend -> 01b frontend -> 04 readiness -> 03 UI verify -> 02 golden flow manual). All components are well-understood patterns.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Notification closure is deferred — returns fixed `deferred` status in consistency API, no implementation
- 10 consistency check categories are defined in the 121-01a PLAN
- Readiness checks share the same API as consistency checks (readiness section in response)
- First-start readiness is integrated into the health center page (Option A), not Dashboard
- Settings page work is verification-only (121-03), not re-execution
- Golden flow is manual checklist, not Playwright E2E (environment constraints)

### Claude's Discretion
- How to organize the consistency checker service (single file vs multiple modules)
- Whether to require auth on `/api/health/consistency` (no write ops, but contains system info)
- Frontend error/loading/empty state details
- Settings page grep guardrail exact patterns

### Deferred Ideas (OUT OF SCOPE)
- Notification auto-send pipeline
- New database type support
- Large-scale agent-core rewrite
- New design system or UI framework
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| POLISH-01 | 关键链路可信 | Consistency checker + health center + golden flow verification |
| CONSISTENCY-01 | 闭环健康中心 API + 前端页面 | New `/api/health/consistency` + health-center.ts page |
| GOLDEN-FLOW-01 | 金牌用户故事 E2E 可验证 | Manual checklist format, documented in VERIFICATION.md |
| ONBOARDING-01 | 首次启动检查 + 修复建议 | Readiness section in consistency API + frontend banner |
| UI-CONSISTENCY-02 | 设置页模板统一收尾 | Grep guardrails + page checklist + build verification |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Data consistency checks | Backend (API) | Database | Queries multiple DB tables, returns structured results |
| Health page rendering | Browser (Client) | — | LitElement component fetches API, renders pass/warn/fail |
| Readiness detection | Backend (API) | Database/Network | Tests DB connectivity, LLM provider status, cron state |
| UI consistency verification | CI / Dev machine | — | grep commands + manual page inspection |
| Golden flow verification | Manual / Dev machine | — | Human-executable checklist, not automated |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Fastify (built-in) | — | Route registration | Existing pattern in server.ts |
| mysql2/promise (built-in) | — | Database queries | Existing via `dbConnection.query()` |
| Lit 3.3 (built-in) | 3.3.x | Frontend component | Health center page as LitElement |
| TypeScript (built-in) | — | Types for consistency check schema | Existing throughout project |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| app-card (built-in) | — | Card containers | Health center check items and categories |
| app-badge (built-in) | — | Status badges | pass/warn/fail/deferred indicators |
| app-empty-state (built-in) | — | Error state | API fetch failure display |
| sharedBtnStyles (built-in) | — | Button styles | Retry button in error state |
| authFetch (built-in) | — | API calls | Fetch consistency API from frontend |

## Package Legitimacy Audit

> No new external packages are installed in this phase. All code is implemented using existing project libraries (Fastify, mysql2/promise, Lit, TypeScript) and shared components.

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────┐     GET /api/health/consistency     ┌───────────────────┐
│  Browser     │ ──────────────────────────────────► │  Fastify Server   │
│  (LitElement)│                                     │  (server.ts)      │
│              │ ◄────────────────────────────────── │                   │
│  health-     │     JSON: ConsistencyResponse       │  consistency-     │
│  center.ts   │                                     │  checker.ts       │
└─────────────┘                                     └────────┬──────────┘
                                                             │
                                                    ┌────────▼──────────┐
                                                    │  Database (MySQL) │
                                                    │  - database_      │
                                                    │    instances       │
                                                    │  - metrics_history │
                                                    │  - alert_rules     │
                                                    │  - cron_jobs       │
                                                    │  - chat_sessions   │
                                                    │  - roles/user_roles│
                                                    │  - approval_events │
                                                    └───────────────────┘
```

### Recommended Project Structure

```
apps/db-ops-api/src/
├── consistency-checker.ts    # NEW — all 10 consistency check methods

frontend/src/app/ui/views/
├── health-center.ts          # NEW — <health-center-page> LitElement
├── settings-shell.ts         # MODIFIED — register new sub-tab

.planning/phases/121-product-polish/
├── 121-GOLDEN-FLOW-VERIFICATION.md   # NEW — manual checklist output
└── 121-VERIFICATION.md               # NEW — overall phase verification
```

### Pattern 1: Route Registration in server.ts
**What:** Register a new GET route with optional auth middleware, following the existing server.ts pattern.
**When to use:** Adding the `/api/health/consistency` endpoint.

```typescript
// Source: Existing server.ts line 187-192 (health check pattern)
fastify.get('/api/health/consistency', async (request, reply) => {
  try {
    const result = await consistencyChecker.runAllChecks();
    reply.send(result);
  } catch (error: any) {
    reply.code(500).send({ error: error.message });
  }
});
```

**Auth consideration:** The existing `/api/health` is unauthenticated. `/api/health/consistency` reveals system info (instance count, LLM provider status, cron state). Recommend adding `{ preHandler: [verifyToken] }` for consistency, matching the pattern used by all other data-returning routes. No write permissions are needed.

### Pattern 2: Consistency Check Method Pattern
**When to use:** Each of the 10 check methods in consistency-checker.ts.

```typescript
// Pattern from existing check-data-integrity.ts (line 43-59)
async function checkInstanceCountMatch(): Promise<ConsistencyCheck> {
  const pool = dbConnection.getPool()!;
  const [rows] = await pool.execute(`SELECT ...`);
  // Determine pass/warn/fail from row data
  return {
    id: 'instance_count_match',
    label: '实例数与仪表盘一致',
    category: 'instance',
    status: count > 0 ? 'pass' : 'fail',
    severity: 'major',
    summary: `${count} 个活跃实例`,
    recommendation: count > 0 ? undefined : '请添加数据库实例',
  };
}
```

### Pattern 3: Settings Page Template (Template A)
**When to use:** The health center page follows the same pattern as scoring-settings.ts, ai-settings.ts, llm-config.ts.

```typescript
// Source: scoring-settings.ts lines 1-117 (verified existing code)
@customElement("health-center-page")
export class HealthCenterPage extends LitElement {
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private data: ConsistencyResponse | null = null;

  static styles = [sharedBtnStyles, css`
    :host { display: block; max-width: 800px; }
    .page-header { margin-bottom: 24px; }
    .page-header h1 { font-size: 22px; font-weight: 700; margin: 0 0 4px; color: var(--text-strong); }
    .page-header p { font-size: 13px; color: var(--muted); margin: 0; }
    .loading { padding: 48px; text-align: center; color: var(--muted); }
  `];

  override connectedCallback() { super.connectedCallback(); this._load(); }

  private async _load() {
    this.loading = true; this.error = null;
    try {
      const res = await authFetch("/api/health/consistency");
      if (!res.ok) throw new Error(`加载失败 (${res.status})`);
      this.data = await res.json();
    } catch (e: any) { this.error = e.message; }
    finally { this.loading = false; }
  }

  override render() {
    if (this.loading) return html`<div class="loading">加载中...</div>`;
    if (this.error) return html`<div class="loading" style="color:var(--danger)">${this.error} <button class="btn btn-primary" @click=${this._load}>重试</button></div>`;
    // ... render page-header, readiness bar, summary bar, check items
  }
}
declare global { interface HTMLElementTagNameMap { "health-center-page": HealthCenterPage; } }
```

### Pattern 4: Sub-tab Registration in settings-shell.ts
**When to use:** Adding the health center tab to the settings navigation.

```typescript
// Source: settings-shell.ts lines 9-27 (verified existing code)
// 1. Add to type union:
type SettingsSubTab = /* ... */ | "health-center";

// 2. Add to SUB_TABS array:
{ id: "health-center", label: "闭环健康", icon: "activity" },

// 3. Add to _renderTabContent switch:
case "health-center":
  return html`<health-center-page></health-center-page>`;
```

### Anti-Patterns to Avoid
- **Hand-rolling skeleton/loading CSS**: Use existing `.skeleton` class or simple `loading` text pattern from scoring-settings.ts.
- **Putting complex DB queries in the route handler**: Abstract all consistency checks into `consistency-checker.ts` with one method per check. The route handler only calls `runAllChecks()`.
- **Async waterfall:** Each check should be independent. Use `Promise.all()` to run checks in parallel where possible, but be mindful of DB connection pool limits (current pool: 10).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Status badges | Custom CSS for pass/fail/warn/deferred | `<app-badge variant="ok|danger|warn|muted">` | Existing component with proper color tokens |
| Card layout | Div with card CSS class | `<app-card variant="default">` | Existing component with structured header/body/footer |
| Empty state | Custom "no data" div | `<app-empty-state>` with title/description/icon | Existing component with consistent styling |
| Loading indicator | Custom spinner CSS | Simple text "加载中..." or `.skeleton` class | Consistent with existing settings pages (scoring-settings.ts pattern) |
| Toast notifications | Custom toast div | `showToast()` from app-toast-container.ts | Singleton pattern, consistent UX |
| Retry button | Hand-written button styles | `class="btn btn-primary"` via sharedBtnStyles | Existing pattern across all pages |

**Key insight:** This phase is about integration and polish, not building new UI primitives. Every visual element needed already exists as a shared component.

## Common Pitfalls

### Pitfall 1: Async Database Queries Throwing Unhandled Errors
**What goes wrong:** A single check method throws (table doesn't exist, connection lost), causing the entire `/api/health/consistency` endpoint to return 500.
**Why it happens:** Checks run sequentially or in Promise.all without error isolation.
**How to avoid:** Each check method should have a try-catch and return the check result with `status: 'fail'` on error rather than rethrowing. Use a `checkSafe()` wrapper:
```typescript
async function checkSafe(fn: () => Promise<ConsistencyCheck>): Promise<ConsistencyCheck> {
  try { return await fn(); }
  catch (err: any) { return { id: 'unknown', label: '检查失败', category: 'system', status: 'fail', severity: 'critical', summary: err.message, recommendation: '检查服务日志' }; }
}
```

### Pitfall 2: DB Connection Pool Exhaustion
**What goes wrong:** Running 10 parallel queries on a pool of 10 connections causes contention or timeout.
**Why it happens:** The main pool has `connectionLimit: 10`. If 10 simultaneous queries all grab connections, the 11th query hangs.
**How to avoid:**
- Run checks sequentially (acceptable for occasional health checks — not a high-traffic endpoint)
- Or if parallel, batch into 3-4 groups at a time
- Reference: `dbConnection.getPool()` in `db-connection.ts` line 47 sets `connectionLimit: 10`

### Pitfall 3: API Schema Mismatch Between Backend and Frontend
**What goes wrong:** Backend returns a field named `camelCase` but frontend expects `snake_case`, or nested structures don't match.
**Why it happens:** No shared type definition between client and server.
**How to avoid:** Define the `ConsistencyCheck` and `ConsistencyResponse` TypeScript interfaces in the backend (`consistency-checker.ts`) and replicate the exact shape in the frontend (`health-center.ts`). Use the PLAN.md schema as the single source of truth.

### Pitfall 4: async/await in Promise.all Without Error Handling
**What goes wrong:** `Promise.all(checks.map(fn))` where one fn throws — all results are lost.
**Why it happens:** Promise.all rejects on first error.
**How to avoid:** Use `Promise.allSettled()` or the `checkSafe()` wrapper above.

### Pitfall 5: Boolean Property Binding in Lit
**What goes wrong:** `?disabled=${this.loading}` uses attribute binding correctly, but `disabled=${this.loading}` converts false to "false" string which is truthy.
**How it applies:** The retry button and any disabled states in the health center must use `?disabled=` prefix. Reference: CLAUDE.md "Boolean property binding must use `.` prefix" rule — but for HTML boolean attributes like `disabled`, use `?` prefix.

### Pitfall 6: Settings-shell sub-tab added without considering admin-only visibility
**What goes wrong:** Health center is visible to non-admin users but should be visible to all (it's a read-only system info page).
**How to avoid:** The `SUB_TABS` entry should NOT have `requireAdmin: true`. The health center page should be visible to all authenticated users since it only displays data.

## Code Examples

### Verified Consistency Check SQL Queries

**Source:** `check-data-integrity.ts` (verified existing code) + schema.sql analysis.

**instance_count_match** — Compare dashboard instance count vs actual active instances:
```sql
-- Active instances count
SELECT COUNT(*) as active_count, SUM(data_size_gb) as total_data_size
FROM database_instances WHERE status = 'active';
```

**capacity_sum_match** — Sum instance data_size_gb vs latest capacity_history total_size_gb:
```sql
-- Latest capacity history total (per instance)
SELECT instance_id, total_size_gb
FROM capacity_history ch1
WHERE recorded_at = (
  SELECT MAX(recorded_at) FROM capacity_history ch2 WHERE ch2.instance_id = ch1.instance_id
);
```

**metrics_freshness** — Check for recent metrics_history data:
```sql
-- Latest metrics data across all instances
SELECT MAX(recorded_at) as latest_metric_time
FROM metrics_history;
```

**alert_rule_metric_refs** — Orphan metric references in alert_rules:
```sql
SELECT ar.id, ar.name, ar.metric_name
FROM alert_rules ar
LEFT JOIN metric_definitions md ON ar.metric_name = md.id
WHERE md.id IS NULL;
```

**event_member_status_match** — Resolved/closed events with open member alerts:
```sql
SELECT ae.id, ae.event_id, ae.title, ae.status as event_status, COUNT(aem.id) as open_members
FROM alert_events ae
JOIN alert_event_members aem ON ae.id = aem.event_id
JOIN alerts a ON aem.alert_id = a.id
WHERE ae.status IN ('resolved', 'closed') AND a.status NOT IN ('resolved', 'closed')
GROUP BY ae.id, ae.event_id, ae.title, ae.status;
```

**rbac_orphan_records** — Dangling role_permissions and user_roles:
```sql
-- Dangling role_permissions (role no longer exists)
SELECT rp.id FROM role_permissions rp
LEFT JOIN roles r ON rp.role_id = r.id WHERE r.id IS NULL;
-- Dangling user_roles (user no longer exists)
SELECT ur.id FROM user_roles ur
LEFT JOIN users u ON ur.user_id = u.id WHERE u.id IS NULL;
```

**cron_hung_jobs** — Enabled jobs with stale running logs, or enabled jobs with past next_run_at:
```sql
-- Enabled jobs with recent running log (hung)
SELECT cj.id, cj.name, cjl.started_at
FROM cron_jobs cj
JOIN cron_job_logs cjl ON cj.id = cjl.job_id AND cjl.status = 'running'
WHERE cj.enabled = TRUE AND cjl.started_at < NOW() - INTERVAL 10 MINUTE;
-- Enabled jobs with past next_run_at (stalled)
SELECT id, name, next_run_at FROM cron_jobs
WHERE enabled = TRUE AND next_run_at IS NOT NULL AND next_run_at < NOW();
```

**chat_session_stats** — Verify message_count vs actual count, last_message_at vs max(created_at):
```sql
SELECT cs.id, cs.session_id, cs.message_count as stored_count, COUNT(cm.id) as actual_count,
       cs.last_message_at as stored_last_msg, MAX(cm.created_at) as actual_last_msg
FROM chat_sessions cs
LEFT JOIN chat_messages cm ON cs.session_id = cm.session_id
GROUP BY cs.id, cs.session_id, cs.message_count, cs.last_message_at;
```

**approval_event_integrity** — Executed requests with missing approval_events; pending requests > N days:
```sql
-- Approved/executed requests without corresponding approval_events
SELECT ar.id FROM approval_requests ar
WHERE ar.status IN ('approved', 'executed')
AND NOT EXISTS (SELECT 1 FROM approval_events ae WHERE ae.request_id = ar.id AND ae.event_type IN ('approved', 'executed'));
-- Pending requests older than 7 days
SELECT id, created_at FROM approval_requests
WHERE status = 'pending' AND created_at < NOW() - INTERVAL 7 DAY;
```

### Readiness Check Implementation

The existing `/api/health` endpoint (line 187-192 in server.ts) returns simple `{status: 'ok'}`. The readiness section in the consistency API extends this pattern:

```typescript
// Pattern: Check DB connectivity via existing dbConnection.isConnected()
const dbConnected = dbConnection.isConnected();
// Reference: db-connection.ts line 79

// Check LLM provider availability
const [llmRows] = await pool.execute(
  'SELECT id FROM llm_providers WHERE enabled = TRUE'
);
const llmAvailable = (llmRows as any[]).length > 0;

// Check cron jobs enabled
const [cronRows] = await pool.execute(
  'SELECT id FROM cron_jobs WHERE enabled = TRUE'
);
const cronRunning = (cronRows as any[]).length > 0;

// Check agent engine (DirectAdapter WS) port
// Use TCP connect check (net module) or rely on existing health data
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Hand-rolled modals/forms | Shared `app-dialog`, `app-form-field` | Phase 120 | Health center uses `<app-card>`, not custom CSS |
| Flat settings tabs | settings-shell with sub-tabs | Phase 112-117 | Health center registers as new sub-tab |
| Hard-coded cron handlers | DB-driven cron_jobs with NL description | Phase 113 | cron_hung_jobs check uses cron_jobs + cron_job_logs tables |
| No consistency checks | New consistency-checker.ts service | This phase | Single API for 10 cross-table integrity checks |

**Deprecated/outdated:**
- `.card` CSS class: Must use `<app-card>` component instead. 121-03 grep guardrails enforce this.
- `.modal-overlay`: Must use `<app-dialog>`. Verified by 121-03 grep guardrails.
- `.badge`, `.tag`, `.status-badge`: Must use `<app-badge>`. Verified by 121-03 grep guardrails.
- `class="btn primary"` (space separator): Must use `class="btn-primary"` (hyphen). Verified by 121-03 grep guardrails.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `authFetch` from `src/api/index.ts` works for GET requests to `/api/health/consistency` | Standard Stack | Low — `authFetch` is the standard pattern used in all settings pages (scoring-settings.ts line 61) |
| A2 | The `dbConnection.getPool()!.execute()` pattern works from a new service file imported in server.ts | Architecture | Low — all existing DB services (instance-database-service.ts, etc.) use this pattern |
| A3 | The new health center sub-tab should NOT have `requireAdmin` | Pitfalls | Low — health data is read-only system info, all authenticated users benefit from seeing it |
| A4 | Promise.all with 10 parallel DB queries won't exhaust the 10-connection pool | Pitfalls | MEDIUM — running checks sequentially is safer and the endpoint is not high-traffic |

**If this table is empty:** All claims in this research were verified or cited — no user confirmation needed.

## Open Questions

1. **Should the consistency checker be a class with methods, or a module with exported functions?**
   - What we know: Both patterns exist in the codebase (class: `DbConnectionManager` in db-connection.ts; module functions: `check-data-integrity.ts`)
   - What's unclear: No strong preference
   - Recommendation: Use a class `ConsistencyChecker` with individual check methods, matching the class pattern used by most services. Export a singleton `consistencyChecker`.

2. **What icon should the health center tab use?**
   - Available icons: 'activity' (pulse line), 'heart-pulse' (heart with pulse), 'shield' (shield), 'check-circle' (check mark in circle)
   - Recommendation: 'activity' — most thematically appropriate for "health" monitoring

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Backend (server.ts) | Check at runtime | — | — |
| MySQL | Consistency checks | Check at runtime | — | API should not 500 without DB |
| npm | Build verification (121-03) | Check at runtime | — | — |

**Missing dependencies with no fallback:** None — this phase adds no new external dependencies.

**Missing dependencies with fallback:** None — DB will be checked at runtime.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (existing, from vitest.config.ts) |
| Config file | apps/db-ops-api/vitest.config.ts |
| Quick run command | `cd apps/db-ops-api && npx vitest run --reporter=verbose src/consistency-checker.test.ts 2>&1 \| tail -30` |
| Full suite command | `cd apps/db-ops-api && npx vitest run 2>&1 \| tail -20` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CONSISTENCY-01 | consistencyChecker.runAllChecks returns structured response with 10 checks | unit | `npx vitest run src/consistency-checker.test.ts -t "returns all 10 checks"` | ❌ Wave 0 |
| CONSISTENCY-01 | Each check method runs without throwing | unit | `npx vitest run src/consistency-checker.test.ts -t "safe check"` | ❌ Wave 0 |
| CONSISTENCY-01 | Readiness section reports DB/LLM/Cron/Agent status | unit | `npx vitest run src/consistency-checker.test.ts -t "readiness"` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** Quick run for affected test file
- **Per wave merge:** Full suite
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/consistency-checker.test.ts` — covers consistency-checker.ts (at least 3 check methods, per 121-01a PLAN verification)
- [ ] `src/consistency-checker.test.ts` — covers safe-check wrapper (error isolation)

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | `{ preHandler: [verifyToken] }` on the new route (recommended, matches existing pattern) |
| V4 Access Control | yes | Read-only endpoint — no permission required beyond authentication. Health data is not sensitive beyond system info disclosure. |
| V5 Input Validation | no | GET route with no user input parameters |

### Known Threat Patterns for Fastify/MySQL Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SQL injection | Tampering | Parameterized queries via `pool.execute(sql, values)` — all consistency checks must use this pattern |
| Unauthenticated system info disclosure | Information Disclosure | Add `{ preHandler: [verifyToken] }` — consistency data includes instance count, provider status |

## Sources

### Primary (HIGH confidence)
- [Verified: codebase read] - server.ts route registration pattern (lines 187-192 for `/api/health`, lines 2370+ for notification routes, lines 4180+ for cron routes)
- [Verified: codebase read] - settings-shell.ts sub-tab registration pattern (lines 9-27 for SUB_TABS, lines 112-131 for _renderTabContent)
- [Verified: codebase read] - scoring-settings.ts Template A pattern (entire file, 117 lines)
- [Verified: codebase read] - db-connection.ts pool management (line 47 for connectionLimit: 10)
- [Verified: codebase read] - check-data-integrity.ts SQL patterns (lines 43-98 for LEFT JOIN orphan checks)
- [Verified: codebase read] - schema.sql (all CREATE TABLE statements for relevant tables)
- [Verified: codebase read] - notification migration (009_add_cron_jobs_tables.sql for cron_jobs schema)
- [Verified: codebase read] - app-card.ts, app-badge.ts, app-empty-state.ts, authFetch in api/index.ts

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All libraries are existing project dependencies
- Architecture: HIGH - Route registration, sub-tab pattern, and settings page template are well-understood
- Pitfalls: HIGH - Based on observed patterns from 120+ completed phases
- Security: MEDIUM - Auth decision for new route is not locked in CONTEXT.md

**Research date:** 2026-06-24
**Valid until:** 2026-07-24 (30 days — stable project conventions)
