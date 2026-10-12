# T03-A 授权基线修复验证

2026-10-12，MAX-144。仅交付当前调度的 FINAL-0126/0127 有界修复及被触达 actor revalidation 路径；不代表完整 T03 交付。

## 基线、根因与兼容

独立 worktree 分支 `codex/MAX-144-auth-baseline`，起点为最新 main `1a3940e2ef79b9529a9f394d074a47e89d36be3d`；T01 #144 的 merge `ef9a09de1abf92bf789e6d59492a01b3e4b2ab70` 已在基线内。相对 Review `fb0766d6`，auth/actor 生产文件没有增量。原工作区的未提交 AGENTS.md 与基线内容均保留，未带入修复 PR。

- `getAccessibleInstanceIds` 原来只返回 scopes 的键，URL 中间件另查 scopes，两者未取 resourceBoundary 交集。现在均使用已有 `hasInstanceAccess`，与过滤一致；空边界拒绝全部，边界中的 ID 仍须有有效 live instance grant。受限 actor 的 admin/通配符不会跳过边界。
- 触达路径复核确认 `revalidateActor` 重读数据库时丢失调用方边界。这不同于 FINAL-0109 的“数据库里持久化边界收缩”原主张，不改变该历史裁定。修复在异步查询前复制并冻结三类资源 ID，返回 live grants 与原 ceiling；避免调用方在 await 期间扩大边界。
- 保留普通无边界 actor 的 admin/通配符、只读/读写层级、401/403 与合法 URL 参数行为。缺失或非正安全整数的 URL ID 返回400，通配符也不能跳过 ID 校验；body 不提供实例授权 ID。不新增公开契约或放宽普通 Chat owner/read share。
- 不引入服务主体、Profile、Session桥接、调查路由、迁移或模型调用。生产数据和其他任务服务未触及。

## RED / GREEN 证据

`1ae0f365` 为 focused RED checkpoint：实例枚举/URL/无效ID及边界保留，11失败/57通过。`cb8611a0` 为真实MySQL RED checkpoint：同一生产代码下4文件17失败/63通过，0skip；其中MySQL8项实际执行，6失败/2通过。首次MySQL夹具缺少shares外键引用的chat_sessions，属于测试设置失败；补用仓库表定义后才计入上述有效RED。

`82d05afc` 为 GREEN checkpoint：同一隔离命令4文件80通过，0失败、0skip。脚本仅创建自己的临时MySQL8.4容器/随机数据库，结束关闭连接、删除测试schema与容器。使用仓库基础表定义、005 grant-expiry迁移及 `applyActorSecuritySchema`；JWT真实签发/验证，ActorContextService真实数据库查询，未mock授权快照。HTTP用Fastify测试夹具，服务端设置委派边界，使用现有认证与授权中间件；不把夹具入口描述为调查业务路由。

真实证据覆盖：

1. scopes={1,2}、boundary={1}：列表/count仅返回1，URL2为403；read-only不能执行要求read-write的操作。
2. 同一JWT删除或过期instance1 grant后，列表为空/count=0，URL1/2均403。
3. 保留actor重新校验后，live grant已收缩且原三类边界仍存在；升级admin也不能抹掉边界或访问无live instance grant的ID。
4. 实例/服务器/网络三类scope全覆盖正例，逐个替换成边界外scope均拒绝；角色过期后服务器/网络读取与实例HTTP权限门禁拒绝。
5. 用户停用/session version变更后，同JWT返回401，保留actor重新校验也失败。
6. 既有Chat路由兼容测试通过；本阶段没有宣称调查消息、证据、WS的端到端撤权已经实现。

```bash
bash scripts/qualification/run-auth-boundary.sh
pnpm --filter slide-api typecheck
pnpm security:agent
pnpm security:test
pnpm --filter slide-api exec vitest run \
  src/auth/chat-ownership.test.ts src/auth/chat-handler-ownership.test.ts \
  src/auth/session-config.test.ts src/resources/resource-service.test.ts
pnpm --filter slide-api exec vitest run src/auth/rbac-service.test.ts
pnpm contracts:check
```

安全agent门禁17文件187项通过；安全测试35文件334项通过；模块兼容4文件46项、RBAC 1文件36项通过。以上均无失败/skip；安全测试与agent门禁存在重叠，不把数量相加冒充独立样本。typecheck和contracts:check通过。focused oxlint 0错误，1个既有 `Boolean(stored.revoked)` 警告，未作无关修改。未测覆盖率；项目未设本模块覆盖率硬门禁。真实MySQL验证命令新增到既有 recovery-qualification CI，默认单测的环境skip不能代替该命令。

## 出口与保留门禁

PR的最终head、当前CI、Review及正常合并SHA由Issue交付记录，不预填通过。本次有界源码复核与真实负例只关闭上述触发条件，不授予整个auth/actor/session领域clear。

T03-B等待已合并T02-B schema/store，T03-C等待T02-C集成证据。服务身份禁登录/无admin继承、Profile及工具权限交集、调查Session窄append、普通Chat转换事务、调查消息/证据/count/WS撤权仍未实施；不以本修复、既有Chat测试或三类scope谓词测试代替这些未来验收。最终集成完整gate仍归T12，无生产发布。

实际token/费用遥测不可用，无硬预算，无新增子代理。
