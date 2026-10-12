# T02-C：调查 HTTP 与完整 T02 当前模块出口

日期：2026-10-12；范围版本 V1.1 / 调度 v1.2。基线 main `321a948e5e508af0514efea974a90c06db14e52c`，消费已正常合并 #145/#146/#147/#148。原运行工作树的用户改动/平台快照未覆盖；功能在独立 `codex/MAX-143-investigation-http` 分支实现。无子代理。

## 已实施

- `server.ts` 仅窄注册调查 routes。真实 JWT → ActorContext → T03 SessionBridge/Authorization；HTTP 不接受 actor、权限、资源边界、Profile内容或Profile版本。
- create/list/detail/patch/runs、授权消息读取和 request cancel HTTP；严格 TypeBox + 服务端跨字段校验，所有响应 private/no-store，错误仅公开稳定错误码。
- POST 创建要求 Idempotency-Key；迁移113先预留原客户端命令键和规范hash，再创建同一调查/Session并调用现有桥接首admission。重试先实时授权、恢复原对象、比较原命令，不重新创建对象；JSON字段顺序和资源数组顺序不改变语义。原创建版本供首request恢复，后续patch/run不会破坏重试。
- Subject/有限时间窗口冻结到原命令及request snapshot；资源与Profile由服务器固定，最大20资源/2000目标/200标题/1小时窗口。System无资源且须config:view；Ops主体必须属于全部required resourceRefs。
- 单一 store transaction提交Session/调查/资源/request/authority/message/job/outbox/幂等键；不是返回202后再入队。锁序create-key → admission-key → Session → investigation，与独立request入口一致。
- list实时校验每个对象全部scope后过滤/count/limit；cursor为绑定过滤条件的offset，返回authorizedCounts.total。并发增删仍可能移动offset页，未宣称快照分页。
- PATCH保持现有title/goal/lifecycle窄契约、实时operator授权及乐观版本409；活动request禁止改变goal/lifecycle。scope/Profile/context不可修改，problemStatus/verification/resolved不属于此HTTP patch，保持拒绝无证据恢复声明；恢复/关闭依据由T11反馈模块实施。
- cancel实时operator/all-scope授权，事务持久取消意图。未领取queued/retry job转cancelled并释放active；running job保留active与状态，T04消费意图并拥有真实Run取消。没有调用DirectAdapter或伪造Run终态。
- detail持久元数据/version/context，derivedRunState/latestResult当前为null；Run/result、events、evidence及WS由T04/T05提供。现有Chat消息由桥接读取，转换复用原Session、不复制原message ID。
- HTTP schemas/OpenAPI/生成类型纳入既有contracts生成器；CI既有auth qualification实际执行routes.test.ts。更新T01只约束已实施HTTP、不再禁止已经实现的入口，未来events/results仍不发布。

## 验收命令与结果

```bash
bash scripts/qualification/run-auth-boundary.sh
bash scripts/qualification/run-report-recovery.sh
pnpm --filter slide-api exec vitest run src/investigations/contracts.test.ts src/workflows/outbox-service.test.ts src/workflows/worker-runtime.test.ts src/auth/chat-ownership.test.ts src/chat-history-page.test.ts
pnpm --filter slide-api typecheck
pnpm --filter slide-frontend typecheck
pnpm contracts:check
pnpm exec oxlint apps/db-ops-api/src/investigations apps/db-ops-api/src/contracts/generate-public-api.ts apps/db-ops-api/src/contracts/public-api.ts
pnpm security:test
pnpm security:scan
git diff --check
```

|检查|实际结果|
|---|---|
|auth/HTTP qualification|7文件148通过，0失败/0skip；其中真实MySQL+JWT：HTTP35、桥接24、instance8；其余为授权模块回归|
|store/outbox/report qualification|3文件64通过，0失败/0skip；正式MySQL迁移、升级/重复run与历史保留应用回退|
|契约/outbox/worker/Chat回归|5文件64通过，0失败/0skip|
|触达安全回归|35文件334通过，0失败/0skip|
|安全扫描|security secret scan passed|
|后端与生成类型检查|api/frontend typecheck、contracts:check、focused oxlint、diff检查通过|

各组存在重叠测试，不相加冒充独立用例。MySQL使用脚本创建的隔离mysql:8.4容器和随机schema，运行全部正式MigrationRunner。测试使用随机JWT secret，不使用生产凭据或模型。脚本退出清理测试容器；Fastify监听随机loopback端口并在afterAll关闭。

|验收|真实证据|
|---|---|
|真实HTTP CRUD/持久读取|真实loopback TCP fetch创建、修改、列表/详情；独立DB连接再次读取持久title；正式113迁移重复run ledger仍completed，context/窗口在request snapshot一致|
|100同键创建|100 HTTP请求全部202且同调查/Session/request/job/version；实际调查/Session/message/request/job/outbox/key各一条；原authority仅服务器permissions|
|100同键请求/单active|首请求结束后的100跟进同键202只有一条新消息/request/job/outbox；100不同键同Session只有一条202，其余409|
|跨入口锁序|100交替create重试及原request重试全部稳定202，无SQL死锁或第二message/request；JSON键顺序/资源顺序改变仍返回原acceptance|
|不同payload/版本|同创建键goal变化409，request message变化409；相同expectedVersion并发patch一200一409；运行中goal/归档409；后续patch仍能恢复原创建acceptance|
|全部事务故障|create的Session/调查/资源/request/message/job/outbox/create-key八处真实SQL trigger，503且所有owned行回滚；跟进request/message/job/outbox四处失败保留原调查/Session/版本；撤除故障同键成功；取消job UPDATE失败连取消意图/active指针一起回滚|
|先授权后分页|不可见对象插在两条可见对象之间，limit1/count仍精确两条；第二页只含另一条可见记录；过滤变化cursor400，query无匹配总数0|
|ACL/撤权|viewer可读却continue/cancel/patch403；普通Chat read-share无调查内容/append权限；同一JWT分别撤instance/server/network scope后detail/messages/create重试/runs/patch404、列表count0；没有新消息|
|System/服务主体|System需config:view，移除同JWT config后重试404；伪造admin/permissions的service interactive JWT401；成员operator继续服务Session不改变numeric owner|
|普通Chat转换|原Session/message ID保留且原消息只一次；read-share转换404，active Run转换409；Run已结束后转换与创建重试同ID|
|取消边界|排队取消事务记录意图/真实jobcancelled/释放active，重复安全；running只持久意图、不伪造Run终态或释放active|

初轮失败已分类并修复：新增夹具辅助JOIN两种表collation不能直接比较、read-share列名与正式schema不符；pre-112升级夹具原来只排除112导致误提前执行依赖113，改为真正pre-112集合；新fetch JSON响应需显式类型；T01旧“接口未实施”断言随公开HTTP落地更新。未降低门禁或skip测试。

## 有界 Review 与剩余模块边界

内联检查严格输入/SQL参数、全scope实时授权、主体非客户端选择、read-share无append、无admin服务继承、原命令规范hash、原创建版本重试、跨入口锁序、事务原子性、取消owner边界及错误脱敏。未发现本阶段阻塞；T03持有的auth/actor/chat/Profile/SessionBridge核心没有修改，只有T02 store新增cancel operation传入既有授权。

#145关闭FINAL-0026/0300、#147关闭FINAL-0126/0127的证据保留。此结果仅补T02-C HTTP所消费的auth/session/outbox准入，不将整个六领域标clear；执行/provider/WS/证据/浏览器/T12总gate仍待各owner。完整T02出口仍须当前head CI、审查与普通合并/main包含head和merge证据；最终PR/head/merge/CI见MAX-143交付评论及父phase台账。

无生产部署/迁移、新付费设施或模型调用。实际token/费用遥测不可用，无硬预算。
