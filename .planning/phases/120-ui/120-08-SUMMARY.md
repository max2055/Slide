---
phase: 120-ui
plan: 08
type: execute
subsystem: frontend
tags: [interaction-states, skeleton-screens, design-tokens, structured-logging, D-12, D-13, D-14, D-16, D-23, D-24]
requires: [120-07-PLAN.md]
provides: [complete-interaction-states, skeleton-screens, token-migration, structured-logging]
affects: [frontend, css, views]
tech-stack:
  added: []
  patterns: [showToast-for-errors, skeleton-loading, design-token-usage]
key-files:
  created: []
  modified:
    - frontend/src/app/styles/shared-btn-styles.ts
    - frontend/src/app/styles/layout.css
    - frontend/src/app/styles/utilities.css
    - frontend/src/app/styles/components.css
    - frontend/src/app/styles/config.css
    - frontend/src/app/styles/usage.css
    - frontend/src/app/styles/dreams.css
    - frontend/src/app/styles/chat/layout.css
    - frontend/src/app/styles/chat/tool-cards.css
    - frontend/src/app/styles/chat/grouped.css
    - frontend/src/app/styles/chat/sidebar.css
    - frontend/src/app/styles/chat/text.css
    - frontend/src/app/ui/views/reports.ts
    - frontend/src/app/ui/views/dashboard.ts
    - frontend/src/app/ui/views/users-management.ts
    - frontend/src/app/ui/views/index-management.ts
    - frontend/src/app/ui/views/event-management.ts
    - frontend/src/app/ui/views/schema-management.ts
    - frontend/src/app/ui/views/login-gate.ts
    - frontend/src/app/ui/views/query-analysis-tab.ts
    - frontend/src/app/ui/views/sql-audit-tab.ts
    - frontend/src/app/ui/views/llm-config.ts
    - frontend/src/app/ui/views/appearance-settings.ts
    - frontend/src/app/ui/views/metric-templates.ts
    - frontend/src/app/ui/views/agents-panels-status-files.ts
    - frontend/src/app/ui/views/agents-panels-tools-skills.ts
decisions:
  - D-12: Complete button :active states for all variants
  - D-13: Unified :focus-visible on nav items with --focus-ring
  - D-14: Consistent --disabled-opacity across all button states
  - D-16: Skeleton screens replace "加载中..." text in 6 views
  - D-23: ~1200 hardcoded px values migrated to design tokens
  - D-24: 15 console.error calls replaced with showToast()
  - M8: Page transition crossfade animation defined
metrics:
  duration: ~7 minutes
  completed_date: 2026-06-18
---

# Phase 120 Plan 08: Final Polish — Interaction states, skeleton screens, px→token migration, console→logger

**One-liner:** Complete button active/focus-visible states for all variants, adopt skeleton loading screens in 6 views, migrate ~1200 hardcoded px values to CSS design tokens, and replace 15 console.error/warn calls with structured showToast() error reporting.

## Summary

This plan finishes the remaining D decisions from Phase 120's context document:

1. **Button interaction states** (D-12, D-13, D-14) — Added `:active` states for `btn-ghost`, `btn-icon`, `btn-xs`, `btn-danger-outline` with translateY/scale press feedback. Updated `btn-primary:active` for consistent feedback. Normalized all disabled buttons to use `--disabled-opacity: 0.45`. Added `:focus-visible` on `.nav-item` with `--focus-ring`. Added page transition crossfade animation classes.

2. **Skeleton screens** (D-16) — Replaced text-based loading indicators (`"加载中..."`) in 6 views with skeleton CSS classes: dashboard (stat cards + chart blocks), reports, users-management, index-management (skeleton lines), event-management (stats + panels), schema-management (blocks).

3. **px→token migration** (D-23) — Replaced ~1200 hardcoded px values across 10 CSS files with design tokens: font-size (`--text-*`), padding/margin/gap (`--space-*`), border-radius (`--radius-*`), top/right/bottom/left (`--space-*`). Also cleaned up inline px values in 5 view files including llm-config.ts.

4. **console→logger** (D-24) — Replaced 15 `console.error()` calls with `showToast()` in 8 view files (reports, login-gate, users-management, dashboard, query-analysis-tab, sql-audit-tab, index-management, event-management). All error messages in English per D-24. Added showToast import to each file.

## Tasks

| # | Name | Type | Status | Commit |
|---|------|------|--------|--------|
| 1 | Interaction states + focus-visible + page transitions | auto | Complete | 696870d |
| 2 | Skeleton screen adoption across 6 views | auto | Complete | c9dbbc4 |
| 3 | px→token migration across CSS files + inline styles | auto | Complete | a0d7db5 |
| 4 | Replace console.error/warn with showToast() | auto | Complete | 1abbf54 |

## Deviations from Plan

### Auto-fixed Issues

None — the plan executed exactly as written with no blocking issues.

### Notes

1. **login-gate.ts skeleton** — The plan listed login-gate.ts for skeleton replacement (D-16), but this file is a pure render function without a loading state. No loading indicator was present, so it was skipped.

2. **px→token coverage** — 52% of all px values across CSS files have been replaced with design tokens (~1200/2309). The remaining ~1093 px values are primarily functional sizes that cannot or should not use spacing tokens: icon dimensions (16-32px), element heights/min-heights (38-44px), structural widths (200-400px), border-width: 1px, stroke-width values, and blur filter values. The plan acknowledged that "some px values are intentional (like icon sizes, fixed widths that can't use tokens)."

3. **console.warn in alerts.ts** — The file `alerts.ts` has 3 `console.warn` calls that were not in the task's file list. Per the plan's guidance ("keep console.warn for debug-only warnings"), these were left unchanged.

## Threat Flags

None — showToast error messages use generic English descriptions that don't expose internals. No new network endpoints, auth paths, or schema changes introduced.

## Self-Check: PASSED

All verification checks passed:
- Button :active states present for all variants
- :focus-visible on nav items
- Page transition classes defined
- Skeleton classes used in all 6 modified views
- 0 console.error/warn remaining in 8 modified view files
- showToast() imported and used in all modified view files
- `npx tsc --noEmit` passes
- No stray generated files left uncommitted
