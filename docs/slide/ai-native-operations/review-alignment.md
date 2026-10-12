# AI-Native Operations V1：R00 Review 对齐与领域准入

本材料为 MAX-141 / R00 的文档候选，不实现 Investigation 功能。Review 已完成其选定扫描范围，领域准入仍有确认阻塞和未决证据。R00 的材料合并不代表 T02–T12 获得全部实施准入；T01 可先做契约、固定样本与测试基线。

## 1. 冻结来源与当前代码

- 扫描与当前实施源码：`fb0766d606c9f07448a5eddac2a6657847d90830`。2026-10-12 获取 `origin/main`、`ls-remote --symref origin HEAD`，默认分支为 main，没有扫描基线之后的远端增量。交付分支复用 `codex/MAX-141-review-alignment`。
- 阶段附件：2026-10-11 14:05:55 UTC 的 progress，记录复用352、新完成400；RUNNING 的402/1074是更早文字，不作为同一时点累计。阶段报告 hash 为 `9068e4fdc3d04328510694eb85c8ea64df32578b78d35bc48870ba78ea571797`。
- 最新取得材料：原 Review 输出目录的 `report.zh-CN.md`、两份 scan JSON、coverage、progress、RUNNING。最终覆盖1074/1074，1489个文件被工具排除；主扫描1071成功、3网络失败，补扫3成功。3884条是候选数量，并非确认缺陷数量。
- 最新报告日期为2026-10-11，取得时间、文件mtime、精确SHA-256和所选38个路径覆盖状态见 [输入来源账本](evidence/input-provenance.json)。mtime是文件时间，不冒充报告生成时间或模型统计时间。
- 本次未重新启动 OCR、全仓代码扫描或付费模型；不采用快照中的指令启动/恢复历史扫描。原大体积报告及原始会话不提交。本次实际token/费用遥测不可用；不借用历史Review模型统计冒充本任务用量。

附件资料包的27个manifest项及压缩包校验通过。执行方案与菜单按附件原文纳入；其中绝对路径和第18节检查是**原方案历史记录**，当前取用入口以 [材料索引](materials-index.md) 为准，不要求执行环境具有作者本机目录。

## 2. 判定方法与证据边界

重点选取 auth/actor、实例边界、Chat持久化、DirectAdapter/Run/投影、Workflow/outbox、Analysis/告警、platform/source、导航/Chat 的38个文件。最终报告180条候选逐项登记当前行段、文件hash、结论、责任任务及尚缺证据；阶段快照另有17个未在最终报告独立保留的位置也登记，防止去重或候选减少被当作修复。

共197个记录：**confirmed 11、rejected 24、needs-evidence 162**。完整逐项表见 [候选账本](candidate-ledger.md)，机器可读源位置、短原主张及源码行段见 [candidate-ledger.json](evidence/candidate-ledger.json)。同一问题族合并责任与门禁，不重复建单；PARTIAL编号和FINAL编号分属各自报告，位置别名并不证明文字完全相同。

- confirmed：在当前源码有确定行为或有界复现；再分别判断是否阻塞所触达的V1契约。并非每个confirmed都是生产可利用漏洞。
- rejected：当前触发前提不成立、在用保护/真实查询否定主张，或候选把既定兼容设计误当缺陷。排除仅覆盖具体主张，不证明整个文件安全。
- needs-evidence：逐项保留源位置与需验证条件；尚未完成调用链或真实环境确认。不能当作默认确认，也不能当作通过。

这里没有声称独立确认全部197个候选。未在重点文件集合中的session配置、agent-core恢复/预算、服务器/网络评估、Tools/Profile及搜索计数等仍须由责任任务补有界Review；没有用全仓候选严重标签代替准入。

## 3. 当前确认条目与修复归属

以下文件位置均对应上述源码SHA，详述和源码行段在逐项账本。修复PR均尚未产生，责任复用现有MAX-140子任务；历史同领域任务done不代替这些新条目的关闭证据。

|发现ID|当前文件:行|结论与影响契约|责任任务|实施门禁 / 关闭证据|
|---|---|---|---|---|
|FINAL-0026|`apps/db-ops-api/src/workflows/outbox-service.ts:10`（Review基线）|confirmed，具体阻塞已修复；begin失败不release的Review原始记录保留|T02/MAX-143；T04/T07消费修复|[PR #145](https://github.com/max2055/Slide/pull/145)正常合并；真实连接中断后begin失败仍release，rollback失败保留原错误；[验证](t02-outbox-validation.md)，合并/CI证据见下|
|FINAL-0300|`apps/db-ops-api/src/workflows/outbox-service.ts:27`（Review基线）|confirmed，具体阻塞已修复；重复返回未落库UUID的Review原始记录保留|T02/MAX-143，T07/MAX-146|同一修复PR已合并；真实MySQL重复/100并发只返回同一实际行ID且无孤儿；REPEATABLE READ旧快照负例通过；[验证](t02-outbox-validation.md)|
|FINAL-0126 / 0127|`apps/db-ops-api/src/auth/require-instance-access.ts:34`、`:88`（Review基线）|confirmed；列表/中间件与hasInstanceAccess对boundary语义不一致；构造受限actor可复现，不宣称普通浏览器已有同样漏洞|T03/MAX-144|T03-A已正常合并[PR #147](https://github.com/max2055/Slide/pull/147)，merge `8a1910b13935d131681724f020d14355b758efdd`；真实MySQL/JWT撤权与三类scope负例、8项CI通过；仅本条blocked关闭，调查授权仍pending；见[t03-auth-baseline-validation.md](t03-auth-baseline-validation.md)|
|FINAL-2384|`apps/db-ops-api/src/adapter/agent-run-service.ts:161`|confirmed；false/0错误与结果写成NULL|T04/MAX-145|相关任务内修复；定义合法非成功payload，保留明确空值语义|
|FINAL-2385|`apps/db-ops-api/src/adapter/agent-run-service.ts:182`|confirmed静态窗口；取消遗留completionPending且running恢复不再查询|T04/MAX-145|blocked于调查取消/恢复接入；真实MySQL staged-complete/cancel竞争及唯一终态契约|
|FINAL-0618|`apps/db-ops-api/src/adapter/direct-adapter.ts:812`|confirmed静态比较；send解析agent前缀，cancel直接比原key|T04/MAX-145，T06/MAX-148验收|blocked于复用取消；有前缀/裸session真实WS两路径可取消|
|FINAL-0614|`apps/db-ops-api/src/adapter/canonical-store.ts:56`|confirmed静态路径；幂等比较遗漏metadata/完整Parts，更新只看status|T05/MAX-147|blocked于版本化事实复用；同ID变更拒绝或明确版本更新，重复checkpoint/恢复对齐|
|FINAL-1117|`apps/db-ops-api/src/platform/platform-observation-service.ts:38`|confirmed；顶层与分组件查询窗口不同|T09/MAX-150|T09内修复；相同from/to全链路响应一致|
|FINAL-1118|`apps/db-ops-api/src/platform/runtime-events.ts:6`|confirmed；非成功turn.terminal映射ok，不能作为成功事件摄入|T09/MAX-150|blocked于System持久事件映射；逐终态映射，取消/partial不统称失败|
|FINAL-1127|`apps/db-ops-api/src/platform/source-snapshot-service.ts:116`|confirmed静态路径；输入根manifest.json与发布清单冲突|T09/MAX-150|相关任务内复现/裁定保留名；若改同步须完成真实sync/manifest/重复同步|

“当前必须修复”指**实施受影响功能之前**：outbox事务/ID、受限actor边界、取消/staged-result、带前缀取消、canonical事实版本、System终态映射。本R00不顺手改这些业务模块。主任务可先调度责任子任务的有界修复PR，不以未来功能交付作为启动自身修复的前置。共享文件的唯一owner由MAX-140协调：outbox T02→T07，agent-run/direct-adapter T04→T05→T06，source T09。

“相关子任务内修复”：合法false/0结果保存、观测时间窗、保留manifest名。只在触及路径且符合契约时处理，不提前建全仓整改任务。

“独立backlog”：未引用Chat组件的循环/失败重试、弃用REST connector的archive/GHE/symlink与资源风险、未证实错误结果的any/嵌套三元/硬编码/重复代码/性能建议。没有新建或启动backlog；如未来启用这些路径，必须先做相应验证。

## 4. 误报、保护与尚未裁定

|发现ID|裁定证据|结论与后续|
|---|---|---|
|FINAL-0080|真实MySQL9.6.0常量SELECT，JSON布尔原查询和unquoted查询都返回1；[结果](evidence/mysql-json-comparison.json)|rejected：“永远无法匹配”不成立；不凭该查询宣称完整crash recovery通过，其他支持版本由T12覆盖|
|FINAL-0029等|`components/chat-message-list.ts`无生产引用；现用`views/chat.ts:1035`把全局RegExp建在while外|rejected当前Chat卡死主张；旧组件自身问题backlog，T06不得未经修复引入|
|FINAL-0109|ActorContextService.revalidateActor从DB重建；resourceBoundary是调用方调度限制，没有可由管理员缩减的同名持久字段|rejected原候选前提不变；T03-A另确认并修复DB重建时丢失已有调用方边界，见验证记录。新Profile/live scope仍待T03-B|
|FINAL-0120 / 0128|admin身份/角色为当前明确bootstrap超管兼容；未证明保留身份可被非管理员控制|rejected可利用升级结论；不扩成RBAC重写，T03服务身份不能继承该旁路|
|FINAL-0218 / 2794|源码测试明确保护signed advisory与单文件可用全部快照预算；reader权限及model egress为访问边界|rejected设计缺陷主张；T09模型证据脱敏/egress仍为pending|
|FINAL-0013 / 0213等|旧REST GitHub/GitLab connector已deprecated；生产SourceManagementService.sync只用GitSourceConnector|rejected生产可达主张，潜伏代码风险backlog；不能仅看类存在认定在用漏洞|
|FINAL-1411|heartbeat timeout/abort/隔离存在；现有测试明确DB原请求settle前不继续领取|rejected“无超时”主张；永久挂起恢复是T12待验证运维条件|
|FINAL-1116|队列失败返回quality=unknown、QUEUE_STORE_UNAVAILABLE|rejected零积压/无缺口主张；详细日志改良backlog|
|FINAL-0084|probe中late append的parts不变，但sequence仍推进；display发late frame；[结果](evidence/probe-results.json)|needs-evidence；客户端也有reducer，尚未证实可见污染，不能按候选断言状态引用不变|
|FINAL-0083 / PARTIAL-0080、0081|消息可并发，已有session锁、authGeneration和DB幂等|needs-evidence；T04补可控re-auth/send时序与持久事实断言|
|FINAL-0106|legacy retry无snapshot时条件可能放行，还需路由授权和MySQL复现|needs-evidence；T08不得无证据接管其他主体legacy分析|
|FINAL-0171|singleton租约DELETE会重置列，但WorkerLease不公开token；不同于workflow job fencing|needs-evidence；缺下游消费/迟到写证据，不能认定整个Workflow栅栏失效|
|FINAL-0743 / 0920、PARTIAL-0565|候选把mysql2默认CLIENT_FOUND_ROWS行为作为前提，未核对实际flags|needs-evidence；真实相同值UPDATE/UPSERT判定，不用unit executor伪证实|

## 5. 领域准入与全部任务映射

准入`blocked`表示存在上表confirmed契约阻塞；`pending`表示该领域需要的证据尚未齐备；`baseline-only`仅允许不触及业务实现的契约/夹具准备。本矩阵没有授予任何领域无条件`clear`。主任务持有最终门禁；后续源码/配置变化后重跑受影响证据并增补本表。

|领域|当前准入|复用证据|缺口与恢复条件|涉及任务|
|---|---|---|---|---|
|auth / actor / session|pending；0126/0127已由#147关闭；T03-B当前模块补证|T03-A[基线验证](t03-auth-baseline-validation.md)；T03-B服务禁登录/无admin、Profile冻结交集、全部scope、viewer/operator、原子Session追加/转换及真实MySQL/JWT撤权，见[阶段验证](t03-b-validation.md)|T03-B源码模块具备有界证据，当前head CI/正常合并由父任务核验；T02-C HTTP、T04执行、T05证据/watch、T06浏览器缓存/深链与T12端到端仍pending，未授予整域clear|T01、T02、T03、T04、T06、T10、T11、T12|
|DirectAdapter / agent-run / message projection|blocked + pending|Run、DirectAdapter、display/WS现有测试通过；MySQL常量查询否定0080|T04取消/staged-result/key；T05事实版本；消息并发与client reducer；agent-core恢复/预算其余候选待有界复核|T01、T04、T05、T06、T08、T09、T11、T12|
|Workflow / outbox|pending；0026/0300具体阻塞已由[PR #145](https://github.com/max2055/Slide/pull/145)关闭|T02真实MySQL8.4.10稳定ID/释放/回滚与报表恢复44项通过；[正式schema/store验证](t02-b-validation.md)|T04真实租约/恢复；T07事件/admission预算；T02-B正式schema/store具备真实MySQL阶段证据；T03调查授权/消息桥接与T02-C HTTP仍待后续phase，未授予整个领域clear|T01、T02、T04、T07、T08、T09、T10、T12|
|Analysis / 告警|pending|envelope/evidence/provider/recovery现有单测通过|legacy retry/归属、告警并发唯一、事件聚合；服务器/网络覆盖与真实链路未完成|T01、T07、T08、T10、T11、T12|
|platform / source evidence|blocked + pending|source当前测试通过；旧connector可达性排除|T09终态映射、查询窗口、部署commit匹配、模型egress；保留名与真实同步；持久异常防自举循环|T01、T05、T09、T12|
|前端导航 / Chat|pending|导航与告警/源码呈现76项通过；旧组件未引用|现用Chat并发附件/greeting/cache、路由/权限深链、1600/1024/390与真实WS/撤权浏览器验收|T01、T06、T08、T10、T11、T12|

|任务 / 已有Issue|明确交付与关联验收|准入条件|
|---|---|---|
|T01 / MAX-142|契约、状态/subject版本、固定样本；A01–A18框架|baseline-only；R00材料合并后推进契约，不替后续领域签字|
|T02 / MAX-143|调查数据/事务API、唯一admission；A02、A06、A10、A18|0026/0300已由#145关闭；按v1.2消费已合并T03-A，T02-B交付正式schema/store；T03-B后才接HTTP，不上线业务入口|
|T03 / MAX-144|Profiles、服务主体、实时授权、Session桥接；A10、A18|关闭0126/0127；覆盖普通read share不可append及多资源全scope|
|T04 / MAX-145|后台执行、取消、恢复、有限工具；A03、A07、A09、A13|关闭2385/0618，裁定0083/0171并补真实MySQL/WS/provider；不得自授admin|
|T05 / MAX-147|事实观察、证据/结果版本；A02、A08、A11|关闭0614；裁定0084，bound与根因验证分离|
|T06 / MAX-148|Workspace、完整菜单、普通Chat；A01、A08、A16、A18|后端前置合并且相应领域就绪；保留旧路由/默认首页，不启用未修旧组件|
|T07 / MAX-146|事件、去重、admission预算；A06、A13、A15|复用T02 outbox修复；事件并发、频率/token预留、unknown usage非零|
|T08 / MAX-149|数据库告警与旧Analysis桥；A05数据库部分、A14|Analysis领域pending解除；一个执行owner，legacy未知结果不盲重放|
|T09 / MAX-150|System持久异常与源码证据；A04、A11、A15|关闭1118；source/read egress/deployment证据就绪，必要真实同步|
|T10 / MAX-152|服务器、网络与资源往返；A05三类完整、A10|T08/T09合并；对应资源评估/权限Review补齐，不把数据库试点当完整V1|
|T11 / MAX-151|反馈/人工恢复、版本与评估；A12、A17|T05/T06合并；证据权限/版本、关闭依据与not_applicable真实验证|
|T12 / MAX-153|完整gate、真实链路、恢复/迁移/回退；A01–A18|所有前置合并与领域就绪；当前R00单测/prototype均不替代总验收|

stage及UUID以MAX-140当前Issue为准，不能只按旧附件的任务列举顺序并行启动。现存关联MAX-113(outbox)、MAX-114(Analysis)、MAX-126/127(Parts/display)、MAX-139(source错误)已完成各自工作，但本矩阵没有仅凭done认定新候选已修复。源码已包含#142/MAX-139错误分类与#130/MAX-126投影实现；新发现不能重复实现既有修复。本R00没有重新分配或启动子任务。

## 6. 验证与移交

当前源码复用：后端18个测试文件247项通过、前端5个文件76项通过，没有skip。复现脚本含5组有界检查，其中实例边界覆盖2条候选；代码没有业务改动，全部命令与限制见 [验证记录](validation.md)。文档/输入hash/全部T01–T12映射/路径检查独立完成，不为文档写镜像测试。

未完成：当前GitHub凭据401，PR创建、当前head required CI、合并及merge SHA核验尚无证据；新V1功能的真实MySQL事务竞争、provider、SSH/网络、浏览器端到端和最终gate没有运行。这些必须分别报告，不能把323项既有单测或原型24项历史记录当作V1验收。R00只需本矩阵和材料可用后走独立PR门禁，不要求全仓所有问题清零。

后续增量协议：MAX-140记录新默认分支SHA、报告hash与候选来源；逐项增补账本、重用责任Issue并核对修复PR当前head与合并SHA。只解除有当前证据的领域，保持其他pending。报告已完成所选扫描范围，仍有未逐项核实候选和工具排除文件；不可将二者遗忘或写成扫描未结束。业务修复不在R00材料PR中。
