# MAX238-COLLECTION-DISPLAY-E2E：资源→模板→指标→采集器→真实样本→页面

本目录记录 2026-10-29 采集链路端到端交付。**一句话结论**：在一个隔离平台库里注册真实 MySQL 目标，经产品 API 绑定固定发布的 `mysql-diagnostics@1.1.0`、完成真实试采与发布，调度器连续 9 个周期从目标读取并写入该环境正式历史；最新数据 API 和浏览器页面读到同一对象、模板版本、指标身份、值与采集时间。**这不是 24h 历史、容量、迁移、触发恢复或 AI 闭环的验收，也不等于 MAX238 整单完成。**

机器证据：[collection-chain-20261029.json](collection-chain-20261029.json)。浏览器截图随交付评论附上。

## 1. 环境与版本

| 项 | 值 |
|---|---|
| 任务分支 | `agent/15coder1/max-238` |
| 代码 HEAD（本证据） | `0f1dfaff25fde7c897bb4250523ece363b175ba8` |
| 运行方式 | 真实 `apps/db-ops-api/server.ts`（127.0.0.1:3001）+ 真实 Vite 前端（127.0.0.1:5173，代理 `/api`） |
| 平台库 | 一次性 MySQL 8.4，`127.0.0.1:13306`，库 `slide_e2e_238`；**未使用 3306** |
| 目标库 | 一次性 MySQL 8.4.10 容器，经局域网地址（`192.168.1.20:13307`）访问，只读账号 |
| 配置指纹 | `METRICS_COLLECTION_ENABLED=true`，`NODE_ENV=development`，`METRICS_TEST_MYSQL_PORT` 未用于本链路；非生产部署 |
| 未包含密钥 | 只记录主机/端口/库名/包摘要/版本；无密码、令牌或凭据引用值 |

**服务器 3（192.168.49.130:22）本轮不可达**：`icmp` 2 包 100% 丢失，22/80/443/3306/9100 全部拒绝，ARP 为 incomplete；因此未使用文档中的 SSH 项，改用指令允许的 MySQL 目标路径。网络设备按既有决定不参与本轮。

## 2. 资源与模板（固定发布版本）

| 项 | 值 |
|---|---|
| 资源 | `instance:1`，名称 `mysql3306`，MySQL，`192.168.1.20:13307`，库 `e2e_shop` |
| 版本 | `8.4.10`，由本次新增的连接时探测写入（见 §7），不是人工填写 |
| 模板（包） | `mysql-diagnostics@1.1.0`，digest `sha256:785a03fc665f5dbb374e5896a41b4134dd1f2af6f64deeee06c4dca432b7250f` |
| 计划 | 33 个指标、14 个已实现采集器 + 4 个派生指标；`interval_ms=60000`，`timeout_ms=5000`，`stale_after_ms=120000` |
| 适用性 | `db.engine=mysql` 命中，`db.version=8.4` 命中（包允许 5.7/8.0/8.4/9.6） |

指标→采集器全部来自发布包自身的映射（详见 JSON `template.metric_sources`）：

| 采集器 | 指标 |
|---|---|
| `diagnostics_connections` / `diagnostics_limit` | 当前会话数、最大连接数 |
| `diagnostics_transactions` | commit/rollback 累计 |
| `diagnostics_size` | `mysql.tables.estimated_allocated_bytes` |
| `diagnostics_queries` | `mysql.queries.total`、慢查询累计 |
| `diagnostic_counters` | protocol 字节、handler read、aborted connects 等 5 项 |
| `diagnostic_gauges` | threads、files、key cache 块等 5 项 |
| `diagnostic_ratios` | buffer pool 命中率、key cache/table cache 命中等 3 项 |
| `innodb_diagnostics` | row lock 均值、deadlocks、临时磁盘表 |
| `buffer_pages` / `uptime_diagnostics` / `thread_cache` / `active_transactions` | 缓冲页使用、`db.uptime_seconds`、线程缓存命中、活动事务 |
| `replication_channels` | 复制延迟/IO/SQL 状态（本目标无复制通道） |
| 派生 | commit/rollback/completed 速率、`mysql.queries.per_second` |

## 3. 流程回执

1. **绑定与检查**：`POST /api/metrics/policy/resources/instance/1/preview` → 200，`expected_revision=0`，无 `unsupported` 适用性。
2. **试采**（真实读取目标、不写正式历史）：`POST /api/metrics/config/resources/instance/1/trial` → `decision=attempted`，14 个采集器全部 `succeeded`，30 个样本（其中 1 个复制通道采集器无样本，不伪造）。样本含 `unit_check`（输入/输出单位）与逐项读取状态。
3. **应用并启用**：`POST .../activate`，`operation_key=max238-chain-20261029-01` → 200，发布 `revision=1`；审计 1 条 `binding.publish`（14:22:43Z）。
4. **应用状态**：`application` 在首个正式采集开始时由 `pending` 转 `applied`（`applied_revision=1`）；该字段的 `reported_at` 随每个采集周期刷新为最近一次（14:31:04Z），不是前端标称。
5. **正式采集**：`metric_schedule` 有 `instance:1` 行；`metric_schedule_events` 全部为 `committed`（9 次；首周期建立正式系列，其后 8 个周期写入正式发布），无失败/不确定事件；`metric_source_acceptance` 记录 revision 1、generation 1。
6. **正式历史**：`metric_observations`（normalized）+ `metric_publications` 240 条（30 series × 8 个发布周期），首条 14:23:50Z、最新 14:31:05Z；`metric_rollout` 30 series，全部 `read_mode=semantic`、`applied_revision=published_revision`。

## 4. 真实样本（同一批，可追溯到采集器与 attempt）

| 指标 | 采样值 | 质量/准确度 | 采集时间 (UTC) | 来源 |
|---|---|---|---|---|
| `db.uptime_seconds` | 697 s | good / exact | 14:31:04.854 | `uptime_diagnostics` |
| `mysql.processlist.count` | 3 | good / exact | 14:31:04.854 | `diagnostics_connections` |
| `mysql.connections.limit` | 151 | good / exact | 14:31:04.854 | `diagnostics_limit` |
| `mysql.tables.estimated_allocated_bytes` | 16384 By | good | 14:31:04.854 | `diagnostics_size` |
| `mysql.queries.per_second` | 0.35 count/s | good | 14:31:04.854 | 派生 |
| 其余 27 项 | 见 JSON | 32/33 可用 | — | 各自采集器 |

`mysql.innodb.deadlocks_total` 保持 `capability_unknown`：MySQL 8.4 的 `SHOW GLOBAL STATUS` 不再返回 `Innodb_deadlocks`，字段级证据缺失。页面显示“资源能力待验证”即由这一项导致；它没有被补零或伪造。

## 5. 最新数据 API 对照

`POST /api/metrics/query {"resource":{"type":"instance","id":1},"view":"all"}` → 200，33 个指标中 32 个 `available`，每个 bucket 带 `sources[].versions.package_id/package_version/config_revision=1` 与 `observed_at`，与 §4 相同。`view=core` 返回“数据库运行时长 / 数据库大小”两列同样来自同一正式发布。`GET /api/metrics/config/resources/instance/1/status` 返回 `application=applied`、`formal_visibility.state=available`、`freshness=fresh`、`last_observed_at` 与发布一致。

## 6. 页面

真实前端（Vite）经产品登录门登录后：

- **实例列表**：`mysql3306` 行显示版本 8.4.10、数据量 16.00 KiB、最近采集时间；“数据量”来自本次绑定模板的 `mysql.tables.estimated_allocated_bytes`。
- **实例详情 → 采集配置**：采集模板 `mysql-diagnostics`、模板 1.1.0、配置版本 1、有效采集开关“已启用（本资源覆盖·已应用）”、最近正式样本时间、最近配置事件“发布资源配置·版本 1”。
- **实例详情 → 指标与趋势**：`数据库运行时长 635 s`、`当前会话数 3`、`最大连接数 151`、`数据库大小 16384 By`、`MySQL 每秒查询数 0.354…`，各自显示观测时间 2026/10/29 22:30:02 与“良好/新鲜/精确”（截图时间点的样本，晚于 §4 的下一周期）。

截图：`max238-chain-instances-list.png`、`max238-chain-instance-detail.png`、`max238-chain-binding.png`、`max238-chain-metrics.png`。

## 7. 本轮必要接线

新注册的实例此前无法进入链路：能力判定只读 `database_instances.db_version`，而该列在旧健康采集退役后无人写入，导致试采固定返回 `capability_unknown`、不建立任何采集器。本轮在“连接建立成功后”读取目标实际报告的版本并记录：`databaseService.detectVersion` + `instanceDatabaseService.recordDetectedVersion`，接入 `POST /api/database/instances/:id/reload` 与启动重连；探测失败或为空保持未知，不猜测、不填占位。验证：清空该实例版本后调用 reload，版本恢复为 `8.4.10`；新增 7 项单测。

## 8. 门禁与未完成项

- `pnpm --filter slide-api typecheck`：通过。
- 新增测试 `database-service.detect-version.test.ts`、`instance-database-service.detected-version.test.ts`：7 passed。
- 相关既有测试（database-service 4 个文件 + instance-database-service 2 个文件）：71 passed。
- 未改前端、未改 metrics 采集/调度/存储语义，未部署、未合并。
- **整单仍未完成**：24h 历史窗口、容量与迁移演练、触发/恢复、通知、AI 闭环、网络设备实机、服务器 3 SSH 项均未在本轮验收；原范围其余项逐项保留。
- 移除环境：一次性平台库与目标库容器在本轮结束前删除；共享开发库、3306 和他人服务未被触碰。
