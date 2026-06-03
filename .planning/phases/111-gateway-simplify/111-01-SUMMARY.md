---
phase: 111-gateway-simplify
plan: 01
type: execute
wave: 1
subsystem: frontend/openclaw/ui
tags: [cleanup, deletion, controller-removal]
requires: []
provides: [clean-imports]
affects: [app-settings, app, direct-gateway]
duration: "12 min"
completed: "2026-05-26"
status: completed
metrics:
  tasks: 3/3
  files-deleted: 9
  files-modified: 3
  commits: 3
tech-stack:
  unchanged: [lit, typescript, vite]
key-files:
  deleted:
    - "frontend/src/openclaw/ui/controllers/usage.ts"
    - "frontend/src/openclaw/ui/controllers/cron.ts"
    - "frontend/src/openclaw/ui/controllers/config.ts"
    - "frontend/src/openclaw/ui/controllers/skills.ts"
    - "frontend/src/openclaw/ui/controllers/exec-approvals.ts"
    - "frontend/src/openclaw/ui/controllers/models.ts"
    - "frontend/src/openclaw/ui/controllers/agent-files.ts"
    - "frontend/src/openclaw/ui/controllers/agent-identity.ts"
    - "frontend/src/openclaw/ui/controllers/agent-skills.ts"
  modified:
    - "frontend/src/openclaw/ui/app-settings.ts"
    - "frontend/src/openclaw/ui/app.ts"
    - "frontend/src/openclaw/ui/direct-gateway.ts"
decisions:
  - "D-01 fully applied: 9 controller files deleted"
  - "Kept ExecApprovalRequest import in app.ts from exec-approval.ts (singular, not deleted)"
  - "Replaced deleted controller type refs with inline equivalents (unknown/Record<string, unknown>/string unions)"
key-links:
  - from: "app-settings.ts"
    to: "deleted controllers"
    status: "all imports removed"
  - from: "app.ts"
    to: "deleted controllers"
    status: "all imports removed (exec-approval.ts kept — not a deleted controller)"
  - from: "direct-gateway.ts"
    to: "generic throw"
    status: "7 explicit throws removed"
---

# Phase 111 Gateway Simplify — Plan 01: Delete Dead Controllers

**One-liner:** Delete 9 fully-broken Gateway RPC controller files and clean all direct import references in app-settings.ts, app.ts, and direct-gateway.ts.

## Objective

Remove 9 controller files whose RPC methods all throw in DirectAdapter mode (D-01). Clean all files that directly import from them to restore a working compilation state. These controllers are dead code causing runtime errors when users navigate to their corresponding views.

## Tasks Executed

### Task 1: Delete 9 fully-broken controller files (commit 444d3eaa430)

Deleted via `git rm`:
- `controllers/usage.ts` — 4 RPC methods, all throw
- `controllers/cron.ts` — 8 RPC methods, all throw
- `controllers/config.ts` — 6 RPC methods, all throw including 2 Schema endpoints
- `controllers/skills.ts` — 5 RPC methods, all throw
- `controllers/exec-approvals.ts` — 4 RPC methods, all throw
- `controllers/models.ts` — models.list throw
- `controllers/agent-files.ts` — 3 RPC methods, all throw
- `controllers/agent-identity.ts` — agent.identity.get throw
- `controllers/agent-skills.ts` — skills.status throw

Preserved: `controllers/config/` subdirectory (form-coerce.ts, form-utils.ts — utility modules used by config-form.ts)

### Task 2: Clean app-settings.ts (commit f0d874c934d)

Removed:
- 8 import lines from deleted controllers (kept loadAgents + loadSessions)
- 8 type intersections from SettingsAppHost type (kept AgentsState + SessionsState)
- `agentsPanel` field from SettingsHost type
- All deleted controller calls from refreshAgentsTab (now only calls loadAgents)
- 5 cases from refreshActiveTab (config/appearance/system, usage, cron, skills)
- 4 deleted controller calls from loadOverview
- Entire loadCron export function
- Skills and cron blocks from buildAttentionItems
- Unused hasMissingSkillDependencies function

### Task 3: Clean app.ts and simplify direct-gateway.ts (commit e007dfd79ce)

app.ts:
- Removed loadToolsEffective / refreshVisibleToolsEffectiveForCurrentSession imports
- Removed type imports from skills.ts and exec-approvals.ts (deleted controllers)
- Removed case "refresh-tools-effective" from onSlashAction
- Removed entire updated() method (only used for tools-effective loading)
- Removed unused handleUpdated import
- Removed unused loadCron method and import (function removed in task 2)
- Replaced inline type imports from deleted cron.js with inline union types
- Replaced deleted controller type refs (ExecApprovalsSnapshot -> Record<string, unknown>, SkillMessage -> unknown, etc.)
- Added lastError to SettingsAppHost (was provided by deleted ConfigState)

direct-gateway.ts:
- Removed 7 explicit throw branches: tools.catalog, tools.effective, models.list, config.get, config.set, sessions.patch, sessions.delete
- Kept 4 working methods: chat.send, chat.history, agents.list, sessions.list
- Kept generic throw for unsupported methods

## Verification

All must_haves pass:
- 9 controller files deleted from git and disk
- app-settings.ts has no imports from any of the 9 deleted controllers
- refreshActiveTab has no cases for config/appearance/system/usage/cron/skills
- loadOverview no longer calls deleted controller methods
- refreshAgentsTab only calls loadAgents (kept controller)
- app.ts has no loadToolsEffective or refreshVisibleToolsEffective references
- direct-gateway.ts has 4 explicit method branches + generic throw (7 removed)

## Deviations from Plan

### Rule 3 — Fixed blocking issues

**1. Inline type imports from deleted controllers/cron.js in app.ts**
- Found during: Task 3 (TypeScript compilation)
- Issue: app.ts had 3 inline `import("./controllers/cron.js").*` type annotations that referenced the deleted cron.ts file
- Fix: Replaced CronJobsScheduleKindFilter with inline union `"all" | "at" | "every" | "cron"`, CronJobsLastStatusFilter with `"all" | "ok" | "error" | "skipped"`, CronFieldErrors with `Partial<Record<string, string>>`
- Files modified: app.ts
- Commit: e007dfd79ce

**2. lastError property missing from SettingsAppHost**
- Found during: Task 3 (TypeScript compilation)  
- Issue: lastError was previously provided by ConfigState and ExecApprovalsState types (both deleted). No longer in the type intersection.
- Fix: Added `lastError: string | null` to the SettingsAppHost inline object type
- Files modified: app-settings.ts
- Commit: e007dfd79ce

**3. loadCron method in app.ts referencing deleted export**
- Found during: Task 3
- Issue: loadCron method and import still existed in app.ts after the function was removed from app-settings.ts
- Fix: Removed the import alias and method from app.ts
- Files modified: app.ts
- Commit: e007dfd79ce

### Plan clarification — ExecApprovalRequest import kept

The plan's task 3 action and verification both indicate removing the `import type { ExecApprovalRequest } from "./controllers/exec-approval.ts"` from app.ts. However, `exec-approval.ts` (singular) is NOT one of the 9 deleted controllers — it remains alive. The plan mistakenly grouped it with deleted controllers. The import was kept because:
- The type is still available from a non-deleted file
- It's used by the `execApprovalQueue` state property and `handleExecApprovalDecision` method

## Known Stubs

None introduced by this plan.

## Threat Flags

None — all file operations were explicit named-file deletions, no new network/file surface introduced.

## Self-Check: PASSED

- 9 controller files confirmed deleted: OK
- app-settings.ts imports verified clean: OK
- app.ts imports verified (no tools-effective, no deleted controller refs): OK
- direct-gateway.ts simplified (4 branches + generic): OK
- No TypeScript compilation errors directly caused by changes: OK
