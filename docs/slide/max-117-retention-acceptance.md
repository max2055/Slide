# MAX-117 / W09：Metrics V2 保留维护验收

范围版本 W09-v1；base main `e4b2624c51ab4166cae9823f47885303174bde30`（已合并 W08 #121）。本次实现固定维护 Workflow，不新增用户可配置 system Agent、公开 API、HA、自动恢复引擎、历史重写或生产数据清理。任务硬预算未设定；实际 input/cached input/output/费用增量遥测不可用，未用预算账本替代实测。子代理 0、深度 0、并发代理峰值 1。

## 实施契约与方案

验收清单：显式保留期校验、默认关闭/dry-run、相同策略 preview 才能 apply、过期原始 payload 无条件清除、当前视图/告警可追溯、每 SQL 批次不超过 1000、每次批数与时间预算、持久续批、重复执行/真实进程退出/关闭后的恢复。先建立 RED，再修改存储/装配，最后 focused、模块 MySQL、typecheck 和完整本地 gate；只有缺少实际权限/凭证/外部强制审批才停止相应步骤。交付 in_review；父任务核验当前 head 的八项 CI、审查和合并，不推进后继。

复用已有 Workflow job、WorkerRuntime lease/fencing 和 policy lock。比只在 cron 串联两个旧 prune 多处理引用语义；比另建维护 Agent 少一套执行身份与调度。`server.ts` 在 worker 可领取前调用 `startMetricRetention()`，测试调用同一生产装配函数，通过真实 MySQL claim/ack 执行。

- 固定 job type `metrics.retention`，空 payload；不读取用户提交的策略或自由 handler。Cron 用户写入仍受既有维护能力白名单限制，本次没有扩充该白名单。
- 全局维护 named lock 防 bootstrap/续批并行；每次删除事务校验 job type、running、owner、fencing token、lease 未过期，并在每阶段及提交前检查取消和时长预算。policy lock 与发布/采集/独立写入串行，防检查引用和删除之间新增引用。
- 先清理 expired raw payload，保留不含 value、raw_field、dimensions 的 tombstone（id、资源、metric、source、versions、原 observed_at、有效 expired_at、原因）。到期前后的读取始终返回 expired，不从引用恢复敏感值；缩短策略也作用于既有行，取原到期时间与配置 cutoff 的较早值。
- normalized 历史和 raw tombstone 只在没有 rollout.latest、transition、存活 normalized.lineage、attempt.observation_ids 引用时删除。保留 running attempt；终态 attempt 达 TTL 可删，身份/来源仍由存活 observation/tombstone 解释。按存活引用保留祖先，失去引用后下一批回收，不需要把 raw 内容无限延长。
- 保留 current latest normalized、本条 publication、告警 watermark 和对应最后 transition；旧 transition 过期后清除，随后下一批回收它独占的 observation/lineage。publication 仅在 observation 不存在且没有当前视图/transition 引用时回收。单独保留 monotonic alert state 防旧告警重放。
- 在当前工作之前持久化下一周期 job；周期 key 按 interval/time bucket 去重，重启/续批不会生成无限周期分支。未完成工作另安排 1 秒后续批；事务回滚或进程退出依靠 lease 重领。关闭开关后已有 job 只 ack，不清理、不安排 successor；重新启动启用时恢复。
- 每次记录 reason、策略 hash、mode、preview 各阶段数量/最老时间/年龄、实际删除计数、批数、elapsed、pending 和 job ID；写入 `metric_v2_retention_state.last_report` 并输出不含 payload 的结构化报告。dry-run 使用与删除相同的引用 predicates，展示当前阶段可处理项；前一阶段释放的引用由后续批次处理，preview 不是无引用假设下的总量承诺。

## 配置与迁移/回滚

新增迁移 `110_metric_v2_retention.sql`：observations.tombstone 及单例 retention state，保留所有已有数据；已在最新 main 分配。完整 migration runner 验证安装与重复迁移。Compose 透传所有配置，默认关闭。本次未修改实际 .env 或启动生产任务。

启用前设置：

```dotenv
METRICS_V2_RETENTION_ENABLED=true
METRICS_V2_RETENTION_MODE=dry-run
METRICS_V2_RETENTION_RAW_MS=604800000
METRICS_V2_RETENTION_HISTORY_MS=2592000000
METRICS_V2_RETENTION_ATTEMPT_MS=604800000
METRICS_V2_RETENTION_BATCH_LIMIT=1000
METRICS_V2_RETENTION_MAX_BATCHES=5
METRICS_V2_RETENTION_MAX_RUN_MS=10000
METRICS_V2_RETENTION_INTERVAL_MS=3600000
```

三项 TTL 必须显式提供、正整数、不超过 3650 天，raw 不大于 history。batch_limit 1–1000、max_batches 1–100、max_run_ms 1–60000、interval_ms 1–86400000；非法配置 fail closed。先以 dry-run 启动并审阅数据库 last_report 的 count/time range，确认已验证备份后再改 mode=apply。没有匹配 TTL hash 的已完成 preview 时 apply 返回 `RETENTION_DRY_RUN_REQUIRED`，更改任一 TTL 需要重新 preview。未使用实际生产数据验证备份。

`MAX_RUN_MS` 是每阶段/事务提交的协作预算：达到预算不再提交该未完成事务，已提交批次保留并安排续批；它不是数据库驱动正在执行的单条 SQL/网络等待的强制 kill。JSON 兼容引用检查和 COUNT preview 的大型生产库耗时未实测；按实际 dry-run/report 调整配置，SQL/存储失败保留 Workflow retry 错误，不宣称无限规模验证。

回滚调度：设 `METRICS_V2_RETENTION_ENABLED=false` 并按标准服务生命周期重新加载；取消信号阻止后续清理并回滚未提交批次。保留迁移字段和记录，不执行 DROP。回滚代码不能恢复已删除 payload/行；只能从已验证的备份恢复。旧读取保留、legacy 表完全不清理，已清除敏感 payload 不可被重试写入 tombstone 复活。

## 验证证据

RED checkpoint `91b4b65`：隔离 MySQL 实际执行修改后的 rollout retention regression，当前 publication/transition 被旧实现删除，1 failed / 9 筛选跳过；新 handler test 同时证明缺少实现（import 失败不是业务用例通过）。

真实 MySQL 8.4 使用本 run 创建的独立空密码容器、随机 localhost 端口和每 suite 新建数据库；未读取应用 .env、未接触用户容器数据。恢复测试还用实际 Node/tsx 子进程，在清理提交之后、Workflow ack 之前 `exit(73)`，新 worker 在 lease 到期后重复运行并完成 ack，fencing token 单调增加、删除数据不复活。shutdown 测试在真实 policy lock 等待期间取消 worker，payload 保留，重启后完成清理。

最终结果另列下方；不以健康检查或直接 prune 单测替代生产装配到删除的测试。

- `bash scripts/qualification/run-metric-retention.sh`：独立 MySQL 8.4，33 passed、0 skipped；该脚本已接入 recovery-qualification CI。最终 transition 水位边界修复后相同三套用例直接在独立 MySQL 重跑，仍为 33 passed、0 skipped。
- `METRICS_V2_TEST_MYSQL_PORT=<独立端口> pnpm --filter slide-api exec vitest run src/metrics-v2 src/workflows/metric-retention-handler.test.ts --maxWorkers=2 --testTimeout=30000`：391 passed / 6 条件跳过；缺少 PostgreSQL、SSH 和 opt-in consumer browser 环境的 4 个 suite 未声称通过。最初同时全并发跑后端和多个 migration suite 导致 3 个 migration 5 秒超时；按独立数据库负载将 worker 降至 2、timeout 提高至 30 秒后全部可用环境通过，没有绕过业务断言或修改生产实现。
- 最终候选增加水位前进但状态不变的 MySQL regression，先复现最后 transition 被删除（1 failed），再改为保护存活 alert state 的最后一条真实 transition，保持 current evidence 可追溯。此改动只重跑受影响 rollout/MySQL 和后端门禁，其他模块复用未变结果。
- 后端完整 gate：2982 passed / 214 条件跳过；必须的本任务 MySQL 测试已在独立命令中无跳过验证。启动 VM fixture 因新 production 装配入口补一个 inert mock，相关启动回归通过。
- 前端 typecheck + 566 passed + build/CSP；agent-core typecheck + 654 passed；sandbox-controller typecheck + 22 passed / 4 条件跳过。
- backend typecheck、生成 API contracts:check、qualification matrix 37/37、security secret scan、deployment security invariants、git diff --check 全部通过。
- 受影响六个 TS 文件 oxlint 0 errors / 0 warnings；全仓 lint 0 errors / 261 既有 warnings。前端产物有既有大 chunk 提示，不属于本包整改。

本包未采集行覆盖率，按上述可观察行为证明验收。未运行生产清理、实际备份恢复或大型生产数据量性能测量，未执行本次人工浏览器路径。外部八项 CI 及父任务独立审查/合并仍需按 PR 精确 head 核验，不用本地测试冒充 CI 或已合并结果。测试生成的两张 config-ui 截图已恢复，未纳入本包改动。

最终水位保护修复后的 `METRICS_V2_TEST_MYSQL_PORT=<独立端口> pnpm --filter slide-api exec vitest run src/metrics-v2/rollout --maxWorkers=2 --testTimeout=30000`：9 suites / 34 passed / 0 skipped。后端最终完整 gate 仍为 2982 passed / 214 条件跳过。
