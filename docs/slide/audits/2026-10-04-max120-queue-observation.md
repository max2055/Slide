# MAX-120 / W12a v1：队列观测与串行阻塞测量

基线为最新 main `4caeaecf32cd1f0d08c2b7ac7b68deaa0a4b3504`，MAX-119 / PR #124 已合并且父任务已验收。本任务在隔离 worktree 的 `codex/max-120-queue-observation` 分支实施；原 runtime worktree 的 AGENTS.md 未触碰，不派生代理。

## 执行契约与交付选择

范围：按 job 类型观测队列，复现十秒慢报表对通知/采集的阻塞，验证现有互斥、fencing、lease renewal 和停止隔离，记录前后相同负载及资源用量。排除生产数据/服务操作、真实发送/模型调用、HA、容量扩张和无关重构。分层验证为 RED → focused / 模块 typecheck → 隔离 MySQL → 最终本地 gate；出现真实外部权限/环境缺失仅停止受影响步骤。硬预算未设定。

本包采用 Issue 明确允许的“未做压测时仅交付观测与结论”路径。生产并发仍为 **1**，保留每个 WorkerRuntime 的 runInFlight、不可取消 handler / renewal quarantine、D1 所有权与业务资源 guard。没有增加 worker，没有删除互斥，也没有声称消除容量瓶颈。

“通知/采集两秒内开始”是**待确认的确定性场景候选验收目标，非现网 SLA**。本次单样本证明 head-of-line 等待；没有真实限额或生产代表性压测证据，不能据此开启类型并发。当前控制数据库连接池上限 10；测试池上限 24 并非建议生产配置。报表、Cron、分析、指标及跨类型的同实例访问还需共享资源互斥和模型额度共同约束；未知/不可取消慢操作必须占用原有 worker/资源槽到真实 promise 收敛，不能靠超时释放槽扩张。

## 观测契约（父任务与后继使用）

`GET /api/platform/observations` 保留 schemaVersion=1 和既有字段，新增 `queue`。仍需 JWT 与 config:view/config:*/*；权限检查发生在读取队列前。OpenAPI 与生成客户端类型同步更新，无迁移、无新配置。

- queue 为请求时的 MySQL 快照，包含 generatedAt / persistence=mysql / quality / gaps / types。它不受 from/to/component 的日志过滤影响，也不代表窗口内累计吞吐。
- 每类型 queued/retry 是当前状态数量，包含尚未到期和禁用 dispatch 的任务；scheduled 是未来 queued/retry 子集。running 包含过期 owner，expiredLeases 是 running 的过期/无 lease 子集。deadLetter 是当前死信数量，不包含已回放任务。
- ready 与 claim 条件一致：queued/retry/running、available_at 到期、lease 为空或过期，且尊重 ANALYSIS_DISPATCH_ENABLED=false。oldestReadyWaitMs 取可领取任务的最大逾期时间；无样本为 null，不是 0。禁用 dispatch 仍显示 backlog，但不计 ready。
- 等待口径为 MySQL NOW(3) - max(created_at, available_at)，排除正常调度/retry 退避；reclaim 时是原到期点以来的逾期年龄，**不是准确的纯排队时间或历史执行时长**。既有 DATETIME 列精度为秒，亚秒测量受舍入影响。
- 最多返回 100 类型，溢出 quality=degraded + QUEUE_TYPES_TRUNCATED；数据库缺失/失败为 quality=unknown + QUEUE_STORE_UNAVAILABLE，types=[] 不应被当作零积压。全队列聚合需要扫描活跃/死信行，未做大表压测。
- 现有结构化日志新增 jobType 分组。job.wait 记录领取逾期；job.executed 使用单调时钟记录 handler 时间；completed/retry/dead_letter 记录到状态提交的总时间；job.lease_lost 覆盖 heartbeat false/error/timeout 与 complete/fail 的 fencing 拒绝，job.cancelled 记录停止取消。
- group 的 durationMs 为和，durationSamples 为真实样本数，maxDurationMs 为最大值（无样本 null）；均值应除以 durationSamples。count 可统计事件数，但不同事件不能直接相加当“任务吞吐”。执行抛错、取消和未知状态保留对应质量标记，不记录 payload、SQL、handler 错误正文或凭证。
- 日志仍为进程内，一小时/10000 事件/100 聚合组上限，默认查询五分钟；重启、缺失、过期或截断通过既有 gaps 标识。它不是持久 lease-loss 总数。持久 expiredLeases 与进程日志 job.lease_lost 含义不同。

顺带修复本次指标直接暴露的错误：fail() 被 fencing 拒绝时，原 runOnce 会返回 dead_letter，即使数据库没有提交死信；现在返回 retry（等待当前 lease 状态处理），并记录 WORKFLOW_LEASE_LOST。不把未提交的失败作为真实死信。

## 真实前后测量

命令：`bash scripts/qualification/run-environment.sh stability`。稳定性场景已接入现有 recovery-qualification CI，无新增 CI job。

本地比较在相同临时 MySQL / 同一完整迁移链上顺序运行两次完全相同 harness：从精确基线建立 detached worktree，复制当前 assert-stability.ts 到其 tests/qualification/max120-stability.ts，用 `--baseline` 跳过仅新代码拥有的观测断言；然后运行当前 assert-stability.ts。该标志仅供旧代码基线测量，CI 默认仍执行全部新断言。自动清理临时容器/数据库；未读写 .env 或用户数据库。

源代码证据：实现提交 `a067b4f3`。测量时当前 HEAD 为 RED 检查点 b14eb0e2，生产代码及 harness 为随后原样提交 a067b4f3 的工作区版本；没有在提交后假称重新测量。原始脱敏数据见 `2026-10-04-max120-queue-measurement.json`。

环境：macOS Darwin 27.0.0，Apple M5 / 10 logical CPUs / 24 GiB RAM，Node 24.18.0，pnpm 11.19.0；Docker 29.7.2，VM 4 CPUs / 5155713024 bytes RAM；MySQL 8.4，动态 localhost 端口和临时数据库，115 个迁移。负载为一个十秒 timer 报表，在其开始后立即入队一条通知和一条采集，同实例 ID=1；单 worker、一秒 poll，假 handler、零真实发送/采集/付费模型调用。另保留二十次同 idempotency key 并发 enqueue 的唯一任务验证。

| 指标 | 原 main 串行基线 | 新观测版本（仍串行） |
|---|---:|---:|
| 通知入队至开始 | 10019 ms | 10029 ms |
| 采集入队至开始 | 11024 ms | 11038 ms |
| 场景总时间 | 11049 ms | 11072 ms |
| 最大同时执行 handler | 1 | 1 |
| 进程 CPU user + system | 18706 μs | 29663 μs |
| RSS 前 → 后 | 101695488 → 103022592 bytes | 98320384 → 100139008 bytes |

每模式仅一个样本，CPU/RSS 包含 driver/runtime/GC 噪声，不能用这组差值推断稳定开销或生产容量。两者通知/采集均超过两秒候选目标，原因仍是串行等待慢报表。新增观测没有提速，有限三个任务最终都执行，同资源 handler 未重叠；这不是持续到达负载下的无饥饿证明。

快照实测：report running=1，notification 与 capacity 各 queued=ready=1；全部完成后对应类型不再有活跃/死信行。额外真实 SQL 夹具得到 queued=1/retry=1/scheduled=1/ready=2/running=1/deadLetter=1/expiredLeases=1，最老可领取逾期约十秒；未来 retry 不计 ready、旧 owner complete 被 fencing 拒绝。

## 验证证据与限制

- 两轮 RED 分别复现缺失快照/等待/执行/jobType、未提交死信错误（5 失败），以及最大耗时、禁用 dispatch ready、API 契约缺失（4 失败），再最小修复为 GREEN。checkpoint 均在当前分支可达。
- 相关模块：`pnpm --filter slide-api exec vitest run src/workflows src/platform src/contracts/public-api.test.ts`，171 通过 / 40 环境用例跳过；API typecheck 通过。既有回归覆盖同 runtime 重入、heartbeat 丢失/超时、晚到 renewal、非协作 handler 停止隔离与 claim 中途 shutdown。
- 隔离 MySQL stability 比较两次通过；新的 gauges/fencing 断言全部真实执行，没有把 skipped 当通过。没有启动完整后台或真实 JWT/业务 provider；API 认证边界由 Fastify inject 的权限 fixture 验证，数据库与运行器由独立真实 MySQL 验证。
- 最终本地 `pnpm -r test`：API 3007 通过 / 250 环境用例跳过；frontend 568、agent-core 654、sandbox 22 通过 / 4 跳过，无失败。`pnpm -r typecheck`、`pnpm build`（CSP 通过）、`pnpm contracts:check`、`pnpm qualification:matrix`（37/37）、security:scan、security:audit、git diff --check 通过。lint 为 0 errors / 262 既有 warnings；build 保留既有大 chunk 警告。
- `pnpm --filter slide-frontend test:browser`：48/48 通过，使用 worktree Vite 测试端口 5186，未重启/占用用户服务。
- 没有生产压测、DB 大队列查询计划/锁竞争评估、代表性多类型持续负载、真实模型额度或跨 worker 共享资源/quarantine 资格证据。仅凭本包测量不能把两秒目标当生产已通过，不能声称生产瓶颈已消除。

## 回滚与后续决策条件

本次无迁移、无并发配置变化，回滚到基线二进制即可撤回观测 API 增量和日志，不影响 workflow_jobs 数据；当前即为并发 1。回滚也会重新带回原 fail fencing 返回值缺陷。

若父任务选择进入有界调度阶段，先确认确定性候选目标，再以生产同样 pool=10 及明确模型限额做隔离负载与资源互斥/重复领取/不可取消任务测试。类型隔离或公平调度都必须保留每 worker 的 runInFlight、跨类型同资源互斥、fencing、D1 和共享 shutdown quarantine；所有未知慢操作仍占槽。仅在同负载前后等待及资源证据达标后启用，保留并发回退 1。此为结论中的进入条件，本包没有新增后台任务或抢跑后继。

实际 raw input / cached input / output / 费用遥测不可用；没有以内部计数冒充模型吞吐。子代理 0、最大深度 0、代理并发峰值 1。完整本地 gate 对最终生产候选只运行一次；有效证据在代码/配置/环境不变时复用。
