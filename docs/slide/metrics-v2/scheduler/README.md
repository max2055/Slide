# 采集计划与既有 Worker 集成

MAX-70 的内部入口是 `apps/db-ops-api/src/metrics-v2/scheduler/index.ts`。使用 MAX-69 发布配置、MAX-67 不可变包、MAX-66 公共 normalize/Counter/Derived、MAX-65 存储，以及 MAX-53 的 `WorkerRuntime`。不经过 Cron，不创建另一套运行时。

## 接入与权限

```ts
const store = new MysqlScheduleStore(controlPool, packages);
const scheduler = new MetricScheduler(store, packages, collectorAccess);
scheduler.register(existingJobRegistry); // metrics.collect
await scheduler.tick();                 // 宿主既有调度循环内调用，可重复
// 已有 worker.runOnce((job, context) => existingJobRegistry.execute(job, context))
// 关闭顺序：停止 tick → await worker.shutdown(timeoutMs)
```

`controlPool` 使用现有 dbConnection 的 UTC 值编码和 UTC session 设置；连接池须为预算槽和短事务留出连接。`collectorAccess.resolve(ref)` 是可信内部端口，必须只解析该资源的 inventory、credential 引用、授权 transport 与 counter/discontinuity evidence；不得从客户端注入此回调或采集实现。队列只存资源身份与 revision，不存凭据。Worker 在解析凭据前检查队列 owner/token/lease 和该资源 schedule.job_id，错配库存身份拒绝。

本项以隔离数据库、实际 Worker 和测试 Collector 验收；未在 `server.ts` 启用 V2 定时采集，未切换旧正式来源或配置生产凭据。下游接入时复用上述入口、资源授权和宿主生命周期，不能新建竞争采集循环。未启动调度时配置继续显示 pending，不虚报 applied。

## 计划与共享

编译输入为已解析配置和不可变 package pin。执行前在配置锁内用最新 inventory/capabilities 重新解析，配置 revision 不变。依赖按包内 DAG 展开；未知来源、无效周期/预算、禁用依赖均拒绝。发现到的维度在提交时实例化 MetricBinding，并通过公共 `validateBindings` 检查身份、来源、维度和基数。

同资源、同包 pin、同周期、同实现的 Collector 合并一次读取，多个标准观测复用同批结果；失败读取也共享，避免同一批内重发。不同资源不会因共享实现而合并周期。现有冻结策略只有资源级 interval；不添加隐含每指标提频规则。不同指标可以有不同 Collector，唯一来源约束是资源＋指标＋维度，不是资源只能用一个 Collector。

资源首次调度由稳定身份散列产生 0～min(interval,10s) 的错峰。正常下一次时间为上次执行结束＋interval，使用 `collection-scheduler.dueMetricIds` 复核；不会补跑积压周期。资源内串行（不超过配置 max_concurrency）；全局固定最多 4 个资源在途，跨进程共享 named-lock 槽。

## 持久化与故障语义

增量 migration `100_metric_v2_schedule.sql` 新增调度和事件表。入队与 schedule.job_id 原子提交；重复 tick 不重复排队。重启读取 next_due、Counter 状态和既有工作流任务。全批失败由现有 Worker 重试，最多 3 次，指数退避 1s/2s（公共上限 60s）；耗尽后恢复正常周期，不立即重排。部分转换失败记录 partial attempt，保留健康输出；结构性 transport/整批解码失败按失败批次处理，不伪造观测。

- 实际 Worker 校验并安装有效计划后，才写 application.applied_revision；published 与 applied 分开。新发布不取消历史，只隔离旧配置的迟到提交。
- 应用上报、观测、attempt、Counter 状态和调度更新分别在受配置锁与队列 fencing 校验的短事务中完成；观测/attempt/状态/next_due 同事务提交。提交结束前再次校验 lease 与取消。陈旧 owner 或 revision 不得写正式结果。失败 attempt 单独持久化，timeout 不篡改既有能力和 Counter 基线。
- 每次新的 SQL/SSH/SNMP transport 调用前检查 signal、连接存活、队列 fencing 和 revision。合作 handler 被取消后不得继续发起后续读取。普通包 runner 未传取消选项时保持既有 SSH 批调用兼容性。
- 超时取消不使用 Promise.race 提前释放资源锁。不可取消的在途请求保留资源锁和预算槽，直到 Promise 实际收敛；关闭可有界返回 false。取消发生时立即记录 cancellation_requested 和是否在途，随后隔离迟到结果。
- named lock 跟随专用数据库连接。进程崩溃/连接丢失后锁会释放，**不能证明目标设备上请求已经撤销或从未重复执行**；接管不承诺外部 exactly-once。数据库 fencing 只保护受控写入。无法收敛的在途操作会占用一个槽，须由宿主报告并处理，不能悄悄释放后重叠执行。

事件只有固定代码、资源/任务/revision、逻辑读取计划数、duration 和 uncertain，不保存远端异常文本。`logical_reads` 是启动批次的计划逻辑读取量（SQL=1，SSH=2，SNMP walk=1），不是网络 PDU 数或已实际完成请求数。事件表可用于统计；本次并发峰值通过隔离 Collector 屏障实测，不宣称生产容量。

## 验证、回退与限制

fixture：[fixtures.json](fixtures.json)；命令和结果：[validation.md](validation.md)。测试用显式 SQL 控制租约到期和领取可用时间，无固定 sleep 决定接管顺序。截止时间测试单独覆盖 timer；频率、错峰与 next_due 使用注入时钟。

回退只需宿主停止 tick、关闭 Worker 并撤销注册接入；保留新增表和观测，旧采集路径未改。生产来源切换、性能压测、目标设备取消能力、UI 展示不属于本项。公共 MySQL queue 并发领取可能返回死锁/idle，宿主须沿用已有 worker-loop 错误处理继续下一轮；本项不改公共 claim 协议，并发测试用显式屏障控制领取、保留四个同时在途请求。
