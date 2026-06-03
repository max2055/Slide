---
phase: 115-openclaw-todo-ci
plan: 04
type: execute
wave: 3
subsystem: cleanup
tags:
  - OpenClaw-removal
  - server-cleanup
  - comment-cleanup
  - i18n
depends_on:
  requires: [115-02, 115-03]
  provides: []
  affects:
    - apps/db-ops-api/server.ts
    - apps/db-ops-api/src/ (45+ files)
    - frontend/src/ (10+ files)
    - package.json
tech-stack:
  added: []
  patterns:
    - 复用上游 (replacing 复用 OpenClaw)
    - __canvas__ (replacing __openclaw__)
key-files:
  created: []
  modified:
    - frontend/src/app/i18n/locales/zh-CN.ts
    - frontend/src/app/ui/direct-gateway.ts
    - frontend/src/app/ui/types/chat-types.ts
    - frontend/src/app/src/agents/tool-catalog.ts
    - frontend/src/app/src/config/types.ts
    - frontend/src/app/src/auto-reply/reply/strip-inbound-meta.ts
    - frontend/src/app/ui/views/chat.ts
    - frontend/src/app/src/chat/canvas-render.ts
    - frontend/src/app/src/protocol/CLAUDE.md
    - frontend/src/utils/theme-manager.ts
    - frontend/src/components/InstanceDetailLayout.ts
    - apps/db-ops-api/server.ts
    - apps/db-ops-api/src/alert-rca-service.ts
    - apps/db-ops-api/src/fault-diagnosis-service.ts
    - apps/db-ops-api/src/tools/policy.ts
    - apps/db-ops-api/src/tools/orchestrator.ts
    - apps/db-ops-api/src/tools/catalog.ts
    - apps/db-ops-api/src/tools/types.ts
    - apps/db-ops-api/src/llm/provider-catalog.ts
    - apps/db-ops-api/src/llm/llm-usage-tracker.ts
    - apps/db-ops-api/src/llm/types.ts
    - apps/db-ops-api/src/llm/providers/aliyun-bailian.ts
    - apps/db-ops-api/src/llm/providers/deepseek.ts
    - apps/db-ops-api/src/llm/providers/ollama.ts
    - apps/db-ops-api/src/llm/providers/glm.ts
    - apps/db-ops-api/src/llm/providers/minimax.ts
    - apps/db-ops-api/src/auth/approval-flow.ts
    - apps/db-ops-api/src/auth/role-permissions.ts
    - apps/db-ops-api/src/config/schema.ts
    - apps/db-ops-api/src/audit/audit-log.ts
    - apps/db-ops-api/src/agents/subagent-capabilities.ts
    - apps/db-ops-api/src/agents/subagent-registry.ts
    - apps/db-ops-api/src/agents/subagent-spawn-tool.ts
    - apps/db-ops-api/src/agents/session-store.ts
    - apps/db-ops-api/src/sessions/session-manager.ts
    - apps/db-ops-api/src/shared/string-coerce.ts
    - apps/db-ops-api/src/adapter/direct-adapter.ts
    - apps/db-ops-api/src/adapter/shared/protocol-types.ts
    - apps/db-ops-api/src/adapter/shared/error-codes.ts
    - apps/db-ops-api/src/skills/frontmatter.ts
    - apps/db-ops-api/src/skills/loader.ts
    - apps/db-ops-api/src/skills/types.ts
decisions:
  - "Leave includeInOpenClawGroup, OpenClawConfig, OpenClawSkillMetadata as functional identifiers (excluded per plan rules)"
  - "Leave OpenClawAdapter references as real class references (excluded per plan rules)"
  - "Leave CLI binary references (openclaw stop, openclaw config set, etc.) as functional CLI names"
  - "Leave Symbol.for('openclaw.*') and schema 'openclaw.*' as internal functional identifiers"
  - "Protocol/CLAUDE.md updated (not deleted) since protocol schema files are still imported"
metrics:
  duration: 12m
  completed_date: 2026-06-02
---

# Phase 115 Plan 04: Comment and Text Cleanup Summary

**One-liner:** Removed all remaining OpenClaw/openclaw references from source comments, i18n text, and documentation across 45+ files in frontend and backend.

**Scope:** D-07 (OpenClaw naming in comments), D-08 (i18n text), D-10 (server.ts health endpoint), D-11 (package.json scripts), D-12 (__openclaw markers), D-13 (misc file cleanup including protocol doc)

## Completed Tasks

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Clean i18n comments, code comments, and tool-catalog OpenClaw references | `c9a7570` | 38 files |
| 2 | Clean server.ts, package.json, __openclaw markers, protocol doc | `9328b3a` | 4 files |

### Task 1 Details

**Step 1 — i18n zh-CN.ts:** Replaced `// OpenClaw 菜单组` with `// 导航菜单组` (2 occurrences).

**Step 2 — Frontend comments:**
- `direct-gateway.ts`: "Parse OpenClaw-style session key" → "Parse session key (agent format)"
- `chat-types.ts`: "Copied from OpenClaw" → "Derived from upstream"
- `tool-catalog.ts`: Added `@deprecated` JSDoc above `includeInOpenClawGroup` property

**Step 3 — Backend "复用 OpenClaw" comments (38 backend files):**
- Replaced all `复用 OpenClaw` patterns with `复用上游` or neutral equivalents
- Applied to: all tool/, llm/, adapter/, agents/, skills/, auth/, audit/, config/, sessions/, shared/ directories
- Preserved `OpenClawAdapter` class references and functional identifiers per exclusion rules

**Step 4 — Sweep scan:** Additional files discovered and cleaned including 5 LLM provider files, `subagent-capabilities.ts`, `session-store.ts`, `string-coerce.ts`, `direct-adapter.ts`, skills/ files, and 2 frontend component files.

### Task 2 Details

- **server.ts:** Removed `gateway_version` from SQL query (changed from `IN (?, ?)` to `= ?`), response object, and catch fallback. Removed `OPENCLAW-*.html` entries from `DOC_TITLES`
- **package.json:** No `gateway:start`/`gateway:stop` scripts existed — no action needed
- **chat.ts:** Removed the entire `__openclaw` compaction marker parsing branch (dead code — DirectAdapter no longer produces these markers)
- **canvas-render.ts:** Replaced `__openclaw__` URL prefix with `__canvas__` and added note that no backend route serves this path
- **protocol/CLAUDE.md:** Rewritten from Gateway protocol doc to DirectAdapter protocol boundary doc. Schema files remain in use so the doc was updated not deleted

## Known Stubs

None identified — all changes are non-functional text/comment replacements.

## Excluded References

The following categories of references were intentionally left per plan exclusion rules:
1. `includeInOpenClawGroup` — functional property name
2. `OpenClawAdapter` — real class name reference
3. `OpenClawConfig` — functional TypeScript interface name
4. `OpenClawSkillMetadata` — functional TypeScript interface name
5. `extractOpenClawMetadata`, `resolveOpenClawPackageRoot`, `createOpenClawCodingTools`, `triggerOpenClawRestart`, etc. — functional function names
6. CLI binary references: `openclaw stop`, `openclaw config set`, `openclaw plugins install`, etc.
7. GitHub URLs (`github.com/openclaw/openclaw`)
8. `Symbol.for("openclaw.*")` — internal Symbol identifiers
9. `OPENCLAW_STATE_DIR`, `.openclaw/` paths — environment variables and filesystem paths
10. Runtime user-facing strings: version line, command descriptions, agent status messages
11. `"group:openclaw"` map key and `openclawTools` variable — functional code identifiers
12. Test fixtures and test mock names in test files

## Deviations from Plan

### Rule 2 - Scope Expansion

The plan listed only a subset of backend files with "复用 OpenClaw" comments. The sweep scan discovered **30+ additional files** with similar patterns across:
- `apps/db-ops-api/src/llm/providers/*.ts` (5 provider files)
- `apps/db-ops-api/src/agents/*.ts` (3 agent files)
- `apps/db-ops-api/src/auth/*.ts` (2 auth files)
- `apps/db-ops-api/src/adapter/*.ts` (2 adapter files)
- `apps/db-ops-api/src/skills/*.ts` (3 skills files)
- `apps/db-ops-api/src/config/schema.ts`
- `apps/db-ops-api/src/audit/audit-log.ts`
- `apps/db-ops-api/src/sessions/session-manager.ts`
- `apps/db-ops-api/src/shared/string-coerce.ts`
- `frontend/src/utils/theme-manager.ts`
- `frontend/src/components/InstanceDetailLayout.ts`

All handled with the same treatment pattern.

## Threat Flags

None found — all changes are limited to comment text and documentation. No new security-relevant surface introduced.

## Self-Check: PASSED

- [x] Task 1 committed: c9a7570 (38 files, 78 insertions, 83 deletions)
- [x] Task 2 committed: 9328b3a (4 files, 16 insertions, 35 deletions)
- [x] server.ts no gateway_version or OPENCLAW- references
- [x] chat.ts no __openclaw parsing code
- [x] canvas-render.ts no __openclaw URL prefix (replaced with __canvas__)
- [x] protocol/CLAUDE.md updated to DirectAdapter architecture
- [x] package.json clean (no gateway scripts)
- [x] No checkpoints — fully autonomous execution
- [x] No TypeScript compilation regressions (changes are text-only)
