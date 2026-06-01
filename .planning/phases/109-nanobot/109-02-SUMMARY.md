---
phase: 109-nanobot
plan: 02
subsystem: agent-core
tags: [skills, memory, context, nanobot-port]
requires: [109-01, MIG-02]
provides: [SkillsLoader, MemoryStore, ContextBuilder]
affects: ["packages/agent-core/*", "vitest.config.ts"]
tech-stack:
  added: ["yaml"]
  patterns: ["nanobot-style workspace path injection", "atomic file writes", "TDD RED/GREEN/REFACTOR"]
key-files:
  created:
    - packages/agent-core/src/skills.ts
    - packages/agent-core/src/memory.ts
    - packages/agent-core/src/context.ts
    - packages/agent-core/src/__tests__/skills.test.ts
    - packages/agent-core/src/__tests__/memory.test.ts
    - packages/agent-core/src/__tests__/context.test.ts
  modified:
    - packages/agent-core/src/types.ts
    - packages/agent-core/src/index.ts
    - vitest.config.ts
decisions:
  - "SkillsLoader uses .agents/skills/ as workspace skills dir (per D-14)"
  - "MemoryStore history at {workspace}/.slide/history.jsonl for Slide project compatibility"
  - "loadSkill() strips frontmatter (diverges from nanobot load_skill which returns raw content)"
  - "Consolidator is simplified — no LLM summarization, just archival concatenation"
  - "ContextBuilder creates its own MemoryStore and SkillsLoader instances"
  - "SessionEntry and SessionMetadata types added from Plan 109-01 spec"
metrics:
  duration: "~6 minutes"
  committed_at: "2026-05-25T22:47Z"
---

# Phase 109 Plan 2: Agent Core — SkillsLoader, MemoryStore, ContextBuilder

Port three core agent subsystems from nanobot Python to agent-core TypeScript. These form the context layer that DirectAdapter will use in Wave 3 to replace hardcoded system prompts and in-memory message storage.

## Results

| Metric | Value |
|--------|-------|
| Tasks completed | 3/3 |
| Test files | 3 |
| Total tests | 33 |
| Tests passing | 33 |
| TSC | Clean compile |
| Lines added | ~1,258 |

## Commits

| Hash | Message |
|------|---------|
| `77bfad5` | feat(109-02): port nanobot SkillsLoader to TypeScript |
| `d7e84c6` | feat(109-02): port nanobot MemoryStore and simplified Consolidator to TypeScript |
| `920a241` | feat(109-02): port nanobot ContextBuilder to TypeScript |

## Task Details

### Task 1: SkillsLoader (`skills.ts`)

- **Method:** TDD (RED/GREEN/REFACTOR)
- **Files:** `skills.ts` (287 lines), `skills.test.ts` (144 lines)
- **Tests:** 8 tests covering:
  - Skills discovery in `.agents/skills/` directory
  - Frontmatter parsing (name, description, always, requires)
  - Skill content loading with frontmatter stripped
  - Context injection via `loadSkillsForContext()`
  - Summary building for system prompts
  - Requirements checking (bins, env vars)
  - Graceful empty directory handling
  - Filtering unavailable skills by unmet requirements
- **API:** `listSkills()`, `loadSkill()`, `loadSkillsForContext()`, `buildSkillsSummary()`, `getAlwaysSkills()`, `getSkillMetadata()`

### Task 2: MemoryStore + Consolidator (`memory.ts`)

- **Method:** TDD
- **Files:** `memory.ts` (270 lines), `memory.test.ts` (121 lines)
- **Tests:** 15 tests covering:
  - MEMORY.md CRUD with atomic writes (tmp + fsync + rename)
  - History.jsonl append, read, cursor management
  - `readUnprocessedHistory()` cursor-based filtering
  - `compactHistory()` truncation
  - `getMemoryContext()` with "## Memory" header
  - SOUL.md, AGENTS.md, USER.md reading
  - Simplified Consolidator `summarize()` and `consolidate()`
- **API:** `MemoryStore`, `Consolidator`
- **Security:** Atomic writes per T-109-03 mitigation

### Task 3: ContextBuilder (`context.ts`)

- **Method:** TDD
- **Files:** `context.ts` (199 lines), `context.test.ts` (107 lines)
- **Tests:** 10 tests covering:
  - Bootstrap file inclusion (SOUL.md, AGENTS.md, HEARTBEAT.md)
  - Identity section from SOUL.md
  - Generic fallback when SOUL.md missing
  - Skill injection into system prompt
  - Message array assembly (system + history + user)
  - Runtime context appended to user message
  - Missing file handling (no crash)
- **API:** `ContextBuilder`, `buildSystemPrompt()`, `buildMessages()`
- **Security:** Bootstrap files are workspace config with no untrusted input (T-109-04 accepted)

## Deviations from Plan

### Auto-fixed Issues

1. **[Rule 1 - Bug] Fixed loadSkill() to strip frontmatter internally while keeping raw content for metadata parsing**
   - **Found during:** Task 1 GREEN phase
   - **Issue:** `loadSkill()` returned raw content (matching nanobot), but plan spec says it should strip frontmatter. However, `getSkillMetadata()` needs raw content.
   - **Fix:** Added private `_loadRawSkill()` method for internal metadata parsing; `loadSkill()` strips frontmatter per plan spec.
   - **Files modified:** `packages/agent-core/src/skills.ts`
   - **Commit:** `77bfad5`

2. **[Rule 1 - Bug] Fixed YAML frontmatter regex to handle CRLF line endings**
   - **Found during:** Task 1 GREEN phase
   - **Issue:** The `FRONTMATTER_RE` regex used `\s*\n` which didn't match `\r\n` on some files.
   - **Fix:** Changed to `[\r?\n]+` pattern matching the nanobot Python regex.
   - **File:** `packages/agent-core/src/skills.ts`

3. **[Rule 1 - Bug] Fixed _checkRequirements() to check top-level requires field**
   - **Found during:** Task 1 GREEN phase
   - **Issue:** Nanobot's `_checkRequirements()` only checks requirements from nested `metadata.nanobot/metadata.openclaw` subfields. Plan spec says top-level `requires` should also be checked.
   - **Fix:** `_getSkillMeta()` now merges top-level `requires` with nested metadata, with nested taking precedence.
   - **File:** `packages/agent-core/src/skills.ts`

### Infrastructure Fixes

4. **Fixed vitest.config.ts broken import**
   - **Issue:** Root vitest config re-exported from `./test/vitest/vitest.config.ts` which doesn't exist, causing vitest to crash before any tests run.
   - **Fix:** Replaced with a minimal inline `defineConfig` using default test patterns.
   - **File:** `vitest.config.ts` (project root)

## TDD Gate Compliance

All three tasks followed RED/GREEN/REFACTOR cycle:

| Task | RED commit | GREEN commit | REFACTOR |
|------|-----------|-------------|----------|
| 1 (SkillsLoader) | Test written before implementation | `77bfad5` | Integrated in same commit |
| 2 (MemoryStore) | Test written before implementation | `d7e84c6` | Integrated in same commit |
| 3 (ContextBuilder) | Test written before implementation | `920a241` | Integrated in same commit |

All RED phase test failures were confirmed before GREEN implementation. No test gate violations.

## Threat Flags

None. All files created/modified fall within the existing threat model boundaries:
- T-109-03 (MemoryStore atomic writes): Mitigated with tmp+fsync+rename
- T-109-04 (ContextBuilder bootstrap): Accepted risk — workspace config files only
- T-109-05 (SkillsLoader read-only): Mitigated — no write path
- No new network endpoints, auth paths, or schema changes at trust boundaries

## Self-Check

- [x] `packages/agent-core/src/skills.ts` exists (287 lines)
- [x] `packages/agent-core/src/memory.ts` exists (270 lines)
- [x] `packages/agent-core/src/context.ts` exists (199 lines)
- [x] `packages/agent-core/src/__tests__/skills.test.ts` exists
- [x] `packages/agent-core/src/__tests__/memory.test.ts` exists
- [x] `packages/agent-core/src/__tests__/context.test.ts` exists
- [x] Commit `77bfad5` exists (SkillsLoader)
- [x] Commit `d7e84c6` exists (MemoryStore)
- [x] Commit `920a241` exists (ContextBuilder)
- [x] TSC compiles clean
- [x] All 33 tests pass
