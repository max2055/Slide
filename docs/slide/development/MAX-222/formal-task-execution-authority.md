# MAX-222 正式任务冻结分配（未激活候选）

本次只接线受信任启动配置，不启用产品模型调用。正式共享 API/Worker 仍使用默认配置：20 次工具、65,536 上下文、128,000 单次调查累计 token。候选为 36 / 294,912 / 1,200,000；普通和摘要共用 8 attempts、普通输出 8,192、摘要输出 10,240、120 秒不变。

## 入口和身份

`execution-allocation.ts` 的 `MAX-222/task-v1` 使用完整配置和 authority：固定 task UUID、实际负责人 run UUID、全新 gate UUID、精确 domain `task.max222.<ownerRunId>.<gateId>`、源码来源 SHA256。配置值和键集合严格匹配；不扩大 `qualification.max222.*` 的正则。普通环境变量、HTTP 请求、模型或 job payload 均不能选择此配置。

受信任启动 composition 将同一份完整配置显式传给 `InvestigationSessionBridge`、`InvestigationExecutor` 和 `MysqlInvestigationBudgetLedger` 的内部参数。配置在进入异步执行前复制/冻结；正式 allocation 的读取必须匹配启动侧配置，持久化 JSON 及其重算 hash 本身不能授权。没有配置的既有请求仍执行其原额度。

```typescript
// 仅在经审阅、单独授权的启动 composition 内构造。不是环境或 HTTP API。
const budget = {
  ...investigationBudgetConfiguration(),
  domain: configuration.authority!.domain,
  policy: { ...investigationBudgetConfiguration().policy,
    maxAutomaticTokensPerDay: 1_200_000, maxTotalTokensPerDay: 1_200_000 },
  taskExecution: configuration,
};
const bridge = new InvestigationSessionBridge(poolProvider, authorization, budget);
const executor = new InvestigationExecutor({ ...trustedExecutorPorts, budget });
// 需要单独构造 ledger 时，同样传入该冻结配置；不得只修改额度。
const ledger = new MysqlInvestigationBudgetLedger(poolProvider, budget.policy,
  budget.maxExecutionTokens, configuration);
```

每个正式 gate 的 domain 用现有 ledger domain 行锁串行化，锁在创建会话／请求前取得；新准入检查独立持久字段 `investigation_requests.execution_domain`，不再依赖可缺失的 JSON allocation。一个 gate 只接收一个新请求，继续调查也要新 gate；拒绝以现有权限错误返回 403，并整体回滚准入/消息/job。已有幂等请求重读并校验原冻结身份；缺失／损坏 allocation 或启动配置、执行域漂移均拒绝，不能按旧额度降级。request/investigation/profile/policy/configuration/hash 绑定沿用现有冻结链，run 生成后与 SQL checkpoint 的 allocationRunId 绑定，后续 SDK/handler 前继续核对同一分配、receipt、ACL 和 lease/fence。新增 131／132 前向迁移：请求表增加可空、唯一的 `execution_domain`，再单独回填完整旧候选的正式 domain。旧请求保持 NULL 和原额度；重复 domain 使回填失败，不选择赢家或删旧账。没有新增表。

## 已验证与限制

原候选 `019fdd3785267aa66b455aa2ead7c985a8cf06e8` 对真实任务 domain 的受信任 composition 准入拒绝已复现。新候选的正式配置和原离线配置分别通过真实 JWT HTTP → Worker → 本地回环 SDK → MySQL 测试；合成成果持久化、results/latestResult 一致，两次不同 API/Worker 进程的终态恢复均无新发送。来源/gate/owner 变更并重算 hash、缺失启动 authority、跨 request/domain、receipt/run 损坏和 HTTP 注入继续拒绝；37 工具批次不执行前缀；旧 unknown charge 不退款。

这些是合成 SQL 预留和回环 SDK，不是产品账本或自主模型分析。B18 的原夹具、2 attempts / 16 tools / 15,468 token 和 partial 结论未改。

本轮另准备并实际恢复同一份新鲜 166 表副本，验证 schema/PRIMARY、native scalar/hash、Provider 路由、空调查/意图/动作/通知，关闭自动调查和指标采集。默认 API/Worker 启动、中文浅色正常登录和未提交调查表单通过。平台启动生成的五类例行 workflow（各已执行/后续 queued）独立记录，不冒充调查。服务已 SIGTERM 正常退出，临时库已删除；受保护原始快照只留本地，上传证据不包含业务原始库或凭据。

后续必须先独立审阅新源码和清单，再决定标准交付；本次 local-only，不推送或启动 CI。实际激活/首发需新的负责人 run、gate、Chief 独占新预留和最新账本核验。恢复同一冻结快照后重新核验最新成员决定、实际 Provider 能力/可靠计量、冻结材料和 API/Worker 最终 readiness；本轮零发送准备不是最终发送 ready，也不继承 B18 或 CI 的发送权。完整真实诊断、采集覆盖和可信生命周期来源/迁移、活动摘要真实恢复与真实 deadline 收尾仍未验收。

## 身份缺失整改与恢复

旧 `1e0585fd` 的两个真实 MySQL 反例已保留：只删除 JSON allocation 会错误降级预留 32,000 并进入合成 Provider 一次；同 gate 第二请求也会错误返回 202。新候选在 executor／ledger 的持久读取中同时校验独立执行域，缺失身份在预留和 Provider／handler 前持久拒绝；同 gate 并发只准入一个新请求，第二请求及其会话、消息和 job 整体回滚。

迁移在同一 SHA256 `550332899fb9bb63fdb8ca02d241c3ca2f664b1caae9143636c903df6098852b` 的受保护快照恢复后实际运行两次，仍为 166 张表，仅请求表结构扩展；除迁移账本外原 native 行 hash 不变。该快照仍是旧 schema 和旧观测时刻，未来恢复后必须先迁移并重新准入，不能称已最终 ready。此轮没有启动 API／Worker、产品调用或新鲜采集。

回退只能停用任务配置并保留新增字段、唯一约束、原 allocation、receipt 和所有 unknown／inflight／delegated 账目；不得 drop 列／回填删除／清 gate 退款。旧二进制不识别独立 marker，因而不能用旧正式任务 composition 执行损坏请求；正式任务必须停发至恢复当前验证版本。共享默认请求仍可按其既有冻结额度运行。候选及迁移均未发布或应用到共享库，后续需独立审阅新的干净发布树与门禁。
