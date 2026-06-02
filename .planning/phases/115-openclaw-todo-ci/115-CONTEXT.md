# Phase 115: 去 OpenClaw 迁移后清理 - Context

**Gathered:** 2026-06-02
**Status:** Ready for planning

## Phase Boundary

v1.4 Agent 解耦的收尾阶段：修复遗留 TODO、清理前端死代码和 OpenClaw 命名残留、添加 CI pipeline。不新增功能，纯清理/修复。

## Implementation Decisions

### 工具 TODO 修复
- **D-01:** 修复全部 5 个遗留 TODO：report-service.ts 容量数据采集、get_instance_summary/list_active_alerts RBAC scope、check_status.ts/configure_llm.ts（但 D-04 优先）
- **D-02:** RBAC scope 实现：从请求 context 获取当前用户，按用户拥有的实例权限过滤返回结果
- **D-03:** report-service.ts collectCapacityData() 实现真实容量采集，复用 database-service.ts 已有的容量查询方法（getMySQLCapacity/getPostgresCapacity 等）
- **D-04:** 删除两套 Agent LLM 配置工具：`slide-self-mgmt/configure_llm.ts` 和 `llm-config/index.ts`（含测试）。LLM 配置管理统一走设置页 REST API `/api/llm/configs`
- **D-05:** 更新 apps/db-ops-api/CLAUDE.md，移除 "self-mgmt 空壳工具" 过时条目

### 前端残留引用清理
- **D-06:** 系统扫描并批量删除所有 import 已删除文件（types.openclaw.ts、config/bindings.ts）的死代码。至少删除 routing/bindings.ts、resolve-route.ts、bound-account-read.ts
- **D-07:** 命名原则：`openclaw`/`OpenClaw` → 中性别名（不用 `slide`）；`gateway`/`Gateway` → 保留（已是中性术语）
- **D-08:** 清理所有注释和文本中的 OpenClaw 引用：i18n zh-CN.ts "OpenClaw 菜单组"、代码注释 "复用 OpenClaw" 等
- **D-09:** 重命名 Vite 别名 `openclaw/plugin-sdk/reply-payload` → 中性别名（如 `@agent/plugin-sdk/reply-payload`），同步更新 auto-reply 下所有 import
- **D-10:** 清理 server.ts：移除 health 端点 `gateway_version` 字段、移除 OPENCLAW-*.html 静态文件路由
- **D-11:** 清理 package.json：删除 `gateway:start`/`gateway:stop` 脚本
- **D-12:** 检查并清理 `__openclaw` session key marker（direct-gateway.ts、chat.ts）。如 DirectAdapter 已不产生此 marker 则删除解析代码
- **D-13:** 杂项清理：direct-gateway.ts 重命名（gateway 保留）、chat-types.ts/icon.ts 注释更新、protocol/CLAUDE.md 删除或更新

### CI 设置
- **D-14:** 添加 GitHub Actions CI：一个 workflow 两个 job（前端 + 后端），PR → main 触发
- **D-15:** CI 步骤：lint + typecheck + tests。118 个失败测试先修复再启用 test 步骤，保证 CI 绿
- **D-16:** 后端 job：npm test (vitest)；前端 job：npm run lint + vitest run

### Claude's Discretion
- 中性别名的具体命名（`@agent/`、`@core/`、`@app/` 等）由 planner 选定
- CI workflow 文件结构和 job 配置细节由 planner 决定
- 118 个失败测试的修复顺序和策略由 executor 决定
- database-service.ts 容量查询方法的复用方式由 researcher 确认

## Canonical References

- `apps/db-ops-api/CLAUDE.md` — 后端开发注意事项，含待修复条目需更新
- `apps/db-ops-api/src/report-service.ts` — 容量数据采集 TODO（L609）
- `apps/db-ops-api/src/tools/ops/get_instance_summary.ts` — D-08 RBAC TODO
- `apps/db-ops-api/src/tools/ops/list_active_alerts.ts` — D-08 RBAC TODO
- `apps/db-ops-api/src/tools/generated/slide-self-mgmt/configure_llm.ts` — 待删除
- `apps/db-ops-api/src/tools/generated/llm-config/index.ts` — 待删除
- `apps/db-ops-api/src/tools/generated/slide-self-mgmt/index.ts` — 需移除 configureLlmTool 导出
- `apps/db-ops-api/server.ts` — health 端点 gateway_version 残留、OpenClaw HTML 路由
- `apps/db-ops-api/package.json` — gateway 脚本待删除
- `frontend/src/app/ui/routing/bindings.ts` — 死代码（import 不存在的 types.openclaw.ts）
- `frontend/src/app/ui/routing/resolve-route.ts` — 死代码
- `frontend/src/app/ui/routing/bound-account-read.ts` — 死代码
- `frontend/vite.config.js` — openclaw/plugin-sdk 别名需重命名
- `frontend/src/app/ui/views/chat.ts` — __openclaw marker（L1946）
- `frontend/src/app/ui/direct-gateway.ts` — __openclaw marker + 文件名待重命名
- `frontend/src/app/src/protocol/CLAUDE.md` — 过时 Gateway 协议文档

## Existing Code Insights

### Reusable Assets
- **llmDatabaseService**: LLM 配置的 REST API 已完整实现（server.ts L518-L540+），这是 Agent 工具删除后唯一的 LLM 配置入口
- **database-service.ts**: 已有 getMySQLCapacity/getPostgresCapacity/getDamengCapacity/getOracleCapacity 方法，可直接复用
- **instanceDatabaseService**: 已有 getAllInstances/getInstanceById，D-08 RBAC 过滤可在此基础上加用户权限检查

### Established Patterns
- Agent 工具注册模式：`toolCatalog.register()` + `AnyAgentTool` 接口
- 死代码识别信号：import 不存在的文件 + 无其他文件 import 该模块
- testConnection 等已有工具通过 `request context` 获取用户信息，RBAC scope 可参考

### Integration Points
- `server.ts` L518 — `/api/llm/configs` REST 端点，唯一 LLM 配置入口
- `server.ts` L196-205 — health 端点需移除 gateway_version
- `toolCatalog` — 删除 LLM 工具后需确认 catalog 索引自动清理
- `vite.config.js` — 别名重命名影响 auto-reply 下所有 import

## Deferred Ideas

- **文档更新**: docs/slide/ 下 5 个文档（ARCHITECTURE.md 等）共 79 处 OpenClaw/Gateway 引用，延后到专门文档更新 phase
- **前端设置页 vs Agent LLM 工具功能重复**: 已完成 — Agent LLM 工具删除

---

*Phase: 115-openclaw-todo-ci*
*Context gathered: 2026-06-02*
