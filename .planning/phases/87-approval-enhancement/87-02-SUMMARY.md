---
phase: 87-approval-enhancement
plan: 02
subsystem: api
tags: notification, approval, batch-review, events, timeline, enrichment

# Dependency graph
requires:
  - phase: 87-01
    provides: ApprovalService.writeEvent, getApprovalEvents, batchReview, reviewRequest with execute_after_approve
provides:
  - NotificationService.buildApprovalMessage() for dingtalk/wecom/feishu/webhook channel formats
  - POST /api/approval/batch-review with input validation and per-item fire-and-forget notifications
  - Modified POST /api/approval/:id/review with execute_after_approve param (default true)
  - Enriched GET /api/approval/:id with instance_name and db_type
  - GET /api/approval/:id/events for timeline data
  - 'notified' events written to approval_events after notification sends (D-02 compliance)
  - Instance name resolution via instanceDatabaseService.getInstanceById for notifications (D-13 compliance)
affects:
  - 87-03 (timeline UI, batch approval UI)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Fire-and-forget notification pattern in review handlers with .catch() error swallowing
    - Instance name resolution before notification formatting (D-13 pattern)
    - 'notified' event write after notification send for timeline completeness (D-02 pattern)

key-files:
  created: []
  modified:
    - apps/db-ops-api/src/notification-service.ts
    - apps/db-ops-api/server.ts
    - apps/db-ops-api/tests/notification-service.test.ts

key-decisions:
  - "buildApprovalMessage follows exact same per-channel format pattern as existing buildMessage and buildEscalationMessage"
  - "DingTalk uses markdown with title/text, WeCom uses markdown with content, Feishu uses interactive card, webhook uses plain JSON with type:'approval' discriminator"
  - "Notification is fire-and-forget with .catch() — failures logged but do not block review response"
  - "Instance name resolution added to both review handlers plus GET /:id enrichment, kept as separate read-only lookups"

requirements-completed: [APPR-03, APPR-04, APPR-06]

# Metrics
duration: 6min
completed: 2026-05-11
---

# Phase 87 Plan 02: Notification Integration and API Wiring Summary

**buildApprovalMessage in notification-service + batch-review, modified review, events endpoint, and enriched GET /:id in server.ts, all with fire-and-forget notifications and notified events**

## Performance

- **Duration:** 6 min
- **Started:** 2026-05-11T14:56:00Z
- **Completed:** 2026-05-11T15:02:00Z
- **Tasks:** 2
- **Files modified:** 3 (1 test file with additions)

## Accomplishments

- Added `NotificationService.buildApprovalMessage()` with dingtalk/wecom/feishu/webhook channel-specific message formats, following existing per-channel patterns from `buildMessage()` and `buildEscalationMessage()`
- Added `POST /api/approval/batch-review` endpoint with:
  - Input validation: `ids` must be non-empty positive integer array, `action` must be approve/reject
  - Per-item notification via fire-and-forget with instance name resolution (D-13)
  - 'notified' event write to approval_events after each notification send (D-02)
- Modified `POST /api/approval/:id/review` to:
  - Accept `execute_after_approve` boolean parameter (default true)
  - Fire fire-and-forget notifications via existing enabled channels with instance name resolution
  - Write 'notified' event to approval_events after notification sends
- Added `GET /api/approval/:id/events` returning ordered approval_events for timeline display
- Enriched `GET /api/approval/:id` with `instance_name` and `db_type` resolved from instanceDatabaseService.getInstanceById (per D-03)
- Both review handlers use `requirePermission('approval:approve')` middleware; enrichment/events use `requirePermission('approval:view')` (per T-87-05)
- Notification payload limits SQL summary to first 100 characters (per T-87-06)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add buildApprovalMessage to NotificationService (TDD)** - `ea3df7652c` (test/RED) -> `d59f83cf2f` (feat/GREEN)
2. **Task 2: Add/Modify server.ts routes** - `87bfa749c5` (feat)

## Files Created/Modified

- `apps/db-ops-api/src/notification-service.ts` - Added buildApprovalMessage method (95 lines) with dingtalk/wecom/feishu/webhook channel formats
- `apps/db-ops-api/server.ts` - Added batch-review endpoint (49 lines), modified review handler (47 lines -> 96 lines), enriched GET /:id handler, added GET /:id/events endpoint
- `apps/db-ops-api/tests/notification-service.test.ts` - Added 6 tests covering all channel formats and metadata inclusion

## Decisions Made

- `buildApprovalMessage` exposes a public method signature different from `buildMessage` (which takes PendingAlert) — it takes a custom `approvalData` object since approval notifications have different fields than alert notifications
- Notification send is fire-and-forget with `.catch()` — notification failures do not block the review response, maintaining low-latency UX
- SQL summary truncated to 100 chars in all notification channels (consistent with T-87-06 mitigation)
- Feishu approve uses green template, reject uses red template
- webhook channel returns plain JSON with `type: 'approval'` discriminator for downstream routing

## Deviations from Plan

None - plan executed exactly as written.

## TDD Gate Compliance

- RED gate: `ea3df7652c` — test commit with 6 failing tests (all `TypeError: buildApprovalMessage is not a function`)
- GREEN gate: `d59f83cf2f` — implementation commit with 6 passing tests (25 total)
- REFACTOR gate: Not needed (code clean, no refactor commit)

## Threat Surface Scan

No new threat flags. All new endpoints use existing `requirePermission` middleware pattern. Notification payloads limit SQL exposure to first 100 characters. No new database connections or file access patterns introduced.

## Self-Check: PASSED

- Created files: notification-service.ts, server.ts, notification-service.test.ts -- all found
- Commits: ea3df7652c (RED), d59f83cf2f (GREEN), 87bfa749c5 (Task 2) -- all verified in git log
- Tests: 45/45 passing

---
*Phase: 87-approval-enhancement*
*Completed: 2026-05-11*
