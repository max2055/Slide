# MAX-69 采集策略实施计划

> Execution: 在已授权范围内执行，复用已合并契约，不要求重复设计批准。

Goal: 包推荐 → 单主资源组 → 资源覆盖 → 能力/平台限制的确定解析、持久发布及影响预览。

Architecture: 纯解析器复用 MAX-64 契约、MAX-67 不可变包；事务存储主组、资源绑定、发布快照和审计。复用资源管理权限，不接受客户端能力证明。发布 revision 与 worker 应用 revision 分开。

Tech Stack: TypeScript、Zod、Fastify、MySQL、Vitest。

## 执行契约 v1

- 基线 main `6c2af2a`，包含 MAX-65 PR #79、MAX-67 PR #80；分支 `agent/15astra/max69-policy`。
- 范围：解析、包版本绑定、三态覆盖、来源映射、限制校验、预览、资源鉴权、CAS revision、事务审计、应用状态查询契约。
- 排除：UI、调度、实际 worker 上报集成（MAX-70）、Canonical/CoreProfile 修改、生产变更。
- 预算：未设定；实际 token/费用遥测不可用；不委派子代理。
- 停止条件：既定验收完成；或缺少不可替代依赖/授权，保留可审阅检查点。无关缺陷不扩范围。

## 实施步骤

1. `src/metrics-v2/policy/model.ts`：严格输入 schema；每个值的继承/设值；启停继承/启用/禁用；指标启停；平台边界。
2. `resolver.ts` 与 `resolver.test.ts`：解析来源、映射/依赖、能力时效、确定性、超时保留能力、包升级覆盖、请求量估算。无外部调用的预览。
3. `099_metric_v2_policy.sql`、`store.ts`、`service.ts`：单主组、资源绑定、事务发布/CAS/审计、应用状态；对每个受影响资源鉴权。升级只换 pin，保留覆盖。
4. `routes.ts`、`routes.test.ts`、`server.ts`：资源/组预览、发布、查询、审计；拒绝秘密字段，响应不包含凭据引用；实际 worker 写入不开放公共 API。
5. `store.mysql.test.ts`：一次性隔离库验证持久化、并发赢家、失败回滚、组更新、应用状态；按层运行受影响测试、类型/lint/契约/目录门禁、最终后端 gate。
6. 本目录 README/validation/fixture：记录命令、结果、限制和回退，提交 PR，回读 issue 状态与最终评论。

## 设计选择

采用独立增量表而不改旧采集路径；采用数据库内单一发布锁序列化低频配置操作，避免组成员变更与批量发布的幻读。运行采集和读查询不使用此锁。比跨行无锁 CAS 更容易证明原子性；暂不引入队列/分布式锁。

组策略只对显式主组成员生效；没有组时直接继承包。资源覆盖优先，平台限制只拒绝非法值，不静默改写；每个 collector 的包内 timeout 上限单独列出。组发布要求所有成员管理权，空组只允许全局管理员创建/修改。禁用上游而显式启用依赖指标拒绝；整体停用保留配置和能力。

验收证据：解析矩阵、资源隔离、版本切换覆盖保留、revision 竞争、组事务回滚、权限/凭据脱敏、published/applied 分离、真实隔离 MySQL；文档目录门禁和相关 fixture/schema 校验。worker 未上报时 applied_revision=null。
