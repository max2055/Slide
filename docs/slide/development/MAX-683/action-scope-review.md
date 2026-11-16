# action-scope 作者自查与基线对照

本文件是作者自查材料，不计作独立复核。基线为 main 92aa557b887729e19ce2aa4a9e8a957d4e2935ac，原实现候选为 42a0ad213be94b7ccda53f711881f6f853371e9f；后续候选 SHA 见交付证据包。

## 授权调用链

| 入口 | 基线 | 当前候选 |
|---|---|---|
| GET actions/plans/:id | verifyToken → ActionPlanService.get/readIn → PlanSources.scope → InvestigationAuthorization.authorize(content) → OperationsAuthorization.authorize(actions:read) | 仅 scope 内的 content 改为 action-scope；后续 actions:read 不变 |
| GET actions/plans（发现、计划过滤） | verifyToken → discover 双重检查调用时与当前 actions:view → 指定调查时 authorize(content) → 每条 readIn → 授权绑定游标 | 指定调查和 readIn 的范围核验使用 action-scope；全局统计仍仅可见记录，拒绝项不贡献标识或计数 |
| GET execution-context/:id、验证读取 | 原执行记录 → 原历史计划及其完整范围 → 行动资源鉴权 | 共用 scope 的读取可不要求 chat；原执行/计划/报告绑定仍保留，不返回调查正文 |
| 提出/修订、提交/审批、执行、验证准备 | sources.lock → 调查 content、来源有效版本/证据/环境 → 原操作权限、独立审批、有效期/版本/hash/实时授权 | lock 路径保持 content，没有替换成 action-scope；scope 的改变不跳过后续写操作检查 |
| GET /api/investigations、结果/证据、工具/模型入口 | 原 read/content/watch/create/continue 等调查权限 | 不改。没有把 action-scope 暴露成可由 HTTP 指定的调查操作，不授予 chat:view |

与基线相比，唯一有意放宽的是“具有行动查看权限且满足原成员和资源边界的用户，读取原授权计划时不再额外要求 chat:view”。不是通过补授 chat 权限实现。

## 保留的范围检查

PlanSources.scope 合并调查当前资源、计划每份直接证据的 metadata.resources、关联/基线所指资源；缺失或格式异常拒绝。InvestigationAuthorization 重新读取实时身份和有效成员；所有权限同时取调用时上限与实时权限交集，存在冻结上限时也须满足。scope_revision>0 时额外核对 investigation_scope_resources 历史资源。

每个资源均检查合法类型/正整数身份、当前读取权限、调用者 resourceBoundary 和实际存在性；数据库实例还保留显式 instanceScopes、可用生命周期及全局权限来源约束。系统调查仍要求 config:view。范围核验后，OperationsAuthorization 再检查行动读取权限及其完整资源集。

action-scope 返回的 tools 为空，返回 actor 的权限集合不包含凭空添加的 chat:view；此内部返回值也未被作为调查正文/证据接口的替代授权。计划中已有的证据版本/hash引用仍可见，证据正文仍走调查接口鉴权。后续审批/执行继续使用原来源 lock 检查，不因“能看计划”获得处置能力。

## 允许 / 拒绝矩阵

| 身份及状态 | 计划读取 / 发现 | 调查正文、证据、工具 |
|---|---|---|
| 仅 actions:view + 完整资源读取 + 有效成员，无 chat | 允许授权原计划与元信息 | 拒绝正文/证据；tools=[]，不获得 chat |
| 有 chat，无 actions:view | 拒绝行动读取 | 仅按原调查授权 |
| 另一有效 viewer 成员 + 行动及资源权限 | 可只读授权计划，不要求是作者 | 无 chat 时仍拒绝调查内容 |
| 非成员、过期成员、跨用户猜测计划ID | 拒绝或在发现中不可见 | 拒绝 |
| 实时撤销 actions:view、servers:view 或会话版本变化 | 拒绝旧调用上下文 | 不使用客户端缓存恢复授权 |
| 调用者 boundary 不含当前目标 | 拒绝 | 拒绝 |
| 目标可读但证据 metadata 涉及 boundary 外资源 | 拒绝 | 拒绝 |
| 当前目标可读但保留历史范围含 boundary 外资源 | 拒绝 | 拒绝 |
| 作者/提交者自批、过期/改版批准、缺写权限 | 沿用原写路径拒绝 | action-scope 不影响这些检查 |

## 可执行证据

apps/db-ops-api/src/operations/actions/plan-service.mysql.test.ts：

- MAX-683 discovers authorized plans without chat permission...：验证另一个有效成员可读取原计划、无调查正文、无工具与chat授权、非成员发现为空、实时行动撤权拒绝。
- MAX-683 action-scope retains the original %s boundary without chat：六个真实SQL变体覆盖成员过期、实时资源撤权、调用上限、证据完整范围、历史范围、会话撤销。
- 同套件既有自批、版本/hash、过期、来源范围、实时JWT/SQL用例保留。

新增六个变体与原90项合计96项真实SQL用例通过。用户名/角色是隔离测试身份，不冒充真实审批人；此处证明生产授权代码和SQL行为，不代替正式登录的完整处置恢复闭环或独立复核。
