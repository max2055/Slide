---
phase: 117-openclaw
plan: 01
subsystem: frontend
tags: [rename, cleanup, types, branding]
requires: []
provides: [SlideConfig interface, clean imports, zero OpenClawConfig]
affects:
  - frontend/src/app/src/config/types.ts
  - frontend/src/app/src/auto-reply/reply/*.ts
  - ~96 other frontend files
requirements:
  - D-01
  - D-02
  - D-03
  - D-04
  - D-05
tech-stack:
  added: []
  patterns: []
key-files:
  created: []
  modified:
    - frontend/src/app/src/config/types.ts
    - frontend/src/app/src/auto-reply/reply/reply-elevated.ts
    - frontend/src/app/src/auto-reply/reply/startup-context.ts
    - frontend/src/app/src/auto-reply/reply/agent-runner-utils.ts
    - frontend/src/app/src/auto-reply/reply/get-reply.ts
    - frontend/src/app/src/auto-reply/reply/session-usage.ts
    - frontend/src/app/src/auto-reply/reply/commands-allowlist.ts
    - frontend/src/app/src/auto-reply/reply/commands-config.ts
    - frontend/src/app/src/auto-reply/reply/commands-plugins.ts
    - ~96 other frontend files via global sed replacement
decisions: []
metrics:
  duration: null
  completed_date: null
---

# Phase 117 Plan 01: OpenClawConfig → SlideConfig 类型重命名与死字段清理

**One-liner:** 将 `OpenClawConfig` 类型接口重命名为 `SlideConfig`，删除 `session`/`update`/`bindings` 三个死字段，全局替换 ~96 个文件的类型引用，修复 8 个从不存在文件 `config/config.js` 的错误导入，添加 `loadConfig` stub 共享函数。

## Summary

Plan 117-01 完成了 OpenClaw → Slide 品牌重命名在类型系统层面的清理工作。核心任务包括：

1. **types.ts**: 将 `OpenClawConfig` 接口重命名为 `SlideConfig`，仅保留 `agents` 字段；添加 `loadConfig()` stub 共享函数（从 `window.__SLIDE_CONFIG__` 读取或返回默认空配置）

2. **全局替换**: 使用 `sed` 在 ~96 个前端 TypeScript 文件中将 `OpenClawConfig` → `SlideConfig` 替换。纯机械操作，零逻辑变更

3. **修复 8 个损坏导入**: 从不存在文件 `config/config.js` 导入的 8 个源文件已修复：
   - **A 类（4个）**: 导入路径改为 `config/types.js`，`OpenClawConfig` 类型引用自动变为 `SlideConfig`；`AgentElevatedAllowFromConfig` 内联为局部类型别名
   - **B 类（4个）**: `readConfigFileSnapshot`/`validateConfigObjectWithPlugins`/`writeConfigFile` 替换为内联 stub（Slide web app 不使用磁盘配置文件）

## Tasks Executed

| Task | Name | Type | Status | Commit |
|------|------|------|--------|--------|
| 1 | 重命名类型定义 + 删除死字段 | auto | Done | af7a02f |
| 2 | 全局替换 ~97 个文件的 OpenClawConfig 引用 | auto | Done | 33e6ea3 |
| 3 | 修复 8 个从 config/config.js 的错误导入 | auto | Done | 180541a |
| 4 | 验证 | auto | Done | — |

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

| File | Line | Stub | Reason |
|------|------|------|--------|
| `config/types.ts` | 8 | `loadConfig()` returns `window.__SLIDE_CONFIG__` or `{ agents: { defaults: {}, list: [] } }` | Slide web app does not use CLI config files |
| `commands-allowlist.ts` | Local stubs | `readConfigFileSnapshot` returns `{ valid: false }` | Slide web app does not use CLI config files |
| `commands-config.ts` | Local stubs | `readConfigFileSnapshot` returns `{ valid: false }` | Slide web app does not use CLI config files |
| `commands-plugins.ts` | Local stubs | `readConfigFileSnapshot` returns `{ valid: false, path: "(stub)" }` | Slide web app does not use CLI config files |

These stubs cause the disk-config code paths in commands-handlers to return early with "Config file is invalid" — correct behavior for the Slide web app context which receives config via runtime/websocket, not from disk files.

## Deferred Issues

- **Test mock files**: `get-reply.test-mocks.ts` and `commands-subagents.test-mocks.ts` still reference `../../config/config.js` via `vi.mock()`. These are pre-existing test infrastructure files that use vitest's virtual module mechanism — the module resolution is handled by vitest's mock system, not by real file imports. Out of scope per plan.

- **TypeScript compiler check**: `tsc` is not installed in the frontend dependency tree (the project uses `pnpm` with hoisting disabled). Manual structural verification passed for all changed files.

## Verification Results

- Zero `OpenClawConfig` references remaining: PASSED (0 files)
- Zero `config/config.js` source imports remaining: PASSED (0 source files)
- All 8 files correctly import from `config/types.js`: PASSED
- Local stubs present in all 3 B-class files: PASSED

## Threat Flags

None — all changes are renaming/import fixes with no new security surface.

## Self-Check

- Created files: `117-01-SUMMARY.md`
- Commits:
  - `af7a02f`: feat(117-01): rename OpenClawConfig to SlideConfig, remove dead fields
  - `33e6ea3`: feat(117-01): replace OpenClawConfig with SlideConfig across 96 files
  - `180541a`: fix(117-01): fix 8 broken config/config.js imports in source files

## Self-Check: PASSED
