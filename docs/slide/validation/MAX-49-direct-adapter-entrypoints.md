# MAX-49：DirectAdapter 不支持入口核查

## 执行契约与版本

范围 v1：核查 `sessions.reset`、`plugin.approval.resolve`、`exec.approval.resolve`、`commands.list`、`logs.tail` 的实际入口、后端能力、权限与降级；仅修正可达的不支持入口。排除整个 request 接口迁移、消息确认超时、无关 UI 重构和新增后端能力。无范围扩展。

验收：五项决策表；变更入口的可观察结果；相关回归、前端类型检查与生产构建。成功/拒绝不适用时说明原因。必要验证完成后停止，不部署、不合并。

核查代码基线 `e3180fa1962fb6f53cccbfeecf3ef068b47b99d7`，分支 `agent/15codex/max-49`；并非直接沿用建单时的 c7073b3。运行环境 Node v24.18.0、pnpm 11.19.0、Vitest 3.2.6、Vite 5.4.21，日期 2026-09-16。生产行为变更只涉及前端。

硬预算未设定；子代理 0、最大代理深度 0、并发代理峰值 1。实际 raw input / cached input / output token 与费用遥测不可用，未使用内部估算冒充实测；未创建 Goal 账本。

## 干净 PR 候选补充记录

交付隔离 v1（范围不变）：原工作树基线含无关未发布提交和打包产物，不能一并推送。另建 `agent/15codex/max-49-pr`，以远端主分支 `45259c040788239035126014a53bb695ee878f64` 为基线，仅 cherry-pick 本任务两次提交；对应新提交为 `1a2232f`（RED 测试）和 `9865379`（修复）。未修改或发布原工作树的 AGENTS.md、打包产物及其他用户修改。

由于基线发生变化，对该最终候选重新完整验证：

- `pnpm --filter slide-frontend test`：72 文件、453/453 通过。
- `pnpm --filter slide-frontend typecheck`：通过。
- `pnpm --filter slide-frontend build`：通过，CSP 校验通过；仅有同类 chunk/导入警告。
- `git diff --check`：通过。PR 仅 7 个任务相关文件。

以下保留最初工作树的调查与阶段验证记录；最终交付的门禁结论以上述干净候选为准。没有重置资源累计，也没有增加代理。

## 五项决策表

`request()` 实际位于 `frontend/src/app/ui/direct-gateway.ts:248`，不在后端 DirectAdapter 类中；未知方法在第 321 行直接抛错，不产生网络请求。

| 方法 | 入口可达性与证据 | 后端能力与权限 | 原行为 → 处理决策 |
| --- | --- | --- | --- |
| `sessions.reset` | 可达：本地命令菜单 `/clear` → `app-chat.ts` 的 `dispatchSlashCommand` → `clearChatHistory`。`/new`、`/reset` 单独走 `switch-session:`。 | 无保留会话的清空接口。`chat-routes.ts:182` 删除整个会话；`:195` 的 cap 及 `chat-database-service.ts:464` 要求至少保留 1 条，不能代替清空。已有接口要求 JWT，服务层校验会话访问权限，不能绕过。 | 原先发不支持 RPC，空闲时报技术错误、运行中进入队列。现在菜单标注不支持，执行立即显示原因；不发 RPC，不清消息、结果、运行 ID，不切会话，不排队。新建语义不变。 |
| `plugin.approval.resolve` | 正常产品入口不可达。`app.ts:187` 队列初始化为空，`:668` 方法仅消费队首并过滤；全仓无生产写入队列、无渲染按钮或事件绑定。前端事件分发和后端 WS 协议也没有旧审批事件。 | 无旧 plugin 审批协议。现有 `/api/agent/approvals/:id/review` 使用另一套持久化审批 ID、action、scope；读要求 `approval:view`，审核要求 `approval:approve`。不能把旧 allow-always 无条件转换。 | 保留不可达代码，不扩大迁移范围。直接调用 request 仍抛不支持；未默认批准。 |
| `exec.approval.resolve` | 与 plugin 共用上述不可达队列与处理方法，且无执行审批队列生产者。 | 无旧 exec 审批协议。现有审批中心 `views/approval-dashboard.ts:191` 直接使用 REST 审核，不经过旧队列。 | 不改现有审批中心；不接入错误协议，不默认放行；request 明确拒绝。 |
| `commands.list` | 可达：`app-chat.ts` 的 `refreshChat` 和 `app-render.helpers.ts` 会刷新命令目录。 | 无远端目录接口。该调用在客户端即拒绝，没有后端权限检查；本地目录本身不授予执行权限。 | `chat/slash-commands.ts:390` 已在异常时重建本地目录。保留该降级；不支持、403、网络错误均能继续列出本地命令。 |
| `logs.tail` | 隐藏但可达：`navigation.ts:97` 保留 `/overview` URL，`app-settings.ts:234` 会触发 loadOverview；原先没有对应视图，日志异常被吞。 | 无旧 Gateway 原始日志流/cursor 接口。`server.ts:4323` 的 `/api/logs` 是实例日志；`platform-observation-service.ts:24` 是聚合事件，后者要求 JWT 与 `config:view`/`config:*`/`*`。它们并非原始日志尾流，不能伪装成同一来源。 | 移除无效轮询调用并清除旧日志行/cursor；`app-render.ts:526` 用已有 `app-empty-state` 明确说明“不支持运行日志”和缺少来源，保持权限边界。 |

不可达审批路径的可复核搜索：

```sh
rg -n 'execApprovalQueue|handleExecApprovalDecision' frontend/src
rg -n 'approval' frontend/src/app/ui/direct-gateway.ts apps/db-ops-api/src/adapter/direct-adapter.ts
rg -n 'plugin.approval.resolve|exec.approval.resolve' frontend/src apps/db-ops-api/src
```

第一项仅出现初始化、类型声明、队首读取/过滤及方法定义，没有生产写入者/模板绑定；第二项无匹配。已有审批中心另有自己的 REST 工作流。

## 验证证据与适用性

- RED：新增 12 项入口测试，修复前 4 项按预期失败（清空无提示/运行中排队、菜单未标不支持、日志仍发请求），8 项通过；提交 `905f5cd` 记录该阶段。
- GREEN：`pnpm --filter slide-frontend exec vitest run src/app/ui/unsupported-entrypoints.test.ts src/app/ui/app-chat-session.test.ts src/app/ui/direct-gateway.test.ts src/app/ui/app-settings-locale.test.ts`，48/48 通过。
- 完整前端 gate：`pnpm --filter slide-frontend test`，70 文件、408/408 通过；随后新增独立 UI 验证 `overview-unsupported.test.ts`，1/1 通过。该增补未修改生产实现，合计 409 项通过，不重复完整 gate。
- UI 验证实际使用 `SlideApp`、`tabFromPath('/overview')`、`renderApp` 和共享空状态组件，在 jsdom 中验证用户能看到“不支持”及缺少日志流来源。
- `pnpm --filter slide-frontend typecheck` 通过。
- `pnpm --filter slide-frontend build` 通过，CSP 校验通过；Vite 提示现有大 chunk 和混合静态/动态导入警告，不影响构建。
- `git diff --check` 通过。

| 入口 | 成功状态 | 拒绝状态 | 不支持状态 |
| --- | --- | --- | --- |
| `/clear` | 清空成功不适用：后端无能力，入口已禁用。原有 `/new` 成功切换待创建会话的测试通过。 | 不调用后端，401/403 不适用，未制造假成功。 | 空闲和运行中均提示原因；历史、会话、侧边结果、运行与流保持原值，无请求、无排队。 |
| `/overview` 日志 | 无日志来源，成功获取日志不适用。 | 没有日志网络请求，因此后端拒绝状态不适用；没有绕过其他日志源的权限。 | 实际组件渲染明确提示，旧日志缓存被清空。 |
| 命令目录（保留） | 本地目录含 `/new` 和 `/clear`。 | 模拟远端 403 后仍保留本地目录，执行权限不因此改变。 | 不支持/网络错误均降级，本地 `/clear` 仍注明不可用。 |
| 两种旧审批（未改） | 不可达，不适用。 | 五种 request 方法均测试显式拒绝且无网络副作用。 | 不映射到其他审批协议，不默认批准。 |

联调边界：未启动或借用其他工作树的后端实例；未实施清空历史或审批对接，故“刷新后持久化一致”及“审批权限/拒绝/后端结果一致”的条件联调不适用。本次证据是当前源码的组件/控制器测试、完整前端回归及构建，不宣称真实数据库 E2E 或浏览器联调已通过。未新增后端代码，因此不扩大到全后端回归。覆盖率百分比未采集。
