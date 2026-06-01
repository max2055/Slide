---
phase: 104-告警系统增强
plan: 03
subsystem: alerting
tags:
  - frontend
  - alert-rules
  - threshold-editor
  - toggle-switch
requires:
  - 104-01 (backend alert rule CRUD)
affects:
  - frontend/src/openclaw/ui/views/alerts.ts
tech-stack:
  added:
    - "N/A (LitElement, existing patterns)"
  patterns:
    - "Three-level threshold inputs with inline validation"
    - "Optimistic UI toggle with per-rule error feedback via state Map"
key-files:
  created: []
  modified:
    - frontend/src/openclaw/ui/views/alerts.ts
decisions: []
metrics:
  duration: ~15 min
  completed: "2026-05-21"
---

# Phase 104 Plan 03: Alert Rule UI Enhancements Summary

**One-liner:** Enhanced rule editor modal with three-level thresholds (warning/error/critical), threshold_type static/dynamic toggle, silence_minutes input, and inline enable/disable toggle switch with optimistic UI rollback.

## Completed Tasks

### Task 1: Three-level threshold inputs + threshold_type toggle + silence_minutes in rule editor

- Added `threshold_type` static/dynamic toggle buttons in the rule editor modal
- Added three independent threshold number inputs (warning/error/critical) shown only when threshold_type is static
- Added `_thresholdValidationError` state and `_validateThresholds()` method enforcing warning < error < critical
- Added `threshold_template` field to the `AlertRule` TypeScript interface
- Added `silence_minutes` number input (default 5) in the rule editor
- Updated `_openRuleModal()` default form values to include `threshold_type: 'static'` and `silence_minutes: 5`
- Updated `_saveRule()` body to include `threshold_type`, `threshold_template`, `silence_minutes` fields
- Set `threshold: 0` when `threshold_template` is set to avoid confusion with legacy single-threshold path
- Validation check blocks save if thresholds violate warning < error < critical
- Updated rule list threshold column to show three-level values (W: / E: / C:) or "dynamic" label

### Task 2: Inline enable/disable toggle switch in rule list

- Replaced status badge text with inline `cfg-toggle` checkbox switch per rule row
- Added `_toggleRuleEnabled()` method with optimistic UI update: flips immediately, rolls back on API failure
- Added `_ruleToggleErrors` state Map for per-rule error feedback visible for 3 seconds on failure
- Added "silence_minutes" column (`静默`) to the rule list table header and data rows
- Widened status column from 70px to 90px to accommodate toggle switch + text label
- `_closeRuleModal()` also resets `_thresholdValidationError`

### Task 3: Checkpoint (pending human verification)

- NOT YET VERIFIED. Awaiting human to start frontend + backend and visually verify:
  1. Three threshold inputs in rule editor
  2. Threshold validation (warning < error < critical)
  3. threshold_type toggle (dynamic hides manual inputs)
  4. silence_minutes input and display
  5. Inline toggle switch with optimistic update
  6. Data persistence through save and page reload

## Deviations from Plan

**None detected** - plan executed exactly as written.

**Note:** `icons['sliders']` not found in project's icon set; falls back gracefully to empty string (toggle button still renders with Chinese label text).

## Key Files

| File | Action | Lines |
|------|--------|-------|
| `frontend/src/openclaw/ui/views/alerts.ts` | Modified | 2941 (+167/-9) |

## Verification Results

- `threshold_type`, `threshold_template`, `silence_minutes` references: 34 (pass)
- `_toggleRuleEnabled`, `_ruleToggleErrors` references: 8 (pass)
- File length: 2941 lines (>= 2800 minimum)
- File contains `threshold_type`: confirmed
- TypeScript compilation: no new errors (pre-existing errors in other sections unaffected)

## Commit

```
d0738925372 feat(104-03): add three-level thresholds, toggle switch, and silence_minutes to alert rule UI
```
