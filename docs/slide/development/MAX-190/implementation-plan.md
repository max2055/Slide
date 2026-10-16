# 资源采集配置实施计划

> **当前设计：** 用户已批准交互原型 R1（确认：“OK，没问题，继续推进”）；冻结包 SHA-256 `ab49721cb37448222295b526cd6c1744b94e2b5b546596c5f2f0ad4416ae6074`。MySQL页内宿主、连续流程、详情与模板表格已完成受控组件验证；先完成MySQL真实对照，再推广其余页内宿主。当前证据及未完成项见 `verification-checkpoint.md`。

> **Execution:** 在 R2 已批准范围内执行。B 独占前端，A 独占后端；不另派代理。最终真实联调依赖 A 审定提交。

**Goal:** 三类资源使用同一采集编辑器，绑定、单指标覆盖、调度应用与正式可见状态分别准确呈现。

**Architecture:** 复用 Lit 共享组件和 MAX-186 主题、列表规范；抽离中性采集 API/类型，编辑器承接预检、试采、发布与有界状态刷新。详情只读摘要通过资源编辑事件打开同一表单；设置管理定义、包、策略组和审计。

**Tech Stack:** Lit 3、TypeScript、Vite、Vitest、Playwright。

## 1. API 与状态（先 MySQL）

- 将前端活动调用统一为 `/api/metrics`，集中共享类型；最终核对 A 的实际契约。
- 对象绑定从资源采集状态读取，禁止以核心列 `not_configured` 推断未绑定；显示全局阻塞、有效开关来源、应用、正式源与最近证据。
- 测试加载、403、失败与 unknown 均不显示未绑定；linux-basic 的核心列缺失不改变绑定状态，MySQL 9.6 容量不支持单独呈现。

## 2. 唯一编辑器

- `metric-configuration.ts` 保留 revision CAS、原覆盖、继承、候选失效、409 不重试、未保存保护。推荐只选择服务确认兼容项；不兼容禁用并解释。
- 以可搜索策略组枚举替代技术 ID 输入。主区仅模板、有效开关、周期和覆盖摘要，高级项折叠。
- 发布后轮询只刷新状态，不重载用户候选；失败停止并提供重试，到达有界次数停止且明确仍未完成。
- `metric-configuration.test.ts` 覆盖推荐、覆盖保护、连续阶段、轮询上限、权限撤销和断开清理。

## 3. 资源入口

- `instances-db.ts` 先接入“监控与采集”，连接保存后保留同一流程完成绑定；新增 ID 校验并避免重复创建。保存连接与发布采集分别反馈。
- `instance-detail.ts` 只展示摘要并发出编辑事件，沿已有导航打开资源编辑；确认真实 MySQL 视觉对照后接 `servers-page.ts`、`network-devices-page.ts` 和对应详情。
- 关闭、导航、切换资源保留未保存确认；键盘 Escape 与焦点恢复复用 `app-dialog`。

## 4. 设置与旧入口

- `metric-settings.ts` 保留定义/包语义版本、策略组与审计；资源策略只读摘要跳同一编辑器。
- 移除 `metric-registry.ts` 产品实现及菜单，旧 URL 跳统一指标目录；更新导航、翻译与受影响测试。
- 扫描前端活动代码、E2E 与夹具的体系名称，保留必要旧 URL 映射并记录退出条件。

## 5. 验证与交付

- focused：`pnpm --filter slide-frontend test` 加直接受影响文件，随后完整前端测试。
- `pnpm --filter slide-frontend typecheck`、`pnpm --filter slide-frontend build`；公开契约由 A 生成并最终执行 `pnpm contracts:check`。
- Playwright 受控异常覆盖桌面/窄屏、明暗、正常/空/加载/失败/权限/部分/未知，保存截图与焦点/溢出结果；正常路径使用真实服务，准确记录 commit/端口/进程/数据来源。
- 一项主要 PR；push/创建后配置当前子任务 CI checks 监听。最终完整证据才置 in_review，由 Chief 独立审查、合入；若 A 尚未可联调，明确未完成并保留检查点，不把 mock 证据当真实验收。

## 历史初始状态（当前交付分支见检查点）

- 工作分支 `agent/15astra/max-190`，HEAD `93bbb18a`，基线 main `acd0e1b0`。
- 既有 `AGENTS.md` 修改与 `.multica/` 不纳入本任务提交。
- 不调用产品 LLM；不修改后端或共享环境开关。
