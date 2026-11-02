# MAX-242 授权事实入口实施计划

> **Execution:** 在既有授权和仓库规则内执行。禁止子代理、产品模型调用、共享3306、实际解绑、通知、合并部署。

**Goal:** 资源/事件/历史上下文进入统一工作空间，显式保存幂等草案并读取授权事实。

**Architecture:** 消费240候选29a2029，复用InvestigationSessionBridge.create（不传firstRequest）和command_snapshot；只读事实复用MetricConsumerService，保留metric语义版本和dimensions。公开链接helper与独立组件接入investigations页面，240自行接按钮。页面GET不写入、不入队、不调用模型。

**Tech Stack:** Lit / Fastify / TypeBox / MySQL / Playwright。

## 实施和验收

1. 核对公开契约和现有权限/幂等机制，追加合入实际240安全候选；保留起点，暂不推原始历史。
2. 新增严格上下文schema、幂等draft API与context-facts API；验证绝对窗口、资源存在/权限、事件来源、metric/dimensions，读取后重校验。拒绝未知字段、过宽窗口和越权，零workflow/model写入。
3. 新增上下文链接helper与工作空间组件。打开仅展示草案与读取事实；用户显式保存草案，结果未知复用同一key；刷新可恢复原调查和来源。撤权清屏，异步旧响应丢弃，键盘/焦点、错误/空/缺模型分支。
4. focused单测、受影响模块、typecheck/build、contracts及安全检查。任务自有非3306 MySQL真实JWT/API/DB/浏览器，1440×900主验及1366×768、1920×1080；零模型、无多余创建和拒绝证据。
5. 记录正式组件/路由契约及未完成的模型分析/审批执行/恢复范围；审计发布对象后按安全方式交付，保持任务分支追加。正常交付in_review，单条最终评论。

## 集成变化记录

收尾时240候选更新为9b6c7ab，读取器拆分。追加合入并改用authenticatedMetricConsumerService；复跑受影响JWT/权限/服务/公开契约及生产浏览器验证，不重置本轮累计调用或预算。此前3f2192f证据保留为原候选验证，最终候选单独记录。

## R1/R2 独立拒绝后的同目标修订

原955134eba经Chief e7ef3e6b7复核拒绝：同值父页面渲染丢保存成功、末尾事件IO缺alert:view重验。本轮不重做原型、不增加子任务；复现两条原负例及真实父页面/8条JWT+MySQL竞态，按RED→GREEN检查点追加修复。集成240已交付2a4bd2b，保持其历史/鉴权文件所有权，不清零累计模型预算。产品模型调用仍为0。

保存与读取分别追踪范围epoch/读取序号；最后事件/调查scope验证覆盖预览、保存、已存context。保存最后检查与原创建共用事务，拒绝时回滚。最终171后端、52前端、5组生产浏览器和必要门禁通过；完整模型/审批执行/恢复范围未完成，交in_review待独立接受，之后由Chief恢复240消费者。
