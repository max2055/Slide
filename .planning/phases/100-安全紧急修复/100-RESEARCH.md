# Phase 100: 安全紧急修复 - Research

**Researched:** 2026-05-20
**Domain:** Security bugfix (unauthenticated routes, icon rendering, duplicate alerts, hardcoded health score)
**Confidence:** HIGH

## Summary

This phase addresses 4 production defects in the Slide v1.3 codebase: 4 unauthenticated API routes exposing data, a login page crash caused by the `eyeOff` SVG icon missing rendering attributes, duplicate alert generation from `monitor-collector.ts` bypassing `alert-engine`, and a hardcoded health score in `report-service.ts` that produces false health ratings.

All 4 fixes are straightforward code edits with no architectural changes required. The CONTEXT.md decisions have been verified against the actual code — no approach needs revision. One minor line number discrepancy was found (routes shifted by +6 lines from CONTEXT.md claims), and one additional hardcoded `health_score: 100` was discovered in a separate codebase (`apps/db-ops/src/api/database.ts:150`) that is out of scope for this phase.

**Primary recommendation:** Execute all 4 fixes as described in D-01 through D-04, applying to the actual line numbers documented below.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** 4 GET routes add `preHandler: [verifyToken]`, no new permission codes
- **D-02:** eyeOff SVG gets `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"` attributes
- **D-03:** Completely remove `checkAlerts()` method and its 2 call sites in monitor-collector.ts
- **D-04:** All hardcoded `health_score: 100` paths use `databaseService.checkHealth()` for real score

### Claude's Discretion
- Whether to fix other icons with missing SVG attributes alongside eyeOff

### Deferred Ideas (OUT OF SCOPE)
- None
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SEC-01 | 4 unauthenticated routes add auth middleware | Routes confirmed unprotected: GET /api/database/instances (L394), GET /api/alerts (L538), GET /api/metrics/:instanceId (L573), GET /api/chat/history (L584). verifyToken exists at L85. Pattern verified. |
| SEC-02 | Fix eyeOff icon crash on login page | eyeOff at icons.ts:439 confirmed missing rendering attributes. 3 other usages across frontend views. Most icons similarly affected but only eyeOff causes login page visual crash. |
| SEC-03 | Remove duplicate alerts from monitor-collector | checkAlerts() at monitor-collector.ts:311-341, called at L190 and L208. No external references. Alert-engine is the correct single source of truth. |
| SEC-04 | Fix hardcoded health_score = 100 | report-service.ts:321 (`health_score: 100`), monitor-collector.ts:200 and L228 (both `health_score: 100`). checkHealth() at database-service.ts:1399 works correctly and is already used by updateHealthStatusFromCheck() (L274-307). |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Auth middleware for routes | API / Backend | — | verifyToken is a Fastify preHandler middleware checking JWT in request headers — backend responsibility only |
| SVG icon rendering | Browser / Client | — | Icons.ts is a Lit template rendered in the browser — fix is purely frontend |
| Alert generation | API / Backend | — | Both monitor-collector and alert-engine run in the backend Node.js process |
| Health score computation | API / Backend | — | checkHealth() queries the database connection and computes a score in the backend |
| Report generation | API / Backend | — | report-service.ts generates reports server-side using backend data |

## Verified Code Locations

### SEC-01: 4 Unauthenticated Routes (server.ts)

| Route | CONTEXT.md Claimed | Actual Line | Discrepancy |
|-------|-------------------|-------------|-------------|
| GET /api/database/instances | L388 | L394 | +6 lines |
| GET /api/alerts | L532 | L538 | +6 lines |
| GET /api/metrics/:instanceId | L567 | L573 | +6 lines |
| GET /api/chat/history | L578 | L584 | +6 lines |

All 4 routes are confirmed **unprotected** — no `preHandler` parameter. The +6 line offset is consistent across all routes, likely due to minor edits since CONTEXT.md was generated.

**verifyToken location:** server.ts:85 (matches CONTEXT.md).

**Pattern on already-protected routes** (examples):
```typescript
fastify.get('/api/users', { preHandler: [verifyToken, requirePermission('admin:*')] }, handler);
fastify.post('/api/llm/configs', { preHandler: [verifyToken, requirePermission('llm:manage')] }, handler);
```

The pattern `{ preHandler: [verifyToken] }` is the correct syntax. No additional permission code is needed for these read-only routes.

### SEC-02: eyeOff Icon (icons.ts)

**eyeOff location:** frontend/src/openclaw/ui/icons.ts:439-449 [VERIFIED]

Current SVG (missing all rendering attributes):
```typescript
eyeOff: html`
  <svg viewBox="0 0 24 24">
    <path d="M10.733 5.076..." />
    <path d="M14.084 14.158..." />
    <path d="M17.479 17.499..." />
    <path d="m2 2 20 20" />
  </svg>
`,
```

**Usages of eyeOff across frontend:**
1. `login-gate.ts:81` — password visibility toggle (crash site)
2. `overview.ts:199` — gateway password field
3. `config-form.node.ts:211` — config form password field
4. `config.ts:1113` — config page password field

### SEC-03: checkAlerts() in monitor-collector.ts

**Method location:** monitor-collector.ts:311-341 [VERIFIED]
**First call site:** L190 (`await this.checkAlerts(instance.id, metrics)`) — inside `collectInstanceMetrics()` success path
**Second call site:** L208 (`await this.checkAlerts(instance.id, retryMetrics)`) — inside `collectInstanceMetrics()` retry path

**No external references found.** grep for `checkAlerts` across entire codebase only returns these 3 lines (definition + 2 calls) within monitor-collector.ts. [VERIFIED]

### SEC-04: Hardcoded health_score = 100

| File | Line | Code | Context |
|------|------|------|---------|
| report-service.ts | 321 | `health_score: 100, // TODO: 实现健康评分逻辑` | Inside `collectHealthMetrics()` — returns 100 regardless of actual DB state |
| monitor-collector.ts | 200 | `await instanceDatabaseService.updateHealthStatus(instance.id, 100, 'healthy')` | Reconnect success path (first occurrence) |
| monitor-collector.ts | 228 | `await instanceDatabaseService.updateHealthStatus(instance.id, 100, 'healthy')` | Reconnect success path (second occurrence, exception handler) |

**checkHealth() verification:** database-service.ts:1399 — correctly checks health per DB type (MySQL, PostgreSQL, Oracle, Dameng) and returns `{ health_score, status, checks }`. Already used by `updateHealthStatusFromCheck()` at monitor-collector.ts:274-307. [VERIFIED]

**Additional finding (out of scope):** `apps/db-ops/src/api/database.ts:150` has `health_score: 100` as default for new instance creation. This is in `apps/db-ops/` (an OpenClaw plugin, not the main API server). It is a reasonable default value, not a bug that needs fixing in this phase.

## Standard Stack

No new libraries needed for this phase. All fixes use existing code:

| Component | Location | Role |
|-----------|----------|------|
| verifyToken | server.ts:85 | JWT verification middleware |
| Fastify preHandler | Fastify route config pattern | Middleware injection |
| Lit html template | icons.ts | SVG icon template rendering |
| databaseService.checkHealth() | database-service.ts:1399 | Real health score computation |
| alert-engine | alert-engine.ts (separate module) | Single source of truth for alerts |

## Architecture Patterns

### Pattern: Fastify preHandler Middleware
**What:** Auth middleware is injected via `{ preHandler: [verifyToken] }` in route configuration.
**When to use:** For all protected routes requiring JWT validation.
**Example source:** server.ts lines 307-314 (list users), 317-335 (create user), etc.

### Anti-Pattern: Duplicate Alert Generation
**What:** monitor-collector.ts had its own `checkAlerts()` that duplicates `alert-engine.ts` logic.
**Why it's bad:** Two code paths generate the same alerts, producing duplicates. alert-engine has a proper lifecycle (silence/aggregation/escalation/notification). monitor-collector's version is an early prototype remnant.
**Remediation:** Complete removal — do not redirect to alert-engine, do not add source tags.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Health score computation | Custom math in report-service | `databaseService.checkHealth()` | Already exists, per-DB-type logic, works correctly |
| Alert evaluation | Inline rules checking | `alert-engine` | Full lifecycle management (silence, aggregation, escalation, notification) |

## Common Pitfalls

### Pitfall 1: Line Number Drift
**What goes wrong:** CONTEXT.md documents line numbers that shift over time as files are edited.
**Why it happens:** Any commit that adds/removes lines above the referenced code changes line numbers.
**How to avoid:** Always grep for route strings (`/api/alerts`, etc.) or function names instead of relying on line numbers from documentation.
**Warning signs:** Route registrations found 4-6 lines away from documented positions.

### Pitfall 2: Forgetting Other SVG Icons
**What goes wrong:** Only fixing eyeOff while other icons with the same attribute issue remain broken.
**Why it happens:** The icon rendering fix is scoped to eyeOff, but ~40 other icons have identical SVG structure.
**How to avoid:** Claude's Discretion allows batch-fixing all icons. If batch fix is chosen, the pattern is consistent: add `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"` to the `<svg>` element of each icon. However, risk is LOW — only eyeOff currently crashes the login page.

### Pitfall 3: Removing checkAlerts mocks from tests but keeping test code referencing them
**What goes wrong:** The monitor-collector test file imports `alertDatabaseService` from `alert-database-service` but the mock will become unused after checkAlerts removal.
**Why it happens:** `tests/monitor-collector.test.ts` mocks `alertDatabaseService` with `getAlerts` and `createAlert` — these mocks were exclusively used by checkAlerts. After removal, they are dead mocks (harmless, but clutter).
**How to avoid:** Clean up the alertDatabaseService mock and its `vi.mock()` import in the test file. Note: the test already has pre-existing issues (references `status.jobs` which doesn't exist in current `getStatus()` return type).

## Code Examples

### Adding preHandler to a route:
```typescript
// Current (unprotected):
fastify.get('/api/alerts', async (request, reply) => { ... });

// Fixed:
fastify.get('/api/alerts', { preHandler: [verifyToken] }, async (request, reply) => { ... });
```

### Adding SVG attributes to eyeOff:
```typescript
// Current (line 440):
eyeOff: html`
  <svg viewBox="0 0 24 24">
    <path d="..."/>
    <path d="..."/>
    <path d="..."/>
    <path d="..."/>
  </svg>
`,

// Fixed:
eyeOff: html`
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="..."/>
    <path d="..."/>
    <path d="..."/>
    <path d="..."/>
  </svg>
`,
```
Note: Add attributes to the `<svg>` element, not to each `<path>`. This matches the `shield` icon (line 489) which has the correct pattern with `fill="none" stroke="currentColor" stroke-width="1.5"` on `<svg>`.

### Using checkHealth() instead of hardcoded 100:
```typescript
// Current (report-service.ts:321):
health_score: 100, // TODO: 实现健康评分逻辑

// Fixed:
const health = await databaseService.checkHealth(instanceId);
health_score: health?.health_score ?? 0,
health_status: health?.status ?? 'unknown',
```

For monitor-collector.ts reconnect paths, the fix pattern should call `databaseService.checkHealth(instance.id)` after the successful reconnect and use the returned score/status instead of hardcoded `100`/`'healthy'`.

## Runtime State Inventory

> This section is included for rename/refactor/migration phases only. This is a pure bugfix phase — no renames or migrations.

Skipped — no renames, refactors, or migrations in this phase.

## Common Pitfalls (continued)

### Pitfall 4: Health score 100 in report-service collectHealthMetrics
**What goes wrong:** The hardcoded 100 propagates into generated health reports, making all instances appear perfectly healthy regardless of actual state.
**Why it happens:** `collectHealthMetrics()` was written with a TODO placeholder that was never implemented.
**How to avoid:** Replace with `databaseService.checkHealth(instanceId)` which returns the real computed score.
**Warning signs:** All generated health reports show `health_score: 100` even for degraded instances.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The `eyeOff` icon's missing SVG attributes cause the login page rendering issue | SEC-02 | LOW — the visual fix (adding attributes) is the correct thing regardless; if the root cause is elsewhere, this fix alone won't resolve the crash. The locked decision from CONTEXT.md requires this fix. |
| A2 | alert-engine is fully capable of replacing checkAlerts() without missing any coverage | SEC-03 | MEDIUM — if alert-engine doesn't evaluate the same metric thresholds that checkAlerts() does, some alert conditions may be missed. However, CONTEXT.md states alert-engine is the "single source of truth" with "complete lifecycle," so this risk is accepted by the locked decision. |

## Open Questions (RESOLVED)

1. **Are there additional hardcoded health_score: 100 values elsewhere?** RESOLVED: Accept the CONTEXT.md scope and fix only the 3 documented locations. If the `apps/db-ops` plugin needs fixing, it can be a separate task.
   - What we know: report-service.ts:321, monitor-collector.ts:200 and L228 are the 3 locations within the main API server. `apps/db-ops/src/api/database.ts:150` is in a separate plugin.

2. **Does the monitor-collector test file need cleanup?** RESOLVED: Remove the now-unused `alertDatabaseService` mock from the test file as part of SEC-03. Document the pre-existing `status.jobs` issue as a known problem not introduced by this phase.
   - What we know: `tests/monitor-collector.test.ts` mocks `alertDatabaseService` with `getAlerts` and `createAlert`. After removing checkAlerts(), the mock becomes unused. The test also references `status.jobs` which doesn't exist in current implementation (pre-existing issue).

## Environment Availability

> No external dependencies for this phase. All fixes are code-only changes.

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| None | — | — | — | — |

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest |
| Config file | apps/db-ops-api/vitest.config.ts (inferred from test imports) |
| Quick run command | `cd apps/db-ops-api && npx vitest run tests/monitor-collector.test.ts --reporter=verbose` |
| Full suite command | `cd apps/db-ops-api && npx vitest run --reporter=verbose` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SEC-01 | Auth middleware on 4 routes | Manual verification (integration) | `Verify: curl each route without token returns 401` | Manual-only |
| SEC-02 | eyeOff icon renders on login page | Manual (visual) | `Verify: login page password toggle icon visible` | Manual-only |
| SEC-03 | No duplicate alerts from checkAlerts() | Unit | `cd apps/db-ops-api && npx vitest run tests/monitor-collector.test.ts` | Yes (but has pre-existing issues) |
| SEC-04 | Health score uses checkHealth() | Manual (integration) | `Verify: generate health report and check score != 100` | Manual-only |

### Wave 0 Gaps
- [ ] `tests/monitor-collector.test.ts` — remove unused `alertDatabaseService` mock after checkAlerts removal (SEC-03 cleanup)
- [ ] No unit test exists for `report-service.ts` `collectHealthMetrics()` — would be nice but out of scope

*(If no gaps: "None — existing test infrastructure covers all phase requirements")*

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | `verifyToken` JWT middleware via Fastify preHandler |
| V3 Session Management | no | JWT is stateless |
| V4 Access Control | partial | verifyToken ensures authenticated, no role/permission check needed for read-only data |
| V5 Input Validation | no | No new input processing in this phase |
| V6 Cryptography | no | Reusing existing JWT verification (jsonwebtoken library) |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Unauthenticated data exposure | Information Disclosure | All 4 read-only GET routes add `preHandler: [verifyToken]` — any authenticated user can access (no permission code needed) |

## Sources

### Primary (HIGH confidence)
- **server.ts** — [VERIFIED: direct file read] All 4 route registrations confirmed unprotected, verifyToken at L85, pattern confirmed
- **monitor-collector.ts** — [VERIFIED: direct file read] checkAlerts() at L311-341, called at L190 and L208, no external references
- **report-service.ts** — [VERIFIED: direct file read] health_score: 100 at L321
- **icons.ts** — [VERIFIED: direct file read] eyeOff at L439-449, missing all rendering attributes
- **database-service.ts** — [VERIFIED: direct file read] checkHealth() at L1399, works correctly, used by updateHealthStatusFromCheck()
- **login-gate.ts** — [VERIFIED: direct file read] eyeOff used at L81 for password toggle
- **tests/monitor-collector.test.ts** — [VERIFIED: direct file read] mocks alertDatabaseService, references non-existent `status.jobs`

### Secondary (MEDIUM confidence)
- **grep validation** — [VERIFIED: bash] No external references to checkAlerts outside monitor-collector.ts
- **grep validation** — [VERIFIED: bash] 3 hardcoded health_score: 100 found in db-ops-api, 1 in apps/db-ops

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new libraries needed
- Code locations: HIGH — all verified by direct file read
- Test impact: MEDIUM — pre-existing test issues identified but not fully analyzed
- Side effects: HIGH — grep confirmed no external references to changed code

**Research date:** 2026-05-20
**Valid until:** N/A — this is a bugfix phase with verified production code, findings are valid as long as the codebase state is current.
