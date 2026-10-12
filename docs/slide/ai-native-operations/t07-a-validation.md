# T07-A：独立持久预算账本

2026-10-12，MAX-146，V1.1 / 调度 v1.2。消费 main `8d9f67b5126c59f7565de0ef9cf663191cdbfd62`，含已合并 #145、#149、#150。本阶段仅账本、独立迁移及测试；不接 HTTP、Worker、executor、事件生产链路，不修改其他任务持有的 store/auth/adapter/outbox。

## 有界 Review 与实施设计

复核 store 的 `transaction` / `admitInTransaction`、OutboxService 的 rollback/finally release、T03 冻结 Profile 的 maxTokens/maxProviderAttempts 以及 agent-core 的 input+output token 口径。#145 已提供真实稳定 outbox ID/连接释放证据；本阶段复用，不全域 clear。现有 runtime budget 是单 Run 的 checkpoint 限额，不提供跨进程全局 admission；新增独立 MySQL ledger 补齐该边界，不复制 runtime。

选择同一安全域持久锁行串行检查配额，再插入 reservation。内存计数无法跨进程恢复；分散计数器需要额外原子多资源回滚。当前采用锁行加有索引事实聚合，保持实现与审计简单；大规模优化留待有真实性能证据时考虑。

可信服务端调用 `reserve` 或同事务 `reserveInTransaction`，键为 request/operation。request 必须是既有 request FK，Profile hash 必须匹配 T03 的持久 authority；同 request 固定 Profile hash、全部持久资源集合、域和 manual/automatic 模式。每个 request 至多一个未结清 operation，所有 operation 累计 token 和次数服从冻结 Profile。全域/全部资源并发、手动保留槽、自动小时频率、自动/总日 token 与货币额度在同事务判定；配置哈希和币种固定到域，配置失配 fail closed，不由调用方临时放宽。日/小时取 MySQL UTC 时间，不接受客户端时间。unknown 跨日继续占额度。

发送前提交 `markSent`，仅首次 committed intent 返回 `dispatchAllowed=true`，重复 sent/unknown 不允许重发；取消只允许未发送 reservation。发送后未知或缺 usage 保留非零 token/cost 和并发槽，不按 TTL 自动退款；可信回执可将 unknown 转已知结算。已知 usage 的 raw input+output 为吞吐，cached input 仅为 input 子集；冻结价表以整数 micro-units/百万 token 计算，已知价表要求预留覆盖最大单价乘 token ceiling。无价表时 cost 显式 unknown、继续保留货币额度。重复 reserve/settle 返回持久事实；不一致 payload 拒绝。实际超出预留也如实记账，后续 fail closed，不截断实际费用。

operation 是整次执行 allocation，不是每个 provider turn 的可退款并发槽。T04 必须把 Runtime token ceiling 限到 `reservedTokens`，在执行终态时用所有调用的合计 usage 结算；任何一次发送后 usage unknown 时传 null。工具/模型仍执行期间不可提前 settle。未决执行保留槽是保守选择，需要可信回执/人工核销，不能自动清理来解锁队列。Run deadline、工具次数、逐 provider attempt 及租约仍由 Runtime/T04 执行，账本不宣称替代它们。

同事务入口不提交、不重试调用方事务；配额拒绝返回稳定 suppression reason，调用方可在原事务持久化事件。授权与租约/fence 由未来 T04/T07-B 可信 owner 在调用前校验，账本不是对外授权 API，也不拥有执行器。

## 实施与验收计划

1. 新增 `114_investigation_budget_ledger.sql`：域锁/冻结策略、唯一 request-operation 账本、全资源关联，InnoDB/FK/精确二进制键/列注释。MigrationRunner 自动发现注册，不改共享 runner 或旧迁移。
2. 新增 `budget-ledger.ts`：严格有限参数、冻结 hash、配额/日窗口、reserve/markSent/cancel/settle/read 及同事务入口。未知保留、已知幂等、不一致冲突、原错误与 rollback/release。
3. `budget-ledger.test.ts` 验证纯 usage/price/参数；`budget-ledger.mysql.test.ts` 必须真实 MySQL 8.4，缺环境自动创建独立容器，失败报错而不 skip。正式迁移 fresh/repeat/pre114 upgrade、并发超卖/同键、手动槽、多资源、频率/token/cost、SQL trigger 回滚、未知跨日、独立连接/进程恢复与回退保留验证。
4. 运行 focused / investigation 模块检查、API typecheck、contracts、lint、diff。独立 PR 当前 head CI 与普通合并核验；保留 T07-B/T04/provider/完整 T12 门禁。

## 回退边界

114 为新增表，应用回退停止新 admission，drain/核销未决 reservation，保留账本/迁移记录。不得在未知结果存在时 DROP 表或从旧执行链路重发。生产不提供破坏性 down；隔离测试验证旧迁移目录启动不会删除账本，新版本回来仍幂等。生产部署/迁移不属于本轮。

## 验证结果

隔离 MySQL 8.4、随机 schema；完整正式 MigrationRunner，未使用 mock MySQL/skip/provider。可信 SQL request/Profile fixture 验证账本，不冒充真实 JWT 或执行器验收。事务组合复用 OutboxService，真实 SQL trigger 注入回滚；跨进程恢复通过独立 Node/tsx 进程读取同数据库事实。默认测试自动启动独立容器并优雅停止，外部隔离环境可用 `BUDGET_TEST_MYSQL_PORT/PASSWORD`，不读取生产 .env。

```bash
BUDGET_TEST_MYSQL_PORT=<isolated-port> INVESTIGATION_TEST_MYSQL_PORT=<isolated-port> AUTH_TEST_MYSQL_PORT=<isolated-port> pnpm --filter slide-api exec vitest run src/investigations
pnpm --filter slide-api exec vitest run src/investigations/budget-ledger.test.ts src/investigations/budget-ledger.mysql.test.ts tests/migration-runner.test.ts src/workflows/outbox-service.test.ts
pnpm --filter slide-api typecheck
pnpm contracts:check
pnpm security:scan
pnpm exec oxlint apps/db-ops-api/src/investigations/budget-ledger.ts apps/db-ops-api/src/investigations/budget-ledger.test.ts apps/db-ops-api/src/investigations/budget-ledger.mysql.test.ts
git diff --check
```

|验收|实际证据|
|---|---|
|持久并发与手动保留|100 同键仅1 reservation；100不同请求仅3自动slot，再接受1手动，余下全局拒绝；30多资源并发仅2；50并发日token预留仅3，不能超卖|
|频率/冻结预算|取消仍计小时频率；同request顺序operation不重复计频率；累计token及allocation次数限额；新价表/域/lane/Profile/资源变更不能复用原键；缺T03 authority拒绝；不同Profile版本独立|
|未知与幂等|100已知重复settlement仍1账；100发送意图仅1可发送；未知usage保持token/cost/slot，跨日和独立进程恢复不重发；无价格显式unknown货币继续占额；可信晚到usage可核销，实际超额如实记账|
|事务与迁移|ledger/resource INSERT及settlement UPDATE真实故障回滚；调用方同事务写入一起回滚；旧REPEATABLE READ snapshot后quota仍读取新事实；正式fresh/repeat/pre114 upgrade和保留账本应用回退；FK拒绝删除有预算事实的request|
|模块与检查|调查7文件204项通过/0 skip；账本+迁移+outbox4文件79项通过/0 skip（包含默认自建容器路径）；API typecheck、contracts、security scan、focused lint、diff通过。各组重叠，不相加|

初轮失败为夹具重复插入正式迁移已有用户、测试中同步/异步错误断言以及 TypeScript 判别联合/已有事务端口类型适配，均已修正。添加已知价表预留下限后，同键冲突夹具改用仍合法的成本变化；未放宽校验或跳过失败项。

有界内联审查覆盖锁序/当前读取、精确键、全部资源、冻结Profile/policy/价格、整数费用、发送防重、未知保守保留、重复结算及 rollback/release。无当前 ledger blocker。域锁串行和聚合查询尚无大规模性能承诺；未来管理员配置变更、无价表的人工货币核销及保留期管理未接生产接口，继续 fail closed。

本阶段不交付 T07-B 事件两层去重/持久suppression，也不接生产模型链路。T04 必须消费上述可信执行/终态契约；父任务独立准入与 T12 最终 gate 保留。PR/head/CI/merge 事实在 MAX-146 最终附件记录，不能拿前置 CI 代替本轮 head。无模型调用、付费设施或生产操作；实际 token/费用遥测不可用，无硬预算。
