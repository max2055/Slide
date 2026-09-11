# MAX-36 方案 B 实施计划

> **Execution:** 按已批准方案执行，遵守现有授权与仓库规则。

**Goal:** 将四视图优化为紧凑专业操作台，完成方案第 8 节验收。
**Architecture:** 保留 overview 数据模型、请求与导航边界，仅调整模板、局部样式、文案及必要共享组件 part。
**Tech Stack:** Lit / Vite / Vitest / Playwright。

## v2 范围与资源

v1 实施 447c0e2 已通过 PR #37 合并为 5217551；v2 基于 main@51c3652，用户明确批准附件方案 B。原真实网络验收缺口继续保留；不改后端、采集器、主题或自动诊断。硬预算未设定，实际 token/费用遥测不可用。累计已有子代理 1，最大深度 1、并发峰值 2；本轮不新增代理。

## 步骤

1. 修改 `frontend/src/app/ui/views/dashboard.ts`、`dashboard-styles.ts` 和 `frontend/src/app/i18n/locales/operations-overview.ts`：标题快照时间、Tab/搜索/引擎相邻；风险双行、四 KPI 语义及选中状态；运行分布和采集质量共用紧凑侧栏；关联选择展开且刷新/筛选失效时清空；空态区分权限/失败/未纳管并内聚管理按钮；数据库引擎与趋势组合。
2. `frontend/src/app/ui/components/app-card.ts` 添加 root/header/body/footer part，`frontend/src/components/stat-card.ts` 添加 label/value/hint part；默认样式不变，总览用 part 设置密度、颜色与圆角。
3. 在 `frontend/src/app/ui/views/dashboard.test.ts` 补选择失效、语义变体、关系状态回归。运行 `pnpm --filter slide-frontend test -- src/app/ui/views/dashboard.test.ts`。
4. 在 `frontend/e2e/dashboard-overview.spec.ts` 补五风险首屏、双主题四视图、长名称、选择/搜索/引擎、权限空态、文字对比度与无自动分析断言。独立前端端口使用 Playwright 执行，保存截图。核对现有服务 PID/端口/cwd/命令，真实登录仅浏览四视图并截图，不触发诊断。
5. 最终运行 `pnpm --filter slide-frontend test`、`typecheck`、`build` 和 `git diff --check`；复用无变化证据。只提交本任务文件，发布后续 PR，交付报告与截图。停止条件：第8节验收达成，或记录确切外部阻塞且完成所有独立部分。
