# Phase 116: 去 OpenClaw 运行时引用 - Research

**Researched:** 2026-06-02
**Domain:** 前端 runtime branding 替换（CLI 名、环境变量、数据目录、Symbol 键、消息文本）
**Confidence:** HIGH

## Summary

Phase 116 目标是将前端 runtime 代码中所有功能性 OpenClaw 引用替换为 Slide 自有标识。Phase 115 已清理注释/文本引用（38+ 文件），Phase 116 处理剩下的运行时引用：环境变量名、Symbol 键、数据目录路径、用户可见消息、导出函数名、CLI 命令显示文本、HTTP 头、对外 URL。

**核心发现补充 CONTEXT.md:**
1. `OPENCLAW_IMAGE_BACKEND` env var 未在 CONTEXT.md 中列出（image-ops.ts）
2. `"User-Agent": "OpenClaw-Gateway/1.0"` 是运行时 HTTP 头（input-files.ts），发送到外部服务 — 需要替换
3. `"openclaw plugins install"` 和 `"openclaw config set"` 显示文本在 install-hints.ts / diagnostics.ts 中 — 内容层引用
4. `PI_CODING_AGENT_DIR` env var 也有 openclaw 路径值（2 个 test-harness 文件）
5. vitest.config.ts 仍有 `@openclaw/ui` 别名，指向已不存在的目录
6. apps/db-ops-api 中有 `OpenClawSkillMetadata` 接口和 `extractOpenClawMetadata` 函数名需要重命名
7. `CONFIG_DIR` 被 stage-sandbox-media.ts 引用但其定义文件（`frontend/src/app/src/utils.ts`）不存在 — 可能是前序清理遗留的问题

**Primary recommendation:** 按 CONTEXT.md D-01/D-02 创建 `branding.ts` 作为单一真相源，然后分 4 个 Wave 逐步替换：Wave 1 基础（branding.ts + dead code），Wave 2 环境变量和 Symbol，Wave 3 用户可见消息，Wave 4 清理和测试同步。

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** 创建集中配置 `frontend/src/app/src/branding.ts`，定义 CLI 名、产品名、env var 前缀等。初始值设为 `slide`。所有引用点从该文件读取，后续改名只需改一处。
- **D-02:** 配置内容包括：`CLI_NAME = 'slide'`、`PRODUCT_NAME = 'Slide'`、`ENV_PREFIX = 'SLIDE'`、`STATE_DIR = '.slide'`
- **D-03:** 删除 `frontend/src/app/src/infra/update-startup.ts` — 整个文件是死代码（仅被 `import type` 引用，导入了 5 个不存在的模块）
- **D-04:** 清理相关 type import：`frontend/src/app/src/events.ts` 中的 `UpdateAvailable` 导入、`frontend/src/app/ui/types.ts` 中的 `UpdateAvailable` 类型定义
- **D-05:** 全部替换，不做 fallback。`OPENCLAW_*` → `SLIDE_*`。涉及 ~20 个 env var（`SLIDE_STATE_DIR`、`SLIDE_AGENT_DIR`、`SLIDE_TEST_FAST` 等）
- **D-06:** `__OPENCLAW_CONTROL_UI_BASE_PATH__` → `__SLIDE_CONTROL_UI_BASE_PATH__`
- **D-07:** `~/.openclaw/` → `~/.slide/`（含子目录 `agents/`、`sessions/`、`media/`）
- **D-08:** 所有用户可见消息中的 `OpenClaw` → `Slide`：版本信息（status.ts:832 `🦞 OpenClaw`）、重启提示（commands-session.ts）、MCP 配置描述（commands-registry.shared.ts）、系统消息（inbound-meta.ts）
- **D-09:** CLI 命令显示文本：`"run openclaw"` → `"run slide"`（tool-display-exec.ts）
- **D-10:** 工具分组名：`"group:openclaw"` → `"group:slide"`，`includeInOpenClawGroup` → `includeInSlideGroup`（tool-catalog.ts）
- **D-11:** `Symbol.for("openclaw.*")` → `Symbol.for("slide.*")`（~8 处）
- **D-12:** SQL schema 注释：`OpenClaw-compatible` → `DAG-compatible`（3 处）
- **D-13:** CSS 注释：`OpenClaw theme system` → `Slide theme system`（2 处）
- **D-14:** Plugin 默认格式：`plugin.format ?? "openclaw"` → `"slide"`（commands-plugins.ts）
- **D-15:** 外部 URL（GitHub issues、docs）→ 更新为 Slide repo 地址或移除
- **D-16:** 所有测试文件中的 `OPENCLAW_*` 环境变量同步更新
- **D-17:** 更新断言中包含 `"OpenClaw"` 的测试用例

### Claude's Discretion
- `branding.ts` 的具体结构和导出方式
- 替换顺序和策略（按模块逐步替换 vs 全局搜索替换）
- 是否需要迁移脚本帮助用户从 `~/.openclaw/` 迁移到 `~/.slide/`
- 外部 URL 无法确定时，删除注释中的死链

### Deferred Ideas (OUT OF SCOPE)
- 如果将来需要更新/重启等 CLI 功能重新实现，在 `branding.ts` 配置下开发，不再硬编码 CLI 名
- `~/.openclaw/` 到 `~/.slide/` 的数据迁移脚本 — 如果需要，作为单独任务加入 Plan
</user_constraints>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| 环境变量引用 | 前端 runtime (auto-reply, media) | — | 所有 OPENCLAW_* env var 在 agent 引擎端运行时读取 |
| Symbol 键 | 前端 runtime (reply pipeline) | — | Symbol.for("openclaw.*") 是运行时全局键，只在 agent 引擎进程内可见 |
| 数据目录路径 | 前端 runtime (test harnesses) | — | ~/.openclaw/ 路径写死在测试辅助文件中，运行时通过 env var 覆盖 |
| 用户可见消息 | 前端 runtime (reply pipeline) | — | OpenClaw 出现在版本、重启、MCP 等 status/reply 生成中 |
| CLI 名显示文本 | 前端 runtime (display helpers) | — | "run openclaw" / "openclaw plugins install" 等是显示用文本，不执行进程 |
| HTTP User-Agent | 前端 runtime (media input) | — | "OpenClaw-Gateway/1.0" 是出站 HTTP 请求的 User-Agent 头 |
| UI base path | 前端 UI (Lit components) | — | window.__OPENCLAW_CONTROL_UI_BASE_PATH__ 在 UI 层读取 |
| 工具分组命名 | 前端 runtime (tool catalog) | — | includeInOpenClawGroup / "group:openclaw" 在 tool-catalog.ts 内部 |
| OpenClawConfig 类型 | 前端 runtime (~90 files import) | — | 跨层共享的配置类型，从 config/types.ts 分发到 auto-reply + media |
| SQL schema 注释 | 数据库 schema | — | migrations 和 schema.sql 中的 API 注释 |
| CSS 注释 | 前端样式 | — | styles/global.css 中的主题系统注释 |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| branding.ts | — | 集中品牌配置 | D-01 锁定决策，不生新依赖 |

No new npm packages needed. This phase is purely code rename/replace within the existing TypeScript codebase.

### Installation
No new packages. The only dependency risk is the `@openclaw/ui` alias in `vitest.config.ts` pointing to a deleted directory — this already breaks the vitest config and must be removed.

## Package Legitimacy Audit

**Not applicable** — Phase 116 installs no external packages. The only package-related finding is the dead `@openclaw/ui` vitest alias.

## Architecture Patterns

### Recommended Branding Structure (branding.ts)

```typescript
// frontend/src/app/src/branding.ts
// Single source of truth for Slide branding strings.
// Always import from here; never hardcode CLI names or env prefixes.

/** CLI binary name shown to users (e.g., "slide", "openclaw") */
export const CLI_NAME = "slide" as const;

/** Human-readable product name (e.g., "Slide", "OpenClaw") */
export const PRODUCT_NAME = "Slide" as const;

/** Prefix for environment variables (e.g., "SLIDE", "OPENCLAW") */
export const ENV_PREFIX = "SLIDE" as const;

/** State directory name (e.g., ".slide", ".openclaw") */
export const STATE_DIR = ".slide" as const;

/** Build env var name from suffix: buildEnvVar("STATE_DIR") => "SLIDE_STATE_DIR" */
export function buildEnvVar(suffix: string): string {
  return `${ENV_PREFIX}_${suffix}`;
}

/** Build Symbol key within product namespace: buildSymbolKey("foo") => "slide.foo" */
export function buildSymbolKey(key: string): string {
  return `${PRODUCT_NAME.toLowerCase()}.${key}`;
}

/** Build CLI command display text: buildCliCmd("update") => "slide update" */
export function buildCliCmd(sub?: string): string {
  return sub ? `${CLI_NAME} ${sub}` : CLI_NAME;
}
```

**Files imported from branding.ts:**
- All files currently hardcoding "openclaw" for display (tool-display-exec.ts, install-hints.ts, diagnostics.ts)
- All files currently hardcoding "OPENCLAW_" env var names (image-ops.ts, get-reply-run.ts, etc.)
- All files currently hardcoding Symbol.for("openclaw.*") (inbound-dedupe.ts, get-reply-fast-path.ts, etc.)

### Dead Code Removal Pattern

`update-startup.ts` (527 lines) is confirmed dead:
1. Only referenced via `import type { UpdateAvailable }` from `events.ts` and `ui/types.ts`
2. All 5 internal imports (`OpenClawConfig`, `resolveOpenClawPackageRoot`, etc.) point to non-existent or unused modules
3. No test file references it
4. Its exports (`UpdateAvailable`, `UpdateCheckState`) are only used as types with no runtime behavior

**Removal:**
1. Delete `frontend/src/app/src/infra/update-startup.ts`
2. Delete `import type { UpdateAvailable }` from `frontend/src/app/src/events.ts`
3. Delete line 1 of `frontend/src/app/ui/types.ts` (`export type UpdateAvailable = ...`)
4. Verify no other imports reference update-startup (confirmed: only those 2)

### OpenClawConfig Type Migration Pattern

`OpenClawConfig` is imported in ~90 files. Two approaches:

**Approach A (Recommended):** Rename the type to `SlideConfig` in `config/types.ts`, update all 90 imports in one pass. This is the cleanest but requires touching many files.

**Approach B (Conservative):** Add `type SlideConfig = OpenClawConfig` alias, keep both. This creates technical debt but splits the change into two phases.

**Recommendation for planner:** Since Phase 116 is explicitly "replace all runtime references," Approach A is preferred. The rename is mechanical (search-and-replace on `OpenClawConfig` → `SlideConfig` across the codebase), affecting ~90 files, and can be done as a single automated task.

### Anti-Patterns to Avoid

- **Partial env var rename:** Renaming some OPENCLAW_ vars but not others (D-05 says "全部替换，不做 fallback")
- **Leaving dead import lines:** After deleting update-startup.ts, verify no stray imports remain
- **Branding string in compiled output:** After changing HTTP User-Agent header, verify no pre-compiled dist/ files contain old string
- **Inconsistent Symbol namespace:** All 8 Symbol.for("openclaw.*") must change atomically; mismatched symbols silently break runtime deduplication
- **Test harness drift:** Test harnesses must match the new env var and path names, or tests silently fail

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Branding config | — | branding.ts (new file) | No existing lib handles this — it's a project-internal concern |

No third-party library alternatives exist for this domain. This is pure code rename within the project's own TypeScript codebase.

## Runtime State Inventory

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — env vars are runtime process state, not persisted | None |
| Live service config | `dist/` assets with compiled OpenClaw strings (frontend/dist/assets/index-D0hyYlTP.js) | Rebuild after source changes |
| OS-registered state | None — temp dirs created at runtime (`openclaw-triggers-suite-`, `openclaw-img-`) change with code | Code edit in test-harness and image-ops |
| Secrets/env vars | OPENCLAW_* env vars are runtime-only, not persisted in any .env file checked into git | Code edit only |
| Build artifacts | `@openclaw/ui` alias in vitest.config.ts referencing deleted directory | Remove alias |

**Nothing found:** No persistence, no OS-level registrations, no live services configuration referencing these strings.

## Common Pitfalls

### Pitfall 1: Symbol Key Inconsistency
**What goes wrong:** Runtime deduplication silently breaks if one Symbol.for("slide.*") key doesn't match the rest.
**Why it happens:** 8 separate Symbol keys spread across 5 files. A grep miss leaves one key with "openclaw." prefix.
**How to avoid:** Do all 8 replacements in a single task/commit. Verify with `grep -rn 'Symbol\.for.*slide\.'` after changes.
**Warning signs:** Duplicate message processing, stale cache not clearing.

### Pitfall 2: Test Harness Env Var Drift
**What goes wrong:** Tests pass locally but fail in CI because env vars changed.
**Why it happens:** Test harnesses set OPENCLAW_STATE_DIR, OPENCLAW_AGENT_DIR, OPENCLAW_HOME as part of setup. If production code reads SLIDE_STATE_DIR but test harness still sets OPENCLAW_STATE_DIR, tests use the wrong env var.
**How to avoid:** Change both sides (production code + test harness) atomically.
**Warning signs:** Tests pass but runtime production paths are wrong (false negative in tests).

### Pitfall 3: HTTP User-Agent Breaking External Services
**What goes wrong:** Changing User-Agent from "OpenClaw-Gateway/1.0" to "Slide-Gateway/1.0" could affect server-side analytics or allowlisting.
**Why it happens:** Some services may identify clients by User-Agent.
**How to avoid:** Use branding.ts to make the string configurable. No external service in this project's domain likely relies on this specific UA string, but document the change.
**Warning signs:** N/A — informational only.

### Pitfall 4: `PI_CODING_AGENT_DIR` — Should It Change?
**What goes wrong:** 2 test-harness files set `process.env.PI_CODING_AGENT_DIR` with `.openclaw` values. The env var name contains no "OPENCLAW", but its value references `.openclaw` directly. If `PI_CODING_AGENT_DIR` is used by production code that reads it via a different mechanism, changing only the env var name but not the value could break.
**How to avoid:** Verify whether `PI_CODING_AGENT_DIR` is used outside the test harnesses. If it's read by some process, the path value also needs to change to `.slide`. The env var name itself does NOT contain "openclaw" so it's not part of D-05 scope, but its value must be updated from `.openclaw` to `.slide`.

## Code Examples

Verified patterns from codebase analysis:

### branding.ts Structure
```typescript
// Source: Planner discretion per CONTEXT.md Claude's Discretion.
// Recommended structure:
export const CLI_NAME = "slide";
export const PRODUCT_NAME = "Slide";
export const ENV_PREFIX = "SLIDE";
export const STATE_DIR = ".slide";

// Helper functions reduce duplication across the codebase
export function buildEnvVar(suffix: string): string {
  return `${ENV_PREFIX}_${suffix}`;
}
export function buildSymbolKey(key: string): string {
  return `${PRODUCT_NAME.toLowerCase()}.${key}`;
}
export function buildCliCmd(sub?: string): string {
  return sub ? `${CLI_NAME} ${sub}` : CLI_NAME;
}
export function buildUserAgent(): string {
  return `${PRODUCT_NAME}-Gateway/1.0`;
}
```

### Symbol Key Replacement Pattern
```typescript
// Before (inbound-dedupe.ts):
const INBOUND_DEDUPE_CACHE_KEY = Symbol.for("openclaw.inboundDedupeCache");

// After:
import { buildSymbolKey } from "../branding.js";
const INBOUND_DEDUPE_CACHE_KEY = Symbol.for(buildSymbolKey("inboundDedupeCache"));
```
Or simpler inline:
```typescript
const INBOUND_DEDUPE_CACHE_KEY = Symbol.for("slide.inboundDedupeCache");
```
(Inline is simpler and more performant; `branding.ts` helper adds indirection but makes future renames one-line.)

### Env Var Replacement Pattern
```typescript
// Before (image-ops.ts):
process.env.OPENCLAW_IMAGE_BACKEND === "sips"

// After (using branding.ts helper):
import { buildEnvVar } from "../branding.js";
process.env[buildEnvVar("IMAGE_BACKEND")] === "sips"

// Or inline (simpler):
process.env.SLIDE_IMAGE_BACKEND === "sips"
```

### CLI Display Text Replacement
```typescript
// Before (tool-display-exec.ts):
if (bin === "openclaw") {
  return sub ? `run openclaw ${sub}` : "run openclaw";
}

// After:
import { CLI_NAME, buildCliCmd } from "../branding.js";
if (bin === CLI_NAME) {
  return sub ? `run ${buildCliCmd(sub)}` : `run ${CLI_NAME}`;
}
```

### HTTP User-Agent Replacement
```typescript
// Before (input-files.ts):
headers: { "User-Agent": "OpenClaw-Gateway/1.0" }

// After:
import { buildUserAgent } from "../branding.js";
headers: { "User-Agent": buildUserAgent() }
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| 硬编码 OpenClaw 字符串散落 ~120 文件 | 集中 branding.ts + 单次替换 | Phase 116 | 未来品牌变更只需改 branding.ts 一处 |

**Deprecated/outdated:**
- `update-startup.ts` 整文件 — 死代码 from OpenClaw 时代，导入的 5 个模块不存在
- `@openclaw/ui` vitest 别名 — 指向已删除的目录

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `PI_CODING_AGENT_DIR` 只出现在 2 个 test-harness 文件中，生产代码不读取 | Runtime State Inventory | 低 — 已验证 grep 结果 |
| A2 | `CONFIG_DIR` 定义在已删除的 `utils.ts` 中，`stage-sandbox-media.ts` 的导入当前会失败 | Architecture | 中 — 如果 `utils.ts` 实际存在于编译路径中，说明我未找到该文件；需要确认该文件状态 |
| A3 | `@openclaw/ui` vitest 别名当前已断（目标目录不存在） | Standard Stack | 低 — 已验证目录不存在 |

## Open Questions

1. **`CONFIG_DIR` 在哪里定义？**
   - What we know: `stage-sandbox-media.ts` imports it from `../../utils.js` (resolves to `frontend/src/app/src/utils.js`), but no `utils.ts` exists in that directory nor anywhere in the frontend tree.
   - What's unclear: Whether this file was deleted in a previous phase, whether the import is currently broken, or whether it resolves through a tsconfig path mapping.
   - Recommendation: Before planning, run `tsc --noEmit` to check if this is a current compilation error. If broken, file this as a pre-existing issue. If not broken, find where CONFIG_DIR is actually defined and ensure the `.openclaw` path component is updated.

2. **apps/db-ops-api 中的 OpenClawAdapter 注释应该清理吗？**
   - What we know: Comments mention OpenClawAdapter as historical adapter name, but the code no longer uses it.
   - What's unclear: Phase 115 said "清理注释/文本引用" but the apps/ directory may not have been included in Phase 115 scope. Phase 116 says "前端 runtime 代码".
   - Recommendation: Since the CONTEXT.md D-12/D-13 include SQL and CSS comments but not apps/src comments, these are likely out of scope for Phase 116. Verify with discuss-phase.

3. **外部 URL 无法确定替换目标时怎么处理？**
   - What we know: Multiple github.com/openclaw/openclaw/issues/* URLs in comments. No Slide equivalent exists.
   - What's unclear: Should these become dead links, point to the Slide repo (which doesn't have these issues), or be removed?
   - Recommendation: For GitHub issue URLs (comment context), remove the URL and keep the contextual code comment. For docs.openclaw.ai URL (bash-command.ts:199), remove or replace with a generic note since no equivalent Slide docs exist yet.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| tsc / tsx | Code compilation check | ✓ (frontend project setup) | — | — |
| grep / find | Verification commands | ✓ (macOS built-in) | — | — |
| vitest | Test verification | ✓ (in frontend/) | — | — |

**Missing dependencies with no fallback:** None.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (configured in `frontend/vitest.config.ts`) |
| Config file | `frontend/vitest.config.ts` |
| Quick run command | `cd frontend && npx vitest run --reporter=verbose 2>&1 \| tail -30` |
| Full suite command | `cd frontend && npx vitest run 2>&1 \| tail -50` |

### Phase Requirements → Test Map

No explicit requirement IDs exist for this phase (listed as TBD). Derive from D-01 through D-17:

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REQ-D05 | No OPENCLAW_* env var refs remain in src/ | grep | `grep -rn 'OPENCLAW_' frontend/src/ --include="*.ts" \| grep -v node_modules \| wc -l` should be 0 | grep (manual check) |
| REQ-D07 | No ~/.openclaw path refs remain in src/ | grep | `grep -rn '\.openclaw' frontend/src/ --include="*.ts" \| grep -v node_modules \| wc -l` should be 0 | grep (manual check) |
| REQ-D11 | No Symbol.for("openclaw.*") refs remain | grep | `grep -rn 'Symbol\.for.*openclaw' frontend/src/ --include="*.ts" \| wc -l` should be 0 | grep (manual check) |
| REQ-D08-D10 | No user-visible "OpenClaw" strings remain in runtime code | grep | `grep -rn '"OpenClaw\|OpenClaw ' frontend/src/app/src/ --include="*.ts" \| grep -v node_modules \| grep -v '^\s*//\|^\s*\*' \| wc -l` should be 0 | grep (manual check) |
| REQ-D04 | update-startup.ts deleted | file check | `test ! -f frontend/src/app/src/infra/update-startup.ts` | bash (manual check) |
| REQ-D15 | No github.com/openclaw/openclaw URLs remain | grep | `grep -rn 'github.com/openclaw/openclaw' frontend/src/ --include="*.ts" \| wc -l` should be 0 | grep (manual check) |

### Sampling Rate
- **Per task commit:** Quick grep of the specific pattern being changed
- **Per wave merge:** Full grep sweep for all remaining OpenClaw patterns
- **Phase gate:** Full vitest suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `frontend/tests/` — no existing test specifically validates brand string consistency (this phase's changes are verified via grep, not vitest)
- [ ] No new vitest tests needed — verification is grep-based

## Security Domain

**Not applicable** — Phase 116 does not change authentication, input validation, cryptography, or access control. It is purely a branding rename exercise. All replaced strings are cosmetic or runtime-internal (env vars, symbols, display text). No security boundaries are crossed.

## Sources

### Primary (HIGH confidence)
- Codebase grep — exhaustive scan of `frontend/src/` for all "openclaw", "OPENCLAW", "OpenClaw", ".openclaw" patterns
- Codebase grep — scan of `apps/db-ops-api/src/` and `apps/db-ops-api/sql/` for same patterns
- File existence check — `update-startup.ts`, `src/openclaw/` directory

### Secondary (MEDIUM confidence)
- CONTEXT.md comparison — all claimed findings verified against actual codebase state

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - verified by codebase analysis, no new packages needed
- Architecture: HIGH - branding.ts pattern confirmed as correct approach
- Pitfalls: HIGH - each verified against actual code patterns

**Research date:** 2026-06-02
**Valid until:** 2026-07-02 (stable code rename, no fast-moving dependencies)
