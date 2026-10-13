# T06 工作空间实施与验收计划

> **Execution:** 在 MAX-148 授权内执行，沿已批准 implementation-baseline/menu-addendum 和当前 main 增量；不委派、不调用外部模型。

**Goal:** 真实调查 API/WS 接入、普通对话转换、兼容菜单和可访问的响应式工作空间。

**Architecture:** Lit Light DOM 页面组合共享组件和当前 Chat Parts renderer。控制器只读观察后端事实，提交目标/继续/取消通过现有 HTTP；使用 DirectGatewayClient 的独立调查订阅，不增加执行 owner。

**Tech Stack:** Lit、TypeScript、Fastify/JWT、MySQL 8.4、Playwright。

1. 消费前 Review：复核现用 Chat 附件异步/greeting/session cache、深链权限、客户端终态 reducer；复用已合并 T04/T05 证据。旧 chat-message-list 不引入。保留托管起始分支与运行规则；功能分支从 main `1d5ba755` 开始。
2. `controllers/investigations.ts` 和前端 API/types：列表分页/搜索/state/Profile/resource 筛选；同键提交可核对接受未知；detail/facts/results/evidence 实时授权读取。WS 水位去重、缺口重新快照、单向终态、撤权/断线清空敏感缓存、切换时取消旧异步结果。
3. `views/investigations.ts`、`investigation-detail.ts`、`components/investigation-context.ts`：创建/转换表单、三层状态、共享 Chat Parts、继续/取消、历史分页、结果版本/证据过期和引用；宽屏三块、1024证据弹窗、390单栏。运行中不另排追问；取消只标等待确认。
4. 导航/app-render 最小接入：关注事项确定性已有事件视图与资源概览切换；AI工作空间与普通Chat；保留旧 dashboard/chat/资源/治理/设置路由与用户默认首页。配置中未实现功能不制造可用入口。
5. focused Vitest：游标重复/缺口/终态后帧、旧调查异步响应、撤权清缓存、同键HTTP接受未知；现用Chat session/附件/greeting/navigation回归。
6. `e2e/investigation-workspace.spec.ts`：实际生产 HTTP/DirectAdapter WS/隔离正式迁移 MySQL；受控 Provider/只读工具与正式 executor。创建→工具→取消→继续不同Run→结果版本→刷新；普通Chat直接输入/转换原消息ID；viewer/撤权/未知/错误/空/加载、dialog焦点；1600/1024/390溢出断言。测试没有 skip，环境缺失明确失败。
7. 前端模块全量、typecheck/build/contracts/lint/diff，记录重叠及环境限制；独立 PR关联MAX-148，当前head CI和父独立Review齐备后普通merge/main核验。不宣称完整V1/T12通过。

停止条件：未经授权后端/模型/生产改动、真实链路不可恢复的环境缺口或父Review阻塞；保存具体证据与PR交接，不把mock当完整验收。
