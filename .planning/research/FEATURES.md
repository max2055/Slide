# Feature Research

**Domain:** Database Operations Platform — v1.3 New Features (Alert, Auth, Report, Data Quality, UI)
**Researched:** 2026-05-20
**Confidence:** HIGH (based on thorough codebase analysis)

## Feature Landscape — Five Target Areas

This document analyses the 5 v1.3 feature areas in the context of database operations platforms. Each area is evaluated for what's table stakes, what differentiates, and what should be avoided.

---

## 1. Alarm System (告警系统)

### Existing State (Already Built)
- Alert engine with 60s cron evaluation via `alert-engine.ts`
- `alert_rules` table with metric_name, operator, threshold, severity, duration_seconds
- 3-level thresholds (warning/error/critical) via `threshold_template` JSON column
- Dynamic baseline thresholds via `metric_baselines` table (mean +/- sigma)
- Event aggregation: groups same instance + metric + 5-min window alerts (min 2) into events via `event-aggregator.ts`
- Alert events lifecycle: open → investigating → handled → resolved → closed via `alert-event-service.ts`
- Escalation rules, maintenance windows, silence periods
- 6-tab frontend (alerts, rules, escalation, maintenance, silence, baselines)
- Notification channels: DingTalk/WeCom/Feishu/Webhook via `notification-service.ts`
- AI event-level auto-RCA via `alert-rca-service.ts`

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Rule threshold editing (static) | Operator must adjust CPU 80%→90% without SQL | LOW | Frontend rule edit modal already exists in `alerts.ts` rules tab, but needs validation + persistence testing |
| Rule enable/disable toggle | Operator pauses noisy rules without deleting | LOW | `alert_rules.enabled` column already exists. Frontend toggle partial. |
| Manual alert acknowledge/mark-read | Operator reviewed the alert, needs to dismiss | LOW | `alerts.status` supports `acknowledged`. Frontend actions partially exist. |
| Event detail view | See which alerts caused the event | MEDIUM | `alert-event-service.ts` returns members. Frontend event detail modal needs confirmation. |
| Alert filtering by severity/status/instance | Operator focuses on critical prod alerts | LOW | Filter state in `alerts.ts` already handles this. |
| Dedup (same alert not repeated endlessly) | Otherwise 1000 identical alerts flood in | LOW | Post-trigger silence via `silence_periods` already works (5-min default). |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **AI auto-threshold learning** | Operator sets "learn from last 7 days" — system auto-adjusts thresholds based on baseline | HIGH | `baseline-calculator.ts` already computes mean+stddev. Missing: UI to auto-update `threshold_template` from baseline; auto-apply flow |
| **Multi-session event aggregation** | CPU + memory + connections alerts at same time → one "resource pressure" event | HIGH | Current aggregator handles `instance_id + metric_name + 5-min`. Need session-level (multiple metrics, same instance, same time) — "this instance is under stress" grouping |
| **Alert root cause event grouping** | 5 alerts all caused by one issue (e.g., connection storm) | HIGH | Requires:
1. Correlation engine (time-series correlation of metrics)
2. Post-event correlation (is this new alert related to an open event?)
3. AI-enhanced event merging
4. Backend event-session service |
| **Dynamic silence adjustment** | If alert repeats after silence, auto-extend silence or escalate | MEDIUM | Currently fixed `silence_minutes` per rule. Need adaptive silence based on alert frequency |
| **Alert impact assessment** | "This high CPU is affecting query latency by 15%" | HIGH | Cross-metric correlation at query time. Requires query analytics integration. |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| AI auto-create rules for every metric | Looks like full automation | Creates 50+ noisy rules, overwhelming operators. Nonsensical for metrics that don't need alerting (data_size_gb). | AI only adjusts thresholds of existing enabled rules. Operator manually adds new rules. |
| Fully automated root cause | "Just tell me the cause without clicking" | Hallucination risk with LLM. False confidence. | Event grouping → AI RCA triggered on event creation, but presented as suggestion not fact. |
| Custom alert scripts / webhook evaluation | "I want to evaluate custom conditions" | Unbounded security risk. SSRF, injection. | Built-in metric transformations and composite rules (AND/OR of existing metrics). |
| P0 severity for everything | Users escalate noise to bypass filters | Destroys severity as a signal. | Clamp severity by rule type. System prevents P0 on `vacuum_count`. |

### Dependencies

```
Threshold editing (UI) → tests existing rule-update API
AI learning thresholds → requires baseline-calculator.ts + auto-update flow
Multi-session aggregation → new correlation table + event-session service
Dynamic silence → extends silence-period logic
```

---

## 2. Auth & Permissions (认证权限)

### Existing State (Already Built)
- JWT auth via `auth-database-service.ts` (bcrypt password verification)
- RBAC tables: `roles`, `permissions`, `role_permissions`, `user_roles`, `instance_permissions`
- `requirePermission` middleware in `auth/require-permission.ts`
- `requireInstanceAccess` middleware in `auth/require-instance-access.ts`
- RBAC CRUD API in `auth/rbac-api.ts`
- System roles seeded: admin/dba/developer/analyst/viewer/auditor
- Permission codes: `resource:action` format (e.g., `instance:query`, `alert:manage`)
- Frontend login gate via WebSocket to OpenClaw gateway
- Token stored in `localStorage` with key "token"
- JWT expiration from `system_config` `auth.jwt_expiration_minutes` (default 1440 min = 24h)
- No refresh token mechanism. Token is single JWT with no refresh pairing.

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Login session survives page refresh | User refreshes browser, stays logged in | LOW | Currently uses `localStorage.getItem("token")` — JWT is already persisted. _Should already work for most cases._ Key question: is token checked/validated on app startup? |
| Login session survives browser close + reopen | "I closed it yesterday, it should still be logged in" | LOW | Same mechanism. But expiration (24h default) means overnight close → expired. |
| Logout clears session | Security hygiene | LOW | Need to remove token from localStorage + optionally invalidate on backend |
| Permission check on protected routes | Non-admin cannot access admin APIs | LOW | `requirePermission` middleware already exists. Need to audit all routes for coverage gaps. |
| Instance-level access control | DBA Alice only sees her instances | MEDIUM | `requireInstanceAccess` middleware exists. Need to verify frontend also filters instance lists by user's permissions. |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Refresh token with sliding expiration** | Session stays alive as long as user is active, expires after inactivity | MEDIUM | Standard pattern: JWT (15min short-lived) + refresh_token (7d long-lived). Frontend auto-refreshes before each API call or on 401. `localStorage` stores both. |
| **Granular permission on frontend UI** | "Can see the alert tab but not the report tab" | MEDIUM | Frontend loads user's permissions on login, uses them to conditionally render nav items and buttons. Backend already returns permissions. |
| **Audit trail for all auth actions** | "Who granted DBA permissions to this user?" | LOW | `user_action_logs` table already exists. Need to wire up permission change events. |
| **SSO / OAuth / LDAP integration** | Enterprise users want Okta/Azure AD login | HIGH | New auth provider abstraction. Not for v1.3 initial scope — plan for v2. |
| **Session management UI** | "See all active sessions, force-logout a stale one" | MEDIUM | Requires session tracking table. Backend tracks token family (jti). Admin UI to revoke. |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Super-fine permission codes (100+) | "I want to control every button" | Admin complexity explodes. Nobody can manage 100+ permissions. | Use wildcards (already have `*`) and resource-level granularity. Max 30-40 permission codes. |
| Permission inheritance chains | "Manager role inherits from DBA but overrides X" | Debugging impossible. "Why can Alice do X?" hard to trace. | Flat role-permission mapping. Each role has explicit permission set. |
| Require re-login on every API 401 | "Best security" | Furious users. Kicked out mid-query. | Silent token refresh on 401. Only redirect to login on refresh token expiry (or explicit 403). |
| IP allowlist per user | "Only access from office IP" | Mobile/remote users break. Complex setup. | Environment-level IP allowlist (corp VPN target) instead. |

### Dependencies

```
Refresh token → needs: refresh_tokens table, /api/auth/refresh endpoint, frontend axios interceptor
Frontend permission filtering → needs: /api/auth/me/permissions endpoint (already exists from RBAC)
Audit trail → needs: permission-change event wiring (uses existing user_action_logs table)
```

---

## 3. Report Refactoring (报表重构)

### Existing State (Already Built)
- `reports` table: type (health/performance/slow_query/capacity/audit/custom), format, content, data
- Report generation via `report-service.ts` (health, performance, slow_query, capacity)
- Report export via `report-exporter.ts` (PDF/HTML/JSON/MD)
- Frontend `reports.ts` view: ov-card summary grid + report types grid + history table
- **ov-card pattern used in 6 files**: reports.ts (25), dashboard.ts (30), instances-db.ts (14), schema-management.ts (23), alerts.ts (31), overview-cards.ts (7)
- Reports use "health check report" / "performance report" naming — concept of "report" vs "report type" somewhat conflated

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Consistent card/stat component across pages | Users expect same visual patterns | MEDIUM | ov-card is duplicated CSS in 6 files with slight variations. Need a shared `<slide-card>` Lit component. |
| Fixed-info report headers | Every report should show instance name, time range, generated date | LOW | Add standard header to all report templates. Currently each template does its own. |
| Clear 报表/报告 naming | "What's the difference?" Users confused | LOW | Unify: "报告" for generated documents (health/performance), "报表" for data tables/lists. Or pick one and be consistent. |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Scheduled report delivery** | "Email me a health report every Monday at 9 AM" | MEDIUM | cron-based report generation + notification channel integration. New `report_schedules` table. |
| **Report dashboard with trend** | "Show last 12 weekly reports as a trend chart" | MEDIUM | Aggregate `report.data` JSON over time. ECharts line chart. |
| **Report comparison** | "Compare this week's health vs last week" | MEDIUM | Side-by-side report rendering. Diff view for scores. |
| **Custom report templates** | "I want my own sections and layout" | HIGH | Template engine (Handlebars/similar). User-defined sections. Defer to v2. |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Ad-hoc report builder UI | "Drag and drop metrics onto a canvas" | Huge UI complexity. Almost every DB ops platform's worst feature. | Scheduled fixed-type reports. If user needs custom data → SQL console + CSV export. |
| Real-time report generation | "I want this report NOW, loading..." | Report generation takes seconds for large instances. Locking the UI is bad. | Background generation with status polling (already implemented: pending→completed flow). |
| All-in-one "everything" report | Print 50 pages of every available metric | Nobody reads it. Wastes compute generating unused data. | Type-specific reports (health, performance, capacity each have scope). |

### Dependencies

```
ov-card removal → 6 files need refactoring. Shared component or CSS extract.
Report header unification → update report-generator HTML templates in report-service.ts
Naming unification → simple text substitutions across frontend zh-CN i18n strings
```

---

## 4. Data Quality (数据质量)

### Existing State (Already Built)
- `database_instances.health_score` column (0-100), computed by `database-service.ts` `checkHealth()`
- MySQL health check: connection status, connection usage, buffer pool hit rate, table cache hits, rate checks
- PostgreSQL health check: connection status, connection usage, cache hit ratio, data size check
- `health_check_history` table: stores score + checks JSON + issues JSON
- `baseline-calculator.ts`: computes mean + stddev per metric per instance
- Instance health status: healthy/warning/critical/unknown
- No comprehensive "data quality scoring algorithm" — health_score is simple weighted penalty, not structured

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Instance scoring with defined formula | Users want to understand "why is my score 62?" | MEDIUM | Current `checkHealth()` has implicit score adjustments (e.g., `totalScore -= 30`). Need explicit weighted formula displayed in UI. |
| CPU/memory collection permission awareness | "I'd like CPU but don't have OS access" | LOW | Current CP 使用率 is estimated from DB internals (threads/transactions weighted), not OS-level. Need to document: "requires OS agent / comes from DB internal estimates". For true OS CPU → need db-connection or SSH agent. |
| Score trend over time | "Was my score better last week?" | LOW | Already have `health_check_history`. Need a trend chart in instance detail view. |
| Individual check item scores | Show pass/fail per check with score contribution | MEDIUM | `checks` JSON already stored in `health_check_history`. Need frontend to display it as a scored checklist. |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Weighted scoring with user-adjustable weights** | DBA can say "connection usage matters more to me" | MEDIUM | Store check weights in `metric_definitions` or a new `scoring_weights` table. Formula: `sum(check_score * weight) / sum(weight)`. |
| **LLM-powered score explanation** | "Your health score dropped 15 points because CPU spiked and slow queries increased" | MEDIUM | Feed `checkHealth` results + recent `metrics_history` diff to LLM for plain-language summary. |
| **Multi-dimension scoring** | Separate availability, performance, capacity, security scores | HIGH | Category-weighted composite score. Each category has its own sub-checks. Currently all checks are flat in one array. |
| **Score prediction** | "If this trend continues, your score will drop to 40 in 3 days" | HIGH | Use existing `capacity-predictor.ts` linear regression approach but apply to health score and key metrics. |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Single "perfect formula" for all instances | "Standardize scoring across all DB types" | Oracle has different metrics than MySQL. Prod vs dev have different standards. | Separate scoring profiles per DB type AND per environment. Flexible weight templates. |
| OS-level metric collection via agent | "Give me real CPU, not estimated" | Installing agents on every DB host is heavy ops burden. Adds attack surface. | Support both: estimated (no agent) for quick setup, OS-level if agent is installed. Clearly label which is used. |
| Score-based alert for every instance | "Alert when score < 80" | Too noisy for dev/staging. Good prod-only threshold. | Allow score alert configuration per instance group/environment, not global. |

### Dependencies

```
Score formula refinement → extends existing checkHealth() logic
Score trend chart → uses existing health_check_history table data
Weight management → new scoring_weights table or extends metric_definitions
LLM score explanation → feeds checkHealth results to existing llm-service
```

---

## 5. UI Unification (UI 统一)

### Existing State (Already Built)
- `frontend/src/styles/icons.ts`: ~60 Lucide-style SVG icons, many unused or duplicated
- Icon name convention conflict: icons.ts uses kebab-case (`bar-chart`), views use camelCase (`barChart`)
- **33 icon names referenced in views are MISSING from icons.ts** (see below)
- `ov-card` CSS class duplicated across 6 views with near-identical definitions
- Login gate uses `icons.eyeOff` which does not exist in icons.ts → likely runtime error
- Various components use inline SVG and inconsistent button/variable naming conventions

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| All referenced icons exist in library | Runtime errors break features | LOW | 33 missing icons identified. Critical: `eyeOff` (login gate), `calendar`, `loader`, `refresh`, `checkCircle`, `barChart` cause broken UI. |
| Consistent icon naming convention | Developers can find/add icons without confusion | LOW | Pick one convention (camelCase or kebab-case), alias the other. icons.ts uses kebab, views use camelCase — total mismatch. |
| Shared stat card component | 6 duplicated `ov-card` CSS blocks is tech debt | MEDIUM | Extract to shared `<slide-stat-card>` Lit element or CSS mixin in a shared stylesheet. |
| Consistent button/input/label styling | Buttons look different per page | LOW | Shared CSS variables already exist. Need audit of individual component overrides. |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Themed icon swap** | "Give me outline vs filled style" | MEDIUM | Export icons as Lit templates with strokeWidth variable. Swap via theme setting. |
| **Accessibility audit** | Screen readers, keyboard navigation | MEDIUM | `aria-hidden` on icon containers already done. Need focus management and keyboard nav on all interactive elements. |
| **CSS variable documentation** | "What's `--warn-subtle` vs `--warn`?" | LOW | Document all custom CSS variables. Extract theme definition. |

### Missing Icons (from icons.ts)

These are icons referenced in views but missing from the library:

**Critical (causes visible runtime errors):**
1. `eyeOff` — login-gate.ts toggle password visibility
2. `checkCircle` — alerts.ts empty state
3. `barChart` — reports.ts report type grid
4. `fileText` — reports.ts history section
5. `calendar` — alerts.ts maintenance window
6. `loader` — alerts.ts baseline computation
7. `refresh` — alerts.ts re-compute button
8. `bellOff` — alerts.ts silence period
9. `partyPopper` — alerts.ts empty state
10. `arrowRight` — alerts.ts escalation rules empty state

**Should have (consistent nav/icons):**
11. `chevronDown` (exists as `chevron-down` — naming mismatch)
12. `chevronRight` (exists as `chevron-right` — naming mismatch)
13. `trendingUp` (exists as `trending-up` — naming mismatch)
14. `hardDrive` (exists as `hard-drive` — naming mismatch)
15. `alertCircle` — partially covered by `circle-alert`
16. `alertTriangle` — covered by `triangle-alert`
17. `history` — useful for audit pages
18. `user` — useful for user management
19. `search` (already exists)
20. `download` (already exists)
21. `maximize` / `minimize` — SQL console fullscreen
22. `monitor` — dashboard/instance display
23. `pause` / `stop` — collector controls

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Replace all SVG with icon library (FontAwesome/Material) | "Popular library is easier" | Adds 50KB+ bundle. License considerations. Breaking existing icons. | Fill gaps in existing Lucide-style set. Add only missing icons as SVGs. No external dependency. |
| Complete visual redesign | "Let's fix all the styling at once" | Massive churn. Regression risk on every view. | Fix only: missing icons + naming convention + ov-card extraction. Save theme overhaul for v2. |
| Animation framework | "Fade between pages, slide-in notifications" | Performance overhead. Can cause nausea for some users. | Minimal transitions (existing `fade-in` + `rise` animations are sufficient). |

### Dependencies

```
Missing icons → just add SVGs to icons.ts (1-2 lines each)
Naming convention → Option A: rename icons.ts to use camelCase (affects all existing usages)
                 → Option B: add aliases in icons.ts export (backward compat)
                 → Option C: make accessor normalize keys (cleanest, no refactoring)
ov-card extraction → needs shared stat card component. Affects 6 view files.
```

---

## Feature Dependencies (v1.3 Cross-Cutting)

```
[1. Alert AI Thresholds]
    └──requires──> [Baseline calculator] (EXISTS: baseline-calculator.ts)
    └──requires──> [Rule threshold auto-update API] (NEW: /api/alerts/rules/:id/auto-threshold)
    └──enhances──> [UI threshold editing]

[2. Auth Refresh Token]
    └──requires──> [JWT token validation refactor] (frontend)
    └──requires──> [Refresh token table + API] (NEW: refresh_tokens table)
    └──enhances──> [Auth session management]

[3. Report ov-card removal]
    └──requires──> [Shared stat-card component] (NEW)
    └──requires──> [CSS audit of 6 views for consistent styling]
    └──enhances──> [UI icon consistency]

[4. Data Quality Scoring]
    └──requires──> [Health check formula audit] (document existing algorithm)
    └──requires──> [Check weights data model] (if user-configurable)
    └──uses──> [Health check history] (EXISTS)

[5. UI Icon Consistency]
    └──requires──> [Missing icon SVGs] (add ~15 SVGs)
    └──requires──> [Naming convention resolution] (camelCase ↔ kebab-case bridge)
    └──enhances──> [All other features] (icons appear everywhere)
```

### Critical Cross-Dependency

**Missing icons block reliable testing of ALL other features.** If `icons.eyeOff` causes an error in the login gate, and `icons.barChart` causes an error in the reports view, testers cannot actually navigate through these features. **UI icon consistency should be the v1.3 Phase 1 foundation**, not a polish task deferred to later.

---

## Phase Ordering Recommendation (for v1.3)

```
Phase 1: UI Foundation (blocks everything else)
  - Fix ALL missing icons in icons.ts (add SVGs)
  - Resolve naming convention (camelCase ↔ kebab-case bridge)
  - Fix login gate eyeOff runtime error
  - Extract shared ov-card → stat-card component

Phase 2: Auth + Permissions (login reliability)
  - Implement refresh token mechanism
  - Audit route permission coverage
  - Wire frontend permission filtering
  - Add auth action audit logging

Phase 3: Report Refactoring
  - Replace ov-card in reports.ts with shared component
  - Add fixed report headers
  - Unify 报表/报告 naming
  - Verify all report types render correctly

Phase 4: Alert System Enhancements
  - Add threshold auto-learning flow (baseline → threshold update)
  - Implement multi-session event aggregation
  - Add adaptive silence
  - Add event session correlation UI

Phase 5: Data Quality Scoring
  - Document existing health score formula
  - Add score trend chart (uses existing health_check_history)
  - Add check item detail display
  - Add CPU/memory collection permission config
  - (Optional: adjustable weights, LLM explanation)
```

### Phase Ordering Rationale

1. **UI first** because all other features are tested through the UI. If icons are broken, testers/navigators hit errors before they reach any feature.

2. **Auth second** because login session reliability is a table-stakes fix that affects every user on every visit. Refresh token is a small backend change with high user impact.

3. **Report refactoring third** because it's a contained UI change (ov-card → component) that benefits from Phase 1's icon fixes. The report header unification is straightforward.

4. **Alert enhancements fourth** because AI threshold learning is the biggest new capability, requiring both baseline algorithm understanding and new auto-update flow. Multi-session aggregation is genuinely novel.

5. **Data quality last** because it's both additive (score improvements can coexist with current scoring) and the least urgent — current health_score already works, just isn't transparent or configurable.

### Research Flags for Phases

| Phase | Flag |
|-------|------|
| **Phase 1: UI** | LOW risk. Icon gaps are mechanical SVGs. Need to verify: Are any unused icons in icons.ts actually used by OpenClaw core views (not Slide views)? Deleting unused ones could break OpenClaw components. |
| **Phase 2: Auth** | LOW risk. Refresh token is a well-known pattern. Need to verify: JWT library support? `jsonwebtoken` already in use. |
| **Phase 3: Reports** | LOW risk. Pure frontend refactoring. Risk: breaking existing report rendering. Mitigate: visual diff or snapshot tests. |
| **Phase 4: Alert** | MEDIUM risk. AI threshold learning needs careful design: baseline quality varies. Empty baseline = keep static threshold. Low-confidence baseline = widen sigma. Operator override always wins. |
| **Phase 5: Data Quality** | LOW risk for basic improvements (trend chart, check details). MEDIUM for configurable weights (misconfiguration could produce confusing scores). |

---

## Sources

- **Codebase analysis**: `apps/db-ops-api/src/` — all backend services and tables verified via schema.sql and source code
- **Frontend analysis**: `frontend/src/openclaw/ui/views/alerts.ts`, `reports.ts`, `login-gate.ts`, `overview-cards.ts` — verified icon references, tab structure, state management
- **Icon analysis**: `frontend/src/styles/icons.ts` vs grep across all view files — 33 missing icons identified, naming convention conflict documented
- **Schema analysis**: `apps/db-ops-api/sql/schema.sql` (1295 lines) — all table definitions verified
- **Existing FEATURES.md**: `.planning/research/FEATURES.md` — v1.1 RBAC/Approval/SQL Console research referenced for cross-dependency check
