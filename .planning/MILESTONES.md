# Milestones

## v1.2 UI + AI + Docs (Shipped: 2026-05-20)

**Phases completed:** 9 phases, 27 plans, 54 tasks

**Key accomplishments:**

- Removed 6 unused OpenClaw menu tabs (sessions, usage, skills, config, appearance, system) from navigation, cleaned dead imports/render blocks from app-render.ts, and deleted 7 orphaned view files while redirecting type imports to surviving type files
- Extended scope beyond original plan — user-requested continuation.
- Refactored ai-analysis-result.ts from self-contained analysis launcher to data-driven presentational component with XSS sanitization, 6 render states, and trigger source tags
- Config service with getConfig/saveConfig in system_config, recent diagnosis endpoint by instance_id + analysis_type, and config CRUD routes
- Status badges, clickable result modals, and auto-analysis config panel integrated into alert list page
- Diagnosis history section with recent 5 summaries and refactored diagnosis card using ai-analysis-result component
- Port four upstream OpenClaw chat state management fixes to eliminate loading animation stalls, new-session flash, and session message race conditions
- One-liner:
- Item A — Heartbeat Token Stripping:
- Replace db_sql_optimization tool stub with real slow query retrieval from metricsDatabaseService.getSlowQueries, enabling Chat AI to answer questions about recent slow queries
- Backend GET /api/chat/greeting endpoint calling getAgentGreeting() from agent-service.ts, with frontend fetch-and-display in chat welcome section using toSanitizedMarkdownHtml
- One-liner:
- One-liner:
- One-liner:
- One-liner:
- Fix 4 verification gaps in Oracle support: ASH parameter name, null crash, DBA table space fallback, V$SYSSTAT statistic name
- Remove oracledb module-level property assignments causing TypeError in Thin mode v6+; pass fetchAs config via createPool() options; drop sslOptions (handled by Thin mode TCPS)
- One-liner:
- Files modified:
- File modified:

---

## v1.1 RBAC + SQL Console + Dashboard (Shipped: 2026-05-13)

**Phases completed:** 5 phases, 17 plans, 34 tasks

**Key accomplishments:**

- All 139 route registrations updated with requirePermission middleware, old requireRole deleted, and auth-database-service role ENUM removed
- Three critical gaps (CR-01, CR-02, CR-03) and one warning (WR-03) closed — verifyToken decorated, dropped column references removed, wildcard check added, collector permissions seeded
- RBAC admin management page with 4 sub-tab views (roles, permissions, user-role binding, instance permissions), navigation tab registration, i18n labels, and LitElement components for full CRUD operations
- Fixed admin check (replaced JWT role claim probe with RBAC API call), added multi-role badges per user with click navigation to RBAC page, and added instance permission modal with live instance checkboxes and diff-based grant/revoke
- Vitest configuration, @open-wc/testing devDependencies, and failing test stubs for all 7 SQL Console Upgrade requirements (SQLC-01 through SQLC-07)
- Multi-tab editor with independent EditorView instances, localStorage persistence, inline rename, unsaved-SQL confirmation dialog, 10-tab soft cap warning, and schema-driven context-aware autocomplete
- Enhanced result table with sortable column headers (asc/desc/none cycling), client-side pagination with 25/50/100/All page size presets and prev/next navigation, and CSV export using Blob download with RFC 4180 escaping and UTF-8 BOM.
- Added a searchable, paginated query history panel in the SQL console left sidebar, backed by a new GET /api/database/instances/:id/query-history endpoint that queries the existing audit log for sql_execution events, with sidebar toggle between Schema browser and History views, infinite scroll loading, and click-to-load-SQL into the active editor tab.
- EXPLAIN visualization with collapsible tree view, flat sortable table view, view toggle between "树形"/"表格", efficiency grade summary bar, and "分析计划" button in the SQL console toolbar.
- approval_events table, event CRUD methods, execute_after_approve parameter, and batchReview with per-item isolation
- buildApprovalMessage in notification-service + batch-review, modified review, events endpoint, and enriched GET /:id in server.ts, all with fire-and-forget notifications and notified events
- Restructured approval-dashboard.ts from flat pending/processed list into sub-view switching component with checkbox multi-select, batch action bar, execute-after-approve toggle, unified batch confirmation dialog, and execution result display in processed tab.
- Implemented full approval detail sub-view with CodeMirror 6 read-only SQL editor (dialect from db_type), metadata card showing instance name from enriched API, and color-coded event history timeline.
- Backend dashboard aggregation endpoints for capacity trend (capacity_history) and AI analysis count (ai_analysis) with integration test stubs
- CSS Variable Adoption (D-24):

---

## v1.0 Slide 数据库运维平台 MVP (Shipped: 2026-05-09)

**Phases completed:** 21 phases, 58 plans, 62 tasks

**Key accomplishments:**

- 执行日期
- 执行日期
- 执行日期
- 执行日期
- 执行日期
- 执行日期
- 实现告警通知推送闭环：NotificationService 每 10 秒轮询 alerts 表，匹配通知渠道，格式化为钉钉/企微/飞书/通用 webhook 格式并发送，记录发送结果。
- One-liner:
- One-liner:
- One-liner:
- One-liner:
- One-liner:
- One-liner:
- One-liner:
- One-liner:
- 状态
- 列表
- 状态
- Status:
- One-liner:
- One-liner:
- One-liner:
- One-liner:
- One-liner:
- 执行日期
- 执行日期
- 执行日期
- 执行日期
- 1. [Rule 2 - Critical] Deep copy editingMetric to prevent mutation
- 执行日期
- 执行日期
- One-liner:
- Objective:
- One-liner:
- One-liner:
- Status:
- One-liner:
- One-liner:
- One-liner
- Log analysis UI with level/time filtering, stats dashboard, multi-select AI analysis trigger, and instance detail tab integration

---
