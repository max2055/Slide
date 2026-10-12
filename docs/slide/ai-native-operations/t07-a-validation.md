# T07-A：独立持久预算账本

2026-10-12，MAX-146，V1.1 / 调度 v1.2。消费 main `8d9f67b5126c59f7565de0ef9cf663191cdbfd62`，含已合并 #145、#149、#150。本阶段仅账本、独立迁移及测试；不接 HTTP、Worker、executor、事件生产链路，不修改其他任务持有的 store/auth/adapter/outbox。

## 有界 Review 与实施设计

复核 store 的 `transaction` / `admitInTransaction`、OutboxService 的 rollback/finally release、T03 冻结 Profile 的 maxTokens/maxProviderAttempts 以及 agent-core 的 input+output token 口径。#145 已提供真实稳定 outbox ID/连接释放证据；本阶段复用，不全域 clear。现有 runtime budget 是单 Run 的 checkpoint 限额，不提供跨进程全局 admission；新增独立 MySQL ledger 补齐该边界，不复制 runtime。

选择同一安全域持久锁行串行检查配额，再插入 reservation。内存计数无法跨进程恢复；分散计数器需要额外原子多资源回滚。当前采用锁行加有索引事实聚合，保持实现与审计简单；大规模优化留待有真实性能证据时考虑。

可信服务端调用 `reserve` 或同事务 `reserveInTransaction`，键为 request/operation。request 必须是既有 request FK；同 request 固定 Profile hash、资源集合、域和 manual/automatic 模式。每个 request 至多一个未结清 operation，所有 operation 累计 token 和次数服从冻结 Profile。全域/全部资源并发、手动保留槽、自动小时频率、自动/总日 token 与货币额度在同事务判定；配置哈希固定到域，配置失配 fail closed，不由调用方临时放宽。日/小时取 MySQL UTC 时间，不接受客户端时间。unknown 跨日继续占额度。

发送前提交 `markSent`；取消只允许未发送 reservation。发送后未知或缺 usage 保留非零 token/cost 和并发槽，不按 TTL 自动退款；可信回执可将 unknown 转已知结算。已知 usage 的 raw input+output 为吞吐，cached input 仅为 input 子集；冻结价表以整数 micro-units/百万 token 计算。无价表时 cost 显式 unknown、继续保留货币额度。重复 reserve/settle 返回持久事实；不一致 payload 拒绝。实际超出预留也如实记账，后续 fail closed，不截断实际费用。

同事务入口不提交、不重试调用方事务；配额拒绝返回稳定 suppression reason，调用方可在原事务持久化事件。授权与租约/fence 由未来 T04/T07-B 可信 owner 在调用前校验，账本不是对外授权 API，也不拥有执行器。

## 实施与验收计划

1. 新增 `114_investigation_budget_ledger.sql`：域锁/冻结策略、唯一 request-operation 账本、全资源关联，InnoDB/FK/精确二进制键/列注释。MigrationRunner 自动发现注册，不改共享 runner 或旧迁移。
2. 新增 `budget-ledger.ts`：严格有限参数、冻结 hash、配额/日窗口、reserve/markSent/cancel/settle/read 及同事务入口。未知保留、已知幂等、不一致冲突、原错误与 rollback/release。
3. `budget-ledger.test.ts` 验证纯 usage/price/参数；`budget-ledger.mysql.test.ts` 必须真实 MySQL 8.4，缺环境自动创建独立容器，失败报错而不 skip。正式迁移 fresh/repeat/pre114 upgrade、并发超卖/同键、手动槽、多资源、频率/token/cost、SQL trigger 回滚、未知跨日、独立连接/进程恢复与回退保留验证。
4. 运行 focused / investigation 模块检查、API typecheck、contracts、lint、diff。独立 PR 当前 head CI 与普通合并核验；保留 T07-B/T04/provider/完整 T12 门禁。

## 回退边界

114 为新增表，应用回退停止新 admission，drain/核销未决 reservation，保留账本/迁移记录。不得在未知结果存在时 DROP 表或从旧执行链路重发。生产不提供破坏性 down；隔离测试验证旧迁移目录启动不会删除账本，新版本回来仍幂等。生产部署/迁移不属于本轮。

## 验证结果

实现后的实际命令、结果及 PR 证据在本文件补齐。无模型调用、付费设施或生产操作；实际 token/费用遥测不可用，无硬预算。
