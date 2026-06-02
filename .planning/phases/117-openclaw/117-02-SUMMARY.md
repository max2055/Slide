---
phase: 117-openclaw
plan: 02
subsystem: api
tags: [fastify, mysql, system_config, branding, config-service]

requires:
  - phase: 116-04
    provides: frontend/src/app/src/branding.ts 常量定义
provides:
  - BrandingConfigService（getBranding / saveBranding）
  - GET /api/branding/config
  - PUT /api/branding/config
affects: [frontend settings UI (future plan)]

tech-stack:
  added: []
  patterns:
    - "system_config 表 CRUD（REPLACE INTO + JSON 存储）"
    - "读取时与 DEFAULTS 合并，fallback 保护"
    - "验证规则：cli_name 小写字母+连字符，env_prefix 大写字母+下划线"

key-files:
  created:
    - apps/db-ops-api/src/branding-config-service.ts
  modified:
    - apps/db-ops-api/server.ts

key-decisions:
  - "GET 和 PUT 均使用 verifyToken 中间件保护（与 scoring-config-service 一致）"
  - "PUT 支持部分更新（读取当前值后 merged，再 REPLACE INTO）"
  - "验证失败时使用 HTTP 400，含中文错误描述"

patterns-established:
  - "CONFIG_KEY = 'branding.config'，符合 scoring.weights / auto_analysis_config 命名约定"
  - "类结构 + 单例导出，与 ai-analysis-config-service / scoring-config-service 一致"

requirements-completed: [D-06, D-07, D-08]

duration: 15min
completed: 2026-06-02
---

# Phase 117 Plan 02: Branding Config Service Summary

**Branding 配置 CRUD 服务，复用 system_config 表持久化 4 个 branding 字段，提供 GET/PUT API 端点**

## Performance

- **Duration:** 15 min
- **Started:** 2026-06-02T15:13:00Z
- **Completed:** 2026-06-02T15:28:00Z
- **Tasks:** 3
- **Files modified:** 2

## Accomplishments

- 创建 `BrandingConfigService`：读取时与 DEFAULTS 合并，写入时验证 + REPLACE INTO 持久化
- GET `/api/branding/config`：返回全部 4 个 branding 字段（cli_name, product_name, env_prefix, state_dir）
- PUT `/api/branding/config`：支持部分更新，对 cli_name / env_prefix 做正则验证
- 两个端点均受 verifyToken 中间件保护，仅已认证用户可访问
- 全部验证规则已通过端到端测试

## Task Commits

Each task was committed atomically:

1. **Task 1: Create BrandingConfigService** - `8fb0f4f` (feat)
2. **Task 2: Register API routes** - `0c15ff8` (feat)
3. **Task 3: Verification** - end-to-end curl tests, all passed

## Files Created/Modified

- `apps/db-ops-api/src/branding-config-service.ts` (NEW, 164 lines) - BrandingConfigService with getBranding() / saveBranding()
- `apps/db-ops-api/server.ts` - Added import + GET/PUT routes

## Decisions Made

- GET 和 PUT 均使用 verifyToken 保护，而非仅 PUT 保护前者 — 保持与 scoring-config-service 一致，且防止未认证用户读取系统品牌配置
- PUT 支持部分更新（与 scoring-config-service 不同，后者要求全量提交）— 前端 UI 典型场景是逐字段修改
- 验证错误使用 HTTP 400 + 中文描述，与后端现有模式一致

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- **cwd drift bug:** 首次写入 `branding-config-service.ts` 时使用了主仓库的绝对路径（`/Users/max/Coding/40-Slide/apps/db-ops-api/src/...`），而非 worktree 路径。这导致 git commit 意外进入了 `feat/standalone-cleanup` 分支而非 worktree 分支。已通过复制文件到 worktree 并重新在 worktree 分支上提交修复。后续所有 Write/Edit 操作均使用 worktree 路径。

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: auth_gate | apps/db-ops-api/server.ts | GET /api/branding/config 和 PUT /api/branding/config 受 verifyToken 保护，非公开端点 |

## Known Stubs

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Branding config 后端 API 完成，前端 Settings UI 可以对接
- 下一计划（117-03）可以处理前端 branding 设置页面的构建

---
*Phase: 117-openclaw*
*Completed: 2026-06-02*
