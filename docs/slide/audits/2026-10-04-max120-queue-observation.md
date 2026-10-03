# MAX-120 / W12a：工作队列观测与有界调度验收 v2

## 当前结论与历史范围

基线 main `4caeaecf32cd1f0d08c2b7ac7b68deaa0a4b3504`（MAX-119 / PR #124 已合并）。续修现有 PR #125 / `codex/max-120-queue-observation`，没有创建第二个 PR 或启动后继任务。

v1（head f1ebf3fe）只交付观测，通知/采集仍等待 10029/11038 ms，并将两秒目标写成待确认。父任务于 2026-10-03 19:02 UTC 的 W12A-ACCEPTANCE-01 审查确认：MAX-107 v2 已确定两秒隔离实验目标，串行超阈值后须实施有界调度。因此本次 v2 撤销“仅观测已完成验收”和“需再次确认目标”的结论，保留 v1 代码及历史原始测量 `2026-10-04-max120-queue-measurement.json`。

范围为按类型观测、固定有界 worker 装配、跨类型资源 guard、真实隔离 MySQL 测量及相关回归。不扩展 HA、真实模型或生产容量认证，不改用户 .env、不连接用户业务数据库、不调用付费模型。硬预算未设定；实际 raw input / cached input / output / 费用遥测不可用，子代理 0、最大深度 0、代理并发峰值 1。

## 调度与配置契约

`WORKFLOW_CONCURRENCY` 只接受 `1` / `3`，默认 `3`；其他值启动报 `WORKFLOW_CONCURRENCY_INVALID`。Compose 显式透传相同默认值。不是任意数量线程池，也不会自动扩容或替换卡住的 worker。

三槽类型划分：

| 槽 | 任务类型 | 上限 |
|---|---|---:|
| notification | notification.deliver、report.notify | 1 |
| collection | metrics.collect | 1 |
| general | 其余类型，包括报表、analysis、cron 和全局维护 | 1 |

整个 D1-owned 装配最多三个正在领取/解析资源/等待资源/执行的槽；潜在模型任务只进入 general，最多一个工作队列模型槽。每个槽仍为独立 WorkerRuntime，保留 runInFlight、heartbeat、fencing、pendingRenewal 和 shutdown quarantine。pool 仍为 10，未额外持有数据库连接做资源锁。API 会话等其他模型入口的已有上限不由本工作队列替代，未认证真实 provider 配额。

D1 ownership 仍在后台装配、每次 tick 前检查；资源 guard 仅在该单后台实例的三个槽间共享，不作为跨主机 HA 锁。server shutdown 同时 abort 三个槽，并且只有全部 drain 才返回 true；既有 shutdown timeout 不释放 D1 ownership/数据库去启动替代 worker。不可取消 handler、claim/资源查询和未完成 renewal 都保留自身槽，重复 tick 不增加请求；非协作 handler 的资源锁直到 handler 真正 settle 才释放。

资源范围：报表 occurrence 从与 job ID / configId / occurrenceAt 绑定的 **冻结 config_snapshot** 读取 instance_id，忽略额外 payload.instanceId；通知从 alerts/reports 的源记录读取 instance_id；metrics.collect 使用既有严格校验的 resource，真实 collector 在 I/O 前仍校验 durable schedule。只将确定的 instance 任务视为局部资源。server/network/global/未知/缺少快照的任务使用 `*`，与全部资源互斥。相同 job ID 也互斥，guard FIFO 入场保证全局等待者不会被后续到达者绕过。未知资源默认全局锁意味着某些真实全局扫描仍可能阻塞快任务，不能把隔离实验结果外推为所有生产任务的保证。

真实三槽并发暴露了原 UPDATE 内队列子查询扫描的 MySQL gap-lock deadlock；已改为普通 SELECT 候选 + 按主键 UPDATE CAS 领取，CAS 继续检查 state / available_at / lease expiry 并递增 fencing token。竞争者 CAS 失败返回 idle，不重复执行；领取成功后只回读该 job ID 与 owner。候选排序 available_at、created_at、id；没有取消 lease fencing 或删除 runInFlight。

## 观测契约

`GET /api/platform/observations` 保留 schemaVersion=1，新增的 queue 快照仍要求 JWT 与 config:view/config:*/*，权限检查在查询前；OpenAPI 与生成客户端类型已在 v1 同步，本次不新增 HTTP 字段/迁移。

- queue 是请求时的 MySQL gauges，与日志查询窗口不同，不代表累计吞吐。按类型提供 queued/retry/scheduled/ready/running/deadLetter/expiredLeases/oldestReadyWaitMs；ready 尊重禁用 analysis.dispatch，scheduled 不计 ready，过期 running 可领取，无等待样本为 null。
- 快照最多 100 类型，截断标 degraded；数据库缺失证据标 unknown。日志仍为一小时、10000 条进程内证据，丢失/截断不会伪装为完整持久历史。
- job.wait 测量入队可用时间至领取，job.resource_wait 测量资源解析/guard 等待，job.executed 含 guard 与 handler 的总耗时。评估入队至实际 handler 开始必须结合 guard 等待，不能只看领取时间。本次实验独立记录实际开始时间。
- 按 jobType 统计 retry/dead-letter/lease loss；fencing 拒绝 fail 时返回 retry / lease-loss，不误报已提交 dead_letter。只记录标签与耗时，不记录任务 payload/凭证。

## 真实 MySQL 测量

命令：`bash scripts/qualification/run-environment.sh stability`。临时 MySQL 8.4 Docker 容器、动态 localhost 端口、独立数据库、115 个迁移，退出自动清理。环境 macOS Darwin 27.0.0，Apple M5 / 10 logical CPUs / 24 GiB，Node 24.18.0，pnpm 11.19.0；Docker 29.7.2 / VM 4 CPUs / 5155713024 bytes RAM。控制 pool=10。

最终测量源 commit `bf8912cda24514c5bf6fc10e6aa8cf8cfa42c64f`；之后只有验收文档/脱敏 JSON 更新。新增原始测量 `2026-10-04-max120-bounded-measurement.json` 与 v1 文件分开保留。

先保留旧十秒 report.schedule + notification.deliver + capacity.collect 的串行复现。真实业务 report.schedule/capacity.collect 为全局扫描，旧夹具 payload.instanceId **不能**证明范围局部，也不能作为独立资源实验。新增匹配生产任务类型的假 handler：十秒 report.occurrence（冻结 instance=1）、notification.deliver（源 instance=2）、metrics.collect（resource instance=3），报表开始后入队两条快任务，poll=1000 ms，零真实生成/发送/采集/模型调用。相同负载分别配置 1 和 3；同资源实验另将全部范围设为 instance=1。

| 指标 | 独立资源并发1 | 独立资源并发3 | 同资源并发3 |
|---|---:|---:|---:|
| 通知入队至开始 ms | 11031 | 1010 | 9996 |
| 采集入队至开始 ms | 10024 | 1008 | 9992 |
| 场景总时间 ms | 12050 | 10046 | 10044 |
| 最大活跃handler | 1 | 2 | 1 |
| 资源重叠次数 | 0 | 0 | 0 |
| CPU user+system μs | 26406 | 32529 | 15558 |
| RSS 前→后 bytes | 91258880→91422720 | 91439104→91684864 | 91701248→92422144 |

每模式一个样本，CPU/RSS包含driver/runtime/GC噪声，不能根据差值推断稳定开销或吞吐容量。

以下结果由最终脱敏 JSON 对应的单次完整实验生成；两秒为已确定的隔离实验目标，不是生产 SLA。全部三任务最终完成，同资源副作用无重叠；并发1仍复现阻塞，证明回退开关有效。持续有限到达实验每100 ms各入队三类型一次、共12轮36个任务，假 handler 60 ms，全部完成、最大活跃3、每任务 attempts=1；不能用有限样本证明无限到达下稳定容量。

首次隔离实验的 occurrence 时间夹具包含毫秒，但表为 DATETIME 秒精度；查询未命中而进入全局保守锁。修正夹具并在 enqueue 前断言冻结快照命中；生产 scheduler 本就使用秒精度 occurrence。随后真实并发复现 claim deadlock，真实失败日志与 SQL 回归共同构成 RED；主键 CAS 修复后完整 stability 为 GREEN。

## 验收与验证

- 独立资源混合负载：通知/采集在2秒内开始（见测量表/JSON），报表保持10秒；同资源负载：最大活跃1、overlaps=0，不能以提速绕过 guard。
- 无饥饿/有界性：36个持续有限到达任务全部完成、最大活跃3；固定三槽，不产生替代 worker。
- 真实 SQL：20次同 idempotency key 并发 enqueue 得到一行；8个 owner 竞争同一任务只有一个成功；expired lease 接管后旧 owner 的 complete/heartbeat/fail 均被 fencing 拒绝；未来 retry 不领取，耗尽 attempts 到 dead_letter。
- 真实失租约/停止：在十秒槽中强制改变 token，handler 收到 lease-loss abort 仍保留资源/槽；同资源通知未开始；30 ms shutdown 返回 false、后续五次 tick cancelled；gate settle 后 shutdown true，未知 job 仍 running，未伪造 completed。
- focused：workflows/platform/contracts/fault/startup，212 passed / 42 环境 skipped；有界 runtime 与装配边界单独32 passed，之后确定性装配回归41 passed / 2 skipped。单元覆盖全局 waiter FIFO、不可取消 renewal 占 general/model 槽，以及每 worker 重入。
- 本地最终 gate：API 3014 passed / 250 环境 skipped，frontend 568，agent-core 654，sandbox 22 passed / 4 skipped；workspace typecheck、build/CSP、contracts:check、qualification:matrix（37/37）、security:scan、security:audit、diff check 通过。lint 0 errors / 262既有 warnings。装配更名首次使两个既有源码/VM fixture 失效，已更新 fixture、focused 和 API 全量重跑通过；其他未变模块复用同轮有效结果。
- PR 的新 head 重新触发八个 CI job，旧 head 的八项成功不作为新 head 门禁。父任务负责审查与合并，不 self-approve，不标 done，不启动后继。

未验证：生产压测、大积压的候选 SELECT 查询计划/竞争、真实模型/provider配额、完整后台JWT+真实业务端到端、HA/跨进程资源guard。D1与真实 collector/通知/报表业务层的已有 fencing/恢复回归继续由CI执行，不以假handler宣称它们的业务I/O已认证。

## 回退与停止条件

设置 `WORKFLOW_CONCURRENCY=1` 后按正常受控部署重启后台，保留本次观测与 CAS/fencing，恢复单槽串行；不在活动进程内替换或扩容 worker。无schema迁移/历史数据改写，二进制回退也可撤回新增调度与观测。遇未知慢操作shutdown=false，保持既有quarantine处理，不释放资源/启动替代槽。

本任务交付同一PR并进入in_review；合并与后继阶段只由MAX-107在最新head门禁/审查通过后推进。累计历史范围与v1原始测量保留；不把修订或上下文计数当作重置预算。
