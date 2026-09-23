# Metrics V2 生产接线与放行清单

状态：开发候选，**生产 NO-GO**。本文件不把隔离测试等同于生产启用。

## 已实现的运行行为

- 使用应用现有 WorkerRuntime / JobRegistry，注册 `metrics.collect`。唯一新增循环是其已有 MetricScheduler 的 1 秒 tick；同一进程不重叠扫描。
- `METRICS_V2_COLLECTION_ENABLED` 缺省为 `false`，只接受 `true` / `false`；启用前验证存储、策略、调度、rollout 和 publication 表。新任务只来自已经发布的策略。
- 关闭或丢失 WorkerLease 时停止调度和工作领取。tick 最多等待 5 秒，Worker 按既有 5 秒关闭预算取消/等待；超时记录 `METRIC_SHUTDOWN_TIMEOUT` / `WORKFLOW_SHUTDOWN_TIMEOUT`。关闭不删除队列、历史或用户覆盖，重启复用持久化调度状态。
- 资产删除、缓存数据库连接与当前地址/用户/数据库/凭据不符时拒绝访问；读取前和结果提交前再次比对资产/凭据快照，检测到变更则丢弃结果。目标地址和明文凭据不进入队列。SNMP discovery 按资产隔离、最多保留 4096 项；变化/淘汰/重启后重新建立基线。
- PostgreSQL 事务计数通过一个固定 SQL 同时读取当前数据库 OID、postmaster 启动时间、stats_reset、采样时间及精确计数；epoch 保留微秒级身份。启动、重置、数据库身份变化都会重新建立基线，不能跨代计算速率。普通 SQL/gauge 路径保持兼容。
- Linux 块设备通过固定 SSH 命令在 /proc/diskstats 两侧读取 boot ID、btime 和 /sys/block/*/diskseq；两侧身份不一致、缺少 kernel diskseq、输出截断或权限不足时拒绝建立连续计数。发现缓存按资产/凭据快照隔离，重启/淘汰后重建基线；不以接口名伪造网络接口生命周期。
- 旧告警与评分的兼容选择以该资源所有已登记序列的正式来源、read mode 和 applied revision 为依据；只有已确认 legacy 才回到旧路径。shadow 策略本身不会替换旧输入，混合/pending/失联状态不恢复告警或伪装为健康。此选择检查不是写入 ticket，不能替代尚未完成的发布 fencing。
- 生产 store 在远程 IO 前冻结**每条已登记序列**的 ticket，不使用全局 ticket。只有 `source=v2`、`read=v2`、package pin 与 published revision 匹配的序列才报告 applied 并有资格正式发布；未登记、新维度或不匹配项只保存 shadow。
- Worker 提交 Raw/Normalized、counter 状态、attempt 和 schedule 时使用同一事务与 fencing。Raw 不进入 publications。正式 V2 页面/Agent 服务的查询及维度发现仅接受 publications，pending/legacy 模式返回缺失 V2 证据。
- `METRIC_TICK_OK` 记录入队数量和耗时，`METRIC_TICK_FAILED` 不打印底层 SQL/远程错误。逐资源 `metric_v2_schedule_events` 保留采集失败、迟到、取消及逻辑读取观测。

## 迁移及恢复

部署候选必须经过既有 MigrationRunner 执行 098–102。098–101 未修改；102 新增 rollout 的资源归属与索引，对已有 latest 做身份回填。无 latest 的旧登记无法逆推 series hash，必须在正式上线前通过经授权的维护过程补齐并校验身份，不能自动绑定其他资产。

DDL 部分失败后禁止直接重复 ALTER、改写历史 migration 或清空 ledger。使用 `inspect` 确认失败语句位置；完成尚未执行的语句后，通过绑定**当前文件 checksum**的 verifier 检查字段、索引、回填及原来源/revision/历史数据，调用 `acknowledgeExternallyRepairedMigration` 后再运行迁移。`rollout/migration.mysql.test.ts` 对 ALTER 完成、backfill 未完成的情形作了真实 MySQL 故障注入。

配置开关只控制新增周期采集，不是完整业务回退。业务回退必须停止相应新任务、收敛在途工作，以更高 revision 和 generation CAS 切回 legacy，并核验查询和告警恢复。不得删除 V2 表或重算历史。

## 仍需实施/验证，不能直接放量

| 门槛 | 当前缺口与下一步 |
| --- | --- |
| SQL/Host 生命周期证据 | 已接入 PostgreSQL startup/stats_reset/OID 原子快照与 Linux boot/diskseq 块设备发现。MySQL、Oracle、Dameng 及 Linux 网络接口仍需可信重置/生命周期证据；MySQL Uptime 与接口名不能替代该证据。缺证据仍为未知。 |
| 旧正式写入者 | `metrics-database-service.ts` 的 metrics_history、服务器 server_metrics、`network-device-collector.ts` 的旧观测写入仍需逐资源来源 fence 和在途收敛。当前不自动停止它们。 |
| 全部消费入口 | V2 consumer runtime 已受控，旧告警/评分已区分 shadow 与正式 applied 来源；旧资源 summary/history、baseline、诊断和旧 Agent 工具仍需完整来源接线，告警最终写入仍需 ticket fencing。禁止同名强制映射或补造 V2 历史。 |
| 动态维度与发布编排 | 内部 RolloutControl 有 CAS；尚无完整生产登记、shadow 比较、按资源/类型/全局切换协调器。新维度默认 shadow。 |
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
