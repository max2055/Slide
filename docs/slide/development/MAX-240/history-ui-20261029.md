# MAX240-HISTORY-UI 交付说明（2026-10-29）

范围：Chief 准入的 MAX-240 原范围历史展示包。在已接受的 HISTORY-WINDOW/R1（`042926f27`）之上，只改既有历史组件与测试，不宣称 MAX-240 整单完成。未改后端 query/formal-store/consumer、policy/config/bindings、DDL/writer/retention/worker、资源详情页、导航、共享配置或 MAX238 fixture。

## 1. 变更

| 文件 | 内容 |
|---|---|
| `frontend/src/app/ui/components/semantic-metrics.ts` | 6h/24h/7d/自定义窗口；24h 与 7d 使用 60s 时间桶（1,440 / 10,080），自定义按 `ceil(窗口/10,080)` 向上取整到分钟并显式提示较粗粒度；数值与曲线共用响应 `window` 与本地时区；历史 good/exact 值不再按 `freshness`/当前 state 隐藏；缺失与无效保留断点；单位不符、超安全精度、非标量记录单独反馈；观测明细默认折叠且打开后最多渲染 200 个时间桶；沿用 generation/accessInvalidated 丢弃迟到响应与撤权结果。 |
| `frontend/src/app/ui/components/metric-chart.ts` | `MetricSeries` 可选 `min`/`max`；以虚线上下限渲染桶内包络，图例与网格随包络行数调整。 |
| `frontend/src/app/ui/components/semantic-metrics.test.ts` | 新增 9 组回归：桶宽/7d/自定义校验、历史 stale-good 保留、缺口断点与 min/max 包络、单位不符与合法 `By/s`、非标量记录、10,080 桶有界 DOM、快速切窗丢弃迟到响应。 |
| `frontend/e2e/MAX-240-history.spec.ts`、`frontend/playwright.max240.config.ts` | MAX240 专属真实浏览器 harness；独立一次性 MySQL、真实后端、真实登录与真实 `/api/metrics/query`。仅在提供 `MAX240_TEST_MYSQL_PORT` 时运行，其他套件跳过。 |
| `docs/slide/development/MAX-240/e2e-20261029/` | 1440×900 / 1366×768 / 1920×1080 与撤权截图、后端日志。 |

要点：

- `bucketMsFor(from, to)`：窗口 ≤ 7 天时 60s；更宽时 `max(60s, ceil(span / 10,080 / 60s) × 60s)`。31 天 → 5 分钟（8,928 桶），不静默截断；UI 显示“每桶 N 分钟，共 N 个”和粗粒度说明。
- 图表值只取决于该时间桶自身：`quality ∈ {good, partial}`、单位与定义一致、`|n| ≤ Number.MAX_SAFE_INTEGER`；`freshness` 与当前 `state` 不参与。当前采集状态、历史质量、观测时间分开显示。
- `SemanticBucket.stats.min/max` 是编码值对象（`{encoding,value}`），包络读取 `.value`；浏览器用例已验证 999,999 的桶内峰值只出现在上下限而不改写 `value`。
- 非标量桶（histogram/summary）不做折线，按编码记录展示；明细明确标注“聚合值，不是原始采样”。
- 公开原始值分页仍未开放，本包不把时间桶称为原始采样。

## 2. 验证（本分支本次提交）

| 检查 | 命令 | 结果 |
|---|---|---|
| 组件回归 | `vitest run src/app/ui/components/semantic-metrics.test.ts` | 19/19 通过 |
| 受影响前端模块 | `vitest run src/app/ui/components src/app/ui/views` | 104 文件 / 954 测试通过 |
| 前端类型 | `pnpm --filter slide-frontend typecheck` | 退出 0 |
| 前端构建 | `pnpm --filter slide-frontend build` | 通过，CSP check 通过 |
| 真实浏览器 + 真实 HTTP | `node node_modules/@playwright/test/cli.js test -c playwright.max240.config.ts` | 3/3 通过 |

浏览器证据绑定当次数据库与进程：

- 环境：macOS darwin 27.2.0、Node 24.18.0、Chromium（Playwright 1.59）、一次性 `mysql:8.4` 容器 `f857dbce1f7d`（宿主 `127.0.0.1:62391`，非 3306），测试自建 `max240_ui_<uuid>` 库并在结束后 `DROP DATABASE`；真实 `server.ts` + JWT/密码登录 + 真实 Vite 前端；模型调用由本地 guard 拒绝（`modelCalls = 0`）。
- 受控历史：逐分钟 3 个样本（24h，含 1400/1401 分钟缺口），第 720 分钟一个 999,999 峰值；正式 publication/rollout 与资源 8401 的绑定由应用服务写入。
- 断言：24h 请求 `bucket_ms=60000`、响应恰 1,440 桶、首尾桶边界与请求窗口一致、缺口 `value=null, stats=null`、峰值 `stats.max=999999` 且包络随 chart `series.max` 到达浏览器；7d 请求 60s、响应 10,080 桶；自定义 8 天请求 `bucket_ms=120000` 且 UI 显示“每桶 2 分钟”“未静默截断”；历史 good/exact 桶 `freshness=stale` 仍显示数值与“过期”徽章；明细默认 0 行、打开后 200 行；1440/1366/1920 无横向溢出；撤除资源权限后刷新返回 403、错误“没有此资源的查看权限”且旧结果被清除。
- 截图：`e2e-20261029/1440x900.png`、`1366x768.png`、`1920x1080.png`、`permission-revoked.png`；后端运行日志 `backend.log` 留在本机证据目录（`*.log` 按仓库规则不入库）。

清理：harness 结束后停止自己启动的后端与 Vite、删除测试库、删除临时 workspace；shell 结束后 `docker rm -f` 本任务一次性容器。未连接共享 3306、未写业务库、未部署、未改共享服务。

公开契约未变化，未重复生成 `contracts:check`；后端与数据库未改，未重跑后端整仓或真实采集。

## 3. 未完成（整单剩余，不宣称完成）

- 最新数据并列展示“当前采集状态 / 最近成功值 / 最后尝试及失败原因”的完整组合（本包只修历史窗口与质量语义，未重写最新数据）。
- 历史阈值引用当时有效配置与事件快照、转入同窗口事件/AI。
- 停用/解绑后的授权历史读取、改名/普通版本升级身份保持。
- 公开原始值分页接口。
- 真实采集链路与容量 SLO qualification。
