---
phase: 93-ai-agent-ops-assistant
plan: 01
subsystem: frontend
tags:
  - ai-settings
  - configuration
  - navigation
  - lit-element
requires: []
provides:
  - AI settings configuration page at /ai-settings
  - Navigation tab registration for ai-settings in Settings group
  - Page routing dispatch for ai-settings in app-render
affects:
  - frontend/src/openclaw/ui/navigation.ts
  - frontend/src/openclaw/ui/app-render.ts
tech-stack:
  added:
    - Lit 3.3 @customElement "ai-settings-page"
  patterns:
    - Full-page config panel (llm-config.ts pattern)
    - Toggle switch for master enable/disable
    - Severity level pill buttons (multi-select toggle)
    - Instance whitelist with Enter-to-add and x-to-remove
    - Time window with two time inputs and "~" separator
key-files:
  created:
    - frontend/src/openclaw/ui/views/ai-settings.ts
  modified:
    - frontend/src/openclaw/ui/navigation.ts
    - frontend/src/openclaw/ui/app-render.ts
decisions:
  - Used "settings" icon for ai-settings tab (plan suggested "sliders" but it does not exist in the IconName set)
  - Placed ai-settings in alphabetical position within Tab union, TAB_PATHS, and iconForTab
  - Placed ai-settings render block immediately after llm-config block in app-render.ts
  - Omitted cronExpression field from UI per D-13 decision (first version keeps defaults)
  - Full-page layout (not dialog) following llm-config.ts pattern
metrics:
  duration_minutes: 3
  completed_date: "2026-05-15"
---

# Phase 93 Plan 01: Create AI Settings Configuration Page

## One-liner
AI Settings configuration page in the Settings navigation group with master toggle, severity level pills, instance whitelist tags, and time window fields, wired to existing GET/PUT /api/ai/config API.

## Tasks Completed

| # | Name | Commit | Files |
|---|------|--------|-------|
| 1 | Register ai-settings tab in navigation system | bd5e7ec | navigation.ts |
| 2 | Create ai-settings.ts LitElement config page | a5486ea | ai-settings.ts (new) |
| 3 | Wire ai-settings page in app-render.ts | db43832 | app-render.ts |

## Deviations from Plan

None -- plan executed exactly as written.

- Icon fallback: plan specified "sliders" icon; verified it does not exist in IconName type, used "settings" as documented fallback. This is expected behavior, not a deviation.

## Verification

- [x] navigation.ts includes "ai-settings" in Tab union, TAB_GROUPS, TAB_PATHS, and iconForTab
- [x] ai-settings.ts is 255 lines (>= 180 min), has @customElement("ai-settings-page"), references /api/ai/config
- [x] app-render.ts imports ai-settings view and renders <ai-settings-page> for "ai-settings" tab
- [x] No syntax errors expected (follows existing patterns from llm-config.ts and alerts.ts)

## Known Stubs

None.

## Threat Flags

None -- no new network endpoints or auth paths introduced; /api/ai/config already JWT-protected in server.ts.

## Self-Check: PASSED

- [x] frontend/src/openclaw/ui/views/ai-settings.ts exists (255 lines)
- [x] frontend/src/openclaw/ui/navigation.ts has "ai-settings" in Tab, TAB_GROUPS, TAB_PATHS, iconForTab
- [x] frontend/src/openclaw/ui/app-render.ts imports and renders ai-settings
- [x] Commit bd5e7ec483 exists
- [x] Commit a5486eaab04 exists
- [x] Commit db43832a8dd exists
