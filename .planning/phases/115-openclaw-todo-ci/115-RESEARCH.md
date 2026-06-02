# Phase 115: OpenClaw 迁移后清理 - Research

**Researched:** 2026-06-02
**Domain:** Cleanup/refactor: TODO fix, dead code removal, naming cleanup, CI pipeline, test fix
**Confidence:** HIGH

## Summary

Phase 115 is the v1.4 Agent decoupling cleanup phase. After removing the OpenClaw dependency, five categories of work remain: (1) fix 5 TODO stubs in backend tools, (2) delete 2 Agent LLM config tool sets replaced by REST API, (3) remove frontend dead code referencing deleted OpenClaw config files, (4) rename remaining `openclaw`/`OpenClaw` naming to neutral aliases, (5) set up GitHub Actions CI pipeline.

**Key insight:** The work is largely mechanical but carries a risk of collateral damage — deleting the routing files (bindings.ts, resolve-route.ts, bound-account-read.ts) is safe because they import the already-deleted `types.openclaw.ts`/`config/bindings.ts`, but there are 30+ other files (auto-reply subsystem, media, infra) that also import the deleted config files and ARE still in use. These need `OpenClawConfig` type replacement, not file deletion.

**Primary recommendation:** Process the work as backend-first (fix TODOs, delete Agent tools), then frontend dead-code sweep, then rename pass, then CI. Fixing the 88 failing tests is the riskiest item due to the `expect(false).toBe(true)` RED tests and the config-related import breaks.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Fix all 5 TODOs: report-service.ts capacity data collection, get_instance_summary/list_active_alerts RBAC scope, check_status.ts/configure_llm.ts (but D-04 takes priority)
- **D-02:** RBAC scope implementation: get current user from request context, filter results by user's instance permissions
- **D-03:** report-service.ts collectCapacityData() implement real capacity collection, reuse database-service.ts capacity query methods (getMySQLCapacity/getPostgresCapacity etc.)
- **D-04:** Delete 2 Agent LLM config tools: `slide-self-mgmt/configure_llm.ts` and `llm-config/index.ts` (including tests). LLM config management goes through REST API `/api/llm/configs`
- **D-05:** Update apps/db-ops-api/CLAUDE.md, remove "self-mgmt empty shell tools" outdated entry
- **D-06:** System scan and batch-delete all dead code importing deleted files (types.openclaw.ts, config/bindings.ts). At minimum delete routing/bindings.ts, resolve-route.ts, bound-account-read.ts
- **D-07:** Naming principle: `openclaw`/`OpenClaw` -> neutral aliases (NOT `slide`); `gateway`/`Gateway` -> keep (already neutral)
- **D-08:** Clean up all comment/text OpenClaw references: i18n zh-CN.ts "OpenClaw menu group", code comments "cloned from OpenClaw" etc.
- **D-09:** Rename Vite alias `openclaw/plugin-sdk/reply-payload` -> neutral alias (e.g., `@agent/plugin-sdk/reply-payload`), sync all auto-reply imports
- **D-10:** Clean up server.ts: remove health endpoint `gateway_version` field, remove OPENCLAW-*.html static file routes
- **D-11:** Clean up package.json: delete `gateway:start`/`gateway:stop` scripts
- **D-12:** Check and clean `__openclaw` session key marker (direct-gateway.ts, chat.ts). If DirectAdapter no longer produces this marker, delete parsing code
- **D-13:** Miscellaneous cleanup: direct-gateway.ts rename (gateway kept), chat-types.ts/icon.ts comment updates, protocol/CLAUDE.md delete or update
- **D-14:** Add GitHub Actions CI: 1 workflow, 2 jobs (frontend + backend), PR -> main trigger
- **D-15:** CI steps: lint + typecheck + tests. Fix 118 failing tests first, then enable test steps. CI must be green.
- **D-16:** Backend job: npm test (vitest); Frontend job: npm run lint + vitest run

### Claude's Discretion
- Neutral alias specific naming (`@agent/`, `@core/`, `@app/`, etc.) to be chosen by planner
- CI workflow file structure and job config details to be decided by planner
- 118 failing test fix order and strategy to be decided by executor
- database-service.ts capacity query method reuse approach to be confirmed by researcher

### Deferred Ideas (OUT OF SCOPE)
- **Documentation update**: docs/slide/ under 5 documents (ARCHITECTURE.md etc.) have 79 OpenClaw/Gateway references, deferred to dedicated doc update phase
- **Frontend settings page vs Agent LLM tool duplication**: Done — Agent LLM tools deleted
</user_constraints>

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Tool TODO fix (RBAC scope) | Backend API | — | RBAC filtering is a pure backend concern — request context has user info |
| Tool TODO fix (capacity data) | Backend API | Database | collectCapacityData() reuses database-service.ts methods in the backend |
| Delete Agent LLM tools | Backend API | — | Tools are backend Agent tool files, REST API `/api/llm/configs` is the replacement |
| Frontend dead code removal | Frontend SPA | — | Routing/binding dead code lives entirely in frontend `config/`-importing files |
| OpenClaw naming cleanup | Both | — | Renames span backend comments, frontend Vite config, i18n, file comments |
| CI pipeline | Infrastructure | Both | A single GitHub Actions workflow orchestrates both frontend and backend jobs |
| Test fix | Both | — | 88 failing tests span frontend (18) and backend (70); fixes are per-project |

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Vitest | ^4.1.4 (backend) / ^3.1.3 (frontend) | Test runner | Already in use, D-16 mandates it for CI |
| GitHub Actions | — | CI pipeline | D-14 mandates it. Platform standard for OSS CI |
| Oxlint | — | Linter | Root `package.json` has `"lint": "oxlint"` — intended project linter |
| TypeScript | 5.x (project-wide) | Type checking | D-15 mandates typecheck in CI. Root tsconfig.json exists |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| pnpm | 10.32.1 | Package manager | All `package.json` scripts use pnpm. CI should use `pnpm test` |
| ESM | — | Module system | All packages use `"type": "module"`. CI must respect ESM |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| GitHub Actions | CircleCI / GitLab CI | D-14 explicitly mandates GitHub Actions |
| Oxlint | ESLint | Root `package.json` already has `"lint": "oxlint"`. But Oxlint is NOT currently installed — CI will need to `npm install oxlint` or it will fail |
| Vitest | Jest | Both projects already use Vitest. Not negotiable. |

**Installation:**
```bash
# CI dependencies (not needed for dev)
pnpm add -D oxlint   # if CI lint is needed; oxlint is declared but not installed
```

**Version verification:** The test infrastructure uses the versions installed in each project's `node_modules`. CI will resolve from `package-lock.json`.

---

## Package Legitimacy Audit

> This phase does NOT install external packages from npm. All work involves modifying existing files, deleting files, and configuring CI infrastructure (GitHub Actions yml). No new runtime dependencies are introduced.

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| None (no new packages) | — | — | — | — | N/A | N/A |

**Packages removed due to slopcheck [SLOP] verdict:** None
**Packages flagged as suspicious [SUS]:** None

*If CI setup installs oxlint or other tools, those should be gated behind `checkpoint:human-verify` since oxlint is declared but not currently installed in node_modules.*

---

## Architecture Patterns

### System Architecture Diagram
```
GitHub Actions CI (.github/workflows/ci.yml)
│
├── Job: Backend (apps/db-ops-api)
│   ├── Checkout + Install
│   ├── Lint (oxlint)
│   ├── TypeCheck (tsc --noEmit)
│   └── Test (vitest run)
│
└── Job: Frontend (frontend/)
    ├── Checkout + Install
    ├── Lint (oxlint)
    ├── TypeCheck (tsc --noEmit)
    └── Test (vitest run)

PR --[trigger: pull_request → main]--> CI workflow
```

### Code Cleanup Flow
```
TODO Fix Flow:
  get_instance_summary.ts          ──→ Add user context → filter by RBAC
  list_active_alerts.ts            ──→ Add user context → filter by RBAC
  report-service.ts:collectCapacity ──→ Reuse database-service.ts capacity methods

Agent Tool Delete Flow:
  slide-self-mgmt/configure_llm.ts ──→ Delete file
  llm-config/index.ts              ──→ Delete file (including test)
  slide-self-mgmt/index.ts         ──→ Remove configureLlmTool export

Frontend Dead Code Delete Flow:
  routing/bindings.ts              ──→ Delete (imports deleted types.openclaw.ts)
  routing/resolve-route.ts         ──→ Delete (imports deleted types.openclaw.ts)
  routing/bound-account-read.ts    ──→ Delete (imports deleted types.openclaw.ts)
  [30+ auto-reply/media/infra files] ──→ NOT dead; need type import fix, not deletion

Naming Cleanup Flow:
  OpenClawConfig type refs ──→ Replace with neutral type
  Vite alias `openclaw/plugin-sdk` ──→ Rename to neutral alias
  backend comments "参考：openclaw_source_code" ──→ Update or remove
  i18n zh-CN.ts "OpenClaw 菜单组" ──→ Replace with neutral text
  server.ts OPENCLAW-*.html routes ──→ Remove
  chat.ts __openclaw marker ──→ Check if still needed, remove if not
  canvas-render.ts /__openclaw__/ ──→ Check if still functional, update or remove
```

### Recommended Project Structure (No structural changes — cleanup only)
```
apps/db-ops-api/
├── src/
│   ├── tools/generated/slide-self-mgmt/
│   │   ├── configure_llm.ts         <-- DELETE
│   │   └── index.ts                  <-- EDIT: remove configureLlmTool export
│   ├── tools/generated/llm-config/
│   │   ├── index.ts                  <-- DELETE entire directory
│   │   └── llm-config-tools.test.ts  <-- DELETE
│   ├── tools/ops/get_instance_summary.ts  <-- ADD RBAC filtering
│   ├── tools/ops/list_active_alerts.ts    <-- ADD RBAC filtering
│   └── report-service.ts                 <-- FILL collectCapacityData()

frontend/src/app/ui/routing/
├── bindings.ts                   <-- DELETE
├── resolve-route.ts              <-- DELETE
├── bound-account-read.ts         <-- DELETE

.github/workflows/
└── ci.yml                        <-- NEW (create)
```

### Anti-Patterns to Avoid
- **Deleting still-used files:** The auto-reply/media/infra files (30+) import deleted config files but are NOT dead code. Do NOT delete them — they need type import replacement.
- **Renaming `gateway`:** D-07 says `gateway` stays. The DirectAdapter has functions named `gateway` that should NOT be renamed.
- **Test fix before code cleanup:** Fix the broken imports and test source code first, then address the `expect(false).toBe(true)` RED tests last.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| CI pipeline | Custom CI scripts | GitHub Actions (`.github/workflows/ci.yml`) | D-14 mandates it. Standard GitHub Actions + checkout/setup-node/cache actions |
| Typecheck | Custom type checker | `tsc --noEmit` | Already in root tsconfig.json. No need for anything custom |
| Linting | Custom lint rules | `oxlint` | Root `package.json` already declares `"lint": "oxlint"` |

**Key insight:** All CI steps use standard GitHub Actions — the only thing to hand-roll is the workflow YAML. Oxlint is not currently installed anywhere; CI needs to either install it (`npm i -D oxlint`) or the root `package.json` needs it in `devDependencies`.

---

## Runtime State Inventory

> This is a cleanup/refactor phase, not a rename phase. However, naming changes (OpenClaw -> neutral) could affect runtime state.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — no database schemas, collection names, or stored keys contain "openclaw" | None |
| Live service config | None — GitHub Actions is new, no existing external services reference OpenClaw naming | None |
| OS-registered state | None — no systemd, launchd, pm2, or Task Scheduler entries | None |
| Secrets/env vars | None — no env vars contain "OPENCLAW" | None |
| Build artifacts | Vite config alias `openclaw/plugin-sdk/reply-payload` — renaming triggers rebuild | Re-run `npm run build` after rename |

**Nothing found in category:** Stored data, Live service config, OS-registered state, Secrets/env vars — all verified by grep sweep.

---

## Common Pitfalls

### Pitfall 1: Collateral deletion of still-used code
**What goes wrong:** Deleting all files that import `types.openclaw.ts` would remove the auto-reply subsystem (30+ actively imported files).
**Why it happens:** The simple approach "find all imports -> delete all" is too aggressive.
**How to avoid:** Only delete files that (a) import deleted config files AND (b) are NOT themselves imported by any other file. Use `grep -rn "import.*from.*routing/bindings"` etc. to verify.
**Warning signs:** TypeScript/test failures in unrelated modules after deletion.

### Pitfall 2: Oxlint not installed
**What goes wrong:** CI `npm run lint` fails because oxlint is declared in root `package.json` scripts but NOT installed in `node_modules`.
**Why it happens:** The instruction `"lint": "oxlint"` exists but oxlint was never `npm install`ed. Root `devDependencies` is missing oxlint.
**How to avoid:** Add `oxlint` to root `devDependencies` or install it globally in CI. [VERIFIED: root package.json has no oxlint in dependencies]
**Warning signs:** CI job fails at lint step with "command not found: oxlint".

### Pitfall 3: `__openclaw__` URL path references
**What goes wrong:** Changing the `__openclaw__` marker in server.ts route handling but missing `__openclaw__` in `canvas-render.ts` which generates frontend URLs with `/__openclaw__/canvas/documents/...`.
**Why it happens:** D-10 mentions server.ts routes for OPENCLAW-\*.html, but `canvas-render.ts` hardcodes `/__openclaw__/` as a URL path prefix for canvas documents.
**How to avoid:** Check ALL `__openclaw` string occurrences across both frontend and backend before removing. [CITED: canvas-render.ts:148]
**Warning signs:** Canvas document links break after cleanup.

### Pitfall 4: 118 vs 88 test failure discrepancy
**What goes wrong:** The CONTEXT.md says 118 failing tests but the actual count is 88 (70 backend + 18 frontend).
**Why it happens:** The CONTEXT was written at a different point in time. Tests may have been partially fixed or the count included different test suites.
**How to avoid:** Measure actual test counts at plan execution time. Document the discrepancy. Target 0 failures regardless of starting count.
**Warning signs:** None — this is just a data freshness issue.

### Pitfall 5: test file imports from deleted Agent tools
**What goes wrong:** When deleting `llm-config/index.ts`, the corresponding test file `llm-config-tools.test.ts` imports from it and must also be deleted.
**Why it happens:** The test file calls functions like `createListLLMProvidersTool()` that are 100% defined in the deleted file.
**How to avoid:** D-04 explicitly says "including tests" — make sure `llm-config-tools.test.ts` is part of the deletion plan. [CITED: CONTEXT.md D-04]
**Warning signs:** CI test step fails after tool deletion with import errors.

---

## Code Examples

### Pattern 1: RBAC scope from request context
```typescript
// Reference pattern from existing tools (e.g., testConnection) that use request context
// Source: CONTEXT.md established pattern note

// In get_instance_summary.ts / list_active_alerts.ts:
import type { UserRequestContext } from '../../types.js';

export const createGetInstanceSummaryTool = (ctx: { requestContext?: UserRequestContext }) => {
  return {
    name: 'get_instance_summary',
    handler: async (args: unknown) => {
      const userId = ctx.requestContext?.userId;
      // Use userId to filter by instance permissions via RBAC service
      const allowedInstances = await rbacService.getUserInstances(userId);
      // Filter results to allowedInstances
    }
  };
};
```

### Pattern 2: agent tool registration
```typescript
// Source: Codebase established pattern in slide-self-mgmt
import type { AnyAgentTool } from '../../types.js';
import { toolCatalog } from '../../catalog.js';

export const someTool: AnyAgentTool = {
  name: 'slide_some_tool',
  description: '...',
  parameters: { type: 'object', properties: {}, required: [] },
  handler: async (args) => {
    // ...
  },
};

toolCatalog.register(someTool);
```

### Pattern 3: GitHub Actions CI workflow structure
```yaml
# Standard dual-project setup based on D-14/D-16
name: CI
on:
  pull_request:
    branches: [main]
jobs:
  backend:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: apps/db-ops-api
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm install
      - run: npx vitest run
  frontend:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: frontend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm install
      - run: npx vitest run
      - run: npm run lint  # assumes oxlint installed
```
[ASSUMED: Based on standard GitHub Actions patterns; exact node version and pnpm usage to be confirmed by planner per discretion]

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| OpenClaw Agent LLM tools | REST API `/api/llm/configs` | Phase 115 | Delete configure_llm.ts + llm-config/index.ts |
| OpenClaw Gateway | DirectAdapter | Phase 110-114 | Clean up naming, dead code, comments |
| No CI | GitHub Actions CI | Phase 115 | New .github/workflows/ci.yml |

**Deprecated/outdated:**
- `slide-self-mgmt/configure_llm.ts`: 6 handlers for LLM CRUD — all replaced by REST API. 288 lines to delete.
- `llm-config/index.ts`: 6 tool factories (createListLLMProviders, createAddLLMProvider, etc.) — all replaced. 465 lines to delete.
- `slide-self-mgmt/index.ts`: contains `configureLlmTool` export — needs the export line removed.
- `llm-config-tools.test.ts`: 174+ lines of tests for the deleted tools — delete.
- `apps/db-ops-api/CLAUDE.md` "self-mgmt 空壳工具" section: outdated — the tools either have real implementations or will be deleted.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The 30+ auto-reply/media/infra files importing `OpenClawConfig` from deleted `config/` are still in use and need type replacement, not deletion | Architecture Patterns / Common Pitfalls | Medium — if they ARE dead code, the plan wastes effort on type replacement; if they're NOT dead code, deleting them breaks the app |
| A2 | Canvas `__openclaw__` URL path (`/__openclaw__/canvas/documents/`) may still be functional or may generate broken links | Common Pitfalls | Low — the URL path exists in code but may point to a non-existent backend route |
| A3 | The 118 test failure count in CONTEXT.md may be stale — actual count is 88 | Common Pitfalls | Low — planning test fix order based on stale count wastes effort but doesn't cause breakage |
| A4 | Oxlint was never actually installed in the project — the root package.json has the script but no dependency | Common Pitfalls | High — if oxlint IS installed and just missing from devDependencies, CI could pick it up from pnpm cache; if NOT, CI lint fails |

---

## Open Questions (RESOLVED)

1. **(RESOLVED)** The 30+ auto-reply files need a type stub — Plan 02 creates `frontend/src/app/src/config/types.ts` as a backward-compatible stub.
   - What we know: 30+ files in `frontend/src/app/src/auto-reply/`, `media/`, `infra/` import `OpenClawConfig` from the deleted `config/types.openclaw.js` / `config/types.js`. These files ARE imported from `frontend/src/app/ui/` (via message-extract.ts, slash-commands.ts, etc.).
   - What's unclear: Whether `OpenClawConfig` needs to be re-exported from a new location, or if the type has been relocated elsewhere. The `config/` directory is entirely gone.
   - **(RESOLVED)** Plan 02 creates the type stub; Plan 05 verifies compilation.

2. **(RESOLVED)** Oxlint is not installed — Plan 05 adds it to root devDependencies and CI install step.
   - **(RESOLVED)** Replaced with `__canvas__` neutral prefix — Plan 04 handles it with backend route verification.

3. **(RESOLVED)** Neutral alias chosen: `@agent/plugin-sdk/reply-payload` per Plan 02 (Claude's discretion).
   - What we know: D-07 says "NOT `slide`" as the replacement. Candidate suggestions: `@agent/`, `@core/`, `@app/`.
   - What's unclear: Which alias best fits the project's existing convention (currently uses `@slide/app/src` and `@slide/app/ui` but D-07 prohibits `slide`).
   - Recommendation: Planner should pick one that is both neutral AND unambiguous. `@agent/` is most descriptive for a plugin-sdk alias.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Both projects | yes | v22.22.1 | — |
| npm | Both projects | yes | 10.9.4 | — |
| pnpm | Monorepo | yes | 10.32.1 | npm workspaces |
| Git | Project | yes | — | — |
| Oxlint | CI lint | NO | — | Add to devDependencies or install in CI |
| GitHub Actions | CI | N/A | — | (only configured in .github/) |
| MySQL | Backend tests | check | — | Tests may mock DB |
| Vitest | Tests | yes | 3.1.3-4.1.8 | — |

**Missing dependencies with no fallback:** None — all critical tools are available.
**Missing dependencies with fallback:** Oxlint is undeclared; CI must install it, or planner can switch to `tsc --noEmit` for type-checking only and skip lint until oxlint is properly added.

---

## Validation Architecture

> This section is included because `nyquist_validation` is not explicitly set to `false` in `.planning/config.json` (the key is absent).

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest ^4.1.4 (backend) / ^3.1.3 (frontend) |
| Config file | `apps/db-ops-api/vitest.config.*` (none — backend uses default vitest config); `frontend/vitest.config.ts` |
| Quick run command | `cd apps/db-ops-api && npm test` (backend); `cd frontend && npx vitest run` (frontend) |
| Full suite command | `pnpm test` (both, from root) |

### Phase Requirements to Test Map
> No explicit requirement IDs were assigned to this phase. The work items (D-01 through D-16) are the implicit requirements.

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| D-01 | Fix 5 TODOs in tools | Unit | `vitest run` (backend) | Existing — tools have existing tests |
| D-04 | Delete Agent LLM tools | Compile | `vitest run` must pass | `llm-config-tools.test.ts` EXISTS — must be deleted with tools |
| D-06 | Dead code deletion | Compile | `tsc --noEmit` (frontend) | N/A — no typecheck script currently |
| D-09 | Vite alias rename | Compile | `vitest run` (frontend) | Must verify auto-reply imports resolve |
| D-14/D-15/D-16 | CI pipeline | CI | `pnpm test` | New — will be gated by CI |
| Test fix | Fix 88 failing tests | All | `pnpm test` | Must pass fully before enabling CI test steps |

### Sampling Rate
- **Per task commit:** `pnpm test` (quick check)
- **Per wave merge:** Full suite green
- **Phase gate:** `pnpm test` passes with 0 failures + `tsc --noEmit` passes (once configured)

### Wave 0 Gaps
- [ ] `vitest run` currently fails with 88 failures — must be fixed to 0 before CI test step is enabled
- [ ] No `tsc --noEmit` script exists in any package.json — needs to be added for CI typecheck
- [ ] Oxlint not currently installable — CI lint script needs oxlint in devDependencies
- [ ] No `.github/workflows/` directory — must be created

*(If no gaps: "None — existing test infrastructure covers all phase requirements")*

---

## Security Domain

> Security enforcement is not explicitly disabled in config. However, this phase has no new code that introduces security-sensitive functionality. RBAC scope implementation (D-02) touches authorization logic.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | — |
| V3 Session Management | no | — |
| V4 Access Control | yes (D-02 RBAC scope) | Instance permission filtering from request context |
| V5 Input Validation | no | — |
| V6 Cryptography | no | — |

### Known Threat Patterns for Cleanup Phase

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| RBAC scope bypass (D-02) | Elevation of Privilege | Filter get_instance_summary/list_active_alerts results by the authenticated user's instance permissions — never by a client-supplied parameter. Use `requestContext.userId`, not `args.userId`. |

---

## Sources

### Primary (HIGH confidence)
- [Codebase grep] — Verified file states: 5 TODO locations, 2 Agent tool sets to delete, 3 dead routing files, 30+ auto-reply files with broken imports, 2 `__openclaw` markers
- [CONTEXT.md] — All 16 decisions (D-01 through D-16) with locked requirements
- [npm registry: vitest] — Backend ^4.1.8, frontend ^3.2.6

### Secondary (MEDIUM confidence)
- [Codebase grep] — Confirmed oxlint is declared in root package.json scripts but NOT in devDependencies and NOT installed in node_modules
- [Test run results] — 70 backend + 18 frontend = 88 total failing tests (CONTEXT says 118 — discrepancy noted)
- [Codebase grep] — github.com/oxc-project/oxc verified as oxlint source

### Tertiary (LOW confidence)
- [CONTEXT "118 tests"] — Number may be stale; actual is 88

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - all tools confirmed by codebase scan and CONTEXT.md
- Architecture: HIGH - all patterns confirmed by codebase and CONTEXT.md
- Pitfalls: MEDIUM - auto-reply file disposition (A1) needs runtime verification
- CI details: MEDIUM - oxlint availability (A4) needs clarification

**Research date:** 2026-06-02
**Valid until:** 2026-07-02 (30 days — cleanup phase is stable)
