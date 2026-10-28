MAX238-ROLLOUT-CONTRACT-REGRESSION-R1。继续现有 MAX238 / 15coder1，基点 fcec46da6abb85a768e06a5766e40936bdbd34f5；只在原任务 branch/start 上追加，不切换、reset、amend、rebase。先读最新父子 policy/评论和本期 Chief review。新成员暂停取消优先。Chief 已有界接受本包 MySQL 4 项红绿及真实 Published 兼容回归，保留 R3/R5/PUBLISH-REJECTIONS，不重做这些未变检查。

唯一确认缺陷是漏掉 supplemental gate：旧 CI run40732529727 job122972501978 的 src/contracts/public-api.test.ts > generates deterministic documented operations and frontend types，期望路径表缺 /api/metrics/config/resources/{type}/{id}/operations/{key}。Chief 在 exact fcec46da6 独立复现 9 passed / 1 failed；当前 buildOpenApiDocument 正确生成99条路径，测试表仍98条。dispatch_handoff.additional_gate 已要求修复，上一运行未做。不得删除断言、改成动态自我比较、skip、隐藏 route 或宽松生产 codec。

先对真实 GET handler/config service、contracts/metrics/public-api.ts、PublicApi schema/generated OpenAPI/frontend types 核一致性；把合法已存在路径加入静态 manifest 的正确排序，并按现有模式补最小必要断言，核 GET 的 operationId、bearer security、type/id/key 参数、MetricOperationState 响应、既有 400/401/403/404/409/500 契约按实际注册内容一致，保留完整路径精确匹配。默认只改 apps/db-ops-api/src/contracts/public-api.test.ts 及本包证据；仅确认生成物漂移才通过原生成器更新最小文件，不修改运行时/权限/应用谓词。

验证：原公开契约测试明确由 9/1 转10/0；pnpm contracts:check；API typecheck（测试更改或生成物受影响时）；仅相关 config/policy 路由/operation state 契约的必要测试。生产和MySQL夹具不变则复用本期 Chief 6/6、作者模块结果与 R3/R5，不重新全量、浏览器、DB。若实际需要 DB，仅本run拥有且非3306一次性schema/container，记录exact owner/nonce/ID和可靠清理。禁止真实采集/共享写/3306业务写/worker/生产切换。针对 pending/committed/absent 不引入新业务语义。

同一草稿PR567，从干净 head a8d89698ad88791ae4c6b3c7a52c2a14e7a60e9c 追加必要变更，核来源/差异/全部新增待推对象无凭据或 qualification 快照，禁止push原风险祖先，保持草稿整单未完成，准确更新说明。一次读取当前CI即可，不watch、rerun CI碰运气、不merge/deploy。原74115头CI25成功5失败的分片2/6/8已确认相关；新头若出现未变或无关失败先分类记录，不扩大改码，不谎报全绿。

MAX240 HISTORY-WINDOW-R1 由其准确唯一回调负责，不重复派发；不碰 query.ts、storage.ts或formal-store.ts读方法/consumers文件。其最新run/rule以父子metadata为准，勿写旧MAX240开发仍在跑。禁止子代理/产品模型/MAX224账本/3306写/部署worker/停写复制切换回退解绑；activate原trial-success/required-metric谓词、必要名单与所有hold不变。操作key为原范围实现，不向成员索要字段。新回调由Chief登记，开发者不建watcher/guard/递归恢复。

交付准确SHA、差异、聚焦红绿/适用typecheck和contracts结果、草稿PR安全head与一次CI事实、未完成项。MAX238/MAX235整体in_progress，不宣称业务真实采集/UI/整单完成。若失败先诊断具体错误、actor和checkpoint，不换Provider或机械重跑。
