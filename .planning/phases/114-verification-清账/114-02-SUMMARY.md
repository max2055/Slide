---
phase: 114-verification-清账
plan: 02
type: execute
subsystem: cleanup
tags: [openclaw, cleanup, dead-code-removal, DirectAdapter]
requires: []
provides: [VER-01]
affects:
  - apps/db-ops-api/src/adapter/get-agent-engine.ts
  - apps/db-ops-api/server.ts
  - frontend/src/app/ui/navigation.ts
  - apps/db-ops-api/src/skills/generated/*/SKILL.md
tech-stack:
  added: []
  removed:
    - OpenClawAdapter (source + adapter infrastructure)
    - OpenClaw reference copies (openclaw-reference/, .agents/skills/openclaw-*)
    - OpenClaw LLM config sync (syncLLMConfigToOpenClaw)
key-files:
  created: []
  modified:
    - apps/db-ops-api/src/adapter/get-agent-engine.ts
    - apps/db-ops-api/server.ts
    - frontend/src/app/ui/navigation.ts
    - apps/db-ops-api/src/skills/generated/topsql-analysis/SKILL.md
    - apps/db-ops-api/src/skills/generated/fault-diagnosis/SKILL.md
    - apps/db-ops-api/src/skills/generated/alert-rca/SKILL.md
    - apps/db-ops-api/src/skills/generated/check_health/SKILL.md
    - apps/db-ops-api/src/skills/generated/skill-files.test.ts
  deleted:
    - openclaw-reference/ directory
    - .agents/skills/openclaw-* (14 skill directories)
    - .openclaw/ workspace directory
    - tmp/sql-audit/.openclaw/, tmp/alert-ops/.openclaw/, tmp/db-admin/.openclaw/
    - apps/db-ops-api/.slide/
    - apps/db-ops-api/src/adapter/openclaw/ (11 files)
    - apps/db-ops-api/src/adapter/__tests__/openclaw-adapter.test.ts
    - apps/db-ops-api/src/adapter/__tests__/dual-run.test.ts
    - apps/db-ops-api/scripts/start-openclaw-gateway.mjs
    - apps/db-ops-api/tests/phase-94-app-render-docs.test.ts
    - apps/db-ops-api/tests/phase-94-docs-viewer.test.ts
    - apps/db-ops-api/tests/phase-94-navigation-docs.test.ts
    - openclaw菜单_已填充.xlsx
decisions:
  - "OpenClawAdapter fully removed — DirectAdapter is now the only adapter"
  - "getAdapterType() simplified to always return 'direct'"
  - "/api/llm/sync endpoint removed (was specific to OpenClaw models.json sync)"
metrics:
  duration: null
  completed_date: 2026-05-27
  files_changed: 47
  lines_added: 13
  lines_deleted: 8252
---

# Phase 114 Plan 02: OpenClaw Source Code Cleanup

**One-liner:** Removed all dead OpenClaw adapter code, reference copies, skill directories, LLM config sync, and stale test files — simplified adapter selection to DirectAdapter-only.

## Summary

Executed a comprehensive cleanup of all OpenClaw-related dead code and files across the repository. The plan consisted of 3 tasks:

1. **Physical file deletion** (39 tracked files, 5 untracked directories) — Removed openclaw-reference/, .agents/skills/openclaw-* skills, .openclaw/ workspace, apps/db-ops-api/.slide/, tmp/*/.openclaw/ workspaces, openclaw菜单_已填充.xlsx, adapter/openclaw/ directory, adapter test files, and start-openclaw-gateway.mjs.

2. **Source code simplification** — `get-agent-engine.ts` stripped of OpenClawAdapter import, feature flags (ENABLE_AGENT_ADAPTER_CHAT/ANALYSIS), openclawEngine singleton, and createOpenClawAdapter factory. `getAdapterType()` simplified to always return `'direct'`. `getAgentEngine()` no longer takes a capability parameter. `server.ts` cleaned of OPENCLAW_STATE_DIR/OPENCLAW_DISABLE_BUNDLED_PLUGINS env vars, syncLLMConfigToOpenClaw calls (3 locations), and the OpenClaw-specific startup conditional block. The `/api/llm/sync` endpoint was removed entirely.

3. **SKILL.md and navigation cleanup** — Removed `metadata.openclaw` from 4 SKILL.md frontmatter files. Removed the `openclaw` tab group from `navigation.ts`. Deleted 3 stale phase-94 test files referencing deleted OpenClaw UI paths. Updated `skill-files.test.ts` to match the new metadata structure.

## Tasks

| # | Name | Type | Status | Commit |
|---|------|------|--------|--------|
| 1 | Delete invalid directories and files | execute | done | `1a73f709e5c` |
| 2 | Remove OpenClaw adapter source code and simplify get-agent-engine.ts | execute | done | `91b35fbe48c` |
| 3 | Clean up SKILL.md frontmatter, navigation, and stale tests | execute | done | `e509c57e747` |
| -- | (deviation) Update skill-files.test.ts after metadata.openclaw removal | fix | done | `4503bb6fd09` |

## Verification

- **adapter/openclaw/ deleted:** Verified
- **TypeScript compilation:** Passes (no new errors; pre-existing errors unrelated)
- **openclaw references in source:** Remaining non-comment references in `llm-service-openclaw.ts` and `db-ops-plugin.ts` are outside plan scope (logged as deferred)
- **Navigation no openclaw tab group:** Verified

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] skill-files.test.ts references removed metadata.openclaw field**

- **Found during:** Task 3
- **Issue:** The test `skill-files.test.ts` checked for `metadata.openclaw.emoji` in SKILL.md frontmatter, but we replaced that field with `metadata: {}`
- **Fix:** Updated the test to check for `metadata` object existence instead of `metadata.openclaw.emoji`
- **Files modified:** `apps/db-ops-api/src/skills/generated/skill-files.test.ts`
- **Commit:** `4503bb6fd09`

## Deferred Issues

The following files contain `openclaw` references but were outside the plan scope and were not modified:

| File | Reference |
|------|-----------|
| `apps/db-ops-api/src/llm-service-openclaw.ts:107` | Uses `process.env.OPENCLAW_AGENT_DIR` |
| `apps/db-ops-api/src/db-ops-plugin.ts:8` | Imports from `openclaw/plugin-sdk/plugin-entry` |

These files should be evaluated for cleanup in a future plan.

## Threat Flags

None — all changes are deletions-only, no new surface introduced.

## Self-Check: PASSED

- **Commits exist:** `1a73f709e5c`, `91b35fbe48c`, `e509c57e747`, `4503bb6fd09` — all confirmed in git log
- **adapter/openclaw/ deleted:** Confirmed
- **getAdapterType() simplified:** Confirmed
- **server.ts OpenClaw branches removed:** Confirmed
- **navigation.ts no openclaw tab group:** Confirmed
