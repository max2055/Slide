# Project Research Summary

**Project:** Slide v1.3 — Database Operations Platform
**Domain:** AI-Powered Database Operations Platform
**Researched:** 2026-05-20
**Confidence:** HIGH

## Executive Summary

Slide v1.3 targets five enhancement areas for an existing AI-powered database operations platform: Alert System, Auth & Permissions, Report Refactoring, Data Quality, and UI Unification. The codebase is production-grade with extensive existing infrastructure — all five areas extend or fix existing components rather than introduce net-new systems. The research reveals a mature platform with specific technical debt that must be resolved before new features can ship reliably.

The recommended approach is a phased build order that prioritizes blocking infrastructure first: fix the missing auth middleware on unprotected routes (a critical security gap), resolve broken icon references that crash the login gate, then implement the auth refresh token mechanism. Only after these foundation fixes should the team tackle UI consolidation, report refactoring, alert system enhancements, and data quality scoring. The research identifies three classes of work: critical security/UX fixes (missing auth middleware, broken login icon, health score hardcoded to 100), incremental improvements (refresh tokens, icon consolidation, ov-card extraction), and genuinely new capability (AI learning thresholds, multi-session event aggregation, instance scoring).

Key risks: (1) Four production API routes have zero auth middleware, exposing instance names, metrics, and alerts to unauthenticated requests. (2) The `monitor-collector.ts` has a duplicate alert-creation path that fights with the `alert-engine` cron, causing duplicate alerts. (3) The `health_score` is hardcoded to 100 in report generation — all health reports claim the instance is perfectly healthy. (4) Two icon files exist with overlapping but different sets, causing missing-icon runtime errors in production views including the login gate. All four risks have straightforward fixes documented in the research.

## Key Findings

### Recommended Stack

The research is definitive: **no new core libraries are needed** for v1.3. The existing stack already covers all feature requirements. The only new dependency is EJS 5.0.2 for server-side report templates, replacing the current 638-line inline HTML string approach in `report-service.ts`.

**Core technologies:**
- **Node.js 18+ / Fastify + TypeScript** (existing): Backend runtime. No upgrade needed.
- **Lit 3.3 + Vite** (existing): Frontend framework. No upgrade needed.
- **Redis / ioredis 5.3.2** (existing): Token blacklisting, refresh token store, cache.
- **simple-statistics 7.8.9** (existing): Moving average, standard deviation, percentile for threshold learning and scoring algorithms. Already installed.
- **jsonwebtoken 9.0.2** (existing): JWT creation and verification. Already installed. Used for refresh token pattern.
- **Anthropic/OpenAI SDKs** (existing): AI-powered threshold recommendation and score explanation. Already installed.
- **PDFKit 0.18.0** (existing): PDF report generation. Keep — do NOT replace with puppeteer/playwright.
- **EJS 5.0.2** (NEW): Server-side report template engine. 205KB, zero dependencies. Replaces inline HTML strings.

**What NOT to add:** Puppeteer (300MB Chromium, not needed for table+metric-card reports), Playwright (same problem), Handlebars (2.8MB vs EJS 205KB), @material/web (4MB, conflicts with custom UI), @lit-labs/task (outdated, existing patterns work), lucide-static (not needed for internal tool UI), any OAuth library (not in v1.3 scope), any policy engine (RBAC tables already work).

**Icon approach:** Do NOT add an external icon library. The existing `icons.ts` file has 60+ Lucide-style SVG icons. The work is to fill 33 missing icon references (including `eyeOff` which breaks the login gate), standardize naming conventions, and consolidate the two competing icon files into one canonical file.

See [STACK.md](.planning/research/STACK.md) for full details.

### Expected Features

**Must have (table stakes) — these represent gaps or incompleteness in the current implementation:**
- Fix missing auth middleware on `GET /api/alerts`, `GET /api/metrics/:instanceId`, `GET /api/database/instances`, `GET /api/chat/history` — critical security issue
- Implement alert rule threshold editing (frontend rule editor currently does not save `threshold_template` to backend)
- Fix alert rule enable/disable toggle (column exists, frontend partial)
- Implement login session persistence with refresh tokens (current single JWT with 24h expiry means silent mid-session logout)
- Make all referenced icons exist in the icon library (33 missing, causing runtime errors including login gate crash)
- Fix report type naming inconsistency (`slow-query` vs `slow_query` causing data corruption in `reports.type` column)
- Replace hardcoded `health_score: 100` with actual computed score
- Provide per-check-item detail in health status display

**Should have (differentiators):**
- Refactor 6 views with duplicated `ov-card` CSS into a shared `<stat-card>` Lit component
- Extract inline report HTML templates from `report-service.ts` into EJS template files
- Add report config management with scheduled delivery
- Implement AI auto-threshold learning from baseline calculations
- Implement multi-session event aggregation (cross-metric correlation)
- Add instance scoring with weighted category breakdown (availability, performance, capacity, security)
- Implement adaptive silence based on alert frequency
- Add metric collection permission detection and display per instance
- Audit frontend routes for permission-aware UI (hide nav items user cannot access)

**Defer (v2+):**
- SSO / OAuth / LDAP integration
- Custom report templates and ad-hoc report builder
- OS-level metric collection via agent
- Fully automated root cause (present AI suggestions, not facts)
- Super-fine permission codes (100+), permission inheritance chains
- Real-time streaming anomaly detection via Redis Streams
- Complete visual redesign/theme overhaul
- Score-based alert for every instance (limit to production environments)

See [FEATURES.md](.planning/research/FEATURES.md) for full analysis with table-stakes/differentiator/anti-feature breakdowns and cross-feature dependency graph.

### Architecture Approach

The architecture uses a standard 3-tier pattern: Lit 3.3 frontend on port 5173, Fastify + TypeScript backend on port 3000, with MySQL as primary store and Redis/Elasticsearch/MongoDB for specialized workloads. The OpenClaw native gateway on port 28789 provides WebSocket-based AI integration. The existing architecture is mature and well-structured — all five v1.3 feature areas extend existing components rather than introducing new patterns.

**Major components relevant to v1.3:**
1. **Alert System** (existing: alert-engine.ts, alert-evaluator.ts, event-aggregator.ts, 11 tables) — Needs: threshold_template persistence fix, AI learning cron, multi-session correlation, removal of duplicate checkAlerts() in monitor-collector
2. **Auth System** (existing: auth-database-service.ts, rbac-service.ts, require-permission.ts, 8 tables) — Needs: refresh token mechanism, auth middleware on 4 unprotected routes, frontend API client with 401 interceptor, time-bound role grants
3. **Report System** (existing: report-service.ts, report-exporter.ts, report-database-service.ts, 2 tables) — Needs: EJS template extraction, report config table + scheduled generation, ov-card replacement, type normalization
4. **Data Quality** (existing: monitor-collector.ts, metrics-database-service.ts, baseline-calculator.ts, health_check_history table) — Needs: instance-score-service.ts, collection capability detection, score trend UI
5. **UI Icons** (existing: two competing icon files) — Needs: consolidation to one canonical file, 33 missing icons added, naming convention bridge, lint rule

**Key patterns to follow:**
- Extend existing services, do not create new service categories
- Reuse `simple-statistics` for threshold learning algorithms rather than adding dependencies
- Keep GPT/AI calls through the existing `llm-service` / `aiBridge` path (OpenClaw gateway)
- Add DB migrations for new columns/tables, never modify existing columns in-place
- Use the existing cron infrastructure (server.ts startup) for new scheduled tasks

See [ARCHITECTURE.md](.planning/research/ARCHITECTURE.md) for full component inventory, data flow diagrams, and integration matrix.

### Critical Pitfalls

1. **GET /api/alerts and three other routes have NO auth middleware.** Any unauthenticated request can list all alerts, metrics, instances, and chat history. Fix: Add `preHandler: [verifyToken, requirePermission(alert:view)]` to `GET /api/alerts`, `GET /api/metrics/:instanceId`, `GET /api/database/instances`, `GET /api/chat/history` — do this BEFORE any alert feature work.

2. **monitor-collector.ts has a duplicate checkAlerts() that creates alerts independently from alert-engine.** Both systems create alerts for the same metrics but use different dedup logic (one checks status='open', the other checks silence_periods). This causes duplicate alerts. Fix: Remove checkAlerts() from monitor-collector.ts entirely. The collector should ONLY collect metrics.

3. **threshold_type and silence_minutes are defined in frontend interfaces and checked in evaluator code, but NOT persisted in the backend AlertRule interface or updateAlertRule().** Users can toggle "Dynamic threshold" in the UI, save, and reload to find it reverted to static. Fix: Add threshold_type and silence_minutes to the AlertRule interface in alert-database-service.ts, add DB columns via migration, update updateAlertRule() to persist both.

4. **Report types are stored inconsistently as 'slow-query' (ReportType enum) and 'slow_query' (route validator).** Data in the reports table has both values, causing filtering to return incomplete results. Fix: Choose one convention, add DB migration to normalize existing rows, type the frontend Report interface properly, use a shared constant.

5. **Two icon files exist with overlapping but different sets.** `styles/icons.ts` (470 lines, kebab-case keys) and `openclaw/ui/icons.ts` (515 lines, camelCase property names). 33 icons referenced in views are missing from both. The login gate crashes at runtime because `icons.eyeOff` does not exist. Fix: Designate `openclaw/ui/icons.ts` as canonical, copy all unique icons from the deprecated file, update all imports, add a lint rule to prevent imports from `*/styles/icons`.

Additional significant pitfalls documented in the full research: health_score hardcoded to 100 in all report output, event aggregation window collision (5-min fixed bucket splits incidents), hardcoded metric-to-alert-type map that silently mislabels new metrics, and JWT stored in localStorage with no refresh path causing silent mid-session logout.

See [PITFALLS.md](.planning/research/PITFALLS.md) for full pitfall analysis including recovery strategies and a "looks done but isn't" verification checklist.

## Implications for Roadmap

The research reveals two competing phase orderings. FEATURES.md prioritizes UI first (missing icons block all testing). ARCHITECTURE.md prioritizes Auth first (all features need stable auth). The synthesis resolves this tension by splitting out critical pre-work (fix broken auth routes and the login-crashing icon) as an urgent Phase 0, then following the ARCHITECTURE.md ordering which has stronger dependency reasoning for the remaining work.

### Phase 0: Emergency Security & Login Fixes
**Rationale:** Four API routes expose data without auth. One missing icon crashes the login gate. These are production incidents, not feature work.
**Delivers:** Routes with auth middleware; functional login page.
**Addresses:** Missing auth on GET /api/alerts, /api/metrics/:instanceId, /api/database/instances, /api/chat/history; fix `eyeOff` icon in login gate.
**Avoids:** PITFALLS-1 (missing auth middleware), PITFALLS-4 (JWT expiry mid-session — partially, by fixing the login gate to render at all).

### Phase 1: Auth Refresh Token & Permission Audit
**Rationale:** All authenticated features (alerts, reports, data quality) need stable, long-lived auth sessions. The refresh token pattern is well-documented and uses only already-installed libraries (jsonwebtoken, ioredis, crypto built-in). This is a self-contained change.
**Delivers:** Refresh token mechanism (new /api/auth/refresh route, new refresh_tokens table/columns, frontend ApiClient with 401 interceptor and transparent token refresh).
**Addresses:** FEATURES.md Auth table-stakes (login session survival), differentiator (refresh token with sliding expiration).
**Uses:** Existing jsonwebtoken, ioredis, crypto.
**Implements:** ARCHITECTURE's section 2.1 (token refresh data flow), new api/client.ts.
**Avoids:** PITFALLS-4 (JWT refresh lost mid-session).

### Phase 2: UI Unification
**Rationale:** High-touch frontend work that touches most views. Doing it early minimizes merge conflicts with later phases. Fixes runtime errors that currently block navigation.
**Delivers:** Consolidated single icon file with all 33 missing icons added; naming convention resolved; ov-card CSS extracted to shared <stat-card> Lit component across 6 views; @keyframes fade-in moved to shared CSS module; inline SVGs and emoji icons replaced with shared icon calls.
**Addresses:** FEATURES.md UI table-stakes (icon consistency, shared card component).
**Implements:** ARCHITECTURE's section 5.1 and 5.2.
**Avoids:** PITFALLS-5 (ov-card blast radius), PITFALLS-9 (two icon files).

### Phase 3: Report Refactoring
**Rationale:** Benefits from Phase 2 CSS standards (shared stat-card) and icon consistency. The EJS template extraction is a self-contained backend change. Fixes the slow-query/slow_query data corruption.
**Delivers:** Report templates extracted from report-service.ts into EJS files; report_configs table + generation scheduling; ov-card in reports.ts replaced with shared component; reports.type data migration; consistent report headers.
**Addresses:** FEATURES.md Report table-stakes (consistent card, fixed headers), differentiator (scheduled delivery).
**Uses:** EJS 5.0.2 (new dependency from STACK).
**Implements:** ARCHITECTURE's section 3 (report configs, template extraction).
**Avoids:** PITFALLS-6 (report type inconsistency).

### Phase 4: Alert System Enhancements
**Rationale:** The biggest new capability phase. Threshold editing is a quick win. AI learning and multi-session aggregation are genuinely novel. Requires fixing threshold_type and silence_minutes persistence as a prerequisite.
**Delivers:** Alert rule threshold editing (3-level warning/error/critical via PUT route fix); AI auto-threshold learning from baseline (new alert-threshold-learner.ts cron, alert_threshold_learning_log table); multi-session event aggregation (cross-metric correlation in event-aggregator.ts); adaptive silence; hardcoded metric typeMap replaced with MetricDefinition.category.
**Addresses:** FEATURES.md Alert table-stakes (threshold editing, enable/disable toggle) and differentiators (AI learning, multi-session aggregation, adaptive silence).
**Implements:** ARCHITECTURE's sections 1.2, 1.3, 1.4.
**Avoids:** PITFALLS-3 (threshold_type mismatch), PITFALLS-8 (aggregation window collision), PITFALLS-10 (hardcoded metric typeMap).

### Phase 5: Data Quality & Instance Scoring
**Rationale:** Additive to existing health checks, least urgent — current health_score already works (it is just hardcoded to 100 in reports). Collection permissions fix is independent.
**Delivers:** InstanceScoreService with multi-category weighted scoring (availability 0.35, performance 0.35, capacity 0.20, security 0.10); score trend chart from existing health_check_history; collection capability detection per instance (collection_capabilities JSON column, permission check endpoint); replace health_score: 100 with instanceScoreService.computeScore() in report generation.
**Addresses:** FEATURES.md Data Quality table-stakes (score formula transparency, trend, per-check detail).
**Implements:** ARCHITECTURE's sections 4.1, 4.2, 4.3.
**Avoids:** PITFALLS-7 (health_score hardcoded to 100).

### Phase Ordering Rationale

- **Phase 0 before everything:** Broken auth routes and a crashing login gate are production-blocking issues. No feature work can be reliably tested until these are fixed. This is not a planning decision — it is incident response.
- **Auth before UI:** Auth refresh is a self-contained backend + frontend change. UI work touches every frontend file. Doing UI first (as FEATURES.md suggests) means every subsequent phase risks merge conflicts with the icon/CSS refactoring. Auth has no such cross-cutting concern.
- **Report after UI:** Report refactoring directly uses the shared stat-card and icons that Phase 2 produces. Doing report work before UI would mean refactoring ov-card twice.
- **Alert before Data Quality:** Alert AI learning depends on the scoring algorithm from Data Quality. However, the research shows that alert threshold editing, metric typeMap fix, and event aggregation fixes are independent of scoring and can ship earlier. Data Quality scoring can be the capstone that feeds back into alerts.
- **Data Quality last:** Additive improvement that can coexist with current implementation. The scoring algorithm should be validated against real instances before being used for alerting.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 4 (Alert AI Learning):** The threshold learning algorithm needs careful design around baseline quality. Empty baseline = keep static threshold. Low-confidence baseline = widen sigma. Operator override must always win. The research provides the mathematical approach (moving window + z-score) but the per-rule sigma configuration and auto-apply flow need detailed design.
- **Phase 4 (Multi-session aggregation):** The cross-metric correlation logic is genuinely novel. The research identifies the data structures needed (correlation events, ai_analysis_id FK) but the correlation algorithm needs design work: what is the similarity threshold for merging? How do you prevent false correlations from merging unrelated incidents?
- **Phase 5 (Instance Scoring):** The scoring algorithm weights (0.35/0.35/0.20/0.10) are research recommendations, not verified against real user expectations. These need validation with actual DBAs during implementation.

Phases with standard patterns (skip research-phase):
- **Phase 1 (Auth Refresh):** Well-documented pattern. JWT + refresh token with rotation is a solved problem. The research provides the exact data flow and SQL schema.
- **Phase 2 (UI Unification):** Straightforward frontend work. Icon consolidation is mechanical. The research already identified all 33 missing icons and the naming convention mismatch.
- **Phase 3 (Report Refactoring):** EJS template extraction and report config management follow established patterns. The research provides the complete migration path.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Verified against existing codebase (npm view package metadata, code analysis). All libraries confirmed installed and working. Only new dependency (EJS 5.0.2) verified via npm registry. |
| Features | HIGH | Based on thorough codebase analysis of ALL backend services, frontend views, and SQL schema (1295 lines). Every "existing" claim is verified against source code. Missing icon list compiled via grep across all views. |
| Architecture | HIGH | Component inventory verified against actual source files. Data flow diagrams reflect live production code paths. Anti-patterns identified from actual code (not hypothetical). Integration matrix cross-references all new components against existing ones. |
| Pitfalls | HIGH | Every pitfall is rooted in specific, verified code locations (line numbers included). Recovery strategies are concrete SQL statements and code changes, not general advice. Security issues confirmed by grep for missing preHandler. |

**Overall confidence:** HIGH

### Gaps to Address

- **Scoring algorithm weights:** The recommended weights (availability 0.35, performance 0.35, capacity 0.20, security 0.10) are the researcher's recommendation based on industry practice. These must be validated with actual database administrators during Phase 5 implementation. Consider making weights configurable from day one rather than hardcoding.
- **AI threshold learning confidence levels:** The research proposes z-score-based threshold computation but does not specify how low-confidence baselines are handled. During Phase 4 planning, define: (a) minimum data points needed, (b) sigma multiplier when stddev is very small, (c) notification thresholds for large adjustments.
- **Notification channel typeMap:** The hardcoded metric-to-alert-type map fix (replace with MetricDefinition.category) requires adding category to the MetricDefinition type in metric-registry.ts. The research identifies this gap but the exact migration path for existing metric definitions needs design.
- **Two competing phase orderings:** FEATURES.md and ARCHITECTURE.md disagree on Phase 1 priority (UI vs Auth). This summary resolves the tension with Phase 0 + Auth-first ordering with strong rationale, but the roadmap creator should validate this dependency analysis against actual team availability and risk tolerance.

## Sources

### Primary (HIGH confidence)
- Slide codebase: apps/db-ops-api/server.ts — all route registrations, auth middleware, login flow
- Slide codebase: apps/db-ops-api/src/alert-engine.ts, alert-evaluator.ts, event-aggregator.ts, alert-database-service.ts, alert-rca-service.ts, alert-escalation-service.ts, alert-silence-service.ts, alert-event-service.ts — full alert system
- Slide codebase: apps/db-ops-api/src/auth/rbac-service.ts, require-permission.ts, require-instance-access.ts, auth-database-service.ts, rbac-api.ts — full auth/RBAC system
- Slide codebase: apps/db-ops-api/src/report-service.ts, report-exporter.ts, report-database-service.ts — report generation (638 lines, inline HTML)
- Slide codebase: apps/db-ops-api/src/monitor-collector.ts — metrics collection with duplicate checkAlerts()
- Slide codebase: apps/db-ops-api/src/baseline-calculator.ts — baseline computation for threshold learning
- Slide codebase: apps/db-ops-api/sql/schema.sql (1295 lines) — all table definitions verified
- Slide codebase: frontend/src/openclaw/ui/icons.ts (515 lines) + frontend/src/styles/icons.ts (470 lines) — both icon files
- Slide codebase: frontend/src/openclaw/ui/views/*.ts — all frontend views (25+), icon usage, ov-card patterns
- npm view ejs@5.0.2, puppeteer@25.0.4, playwright@1.60.0, lucide-static@1.16.0, @material/web@2.4.1, simple-statistics@7.8.9 — package metadata verified on 2026-05-20
- Slide codebase: frontend/src/openclaw/ui/views/login-gate.ts, event-management.ts — localStorage token pattern, icon reference patterns

---
*Research completed: 2026-05-20*
*Ready for roadmap: yes*
