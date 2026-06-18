---
phase: 120-ui
plan: 07
type: execute
subsystem: frontend
tags: [component-adoption, shared-components, app-dialog, app-form-field, app-card, app-badge, app-empty-state, showToast]
requires: [120-06]
provides: []
affects: [12 view files]
tech-stack:
  added: [showToast from app-toast-container]
  patterns: [shared Lit components replacing hand-rolled CSS patterns]
key-files:
  created: []
  modified:
    - frontend/src/app/ui/views/sql-console.ts
    - frontend/src/app/ui/views/metric-registry.ts
    - frontend/src/app/ui/views/cron-jobs-settings.ts
    - frontend/src/app/ui/views/approval-dashboard.ts
    - frontend/src/app/ui/views/metric-templates.ts
    - frontend/src/app/ui/views/reports.ts
    - frontend/src/app/ui/views/users-management.ts
    - frontend/src/app/ui/views/instances-db.ts
    - frontend/src/app/ui/views/dashboard.ts
    - frontend/src/app/ui/views/ai-settings.ts
    - frontend/src/app/ui/views/schema-management.ts
decisions:
  - "Skipped cron-jobs div-table -> app-data-table: table has complex action buttons/toggles/badges not supported by simple app-data-table component"
  - "Skipped approval-dashboard card -> app-card: card has complex selection state (.card.selected, .card-row) not fitting simple app-card component"
metrics:
  duration: ~15 min
  completed_date: "2026-06-18"
  tasks_total: 2
  tasks_completed: 2
  files_modified: 11
---

# Phase 120 Plan 07: Component Adoption in 12 Views Summary

Adopt shared components across all remaining views. Replace hand-rolled dialog/modals, forms, cards, tables, toasts, and badges with new shared components.

## What Was Done

### Task 1: Replace dialog/modal overlays + forms (8 views)

Replaced all `.dialog-overlay` / `.modal-overlay` CSS patterns with `<app-dialog>` component:

| View | Dialogs Replaced |
|------|-----------------|
| sql-console.ts | Tab confirm modal |
| metric-registry.ts | Delete confirm + create/edit modal |
| cron-jobs-settings.ts | Log viewer, form editor, delete confirm, trigger dialog |
| approval-dashboard.ts | Batch review dialog |
| metric-templates.ts | Template CRUD, rule creation, instance link modals |
| reports.ts | Removed unused `.modal-overlay` CSS |
| users-management.ts | Create/edit user + password reset modals |
| instances-db.ts | Add/edit form, delete confirm, test connection dialogs |

In `instances-db.ts`, also wrapped form fields in `<app-form-field>` for standardized label/error rendering.

### Task 2: Replace card CSS, toast, badge, empty state (9 views)

| Pattern | Views Changed |
|---------|--------------|
| `.card`/`.status-card` CSS -> `<app-card>` | dashboard, ai-settings, reports, users-management, schema-management |
| Custom toast -> `showToast()` | cron-jobs-settings, metric-templates |
| `.status-badge` CSS -> `<app-badge>` | dashboard, users-management, reports, instances-db |
| "暂无数据" -> `<app-empty-state>` | reports, users-management, dashboard, schema-management |

All replaced CSS class declarations removed from `static styles`.

## Deviations from Plan

### Skipped

**1. cron-jobs-settings.ts div-table -> `<app-data-table>`**
- **Reason:** The cron jobs table has complex cell rendering (action buttons, toggle switches, badges, click handlers) that is not supported by the simple `<app-data-table>` component, which only renders text via `row[col.key]`. The plan's IMPORTANT note allows skipping when "complex rendering that doesn't fit the shared component."

**2. approval-dashboard.ts `.card` -> `<app-card>`**
- **Reason:** The approval card has complex internal state (`.card.selected`, `.card-row`, `.card-checkbox`) that maps poorly to the simple `<app-card>` structure.

### Auto-fixed Issues

None - plan executed without auto-fix triggers.

## Verification

TypeScript compilation: **PASSED** (`npx tsc --noEmit` returns 0 errors)

| Check | Result |
|-------|--------|
| No `.dialog-overlay` / `.modal-overlay` in modified views | All 8 views: 0 |
| No `.card` CSS in modified views | All 5 card views: 0 |
| No custom toast in cron-jobs/metric-templates | showToast() used instead |
| No `.status-badge` CSS classes in dashboard, users-management, reports, instances-db | All replaced with `<app-badge>` |
| `<app-dialog>` used in views | 7 views with active dialogs |
| `<app-form-field>` used in instances-db | 27 occurrences |
| `<app-empty-state>` used in views | reports(3), dashboard(3), schema-management(2), users-management(1) |

## Commits

| Task | Hash | Message |
|------|------|---------|
| 1 | 43c429f | feat(120-07): replace dialog/modal overlays with app-dialog + app-form-field in 8 views |
| 2 | 606f599 | feat(120-07): replace card CSS, toast, badge, empty state patterns in 9 views |

## Duration

~15 minutes (wave 5 of 6)

## Self-Check: PASSED
