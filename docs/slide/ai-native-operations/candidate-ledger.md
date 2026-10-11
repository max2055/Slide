# R00 候选逐项证据账本

最终报告重点路径 180 条，加上阶段快照未独立保留的 17 个位置，共 197 个记录、38 个文件。不等于 3884 条全仓候选已确认。FINAL 与 PARTIAL 编号来自各自报告，不能混用；family 字段只归并同类责任，不伪造逐字相同。JSON 保存每项当前源码行段和文件 hash。

判定计数：{'rejected': 24, 'confirmed': 11, 'needs-evidence': 162}。源码 SHA 统一为 `fb0766d606c9f07448a5eddac2a6657847d90830`。未决项逐条留缺口；clear 仅排除该条候选，不批准整个领域。

|发现 ID / 快照位置别名|文件:行|结论|证据与缺口|责任任务|门禁 / 处置|
|---|---|---|---|---|---|
|FINAL-0013|`apps/db-ops-api/src/platform/github-source-connector.ts:68`|rejected|该 REST connector 已标 deprecated；SourceManagementService.sync 生产只实例化 GitSourceConnector。候选的 archive/symlink/GHE/资源限制问题属于未启用路径，不能阻塞当前 V1；若未来启用须先有独立安全修复。|T09；修复 PR 尚无|clear / backlog|
|FINAL-0026|`apps/db-ops-api/src/workflows/outbox-service.ts:10`|confirmed|beginTransaction 位于 try 外；reproduce.mts 注入 begin 失败，release=0。阻塞新事务复用，须由 T02/MAX-143 先交有界修复 PR，T04/T07 复用修复。|T02, T07；修复 PR 尚无|blocked / related-task|
|FINAL-0029|`frontend/src/app/ui/components/chat-message-list.ts:70`|rejected|components/chat-message-list.ts 未被生产 frontend/src 引用；现用 views/chat.ts 的正则定义在 while 外。候选所说在用 Chat 卡死不成立；未使用组件自身循环/请求风险归独立 backlog，禁止 T06 直接启用。|T06；修复 PR 尚无|clear / backlog|
|FINAL-0080 / PARTIAL-0077|`apps/db-ops-api/src/adapter/agent-run-service.ts:147`|rejected|MySQL 9.6.0 真实常量 SELECT original_predicate=1、unquoted_predicate=1，否定“永远无法匹配”。不代表全部 MySQL 版本或完整 crash recovery 已验收。|T04；修复 PR 尚无|clear / no-fix|
|FINAL-0083 / PARTIAL-0082|`apps/db-ops-api/src/adapter/direct-adapter.ts:917`|needs-evidence|async listener 可交错属事实，但已有 authGeneration/session lock/DB 幂等；需构造 re-auth 与 send 的确定性时序、核实 stale actor 可达性。|T04；修复 PR 尚无|pending / related-task|
|FINAL-0084 / PARTIAL-0083|`apps/db-ops-api/src/adapter/display-stream.ts:133`|needs-evidence|真实 reducer probe：end 后 append 不改 parts，但 sequence 从2推进到3，并非候选说的原引用不变；display 仍发 late frame。需比较客户端 reducer 后结果，尚未证实 UI 污染。|T05；修复 PR 尚无|pending / related-task|
|FINAL-0100 / PARTIAL-0101|`apps/db-ops-api/src/alert-database-service.ts:206`|needs-evidence|缺省 scoped options 放行是内部服务契约，当前路由是否遗漏 scope 尚未证明；须从 server 路由到列表查询验证 instanceId 与 allowedIds 组合。|T07, T08, T10；修复 PR 尚无|pending / related-task|
|FINAL-0101 / PARTIAL-0102|`apps/db-ops-api/src/alert-database-service.ts:499`|needs-evidence|retentionDays<=0 清空是现有显式管理清理路径；是否缺少授权/操作确认需核对调用方，R00 不执行任何清理。|T07, T08, T10；修复 PR 尚无|pending / related-task|
|FINAL-0106 / PARTIAL-0111|`apps/db-ops-api/src/analysis/analysis-dispatch-store.ts:73`|needs-evidence|legacy manual retry 在无 snapshot/cache 归属时条件可能放行；还需检查调用方对 analysisId/subject 的授权及隔离 MySQL+真实 HTTP 复现。T08 所有权裁定前不得直接接管 legacy。|T08；修复 PR 尚无|pending / related-task|
|FINAL-0107 / PARTIAL-0112|`apps/db-ops-api/src/analysis/analysis-evidence.ts:12`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T08；修复 PR 尚无|pending / related-task|
|FINAL-0108 / PARTIAL-0113|`apps/db-ops-api/src/analysis/analysis-evidence.ts:115`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T08；修复 PR 尚无|pending / related-task|
|FINAL-0109 / PARTIAL-0114|`apps/db-ops-api/src/analysis/analysis-identity.ts:31`|rejected|revalidateActor 从 DB 重建 actor，不返回持久 resourceBoundary；旧 boundary 是调度约束而非可由管理员改写的 DB 列。真实 scopes/permissions/sessionVersion 变化仍进入版本比较。候选的“只收缩当前 boundary”触发条件未成立；T03 新 Profile/live scope 仍须求交。|T08；修复 PR 尚无|clear / no-fix|
|FINAL-0120 / PARTIAL-0127|`apps/db-ops-api/src/auth/actor-context.ts:358`|rejected|admin 用户/角色是当前显式 bootstrap 超管兼容规则；候选未证明可创建或重命名为保留身份。拒绝“字符串可控即越权”的现有漏洞结论；T03 服务身份不得使用此身份/角色或继承 *。|T03；修复 PR 尚无|clear / no-fix|
|FINAL-0126 / PARTIAL-0133|`apps/db-ops-api/src/auth/require-instance-access.ts:34`|confirmed|构造 scopes={1,2}, boundary={1}：列表返回[1,2]、URL id=2 中间件200，hasInstanceAccess 则拒绝。为 helper 不一致；浏览器 actor 当前不持久化 boundary，不能据此声称现有任意用户越权。T03 服务身份桥接前修复。|T03；修复 PR 尚无|blocked / related-task|
|FINAL-0127 / PARTIAL-0134|`apps/db-ops-api/src/auth/require-instance-access.ts:88`|confirmed|构造 scopes={1,2}, boundary={1}：列表返回[1,2]、URL id=2 中间件200，hasInstanceAccess 则拒绝。为 helper 不一致；浏览器 actor 当前不持久化 boundary，不能据此声称现有任意用户越权。T03 服务身份桥接前修复。|T03；修复 PR 尚无|blocked / related-task|
|FINAL-0128 / PARTIAL-0135, PARTIAL-0546|`apps/db-ops-api/src/auth/require-permission.ts:26`|rejected|admin 用户/角色是当前显式 bootstrap 超管兼容规则；候选未证明可创建或重命名为保留身份。拒绝“字符串可控即越权”的现有漏洞结论；T03 服务身份不得使用此身份/角色或继承 *。|T03；修复 PR 尚无|clear / no-fix|
|FINAL-0159|`apps/db-ops-api/src/event-aggregator.ts:77`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T07, T08, T10；修复 PR 尚无|pending / related-task|
|FINAL-0160|`apps/db-ops-api/src/event-aggregator.ts:106`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T07, T08, T10；修复 PR 尚无|pending / related-task|
|FINAL-0161|`apps/db-ops-api/src/event-aggregator.ts:206`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T07, T08, T10；修复 PR 尚无|pending / related-task|
|FINAL-0170|`apps/db-ops-api/src/lifecycle/worker-lease.ts:21`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T04；修复 PR 尚无|pending / related-task|
|FINAL-0171|`apps/db-ops-api/src/lifecycle/worker-lease.ts:26`|needs-evidence|DELETE 后新 token=1 的 SQL 事实成立；WorkerLease 只公开 boolean，未找到下游消费该 singleton token 的证据，不能混同 workflow_jobs 自增 fencing。T04/T12 复核 startup owner 与迟到写。|T04；修复 PR 尚无|pending / related-task|
|FINAL-0213|`apps/db-ops-api/src/platform/github-source-connector.ts:63`|rejected|该 REST connector 已标 deprecated；SourceManagementService.sync 生产只实例化 GitSourceConnector。候选的 archive/symlink/GHE/资源限制问题属于未启用路径，不能阻塞当前 V1；若未来启用须先有独立安全修复。|T09；修复 PR 尚无|clear / backlog|
|FINAL-0214|`apps/db-ops-api/src/platform/github-source-connector.ts:66`|rejected|该 REST connector 已标 deprecated；SourceManagementService.sync 生产只实例化 GitSourceConnector。候选的 archive/symlink/GHE/资源限制问题属于未启用路径，不能阻塞当前 V1；若未来启用须先有独立安全修复。|T09；修复 PR 尚无|clear / backlog|
|FINAL-0215|`apps/db-ops-api/src/platform/gitlab-source-connector.ts:48`|rejected|该 REST connector 已标 deprecated；SourceManagementService.sync 生产只实例化 GitSourceConnector。候选的 archive/symlink/GHE/资源限制问题属于未启用路径，不能阻塞当前 V1；若未来启用须先有独立安全修复。|T09；修复 PR 尚无|clear / backlog|
|FINAL-0216|`apps/db-ops-api/src/platform/platform-observation-service.ts:10`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T09；修复 PR 尚无|pending / related-task|
|FINAL-0217|`apps/db-ops-api/src/platform/source-routes.ts:16`|needs-evidence|代码风格/类型或配置建议，尚未给出可达的错误结果；更新后的 AGENTS 没有全仓改写或机械替换要求。除触达后证实契约错误外，留独立 backlog，不作为准入 blocker。|T09；修复 PR 尚无|pending / backlog|
|FINAL-0218|`apps/db-ops-api/src/platform/source-snapshot-service.ts:100`|rejected|source-snapshot-service.test 明确测试敏感标记作为签名 advisory，保留完整源码；requireSourceReader 与 inspect model egress 为访问边界。拒绝将既定设计直接当越权缺陷；T09 模型证据脱敏仍未验收。|T09；修复 PR 尚无|clear / no-fix|
|FINAL-0300|`apps/db-ops-api/src/workflows/outbox-service.ts:27`|confirmed|重复插入保留旧 id，但 append 返回新 UUID；executor 复现。当前 report occurrence 按幂等键定位，未证实当前调用产生孤儿；T02 接入前明确稳定 ID 契约并补真实 MySQL。|T02, T07；修复 PR 尚无|blocked / related-task|
|FINAL-0370|`frontend/src/app/ui/components/chat-message-list.ts:83`|rejected|components/chat-message-list.ts 未被生产 frontend/src 引用；现用 views/chat.ts 的正则定义在 while 外。候选所说在用 Chat 卡死不成立；未使用组件自身循环/请求风险归独立 backlog，禁止 T06 直接启用。|T06；修复 PR 尚无|clear / backlog|
|FINAL-0381|`frontend/src/app/ui/embed-sandbox.ts:10`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T06；修复 PR 尚无|pending / related-task|
|FINAL-0399|`frontend/src/app/ui/views/chat.ts:717`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T06；修复 PR 尚无|pending / related-task|
|FINAL-0611 / PARTIAL-0410|`apps/db-ops-api/src/adapter/agent-run-service.ts:50`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T04；修复 PR 尚无|pending / related-task|
|FINAL-0613 / PARTIAL-0412|`apps/db-ops-api/src/adapter/canonical-store.ts:43`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T05；修复 PR 尚无|pending / related-task|
|FINAL-0614 / PARTIAL-0413|`apps/db-ops-api/src/adapter/canonical-store.ts:56`|confirmed|payload 比较未含 metadata/完整 messageParts，更新仅看 status。静态路径可保留旧事实；T05 定义不可变事实和版本更新语义，补真实重复 checkpoint。|T05；修复 PR 尚无|blocked / related-task|
|FINAL-0617 / PARTIAL-0416|`apps/db-ops-api/src/adapter/direct-adapter.ts:297`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T04；修复 PR 尚无|pending / related-task|
|FINAL-0618 / PARTIAL-0417|`apps/db-ops-api/src/adapter/direct-adapter.ts:812`|confirmed|send 使用已解析 sessionId，cancel 直接比较原始 key；带 agent 前缀路径静态不一致。T04/T06 接取消前以真实 WS 测试关闭。|T04；修复 PR 尚无|blocked / related-task|
|FINAL-0619 / PARTIAL-0418|`apps/db-ops-api/src/adapter/direct-adapter.ts:963`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T04；修复 PR 尚无|pending / related-task|
|FINAL-0620 / PARTIAL-0419|`apps/db-ops-api/src/adapter/display-stream.ts:82`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T05；修复 PR 尚无|pending / related-task|
|FINAL-0632 / PARTIAL-0433|`apps/db-ops-api/src/adapter/message-projection.ts:65`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T05；修复 PR 尚无|pending / related-task|
|FINAL-0656 / PARTIAL-0463|`apps/db-ops-api/src/alert-database-service.ts:87`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T07, T08, T10；修复 PR 尚无|pending / related-task|
|FINAL-0657 / PARTIAL-0464|`apps/db-ops-api/src/alert-database-service.ts:132`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T07, T08, T10；修复 PR 尚无|pending / related-task|
|FINAL-0658 / PARTIAL-0466|`apps/db-ops-api/src/alert-database-service.ts:625`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T07, T08, T10；修复 PR 尚无|pending / related-task|
|FINAL-0659 / PARTIAL-0467|`apps/db-ops-api/src/alert-engine.ts:123`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T07, T08, T10；修复 PR 尚无|pending / related-task|
|FINAL-0660 / PARTIAL-0469|`apps/db-ops-api/src/alert-engine.ts:365`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T07, T08, T10；修复 PR 尚无|pending / related-task|
|FINAL-0677 / PARTIAL-0492|`apps/db-ops-api/src/analysis/analysis-dispatch-handler.ts:44`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T08；修复 PR 尚无|pending / related-task|
|FINAL-0678 / PARTIAL-0493|`apps/db-ops-api/src/analysis/analysis-dispatch-handler.ts:55`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T08；修复 PR 尚无|pending / related-task|
|FINAL-0681 / PARTIAL-0496|`apps/db-ops-api/src/analysis/analysis-evidence.ts:42`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T08；修复 PR 尚无|pending / related-task|
|FINAL-0682 / PARTIAL-0497|`apps/db-ops-api/src/analysis/analysis-evidence.ts:74`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T08；修复 PR 尚无|pending / related-task|
|FINAL-0684 / PARTIAL-0499|`apps/db-ops-api/src/analysis/analysis-identity.ts:25`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T08；修复 PR 尚无|pending / related-task|
|FINAL-0685 / PARTIAL-0500|`apps/db-ops-api/src/analysis/analysis-identity.ts:38`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T08；修复 PR 尚无|pending / related-task|
|FINAL-0711 / PARTIAL-0527|`apps/db-ops-api/src/auth/actor-context.ts:116`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T03；修复 PR 尚无|pending / related-task|
|FINAL-0712 / PARTIAL-0528|`apps/db-ops-api/src/auth/actor-context.ts:153`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T03；修复 PR 尚无|pending / related-task|
|FINAL-0713 / PARTIAL-0529|`apps/db-ops-api/src/auth/actor-context.ts:204`|needs-evidence|JWT 当前 secret 类型及 jsonwebtoken 算法限制需一起验证；未配置的未来非对称公钥场景不能直接认定当前算法混淆。|T03；修复 PR 尚无|pending / related-task|
|FINAL-0714 / PARTIAL-0530|`apps/db-ops-api/src/auth/actor-context.ts:260`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T03；修复 PR 尚无|pending / related-task|
|FINAL-0725 / PARTIAL-0541|`apps/db-ops-api/src/auth/require-instance-access.ts:47`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T03；修复 PR 尚无|pending / related-task|
|FINAL-0726 / PARTIAL-0542|`apps/db-ops-api/src/auth/require-instance-access.ts:58`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T03；修复 PR 尚无|pending / related-task|
|FINAL-0727 / PARTIAL-0544|`apps/db-ops-api/src/auth/require-instance-access.ts:93`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T03；修复 PR 尚无|pending / related-task|
|FINAL-0743 / PARTIAL-0566|`apps/db-ops-api/src/chat-database-service.ts:406`|needs-evidence|需核对 mysql2 CLIENT_FOUND_ROWS 默认及实际连接 flags；不能直接接受“默认 changed rows”前提，现有 unit stubs 不证明数据库 affectedRows。|T03；修复 PR 尚无|pending / related-task|
|FINAL-0744 / PARTIAL-0567|`apps/db-ops-api/src/chat-database-service.ts:522`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T03；修复 PR 尚无|pending / related-task|
|FINAL-0849|`apps/db-ops-api/src/event-aggregator.ts:51`|needs-evidence|代码风格/类型或配置建议，尚未给出可达的错误结果；更新后的 AGENTS 没有全仓改写或机械替换要求。除触达后证实契约错误外，留独立 backlog，不作为准入 blocker。|T07, T08, T10；修复 PR 尚无|pending / backlog|
|FINAL-0850|`apps/db-ops-api/src/event-aggregator.ts:196`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T07, T08, T10；修复 PR 尚无|pending / related-task|
|FINAL-0851|`apps/db-ops-api/src/event-aggregator.ts:217`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T07, T08, T10；修复 PR 尚无|pending / related-task|
|FINAL-0852|`apps/db-ops-api/src/event-aggregator.ts:274`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T07, T08, T10；修复 PR 尚无|pending / related-task|
|FINAL-0917|`apps/db-ops-api/src/lifecycle/worker-lease.ts:11`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T04；修复 PR 尚无|pending / related-task|
|FINAL-0918|`apps/db-ops-api/src/lifecycle/worker-lease.ts:14`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T04；修复 PR 尚无|pending / related-task|
|FINAL-0919|`apps/db-ops-api/src/lifecycle/worker-lease.ts:16`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T04；修复 PR 尚无|pending / related-task|
|FINAL-0920|`apps/db-ops-api/src/lifecycle/worker-lease.ts:32`|needs-evidence|需核对 mysql2 CLIENT_FOUND_ROWS 默认及实际连接 flags；不能直接接受“默认 changed rows”前提，现有 unit stubs 不证明数据库 affectedRows。|T04；修复 PR 尚无|pending / related-task|
|FINAL-1104|`apps/db-ops-api/src/platform/deployment-binding.ts:7`|needs-evidence|代码风格/类型或配置建议，尚未给出可达的错误结果；更新后的 AGENTS 没有全仓改写或机械替换要求。除触达后证实契约错误外，留独立 backlog，不作为准入 blocker。|T09；修复 PR 尚无|pending / backlog|
|FINAL-1105|`apps/db-ops-api/src/platform/deployment-binding.ts:16`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T09；修复 PR 尚无|pending / related-task|
|FINAL-1106|`apps/db-ops-api/src/platform/deployment-binding.ts:25`|needs-evidence|代码风格/类型或配置建议，尚未给出可达的错误结果；更新后的 AGENTS 没有全仓改写或机械替换要求。除触达后证实契约错误外，留独立 backlog，不作为准入 blocker。|T09；修复 PR 尚无|pending / backlog|
|FINAL-1107|`apps/db-ops-api/src/platform/git-source-connector.ts:41`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T09；修复 PR 尚无|pending / related-task|
|FINAL-1108|`apps/db-ops-api/src/platform/git-source-connector.ts:42`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T09；修复 PR 尚无|pending / related-task|
|FINAL-1109|`apps/db-ops-api/src/platform/git-source-connector.ts:112`|needs-evidence|代码风格/类型或配置建议，尚未给出可达的错误结果；更新后的 AGENTS 没有全仓改写或机械替换要求。除触达后证实契约错误外，留独立 backlog，不作为准入 blocker。|T09；修复 PR 尚无|pending / backlog|
|FINAL-1110|`apps/db-ops-api/src/platform/github-source-connector.ts:44`|rejected|该 REST connector 已标 deprecated；SourceManagementService.sync 生产只实例化 GitSourceConnector。候选的 archive/symlink/GHE/资源限制问题属于未启用路径，不能阻塞当前 V1；若未来启用须先有独立安全修复。|T09；修复 PR 尚无|clear / backlog|
|FINAL-1111|`apps/db-ops-api/src/platform/github-source-connector.ts:65`|rejected|该 REST connector 已标 deprecated；SourceManagementService.sync 生产只实例化 GitSourceConnector。候选的 archive/symlink/GHE/资源限制问题属于未启用路径，不能阻塞当前 V1；若未来启用须先有独立安全修复。|T09；修复 PR 尚无|clear / backlog|
|FINAL-1112|`apps/db-ops-api/src/platform/github-source-connector.ts:67`|rejected|该 REST connector 已标 deprecated；SourceManagementService.sync 生产只实例化 GitSourceConnector。候选的 archive/symlink/GHE/资源限制问题属于未启用路径，不能阻塞当前 V1；若未来启用须先有独立安全修复。|T09；修复 PR 尚无|clear / backlog|
|FINAL-1113|`apps/db-ops-api/src/platform/gitlab-source-connector.ts:56`|rejected|该 REST connector 已标 deprecated；SourceManagementService.sync 生产只实例化 GitSourceConnector。候选的 archive/symlink/GHE/资源限制问题属于未启用路径，不能阻塞当前 V1；若未来启用须先有独立安全修复。|T09；修复 PR 尚无|clear / backlog|
|FINAL-1114|`apps/db-ops-api/src/platform/gitlab-source-connector.ts:66`|rejected|该 REST connector 已标 deprecated；SourceManagementService.sync 生产只实例化 GitSourceConnector。候选的 archive/symlink/GHE/资源限制问题属于未启用路径，不能阻塞当前 V1；若未来启用须先有独立安全修复。|T09；修复 PR 尚无|clear / backlog|
|FINAL-1115|`apps/db-ops-api/src/platform/platform-observation-service.ts:18`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T09；修复 PR 尚无|pending / related-task|
|FINAL-1116|`apps/db-ops-api/src/platform/platform-observation-service.ts:36`|rejected|observeQueue 失败后保留 quality=unknown、QUEUE_STORE_UNAVAILABLE；不是伪装零积压。详细日志不足可 backlog，不自动构成 System 业务阻塞。|T09；修复 PR 尚无|clear / backlog|
|FINAL-1117|`apps/db-ops-api/src/platform/platform-observation-service.ts:38`|confirmed|顶层 logs.query 传 from/to，components 循环只传 component；查询窗口确定不一致。T09 内修复，不影响不消费该摘要的事务基线。|T09；修复 PR 尚无|pending / related-task|
|FINAL-1118|`apps/db-ops-api/src/platform/runtime-events.ts:7`|confirmed|runtime-events 对 candidate.reject 之外均标 ok；turn-loop 的非 completed terminal 可落该分支。T09 持久事件摄入前按具体结果映射，取消不可简单等同 failed。|T09；修复 PR 尚无|blocked / related-task|
|FINAL-1119|`apps/db-ops-api/src/platform/source-error-codes.ts:3`|needs-evidence|源码敏感 warning 不再抛出，候选对其生产失败传播的前提过时；SOURCE_DEPLOYMENT_UNKNOWN/TREE_MISMATCH 等映射仍需逐个 inspect 调用验证。不得重做已合并 MAX-139 错误整改。|T09；修复 PR 尚无|pending / related-task|
|FINAL-1120|`apps/db-ops-api/src/platform/source-error-codes.ts:17`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T09；修复 PR 尚无|pending / related-task|
|FINAL-1121|`apps/db-ops-api/src/platform/source-management-service.ts:37`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T09；修复 PR 尚无|pending / related-task|
|FINAL-1122|`apps/db-ops-api/src/platform/source-management-service.ts:243`|needs-evidence|代码风格/类型或配置建议，尚未给出可达的错误结果；更新后的 AGENTS 没有全仓改写或机械替换要求。除触达后证实契约错误外，留独立 backlog，不作为准入 blocker。|T09；修复 PR 尚无|pending / backlog|
|FINAL-1123|`apps/db-ops-api/src/platform/source-management-service.ts:251`|needs-evidence|代码风格/类型或配置建议，尚未给出可达的错误结果；更新后的 AGENTS 没有全仓改写或机械替换要求。除触达后证实契约错误外，留独立 backlog，不作为准入 blocker。|T09；修复 PR 尚无|pending / backlog|
|FINAL-1124|`apps/db-ops-api/src/platform/source-policy.ts:6`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T09；修复 PR 尚无|pending / related-task|
|FINAL-1125|`apps/db-ops-api/src/platform/source-routes.ts:8`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T09；修复 PR 尚无|pending / related-task|
|FINAL-1126|`apps/db-ops-api/src/platform/source-routes.ts:25`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T09；修复 PR 尚无|pending / related-task|
|FINAL-1127|`apps/db-ops-api/src/platform/source-snapshot-service.ts:116`|confirmed|publish 先在临时目录写输入文件，再 wx 写 manifest.json，根级同名输入冲突；T09 若纳入此路径，补同名发布复现并裁定保留文件名。|T09；修复 PR 尚无|pending / related-task|
|FINAL-1128|`apps/db-ops-api/src/platform/source-snapshot-service.ts:138`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T09；修复 PR 尚无|pending / related-task|
|FINAL-1129|`apps/db-ops-api/src/platform/source-snapshot-service.ts:182`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T09；修复 PR 尚无|pending / related-task|
|FINAL-1130|`apps/db-ops-api/src/platform/structured-log-evidence-adapter.ts:28`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T09；修复 PR 尚无|pending / related-task|
|FINAL-1131|`apps/db-ops-api/src/platform/structured-log-evidence-adapter.ts:32`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T09；修复 PR 尚无|pending / related-task|
|FINAL-1132|`apps/db-ops-api/src/platform/structured-log-evidence-adapter.ts:41`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T09；修复 PR 尚无|pending / related-task|
|FINAL-1133|`apps/db-ops-api/src/platform/structured-log-evidence-adapter.ts:42`|needs-evidence|代码风格/类型或配置建议，尚未给出可达的错误结果；更新后的 AGENTS 没有全仓改写或机械替换要求。除触达后证实契约错误外，留独立 backlog，不作为准入 blocker。|T09；修复 PR 尚无|pending / backlog|
|FINAL-1134|`apps/db-ops-api/src/platform/structured-log-evidence-adapter.ts:44`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T09；修复 PR 尚无|pending / related-task|
|FINAL-1135|`apps/db-ops-api/src/platform/structured-log-evidence-adapter.ts:78`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T09；修复 PR 尚无|pending / related-task|
|FINAL-1401|`apps/db-ops-api/src/workflows/outbox-service.ts:22`|needs-evidence|代码风格/类型或配置建议，尚未给出可达的错误结果；更新后的 AGENTS 没有全仓改写或机械替换要求。除触达后证实契约错误外，留独立 backlog，不作为准入 blocker。|T02, T07；修复 PR 尚无|pending / backlog|
|FINAL-1410|`apps/db-ops-api/src/workflows/worker-runtime.ts:129`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T04；修复 PR 尚无|pending / related-task|
|FINAL-1411|`apps/db-ops-api/src/workflows/worker-runtime.ts:198`|rejected|WorkerRuntime 有 heartbeat 超时、leaseLost/abort，pendingRenewal 隔离避免不可取消 SQL 查询堆积；现有 hung heartbeat 测试明确只在原请求 settle 后继续。拒绝“无超时”描述；数据库永久挂起的运维恢复待 T12。|T04；修复 PR 尚无|clear / no-fix|
|FINAL-1773|`frontend/src/app/ui/control-ui-contract.ts:3`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T06；修复 PR 尚无|pending / related-task|
|FINAL-1774|`frontend/src/app/ui/control-ui-contract.ts:14`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T06；修复 PR 尚无|pending / related-task|
|FINAL-1802|`frontend/src/app/ui/embed-sandbox.ts:11`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T06；修复 PR 尚无|pending / related-task|
|FINAL-1814|`frontend/src/app/ui/navigation.ts:109`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T06；修复 PR 尚无|pending / related-task|
|FINAL-1815|`frontend/src/app/ui/navigation.ts:114`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T06；修复 PR 尚无|pending / related-task|
|FINAL-1816|`frontend/src/app/ui/navigation.ts:197`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T06；修复 PR 尚无|pending / related-task|
|FINAL-1817|`frontend/src/app/ui/navigation.ts:225`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T06；修复 PR 尚无|pending / related-task|
|FINAL-1914|`frontend/src/app/ui/views/chat.ts:394`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T06；修复 PR 尚无|pending / related-task|
|FINAL-1915|`frontend/src/app/ui/views/chat.ts:665`|needs-evidence|代码风格/类型或配置建议，尚未给出可达的错误结果；更新后的 AGENTS 没有全仓改写或机械替换要求。除触达后证实契约错误外，留独立 backlog，不作为准入 blocker。|T06；修复 PR 尚无|pending / backlog|
|FINAL-1916|`frontend/src/app/ui/views/chat.ts:736`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T06；修复 PR 尚无|pending / related-task|
|FINAL-1917|`frontend/src/app/ui/views/chat.ts:1113`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T06；修复 PR 尚无|pending / related-task|
|FINAL-2383 / PARTIAL-0952|`apps/db-ops-api/src/adapter/agent-run-service.ts:132`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T04；修复 PR 尚无|pending / related-task|
|FINAL-2384 / PARTIAL-0953|`apps/db-ops-api/src/adapter/agent-run-service.ts:161`|confirmed|finish(false,0) 的 SQL 绑定均为 NULL，executor 复现；是值丢失，不等于已确认生产失败信息损坏。T04 明确非成功 result/error 契约。|T04；修复 PR 尚无|pending / related-task|
|FINAL-2385 / PARTIAL-0954|`apps/db-ops-api/src/adapter/agent-run-service.ts:182`|confirmed|cancel UPDATE 不清 completionPending，且 pendingCompletions 只查 running；取消与 staged success 竞态必须明确唯一终态优先级。静态窗口成立，真实事务竞争测试未完成。T04 修复/裁定后才能接取消。|T04；修复 PR 尚无|blocked / related-task|
|FINAL-2387 / PARTIAL-0956|`apps/db-ops-api/src/adapter/canonical-store.ts:52`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T05；修复 PR 尚无|pending / related-task|
|FINAL-2388 / PARTIAL-0957|`apps/db-ops-api/src/adapter/canonical-store.ts:68`|needs-evidence|代码风格/类型或配置建议，尚未给出可达的错误结果；更新后的 AGENTS 没有全仓改写或机械替换要求。除触达后证实契约错误外，留独立 backlog，不作为准入 blocker。|T05；修复 PR 尚无|pending / backlog|
|FINAL-2389 / PARTIAL-0958|`apps/db-ops-api/src/adapter/canonical-store.ts:104`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T05；修复 PR 尚无|pending / related-task|
|FINAL-2392 / PARTIAL-0961|`apps/db-ops-api/src/adapter/display-stream.ts:23`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T05；修复 PR 尚无|pending / related-task|
|FINAL-2393 / PARTIAL-0962|`apps/db-ops-api/src/adapter/display-stream.ts:258`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T05；修复 PR 尚无|pending / related-task|
|FINAL-2401 / PARTIAL-0972|`apps/db-ops-api/src/adapter/message-projection.ts:15`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T05；修复 PR 尚无|pending / related-task|
|FINAL-2402 / PARTIAL-0974|`apps/db-ops-api/src/adapter/message-projection.ts:70`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T05；修复 PR 尚无|pending / related-task|
|FINAL-2403 / PARTIAL-0975|`apps/db-ops-api/src/adapter/message-projection.ts:83`|needs-evidence|代码风格/类型或配置建议，尚未给出可达的错误结果；更新后的 AGENTS 没有全仓改写或机械替换要求。除触达后证实契约错误外，留独立 backlog，不作为准入 blocker。|T05；修复 PR 尚无|pending / backlog|
|FINAL-2432 / PARTIAL-1011|`apps/db-ops-api/src/alert-database-service.ts:307`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T07, T08, T10；修复 PR 尚无|pending / related-task|
|FINAL-2433 / PARTIAL-1013|`apps/db-ops-api/src/alert-engine.ts:32`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T07, T08, T10；修复 PR 尚无|pending / related-task|
|FINAL-2442 / PARTIAL-1032|`apps/db-ops-api/src/analysis/analysis-dispatch-handler.ts:37`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T08；修复 PR 尚无|pending / related-task|
|FINAL-2443 / PARTIAL-1033|`apps/db-ops-api/src/analysis/analysis-dispatch-store.ts:44`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T08；修复 PR 尚无|pending / related-task|
|FINAL-2444 / PARTIAL-1034|`apps/db-ops-api/src/analysis/analysis-dispatch-store.ts:74`|rejected|同事务先 INSERT/UPSERT dispatch key 再 SELECT FOR UPDATE 保证存在；候选依赖未来移除不变量，不是当前缺陷。|T08；修复 PR 尚无|clear / no-fix|
|FINAL-2445 / PARTIAL-1035|`apps/db-ops-api/src/analysis/analysis-dispatch-store.ts:77`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T08；修复 PR 尚无|pending / related-task|
|FINAL-2446 / PARTIAL-1036|`apps/db-ops-api/src/analysis/analysis-dispatch-store.ts:80`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T08；修复 PR 尚无|pending / related-task|
|FINAL-2447 / PARTIAL-1037|`apps/db-ops-api/src/analysis/analysis-dispatch-store.ts:177`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T08；修复 PR 尚无|pending / related-task|
|FINAL-2450 / PARTIAL-1042|`apps/db-ops-api/src/analysis/analysis-evidence.ts:31`|needs-evidence|代码风格/类型或配置建议，尚未给出可达的错误结果；更新后的 AGENTS 没有全仓改写或机械替换要求。除触达后证实契约错误外，留独立 backlog，不作为准入 blocker。|T08；修复 PR 尚无|pending / backlog|
|FINAL-2451 / PARTIAL-1043|`apps/db-ops-api/src/analysis/analysis-evidence.ts:95`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T08；修复 PR 尚无|pending / related-task|
|FINAL-2454 / PARTIAL-1046|`apps/db-ops-api/src/analysis/analysis-identity.ts:26`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T08；修复 PR 尚无|pending / related-task|
|FINAL-2480 / PARTIAL-1075|`apps/db-ops-api/src/auth/actor-context.ts:86`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T03；修复 PR 尚无|pending / related-task|
|FINAL-2487 / PARTIAL-1083|`apps/db-ops-api/src/auth/require-permission.ts:15`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T03；修复 PR 尚无|pending / related-task|
|FINAL-2488 / PARTIAL-1084|`apps/db-ops-api/src/auth/require-permission.ts:45`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T03；修复 PR 尚无|pending / related-task|
|FINAL-2501 / PARTIAL-1100|`apps/db-ops-api/src/chat-database-service.ts:286`|needs-evidence|代码风格/类型或配置建议，尚未给出可达的错误结果；更新后的 AGENTS 没有全仓改写或机械替换要求。除触达后证实契约错误外，留独立 backlog，不作为准入 blocker。|T03；修复 PR 尚无|pending / backlog|
|FINAL-2502 / PARTIAL-1101|`apps/db-ops-api/src/chat-database-service.ts:306`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T03；修复 PR 尚无|pending / related-task|
|FINAL-2503 / PARTIAL-1102|`apps/db-ops-api/src/chat-database-service.ts:420`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T03；修复 PR 尚无|pending / related-task|
|FINAL-2504 / PARTIAL-1104|`apps/db-ops-api/src/chat-database-service.ts:538`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T03；修复 PR 尚无|pending / related-task|
|FINAL-2592|`apps/db-ops-api/src/event-aggregator.ts:86`|needs-evidence|代码风格/类型或配置建议，尚未给出可达的错误结果；更新后的 AGENTS 没有全仓改写或机械替换要求。除触达后证实契约错误外，留独立 backlog，不作为准入 blocker。|T07, T08, T10；修复 PR 尚无|pending / backlog|
|FINAL-2593|`apps/db-ops-api/src/event-aggregator.ts:230`|needs-evidence|代码风格/类型或配置建议，尚未给出可达的错误结果；更新后的 AGENTS 没有全仓改写或机械替换要求。除触达后证实契约错误外，留独立 backlog，不作为准入 blocker。|T07, T08, T10；修复 PR 尚无|pending / backlog|
|FINAL-2645|`apps/db-ops-api/src/lifecycle/worker-lease.ts:9`|needs-evidence|代码风格/类型或配置建议，尚未给出可达的错误结果；更新后的 AGENTS 没有全仓改写或机械替换要求。除触达后证实契约错误外，留独立 backlog，不作为准入 blocker。|T04；修复 PR 尚无|pending / backlog|
|FINAL-2781|`apps/db-ops-api/src/platform/deployment-binding.ts:23`|needs-evidence|代码风格/类型或配置建议，尚未给出可达的错误结果；更新后的 AGENTS 没有全仓改写或机械替换要求。除触达后证实契约错误外，留独立 backlog，不作为准入 blocker。|T09；修复 PR 尚无|pending / backlog|
|FINAL-2782|`apps/db-ops-api/src/platform/git-source-connector.ts:76`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T09；修复 PR 尚无|pending / related-task|
|FINAL-2783|`apps/db-ops-api/src/platform/git-source-connector.ts:79`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T09；修复 PR 尚无|pending / related-task|
|FINAL-2784|`apps/db-ops-api/src/platform/git-source-connector.ts:126`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T09；修复 PR 尚无|pending / related-task|
|FINAL-2785|`apps/db-ops-api/src/platform/github-source-connector.ts:83`|rejected|该 REST connector 已标 deprecated；SourceManagementService.sync 生产只实例化 GitSourceConnector。候选的 archive/symlink/GHE/资源限制问题属于未启用路径，不能阻塞当前 V1；若未来启用须先有独立安全修复。|T09；修复 PR 尚无|clear / backlog|
|FINAL-2786|`apps/db-ops-api/src/platform/platform-observation-service.ts:15`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T09；修复 PR 尚无|pending / related-task|
|FINAL-2787|`apps/db-ops-api/src/platform/source-management-service.ts:26`|needs-evidence|代码风格/类型或配置建议，尚未给出可达的错误结果；更新后的 AGENTS 没有全仓改写或机械替换要求。除触达后证实契约错误外，留独立 backlog，不作为准入 blocker。|T09；修复 PR 尚无|pending / backlog|
|FINAL-2788|`apps/db-ops-api/src/platform/source-management-service.ts:79`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T09；修复 PR 尚无|pending / related-task|
|FINAL-2789|`apps/db-ops-api/src/platform/source-policy.ts:12`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T09；修复 PR 尚无|pending / related-task|
|FINAL-2790|`apps/db-ops-api/src/platform/source-policy.ts:13`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T09；修复 PR 尚无|pending / related-task|
|FINAL-2791|`apps/db-ops-api/src/platform/source-repository-path.ts:3`|needs-evidence|代码风格/类型或配置建议，尚未给出可达的错误结果；更新后的 AGENTS 没有全仓改写或机械替换要求。除触达后证实契约错误外，留独立 backlog，不作为准入 blocker。|T09；修复 PR 尚无|pending / backlog|
|FINAL-2792|`apps/db-ops-api/src/platform/source-repository-path.ts:4`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T09；修复 PR 尚无|pending / related-task|
|FINAL-2793|`apps/db-ops-api/src/platform/source-repository-path.ts:5`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T09；修复 PR 尚无|pending / related-task|
|FINAL-2794|`apps/db-ops-api/src/platform/source-snapshot-service.ts:24`|rejected|MAX_FILE_BYTES=MAX_SNAPSHOT_BYTES 有显式注释：单文本可用整个预算，512KiB 是 advisory；不是失效限制。|T09；修复 PR 尚无|clear / no-fix|
|FINAL-2795|`apps/db-ops-api/src/platform/source-snapshot-service.ts:103`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T09；修复 PR 尚无|pending / related-task|
|FINAL-2796|`apps/db-ops-api/src/platform/source-snapshot-service.ts:124`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T09；修复 PR 尚无|pending / related-task|
|FINAL-2797|`apps/db-ops-api/src/platform/source-snapshot-service.ts:147`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T09；修复 PR 尚无|pending / related-task|
|FINAL-2798|`apps/db-ops-api/src/platform/structured-log-evidence-adapter.ts:31`|needs-evidence|代码风格/类型或配置建议，尚未给出可达的错误结果；更新后的 AGENTS 没有全仓改写或机械替换要求。除触达后证实契约错误外，留独立 backlog，不作为准入 blocker。|T09；修复 PR 尚无|pending / backlog|
|FINAL-3031|`apps/db-ops-api/src/workflows/worker-runtime.ts:28`|needs-evidence|代码风格/类型或配置建议，尚未给出可达的错误结果；更新后的 AGENTS 没有全仓改写或机械替换要求。除触达后证实契约错误外，留独立 backlog，不作为准入 blocker。|T04；修复 PR 尚无|pending / backlog|
|FINAL-3032|`apps/db-ops-api/src/workflows/worker-runtime.ts:53`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T04；修复 PR 尚无|pending / related-task|
|FINAL-3033|`apps/db-ops-api/src/workflows/worker-runtime.ts:83`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T04；修复 PR 尚无|pending / related-task|
|FINAL-3034|`apps/db-ops-api/src/workflows/worker-runtime.ts:187`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T04；修复 PR 尚无|pending / related-task|
|FINAL-3446|`frontend/src/app/ui/components/chat-message-list.ts:26`|rejected|components/chat-message-list.ts 未被生产 frontend/src 引用；现用 views/chat.ts 的正则定义在 while 外。候选所说在用 Chat 卡死不成立；未使用组件自身循环/请求风险归独立 backlog，禁止 T06 直接启用。|T06；修复 PR 尚无|clear / backlog|
|FINAL-3447|`frontend/src/app/ui/components/chat-message-list.ts:137`|rejected|components/chat-message-list.ts 未被生产 frontend/src 引用；现用 views/chat.ts 的正则定义在 while 外。候选所说在用 Chat 卡死不成立；未使用组件自身循环/请求风险归独立 backlog，禁止 T06 直接启用。|T06；修复 PR 尚无|clear / backlog|
|FINAL-3475|`frontend/src/app/ui/control-ui-contract.ts:1`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T06；修复 PR 尚无|pending / related-task|
|FINAL-3476|`frontend/src/app/ui/control-ui-contract.ts:13`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T06；修复 PR 尚无|pending / related-task|
|FINAL-3477|`frontend/src/app/ui/controllers/chat.ts:362`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T06；修复 PR 尚无|pending / related-task|
|FINAL-3478|`frontend/src/app/ui/controllers/chat.ts:365`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T06；修复 PR 尚无|pending / related-task|
|FINAL-3479|`frontend/src/app/ui/controllers/chat.ts:465`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T06；修复 PR 尚无|pending / related-task|
|FINAL-3497|`frontend/src/app/ui/embed-sandbox.ts:5`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T06；修复 PR 尚无|pending / related-task|
|FINAL-3508|`frontend/src/app/ui/navigation.ts:189`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T06；修复 PR 尚无|pending / related-task|
|FINAL-3594|`frontend/src/app/ui/views/chat.ts:326`|needs-evidence|代码风格/类型或配置建议，尚未给出可达的错误结果；更新后的 AGENTS 没有全仓改写或机械替换要求。除触达后证实契约错误外，留独立 backlog，不作为准入 blocker。|T06；修复 PR 尚无|pending / backlog|
|FINAL-3595|`frontend/src/app/ui/views/chat.ts:583`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T06；修复 PR 尚无|pending / related-task|
|FINAL-3596|`frontend/src/app/ui/views/chat.ts:1409`|needs-evidence|代码风格/类型或配置建议，尚未给出可达的错误结果；更新后的 AGENTS 没有全仓改写或机械替换要求。除触达后证实契约错误外，留独立 backlog，不作为准入 blocker。|T06；修复 PR 尚无|pending / backlog|
|FINAL-3597|`frontend/src/app/ui/views/chat.ts:2106`|needs-evidence|已对齐当前行段；需沿本条候选所列触发条件核对调用方保护及输入可达性，补专项复现。现有模块单测通过不证明此候选成立或被排除。|T06；修复 PR 尚无|pending / related-task|
|PARTIAL-0012|`apps/db-ops-api/src/analysis/analysis-identity.ts:40`|rejected|actor 可选用于内部自动维护，外部路由仍 verifyToken；未给出无需认证的 HTTP/WS 可达链。T03 不得将该 legacy system 分支用于新服务主体。|T08；修复 PR 尚无|clear / no-fix|
|PARTIAL-0080|`apps/db-ops-api/src/adapter/direct-adapter.ts:575`|needs-evidence|与 FINAL-0083 同一问题族，沿用该项尚缺的触发/真实数据库证据，源位置不同不冒充同一候选。|T04；修复 PR 尚无|pending / related-task|
|PARTIAL-0081|`apps/db-ops-api/src/adapter/direct-adapter.ts:672`|needs-evidence|与 FINAL-0083 同一问题族，沿用该项尚缺的触发/真实数据库证据，源位置不同不冒充同一候选。|T04；修复 PR 尚无|pending / related-task|
|PARTIAL-0103|`apps/db-ops-api/src/alert-engine.ts:50`|needs-evidence|与 FINAL-0657 同一问题族，沿用该项尚缺的触发/真实数据库证据，源位置不同不冒充同一候选。|T08；修复 PR 尚无|pending / related-task|
|PARTIAL-0104|`apps/db-ops-api/src/alert-engine.ts:240`|needs-evidence|与 FINAL-0657 同一问题族，沿用该项尚缺的触发/真实数据库证据，源位置不同不冒充同一候选。|T08；修复 PR 尚无|pending / related-task|
|PARTIAL-0115|`apps/db-ops-api/src/analysis/analysis-identity.ts:39`|needs-evidence|阶段快照独有位置未在最终报告独立保留；源码仍有该行段，候选减少不等于修复。需检查当前输入与调用方保护，领域保持 pending。|T08；修复 PR 尚无|pending / related-task|
|PARTIAL-0465|`apps/db-ops-api/src/alert-database-service.ts:555`|needs-evidence|与 FINAL-0658 同一问题族，沿用该项尚缺的触发/真实数据库证据，源位置不同不冒充同一候选。|T08；修复 PR 尚无|pending / related-task|
|PARTIAL-0468|`apps/db-ops-api/src/alert-engine.ts:268`|needs-evidence|阶段快照独有位置未在最终报告独立保留；源码仍有该行段，候选减少不等于修复。需检查当前输入与调用方保护，领域保持 pending。|T08；修复 PR 尚无|pending / related-task|
|PARTIAL-0543|`apps/db-ops-api/src/auth/require-instance-access.ts:75`|needs-evidence|阶段快照独有位置未在最终报告独立保留；源码仍有该行段，候选减少不等于修复。需检查当前输入与调用方保护，领域保持 pending。|T03；修复 PR 尚无|pending / related-task|
|PARTIAL-0545|`apps/db-ops-api/src/auth/require-permission.ts:16`|needs-evidence|阶段快照独有位置未在最终报告独立保留；源码仍有该行段，候选减少不等于修复。需检查当前输入与调用方保护，领域保持 pending。 风格/死导入/类型建议不自动阻塞 V1。|T03；修复 PR 尚无|pending / backlog|
|PARTIAL-0565|`apps/db-ops-api/src/chat-database-service.ts:363`|needs-evidence|与 FINAL-0743 同一问题族，沿用该项尚缺的触发/真实数据库证据，源位置不同不冒充同一候选。|T03；修复 PR 尚无|pending / related-task|
|PARTIAL-0973|`apps/db-ops-api/src/adapter/message-projection.ts:31`|needs-evidence|与 FINAL-2403 同一问题族，沿用该项尚缺的触发/真实数据库证据，源位置不同不冒充同一候选。 风格/死导入/类型建议不自动阻塞 V1。|T05；修复 PR 尚无|pending / backlog|
|PARTIAL-1012|`apps/db-ops-api/src/alert-engine.ts:8`|needs-evidence|阶段快照独有位置未在最终报告独立保留；源码仍有该行段，候选减少不等于修复。需检查当前输入与调用方保护，领域保持 pending。 风格/死导入/类型建议不自动阻塞 V1。|T08；修复 PR 尚无|pending / backlog|
|PARTIAL-1038|`apps/db-ops-api/src/analysis/analysis-dispatch-store.ts:239`|needs-evidence|阶段快照独有位置未在最终报告独立保留；源码仍有该行段，候选减少不等于修复。需检查当前输入与调用方保护，领域保持 pending。 风格/死导入/类型建议不自动阻塞 V1。|T08；修复 PR 尚无|pending / backlog|
|PARTIAL-1074|`apps/db-ops-api/src/auth/actor-context.ts:29`|needs-evidence|阶段快照独有位置未在最终报告独立保留；源码仍有该行段，候选减少不等于修复。需检查当前输入与调用方保护，领域保持 pending。 风格/死导入/类型建议不自动阻塞 V1。|T03；修复 PR 尚无|pending / backlog|
|PARTIAL-1082|`apps/db-ops-api/src/auth/require-instance-access.ts:64`|needs-evidence|阶段快照独有位置未在最终报告独立保留；源码仍有该行段，候选减少不等于修复。需检查当前输入与调用方保护，领域保持 pending。 风格/死导入/类型建议不自动阻塞 V1。|T03；修复 PR 尚无|pending / backlog|
|PARTIAL-1103|`apps/db-ops-api/src/chat-database-service.ts:511`|needs-evidence|阶段快照独有位置未在最终报告独立保留；源码仍有该行段，候选减少不等于修复。需检查当前输入与调用方保护，领域保持 pending。|T03；修复 PR 尚无|pending / related-task|
