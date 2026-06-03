# Phase 117: OpenClaw收尾 - Context

**Gathered:** 2026-06-02
**Status:** Ready for planning

<domain>
## Phase Boundary

三个收尾任务：

1. **OpenClawConfig → SlideConfig 类型重命名** — ~97 个前端文件中将 `OpenClawConfig` 接口重命名为 `SlideConfig`，同时删除死字段（`session`、`update`、`bindings`），只保留 `agents`。修复 4 个从 `config/config.js`（不存在的文件）错误导入的引用。

2. **文档更新** — 推迟。项目架构还在变动（DirectAdapter 刚稳定），等项目整体告一段落再单独开 phase 更新 docs/。

3. **Branding 配置 Settings 集成** — 将 Phase 116 创建的 `branding.ts` 硬编码值做成运行时配置。4 个字段（CLI_NAME、PRODUCT_NAME、ENV_PREFIX、STATE_DIR）全部可配置，复用 `system_config` 表持久化，修改即时生效。

</domain>

<decisions>
## Implementation Decisions

### 类型重命名

- **D-01:** `config/types.ts` 中 `OpenClawConfig` → `SlideConfig`。删除 `session`、`update`、`bindings` 三个死字段（经搜索确认无实际 indexed access 使用），只保留 `agents`。
- **D-02:** ~97 个引用文件全部同步替换：`import type { OpenClawConfig }` → `import type { SlideConfig }`，`cfg: OpenClawConfig` → `cfg: SlideConfig`，`as OpenClawConfig` → `as SlideConfig`，`T extends OpenClawConfig` → `T extends SlideConfig`，`OpenClawConfig["agents"]` → `SlideConfig["agents"]`。
- **D-03:** 修复 4 个从 `config/config.js` 错误导入的文件（`get-reply.ts`、`agent-runner-utils.ts`、`reply-elevated.ts`、`startup-context.ts`）— 该文件不存在，应改为从 `config/types.js` 导入。
- **D-04:** `cron-completion-tool.ts`（backend）虽然 grep 显示匹配但实际无引用，确认后无需改动。
- **D-05:** 重命名为纯机械操作 — 不改变任何运行时行为，一个 commit 完成。

### Branding Settings

- **D-06:** 4 个 branding 字段全部做成运行时配置：`branding.cli_name`、`branding.product_name`、`branding.env_prefix`、`branding.state_dir`。
- **D-07:** 复用现有 `system_config` 表（`config_key VARCHAR(100) UNIQUE` + `config_value TEXT` + `value_type ENUM`）。已有 `system.name` 等 key 使用此模式。
- **D-08:** `branding.ts` 保留为编译时默认值。运行时从 `system_config` 表读取覆盖，DB 不可用或字段为空时 fallback 到硬编码默认值。
- **D-09:** 修改即时生效 — 通过 getter 函数 + 内存缓存实现，更新时写 DB 同时刷新缓存。所有 import 点通过 getter 获取当前值。
- **D-10:** Settings shell 新增 "Branding" 子 tab（`branding-settings` Lit 组件）。表单：4 个文本输入 + 保存按钮。修改后立即刷新内存缓存。

### 文档更新

- **D-11:** 推迟。`docs/slide/` 下 5 个文档（ARCHITECTURE.md、OPERATIONS.md、PROJECT_STRUCTURE.md、README.md、USER-GUIDE.md）共 ~79 处 OpenClaw/Gateway 引用暂不更新。等项目稳定后单独开 phase。

### Claude's Discretion

- 类型重命名的执行策略（全局 sed 一键替换 vs 按模块逐步替换）— planner 根据文件依赖关系决定
- `system_config` 读取 API 的实现方式（新建 `/api/system-config` 端点 vs 扩展已有设置 API）
- Branding Settings 前端 form 的具体 UI 设计（layout、validation）
- 内存缓存的失效策略（写 DB 后立即刷新 vs TTL-based）

</decisions>

<canonical_refs>
## Canonical References

### Phase 116 上游上下文
- `.planning/phases/116-openclaw-cli/116-CONTEXT.md` — D-01/D-02 创建了 branding.ts 集中配置
- `.planning/phases/115-openclaw-todo-ci/115-CONTEXT.md` — D-07 中性命名原则，types.openclaw.ts 历史

### 关键源码
- `frontend/src/app/src/config/types.ts` — OpenClawConfig 类型定义（本 phase 核心目标）
- `frontend/src/app/src/branding.ts` — Phase 116 创建的 branding 集中配置（本 phase 扩展基础）
- `frontend/src/app/ui/views/settings-shell.ts` — Settings shell，本 phase 需在此添加 Branding sub tab
- `frontend/src/app/ui/views/appearance-settings.ts` — 参考 UI 模式（branding settings 可参考）

### 数据库
- `apps/db-ops-api/sql/schema.sql` — `system_config` 表定义（L797），已有 `system.name` 等 seed key（L863）
- `apps/db-ops-api/src/scoring-config-service.ts` — `system_config` 读写参考实现（REPLACE INTO 模式）
- `apps/db-ops-api/src/ai-analysis-config-service.ts` — 另一个 `system_config` 读写参考

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`system_config` 表** — 已存在的 key-value 配置表，`scoring-config-service.ts` 和 `ai-analysis-config-service.ts` 已提供读写模式（`REPLACE INTO` + `SELECT WHERE config_key = ?`）
- **`branding.ts`** — Phase 116 创建的集中配置，目前是硬编码常量 + helper 函数（`buildEnvVar`、`buildSymbolKey`、`buildCliCmd`、`buildUserAgent`）
- **`settings-shell.ts`** — 已有 7 个子 tab 的 settings 框架，遵循 `SUB_TABS` 数组 + `_renderTabContent()` switch 模式

### Established Patterns
- `system_config` 读写模式：`REPLACE INTO` 写入 + `SELECT config_key, config_value FROM system_config WHERE config_key = ?` 读取
- Settings 子页面模式：独立的 Lit component + `settings-shell.ts` 中注册
- 所有 `OpenClawConfig` 引用都是 `import type`，零运行时依赖 — 重命名安全

### Integration Points
- Branding Settings API 需要新增 endpoint（或在现有 API 上扩展），前端 Settings UI 通过 fetch 读写
- `branding.ts` 需要从纯常量模块改为 getter + 缓存模式，所有现有 import 点（~20 个文件）需要适配新的 getter API
- Settings shell 的 `SUB_TABS` 数组和 `_renderTabContent()` switch 需要添加 branding 条目

</code_context>

<specifics>
## Specific Ideas

- 类型重命名：简单机械操作，不含任何逻辑变更。全局 search-replace 即可，无需按模块分步。
- Branding form：4 个文本输入框 + 保存按钮，和 `appearance-settings.ts` 的简洁程度一致即可。
- 即时生效：关键是要让所有现有的 `branding.ts` import 点（CLI_NAME、PRODUCT_NAME 等）在配置更新后拿到新值，而不是模块加载时的快照。

</specifics>

<deferred>
## Deferred Ideas

- **文档更新** — `docs/slide/` 下 5 个文档（ARCHITECTURE.md 含 26 处 OpenClaw/Gateway 引用）推迟到项目架构稳定后单独开 phase。当前 DirectAdapter 刚替代 OpenClaw Gateway，架构文档现在写了很快又会过时。

</deferred>

---

*Phase: 117-openclaw*
*Context gathered: 2026-06-02*
