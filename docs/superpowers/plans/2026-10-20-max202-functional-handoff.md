# MAX-202 P09 工程候选与接口接续

当前规则为 functional-delivery-1。准确输入 base 为 P08 PR213 `af2637a0084a9458bdc3c36acffdc1976877838d`，分支 `codex/max202-operations-ui` 堆叠到 `codex/max201-verification`；没有合并或部署。当前候选是部分功能交付，完整 P09 仍被下述接口与验证缺口阻塞，不宣称整批完成。最终 head、PR、CI 与附件校验和随交付评论/证据清单记录。

## 功能与证据矩阵

| 范围 | 已实现与已验证 | 尚未完成/证据限制 |
|---|---|---|
| 导航与旧功能 | 新增可信知识/行动中心，权限守卫、懒加载；原导航/路由与审批保留；完整前端回归 | 不是整批跨包回归结论 |
| 可信知识 | 真实 JWT/ACL/HTTP/MySQL/KnowledgeService：调查整理候选、保存、提交、第二身份独立审核、中文搜索、详情、撤源 ACL 后刷新清正文；revision/version/hash 审核绑定单测 | synthetic 来源事实与身份，无产品模型调用；人工将案例绑定当前调查的正式入口缺失 |
| 行动计划 | 真实 PlanService/HTTP/MySQL：按 ID 读取、从统一审批记录发现已提交计划、提交、双主体审批、绑定版本、编辑新版本使旧版本 superseded；SQL 执行数为 0 | seed 使用明确 synthetic 环境验证器；完整草稿/执行队列、可信来源生成草案、执行与报告尚未接入 |
| 关系 | 三类资源详情最小挂载，按需读取实际关系接口，来源/版本/效期/partial，建议不冒充确认；组件单测 | 未完成三类真实详情的浏览器/服务业务链，不把组件 mock 当 E2E |
| 基线 | 指标与趋势内按实际 metric/dimensions 显式评估，资格/覆盖/缺口与静态阈值独立；组件单测 | 未完成真实历史数据/服务/浏览器链；不存在资格时不画正常偏离图 |
| 调查关联 | 实际 attention snapshot/page 请求、去掉资源 role，partial/未知上下界/理由与调查跳转；组件单测 | 未完成真实调查实时 WS 与关联浏览器链；未实现 attention 人工 override UI |
| 安全状态 | 控制器测试：撤权/会话失效/卸载/切对象围栏、迟到响应、互斥写、网络/5xx 接受未知后不重发且允许只读核对；计划审批绑定晚到 feed 单测 | 写未知锁在页面生命周期内；不声称执行器 once/现场安全经过本页面验收 |
| 浏览器补充状态 | 明确 HTTP 拦截补充 loading/empty/503/403/expired tombstone/write unknown 双击仅发一次；长文、三密度×三宽无横溢；可见按钮名称 | 此项不是正式后端异常链；未作完整 axe/WCAG 合规审计，未完成上下文全部状态矩阵 |
| 视觉与键盘 | 案例列表/详情、行动列表/计划 1600/1024/390 × light/dark 共24图；comfortable 长文3图；原生共享 dialog Esc 关闭与焦点恢复 | 未完成执行报告/人工结案视图和资源嵌入全矩阵；无人听读门槛 |

## 已批准 R1 对照

沿用 R1 的主信息列＋286px 侧栏、960px 以下单列、案例适用→事实→处理→反例→原记录、计划四步与风险紧邻审批，技术 hash/参数按需展开；消费现有主题与密度 token、app-card/dialog/badge/empty-state 与共享按钮。深浅/窄屏截图来自真实 Lit 页面，不复用原型图片。

保留现有产品导航 rail；390px 对本次两页增加 rail 占位，避免内容遮挡。此处沿既有产品导航而非重新实现原型的全站移动导航。行动中心只展示实际审批 feed 的已提交计划，明确不含草稿/执行队列；未实现 R1 的待执行/需核对/已验证页签及效果图。病例详情明确人工绑定入口尚缺，不设置假引用成功。

## 一次列全：Chief/P11 最小接口协调

P09 不修改后端公共写者文件。以下列出现有域端口与消费需求；建议名称不是已存在的 HTTP 契约，最终路径/DTO/装配由 P11 明确发布并运行 contracts:check。

1. **调查 → 可信计划草案/发现**。`operations/actions/routes.ts` 当前只有 POST plans、GET plans/:id、versions/submit/review，无 GET 列表/按调查检索。需授权分页列表（调查、状态、cursor、authorizedCounts/partial），或调查上下文返回当前可访问 planId/版本/状态。POST create 已存在，但需要服务端提供可信工具版本/hash、环境/策略版本、证据/关系/基线引用和预注册 verifier 来源；不能要求用户输入 hash 冒充可信构建。UI 当前 sourceInvestigation 链接不代表已筛选出该调查计划。
2. **人工选择案例绑定调查**。现有知识搜索/详情/审核与模型参考服务不等同人工绑定。需明确调查/结果版本、案例 id/version/hash、适用确认及当前 ACL/效期的写入契约和撤销/失效语义。P09 当前仅提供搜索与来源往返。
3. **执行 enqueue / read / cancel / 原回执核对**。`ActionExecutionStore.enqueue` 已有严格输入 `{planId,expectedVersion,approvalId,requestKey}`；`get(actor,id)`、`cancel(actor,id)` 与 `ActionExecutor.reconcile(actor,id)` 已存在域端口，但无正式 HTTP/公开契约/生产装配。需要返回 executionId、计划版本、operationId、状态/回执/错误与版本，按调查/计划发现既有执行；显式新动作 requestKey 与同请求核对必须区分，outcome_unknown 不得 enqueue 重放。取消只能按域状态处理，不能把 unknown 声称已撤回。P09 没有执行按钮或自动重试。
4. **验证与报告发现/读取/worker 装配**。`registerActionVerificationRoutes` 已实现内部 POST/GET `/api/operations/action-executions/:id/verification` 和 GET `.../versions/:version`；`operations/public-api.ts` 与 `composition.ts` 尚未发布/装配。需与 `verifiedActionWorkflowHandler`/`verificationWorkflowHandler`、持久化调用者权限上限以及执行发现统一接通。UI 需要报告 immutable id/version/hash、执行与恢复分别结论、120/60/300/10 观测、缺数 inconclusive/未改善 failed、证据与负面影响、历史版本/失效标志。
5. **人工结案**。`investigations/feedback-types.ts`/contracts 已支持 `verification.actionReport:{id,version,hash}` 与 `staleVerification`，P08 语义保留。正式报告发现接通后 P09 才能从实际报告选择构造 close/recovery，展示旧报告失效/重开，不允许手填报告 hash 或提前结案。旧 investigation feedback UI 保留，本次未实现行动报告选择器。

## P09 可恢复接续

1. Chief 独立审查本工程候选与准确 CI；处理本范围发现，P11 协调/释放上述契约后，原单一写者接回页面消费。无需重新批准 R1、等待生产部署或长期资格。
2. 完成草案/列表/执行/原回执核对/报告/人工关闭重开，补 attention override（若 B15 要求）；补资源关系/基线/关联三类详情真实服务浏览器链和完整特殊状态矩阵。
3. 重跑受影响 focused、最终候选 gate、真实浏览器状态及截图；准确新 head CI 通过并经独立审查后才可将完整 P09 交 in_review。

## 复现与环境边界

`pnpm --filter slide-frontend test`、`typecheck`、`build`，根 `pnpm lint`、`pnpm contracts:check`。专用浏览器命令：`MAX202_MYSQL_PORT=<本任务隔离MySQL端口> MAX202_OUTPUT_DIR=<产物目录> pnpm --filter slide-frontend exec playwright test --config playwright.operations.config.ts`。未设置隔离端口时该专用 suite skip，避免普通 smoke 意外访问数据服务。

fixture 创建独立 schema、跑真实迁移，结束 drop schema/关闭 Vite/Fastify/池；没有共享3308/旧卷、Provider、SSH、目标执行或产品模型发送。仅取消 fixture 自己已知未发送的测试预算 reservation；未操作 canonical 产品账本。编码 token/费用遥测不可用，不冒充产品模型计量。本 run 的专用 MySQL 容器在最终交付前按准确 ID/label 优雅停止。
