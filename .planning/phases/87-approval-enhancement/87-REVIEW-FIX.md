---
phase: 87-approval-enhancement
fixed_at: 2026-05-11T10:40:00Z
review_path: .planning/phases/87-approval-enhancement/87-REVIEW.md
iteration: 1
findings_in_scope: 6
fixed: 6
skipped: 0
status: all_fixed
---

# Phase 87: Code Review Fix Report

**Fixed at:** 2026-05-11T10:40:00Z
**Source review:** .planning/phases/87-approval-enhancement/87-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 6 (1 critical, 5 warnings)
- Fixed: 6
- Skipped: 0

## Fixed Issues

### CR-01: SSRF Bypass via Incomplete Webhook URL Validation

**Files modified:** `apps/db-ops-api/src/notification-service.ts`
**Commit:** 5fdd734190
**Applied fix:** Rewrote `validateWebhookUrl` as async with DNS resolution (via `dns.promises.resolve4`) and numeric IP expansion (`_expandNumericIp`) covering decimal (2130706433), hex (0x7f000001), and short-form (127.1) representations. Added `_isReservedIp` helper that strips IPv6-mapped IPv4 prefixes and checks all private/reserved ranges. Added `net` and `dns` imports. Updated caller to `await` the async method.

### WR-01: SQL Injection Vector via Template Literal in `getProcessedRequests`

**Files modified:** `apps/db-ops-api/src/approval-service.ts`
**Commit:** db7b6be8b1
**Applied fix:** Replaced template literal interpolation (`LIMIT ${safeLimit}`) with parameterized query using mysql2 `?` placeholder (`LIMIT ?`, `[safeLimit]`). Consistent with the rest of the file which uses `pool.execute()` with `?` placeholders.

### WR-02: NaN Propagation from Invalid `limit` Query Parameter

**Files modified:** `apps/db-ops-api/server.ts`
**Commit:** 5e757554cd
**Applied fix:** Added intermediate `rawLimit` variable from `parseInt` with `Number.isFinite` guard before `Math.min`. When `parseInt` returns NaN (e.g., `?limit=abc`), the fallback is 50. Fix applied across both `/api/approval/history` and `/api/database/instances/:id/query-history` routes.

### WR-03: Unhandled `JSON.parse` Exception in `_renderExecResult`

**Files modified:** `frontend/src/openclaw/ui/views/approval-dashboard.ts`
**Commit:** 590c107dc7
**Applied fix:** Wrapped `JSON.parse` in a try/catch with fallback `{ error: '无法解析执行结果' }`. Prevents uncaught exception from crashing the entire Lit render when `execution_result` contains invalid JSON.

### WR-04: Status Updated to "approved" Before SQL Execution Completes

**Files modified:** `apps/db-ops-api/src/approval-service.ts`
**Commit:** c77f7a1c44
**Applied fix:** Restructured `reviewRequest` approval flow. When `execute_after_approve` is enabled, SQL execution now happens first, then the status is set to `'executed'` (success) or `'approved'` (failure) in a single UPDATE with `reviewed_by`, `review_notes`, and `execution_result`. The non-execution path remains unchanged. This eliminates the window where status was `'approved'` before SQL had run.

### WR-05: Empty Catch Block Swallows JSON Parse Errors with Misleading Comment

**Files modified:** `apps/db-ops-api/src/approval-service.ts`
**Commit:** 2d27ef797a
**Applied fix:** Separated `JSON.parse` from the LLM call into its own inner try/catch with a descriptive warning log. The outer catch now logs the actual error via `console.warn('LLM 不可用，降级为模式匹配风险判断:', err)` instead of silently swallowing everything.

---

_Fixed: 2026-05-11T10:40:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
