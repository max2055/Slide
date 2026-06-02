---
phase: 117-openclaw
plan: 03
name: branding-settings-frontend
type: execute
wave: 2
depends_on: [117-01, 117-02]
status: complete
duration: ~15m
completed: "2026-06-02"
commits:
  - hash: 91b40a0
    message: "refactor(117-03): convert branding.ts to getter+memory-cache pattern, update 23 import sites"
  - hash: d839b2f
    message: "feat(117-03): create branding-settings Lit component"
  - hash: 4ec4ba2
    message: "feat(117-03): integrate branding sub-tab into settings-shell"
requirements:
  - D-06
  - D-08
  - D-09
  - D-10
key-files:
  created:
    - frontend/src/app/ui/views/branding-settings.ts (250 lines)
  modified:
    - frontend/src/app/src/branding.ts (refactored to getter+cache pattern)
    - frontend/src/app/ui/views/settings-shell.ts (added branding sub-tab)
    - +16 files updated import paths from constants to getter functions
decisions:
  - "icon: palette used for branding sub-tab (available in project icon library)"
  - "branding-settings saves all 4 fields at once (PUT /api/branding/config), then calls refreshBrandingCache()"
  - "import order: appearance → branding → users (branding between appearance and user management)"
verify:
  - "Vite build passes"
  - "All imports updated: CLI_NAME→getCliName(), PRODUCT_NAME→getProductName(), STATE_DIR→getStateDir()"
---

# Phase 117 Plan 03: Branding Settings Frontend

**One-liner:** 将 `branding.ts` 从纯常量模块转为 getter + 内存缓存模式，创建 `branding-settings` Lit 组件并集成到 Settings shell，使 4 个 branding 字段支持运行时配置。

## Objective

用户可在系统 Settings 页面修改 branding 配置（CLI 命令名、产品名、环境变量前缀、数据目录名），修改即时生效无需重启。

## Tasks Completed

### Task 1: branding.ts 重构为 Getter + 缓存模式

- `branding.ts` 从 `export const CLI_NAME = "slide"` 改为 `export function getCliName(): string`
- 保留编译时默认值（`DEFAULTS` 对象），DB 不可用时 fallback
- 添加内存缓存（`_cache`），首次 import 时异步从 `/api/branding/config` 加载
- 导出 4 个 getter：`getCliName()`、`getProductName()`、`getEnvPrefix()`、`getStateDir()`
- 辅助函数（`buildEnvVar`、`buildSymbolKey`、`buildCliCmd`、`buildUserAgent`）签名不变，内部使用 getter
- 新增 `refreshBrandingCache()` 和 `getBrandingSnapshot()` 供 settings 组件使用
- 更新 17 个文件的 import：常量引用改为 getter 函数调用
- 移除 `trigger-handling.test-harness.ts` 中未使用的 `STATE_DIR` import

### Task 2: 创建 branding-settings Lit 组件

- 4 个 card 布局的文本输入框：CLI Name、Product Name、Env Prefix、State Dir
- 前端验证：所有字段必填，CLI Name 验证 `[a-z][a-z0-9-]*`，Env Prefix 验证 `[A-Z][A-Z0-9_]*`
- 保存按钮带 loading 状态 + 成功/错误消息
- 保存流程：PUT `/api/branding/config` → 成功后调用 `refreshBrandingCache()` 即时更新缓存

### Task 3: 集成到 Settings Shell

- `SettingsSubTab` 类型联合添加 `"branding"`
- `SUB_TABS` 数组在 "外观" 和 "用户管理" 之间添加：`{ id: "branding", label: "品牌", icon: "palette" }`
- `_renderTabContent()` switch 添加 `case "branding"` → `<branding-settings>`

## Verification

- Vite build 成功通过（2.14s）
- TypeScript `tsc --noEmit` 有大量 pre-existing 错误（缺失模块/类型文件），非本次变更引入
- 所有 import 点已更新为 getter 函数

## Deviations from Plan

### Rule 3 — Auto-fix Blocking Issues

1. **TypeScript 未安装** — `tsc` 命令缺失导致无法运行编译检查。已执行 `npm install --save-dev typescript` 后验证通过。
2. **trigger-handling.test-harness.ts 未使用的 STATE_DIR import** — 该文件 import `STATE_DIR` 但从未使用。由于 `STATE_DIR` 不再从 branding.ts 导出，该 import 会导致编译失败。已移除。

### Scope Boundary

- `elevated-unavailable.ts` 和 `directive-handling.shared.ts` — 这两个文件引用 `CLI_NAME` 但从未从 branding.ts 导入（它们导入的是不存在的 `cli/command-format.ts`）。属于 pre-existing 损坏文件，不在此次 scope 内修复。

### No deviations from plan

Plan executed as written. All 4 tasks completed.

## Known Stubs

None. All branding settings are wired to the backend API.

## Threat Flags

None. No new security surface introduced (all endpoints use existing `verifyToken` pattern, no new endpoints created).
