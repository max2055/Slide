# T03-D：设置 Profile 只读事实与消费契约

## 范围与接口

MAX-144 T03-D 为 T06/MAX-148 提供 `GET /api/investigation-profiles`。既有 T03-A/B/C 的授权、Session、Chat 合同和交付历史继续有效；本阶段不改变 admission、executor、Run、Session、ledger、schema 或 UI，不调用模型、不操作生产。

使用 Bearer JWT；正式 `createVerifyToken` 每次从 MySQL 重新加载 active 用户、Session version、未过期角色和权限，再经既有 `requirePermission('ai:view')` 校验 AI 设置读取权限。普通 Chat 权限不授权此接口；numeric 服务身份不可交互认证，不能借 admin 角色读取。既有 admin 和权限通配符语义保留。

无查询参数、分页或写方法。认证缺失/失效/用户禁用/Session 撤销为 401；有效主体缺 live `ai:view` 为 403；带查询参数为 400 `INVESTIGATION_INPUT_INVALID`。成功和这些拒绝响应均 `Cache-Control: private, no-store`，不产生 ETag，不发布配置内容之外的主体资料。未注册的写方法为普通 404。

## 返回事实

公开 TypeBox schema：`InvestigationProfilesResponse`。OpenAPI：`docs/slide/openapi.json`；生成消费类型：`frontend/src/api/generated/public-api.ts`。顶层返回 `schemaVersion=1`、`source=repository`、`allowlistSemantics=authority_ceiling` 和 `items`。每项包含完整 `profile` 对象、`profileHash`、`configurationStatus=preset`、`toolAvailability=not_evaluated`、`outputSchemaId=InvestigationResult`。

实际 `items` 固定包含 Ops 和 System 两项，消费者按 `profile.id` 查找，不依赖顺序。`profile` 直接投影 `INVESTIGATION_PROFILES`，包含 id/version、责任、supportedSubjectKinds、modelScene、prompt version/hash、skills version/hash、toolAllowlist、readonly/resourceBoundary、outputSchemaVersion/outputLanguage、全部七项 budget 上限；没有独立复制 Profile 配置。`profileHash` 复用 `investigationProfileHash`，与调查快照的内容绑定一致。严格响应 schema 及显式投影阻止内部新增字段意外发布。

`configurationStatus=preset` 只说明仓库已有版本化预置定义；`toolAvailability=not_evaluated` 如实说明此读取不评估部署工具就绪情况。白名单是权限上限，不能当作全部工具已支持、用户可执行或模型已就绪。实际执行继续取主体、所有资源 scope、Profile、工具策略交集。`modelScene=fault_diagnosis` 是场景引用，不是 Provider/模型/凭据配置副本。`outputSchemaId=InvestigationResult` 与 `profile.outputSchemaVersion=2` 对应同名公开严格 schema，不宣称结果已验证。

预算展示 Profile 的上限，不宣称其等于全局有效额度或已扣费金额；策略/有效预算/用量成本由 T07-C 提供。原始 prompt、用户/服务账户信息、密码/密钥均不返回。skills 为空如实展示，不虚构已加载技能。

## T06 消费与文件交接

T06 设置页使用本端口和生成类型，不硬编码两 Profile 内容。读取遇到 401/403 时清除当前事实并显示拒绝状态；不得用先前缓存继续展示。HTTP no-store 不替代浏览器缓存清除验收。工具与模型就绪若无其他真实来源，使用本接口未评估语义。该端口不提供 Profile 编辑或生产触发。

共享 `server.ts` 与公共 contract/generator 的最小注册由本阶段暂借；本 PR 合并并经父独立核验后交还 T07-C 串行注册。前端 UI、策略/成本端口仍由原 owner 完成。本模块真实 HTTP 验收不替代 T06 浏览器或 T12 完整 V1 gate。

## 本地验收

基线 `origin/main=0a2296ac`，托管起始 `13d0108c` 保留并合入 main；独立交付 PR 只包含本阶段文件，不包含 `.multica`、AGENTS 本地追加或历史工作树差异。

|检查|结果|
|---|---|
|`bash scripts/qualification/run-auth-boundary.sh`|8 文件、171 项通过，0 skip；独立 mysql:8.4、正式 MigrationRunner、真实 JWT/TCP HTTP，容器/测试数据库正常清理|
|新增 `profile-routes.test.ts`|11 项真实 MySQL/JWT/HTTP + 1 项公开契约；授权读、严格投影/脱敏、未登录/坏 JWT、普通 Chat 权限拒绝、同 JWT 撤权/恢复、禁用、Session 撤销、角色删除/过期、admin 兼容、服务身份拒绝、无写方法/拒绝查询|
|原授权模块|instance boundary、require-instance-access、security boundaries、Chat routes、authorization、Session bridge、调查 HTTP 全部通过，原有 Profile 授权与普通 Chat 兼容|
|`pnpm security:test`|35 文件、334 项通过，0 skip|
|`pnpm --filter slide-api exec vitest run src/contracts/public-api.test.ts`|10 项通过|
|前后端 typecheck、contracts:check、security:scan、diff --check|通过|
|lint|全仓 0 errors（263 项既有 warnings）；三个新文件 0 warnings/0 errors|

新测试已接入既有 `run-auth-boundary.sh`，由 CI recovery-qualification 实际运行真实 SQL，普通 unit run 无 SQL 的 skip 不作为验收。先确认未新增实现时报模块缺失 RED；首轮真实验证定位夹具字段/权限种子错误，修正为正式 `grant_expiry`/`inactive` 和既有 AI 设置权限的显式测试 grant 后 GREEN，无生产 schema 或权限初始化变更。

当前 PR head CI、父独立 Review 和普通合并/main 核验为交付后续门禁；未满足时保持 in_review，不宣称已经合并或放行其他任务。实际 token/费用遥测不可用；本阶段无外部模型请求，T04 5/6 停发授权未转用。
