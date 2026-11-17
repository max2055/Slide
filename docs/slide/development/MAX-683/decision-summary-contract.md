# 工作台只读摘要增量

对应 MAX-683 的 2026-11-17 原型 README。后端唯一修改人 15-BackendDev-01；前端类型和消费代码由 15-FrontendDev-01 修改。

`GET /api/operations/workspace-attention` 每条新增：

- `decisionSummary.conclusion: string|null`：已授权、结构校验通过的绑定结果 summary；旧 v1 使用 conclusions。不是已确认根因或恢复保证。
- `recommendation: string|null`：v2 结果首条建议，保留来源顺序，不推断优先级；完整建议仍读原结果。
- `sourceRef: {type:'investigation_result',id:string,version:number}|null`、`asOf: string|null`：结果版本和持久化时间。行动使用计划绑定结果版本；不能与调查最新版本混用。
- `targetRef: {type:'server',id:number}|null`、`displayName: string|null`、`impact: string|null`、`stage: string|null`：已授权计划的目标、名称、影响和当前计划状态；stage 不是调查生命周期、执行状态或业务恢复状态。
- 行级 `planUpdatedAt: string|null`、`expiresAt: string|null`：计划自己的更新时钟和有效期；无计划时均为 null。

所有字段是只读展示数据，不作为提交授权凭证。原 title/updatedAt 仍属调查。阶段、建议、结论、目标缺失时明确提示未提供；不从 kind/title 拼造结论。原型拟议 evidence/趋势没有可靠完整时序投影，本次不生成图表；证据完整读取沿原结果与报告接口。

现有 chat:view、调查内容授权、证据绑定校验、计划资格检查仍在事务内执行。投影绑定旧结果时额外校验该旧结果全部证据。仅行动权限仍走独立 plans 列表，不通过此接口读取调查摘要。分页、每调查一个下一步、完整类型列表发现及写入接口均保持原契约。

既有 PR #1008 的 targetName/updatedAt/verificationState 属已有候选，集成时保留，勿重复实现。本增量基于私有分支 2c1c9c33954fab4019a82bb4686edf533acb5493，供原 PR 集成。

验证：直接调用仓库脚本的等价 Node 入口，后端 tsc --noEmit、generate-public-api.ts --check、decision-summary.test.ts 与 contracts.test.ts（6 tests）通过；source-policy 0 violations，git diff --check 通过。环境使用已有本机 Node 与依赖链接，未安装新包。最初缺前端/agent-core依赖的检查失败，补齐链接后通过。

未完成：真实数据库/HTTP 摘要权限与旧版本绑定验收、前端联调、四身份与实时撤权、完整列表发现、审批执行/并发幂等回归、独立复核及最终集成 gate。当前测试仅证明投影结构与缺失降级，不能替代这些业务验收。无模型调用、共享数据库写入、部署或发布。
