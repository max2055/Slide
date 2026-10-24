# MAX-223 三类资源八列列表实施计划

> **Execution:** Follow this plan within existing authorization and repository rules; use executing-plans when useful. Track task dependencies and acceptance evidence. Delegate only when useful and authorized.

**Goal:** 按 MAX-223 已批准的正文实现三类资源八列单行、四操作直显及窄屏局部滚动。

**Architecture:** 复用 resource-metrics-table 和 app-data-table，固定业务列并分开正式采集状态与最近成功时间；附加指标沿用列设置。页面提供真实名称、地址、版本/型号及原有操作回调；网络/服务器健康读取正式资源总览，数据库保留现有健康判定。

**Tech Stack:** Lit 3、TypeScript、Vite、Vitest、Playwright。

## 实施顺序与验证

1. 修改 `frontend/src/app/ui/components/resource-metrics-table.ts`：统一所有宽度表格；固定选择框＋八业务列；迁移旧列隐藏偏好；保留分页与跨页选择，正式状态/时间分列；为长文本和完整时间提供可聚焦全文；观测健康保留未知和过期。更新直接单测，验证25行分页序号及状态时间来源。
2. 修改 `frontend/src/app/ui/views/instances-db.ts`、`servers-page.ts`、`network-devices-page.ts`：独立地址、真实版本/型号，四按钮同排；保持原有编辑/确认删除/导航；测试防并发，数据库旧健康不得冒充测试结果。更新连接测试回归。
3. 更新 `frontend/e2e/resource-metrics.spec.ts`：三页×1440/768/375×浅深主题；验证列顺序、单行、无页面溢出、键盘滚动与焦点、搜索分页和批量选择、详情/编辑/测试/删除取消。构造状态明确为隔离数据，不作为正式采集证明。
4. 运行 `pnpm --filter slide-frontend typecheck`、`pnpm --filter slide-frontend test`、`pnpm --filter slide-frontend build` 及相关 Playwright。独立端口运行当前代码，真实服务仅安全读取/测试及删除取消，收集脱敏截图与证据。
5. 提交代码、推送 codex/MAX-223-resource-columns 并创建 PR。登记本任务 checks 监听（30m超时wake），上传证据，置 in_review 交 Chief 审阅；不合并 main。

## 追加要求（2026-10-21）

Max 增加数据库“数据量”列，置于版本之后；数据库为九个固定业务列，网络/服务器仍为八列。复用 latest_capacity 已发布容量值和其观测时间，未知、不支持及过期如实展示，不触发采集。

## 边界和停止条件

不修改采集调度、模板、趋势、鉴权后端或共享运行服务；无产品模型调用。不执行共享真实资产删除。范围内检查通过且 PR/证据交付后停止；环境缺口如实记录，不以 mock 代替真实业务验收。
