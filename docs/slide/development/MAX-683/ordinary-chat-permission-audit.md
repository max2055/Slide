# 普通对话权限疑点：基线与候选作者核查

2026-11-16 范围更新：Max 已将普通对话权限另立 MAX-684，不再作为 MAX-683 验收依赖。以下保留当时核查结果及条件判断；本 PR 不实施普通聊天全局授权重构。非作者复核由 Chief 承担，当前事项见 `review-repair.md`。

基线 main `92aa557b887729e19ce2aa4a9e8a957d4e2935ac`；产品候选 `337d93cfb533a96481894086f71780200f5f4883`。本材料是作者核查，不代替独立复核。本轮仅增加现状复现和文档，不更改普通对话全局授权，不重试不可用真实目标。

## 结论与验收关系

普通对话的既有服务端策略是“有效JWT + 当前用户的会话归属/明确只读分享”，不是普通对话全入口的chat:view门禁。没有chat:view的身份在基线与候选都能读取本人普通会话，并把本人或新普通会话的发送送到引擎边界；撤销operations:actions:view后也仍可发送。该允许行为不依赖本次新增的行动权限或action-scope。

没有发现本次扩大普通对话权限、绕过跨用户会话归属、放开关联调查正文或让无授权敏感工具可用的证据。不声称所有工具均不可见：原策略允许的公共能力仍由原目录策略决定；本项未增加额外工具授权。

若AC06要求绝对禁止无chat:view身份使用普通AI对话，则基线和候选均不满足，应作为既有独立权限口径问题处理，不能以action-scope不添加chat:view或隐藏菜单代替验收。其他真实目标、详情/弹窗及独立复核阻塞继续保持。

## 入口与调用链

| 层 | 基线与候选对照 |
|---|---|
| 导航 | 普通对话仍为/chat和原chat菜单；变更收敛三个工作台旧入口，不新增chat路径或发送入口。命令面板原本另按chat:view过滤，不能当成服务端鉴权。 |
| HTTP | chat-routes.ts前置处理仅verifyToken；POST send→handleChatSend：新会话按认证用户创建，指定会话先authorizeSession(append)，再进入引擎。历史和会话列表按当前用户读取。 |
| JWT | authenticateAccessToken实时检查身份/会话版本；Token承载userId/sessionVersion，请求body不能替换身份。 |
| 归属/分享 | ChatDatabaseService SQL按user_id约束；read分享只允许read/history/watch，不允许追加。operations权限不替代归属。 |
| 关联调查 | 历史接口发现关联调查后仍走InvestigationAuthorization(read)，要求原chat权限、成员及资源范围。 |
| WebSocket | DirectAdapter先认证、逐消息revalidateActor，再对history/watch/send核验会话归属；没有新增chat:view门禁，文件与基线相同。 |
| 工具 | 按actor构建目录，经canActorDiscoverTool及agentSecurityPolicy过滤；执行时再executeToolWithPolicy。action-scope不进入普通对话目录构建，不替换actor。 |

chat-routes、chat-handler、chat-database-service、direct-adapter、get-agent-engine、auth-middleware、actor-context、tools/policy、tools/security-catalog九文件SHA256逐一相同，完整哈希清单随附件交付。

## 最小允许/拒绝证据

新增 `apps/db-ops-api/src/auth/chat-permission-contract.mysql.test.ts`，使用独占真实MySQL、正式迁移、真实JWT和实时SQL身份，仅在getAgentEngine边界使用受控替身。证明“允许到达引擎”，不声称真实模型生成；不调用真实Provider、目标或工具处理器。基线和候选分别5项通过，14条观察完全一致。

| 无chat:view身份的场景 | 两版本观察 |
|---|---|
| 无JWT读历史 | 401 |
| 本人普通历史 | 200，可见本人哨兵正文 |
| 跨用户未分享历史 | 404，无他人哨兵正文 |
| 本人发送/新建发送 | 均200，各到达受控引擎一次 |
| 跨用户发送/body伪造身份 | 404/400，未到达引擎 |
| 明确read分享后读取 | 200，是授权分享 |
| read分享身份追加 | 404，未到达引擎 |
| 本人关联调查历史 | 404，无调查哨兵正文 |
| query_metrics/get_instance_connection | 添加行动权限前后均不可发现、不允许，原因相同，未调用处理器 |
| 撤销行动权限后的本人发送 | 仍200，说明不是该权限或新scope赋予 |
| 会话版本撤销后的旧JWT | 401 |

另仅运行已有DirectAdapter两个敏感目录用例，2项通过，其余56项由名称筛选未运行。它们以受控Provider/身份夹具验证认证WebSocket中的敏感目录/连接工具拒绝，不冒充真实Provider或真实JWT端到端证明；真实JWT与SQL由HTTP矩阵证明。

复现：显式设置MAX683_CHAT_MYSQL_PORT、MAX683_CHAT_MYSQL_PASSWORD到任务独占非3306 MySQL，运行 `pnpm --filter slide-api exec vitest run --maxWorkers=1 src/auth/chat-permission-contract.mysql.test.ts`。可选MAX683_CHAT_EVIDENCE写入不含Token的观察JSON。无配置不接触数据库，随机schema结束后删除。基线仅复制同一复现文件，不修改基线产品代码。现状刻画不代表认可放行策略；后续明确改变策略时须更新预期。

## 建议

不把既有差异当作本次回归进行全局重构。先确认普通对话是否与调查统一使用chat:view；若维持AC06绝对禁止要求，以独立、可评审增量统一HTTP/WS读取、新建、发送、watch等入口，并盘点存量角色、分享、后台身份及撤权兼容。保留会话归属、分享只读及工具双重鉴权，不能只隐藏菜单。

本PR继续复核导航兼容与行动视图；普通对话绝对禁止部分不标通过。独立审查由非作者承担，不合并、不部署，不增加人工听读门禁。
