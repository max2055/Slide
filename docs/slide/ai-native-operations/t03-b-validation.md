# T03-B：Profile、实时授权与调查 Session 桥接

2026-10-12，MAX-144，产品 V1.1 / 调度 v1.2。本阶段交付后仍须等待 T02-C，完整 T03-C 尚未交付。

## 基线、范围及有界 Review

从最新 `origin/main` `915ec9b447aacae1f143e6b4262d4d9f5e8a85fe` 建立独立 `codex/MAX-144-session-bridge` worktree。复用 T03-A / #147 与 T02-B / #146；其 PR、当前 head CI、真实验收和 merge 证据已由 MAX-140 准入。原 Review 基线 `fb0766d606c9f07448a5eddac2a6657847d90830` 的差异仅按触达能力复核，不重新开展全仓 Review。

实现仓库版本化 ops/system Profile、受限 numeric 服务主体、实时调查授权、同事务 request 消息追加、普通 Chat 转换与关联会话读取保护。没有修改 store 生产代码、迁移、调查 HTTP/server 注册、DirectAdapter、executor、watch、canonical store、证据或前端。T02 升级测试仅补齐真实 actor/资源夹具；Analysis/Cron 手写用户夹具仅补齐正式 schema 已有的 password_hash 列，验证共享身份加载兼容；没有改 schema/store 或 Analysis/Cron 业务所有权。

本轮内联有界审查覆盖：真实主体/status/sessionVersion；服务禁密码/JWT/refresh/admin；owner/member ACL 与过期；全部资源、调用方与冻结上限；只读安全目录、Profile 和 live policy 交集；权限失败不泄露版本/计数；事务锁序、幂等消息 ID、统计和整体回滚；普通 Chat 与 maintenance 边界。未发现本阶段未处理阻塞。仅确认当前模块能力，不授予 auth/session 整域 clear；无子代理或人工批准声明。

审查中补了两个实际必要的边界：关联会话的旧 Chat 读接口不能仅凭 owner/read-share 绕过调查撤权；已有显式实例 grant 的 request 不能因后续 admin 晋升而在该 grant 撤销后继续执行。后者保存原始全局实例授权来源，冻结快照与后续 live grant 交集，保留原来合法的用户 admin 全局权限语义；服务主体始终无该旁路。

## 可供后续阶段消费的接口

### Profile 与身份

- `profiles.ts` 是服务器仓库配置，ops/system v1 使用已有 `fault_diagnosis` scene、固定 prompt 内容/hash、空 skills 集合、readonly allowlist、schema v2、中文输出和保守预算（120s、20 tools、8 provider attempts、32k tokens、200 rows、128k bytes、1h window）。未知 id/version 失败关闭；不允许客户端/模型提交 prompt 或 tools。
- Profile 配置及容器冻结，内容 hash 存入 request authority；未宣称目录 allowlist 已完成工具参数、SQL readonly、源码部署匹配和脱敏执行验收。这些是 T04/T09 的门禁。EXPLAIN/slow SQL 等工具不因产品描述而自动放行；目录没有安全只读定义就拒绝。
- `provisionInvestigationServiceIdentity(connection, name)` 为显式可信配置动作，使用现有 users 列创建真实 numeric ID。保留账户名前缀 `slide-investigation-` 与不可用密码标记必须同时符合服务加载规则；任一标记都禁止交互身份加载/密码登录。没有生产自动建号、服务默认 admin、userId=0 或新迁移。
- 配置者另行授予**精确现有 permission codes / 有效期 / instance_permissions**。服务加载只接受七项现有只读 permission codes，拒绝 admin、任意 wildcard 及显式写权限。Policy/executor 必须固定 numeric service ID、精确 permission ceiling 和明确三类 resourceBoundary；不能由事件、请求或模型选择主体。只提供受控配置端口，尚未运行自动策略或部署生产服务账户。
- `loadInvestigationActorFrom` 在传入 transaction connection 上执行 current read；读取状态、sessionVersion、未过期 roles/permissions/instance grants。普通 access JWT、token signing、refresh issuance/rotation均不能用于服务主体。停用或 sessionVersion 变化立即失效。

### 实时授权、内容及工具

- `InvestigationAuthorization.forActor(verifiedActor)` 绑定并复制调用方上限，作为 store 的服务器授权回调。store command 中的 kind/id 必须完全相同。这里的 ActorContext 来自服务器认证/配置，不能从请求 body 或 JWT 任意自定义字段构造。
- 所有 read/create/patch/admit 调用实时授权；owner 或未过期 investigation member 才可见，普通 Chat share 不是调查 ACL。成员 viewer 只读，operator/owner 可以 continue/cancel；用户 admin 也不能凭权限读取无 ACL 的服务调查。继续自动调查不改变 service Session owner，新 request 冻结访问者自己的主体。
- 可见性需 chat:view、System 的 config:view、全部 required resource read permissions、实例 live grant、资源存活与调用方 boundary。任一缺失时标题/目标/消息/列表计数整体隐藏。存在但仅 viewer 的变更操作为 403；不可见为 404；SQL/授权基础设施异常不伪装成零计数。
- `authorize(connection, caller, investigation, 'content'|'watch', contentResources)` 是 T04/T05 发送模型上下文、证据/派生摘要/缓存/WS 的统一实时门禁。contentResources 必须来自可信持久内容 scope，额外 scope 也需全量通过。旧缓存成功不替代新调用。此阶段没有证据/watch/browser 模块，未来所有发送端及旧无 scope 证据的保守处理须在 T05/T06/T12 验收。
- `freeze` 将 actor/sessionVersion、有效 exact permissions、三类资源上限、实例授权来源、investigation/session/scopeVersion、Profile 内容 hash、工具交集存入 `request_snapshot.authority`。后续 `authorizeTool` 同时验证这些冻结字段和 live grants/policy，阻止扩权、越界目标、其他 Profile、secret/write/execute/internal 工具。下游 actor 去掉 admin username/roles/wildcards，只有 exact permissions 和 read-only instance scopes。
- 工具 policy 回调由可信 executor 注入，每次调用实时读取；默认只使用当前服务器安全目录。T04 必须接入其实际工具策略、可信目标解析、参数限额及审计执行，不把此模块的授权通过等同于工具执行完成。已有全局 policy 扩张也不能扩大旧 snapshot allowlist。
- `requestAuthority` 只供**原 request 主体**执行重校验并返回冻结快照。访问者 read/watch 应校验自己的 content/watch 授权，不能继承原服务主体 authority；进入 Workspace 不改变运行主体。

### Session / admission 原子桥接

- `InvestigationSessionBridge.create(actor, command, firstRequest?)` 复用 `createInTransaction/admitInTransaction`，创建/转换/可选首次 admission 一个事务；普通转换复用原 session_id/message ID，不复制历史。原 Chat 非 owner read share 或活动 Run 不可转换。
- `admit` 复用 store 的唯一 queue owner，在 `isNew` 时才冻结 authority，并调用 `ChatDatabaseService.appendInvestigationMessage`。窄入口校验调查/Session/request/acceptedVersion/active request、actor 与原始 message，追加规范 user Message Parts、绑定 request.message_id、更新统计。两次 UPDATE 各必须影响一行；任何失败整体回滚。重试同键只返回原 acceptance，不再次追加或入队。
- T02-C 的 continue/create-with-request 必须使用这个桥接，不能绕过到裸 store.admit 或 maintenance append。**POST create 的重试解析归 T02-C**：在分配新调查前按原客户端命令/key 找回原 investigationId；不能每次创建新调查后靠 admission 去重。
- 普通未关联 Chat 的 owner/read-share API 合同保留；关联会话读/history/count/watch 重校验调查权限，旧 share 不升级。关联会话普通 append/patch/share/cap/delete 不能绕过调查窄入口。maintenance 不开放给外部入口；已有归档升级回退读取仍需当前授权。
- `messages` 在同连接锁与内容授权后读取，复用既有 Message Parts 标准化。新 request 的内容来自冻结命令；历史转换不编造证据 scope。未来 evidence/result/history 模型重放须走前述可信 content scope 端口及 T05 的保守历史规则。

## 当前代码验证证据

真实环境：脚本新建并退出清理的临时 `mysql:8.4`，独立随机 schema、正式 MigrationRunner、真实 users/roles/grants/member/Session/request/job/outbox、真实签名 JWT + Fastify 测试入口。入口只是验证 harness，生产调查 HTTP 由 T02-C owner 实施。没有生产数据库、模型调用或新增付费设施。

```bash
bash scripts/qualification/run-auth-boundary.sh
bash scripts/qualification/run-report-recovery.sh
bash scripts/qualification/run-analysis-recovery.sh
pnpm --filter slide-api exec vitest run src/auth/chat-ownership.test.ts \
  src/auth/chat-routes.test.ts src/auth/chat-handler-ownership.test.ts \
  src/chat-history-page.test.ts src/investigations/authorization.test.ts
pnpm security:test
pnpm --filter slide-api test
pnpm --filter slide-api typecheck
pnpm contracts:check
pnpm exec oxlint apps/db-ops-api/src/investigations \
  apps/db-ops-api/src/auth/actor-context.ts apps/db-ops-api/src/auth-database-service.ts \
  apps/db-ops-api/src/chat-database-service.ts
git diff --check
```

- 授权 qualification：**6 文件、113 项通过、0 skip**；其中 T03-B 真 SQL/JWT 24 项、既有实例 MySQL 8 项实际执行。脚本已接入既有 CI auth gate，默认测试的 skip 不替代该实际执行。
- 正式 store/report/outbox SQL 回归：**3 文件、64 项通过、0 skip**；含 T02 升级/回退与事务回归。生产 store/迁移未改变，后续仅 Chat 窄入口的写入返回值校验变化由真实 bridge SQL gate覆盖。
- CI 相关兼容补证：Analysis 真实恢复/provider **2 文件、41 项通过、0 skip**；Cron 真实 SQL/授权 **1 文件、28 项通过、0 skip**，新建临时 MySQL 专门运行 `src/cron/cron-mysql.integration.test.ts`，容器退出清理。只修改两处手写 users fixture，不削弱生产身份校验。
- Chat compatibility/Profile focused：5 文件、35 项通过、0 skip；新增一项服务写权限负例后由授权专项及后端全量覆盖。
- 安全门禁：35 文件、334 项通过、0 skip。后端全量：329 文件通过、33 文件跳过，3161 项通过 / 335 跳过；默认未配置其他外部环境，不宣称这些 skip 通过。
- 后端 typecheck、公共 contracts check、focused lint 和 diff 检查通过。focused lint 仅3条既有 warning（auth-database-service 两个未使用 import，actor-context 的 Boolean），无 error；未顺手整改。

|验收|当前真实证据|
|---|---|
|100同键|返回同一 acceptance，message/request/job/outbox各一条，message_id与统计一致|
|故障回滚|message INSERT、request UPDATE、Session stats UPDATE三处trigger失败，全部admission/key/job/outbox/message回滚，调查version/活动指针恢复；恢复后可重试|
|创建+首次请求|message失败时新调查/Session也回滚，无孤儿|
|普通转换|原Session、原message ID保留；普通read share不能转换/append；活动Run拒绝；关联后owner也不能走普通append绕过|
|viewer/operator|真实JWT viewer读200，continue/cancel403；operator追问以用户主体执行，Session仍归numeric service|
|服务禁登录|有效签名JWT401；access signing/identity loading/refresh issuance/rotation失败；误配有效bcrypt/改名仍禁登录；加入admin后服务创建失败|
|实时撤权|同JWT grant删除/过期后list total0，detail/message404；原key重试拒绝，普通Chat消息/count/watch也隐藏，无第二message/job|
|全scope|三类caller边界逐个缺失；三类live permission逐个撤销；调查/消息/count/watch权限全隐藏；ACL成员过期同样拒绝|
|冻结交集|Profile工具白名单、permission ceiling、live policy、目标边界；后续admin扩权不能增加旧工具，原显式grant撤销仍拒绝；下游没有admin角色|
|System/content|System不授Ops工具；缺config scope或额外不可见内容scope时拒绝；无ACL的其他admin不能读服务调查|
|停用/会话版本|同JWT401及保留actor404；role expiry使内容不可见|

初轮问题已分类并修复：本次 Profile TypeScript 判别联合表达、mysql2 新版本 executor 类型适配、服务器夹具误用表/列名；旧 Chat mock 缺调查binding查询、旧升级夹具只有userId而缺真实actor/资源。均未改变权限规则来放过测试，当前受影响检查已复跑。

首个 head `21730de540275109cc080c25f505db881b8ca273` 的 CI run `38208820546`：六项通过，recovery-qualification失败，release-artifact因依赖失败跳过。根因是旧 Analysis 手写 users 表没有 password_hash，新增服务身份标记读取在四项真实撤权/恢复测试报 ER_BAD_FIELD_ERROR；正式 users schema 始终有该列。本次相关CI阻塞已通过最小fixture修复及41项真实回归定位关闭；同类已触达Cron actor fixture一起补齐并28项验证。不复用失败head的CI声明新head通过，也不重复无证据重试或修改门禁。新head仍须收集全部CI、正常合并及main包含关系。

## 出口与保留门禁

第二个 head `69f258d73f6ac96c1853322c14645793a8abdd4d` 的 CI run `38209600534`：六项通过，recovery-qualification 在正式 store 的旧库升级用例于 5026ms 超时（默认 5000ms），release-artifact 依赖跳过。该用例创建完整 pre-112 schema，再执行升级、重复启动及应用回退兼容断言；本地新建 MySQL 8.4 实测旧 schema 初始化 2296ms、测试主体 2456ms，相关 64 项通过/0 skip。分类为已触达集成测试的 CI 时限问题，已先在父任务 phase 台账记录有界修复范围：仅此用例设为 30 秒，保留全部真实 SQL 与业务断言，其他用例/门禁默认时限不变，生产 store/迁移和 T02 文件所有权不变。诊断埋点不提交；最终准确代码再次运行同一真实 SQL gate：64 项通过/0 skip；typecheck、focused lint（0 warning/0 error）和 diff 检查通过。新 head 仍必须重新通过全部 CI，旧 head 的六项通过不能代替。

当前 head CI、PR URL、head/merge SHA 和 main包含关系记录于 MAX-144 最终评论及父任务 phase evidence。仅在该 PR 当前检查与正常 merge 核验后释放 T02-C；完整 T03 等 T02-C 合并证据再做 T03-C。本材料不替代未来 provider/executor、WS/证据/浏览器撤权、预算/恢复或 T12 完整端到端门禁。

没有生产发布/迁移，没有新任务/子代理，实际 token/费用遥测不可用，无硬预算。
