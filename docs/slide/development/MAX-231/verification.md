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

## 证据性质与未完成项

- 浏览器用例的 `/api/llm/**` 响应为受控 fixture，用于稳定复现“已保存未应用”状态，属于模拟后端证据；页面、组件与键盘交互是真实实现。
- **真实后端持久化/应用验证未完成（阻塞项）**：本工作树没有 `apps/db-ops-api/.env`；按批次规则，SQL fixture 归 MAX-225，未经串行交接不得另起 MySQL。本工作树内可访问的 Docker MySQL 实例凭据不可用，因此未执行真实后端验证。后端契约目前只有类型检查、契约检查、`reloadOutcome` 单元测试与浏览器 fixture 证据。需要串行交接一个隔离库后执行下列场景并记录真实响应：
  1. 创建可用 Provider（enabled，含 key）→ `{success:true, applied:true}`，库内行存在；
  2. 再创建一个 enabled 但无 key 的 Provider → 仍 `applied:true`（单个不可用 Provider 不阻断）；
  3. 仅保留不可用 Provider（禁用可用者）→ `{success:true, applied:false, reloadError:'LLM_CONFIGURATION_UNAVAILABLE'}`，且运行时仍可列出上一份可用 Provider；
  4. 恢复可用 Provider → 再次 `applied:true`。全程不发起模型请求。
- 删除入口（`DELETE /api/llm/configs/:id`）不在本单列出的入口范围内，保持原行为（删除后重载失败仍返回 500），已作为后续项记录，不在本单扩大范围。
- 未修改 MAX-225 的 admission/runtime、MAX-234 的 CI 文件，也未改动 MAX-232 的告警路由逻辑；`server.ts` 仅改动 LLM 配置路由片段。

## 发布

任务分支 `agent/15coder1/max-231` 的历史里含上一轮基线带入的 225 个运行时快照与无关 planning 文件，不用于合并。发布使用从当前 `main` 单独构建的 source-only 提交（仅含本单 7 个文件），任务分支 HEAD 不变。

回退：撤销本单前端两处、后端新模块与四处路由改动及其测试即可恢复原行为；无数据库迁移或配置变更。
