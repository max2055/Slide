# MAX240-LATEST-DATA 交付说明（2026-10-29）

范围：MAX-240 原范围“最新数据并列展示”包。只改既有资源“指标与趋势”组件及其测试，不宣称 MAX-240 整单完成。未改后端、公开契约、schema/writer/retention/worker、policy/config/binding、资源详情页、导航或 MAX238 fixture。

## 1. 变更

| 文件 | 内容 |
|---|---|
| `frontend/src/app/ui/components/semantic-metrics.ts` | 新增“最新数据与当前采集状态”区：当前采集状态与阻塞、最后尝试（时间/状态/错误代码）、最近成功采集时间、绑定模板，与历史数值并列；每指标显示最近**成功**值（不再用最后一个可能为缺口的桶）、单位、观测时间、质量徽章及该桶来源的模板/采集器；当前状态不可用或值为旧桶/已过期时数值灰化并标记“非实时”，附值时间，不冒充实时健康。状态读取失败不清空历史；状态读取遇 401/403 按撤权清空。 |
| `frontend/src/app/ui/components/metric-api.ts` | 复用既有只读 `config/resources/:type/:id/status` 与 `attempts` 契约：新增 `CollectionAttempt` 类型、`readCollectionState`（不额外读取推荐列表）与 `readCollectionAttempts`（轻量结构校验）；补齐 `STALE_SAMPLE`、`LEGACY_CONFIGURATION_REVIEW_REQUIRED` 两个既有阻塞码的中文标签。 |
| `frontend/src/app/ui/components/semantic-metrics.test.ts` | 新增 7 组回归：当前失败与旧成功值并列、尾部缺口时保留较早成功值并灰化、最新有效桶显示“当前”与模板/采集器来源、无来源证据不臆造、全缺口显示“暂无最近成功值”、状态读取失败不隐藏数值、状态读取 403 清空；查询断言改为按 URL 定位查询调用，避免与新增的状态/尝试读取混淆。 |
| `frontend/e2e/MAX-240-history.spec.ts` | 真实浏览器用例新增最新数据断言：真实 `/status`、`/attempts` 响应，当前停用/失败、最后尝试错误码、最近成功时间、绑定模板，以及灰化的最近成功值与模板来源；同时保留原 24h/7d/自定义与撤权用例。测试夹具在一次性库里写入一条成功和一条更新的失败尝试。 |
| `docs/slide/development/MAX-240/e2e-20261029/` | 重新生成三档桌面截图，并新增 `latest-data-failure.png`。 |

语义要点：

- “最近成功值”取窗口内最后一个可用桶：标量值需在安全精度内、单位与定义一致、质量 good/partial；缺口、无效、单位不符不冒充数值。尾部缺口不会抹掉更早的成功值。
- 灰化条件：该值不是窗口最后一个桶、`freshness !== fresh`，或指标当前状态不是 `available`。灰化只影响呈现，不影响历史桶各自的数值与质量。
- “最后尝试”来自既有 `metric_attempts` 读取（最新 `started_at`），显示状态与 `error`/`evidence_code`；读取失败时退回状态接口的 `last_attempt_at` 与 `COLLECTION_FAILED`，不编造错误码。
- 模板来源只读该时间桶 `sources` 中的 `package_id@package_version` 与 `collector_id`；缺失时不显示，不推测。
- 状态/尝试读取是与查询并行的有界请求（每资源 2 个），失败不影响历史数值；401/403 视为撤权并清空旧结果。

## 2. 验证（绑定本分支）

环境：macOS darwin 27.2.0、Node v24.18.0、pnpm 11.19.0、Chromium（Playwright 1.59）。

| 检查 | 命令 | 结果 |
|---|---|---|
| 组件回归 | `vitest run src/app/ui/components/semantic-metrics.test.ts` | 26/26 通过 |
| 受影响前端模块 | `vitest run src/app/ui/components src/app/ui/views` | 104 文件 / 961 测试通过 |
| 前端类型 | `tsc --noEmit`（frontend） | 退出 0 |
| 前端构建 | `vite build` + `check-csp.mjs` | 通过，CSP check 通过 |
| lint（改动文件） | `oxlint semantic-metrics.ts metric-api.ts semantic-metrics.test.ts` | 0 warning / 0 error |
| 真实浏览器 + 真实 HTTP | `node node_modules/@playwright/test/cli.js test -c playwright.max240.config.ts` | 4/4 通过 |

浏览器证据绑定当次数据库与进程：

- 环境：一次性 `mysql:8.4` 容器（宿主 `127.0.0.1:62391`，非 3306；本次容器已删除），测试自建 `max240_ui_<uuid>` 库并 `DROP DATABASE`；真实 `server.ts` + JWT/密码登录 + Vite；模型 guard 计数 0。
- 夹具：24h 逐分钟历史（含 1400/1401 分钟缺口与 999,999 峰值），`metric_attempts` 写入 `succeeded`（`to-90s`）与 `failed/permission_denied/MYSQL_ACCESS_DENIED`（`to-30s`）。
- 断言：`/status` 返回 `collection.state=disabled`（夹具保持全局采集关闭）、`last_attempt_at=to-30s`、`last_success_at=to-85s`、`GLOBAL_COLLECTION_DISABLED`、绑定包 `mysql-basic`；`/attempts` 返回失败尝试及错误码。页面显示当前状态与阻塞、最后尝试时间/失败原因/错误码、最近成功采集时间、绑定模板；指标卡显示灰化的 `6 s`、观测时间、良好/新鲜/精确、`模板来源：模板 fixture 1.0.0 · 采集器 fixture`、`非实时` 及“最近成功值来自较早或已过期的时间桶”。1440×900 / 1366×768 / 1920×1080 无横向溢出；撤权后 403 且旧结果清除。
- 截图：`e2e-20261029/latest-data-failure.png`、`1440x900.png`、`1366x768.png`、`1920x1080.png`、`permission-revoked.png`。

清理：harness 结束后停止自启后端与 Vite、删除测试库与临时 workspace；shell 结束后删除本任务一次性容器。未连接共享 3306、未写业务库、未部署、未改共享服务。

公开契约未变化（只消费既有只读接口），未重复生成 `contracts:check`；后端与数据库未改，未重跑后端整仓或真实采集。

## 3. 未完成（整单剩余，不宣称完成）

- 历史阈值引用当时有效配置与事件快照、转入同窗口事件/AI。
- 停用/解绑后的授权历史读取、改名/普通版本升级身份保持（本包只沿用现有读取围栏，未改语义）。
- 公开原始值分页接口。
- 真实采集链路与容量 SLO qualification（fixture 与一次性数据库不等于真实采集）。
- 本轮未验证真实生产库的采集错误文案全集；`error` 枚举以外的值按原样显示。
