# MAX-231 Provider 保存与应用结果分离（验证记录）

对应 GitHub #255。交付 HEAD 以分支 `agent/15coder1/max-231` 最新提交为准，PR 与 Issue 评论记录准确 SHA。本文只记录本单改动、证据及其性质，不宣称未执行的真实业务验收。

## 范围与实现

- 前端 `frontend/src/app/ui/views/llm-config.ts`：保存（新增/编辑）、启停、设为默认统一消费 `applied`/`reloadError`。`applied === false` 时不再显示“已保存配置”生效态，改为警示条“配置已保存，但尚未应用到运行时”＋可理解原因＋固定错误码；保存与设为默认提供“重试应用”入口（启停的再次调用会反向翻转持久化状态，因此只提示而不重试）。
- `reloadError` 只渲染形如 `^[A-Z][A-Z0-9_]{0,63}$` 的代码型信号；自由文本（可能包含供应商凭据）不进入 DOM，统一降级为通用原因。
- 后端 `apps/db-ops-api/src/llm-config-reload.ts`（新增）：把“持久化成功但运行时未应用”的判定固定为 `{ applied: false, reloadError: 'LLM_CONFIGURATION_UNAVAILABLE' }`，仅在服务端日志记录代码，不回传异常文本。
- `apps/db-ops-api/server.ts`：`POST /api/llm/configs`、`PUT /api/llm/configs/:id`、`POST /api/llm/configs/:id/toggle`、`POST /api/llm/configs/:id/default` 统一返回 `success`＋`applied`（失败时附 `reloadError`），不再在行已写入后返回不透明的 500。设为默认沿用其原有 `llmService.reloadConfig()` 重载范围，未扩大为 chat provider 重载。
- 运行时保留上一份可用配置、单个不可用 Provider 不阻断其他 Provider：由既有 `llm-service.ts` 原子替换实现，本单未改动该逻辑。

## 返回契约（本单统一后）

| 入口 | 持久化失败 | 持久化成功且已应用 | 持久化成功但未应用 |
| --- | --- | --- | --- |
| POST /api/llm/configs | `{ success: false, error }` | `{ success: true, providerId, applied: true }` | `{ success: true, providerId, applied: false, reloadError }` |
| PUT /api/llm/configs/:id | `{ success: false, error }` | `{ success: true, applied: true }` | `{ success: true, applied: false, reloadError }` |
| POST /api/llm/configs/:id/toggle | `{ success: false, error }` | `{ success: true, applied: true }` | `{ success: true, applied: false, reloadError }` |
| POST /api/llm/configs/:id/default | `{ success: false, error }` | `{ success: true, applied: true }` | `{ success: true, applied: false, reloadError }` |

`applied` 表示运行时配置已整体重载；单个 Provider 因凭据缺失被跳过时仍为 `true`（既有的隔离语义），该 Provider 是否可用由连接测试单独验证。

## 先复现

第一轮：在未修改的前端源码上运行新增用例，5 项失败：`success=true, applied=false` 时 `savedOk=true`、无任何应用失败反馈（断言找不到 `[aria-label="运行时应用结果"]`）。

第二轮（本轮补修，Chief 复现的两处状态串扰）：把前端文件退回 `b75a9f2b4` 版本后运行本轮新增用例，4 项失败、浏览器 2 项新增用例中默认切换 1 项失败（另 1 项因 2.5s 自清除计时器不稳定而先通过，改为即时快照断言后同样在旧代码上失败）：

- 先 `_save` 得到 `applied=true`（按钮“✓ 已保存配置”），紧接着 `_toggle` 得到 `applied=false`：旧代码只设警示条，按钮仍是成功态。
- 先 `_setDefault` 失败（`formMsg=默认切换失败`），紧接着重试 `applied=true`：旧代码 `formMsg` 仍是旧错误、没有任何成功确认。
- 保存失败/应用失败之间切换时，旧的成功或失败文案会残留。

## 修复（本轮）

- 新增 `_beginMutation()`：每次保存、启停、设为默认以及选择 Provider/模板/新增入口都先清空 `savedOk` 与其计时器、`formMsg`、`applyWarning`、`mutationOk`，保证任一时刻只展示最近一次操作的结果。
- 启停、设为默认在 `applied !== false` 时给出明确成功确认（`[role="status"][aria-label="操作结果"]`：已应用到运行时）；`applied === false` 时仍只有警示条。默认切换的“重试应用”成功后旧错误被清除并显示成功确认。
- `_toggle`/`_setDefault` 现在也检查 `success === false` 并按失败处理，与保存入口一致。

## 检查结果（本工作树当前代码）

- `pnpm --filter slide-frontend test`：148 文件、1,312 项通过（含本单新增 11 项：应用失败不显示生效、代码型原因可见、自由文本不泄露、重试成功后清除、正常保存与保存失败区分、启停/默认/新增契约一致，以及本轮 4 项顺序状态用例：保存成功→启停未应用、启停/默认失败→成功、保存警示→启停应用成功）。
- `pnpm --filter slide-frontend typecheck`、`pnpm --filter slide-frontend build`（含 CSP 检查）：通过；build 仍有既有的 chunk 体积提示。
- `apps/db-ops-api` 内 `vitest run src/llm-config-reload.test.ts src/llm-service.test.ts`：5 项通过。
- `pnpm --filter slide-api typecheck`、`pnpm contracts:check`：通过，公开契约未漂移。
- 浏览器回归（Chromium，真实页面与 Lit 渲染）：`frontend/e2e/llm-save-apply-feedback.spec.ts` 4 项通过；既有 `frontend/e2e/llm-test-feedback.spec.ts` 8 项通过。覆盖保存应用失败警示、键盘 Enter 重试成功、正常保存、HTTP 500 保存失败，以及本轮两处顺序状态：保存成功后被未应用的启停取代（同一时刻不再显示“✓ 已保存配置”）、默认切换失败后重试成功清除旧错误并显示成功确认。

## 真实后端验证（隔离 MySQL，2026-10-26）

### 环境与证据性质（真实，非 mock）

- **真实 SQL**：隔离容器 `slide-max231-sql-2601`（mysql:8.4.10，宿主 33306），用 `apps/db-ops-api/init-db.ts` 的迁移账本从空库建表；与 `slide-local-*` 共享栈和其他任务实例无关，结束后已删除。
- **真实生产路由**：直接启动 `apps/db-ops-api/server.ts`（端口 3131，非测试替身），使用真实 JWT（`userId=1`、admin）通过 `verifyToken` + `requirePermission('llm:manage')`，调用 `POST/PUT /api/llm/configs`、`POST /api/llm/configs/:id/toggle`、`POST /api/llm/configs/:id/default`。
- **真实运行时**：同一进程内读取 `llmService.getAvailableProviders()` / `isInitialized()`，即生产 LLMService 单例的实际运行配置，而非数据库回读。
- **故障是真实配置故障**：`max231-nokey` 为启用但无凭据的 Provider，重载时 `createServiceProviderClient` 真实抛 `LLM_CREDENTIAL_NOT_CONFIGURED`，`initialize()` 返回 false；**未注入 mock、未改源码分支、未伪造响应**。持久化失败路径用真实的参数校验拒绝（`Max Tokens + 1024 >= 上下文窗口`），也非模拟。
- **全程未发模型请求**：SDK 客户端只被构造（`provider-connection` 构造不联网）；本地 Provider 的 baseURL 指向未监听的 127.0.0.1:11434，验证期间该端口无监听。

### 场景与真实响应

| # | 操作（真实路由） | 响应 | 库内结果 | 运行时 `getAvailableProviders()` |
| --- | --- | --- | --- | --- |
| A | `POST /api/llm/configs` 创建 enabled 本地 Provider | `200 {success:true, providerId:9, applied:true}` | 行存在（`GET /api/llm/configs/9` 返回 `max231-local`） | `[max231-local, ollama]` |
| B | 再创建 enabled 但无凭据的 Provider | `200 {success:true, providerId:10, applied:true}` | 行存在 | `[max231-local, ollama]`（不可用者被隔离，不阻断） |
| C | `POST /:id/toggle` 停用一个可用 Provider | `200 {success:true, applied:true}` | `max231-local.enabled=0` | `[ollama]` |
| D | 再停用最后一个可用 Provider | `200 {success:true, applied:false, reloadError:"LLM_CONFIGURATION_UNAVAILABLE"}` | `ollama.enabled=0`（持久化生效） | **仍为 `[ollama]`**，`isInitialized()=true`（保留上一份可用配置） |
| E | 仅剩不可用 Provider 时 `POST /:id/default` | `200 {success:true, applied:false, reloadError:"LLM_CONFIGURATION_UNAVAILABLE"}` | `is_default` 已写库 | 仍为 `[ollama]` |
| F | 重新启用可用 Provider（重试成功） | `200 {success:true, applied:true}` | `ollama.enabled=1` | `[ollama]` |
| G | `PUT /api/llm/configs/:id` 补凭据 | `200 {success:true, providerId:10, applied:true}` | `api_key_encrypted` 为 v2 密文（134 字节），非明文 | `[max231-nokey, ollama]` |
| H | 保存失败（创建/更新非法参数） | `{success:false, error:"LLM_MODEL_PARAMETERS_INVALID…"}`，**无 `applied`/`reloadError`** | 未落库 | 不变 |

服务端日志同步印证：D/E 时 `[LLM] 初始化失败: LLM_CREDENTIAL_NOT_CONFIGURED` 且没有替换现有客户端；A/C/F/G 各自 `[LLM] 已加载 N 个提供商`。

### 与验收项的对应

- `success=true/applied=false` 返回固定代码 `LLM_CONFIGURATION_UNAVAILABLE`，不含异常文本；所有响应与日志中未出现写入的占位凭据（明文仅存在于请求体，库内为密文）。
- 正常保存并应用（A/F/G）、保存失败（H）、应用失败（D/E）、重试成功（F）四类结果来自真实后端，前端对三类字段的消费由前述单测与浏览器用例覆盖。
- 应用失败不阻断其他正常 Provider（B/C）；失败时保留上一份可用运行配置（D/E 运行时观测）。

### 清理

验证脚本为临时 harness，未提交；容器 `slide-max231-sql-2601` 已 `docker rm -f`，3131 端口释放，`slide-local-*` 共享栈未改动。

## 证据性质与未完成项

- 浏览器用例的 `/api/llm/**` 响应为受控 fixture，用于稳定复现“已保存未应用”状态，属于模拟后端证据；页面、组件与键盘交互是真实实现。真实后端自 2026-10-26 隔离库验证后不再是阻塞项（见上节）。
- 删除入口（`DELETE /api/llm/configs/:id`）不在本单列出的入口范围内，保持原行为（删除后重载失败仍返回 500），已作为后续项记录，不在本单扩大范围。
- 未修改 MAX-225 的 admission/runtime、MAX-234 的 CI 文件，也未改动 MAX-232 的告警路由逻辑；`server.ts` 仅改动 LLM 配置路由片段。

## 发布

任务分支 `agent/15coder1/max-231` 的历史里含上一轮基线带入的 225 个运行时快照与无关 planning 文件，不用于合并。发布使用从当前 `main` 单独构建的 source-only 提交（仅含本单 7 个文件），任务分支 HEAD 不变。

回退：撤销本单前端两处、后端新模块与四处路由改动及其测试即可恢复原行为；无数据库迁移或配置变更。
