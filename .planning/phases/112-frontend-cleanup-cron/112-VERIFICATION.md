---
phase: 112-frontend-cleanup-cron
verified: 2026-05-27T13:00:00Z
status: human_needed
score: 28/28 must-haves verified
overrides_applied: 0
gaps: []
deferred: []
human_verification:
  - test: "Open Settings page, verify 'Cron Jobs' tab appears in the settings group alongside AI Settings, LLM Config, Scoring Settings"
    expected: "A 'Cron Jobs' tab with the loader icon is visible in the settings navigation"
    why_human: "Visual verification required — navigation rendering depends on permission checks and state"
  - test: "Verify toggle switch enables/disables a cron job with visual feedback"
    expected: "Toggle changes state immediately (optimistic), persists on API success, reverts on error"
    why_human: "Visual feedback (toast, toggle position) requires browser rendering"
  - test: "Verify inline cron expression editor with template dropdown and next-5-run preview"
    expected: "Double-clicking expression opens edit; presets populate input; preview shows 5 dates"
    why_human: "Visual interaction timing and preview rendering"
  - test: "Start the backend server and verify CronManager startup log"
    expected: "Server logs 'CronManager: N jobs scheduled' at startup"
    why_human: "Requires running the backend server (not available in verification context)"
  - test: "E2E: Fetch jobs, toggle, trigger, and view logs through the full flow"
    expected: "Full CRUD cycle works end-to-end with live MySQL database"
    why_human: "Requires running backend with seeded MySQL database"
re_verification:
  previous_status: gaps_found
  previous_score: 26/28
  gaps_closed:
    - "Post-trigger, frontend polls GET /api/cron/jobs/:id/logs?limit=1 every 3 seconds for up to 30 seconds"
    - "Logs button expands a sub-row showing last 20 execution logs with started_at, finished_at, duration, status, result, error"
  gaps_remaining: []
  regressions: []
---

# Phase 112: Frontend Cleanup & Cron Verification Report

**Phase Goal:** Frontend cleanup (rename openclaw->app, delete dead views) + Configurable CronJobs (DB-driven scheduler replacing hardcoded CronJobs)
**Verified:** 2026-05-27T13:00:00Z
**Status:** human_needed
**Re-verification:** Yes — after gap closure

## Summary

Phase 112 covered three plans. **Plan 01 (frontend cleanup)** and **Plan 02 (backend cron infrastructure)** pass all must-haves unchanged. **Plan 03 (frontend cron UI)** now also passes all must-haves after fixes.

**Previous gaps (2) — both now CLOSED:**

The 2 gaps from the previous verification were caused by a data contract mismatch (CR-01): the backend `GET /api/cron/jobs/:id/logs` returns `{ logs: CronJobLog[], total: number }` but the frontend at two call sites treated the response as a bare array. This prevented the post-trigger polling from detecting completion and caused the log viewer to crash.

**Fix applied in `cron-jobs-settings.ts`:**
- Line 409 (`pollJobStatus`): changed from `const logs: CronJobLog[] = await res.json()` to `const { logs } = await res.json() as { logs: CronJobLog[] }`
- Line 436 (`loadLogs`): changed from `const logs: CronJobLog[] = await res.json()` to `const { logs } = await res.json() as { logs: CronJobLog[] }`

Both call sites now correctly destructure the `logs` array from the response object. The polling loop properly detects completion via `logs.length > 0 && logs[0].status !== "running"`. The log sub-row correctly spreads the array via `[...existing, ...logs]`.

## ROADMAP Success Criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | 前端不再引用任何已删除的 Gateway view/controller | ✓ VERIFIED | All 24+ placeholder views deleted from views/. grep shows zero imports from deleted views. |
| 2 | WebSocket 连接路径全部使用 DirectAdapter，无旧 Gateway 路径残留 | ✓ VERIFIED | app.ts and app-lifecycle.ts import initChatClient from direct-gateway.ts, not deleted app-gateway.ts. |
| 3 | 定时任务从 server.ts 硬编码迁移到数据库配置模型 | ✓ VERIFIED | 13 hardcoded CronJob blocks removed. CronManager.start() reads enabled jobs from cron_jobs table. Zero hardcoded scheduling in server.ts (only 3 expression-validation CronJob calls remain). |
| 4 | 每个定时任务支持 enabled / interval / timezone 配置 | ✓ VERIFIED | cron_jobs table has enabled, cron_expr, timezone columns. All 13 seed records have these fields. PUT/POST toggle/toggle endpoints allow configuration changes. |
| 5 | 前端提供定时任务管理页面（列表、启停、查看日志） | ✓ VERIFIED | cron-jobs-settings.ts LitElement (632 lines) with list, toggle, trigger, log viewer. Post-trigger polling and log sub-row both fixed — data contract mismatch resolved. |

## Observable Truths

### Plan 01: Frontend Cleanup

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | frontend/src/openclaw/ no longer exists — renamed to app/ | ✓ VERIFIED | `test ! -d frontend/src/openclaw/`. `test -d frontend/src/app/`. |
| 2 | frontend/src/main.ts imports from ./app/ not ./openclaw/ | ✓ VERIFIED | main.ts lines 11,18: `import './app/styles.css'`, `import './app/ui/app.js'`. Zero `openclaw` imports. |
| 3 | protocol/ directory does not exist anywhere under frontend/src/ | ✓ VERIFIED | `frontend/src/app/protocol/` does not exist. The `src/protocol/` under `app/src/` is an internal schema directory (not the old Gateway protocol). |
| 4 | app-gateway.ts does not exist anywhere under frontend/src/ | ✓ VERIFIED | `find` returns no results for app-gateway.ts. |
| 5 | No placeholder view files for cron/skills/usage/config/overview/exec-approval under views/ | ✓ VERIFIED | None of these files exist in `frontend/src/app/ui/views/`. |
| 6 | No unavailable-page.ts exists under frontend/src/ | ✓ VERIFIED | `find` returns no results. |
| 7 | navigation.ts no longer lists dead tabs in TAB_GROUPS or TAB_PATHS | ✓ VERIFIED | TAB_GROUPS has no overview/usage/cron/skills/config. Tab type union has no dead tabs. |
| 8 | app-render.ts no longer renders placeholder sections for deleted tabs | ✓ VERIFIED | No placeholder renders for deleted tabs. Only `config` tab renders `nothing` (documented in Summary as harmless dead code). |
| 9 | app.ts and app-lifecycle.ts import initChatClient from direct-gateway.ts | ✓ VERIFIED | app.ts:10 imports from `./direct-gateway.ts`. app-lifecycle.ts:1 imports from `./direct-gateway.ts`. direct-gateway.ts exports initChatClient. |
| 10 | @openclaw/protocol alias removed; @openclaw aliases updated to @slide/app | ✓ VERIFIED | vite.config.js has `@slide/app/src` and `@slide/app/ui` aliases. Zero `@openclaw` aliases. |
| 11 | All 13 i18n locale files have dead Gateway/navigation keys removed | ✓ VERIFIED | Zero matches for tabs.overview, tabs.usage, tabs.cron, tabs.skills, tabs.config in any locale file. |

### Plan 02: Backend Cron Infrastructure

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Migration 009 creates cron_jobs, cron_job_logs, cron_job_params tables | ✓ VERIFIED | File creates 3 tables with all D-13 schema fields. Verified: 3 CREATE TABLE statements in migration SQL. |
| 2 | 13 seed records match existing 13 hardcoded CronJobs' names, cron expressions, timezones | ✓ VERIFIED | Single INSERT with 13 value rows. Handlers: topsqlAnalysis, rcaAnalysis, faultDiagnosis, capacityCollection, schemaCollection, indexCollection, baselineCalculation, baselineCleanup, logCollection, silenceCleanup, reportScheduling, escalationMonitoring, notificationCheck. |
| 3 | CronManager on startup reads enabled jobs from DB | ✓ VERIFIED | cron-manager.ts start() -> reload() -> jobService.getEnabledJobs(). |
| 4 | Each enabled job executes its handler function | ✓ VERIFIED | scheduleJob creates CronJob with callback -> executeJob -> getHandler(config.handler) -> handler(). |
| 5 | cron_job_logs records for each execution | ✓ VERIFIED | startLog() called before execution, completeLog() after. |
| 6 | server.ts no longer has 13 individual new CronJob() calls | ✓ VERIFIED | Only 3 CronJob calls remain, all for expression validation (report config preview, PUT validation, preview endpoint). |
| 7 | Permission codes cron:view and cron:manage exist and assigned | ✓ VERIFIED | Migration seeds both codes, assigns cron:view+cron:manage to dba role. Admin already has * wildcard. |
| 8 | PUT/POST toggle/run, GET logs endpoints exist | ✓ VERIFIED | 7 endpoints registered (list, get, update, toggle, run, preview, logs) all with preHandler permission checks. |

### Plan 03: Frontend Cron UI

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Settings shows '定时任务' tab with loader icon alongside AI/LLM/Scoring | ✓ VERIFIED | navigation.ts TAB_GROUPS settings includes `cron-jobs`. iconForTab returns `loader`. |
| 2 | Job list table with Status, Name, Description, Cron Expression, Next Run, Last Run, Last Result, Actions | ✓ VERIFIED | cron-jobs-settings.ts renders `<table class="table">` with all columns. |
| 3 | Toggle switch enables/disables with optimistic UI update | ✓ VERIFIED | toggleJob() calls authFetch PATCH, reverts on error. "optimistic" in comments. showToast on success/failure. |
| 4 | Double-click cron expression opens inline edit with input, save/cancel, next-5 preview | ✓ VERIFIED | `@dblclick=${() => this.startEdit(job)}`. editValue state, fetchPreview, save/cancel buttons. |
| 5 | Common template dropdown populates expression input | ✓ VERIFIED | 5 presets defined (every-min, every-5min, every-hour, every-day, every-day-8am). applyPreset() sets editValue. |
| 6 | Trigger Now shows confirmation dialog before POST | ✓ VERIFIED | triggerDialogOpen state, dialog overlay CSS, confirm/cancel buttons, POST via authFetch. |
| 7 | Post-trigger polls every 3s for up to 30s | ✓ VERIFIED | pollJobStatus() with setInterval 3s, max 10 attempts. `const { logs } = await res.json()` now correctly destructures logs array. `logs.length > 0 && logs[0].status !== "running"` correctly detects completion. On completion: clears interval, refreshes job list. |
| 8 | Log sub-row shows last 20 execution logs | ✓ VERIFIED | toggleLogExpanded() with loadLogs(). `const { logs } = await res.json()` now correctly destructures logs array. `[...existing, ...logs]` correctly merges arrays. Pagination with offset: limit=20, offset tracking per job. Table renders started_at, finished_at, duration, status, result, error columns. |
| 9 | All error states handled | ✓ VERIFIED | error, loading, previewError, triggerError states. Toast for success/error. Error CSS classes. |

**Score:** 28/28 truths verified (0 failed)

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `frontend/src/main.ts` | Imports from `./app/` | ✓ VERIFIED | Lines 11,18 import from `./app/` |
| `frontend/vite.config.js` | @slide/app aliases, no @openclaw/protocol | ✓ VERIFIED | Lines 19-20: `@slide/app/src`, `@slide/app/ui` |
| `frontend/src/app/ui/navigation.ts` | TAB_GROUPS no dead tabs, cron-jobs in settings | ✓ VERIFIED | Clean groups, cron-jobs with loader icon |
| `frontend/src/app/ui/app-render.ts` | No dead renders, imports cron-jobs-settings | ✓ VERIFIED | Lines 25, 714-715 |
| `frontend/src/app/ui/views/cron-jobs-settings.ts` | LitElement with full cron management UI | ✓ VERIFIED | 632 lines, customElement, all features, both data contract fixes applied |
| `apps/db-ops-api/sql/migrations/009_add_cron_jobs_tables.sql` | 3 tables + 13 seeds + permissions | ✓ VERIFIED | Migration file exists |
| `apps/db-ops-api/run-migration-009.ts` | Migration runner | ✓ VERIFIED | Runner file exists |
| `apps/db-ops-api/src/cron/types.ts` | Shared types | ✓ VERIFIED | File exists |
| `apps/db-ops-api/src/cron/cron-job-service.ts` | Full CRUD class | ✓ VERIFIED | Class CronJobDatabaseService with 11 methods |
| `apps/db-ops-api/src/cron/cron-job-handlers.ts` | Handler dispatch table | ✓ VERIFIED | 13 handlers, getHandler, handlerNames exports |
| `apps/db-ops-api/src/cron/cron-manager.ts` | Scheduler lifecycle | ✓ VERIFIED | Class CronManager with start/stop/reload |
| `apps/db-ops-api/server.ts` | CronManager init + API routes, no 13 CronJob blocks | ✓ VERIFIED | CronManager.start() at line 3661, 7 cron API routes |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| cron-jobs-settings.ts:pollJobStatus | logs (line 409) | GET /api/cron/jobs/:id/logs | Destructures `{ logs }` from response — correctly extracts array | ✓ FLOWING |
| cron-jobs-settings.ts:loadLogs | logs (line 436) | GET /api/cron/jobs/:id/logs | Destructures `{ logs }` from response — correctly extracts array | ✓ FLOWING |
| cron-manager.ts:executeJob | config (line 113) | cron_jobs table | DB-driven via cronJobService | ✓ FLOWING |
| cron-job-service.ts:getJobs | rows | SELECT * FROM cron_jobs | Real DB query | ✓ FLOWING |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | --- | --- | ------ | ------- |
| main.ts | app/styles.css + app/ui/app.js | import ./app/ | ✓ WIRED | Lines 11,18 |
| app.ts | direct-gateway.ts | import { initChatClient } | ✓ WIRED | Line 10 |
| app-lifecycle.ts | direct-gateway.ts | import { initChatClient } | ✓ WIRED | Line 1 |
| server.ts | CronManager | new CronManager() + await cronManager.start() | ✓ WIRED | Lines 3660-3661 |
| CronManager | CronJobDatabaseService | this.jobService.getEnabledJobs() | ✓ WIRED | cron-manager.ts line 53 |
| CronManager | cron-job-handlers.ts | getHandler(config.handler) | ✓ WIRED | cron-manager.ts line 130 |
| server.ts routes | CronJobDatabaseService | GET/PUT/POST /api/cron/jobs/* | ✓ WIRED | Lines 3680-3838 |
| cron-jobs-settings.ts | /api/cron/jobs | authFetch() | ✓ WIRED | Lines 246,268,303,329,381,407,434 |
| cron-jobs-settings.ts | /api/cron/jobs/:id/logs | authFetch() GET | ✓ WIRED | Lines 407,434 — destructure `{ logs }` correctly, data flows properly |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Frontend build | `npm run build` | Build succeeds (2.06s) | ✓ PASS |
| Remaining @openclaw references | `grep -rn "@openclaw" frontend/src/ --include="*.ts"` | 0 non-comment references | ✓ PASS |
| Backend imports valid | Check server.ts imports | CronManager, CronJobDatabaseService resolve | ✓ PASS |
| 13 handler functions | grep handlerNames in cron-job-handlers.ts | 13 handlers mapped | ✓ PASS |
| Data contract fix: pollJobStatus | Line 409 destructures `{ logs }` | `const { logs } = await res.json() as { logs: CronJobLog[] }` | ✓ PASS |
| Data contract fix: loadLogs | Line 436 destructures `{ logs }` | `const { logs } = await res.json() as { logs: CronJobLog[] }` | ✓ PASS |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| apps/db-ops-api/run-migration-009.ts | 20 | Hardcoded production password fallback | ⚠️ WARNING | Security risk (CR-03 from review) |
| apps/db-ops-api/run-migration-009.ts | 42 | SQL injection via template literal in verification query | ⚠️ WARNING | Security risk (CR-04 from review) |
| apps/db-ops-api/server.ts | 3778 | Manual trigger bypasses CronManager concurrency guard | ⚠️ WARNING | Two manual triggers of same job can overlap (CR-05 from review) |
| apps/db-ops-api/src/cron/cron-job-handlers.ts | 37 | Unbounded memory growth in rcaProcessedAlerts Set | ⚠️ WARNING | Memory leak (CR-02 from review) |
| apps/db-ops-api/src/cron/cron-manager.ts | 56 | Dead code: `let validJobs = enabledJobs` immediately overwritten | ℹ️ INFO | Harmless (WR-01 from review) |
| apps/db-ops-api/src/cron/cron-manager.ts | 113 | Missing timeout enforcement per config.timeout_seconds | ⚠️ WARNING | Hanging handler permanently blocks job (WR-02) |

**Two BLOCKER-level anti-patterns from previous verification (lines 409, 436) now RESOLVED.** Both data contract mismatches have been corrected with proper destructuring.

### Requirements Coverage

All three plans have `requirements: []` in frontmatter. No requirement IDs are mapped to this phase in REQUIREMENTS.md. No orphaned requirements found.

### Human Verification Required

1. **Cron Jobs tab rendering in Settings**
   - **Test:** Open browser to frontend Settings page when logged in with a user that has `cron:view` permission
   - **Expected:** "Cron Jobs" tab visible in Settings sidebar with loader icon alongside AI Settings, LLM Config, Scoring Settings
   - **Why human:** Navigation rendering depends on permission state and routing logic

2. **Toggle switch visual behavior**
   - **Test:** Click toggle on a cron job (e.g., capacityCollection)
   - **Expected:** Toggle state changes immediately, reverts if API fails
   - **Why human:** Optimistic UI update + toast feedback is visual

3. **Inline cron expression editor**
   - **Test:** Double-click a cron expression cell, edit, select preset, see preview
   - **Expected:** Inline editor with presets and next-5-run preview appears
   - **Why human:** Visual interaction timing and preview rendering

4. **CronManager backend startup**
   - **Test:** Run migration then start server
   - **Expected:** Log shows "CronManager: N jobs scheduled"
   - **Why human:** Requires running backend server

5. **Full E2E flow**
   - **Test:** List jobs, toggle, trigger, view logs
   - **Expected:** Full CRUD cycle with live MySQL
   - **Why human:** Requires running backend with seeded database

### Gaps Summary

**No gaps remaining.** Both previously identified gaps from CR-01 (data contract mismatch) have been resolved:

1. **Post-trigger polling (✓ FIXED)** — `pollJobStatus()` at line 409 now correctly destructures `const { logs }` from the API response. `logs.length` correctly returns array length, so the completion check `logs.length > 0 && logs[0].status !== "running"` works as intended. Polling detects execution completion, clears the interval, and refreshes the job list.

2. **Log sub-row viewer (✓ FIXED)** — `loadLogs()` at line 436 now correctly destructures `const { logs }` from the API response. `[...existing, ...logs]` correctly merges arrays. The log table renders properly with started_at, finished_at, duration, status, result, and error columns. Pagination via offset tracking works.

**Both fixes:** Changed `const logs: CronJobLog[] = await res.json()` to `const { logs } = await res.json() as { logs: CronJobLog[] }` at lines 409 and 436 of `cron-jobs-settings.ts`. No backend changes needed — the backend `{ logs, total }` response shape was correct.

---

_Verified: 2026-05-27T13:00:00Z_
_Verifier: Claude (gsd-verifier)_
