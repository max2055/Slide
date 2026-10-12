# T02-B 正式调查 schema/store：验证与 T03-B 交接

2026-10-12，MAX-143 / PR #146；产品 V1.1、调度 v1.2。本阶段是正式持久化模块，**完整 T02/调查 HTTP 尚未交付**。

## 基线和范围

默认分支 main。复用 `codex/MAX-143-investigation-store` / #146，在原候选上合并 main `8a1910b13935d131681724f020d14355b758efdd`，保留早期 #146 和 #145 历史。#147（T03-A）head `9fe3ad1e47c3a27cbf74d50a84788906212380a0` 已正常合并为上述 main SHA，8 项 CI 通过；父任务已核验其真实 MySQL/JWT 领域证据。本轮未覆盖原工作区的 AGENTS.md / 平台文件。

本阶段新增 `sql/migrations/112_investigations.sql`。当前 runner 自动按文件名发现并登记 SQL migration，不使用假设的 TypeScript migration 编号/注册模式。新增调查、资源、成员、请求和精确字节幂等键五表；不预建后续证据/投影/预算模块或复制 Run 状态。

`MysqlInvestigationStore` 提供 create/detail/list/patch/admit 与可组合事务接口。现有 Chat 数据库服务仅修改 maintenance 清理的排除条件；未修改 auth/actor/chat HTTP 所有权、routes/server、Profile、服务主体或模型执行。

## T03-B 消费契约

- 构造函数第二参数必须为**可信服务器授权端口** `AdmissionAuthorizer(connection, actor, investigation, operation)`，缺失即失败关闭。operation 为 create/read/patch/admit；所有读写及幂等重试均调用。actor 为真实 numeric user/service ID，不用 0 或默认 admin。
- 回调收到 owner、固定 Profile id/version、scopeVersion、Session、版本及完整 resources；资源/owner 容器冻结。T03 在该 connection 上用实时权限当前读/锁验证主体、调查 ACL/成员有效期、全部资源 scope、Profile/工具交集及调用方权限上限。客户端和模型不能传入回调或自行选择执行身份。不可见用 NOT_FOUND，操作权限不足用 FORBIDDEN，基础设施异常不吞掉。
- create 仅允许 owner 转换现有 Session；普通 read share 不能转换或取得 append 权限。已有 running Run/调查绑定返回 409。新调查创建现有 numeric-owner Chat Session，资源写入和授权失败均回滚；转换不复制任何消息。ops 必须有资源，system 可零资源；最多 20 个资源。
- Session 有唯一绑定及 FK RESTRICT。独立 Chat delete 的事务在 FK 拒绝后回滚先前消息删除；maintenance 排除引用会话；归档保留原消息。服务主体的禁登录/无 admin 与调查 append 授权是 T03-B 的责任，store 不声称已实现。
- `list` 按 updated_at/id 稳定排序，逐调查调用实时 read 授权，再按 profile/resource/query 过滤、计算 total 和 offset/limit（最大 50）。只有 NOT_FOUND 可作为不可见项过滤；授权服务异常使整个请求失败，不返回伪造计数。当前是全候选扫描/授权，成本随候选数增长；HTTP cursor/source/派生运行态契约在 T02-C 对接，不能先 SQL limit 再补授权。
- patch 在调查锁内授权，随后校验 expectedVersion，竞争者返回 409；只允许 title/goal/lifecycle。活动请求禁止生命周期变化。problemStatus/resolved/verification 不由此基础接口声明，避免绕过真实恢复证据；完整验证型 patch 在对应功能阶段接入。
- admission 的锁序为 actor/key → Session → investigation → request；固定 hash 含 investigationId/message/expectedVersion，重试不重哈希新的 Profile。不同 hash 409；同 Session 唯一活动请求。request/job/outbox/版本/幂等键一个事务、单一入队 owner；不创建 Agent Run，也不写 Chat 消息。
- `transaction(work(connection, append))`、`createInTransaction`、`admitInTransaction` 供可信服务组合，不启动嵌套事务。后者返回 `{ acceptance, isNew }`，`admit()` 的公开稳定返回值仍是 acceptance。T03-B **只在 isNew 时**在同一 connection 上追加消息并绑定 request.message_id；任何失败抛出以回滚整体，不在 authorizer 内追加，不重复入队。
- 新调查创建与首次 admission 已证明可在一个事务内组合并整体回滚。create 本身不是 HTTP Idempotency-Key 接口；T02-C 的 POST 创建重试仍需在创建前按原始客户端命令解析/校验既有键及原 investigationId，再调用这些端口，不能每次创建新调查然后靠 admission 去重。

## 当前真实验收

本地临时 MySQL **8.4.10**（mysql:8.4，aarch64），随机隔离 schema，完整正式 MigrationRunner；授权为持久 SQL grant **测试端口**，没有替代 T03 的 JWT/Profile/服务身份实现。所有测试容器已由脚本退出清理；无生产数据库访问或模型调用。

```bash
bash scripts/qualification/run-report-recovery.sh
pnpm --filter slide-api exec vitest run \
  src/investigations/contracts.test.ts src/workflows/outbox-service.test.ts \
  src/workflows/worker-runtime.test.ts
pnpm --filter slide-api exec vitest run \
  src/auth/chat-ownership.test.ts src/auth/chat-routes.test.ts \
  src/auth/chat-handler-ownership.test.ts src/chat-history-page.test.ts
pnpm --filter slide-api typecheck
pnpm exec oxlint apps/db-ops-api/src/investigations/store.ts \
  apps/db-ops-api/src/investigations/store.mysql.test.ts \
  apps/db-ops-api/src/chat-database-service.ts
pnpm contracts:check
git diff --check
```

- 真实 SQL qualification：**3 文件 64 项通过，0 fail / 0 skip**。其中调查 44、原 outbox/report 20；新调查测试继续由 recovery-qualification CI 脚本实际执行。
- 契约/outbox/worker focused：3 文件 52 项通过，0 skip。
- Chat ownership/routes/handler/history：4 文件 27 项通过，0 skip。
- 后端 typecheck、focused lint、公共契约检查和 diff 检查通过。没有新增 HTTP 契约。

| 验收 | 当前证据 |
|---|---|
| 正式迁移、重复执行 | 全量 fresh install 后两次 run；112 ledger 仅一条 completed，再次 run 完整 ledger 内容不变 |
| 旧库升级和安全回退 | 使用 pre-112 的完整正式迁移建旧 schema，保留原 Chat Session/消息后升级并重复 run；归档调查后仍可用既有 Chat 读接口读取；删除拒绝且原 message ID 保留 |
| 100 同键 | 返回完全相同 acceptance，request/job/outbox 各一条，实际 ID 对齐 |
| hash 冲突、Session 活动唯一 | message/version/调查 ID 变化均 409；100 不同键同 Session 仅一项成功，其余 409 |
| admission 故障回滚 | request/job/outbox 三处 SQL trigger 失败，全部关联行和 key 回滚、版本/活动指针不变；恢复后可重试 |
| 创建原子、无孤儿 | investigations/resources 两处 SQL trigger 失败及授权失败，新 Session 也回滚；创建+admission 组合的 queue 失败回滚 Session/调查/资源/request/job/outbox/key |
| Session 安全 | 转换 running Run 拒绝；有真实 read-share 的非 owner 拒绝；转换后原消息只有一条且原 ID 不变；重复绑定 409；FK 阻止独立删除并保留消息，maintenance 保留引用会话 |
| 授权查询/计数 | 将缺 scope 的对象排到列表首位仍只返回授权项，total/offset 不含隐藏项；detail 404；异常 503；所有入口缺授权端口 403 |
| 全 scope/撤权 | SQL fixture 中两个 required scope 只满足一个时不可见/不能 admission；补齐后成功；撤销任一 scope 后同键重试拒绝，无第二 job |
| patch | 同版本并发两项仅一成功、另一 VERSION_CONFLICT 409；先授权后版本信息；活动请求不能归档；禁止无验证 resolved 声明 |

MySQL DDL 不是事务回滚：本阶段采用**应用回退且保留新增表/外键/ledger**的安全策略，真实测试证明既有读链路及历史数据不丢失。没有实现或执行 populated schema 的破坏性 down migration；部分 DDL 失败继续遵循现有 runner 的 failed ledger / 显式修复机制，不能删除 ledger 后盲目重试。未执行生产迁移。

初轮失败均属本次 fixture/迁移整合：新表列注释被全库 invariant 拒绝、预置用户 ID 冲突、fixture grant 表漏注释、隔离升级库名超 MySQL 64 字节上限；已逐项修复并完整复跑受影响 SQL 检查。oxfmt 因仓库忽略 apps 而未执行格式化；focused lint/diff 已通过，不把该输出声称为格式检查通过。

## 有界 Review 与出口

本轮内联审查只消费 T02-B 的能力：SQL 参数绑定、输入上限/字段白名单、numeric owner、无服务 admin 默认值、全部资源交给必调授权端口、重试撤权、读授权在 count/limit 前、锁序、事务失败释放及原消息删除回滚、稳定 request/job/outbox ID。未发现本阶段阻塞；未派生代理，也未重复全仓 Review。最终当前 head 的 CI/正常 merge 及 merge SHA 记录于 #146 和 MAX-143 交付评论。

#145 的 FINAL-0026/0300 和 #147 的 FINAL-0126/0127 修复证据保留；仅消费这些已合并基线及正式 store 阶段能力。其他 auth/Profile/WS/工具/证据等 pending 不改成整域 clear。完整 T02-C 必须等待 T03-B 已合并授权/Session 桥接，之后完成真实 JWT HTTP、POST 创建幂等、验证型 patch 和公开契约链路验收。完整集成 gate 仍归 T12，当前证据不替代未来总验收。

本阶段正常合并并由父任务核验后可调度 T03-B；完整 T02 未完成，不标 done。无生产发布、新付费基础设施或模型调用；实际 token/费用遥测不可用，无硬预算。
