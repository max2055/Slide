---
phase: 115-openclaw-todo-ci
verified: 2026-06-02T11:48:00Z
status: gaps_found
score: 22/23 must-haves verified
overrides_applied: 0
gaps:
  - truth: "After test fixes, `cd apps/db-ops-api && npx vitest run` and `cd frontend && npx vitest run` both pass with 0 failures"
    status: failed
    reason: "D-15 requires 0 test failures for CI green. Backend has 15 failures (notifications, monitor-collector, cron-executor, event-aggregation, event-service, fault-diagnosis, phase-94-docs, task2). Frontend has 15 failures (design-tokens, navigation-cleanup). 30 total failures remain."
    artifacts:
      - path: "apps/db-ops-api"
        issue: "15 backend test failures (notification-service timeout mocks, monitor-collector cron mocking, event aggregation, fault-diagnosis cache key, phase-94-docs file paths, cron-executor parameter schema, task2 source verification)"
      - path: "frontend"
        issue: "15 frontend test failures (design-tokens migration checks, navigation-cleanup tab structure assertions)"
    missing:
      - "Fix notification-service.ts retry/timeout mock timing to prevent timeout failures"
      - "Fix monitor-collector.test.ts cron job mocks to match current implementation"
      - "Fix event-aggregation.test.ts alert grouping logic or update expectations"
      - "Fix event-service.test.ts empty events query or update expectations"
      - "Fix fault-diagnosis-service.test.ts cache key granularity assertion"
      - "Fix phase-94-docs-structure.test.ts file path expectations (39-Slide vs 40-Slide)"
      - "Fix cron-executor.test.ts parameter schema assertion"
      - "Fix task2.test.ts source verification pattern"
      - "Fix design-tokens.test.ts page migration expectations"
      - "Fix navigation-cleanup.test.ts tab structure assertions"
  - truth: "No `OpenClaw`/`openclaw` references remain in code comments, i18n files, or user-facing strings (excluding functional names)"
    status: failed
    reason: "Several non-excluded OpenClaw references remain in frontend source comments and strings that are not covered by the plan's exclusion list: icons.ts, plugin-sdk/reply-payload.ts, strip-inbound-meta.ts, templating.ts, input-files.ts, commands-export-session.ts, and skills/types.ts comments"
    artifacts:
      - path: "frontend/src/icons.ts:3"
        issue: "Comment references openclaw/ui/icons.ts merge source path"
      - path: "frontend/src/app/src/plugin-sdk/reply-payload.ts:2"
        issue: "Comment says 'extracted from OpenClaw plugin-sdk'"
      - path: "frontend/src/app/src/auto-reply/reply/strip-inbound-meta.ts:195"
        issue: "Comment says 'appended by OpenClaw'"
      - path: "frontend/src/app/src/auto-reply/templating.ts:114"
        issue: "Comment example uses openclaw@192.168.64.3"
      - path: "frontend/src/app/src/media/input-files.ts:189"
        issue: "User-Agent header contains 'OpenClaw-Gateway/1.0'"
      - path: "frontend/src/app/src/auto-reply/reply/commands-export-session.ts:173"
        issue: "Default filename uses 'openclaw-session-' prefix"
      - path: "apps/db-ops-api/src/skills/types.ts:134,252"
        issue: "Comments contain 'legacy OpenClaw' text (borderline — references excluded functional type OpenClawSkillMetadata)"
    missing:
      - "Update frontend/src/icons.ts:3 to remove or rephrase the openclaw merge path reference"
      - "Update frontend/src/plugin-sdk/reply-payload.ts:2 to use neutral wording"
      - "Update strip-inbound-meta.ts:195 comment to use neutral terminology"
      - "Update templating.ts:114 example hostname or comment"
      - "Evaluate input-files.ts:189 User-Agent header — may need to change if functional"
      - "Evaluate commands-export-session.ts:173 default filename prefix"
      - "Update skills/types.ts:134,252 comments to remove legacy OpenClaw wording"
---

# Phase 115: OpenClaw Cleanup + TODO Fix + CI Pipeline Verification Report

**Phase Goal:** Clean up v1.4 OpenClaw migration remaining items -- delete replaced Agent LLM config tools, fix TODO stubs, clean frontend residual references and OpenClaw naming, add GitHub Actions CI pipeline

**Verified:** 2026-06-02T11:48:00Z
**Status:** gaps_found
**Re-verification:** No -- initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Agent LLM config tools (configure_llm.ts + llm-config/index.ts) are no longer present in the source tree | VERIFIED | `test -f` returns 1 for all 3 deleted files. No broken imports found. |
| 2 | LLM config management is only accessible via REST API /api/llm/configs, not through Agent tools | VERIFIED | REST API endpoint exists at server.ts:514-602 with GET/POST/PUT/DELETE routes. Agent tools deleted. |
| 3 | CLAUDE.md no longer references self-mgmt empty-shell tools or llm-config | VERIFIED | grep for "self-mgmt 空壳工具" and "llm-config/index.ts" returns no matches. Sections updated. |
| 4 | slide-self-mgmt/index.ts still exports checkStatusTool and completeAnalysis (not broken by the deletion) | VERIFIED | Both exports present. configureLlmTool removed. All other exports intact. |
| 5 | Three dead routing files (bindings.ts, resolve-route.ts, bound-account-read.ts) are deleted from the source tree | VERIFIED | `test -f` returns 1 for all 3 files. No downstream imports found. |
| 6 | Auto-reply / infra files compile successfully -- they no longer import from a non-existent config/types.openclaw.js path | VERIFIED | Zero occurrences of `types.openclaw` in non-routing source files (only in config/types.ts comment, intentional). |
| 7 | Vite alias `openclaw/plugin-sdk/reply-payload` is renamed to `@agent/plugin-sdk/reply-payload` consistently across the codebase | VERIFIED | vite.config.js uses `@agent/plugin-sdk/reply-payload`. Zero occurrences of old alias in frontend/src/. |
| 8 | No remaining broken import paths point to the deleted `config/` directory | VERIFIED | config/types.ts stub created. All imports updated. |
| 9 | get_instance_summary filters results by the current user's RBAC instance permissions | VERIFIED | Code contains RbacService import, `context?.userId` check, and `getUserInstanceAccess()` calls at lines 37 and 87. TODO(D-08) removed. |
| 10 | list_active_alerts filters results by the current user's RBAC instance permissions | VERIFIED | Code contains RbacService import, `context?.userId` check, and `getUserInstanceAccess()` call at line 69. TODO(D-08) removed. |
| 11 | collectCapacityData() in report-service.ts returns real capacity data (disk_usage, growth_trend) using database-service.ts capacity methods | VERIFIED | Function at line 611 gets instance info, realtime metrics, calls `databaseService.getCapacityInfo()`, computes growth_trend from 30-day history. TODO removed. |
| 12 | check_status.ts performs real DB connection and LLM provider status checks instead of returning placeholder data | VERIFIED | Uses `databaseService.checkConnectionAlive()`, iterates providers via `getAllProviders()`, uses `Promise.allSettled` with `fetch()` for connectivity tests. No placeholder/stub. |
| 13 | No `OpenClaw`/`openclaw` references remain in code comments, i18n files, or user-facing strings (excluding functional names) | FAILED | 7 non-excluded references remain: icons.ts:3, reply-payload.ts:2, strip-inbound-meta.ts:195, templating.ts:114, input-files.ts:189, commands-export-session.ts:173, skills/types.ts:134/252 |
| 14 | server.ts health endpoint no longer returns `gateway_version` field | VERIFIED | grep for "gateway_version" returns no matches in server.ts. |
| 15 | server.ts DOC_TITLES no longer lists OPENCLAW-*.html entries | VERIFIED | grep for "OPENCLAW-" returns no matches in server.ts. |
| 16 | Root package.json no longer has `gateway:start` or `gateway:stop` scripts | VERIFIED | grep for both returns no matches. |
| 17 | `__openclaw` session key marker is either removed or confirmed as unused | VERIFIED | No `__openclaw` references remain anywhere in codebase. chat.ts cleaned. canvas-render.ts uses `__canvas__`. |
| 18 | protocol/CLAUDE.md is removed or updated to reflect current DirectAdapter architecture | VERIFIED | File exists and is rewritten to reflect DirectAdapter protocol boundary. No Gateway references. |
| 19 | GitHub Actions CI workflow exists at .github/workflows/ci.yml, triggered on PRs to main | VERIFIED | File exists with PR -> main trigger. |
| 20 | CI has two jobs: backend (vitest) and frontend (lint + vitest) | VERIFIED | Backend job: npm ci + typecheck + vitest. Frontend job: npm ci + lint + tsc --noEmit + vitest. |
| 21 | Root package.json has `oxlint` in devDependencies (so `npm run lint` works) | VERIFIED | `"oxlint": "^0.16.0"` present in root devDependencies. |
| 22 | Both projects have a `typecheck` script calling `tsc --noEmit` | VERIFIED | Both apps/db-ops-api/package.json and frontend/package.json have `"typecheck": "tsc --noEmit"`. |
| 23 | After test fixes, `cd apps/db-ops-api && npx vitest run` and `cd frontend && npx vitest run` both pass with 0 failures | FAILED | Backend: 15 failures (8 test files). Frontend: 15 failures (2 test files). 30 total failures remain. |

**Score:** 21/23 truths verified (2 failed)

### Deferred Items

No deferred items identified. This is the final phase in the current milestone (no phase 116+ defined in the roadmap). The remaining test failures and OpenClaw reference gaps are not addressed in any later phase.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/db-ops-api/.../configure_llm.ts` | Deleted | VERIFIED | File confirmed absent |
| `apps/db-ops-api/.../llm-config/index.ts` | Deleted | VERIFIED | File confirmed absent |
| `apps/db-ops-api/.../llm-config-tools.test.ts` | Deleted | VERIFIED | File confirmed absent |
| `apps/db-ops-api/.../slide-self-mgmt/index.ts` | configureLlmTool removed | VERIFIED | grep returns 0 matches |
| `apps/db-ops-api/CLAUDE.md` | No self-mgmt/llm-config refs | VERIFIED | Cleaned per D-05 |
| `frontend/.../routing/bindings.ts` | Deleted | VERIFIED | File confirmed absent |
| `frontend/.../routing/resolve-route.ts` | Deleted | VERIFIED | File confirmed absent |
| `frontend/.../routing/bound-account-read.ts` | Deleted | VERIFIED | File confirmed absent |
| `frontend/src/app/src/config/types.ts` | Created | VERIFIED | Exists with OpenClawConfig stub |
| `frontend/vite.config.js` | Neutral alias | VERIFIED | `@agent/plugin-sdk/reply-payload` |
| `.github/workflows/ci.yml` | CI workflow | VERIFIED | PR->main trigger, 2 jobs |
| `package.json` | oxlint in devDeps | VERIFIED | `"oxlint": "^0.16.0"` |
| `apps/db-ops-api/server.ts` | No gateway_version/OPENCLAW- | VERIFIED | Both removed |
| `frontend/.../protocol/CLAUDE.md` | Updated | VERIFIED | Now DirectAdapter protocol doc |
| `frontend/.../chat.ts` | No __openclaw | VERIFIED | Cleaned |
| `frontend/.../canvas-render.ts` | No __openclaw__ | VERIFIED | Uses __canvas__ |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| get_instance_summary.ts | requestContext.userId | RBAC permission filter | WIRED | `RbacService.getUserInstanceAccess(context.userId)` at lines 37, 87 |
| list_active_alerts.ts | requestContext.userId | RBAC permission filter | WIRED | `RbacService.getUserInstanceAccess(context.userId)` at line 69 |
| report-service.ts | database-service.ts capacity methods | collectCapacityData | WIRED | Calls `databaseService.getCapacityInfo(instanceId)` which dispatches by db_type |
| CLAUDE.md | slide-self-mgmt/index.ts | Updated tool status | WIRED | `check_status.ts` mention retained, deleted tool entries removed |
| vite.config.js | auto-reply/reply files | Vite alias resolution | WIRED | `@agent/plugin-sdk/reply-payload` alias configured, all 12+ files updated |
| package.json (root) | .github/workflows/ci.yml | oxlint devDependency | WIRED | oxlint ^0.16.0 in devDependencies, CI workflow references lint |
| apps/db-ops-api/package.json | .github/workflows/ci.yml | CI backend vitest | WIRED | `npx vitest run` in CI workflow |
| server.ts | health endpoint | gateway_version removed | WIRED | Field removed from query, response, and catch block |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|--------------------|--------|
| get_instance_summary.ts | userInstances | requestContext.userId -> RbacService.getUserInstanceAccess() | Yes -- calls RBAC service | FLOWING |
| list_active_alerts.ts | userInstances | requestContext.userId -> RbacService.getUserInstanceAccess() | Yes -- calls RBAC service | FLOWING |
| report-service.ts collectCapacityData | capacityInfo | databaseService.getCapacityInfo(instanceId) | Yes -- dispatches to db-specific capacity methods | FLOWING |
| check_status.ts | providers/connections | getAllProviders() + databaseService.checkConnectionAlive() + fetch(baseUrl) | Yes -- real connectivity checks | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Backend tests pass with 0 failures | `cd apps/db-ops-api && npx vitest run` | 15 failed, 843 passed | FAIL -- 15 failures remain |
| Frontend tests pass with 0 failures | `cd frontend && npx vitest run` | 15 failed, 220 passed | FAIL -- 15 failures remain |

### Probe Execution

No probes were declared in PLAN or SUMMARY files for this phase. Step skipped.

### Requirements Coverage

The D-01 through D-16 requirement IDs are defined in the phase-local CONTEXT.md file, NOT in the global REQUIREMENTS.md (which covers v1.3 requirements SEC-01 through QUAL-04 for phases 100-105). All 16 requirements are cross-referenced across the 5 PLAN files:

| Requirement | Source Plan | Description | Status | Evidence |
|------------|-------------|-------------|--------|----------|
| D-01 | Plan 03 | Fix 5 TODO stubs | SATISFIED | All 4 remaining TODOs (after D-04 deletion) fixed: RBAC in 2 tools, capacity in report-service, real checks in check_status |
| D-02 | Plan 03 | RBAC scope from request context | SATISFIED | Both tools use requestContext.userId with RbacService.getUserInstanceAccess() |
| D-03 | Plan 03 | Real capacity data collection | SATISFIED | collectCapacityData() uses databaseService.getCapacityInfo() |
| D-04 | Plan 01 | Delete Agent LLM config tools | SATISFIED | configure_llm.ts, llm-config/index.ts, test file all deleted |
| D-05 | Plan 01 | Update CLAUDE.md | SATISFIED | Self-mgmt section rephrased, llm-config entry removed |
| D-06 | Plan 02 | Delete dead routing code | SATISFIED | 3 routing files deleted, broken import chain broken |
| D-07 | Plan 04 | Naming principle: OpenClaw -> neutral | SATISFIED | Applied across 45+ files; exceptions documented |
| D-08 | Plan 04 | Clean comment/text OpenClaw references | PARTIAL | Most references cleaned; 7 minor non-excluded references remain |
| D-09 | Plan 02 | Rename Vite alias | SATISFIED | openclaw/plugin-sdk -> @agent/plugin-sdk; all imports updated |
| D-10 | Plan 04 | Clean server.ts | SATISFIED | gateway_version removed; OPENCLAW-* doc titles removed |
| D-11 | Plan 04 | Clean package.json scripts | SATISFIED | No gateway:start/stop scripts exist |
| D-12 | Plan 04 | __openclaw markers | SATISFIED | Removed from chat.ts; replaced with __canvas__ in canvas-render.ts |
| D-13 | Plan 04 | Misc cleanup | SATISFIED | Comments updated; protocol/CLAUDE.md rewritten; direct-gateway.ts comment cleaned |
| D-14 | Plan 05 | GitHub Actions CI workflow | SATISFIED | .github/workflows/ci.yml created with PR->main trigger |
| D-15 | Plan 05 | Fix tests, CI must be green | BLOCKED | 30 test failures remain (15 backend + 15 frontend). CI will NOT be green. |
| D-16 | Plan 05 | CI job structure | SATISFIED | Backend: vitest. Frontend: lint + vitest. |

**Coverage summary:**
- D-01 through D-16: 16/16 requirements mapped to plans (100%)
- SATISFIED: 14
- BLOCKED: 1 (D-15)
- PARTIAL: 1 (D-08 minor residual)

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| frontend/src/icons.ts | 3 | Historical OpenClaw file path in comment | Info | Non-functional comment reference |
| frontend/src/app/src/plugin-sdk/reply-payload.ts | 2 | "extracted from OpenClaw" comment | Info | Non-functional comment reference |
| frontend/src/app/src/auto-reply/reply/strip-inbound-meta.ts | 195 | "appended by OpenClaw" comment | Info | Non-functional comment reference |
| frontend/src/app/src/auto-reply/templating.ts | 114 | Example hostname openclaw@192.168.64.3 | Info | Example data in comment |
| frontend/src/app/src/media/input-files.ts | 189 | User-Agent "OpenClaw-Gateway/1.0" | Warning | Functional string -- may be safe to change or may affect compatibility |
| frontend/src/app/src/auto-reply/reply/commands-export-session.ts | 173 | "openclaw-session-" filename prefix | Warning | Functional default filename -- changing may affect user-visible behavior |
| apps/db-ops-api/src/skills/types.ts | 134, 252 | "legacy OpenClaw" comments | Info | Describes functional type OpenClawSkillMetadata, says "legacy" |

### Human Verification Required

1. **input-files.ts:189 User-Agent header compatibility**
   - Test: Check if changing "OpenClaw-Gateway/1.0" to a neutral User-Agent breaks any upstream service communication
   - Expected: No regression if the header is informational; breakage if the server checks for this exact UA string
   - Why human: Requires understanding of upstream server User-Agent filtering

2. **commands-export-session.ts:173 default filename prefix**
   - Test: Check if changing "openclaw-session-" prefix breaks any downstream tooling or user expectations for exported session files
   - Expected: No functional impact; filename is cosmetic
   - Why human: Requires understanding of user workflows and downstream tooling

3. **skills/types.ts:134,252 comments**
   - Test: Verify whether these comments are worth changing (they say "legacy" which accurately describes the provenance)
   - Expected: Cosmetic -- no functional impact
   - Why human: Subjective judgment on whether "legacy OpenClaw" wording is acceptable

## Gaps Summary

### Gap 1 (BLOCKER): CI will not be green -- 30 test failures remain

**D-15 status: BLOCKED.** The requirement explicitly states "Fix 118 failing tests first, then enable test steps. CI must be green." The phase documentation (DISCUSSION-LOG.md) confirms the user explicitly chose "先修测试再启用 CI" (fix tests first, then enable CI).

Current test status:
- Backend: 15 failures in 8 test files (notification-service timeout mocks, monitor-collector cron mocking, event-aggregation, event-service query expectations, fault-diagnosis cache key, phase-94-docs file paths, cron-executor parameter schema, task2 source verification)
- Frontend: 15 failures in 2 test files (design-tokens migration checks, navigation-cleanup tab structure assertions)

The Plan 05 SUMMARY acknowledges these as "pre-existing" and flags the requirements as incomplete in its self-check (the self-check shows `[ ]` not `[x]` for the 0-failure checks). CI as currently configured will fail because `npx vitest run` returns non-zero on test failures.

### Gap 2 (WARNING): Residual OpenClaw references in comments and strings

7 non-excluded OpenClaw/openclaw references remain:
- 2 are functional strings that may need evaluation before changing (User-Agent header, filename prefix)
- 5 are historical comments explaining file provenance
- All are in frontend code or skills/types.ts comments

These are cosmetic but represent incomplete fulfillment of D-07/D-08. The plan's exclusion list covered the major categories, these minor items slipped through the sweep.

### Overall Assessment

The phase achieved the vast majority of its goals:
- All dead code deleted (Agent tools, routing files)
- All TODO implementations completed (RBAC, capacity, status checks)
- Vite alias renamed
- CI workflow infrastructure created
- Server/package.json cleaned
- OpenClaw naming 98% cleaned

Two gaps remain: the test fix requirement (D-15) is not fully met, and a handful of cosmetic OpenClaw references survived the sweep. The test gap is the critical blocker -- with 30 failures, the CI pipeline cannot go green.

---

*Verified: 2026-06-02*
*Verifier: Claude (gsd-verifier)*
