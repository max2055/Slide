# T03-C：Profile、授权与 Session 当前模块集成出口

2026-10-12，MAX-144，产品 V1.1 / 调度 v1.2。基线 `main=58491d49b48073be527506eb89fb8180b17753ff`；独立分支 `codex/MAX-144-integration`。本轮新增真实集成负例与模块交接文档，生产代码、迁移、HTTP/store、executor、前端均无改动。原工作树的用户/平台修改未覆盖。没有子代理、模型调用或生产操作。

## 前置与复用证据

|阶段|已合并 PR / head / merge|当前 head CI|
|---|---|---|
|T03-A|[#147](https://github.com/max2055/Slide/pull/147) / `9fe3ad1e47c3a27cbf74d50a84788906212380a0` / `8a1910b13935d131681724f020d14355b758efdd`|[38200371823 attempt 2](https://github.com/max2055/Slide/actions/runs/38200371823/attempts/2)，8 passed|
|T03-B|[#148](https://github.com/max2055/Slide/pull/148) / `7f739a25a346ae68a4c0be1eb046f804e3059076` / `321a948e5e508af0514efea974a90c06db14e52c`|[38210782759](https://github.com/max2055/Slide/actions/runs/38210782759)，8 passed|
|T02-C|[#149](https://github.com/max2055/Slide/pull/149) / `b064ce67fa1b241812953790d7b42d9ca9379dc3` / `58491d49b48073be527506eb89fb8180b17753ff`|[38214096468](https://github.com/max2055/Slide/actions/runs/38214096468)，8 passed|

上述 head/merge 均进入当前基线；前置由 MAX-140 核验，本轮再次读取 GitHub 当前检查及本地 main。#149 未改 T03 生产模块。未变 store/report/outbox 的真实 MySQL 64 项与 Analysis 恢复 41 项复用该 head CI；不为文档重复执行全量测试。T03-A 关闭 FINAL-0126/0127；T03-B 额外保护关联 Chat 读取及原显式实例授权来源。详细接口和历史失败分类保留在 [T03-B](t03-b-validation.md)、[T02-C](t02-c-validation.md) 与父阶段台账中。

## 本轮真实验证

`session-bridge.test.ts` 保留原桥接 fixture，并注册**实际生产** `registerInvestigationRoutes`。真实临时 MySQL 8.4、正式 MigrationRunner、users/roles/grants/members、JWT middleware、HTTP/store/Chat/bridge 使用同一生产实现。新增 10 项，无 mock ACL、无 skip，退出关闭 Fastify/连接并清理独立数据库及测试容器。

|新增验收|结果|
|---|---|
|成员删除、成员过期、角色 chat:view 撤销、角色过期（4项）|先以同一 JWT 成功读取；数据库撤权后 detail/messages404且 no-store、列表 items空/count0/cursor空，原 admission key 重试、cancel、patch404；保留 actor 的 requestAuthority/watch/authorizeTool 拒绝；旧 Chat message/count/watch 也拒绝；message/request/job/outbox仍各一条|
|operator 降 viewer（1项）|同 JWT 仍能读消息/watch；原键重试、cancel、patch、持久快照工具权限403；没有第二消息/job|
|持久快照失配（4项）|用真实 SQL 写入过时 profileHash/scopeVersion/sessionId/sessionVersion，重建 bridge 后 requestAuthority404；内容读取仍独立校验 live ACL。只验证快照失配 fail-closed，不宣称数据库被恶意控制时的完整防篡改能力|
|另一 operator 读取自动调查（1项）|可读同 service Session 历史，但不能继承原 request 用户 authority；原 numeric user 的 authority 重建成功且嵌套资源上限不可变；service Session owner 不变|

```bash
bash scripts/qualification/run-auth-boundary.sh
pnpm --filter slide-api exec vitest run src/auth/chat-ownership.test.ts src/auth/chat-routes.test.ts src/auth/chat-handler-ownership.test.ts src/chat-history-page.test.ts src/investigations/authorization.test.ts src/investigations/contracts.test.ts src/contracts/public-api.test.ts
pnpm security:test
pnpm security:scan
pnpm --filter slide-api typecheck
pnpm contracts:check
pnpm exec oxlint apps/db-ops-api/src/investigations/session-bridge.test.ts
git diff --check
```

|检查|本轮结果|
|---|---|
|真实授权/HTTP qualification|7 文件 **158 passed / 0 failed / 0 skip**；HTTP35、bridge34、instance8实际执行，其余为授权回归|
|Chat/Profile/公共契约模块回归|7 文件 **74 passed / 0 skip**|
|触达安全回归|35 文件 **334 passed / 0 skip**|
|安全扫描|passed|
|API typecheck / contracts / focused lint / diff|passed，focused lint 0 warning / 0 error|

各组有重叠，不相加冒充独立用例。本轮未出现测试失败；没有改权限来通过断言。新 PR 的准确 head、CI、审查和 merge/main 包含关系由 MAX-144 最终附件及父 phase evidence 记录；旧 head 通过不代替本轮 CI。

## 完整 T03 当前模块验收映射

|要求|当前证据与消费边界|
|---|---|
|两个版本化 Profile|ops/system v1、prompt/hash、fault_diagnosis、readonly allowlist、参数预算与 schema 冻结；authorization.test.ts，T03-B|
|受限 numeric 服务主体|真实 provisioning；密码/JWT/refresh 禁交互登录；admin/wildcard/write permission 禁继承；bridge34 中原有服务负例 + authorization.test.ts|
|主体/成员/全部资源/Profile/工具/caller/request 交集|production HTTP35 + bridge34；三类 scope 撤权、System config、原 grant/admin 晋升、live policy 收缩、冻结 allowlist/资源上限、当前成员删除/过期/降级|
|显式 Session append|Chat 窄入口校验绑定、active request、原 actor/内容/acceptedVersion；100同键只一条消息/request/job/outbox；故障 SQL trigger 整事务回滚，T03-B/T02-C|
|普通 read share 与转换|read-share不能 append/转换；转换保留原 Session/message ID；活动 Chat Run 409；关联会话普通入口不可绕过实时授权，T03-B/T02-C|
|恢复与撤权|重建 bridge/store保留原对象/请求；同JWT及保留actor在 grant/member/role 撤权后隐藏内容/count并拒绝重试；请求冻结主体和 Profile/scope/Session 必须一致，本轮补齐负例|

本轮有界 Review 覆盖 `profiles/authorization/session-bridge`、`auth/actor-context`、服务身份标记、Chat受限入口与 #149 的连接点：角色/grant current read、所有必需 scope、caller ceiling 的复制、冻结授权来源、viewer/operator、HTTP no-store、admission授权先于幂等返回、同事务消息/统计、错误不泄漏。未发现当前模块阻塞，无额外生产修复。仓库 main 无保护/额外 rules 要求人工批准；本轮仍须当前 head CI和普通 match-head merge，不使用 admin/force。

## 下游撤权契约与保留门禁

- T04 执行每个 request 必须先用可信原主体调用 `requestAuthority`，并在每次工具调用前调用 `authorizeTool`；快照只限定最大权限，不能替代 live grant/member/role/Profile/policy。返回的 actor 已去掉 admin roles/username/wildcards并限为只读边界。必须另外实现可信目标解析、参数限额、真实 provider、取消/恢复/租约，不能把授权测试当执行验证。
- T05 内容、证据、派生摘要、缓存复用及每次 watch/WS发送须调用 `authorize(...,'content'|'watch', trustedContentScopes)`。内容 scope 来自持久可信来源，全量验证；访问者校验自己的 ACL，不能借原服务/request authority。之前成功的读取不能缓存为权限，原始记录没有可信 scope 时保守处理。新投影/历史语义与 WS 撤权由 T05 验收。
- T06 在撤权/断线/重新授权时隐藏消息、证据、派生计数与浏览器缓存，验证深链与旧 Chat 路由；本模块提供服务器门禁，**没有**宣称 WS关闭或浏览器清缓存通过。
- 本次仅完整 T03 **当前模块**出口。T04 Run/executor、T05 evidence/watch、T06 browser、T09 source/egress 及 T12 真实端到端/最终全量 gate 仍待对应 owner；六领域不整体 clear。stage5释放由 MAX-140 独立核验，不能由本子任务自动调度。

无生产部署/迁移、新任务、子代理、付费设施或模型调用。实际 token/费用遥测不可用，无硬预算。
