# MAX-113 / W06a 报表 occurrence 恢复验收

范围 v1 沿用任务已批准的 W06a/A03：独立报表 occurrence、durable job 所有权、崩溃恢复、报告内容与通知 outbox。基线 `main@1b276ac72264d1e260f4d74ef50a747c50d2a747`（W07 / PR #118 已合并且父任务验收完成），实现分支 `codex/max-113-report-recovery`，代码证据提交 `e941ea5`。后续文档提交不改变已验证代码。

不扩 HA、自动恢复引擎或通用 exactly-once 外部通知；不改实际 `.env`、用户服务或生产数据，不调用付费模型。既有工作树的 AGENTS.md 修改原样保留。本任务无子代理，线程数 1、最大深度 0、并发峰值 1；硬预算未设定，raw/cached/output token 与费用实际遥测不可用。

## 最终行为与后继契约

- `report.schedule` 先持久化下一分钟 successor，再扫描到期配置。每个 `configId + occurrenceAt` 原子插入 queued occurrence 与独立 `report.occurrence` job，不预占整批。业务键哈希为 36 字符 UUID 形状，兼容既有 workflow 主键。两次扫描只产生一个逻辑 job。
- `lastOccurrence` 从已绑定 job 的所有状态及 legacy completed 中取最大时间。首项失败不阻止另一配置或下一 occurrence 入队；失败 job 使用原有 worker 重试/死信规则，不通过新 occurrence 重做同一次业务发生。扫描每次每个配置安排一个到期 occurrence，保留原有逐步补齐节奏。
- migration 108 只给 occurrence 增加 job、owner、fencing、staged_report_id、config_snapshot 与唯一约束；不改旧状态/数据、不重写历史迁移。租约有效期唯一权威仍是 `workflow_jobs.lease_expires_at`，避免两套 TTL 漂移。输入与通知渠道在排队时冻结，重试不读取后续改动后的配置。
- 每次 claim、报告创建/更新、失败记录与最终完成，短事务锁定匹配的 running durable job，检查 owner、fencing、未过期租约及 AbortSignal；提交前再次检查。旧 owner、已过期 owner 与任务取消均无法迟到写入。生成/采集在事务之外执行，未把远程查询包进数据库事务。
- 通过局部 AsyncLocalStorage 将定时报表的数据库写入接到受 fencing 保护的存储边界，现有交互式报告 API 保持原实现。内容保存与 staged_report_id 同事务；pending/failed 内容恢复时复用同一行，completed 内容直接复用 reportId，不再次调用生成器。已完成内容不可由旧 catch 路径降级为 failed；已绑定内容若被删除则明确报错，不能悄悄再生成。
- 最终短事务核对 completed 内容，将 report_id 最终关联、occurrence completed、每个去重渠道的 `reportId + channelId` outbox 意图与本地 `report.notify` durable job 一起提交。outbox published_at 表示已在同一事务发布到本地队列，不表示外部接收成功。任一写失败全部回滚；worker 尚未确认便退出时，重领发现 occurrence 已完成，仅确认 job。
- `report.notify` 沿用 W03 已合并的投递协议与人工 reconciliation。SMTP/webhook 被调用后结果丢失为 unknown；outbox 唯一只保证一个逻辑通知意图，不能保证外部 exactly-once。unknown 不自动再发，也不能通过重扫 occurrence 绕过门禁。
- 没有 workflow_job_id 的 legacy running/failed/queued 不会自动绑定或批量改 failed。legacy completed 保留读取，缺失通知通过下述人工清单核对。
- 没有公共 API 路径或 DTO 变化；生成契约校验通过，无需改 OpenAPI。

## 失败复现与真实验收

在真实 MySQL 8.4 上、修复前运行的三项回归全部失败：第二个 occurrence 留 running、无有效 owner 仍可 complete、完成后 outbox 为空。新增故障测试在同一隔离环境中验证最终行为，未把模拟对象结果当作真实数据库验收。

| 场景 | 证据与结果 |
|---|---|
| 两个到期 occurrence，首个生成失败 | 各自独立 job；首个 retry/failed，第二个成功，无预占的 running 遗留 |
| 认领后进程退出 | 真实 Node 子进程 exit 77；租约到期后新 worker 接管并完成 |
| pending 报告保存后退出 | 真实子进程退出，重启复用同一 staged report 行，最终只一个报告 |
| completed 内容保存后退出 | 真实子进程退出，重启未调用生成器，复用原 reportId 并补最终提交 |
| 最终提交后、worker 确认前退出 | 真实子进程退出；occurrence、outbox、通知 job 均在库，重领无重复报告或意图 |
| outbox / 通知 job / occurrence 终态写失败 | 三个 MySQL trigger 分别注入错误；整个最终事务回滚；恢复仅重试最终提交 |
| 旧 owner / fencing / lease | 过期和接管后的 create/update/fail/complete 全部拒绝；新 owner 完成 |
| 事务内租约到期 | trigger 延迟 2 秒跨越 TTL，提交前校验拒绝，outbox 与终态全部回滚 |
| 生成期间的事务边界 | 生成器等待时另一个连接可 NOWAIT 锁定 job 与 occurrence，证明未持有长事务 |
| 重复扫描和失败后的下一 occurrence | 两个连接同时扫描只有一个 job；failed 不阻塞下一 occurrence |
| 历史数据 | 未确认 running 不自动认领；只读 dry-run 输出报告/投递关联与 unknown 分类，不改变数据 |
| 已被 SMTP 接收但响应丢失 | 本地真实 SMTP 收到一封，注入响应丢失后为 unknown；重试 handler 拒绝，发送器调用次数仍为 1 |

## 命令与环境

环境：macOS、Node 24.18.0、pnpm 11.19.0、Vitest 4.1.8、Docker 29.7.2。真实实验仅使用自建 MySQL 8.4 的随机 loopback 端口与临时数据库、本地假报告和 SMTP 接收端。子进程全部前台收集；资格脚本通过 trap 删除它创建的容器。

| 检查 | 命令 | 结果 |
|---|---|---|
| MySQL/退出/SMTP 专项 | `bash scripts/qualification/run-report-recovery.sh` | 15/15 通过，已接入 recovery-qualification CI |
| 受影响模块 | `pnpm --filter slide-api exec vitest run src/workflows tests/report-scheduler.test.ts src/server-report-service.test.ts tests/server-report-scope.test.ts`，同时显式设置专项测试端口 | 15 文件、102 用例通过；18 项另一个 opt-in 投递套件未启用。之后新增的边界/SMTP 项由上行资格脚本覆盖 |
| 最终完整本地测试 | `pnpm -r test` | backend 2955、frontend 563、agent-core 654、sandbox 22 通过；backend 170、sandbox 4 opt-in 项跳过，报表专项已单独实跑 |
| 类型 | 四个模块各自 `typecheck` | 全部通过 |
| 静态/构建/契约 | `pnpm lint`、frontend build、`pnpm contracts:check`、`pnpm qualification:matrix`、`git diff --check` | 全部通过；既有 lint 警告、构建 chunk 大小警告保留 |
| 安全 | `pnpm security:scan`、`pnpm security:deployment` | 通过 |
| 迁移 | 隔离库设置 DB_HOST/PORT/USER/PASSWORD/NAME 后，连续两次 `pnpm --filter slide-api exec tsx init-db.ts` | 空库迁移和重复启动通过；仅隔离库写入 |
| dry-run CLI | 在上述隔离完整库执行 `pnpm --filter slide-api exec tsx scripts/report-recovery-dry-run.ts` | 返回 `dryRun:true, entries:[], nextAfterConfigId:null`；有历史数据的分类由 MySQL 专项覆盖 |

完整本地 gate 统一一次；静态检查的链式退出码曾不足以证明每一命令成功，因此仅对缺少独立退出证据的静态检查补充 fail-fast 记录，未重复完整测试。未运行真实生产数据修复、生产通知、付费模型、长时 soak 或本地浏览器资格验收；PR 的八项 CI 由父任务按精确 head 核验，未以本地结果替代 CI。

## 历史数据 dry-run 与确认后处理

`apps/db-ops-api/scripts/report-recovery-dry-run.ts` 没有 apply 模式，不自动读取 `.env`；必须显式指定获准控制库的 DB_HOST/USER/NAME。推荐只读数据库账号。第一个参数是上一页 nextAfterConfigId，第二个为页大小（默认 200，上限 1000）。在配置边界分页；单配置超过页上限时明确报错，不能无声截断。有报告关联时输出 ID/status、旧投递 attempt 与已有 outbox；无关联时只列候选报告 ID/时间与截断标志。候选仅供核对，不是关联证据，也不包含报告正文或凭证。

先暂停 scheduler 与 occurrence 执行，排空或标注在途 job，保留通知投递审计。保存每一页清单，并逐项确认配置 ID、occurrence 时间、报告 ID、内容完成证据、渠道、外部接收证据、owner 已失效与预期旧状态。下面三类处理必须在**具体数据清单得到确认后**才能执行；本任务没有生产清单，未实施历史修复：

1. 确定已生成且 reportId 唯一：复用原报告。补 staged/final 关联与缺失 outbox/job 必须在一个短事务中完成，使用现有 `OutboxService.append` 和 `MysqlWorkflowStore.enqueue`（均传入同一 connection）、`createReportNotificationJob(reportId, channelId)` 的逻辑键。锁定并 CAS 核对清单中的 occurrence 旧状态，重复执行不得创建新报告或新通知身份。旧 sent 审计保留，投递门禁会跳过已送达渠道。
2. 确定从未开始且没有生成/发送副作用：按审批清单逐项绑定 `createReportOccurrenceJob` 的 job ID、冻结 config_snapshot 并设 queued，同时在同一事务写 durable job。不是把所有 running 改 failed。此路径不会自动触发未知报告的重新生成。
3. 无法确认生成或外部发送结果：保留 legacy 数据与 unknown 证据，等待人工处置。通知使用 W03 reconciliation 的版本 CAS、原因、接收方核对证据；明确接受重复风险之前不能授权重发。

## 回滚

DDL 仅新增，不删除 occurrence/report/outbox/投递审计。暂停 scheduler 和相关 worker，等待在途任务结束；无法确认者记录 unknown/待核对。回退版本必须理解 `report.occurrence`、staged 关联和已存在投递状态；旧 `main@1b276ac` 没有这些能力，不可直接启用它的后台调度。需要版本回退时先交付兼容适配版本，再恢复 scheduler。保留本地 durable 队列与 outbox，不通过清空表或批量终结 running 恢复调度。
