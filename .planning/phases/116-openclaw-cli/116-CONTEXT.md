# Phase 116: 去 OpenClaw 运行时引用 - Context

**Gathered:** 2026-06-02
**Status:** Ready for planning

## Phase Boundary

将前端 runtime 代码中的 `openclaw` CLI 二进制名、环境变量、数据目录、Symbol 键、用户可见消息全部替换为 Slide 自有标识。Phase 115 清理了注释/文本引用，Phase 116 处理剩下的功能性引用。

**代码调查关键发现：** `update-startup.ts` 是死代码（只被 `import type` 引用，导入了 5 个不存在的文件），可以直接删除。大部分 "CLI 调用" 其实是显示文本，不执行进程。

## Implementation Decisions

### Branding 配置
- **D-01:** 创建集中配置 `frontend/src/app/src/branding.ts`，定义 CLI 名、产品名、env var 前缀等。初始值设为 `slide`。所有引用点从该文件读取，后续改名只需改一处。
- **D-02:** 配置内容包括：`CLI_NAME = 'slide'`、`PRODUCT_NAME = 'Slide'`、`ENV_PREFIX = 'SLIDE'`、`STATE_DIR = '.slide'`

### 死代码处理
- **D-03:** 删除 `frontend/src/app/src/infra/update-startup.ts` — 整个文件是死代码（仅被 `import type` 引用，导入了 5 个不存在的模块）
- **D-04:** 清理相关 type import：`frontend/src/app/src/events.ts` 中的 `UpdateAvailable` 导入、`frontend/src/app/ui/types.ts` 中的 `UpdateAvailable` 类型定义

### 环境变量
- **D-05:** 全部替换，不做 fallback。`OPENCLAW_*` → `SLIDE_*`。涉及 ~20 个 env var（`SLIDE_STATE_DIR`、`SLIDE_AGENT_DIR`、`SLIDE_TEST_FAST` 等）
- **D-06:** `__OPENCLAW_CONTROL_UI_BASE_PATH__` → `__SLIDE_CONTROL_UI_BASE_PATH__`

### 数据目录
- **D-07:** `~/.openclaw/` → `~/.slide/`（含子目录 `agents/`、`sessions/`、`media/`）

### 用户可见文本
- **D-08:** 所有用户可见消息中的 `OpenClaw` → `Slide`：版本信息（status.ts:832 `🦞 OpenClaw`）、重启提示（commands-session.ts）、MCP 配置描述（commands-registry.shared.ts）、系统消息（inbound-meta.ts）
- **D-09:** CLI 命令显示文本：`"run openclaw"` → `"run slide"`（tool-display-exec.ts）
- **D-10:** 工具分组名：`"group:openclaw"` → `"group:slide"`，`includeInOpenClawGroup` → `includeInSlideGroup`（tool-catalog.ts）

### Symbol 键
- **D-11:** `Symbol.for("openclaw.*")` → `Symbol.for("slide.*")`（~8 处）

### 其他引用
- **D-12:** SQL schema 注释：`OpenClaw-compatible` → `DAG-compatible`（3 处）
- **D-13:** CSS 注释：`OpenClaw theme system` → `Slide theme system`（2 处）
- **D-14:** Plugin 默认格式：`plugin.format ?? "openclaw"` → `"slide"`（commands-plugins.ts）
- **D-15:** 外部 URL（GitHub issues、docs）→ 更新为 Slide repo 地址或移除

### 测试
- **D-16:** 所有测试文件中的 `OPENCLAW_*` 环境变量同步更新（~15 个测试文件）
- **D-17:** 更新断言中包含 `"OpenClaw"` 的测试用例

### Claude's Discretion
- `branding.ts` 的具体结构和导出方式
- 替换顺序和策略（按模块逐步替换 vs 全局搜索替换）
- 是否需要迁移脚本帮助用户从 `~/.openclaw/` 迁移到 `~/.slide/`
- 外部 URL 无法确定时，删除注释中的死链

## Canonical References

### Phase 115 遗留上下文
- `.planning/phases/115-openclaw-todo-ci/115-CONTEXT.md` — D-07 中性命名原则、D-08 OpenClaw 清理策略
- `.planning/phases/115-openclaw-todo-ci/115-04-PLAN.md` — Phase 115 Plan 04 清理范围（哪些改了，哪些特意没改）
- `.planning/phases/115-openclaw-todo-ci/115-04-SUMMARY.md` — 38+ 文件清理结果

### 关键源码
- `frontend/src/app/src/infra/update-startup.ts` — 死代码，待删除
- `frontend/src/app/src/events.ts` — 待清理 type import
- `frontend/src/app/ui/types.ts` — 待清理 type import
- `frontend/src/app/src/auto-reply/status.ts` — 用户可见版本信息（L832）
- `frontend/src/app/src/auto-reply/reply/commands-session.ts` — 重启消息
- `frontend/src/app/src/auto-reply/reply/commands-registry.shared.ts` — MCP/restart 命令描述
- `frontend/src/app/src/auto-reply/reply/tool-display-exec.ts` — "run openclaw" 显示
- `frontend/src/app/src/agents/tool-catalog.ts` — 工具分组名
- `frontend/src/app/src/auto-reply/reply/inbound-meta.ts` — 系统消息
- `apps/db-ops-api/sql/schema.sql` — SQL 注释

## Existing Code Insights

### Reusable Assets
- 无现有 branding 配置 — D-01 需要新建 `branding.ts`

### Established Patterns
- Phase 115 D-07 的中性命名方式对 import 别名有效，但对 runtime 标识不适用
- Vite alias 已在 Phase 115 中改为 `@agent/plugin-sdk/reply-payload`

### Integration Points
- 前端 Vite 构建通过 `vite.config.js` 管理别名
- 环境变量在 `reply.test-harness.ts`、`reply.triggers.trigger-handling.test-harness.ts` 等测试文件中集中定义
- `update-startup.ts` 与 `events.ts` 通过 type import 连接，删除时需清理

## Deferred Ideas

- 如果将来需要更新/重启等 CLI 功能重新实现，在 `branding.ts` 配置下开发，不再硬编码 CLI 名
- `~/.openclaw/` 到 `~/.slide/` 的数据迁移脚本 — 如果需要，作为单独任务加入 Plan

---

*Phase: 116-openclaw-cli*
*Context gathered: 2026-06-02*
