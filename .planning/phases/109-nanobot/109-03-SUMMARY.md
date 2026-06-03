---
phase: "109-nanobot"
plan: "03"
subsystem: "agent-core"
tags:
  - checkpoint
  - subagent
  - tool-discovery
  - session
  - context
  - nanobot-port
requires: [109-01, 109-02, MIG-02, MIG-03]
provides:
  - Bidirectional checkpoint restore (set/restore/clear + message key dedup)
  - SubagentManager wrapping AgentRunner for subagent execution
  - Tool auto-discovery (scanToolDir, importToolsFromDir)
  - Full DirectAdapter subsystem integration (SessionManager, ContextBuilder, SkillsLoader, MemoryStore)
affects: ["packages/agent-core/*", "apps/db-ops-api/src/adapter/*", "apps/db-ops-api/src/agents/*"]
tech-stack:
  added: ["node:child_process for bin requirement checking"]
  patterns: ["nanobot loop.py checkpoint restore port", "nanobot subagent.py SubagentManager port", "nanobot tools/loader.py ToolLoader port"]
key-files:
  created:
    - packages/agent-core/src/session.ts
    - packages/agent-core/src/skills.ts
    - packages/agent-core/src/memory.ts
    - packages/agent-core/src/context.ts
    - packages/agent-core/src/__tests__/runner-checkpoint.test.ts
    - apps/db-ops-api/src/agents/subagent-manager.ts
  modified:
    - packages/agent-core/src/runner.ts
    - packages/agent-core/src/types.ts
    - packages/agent-core/src/index.ts
    - packages/agent-core/src/tool-registry.ts
    - apps/db-ops-api/src/adapter/direct-adapter.ts
    - apps/db-ops-api/src/agents/subagent-spawn-tool.ts
decisions:
  - "Checkpoint restore is caller-side responsibility (DirectAdapter), not inside AgentRunner.run() loop"
  - "SubagentManager wraps AgentRunner with fire-and-forget pattern — no awaited spawn"
  - "ToolLoader uses synchronous readdirSync for scan (keeps ToolRegistry pattern consistent)"
  - "DirectAdapter creates its own subsystems with workspace path if not provided (backward compatible)"
  - "Backward compatibility: workspace defaults to process.cwd() for existing tests"
metrics:
  duration: "~11 min"
  committed_at: "2026-05-25T22:58Z"
tasks:
  total: 3
  completed: 3
  commits: 6
  test_files: 4 (existing) + 1 (new)
  tests_passing: 26 (14 checkpoint + 12 adapter)
---

# Phase 109 Plan 03: Checkpoint Restore + Subagent Integration + DirectAdapter Wiring

**One-liner:** Add bidirectional checkpoint restore to AgentRunner (send during execution, restore before turn), integrate SubagentManager wrapping AgentRunner for subagent execution, add Tool auto-discovery via directory scanning and dynamic import, and wire all agent-core subsystems (SessionManager, ContextBuilder, SkillsLoader, MemoryStore) into DirectAdapter to replace hardcoded session map and default system prompt.

## Results

| Metric | Value |
|--------|-------|
| Tasks completed | 3/3 |
| Test files | 1 new (runner-checkpoint.test.ts) |
| Total tests | 26 (14 checkpoint + 12 adapter) |
| Tests passing | 26 |
| TSC (agent-core) | Clean compile with strict mode |
| TSC (db-ops-api) | Clean for adapter/subagent files (pre-existing errors in server.ts/openclaw only) |
| Lines added | ~2,200 |

## Commits

| Hash | Message |
|------|---------|
| `b5864f82f5a` | test(109-03): add failing test for AgentRunner checkpoint restore |
| `76a568d202f` | feat(109-03): add bidirectional checkpoint restore + prerequisite agent-core modules |
| `dd7178f9856` | feat(109-03): add SubagentManager, Tool auto-discovery, and ToolRegistry registration |
| `f38fd72b905` | feat(109-03): wire all agent-core subsystems into DirectAdapter |
| `1d2dcc7e349` | fix(109-03): TypeScript compilation fixes for strict mode |
| `4c587d9f441` | chore(109-03): add .slide/ to gitignore and track agent-core package.json |

## Task Details

### Task 1: Add bidirectional checkpoint restore to AgentRunner (TDD)

**Method:** TDD (RED/GREEN)

**Files:** `runner.ts`, `types.ts`, `runner-checkpoint.test.ts`

**RED phase:** Wrote 14 tests covering:
- `_setRuntimeCheckpoint` writes payload into session metadata
- `_setRuntimeCheckpoint` overwrites existing checkpoint
- `_clearRuntimeCheckpoint` removes checkpoint from metadata
- `_clearRuntimeCheckpoint` does nothing if no checkpoint exists
- `_restoreRuntimeCheckpoint` returns false when no checkpoint
- `_restoreRuntimeCheckpoint` returns false for invalid checkpoint
- `_restoreRuntimeCheckpoint` appends assistant message
- `_restoreRuntimeCheckpoint` appends completed tool results
- `_restoreRuntimeCheckpoint` backfills pending tool calls with "[Task interrupted]" message
- `_restoreRuntimeCheckpoint` deduplicates overlapping messages (suffix vs prefix overlap detection)
- `_restoreRuntimeCheckpoint` clears checkpoint from metadata after restore
- `_restoreRuntimeCheckpoint` returns true when messages restored
- `_restoreRuntimeCheckpointForMessages` returns messages array

**GREEN phase:** Implemented 5 methods on AgentRunner:
- `_setRuntimeCheckpoint(session, payload)` — persists to `session.metadata['runtime_checkpoint']`
- `_clearRuntimeCheckpoint(session)` — removes checkpoint key
- `_checkpointMessageKey(message)` — returns dedup tuple (role, content, tool_call_id, name, tool_calls, reasoning_content, thinking_blocks)
- `_restoreRuntimeCheckpoint(session)` — restores assistant_message, completed_tool_results, backfills pending_tool_calls with "[Task interrupted before this tool finished.]", deduplicates via suffix/prefix overlap detection, clears checkpoint
- `_restoreRuntimeCheckpointForMessages(session)` — convenience wrapper returning Message[]

**Verification:** All 14 tests pass, TSC clean.

### Task 2: Subagent integration + Tool auto-discovery

**Files:** `subagent-manager.ts` (NEW), `subagent-spawn-tool.ts` (MODIFIED), `tool-registry.ts` (MODIFIED)

**SubagentManager** (`apps/db-ops-api/src/agents/subagent-manager.ts`):
- Constructor takes `agentRunner: AgentRunner`
- `spawn(agentId, task, parentSessionKey)` — registers SubagentRun, fires fire-and-forget AgentRunner execution
- `access(runId)` — returns status and result from SubagentRegistry
- Internal `_executeSubagent(run)` — creates AgentRunSpec with subagent-specific settings, updates registry

**Tool registration** (`subagent-spawn-tool.ts`):
- Added `createSpawnSubagentCoreTool(subagentManager)` — agent-core Tool-compatible spawn_subagent
- Added `createAccessSubagentCoreTool(subagentManager)` — agent-core Tool-compatible access_subagent
- Added `registerSubagentTools(registry, subagentManager)` — batch registration helper

**Tool auto-discovery** (`tool-registry.ts`):
- `scanToolDir(dirPath)` — synchronous directory scan for .js/.ts/.mjs/.cjs files
- `importToolsFromDir(dirPath)` — dynamic import() each file, collect Tool exports
- Skips index/types/schema files by default

**Verification:** Both packages compile cleanly for new files.

### Task 3: Wire all subsystems into DirectAdapter

**Files:** `direct-adapter.ts` (REWRITTEN), `vitest.config.ts` (FIXED)

**Constructor changes:**
- New `DirectAdapterOptions` interface with `workspace`, `sessionManager?`, `contextBuilder?`, `skillsLoader?`, `memoryStore?`
- If subsystems not provided, created with workspace path (defaults to process.cwd())
- Removed `sessions: Map<string, Message[]>` and `systemPrompt: string`
- Added `sessionManager`, `contextBuilder`, `skillsLoader`, `memoryStore` fields

**chat() method rewrite:**
- Gets/creates session via `this.sessionManager.getOrCreate(sessionKey)` (D-07)
- Checkpoint restore: checks for `runtime_checkpoint` in metadata, calls `_restoreRuntimeCheckpoint` (D-17)
- Pushes user message to session
- Builds messages with `this.contextBuilder.buildMessages(history, message, skillNames)` (D-12)
- Creates checkpoint callback that persists via `this.sessionManager.save(session)`
- On success: pushes assistant response, clears checkpoint, saves session
- On error: checkpoint remains for next turn

**invoke() changes:**
- Optionally uses ContextBuilder for system prompt assembly when no custom prompt provided
- Falls back to minimal system prompt string for backward compatibility

**Verification:** All 12 existing adapter tests pass unchanged. TSC clean for adapter files.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Missing prerequisite modules from plans 109-01 and 109-02**

- **Found during:** Task 1 startup
- **Issue:** Base commit `bd578aac8220` did not contain `session.ts`, `skills.ts`, `memory.ts`, `context.ts` or their tests. These files were committed in previous worktree agents that have been cleaned up.
- **Fix:** Created all four modules with full implementations based on the detailed interface specifications in 109-01-SUMMARY.md and 109-02-SUMMARY.md. Committed together with checkpoint implementation.
- **Commit:** `76a568d202f`

**2. [Rule 3 - Blocking] Broken vitest.config.ts**

- **Found during:** RED phase test execution
- **Issue:** Root vitest.config.ts referenced `./test/vitest/vitest.config.ts` which doesn't exist in the worktree
- **Fix:** Replaced with minimal inline defineConfig (matching previous wave fix)
- **File:** `vitest.config.ts`
- **Commit:** `f38fd72b905`

**3. [Rule 3 - Blocking] Missing @types/node in tsconfig**

- **Found during:** TypeScript compilation after creating node modules
- **Issue:** crypto, fs, path imports from `node:*` not recognized without `@types/node`
- **Fix:** Added `"types": ["node"]` to tsconfig compilerOptions
- **Files modified:** `packages/agent-core/tsconfig.json`
- **Commit:** `f38fd72b905`

**4. [Rule 3 - Blocking] Missing @slide/agent-core workspace resolution**

- **Found during:** db-ops-api TypeScript compilation
- **Issue:** `@slide/agent-core` not resolvable; no pnpm workspace linking in worktree
- **Fix:** Created `node_modules/@slide/agent-core` symlink to packages/agent-core
- **Commit:** N/A (local fix, tracked in node_modules)

### Infrastructure Fixes

**5. TypeScript strict mode fixes**
- Added explicit type annotations for filter/map callbacks in session.ts and memory.ts
- Removed unused `fileURLToPath` import from session.ts
- Replaced `require('node:child_process')` with ESM `import` in skills.ts
- **Commit:** `1d2dcc7e349`

**6. gitignore and package.json tracking**
- Added `.slide/` to gitignore (runtime SessionManager JSONL storage)
- Committed `packages/agent-core/package.json`
- **Commit:** `4c587d9f441`

## TDD Gate Compliance

| Gate | Commit | Status |
|------|--------|--------|
| RED (test) | `b5864f82f5a` | Confirmed: 13 tests failed before implementation |
| GREEN (feat) | `76a568d202f` | Confirmed: 14 tests pass after implementation |
| REFACTOR | Integrated in same commit | N/A |

## Verification

```bash
# agent-core compilation
npx tsc --noEmit --project packages/agent-core/tsconfig.json
# Exit code: 0 — clean

# Checkpoint tests
npx vitest run packages/agent-core/src/__tests__/runner-checkpoint.test.ts
# Test Files: 1 passed, Tests: 14 passed

# Adapter tests
npx vitest run apps/db-ops-api/src/adapter/__tests__/direct-adapter.test.ts
# Test Files: 1 passed, Tests: 12 passed

# db-ops-api compilation (subagent + adapter files only)
npx tsc --noEmit --project apps/db-ops-api/tsconfig.json
# No errors in subagent*.ts, direct-adapter.ts, or types.ts
# Pre-existing errors in server.ts and openclaw/ files only
```

## Threat Flags

None. All new code falls within the existing threat model boundaries:

| Threat ID | Category | Component | Status |
|-----------|----------|-----------|--------|
| T-109-06 | Spoofing | Checkpoint restore | Accept — checkpoint is internal (session metadata, JSONL-only) |
| T-109-07 | Denial of Service | SubagentManager spawn | Mitigate — bounded by maxIterations |
| T-109-08 | Tampering | Tool dynamic import | Mitigate — project-internal tool dirs only |

No new network endpoints, auth paths, file access patterns, or schema changes at trust boundaries.

## Known Stubs

None identified. All subsystems are fully wired:
- Checkpoint restore produces real deduplicated messages (no hardcoded empty values)
- SubagentManager creates real SubagentRun records
- ToolLoader performs real file system scans
- DirectAdapter subsitutes subsystem defaults when not provided

## Self-Check: PASSED

- [x] `packages/agent-core/src/runner.ts` contains checkpoint methods
- [x] `packages/agent-core/src/types.ts` contains `RuntimeCheckpoint`
- [x] `packages/agent-core/src/__tests__/runner-checkpoint.test.ts` exists (285 lines)
- [x] `apps/db-ops-api/src/agents/subagent-manager.ts` exists
- [x] `apps/db-ops-api/src/adapter/direct-adapter.ts` uses SessionManager
- [x] `npx tsc --noEmit --project packages/agent-core/tsconfig.json` passes
- [x] `npx vitest run packages/agent-core/src/__tests__/runner-checkpoint.test.ts` passes (14 tests)
- [x] `npx vitest run apps/db-ops-api/src/adapter/__tests__/direct-adapter.test.ts` passes (12 tests)
- [x] Types exported: `RuntimeCheckpoint`, `Session`, `SessionManager`, `SkillsLoader`, `MemoryStore`, `Consolidator`, `ContextBuilder`
- [x] `scanToolDir` and `importToolsFromDir` exported
- [x] `SubagentManager` created and imported in subagent-spawn-tool.ts
- [x] `registerSubagentTools` function available
- [x] All 6 commits exist in git log
