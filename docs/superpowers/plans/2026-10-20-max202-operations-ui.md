# P09 页面与导航实施计划

> **Execution:** 在现有授权、单一写者与仓库规则内执行，不委派。

**Goal:** 沿已批准 V23 R1 将可信案例、行动计划和调查/资源上下文接入产品。

**Architecture:** 从已审 P08 af2637a0084a9458bdc3c36acffdc1976877838d 堆叠；Lit 页面消费现有 JWT HTTP 接口，资源关系折叠在概览/关系区，基线在指标与趋势。读取与写入均有权限变化/卸载代际围栏；写入结果未知不重发。

**Tech Stack:** Lit 3、TypeScript、共享 app-card/dialog/badge/form-field/empty-state、Vitest、Playwright。

设计依据：2026-10-16 V23 原型 R1 的 UI-DESIGN、knowledge/case/actions/plan/context 截图；以 MAX193 当前 designReview metadata 的已批准决定替代原材料的旧“待确认”标记。保留 PR196/199 样式与完整旧路由。

## 1. 接口与敏感内容边界

- 新增 frontend/src/app/ui/controllers/operations-api.ts，定义实际响应 DTO、no-store 请求、安全错误文案，以及 Lit 读取/写入控制器。
- 请求完成前发生权限/会话变化、换对象或卸载，则忽略迟到结果并清除敏感详情与表单。
- 网络/5xx 写入接受未知后阻止再次发送，只允许只读核对；4xx 明确拒绝可修正。测试覆盖迟到结果、权限清除、版本绑定、unknown 不重发。

## 2. 可信知识页面

- 新增 frontend/src/app/ui/views/operations-knowledge.ts。
- 服务端搜索按状态、中文词与资源类型，使用授权计数与 cursor；清除筛选与分页，失败不作空列表。
- 详情分适用范围、事实、处理效果、反例与原记录，版本/hash 技术详情折叠。tombstone/过期禁止引用；审核提交确切 revision/version/hash，备注必填。
- 从调查整理候选，人工填写并确认来源结果；修改创建新版本，提交与独立审核分别进行。真实身份和权限由服务端强制。

## 3. 调查与资源衔接

- 新增 frontend/src/app/ui/components/investigation-operation-context.ts，承载资源关系、基线与调查关联上下文。
- investigation-detail.ts 最小挂载可信案例搜索、关联事项与计划入口；保留原反馈/关闭入口。
- instance-detail.ts/server-detail.ts 的概览折叠及 network-device-detail.ts 关系区挂载关系；semantic-metrics.ts 在选定指标/维度后显式计算基线，展示覆盖率、资格缺口、独立静态比较，不用空数据绘正常图。
- 关联事件显示规则理由、未知评分上下界与 partial，不称为根因。

## 4. 行动与导航

- 新增 frontend/src/app/ui/views/operations-actions.ts，显示实际可读计划的目标、风险、前置、预注册验证、版本与双主体；提交审批、独立审核绑定当前版本。
- navigation.ts/app-render.ts 接入两页和权限；approval-dashboard.ts 添加专用计划入口，保留旧审批。
- 现有服务未提供行动计划列表/调查到计划发现、可信计划构建预填、执行 enqueue/get/reconcile/cancel 的正式 HTTP 路径；验证路由也未在正式服务装配。不能编造 endpoint 或假数据。一次交付准确缺口供 Chief/P11 协调；受影响验收保持未完成。

## 5. 验证与交付

- focused: pnpm --filter slide-frontend exec vitest run src/app/ui/controllers/operations-api.test.ts 及新增视图测试。
- 模块：pnpm --filter slide-frontend typecheck、test、build；pnpm contracts:check；pnpm lint。
- 浏览器连接受控服务验证实际可用链路，synthetic 身份/数据明确标记；特殊状态补充测试区分于真实业务。
- 1600/1024/390、light/dark、密度、长文、键盘/焦点/控件名称、自动 a11y，逐页保存截图和证据。未验证项如实记载。
- 提交并推送准确 base/head，创建 PR 并配置本 issue checks 监听。CI 必须对应 head；不合并/部署。完整验收受外部缺口阻塞时保留工程与证据并列出最小接续，不宣称完成或 in_review。
