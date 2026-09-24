# Metrics V2 生产接线与放行清单

状态：开发候选，**生产 NO-GO**。本文件不把隔离测试等同于生产启用。

## 已实现的运行行为

- 使用应用现有 WorkerRuntime / JobRegistry，注册 `metrics.collect`。唯一新增循环是其已有 MetricScheduler 的 1 秒 tick；同一进程不重叠扫描。
- `METRICS_V2_COLLECTION_ENABLED` 缺省为 `false`，只接受 `true` / `false`；启用前验证存储、策略、调度、rollout 和 publication 表。新任务只来自已经发布的策略。
- 关闭或丢失 WorkerLease 时停止调度和工作领取。tick 最多等待 5 秒，Worker 按既有 5 秒关闭预算取消/等待；超时记录 `METRIC_SHUTDOWN_TIMEOUT` / `WORKFLOW_SHUTDOWN_TIMEOUT`。关闭不删除队列、历史或用户覆盖，重启复用持久化调度状态。
- 资产删除、缓存数据库连接与当前地址/用户/数据库/凭据不符时拒绝访问；读取前和结果提交前再次比对资产/凭据快照，检测到变更则丢弃结果。目标地址和明文凭据不进入队列。SNMP discovery 按资产隔离、最多保留 4096 项；变化/淘汰/重启后重新建立基线。
- PostgreSQL 事务计数通过一个固定 SQL 同时读取当前数据库 OID、postmaster 启动时间、stats_reset、采样时间及精确计数；epoch 保留微秒级身份。启动、重置、数据库身份变化都会重新建立基线，不能跨代计算速率。普通 SQL/gauge 路径保持兼容。
- Linux 块设备通过固定 SSH 命令在 /proc/diskstats 两侧读取 boot ID、btime 和 /sys/block/*/diskseq；两侧身份不一致、缺少 kernel diskseq、输出截断或权限不足时拒绝建立连续计数。发现缓存按资产/凭据快照隔离，重启/淘汰后重建基线；不以接口名伪造网络接口生命周期。
- 旧告警与评分的兼容选择以该资源所有已登记序列的正式来源、read mode 和 applied revision 为依据；只有已确认 legacy 才回到旧路径。shadow 策略本身不会替换旧输入，混合/pending/失联状态不恢复告警或伪装为健康。
- Metrics V2 正式告警携带不可变 series/source/generation/revision fence。通知 Worker 在外部发送前重新核对告警仍为 unread、rollout 已 applied 且 ticket 完全匹配，并持有逐序列锁直到发送结束；切换、回退和正式恢复使用同一锁。已排队的旧代次告警会记为 skipped，不调用外部渠道；发送前数据库故障进入 retryable，发送已开始后的不确定结果仍按既有人工协调契约处理。
- 资源 overview、metrics summary、diagnose 及 `diagnose_resource` Agent 共用的 observations 入口已按资源正式来源选择：只有完整 applied legacy 状态读取旧表；pending、mixed 或 V2 状态不混入旧观测。诊断包中的 V2 数据继续由正式 `semanticMetrics` 提供，缺少旧字段时保持缺失，不做同名强制映射。
- 数据库 `metrics_history`、服务器 `server_metrics` 和网络设备 `network_device_observations` 的旧正式写入与 rollout/policy 共享事务锁。未登记资源保持 legacy；资源存在任一 pending、mixed 或 V2 序列时，旧采集器在 SQL/SSH/SNMP 前停止新指标任务，已在途任务在最终提交时再次检查并丢弃晚到结果。切换、回退和 applied 更新遵循同一锁顺序，不能与旧写入交叉提交；状态探测与资产元数据不冒充正式指标。
- 生产 store 在远程 IO 前冻结**每条已登记序列**的 ticket，不使用全局 ticket。只有 `source=v2`、`read=v2`、package pin 与 published revision 匹配的序列才报告 applied 并有资格正式发布；未登记、新维度或不匹配项只保存 shadow。
- Worker 提交 Raw/Normalized、counter 状态、attempt 和 schedule 时使用同一事务与 fencing。Raw 不进入 publications。正式 V2 页面/Agent 服务的查询及维度发现仅接受 publications，pending/legacy 模式返回缺失 V2 证据。
- `METRIC_TICK_OK` 记录入队数量和耗时，`METRIC_TICK_FAILED` 不打印底层 SQL/远程错误。逐资源 `metric_v2_schedule_events` 保留采集失败、迟到、取消及逻辑读取观测。
- 逐资源 rollout 协调器执行 `legacy -> shadow -> pending -> v2`：服务端根据 V2 observations 生成并保存 shadow 证据，达到门槛后停止该资源旧/V2 新任务、等待在途工作收敛，在逐序列告警锁与策略锁内以 CAS 原子提升 generation/revision，并等待匹配的 applied revision。回退使用更高 generation/revision 切回 legacy、停止 V2 新任务，保留 V2 历史与审计；过期协调作业不能抢占更新 revision。
- 正式读取统一经过资源来源路由器；legacy、V2、pending/mixed 严格单选，不以 pending 查询失败回退旧表。实例实时/历史 API 在 V2 下返回完整 semantic payload，前端切换来源时清除旧缓存并使用 canonical 组件展示单位、维度、质量、新鲜度与来源，不把指标强制映射为旧 CPU/QPS 字段。
- legacy baseline 只在正式来源为 legacy 时计算或读取缓存；V2 返回明确不可用，pending 不读取旧缓存。health/performance/capacity 报表按正式来源路由，V2 报表查询 `view=all`、保存完整 semantic response，并逐系列展示值、单位、维度、质量、freshness、coverage 与来源；slow-query 报表不依赖指标来源，保持原路径。

## 迁移及恢复

部署候选必须经过既有 MigrationRunner 执行 098–103。098–101 未修改；102 新增 rollout 的资源归属与索引，对已有 latest 做身份回填；103 新增逐资源 rollout 协调状态及 shadow evidence。无 latest 的旧登记无法逆推 series hash，必须在正式上线前通过经授权的维护过程补齐并校验身份，不能自动绑定其他资产。

DDL 部分失败后禁止直接重复 ALTER、改写历史 migration 或清空 ledger。使用 `inspect` 确认失败语句位置；完成尚未执行的语句后，通过绑定**当前文件 checksum**的 verifier 检查字段、索引、回填及原来源/revision/历史数据，调用 `acknowledgeExternallyRepairedMigration` 后再运行迁移。`rollout/migration.mysql.test.ts` 对 ALTER 完成、backfill 未完成的情形作了真实 MySQL 故障注入。

配置开关只控制新增周期采集，不是完整业务回退。业务回退必须停止相应新任务、收敛在途工作，以更高 revision 和 generation CAS 切回 legacy，并核验查询和告警恢复。不得删除 V2 表或重算历史。

## 仍需实施/验证，不能直接放量

| 门槛 | 当前缺口与下一步 |
| --- | --- |
| SQL/Host 生命周期证据 | 已接入 PostgreSQL startup/stats_reset/OID 原子快照与 Linux boot/diskseq 块设备发现。MySQL、Oracle、Dameng 及 Linux 网络接口仍需可信重置/生命周期证据；MySQL Uptime 与接口名不能替代该证据。缺证据仍为未知。 |
| 代码级写入/消费边界 | 仓库内三类旧正式写入、正式告警/评分/通知、资源诊断与 Agent、实例实时/历史 API、canonical UI、baseline 及指标型 report 已接入统一来源边界；逐资源协调器负责停止任务、排空、CAS、applied 与回退。上线前仍须按实际部署版本复核没有私有分支、外置任务或新增入口绕过边界。 |
| 动态维度与发布编排 | 协调器已从服务端 V2 observations 生成 series 集合与 shadow gate，不接受客户端提交 series、目标、凭据、SQL、命令或 OID；新维度默认 shadow。仍需在生产资产上建立 package pin/策略/凭据权限，记录每批 shadow 证据并执行逐资源、类型和全局操作演练。 |
| Counter/Derived 真实目标 | 隔离 fixture 能验证契约，不能证明当前生产 MySQL/PG/Oracle/Dameng 版本、Linux 发行版或物理交换机通过。 |
| 容量与监控阈值 | 需要资源数、峰值序列基数、周期、Raw/Normalized 保留期、索引实测、备份空间及连接池/Worker 配额。以每类实测数据外推，并保留至少 30% 余量和一份完整备份。现有 12 资源样本不可作生产容量结论。 |
| 生产放量与回退 | 需要明确部署实例、首批资产 ID/版本、凭据引用、窗口和操作范围。按批记录 published/applied revision、generation、pin、数值/单位/质量/新鲜度/缺失率差异、重复告警与回退点；必须项失败即停量。 |

不要仅打开 `METRICS_V2_COLLECTION_ENABLED` 就把 issue 标记为生产完成。它首先用于获准的 shadow 验证；正式来源必须等上述写入/消费边界和真实验收完成后才切换。

## 可复核验证命令

在独立空 MySQL 上设置 `METRICS_V2_TEST_MYSQL_PORT`；相关测试自行创建并删除带进程 ID 的隔离数据库。不要指向生产数据库服务。Linux fixture 另设 `METRICS_V2_TEST_SSH_PORT` / `METRICS_V2_TEST_SSH_PASSWORD`。物理设备仍需单独授权验收。

```bash
pnpm --filter slide-api exec vitest run src/metrics-v2 src/contracts/metrics-v2 --maxWorkers=1
pnpm --filter slide-api typecheck
pnpm --filter slide-frontend typecheck
pnpm --filter slide-frontend build
pnpm contracts:check
pnpm qualification:matrix
pnpm security:scan
pnpm security:deployment
```

完整门禁和任何跳过/既有失败应随候选提交记录。测试未运行、环境跳过、模拟设备均不得写成生产通过。
