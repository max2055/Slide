# MAX238-APPLY-IDEMPOTENCY-R1：操作键协议补修

修正包针对 `d89860916` 复核中的两个独立反例和前端未知结果缺口，属于原范围修正，不扩大范围。

## 反例 1：旧意图重放被当前配置污染

**原因**：重放路径先按当前 binding 重新执行 candidate，再比较 digest。A 发布 revision 1 时省略 `overrides`；B 发布 revision 2 并改为停用后，当前 binding 的默认值变了，A 的原始请求被重新解析成 revision 2 的配置，返回 `POLICY_OPERATION_CONFLICT`。

**修正**：日志行新增 `intent_digest`（规范化请求的 sha256，包含 `expected_revision` / `package` / `group_id` / `overrides` 的显式-省略形态）。重放只比较该摘要，直接返回记录的结果，不再重新解析 candidate。异资源、异 revision、异载荷仍是冲突。

## 反例 2：在途 activate 被查成 absent

**原因**：activate 只在整个发布事务内持锁，trial 阶段无状态；`GET operations/key` 因此返回 `absent`，而公开契约宣称 absent 可以安全重试。

**修正**：新增 `pending` 生命周期。

| 阶段 | 事务 | 日志行 |
| --- | --- | --- |
| `beginOperation`（trial 之前） | 与发布同一把策略锁 | 插入 `state='pending'`，无 configuration_digest/result/committed_at |
| trial / 远程阶段 | 无锁 | 仍是 pending |
| `changeBinding(publish, finishClaim)` | 与 binding、revision、audit 同一事务 | 同一行提升为 `committed` |
| 已知的进程内失败 | 独立小事务 | 只删除本请求自己的 pending 行 |

- 同键并发：第二个请求在 `beginOperation` 收到 `POLICY_OPERATION_PENDING`，不发起第二次试采。
- 进程崩溃/结果未知：行保持 `pending`，没有超时清零逻辑，也不会被当成 absent 重试；不声称跨崩溃远程 exactly-once。
- 查询与重放都在实时权限下执行；重新授权发生在远程阶段之后。
- 未带 `operation_key` 的调用保持原行为（既有 409/422/200 用例不变）。

## 前端

- 失败后先用**原资源 + 原 key** 查询 `GET .../operations/:key`，不直接重发 mutation。
- `committed` → 视为已完成，提示并刷新；`pending` → 显示“尚未确认”，按钮变为“查询发布结果”，再点只查询；`absent` → 才允许同 key 重试；查询本身失败 → 按未知处理，保留意图。
- key 的意图摘要包含资源身份，`load()` 与权限变更都清空 key，资源切换不继承。

## 命令与结果

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 反例回归（内存事务） | `pnpm exec vitest run src/metrics/config/idempotency-recovery.test.ts` | 9 passed |
| HTTP 路由（含 pending/重放） | `pnpm exec vitest run src/metrics/config/routes.test.ts` | 14 passed |
| 一次性 MySQL（真实迁移） | `METRICS_TEST_MYSQL_PORT=13306 pnpm exec vitest run src/metrics/config/apply-idempotency-r1.mysql.test.ts` | 7 passed |
| 既有幂等证据包 | `METRICS_TEST_MYSQL_PORT=13306 pnpm exec vitest run src/metrics/config/apply-idempotency.mysql.test.ts` | 8 passed |
| config + policy 模块 | `METRICS_TEST_MYSQL_PORT=13306 pnpm exec vitest run src/metrics/config src/metrics/policy` | 192 passed, 12 skipped |
| API typecheck | `pnpm exec tsc --noEmit` | passed |
| 公开契约 | `pnpm contracts:check` | passed（已 `contracts:generate`） |
| 前端 typecheck / build | `pnpm exec tsc --noEmit` / `pnpm build` | passed；CSP 检查通过 |
| 前端测试 | `pnpm exec vitest run` | 1322 passed (148 files) |
| 浏览器恢复证据 | `pnpm exec playwright test --config playwright.MAX-238.config.ts` | 2 passed（chromium） |

一次性 MySQL：`docker run --rm -p 13306:3306 … mysql:8.4`，独立 schema `max238_apply_idempotency_r1_<pid>`，`afterAll` 删除库与容器；不使用 3306，不连业务库。

## 浏览器证据边界

`e2e/max238-idempotency-recovery.spec.ts` 由 Vite 提供真实组件，只通过自身控件操作；所有 `/api/metrics` 响应来自 Playwright 路由桩。activate 在桩内记录结果后以 `connectionreset` 中断响应，模拟“服务端已处理、客户端没收到响应”。它证明的是 UI 接线（同资源同 key 先查、committed 恢复、pending 不重发），**不是**真实 API、真实试采、目标库或正式采集验收。

## 未覆盖 / 限制

- 崩溃恢复只证明“保持 pending、不重试”，没有真实进程 kill + 远程阶段复现；不声称跨崩溃远程 exactly-once。
- 前端 key 只在页面生命周期内保留（组件内存）；硬刷新后按新意图生成新 key，状态仍由 `load()` 从头读取。未做跨刷新离线同步。
- 整单其余缺口（真实采集链、并发 revision 之外的权限变化窗口、最终整合 gate）不因本包关闭。
- 基点既有的 4 个 `rollout/coordinator`、`rollout/portfolio` `BINDING_PAYLOAD_*_INVALID` 失败与本包无关，未修改。
