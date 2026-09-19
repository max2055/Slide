# MAX-76 隔离灰度与回退验收

基线 `6335d9a68a806b83e7e830c5648d66dfa86be933` 包含 MAX-74/#87、MAX-75/#88。分支 `agent/15astra/3d235fb316ad`。2026-09-19 执行；精确提交由 PR head 提供。设计 v1 已获批准，范围未扩大。硬预算未设定；实际 input/cached input/output/费用遥测不可用；子代理 0、深度 0、并发峰值 1。

## 结论与边界

新增显式 opt-in 正式来源控制，使用 MySQL 行锁串行化来源 CAS、发布、正式读取和告警转换。Worker 持有启动时捕获的来源 ticket；切换后旧 Worker 整批提交失败，不自动追认新代次。MetricStorageAdapter 的受控模式分离影子证据与正式值/历史，复用既有 SemanticQueryService/evaluateMetric 和 alerts 持久化。现有默认生产行为不自动启用。

本次验收是三类代表闭环、隔离灰度/回退，不是全指标迁移或生产部署。数据库来源/告警状态事务不等于 SMTP、通知或外部系统 exactly-once。

## 证据分层与差异解释

| 类别 | 环境与证据 | 值、质量、时间与开销 |
| --- | --- | --- |
| 数据库 | `database-evidence.json`；真实 MySQL 8.0.46、真实 Worker/存储/查询 | 五次固定 SQL 读取；uint64 保持字符串，速率按两次真实计数差/60 秒计算；首点为 counter_baseline，非 0；分配空间 estimated 不改为 exact。调度时间受控，事件 duration_ms 不是墙钟性能，另存 collector_wall_ms。 |
| Host | `host-evidence.json`；真实 Alpine 3.22 SSH 容器、真实 MySQL | CPU 使用同一份 top 输出与旧解析器比较，值相等；内存、文件系统 bytes/ratio 原单位和质量保留，ratio 不冒充 df 可用空间百分比；counter 两次采样后计算速率。raw_calls、版本、lineage、package_wall_ms 保留。 |
| SNMP | `snmp-evidence.json`；模拟 UDP Agent、真实 Worker/MySQL | rx/tx 分开；Counter64 不丢精度；派生 bit/s 与 fixture 期望相等；重启改变 interface_epoch 并回到 counter_baseline，禁止拼接旧 epoch；collector_wall_ms 是实际墙钟。不是物理交换机验证。 |
| 来源/告警 | `control.mysql.test.ts`、数据库 Worker 第三个测试 | CAS 竞争仅一方成功；pending revision 不发布；旧代次、错 revision、影子 evidence 被拒；20 路同键重复只创建一个 alerts 行；恢复后旧窗口不重开；未知质量不恢复；显式 SQL 故障使转换/状态/alerts 一起回滚。 |
| 语义与兼容 | `src/contracts/metrics-v2`、processor/query、consumers、config 测试 | 等价跨模板比较、不等价映射拒绝、Canonical/Extension 同质量约束、旧阈值与评分 review_required、CoreProfile 稳定、published/applied、Raw/Normalized/Aggregation 血缘。 |

证据中的真实采集值随环境运行变化；旧新比较使用相同输入/时间窗口，不能把两个不同时刻的主机读数当作实现差异。没有宣称老列中存在与所有 Extension 等价的历史值。

## 容量与放行阈值

`capacity.json` 包含独立 MySQL 实测与公式，数据值明确是契约 fixture。先每类一个测试资源，再扩展至 12 个资源、28 条序列（每资源维度分别为 1/2/4），周期 60 秒，10 轮，最大并发 4；共 280 对 Raw+Normalized。

- 需求按序列/周期计算：28/60 点对每秒，压力最低门槛为两倍（0.9334 点对每秒）。实测吞吐和写/查 p50/p95/p99 见 JSON；写入 p95 门槛 1000ms，低于配置周期。
- 原始 JSON 字节和表/索引分配是实测；表分配有 InnoDB 页粒度，不等于行 payload 总和。小样本外推有误差，不代表最大容量。
- 外推包括 Raw 7 天、Normalized 30 天、Raw tombstone 23 天、attempt 7 天、transition 30 天、索引和每序列控制状态。tombstone=128B、attempt=512B、transition=1024B、控制状态=2048B 是保守假设，分别标识，非伪装实测。
- 按每周期每序列最多一次转换估算后加 30% 余量及一份完整备份；准确结果见 `with_30_percent_headroom_and_one_backup_bytes`。采集墙钟样本量小（Host 仅两次），只用于隔离门槛，生产须重新测量。
- 来源冲突成功数、重复状态转换、错误映射及未解释数值差异门槛为 0；并发来源的拒绝是预期 fencing，不是放行错误。

## 复现与回退

前提：Docker、Node >=20、pnpm 11.19.0、Playwright Chromium。根目录执行：

```bash
pnpm install --frozen-lockfile
bash scripts/qualification/run-metrics-rollout.sh
```

脚本创建专用 MySQL/Linux 容器、随机 loopback 端口和 `max*_<pid>` 隔离数据库；不读取应用 .env。失败退出即停止，不跳过门禁；退出清理本次容器。重新生成的证据位于本目录。

已执行的回退场景可单独重复（端口必须指向上述同类隔离 MySQL，禁止生产）：

```bash
METRICS_V2_TEST_MYSQL_PORT=<isolated-port> pnpm --filter slide-api exec vitest run src/metrics-v2/rollout/control.mysql.test.ts -t 'serializes competing switches'
METRICS_V2_TEST_MYSQL_PORT=<isolated-port> pnpm --filter slide-api exec vitest run src/metrics-v2/rollout/capacity.mysql.test.ts
```

内部切换顺序：停止旧来源新增任务并收敛在途工作；`control.switch(series, expectedGeneration, {source, read, package: oldPin, revision: newRevision})` 原子递增来源代次并重置 applied；部署指定包的 Worker 后 `control.applied(series, ticket)` 确认同 revision；再恢复采集。回退也必须使用更高 revision/代次，CAS 冲突立即停止。切回 legacy 读模式保留其真实旧时间；无 V2→旧列伪造、无 DROP、无历史重算。测试对比切换前后观测行数/内容不变。

保留维护先调用既有 `MysqlMetricStorage.prune()`，再调用 `RolloutControl.prune()`；都是有界批次。Raw expires/tombstone 复用上游实库测试；本项补证正式历史索引清理、转换 ledger 清理后 monotonic watermark 仍拒绝旧窗口。每序列最后正式值与告警 watermark 保留，陈旧由原始时间与语义查询报告。

受控 legacy 回调必须使用传入的同一数据库连接；正式告警调用 `control.evaluate()`，不能把影子存储查询结果送给正式转换。部署集成必须将全部参与发布/消费的调用方接到此边界；本次没有激活生产 legacy 定时任务或默认 consumers 读路径。

## 验证记录

- 后端完整 gate：276 文件通过，2584 测试通过，112 项环境相关测试跳过；本项 metrics-v2 专项另用 MySQL/SSH/浏览器环境运行，不能将默认跳过当通过。
- 前端：78 文件、523 测试通过；类型检查、生产构建及 CSP 通过。已有大 chunk 提示，不属于本项阻塞。
- agent-core：10 文件、87 测试通过；类型检查通过。
- 后端类型检查通过；文档目录门禁 11/11 通过。
- 专项最终复现结果见 `verification.txt`。首次并行迁移 5 秒超时在单 worker 下通过，未扩大超时或放宽断言。故障注入改为显式 SQL SIGNAL，不依赖不存在的外键。
- PR CI 状态独立于本地证据，以 PR 页面为准；未宣称 CI 已通过。

## 发布清单与剩余风险

- 仅隔离测试资源及隔离扩大集合获验证；生产资源清单、容量、凭证、维护窗口和发布授权未提供，不执行生产变更。
- SNMP 是模拟设备；未覆盖所有引擎、物理交换机、Linux 发行版及全部指标。
- 隔离证据支持受控调用路径；未经受控适配器的旧写入不能靠登记来源自动被拦截。正式启用前须确认所有竞争写入者/消费者均切换且旧任务收敛。
- 规则版本必须由调用方稳定提供；同窗口结果以首次已接受评估为准。通知沿用既有系统，不承诺外部恰好一次。
- 任一必须门槛失败即 no-go；生产部署另需授权，本任务独立关闭不以生产上线为前提。
