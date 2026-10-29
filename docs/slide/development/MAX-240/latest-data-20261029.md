# MAX240-LATEST-DATA 交付说明（2026-10-29）

范围：Chief 准入的 MAX-240 原范围下一包「最新数据并列展示」。基于有界接受的 HISTORY-UI 修正 `99e0c3be7` 之上追加，只改既有语义指标视图、对应组件测试、`metric-api.ts` 的只读 status/attempts 读取函数与本目录文档。未恢复已撤回的 `ee9c7478f`。未改后端、schema、writer、retention、policy/围栏、activate、必要指标名单、资源详情页或 MAX238 文件。MAX-240 与 MAX-235 仍 `in_progress`。

## 1. 变更

| 文件 | 内容 |
|---|---|
| `frontend/src/app/ui/components/metric-api.ts` | 新增 `readCollectionSummary`（只读 `.../status`，**不再**经 `readCollectionStatus` 附带 recommendations）与 `readCollectionAttempts`（只读 `.../attempts`，校验数组）；`CollectionAttempt` 最小类型（status/started_at/ended_at/error/evidence_code）。`readCollectionStatus` 保持不变。 |
| `frontend/src/app/ui/components/semantic-metrics.ts` | 在既有视图顶部并列四项：当前采集状态、最近一次尝试、正式采集成功时间、窗口内最近可用值。状态条与历史查询分开读取：401/403/404 清除受保护结果；其他失败只显示状态条读取失败，历史结果保留。 |
| `frontend/src/app/ui/components/semantic-metrics.test.ts` | 新增 6 组回归（见 §2）；3 处窗口断言改为定位 `/api/metrics/query` 调用，不再假设它是最后一次请求。 |
| `frontend/e2e/MAX-240-history.spec.ts` | 同一任务 harness 增加失败+旧成功值用例；后端进程显式 `METRICS_COLLECTION_ENABLED=true`，并种入同一 `config_revision` 的成功/失败采集尝试。原有 3 个用例保留。 |
| `docs/slide/development/MAX-240/e2e-20261029/` | 刷新 1440/1366/1920 与撤权截图，新增 `latest-data-failed.png`。 |

语义：

- **当前采集状态**：`collection.state`、`in_flight`、`blockers`（资源采集状态，不是时间桶质量）。
- **最近一次尝试**：`status`、`started_at`/`ended_at`、`error`、`evidence_code`；`partial`/`failed` 显式标“不是成功”，没有尝试写“暂无采集尝试”。
- **正式采集成功时间**：`collection.last_success_at` 与 `formal_visibility.last_observed_at` 分别列示，不同时提示“两者不同”，不合成一个时间。
- **窗口内最近可用值**：从新到旧第一个 `chartValue` 非空的桶；带单位、质量、accuracy、freshness、观测时间与 sources 中已有的 collector/package。只用与曲线相同的可绘制条件，单位不符、非标量、超安全整数、unknown/invalid 不会成为该值；无可用桶写“暂无”，不补 0。
- **灰化条件**：指标 `state !== available`、该桶 `freshness !== fresh`，或该桶不是窗口内最新桶。灰化值附“旧值，不代表当前健康。”；当前采集失败时历史曲线与旧值仍保留。

## 2. 验证（绑定本提交）

| 检查 | 命令 | 结果 |
|---|---|---|
| 组件回归 | `vitest run src/app/ui/components/semantic-metrics.test.ts` | 28/28 通过（22 既有 + 6 新增） |
| RED 证据 | 以 `99e0c3be7` 版 `semantic-metrics.ts`/`metric-api.ts` 跑同一测试文件 | 6 个新用例失败，22 个既有通过；恢复实现后 28/28 |
| 受影响前端模块 | `vitest run src/app/ui/components src/app/ui/views` | 104 文件 / 963 测试通过 |
| 前端类型 | `npx tsc --noEmit`（`frontend/`） | 退出 0 |
| 前端构建 | `pnpm build`（`frontend/`） | vite build 通过，CSP check 通过 |
| 改动文件 lint | `oxlint` 4 个改动文件 | 0 warning / 0 error |
| 真实浏览器 + 真实 HTTP | `playwright test -c playwright.max240.config.ts` | 4/4 通过（3 既有 + 1 新增） |

真实浏览器证据绑定当次数据库与进程：

- 环境：Node 24.18.0、Chromium（Playwright）、一次性 `mysql:8.4` 容器 `67376fb158f0`（宿主 `127.0.0.1:63421`，非 3306）；测试自建 `max240_ui_<uuid>` 库并在结束后 `DROP DATABASE`，容器已删除；真实 `server.ts` + JWT 登录 + 真实 Vite；模型调用 0（本地 guard 拒绝，`afterAll` 断言 `modelCalls === 0`）。
- 种入数据：同一 `config_revision=1` 下一条成功尝试（`to-2h`）与一条较新的失败尝试（`to-10m`，`connection_error` + `CONNECTION_REFUSED`），以及 24h 逐分钟历史（含缺口与 999999 峰值）。
- 断言：`GET .../status` 返回 `collection.state=failed`、`blockers` 含 `COLLECTION_FAILED`、`last_success_at` 为旧成功尝试的 `ended_at`、`last_attempt_at` 为失败尝试的 `started_at`、`formal_visibility.last_observed_at` 非空；`GET .../attempts` 首条为失败并携带证据码。UI 同时显示四项；旧值带灰化类与“旧值，不代表当前健康”；24h 曲线仍为 1,440 桶且 1,000+ 可绘制点。
- 状态条只读 status/attempts，不发 recommendations；组件测试断言调用列表无 `/recommendations`，且只有 `GET status|attempts` 与查询 `POST`。
- 读取失败语义由组件测试覆盖（mock 仅用于读取失败）：503 保留历史并显示“采集状态读取失败；历史查询结果保留”，403/401/404 清除结果并报权限。
- 截图：`e2e-20261029/latest-data-failed.png`、`1440x900.png`、`1366x768.png`、`1920x1080.png`、`permission-revoked.png`；后端日志 `backend.log` 留在本机证据目录（`*.log` 不入库）。

清理：harness 结束停止自己启动的后端与 Vite、删除测试库、删除临时 workspace；一次性容器已 `docker rm -f`。未连接共享 3306、未写业务库、未部署。

公开契约未变化，未重新生成 `contracts:check`；后端与数据库未改，未重跑 R1 的 query 22/22、counter 100 组或 MySQL/HTTP 6/6。

## 3. 未完成（整单剩余，不宣称完成）

- 历史阈值引用当时有效配置与事件快照、转入同窗口事件/AI。
- 停用/解绑后的授权历史读取、改名与普通版本升级的身份保持。
- 公开原始值分页接口。
- 真实采集链路与容量 SLO qualification。
