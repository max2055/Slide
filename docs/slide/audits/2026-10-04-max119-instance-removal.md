# MAX-119 / W11 v1：实例删除生命周期

基线：最新 main `080b2c6b6f4996e4cff4dfe2055bdeabd96827b8`（MAX-118 已合并并由父任务记录验收）。在 `codex/max-119-instance-removal` 隔离 worktree 实施，原 runtime worktree 的 AGENTS.md 修改未触碰。不派生代理。

## 执行契约与根因

范围仅覆盖实例删除、直接关联任务/采集/关系/连接及回归；排除全库级联、HA、新恢复引擎、用户实例批量删除、生产迁移和历史修复。验收：有连接/Cron/指标/关系的实例删除后停止新访问；重复删除与中断收敛；旧任务与旧配置不能恢复对象；历史可读且标记删除；任一步失败不报成功。分层验证为失败复现 → focused checks → 真实隔离 MySQL → 最终本地 gate → PR CI。硬预算未设定；遇真实权限/外部环境缺失才停止受影响步骤。

修改前 DELETE 仅执行 `DELETE FROM database_instances`，没有 runtime 清理。首个连接关闭失败会跳过剩余驱动。已复现失败测试：关闭 MySQL 抛错后，PG 的 end 调用次数为 0（预期 1）。自动重连和迟到采集仍持有配置；Cron FK 的 SET NULL 还可能把实例脚本转成控制库脚本。

## 外键、应用关联与 runtime 清单

| 类别 | 当前关系/缓存 | 删除政策 |
|---|---|---|
| 实例权限 | instance_permissions，FK CASCADE | 保留实例墓碑及既有授权，历史仍按既有权限读取；不扩大权限 |
| 指标模板 | instance_templates，FK CASCADE | 保留配置/历史；失效对象不再采集 |
| Cron | target_instance_id FK SET NULL；resource_scope 包含多实例；cron_runs/logs、持久 workflow、内存 CronJob/运行标志/settlements | 不触发 SET NULL、不修改范围为全局；禁用所有显式目标/范围含此 ID 的任务，停止 timer、取消 queued/retry，向可取消 runner 发 abort，未收敛运行阻止成功 |
| 报表 | report_configs FK CASCADE；reports/occurrence snapshot | 禁用目标配置；快照不能触发已删除实例的生成；保留历史 |
| 关系 | resource_relations 无实例 FK；双向来源/目标、未来关系 | 到期，不级联服务器/其它实例；保留关系及 provenance；新增关系在实例行锁下检查 available |
| 指标/健康 | metrics_history、slow_queries、capacity/health 历史、collection_schedule；V2 policy/schedule/states/attempts/rollout | 按既有保留政策保留；停止新调度与 IO，取消 queued/retry 指标任务；迟到 V2 结果不提交；清除 schedule/健康节奏/collection capability 内存缓存 |
| 能力 | resource_capabilities、collectionCapabilityTracker | 持久能力标记 unsupported/INSTANCE_REMOVED、到期；清除 runtime tracker |
| 审计/诊断 | sql_execution_history、audit_log_entries、ai_analysis、analysis dispatch | 保留目标 ID 与旧内容；读取加入 instanceLifecycleState / instance_lifecycle_state，未知分析不自动重计费 |
| 驱动 | DatabaseService Map：MySQL pool、PG client、Oracle persistent session/pool、DM connection；排队 SQL/explain；临时测试/V2 session/socket | 每次驱动调用检查 durable 状态及本地 fence；保留旧引用也无法发新查询；各句柄独立关闭，失败句柄留待重试；追踪迟到建连及临时句柄 |

以上为最新迁移链清单；不同历史部署可用 `sql/audits/max119-instance-removal-dry-run.sql` 查询实际 FK 与遗留对象，不自动补写/删除历史数据。

## 状态、迁移与 API

迁移 `111_instance_removal_lifecycle.sql` 仅为 database_instances 增加 lifecycle_state（available/deleting/deleted）、请求/完成时间、脱敏清理原因及索引。status 继续使用原有 active/inactive/error，不把健康状态当成删除状态。迁移不删除既有资源。

DELETE 顺序为：本地 fence → 提交 durable deleting/inactive 意图 → 停止 scoped Cron/采集 → 关闭临时和共享驱动 → 等待已登记 IO 收敛 → 再清理迟到句柄 → 幂等关联清理 → 提交 deleted 墓碑并清空密码/连接串。SQL 与 socket 不冒称共同事务；失败仅保存稳定步骤码、不保存远程错误或凭证。每步骤等待上限 5 秒；超时保留真实 promise/句柄，重复 DELETE 再检查收敛，不伪造 socket 已关闭。

`DELETE /api/database/instances/:id` 仍使用 instance:delete + 实例 admin 权限。全部清理完成返回 200 + lifecycle_state=deleted；未完成返回 409 + lifecycle_state=deleting + reasons；不存在 404、无效 ID 400、意图/运行环境不可用 503。重复请求合并本进程在途删除，并可重复完成墓碑。误删未来不存在的 ID 不会永久 fence 后来的合法分配。

实例管理列表隐藏 completed tombstone；详情仍可读生命周期，deleting 可见且不可 reload/更新/获取凭证。历史 metrics/query/capacity/health 端点保留原响应形状，响应头 `X-Instance-Lifecycle-State` 标明当前生命周期。OpenAPI 和客户端类型随生成器更新。

启动已迁移后装配 durable guard；在既有 D1 WorkerStartup/WorkerLease 所有权下，仅重放已有 deleting 意图，再启动 Cron。D1 为单主机单后台进程，不新增 HA。多个 access fence 的回归证明 durable 失效可在下一次操作传播；不是跨主机主动广播或四种驱动真实 UAT。Oracle/PG/DM 独立关闭与晚到阻止由驱动 doubles 验证，真实 socket 集成为 MySQL。

## 验证证据

环境：macOS 隔离 worktree，Node 24.18.0、pnpm 11.19.0；MySQL 8.4 临时容器、动态 localhost 端口、临时数据库与完整迁移链。无应用 .env、真实凭证、用户实例删除、用户服务重启或付费模型调用。

- `bash scripts/qualification/run-instance-removal.sh`：8/8 通过，0 skipped。真实连接、Cron/queued workflows、指标/关系/审计、重复 HTTP DELETE、in-flight cooperative runner 取消、多实例范围失效、驱动关闭失败、墓碑 SQL trigger 故障、detach 事务中断与重复收敛、重建 service/fence 后重放意图、迟到 script 目标不变、历史 GET 200 与 deleted header。脚本自动清理容器/数据库，接入 recovery-qualification。
- 当前 focused checks：连接/生命周期/工具/配置 92 通过；其他相关模块批次 372 通过。未设置 MySQL 环境的既有用例跳过，不将其冒称通过；本任务 8 个 MySQL 用例由独立脚本全部真实执行。
- 最终自审补充 3 个先失败后修复的回归：达梦超时建连迟到且首次关闭失败、借出会话迟到且关闭失败、重复 Cron trigger 跳过时不能丢失在途清理所有权。相关 focused 批次 25/25 通过。
- 最终本地 gate：`pnpm -r typecheck`、`pnpm build`（CSP 通过）、`pnpm contracts:check`、`pnpm qualification:matrix`（37/37）、`pnpm security:audit`、`pnpm security:scan` 通过。构建保留既有大 chunk 警告；最终 `pnpm lint` 为 0 errors / 262 warnings。
- `pnpm -r test`：frontend 568 通过、agent-core 654 通过、sandbox-controller 22 通过/4 跳过；API 首轮 4 个本次结构/契约变化导致的失败已修复。受影响 API 最终重跑 `pnpm --filter slide-api test` 为 **2998 通过 / 250 环境用例跳过 / 0 失败**，API typecheck 通过。
- `pnpm --filter slide-frontend test:browser`：48/48 通过。自审后仅 API 改动，复用未变化的 frontend/agent/browser/build/契约检查；最终隔离 MySQL 重跑仍为 8/8 通过、0 skipped。`git diff --check` 通过。

HTTP harness 执行 server.ts 的真实删除/历史路由注册、服务与真实 MySQL，仅替换认证/access guards；出站地址授权替换为临时 localhost，Cron 模型 runner 使用假实现。不等同于真实 JWT/生产端到端、跨主机传播或 PG/Oracle/DM 实机认证。启动重放由新 service/fence 与真实 durable 状态验证，未启动完整用户后台。CI 八个 job 由父任务针对精确 PR head 核验后合并。

## 回滚与资源

保留 additive schema、删除意图、墓碑、目标 ID 和历史数据。不能直接回滚到不认识生命周期的旧二进制（它可能把墓碑 reload）；安全回滚需停后台并使用仍保留 fence/available 查询条件的版本。不得恢复已清除凭证、自动重新连接对象、删除迁移列或用 SQL 把 deleted 改 available。真正恢复为新资源须走用户显式新增流程；墓碑保留既有 name/environment 唯一约束，避免默默复用身份。

运行指标保留原策略；本次不扫描生产历史，不修复已被旧 SET NULL 清空的 Cron 目标。此类既有歧义交付只读清单后由可信 binding/审计人工判断，不能猜回目标或执行控制库脚本。

raw input / cached input / output / 实际费用遥测不可用，不用内部预算冒充实测；子代理 0、最大深度 0、代理并发峰值 1。仅创建隔离 worktree、任务测试容器、PR 与验收产物。
