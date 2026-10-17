# 批量采集配置实施计划

> **Execution:** 在 MAX-191 已授权范围内执行，不派生代理。依据附件 R2、冻结 R1 和 APPROVAL.md；基线 3b309a7b。

**Goal:** 从三类资源列表选择对象，确认逐对象配置差异后受控执行并追溯结果。

**Architecture:** 批量编排复用 PolicyService 和 MetricConfigurationService.activate，不创建第二采集调度器。MySQL 保存预览、逐对象执行输入和结果；数据库锁限制工作进程，发布审计用于崩溃恢复。队列重新读取有效权限，取消保留已发布事实。默认保留覆盖，仅显式选择的字段进行合并。

**Tech Stack:** Fastify / TypeScript / MySQL / Lit / Vitest / Playwright。

### 1. 编排与持久化

- 新增 `metrics/bulk/model.ts`、`service.ts`、`store.ts`、`routes.ts` 和迁移 `126_metric_bulk_jobs.sql`。
- 测试 `metrics/bulk/service.test.ts`：混合兼容性、已有覆盖不丢失、未授权项不读取详情、逐对象冲突、失败不发布、幂等、取消中在途结果、仅失败项重新预览、审计恢复不重复发布。
- 修改 `metrics/config/service.ts`：为现有 activate/trial 增加可选取消和实时检查钩子，以及预览指纹门禁；单对象默认行为不变。
- 队列仅处理已确认预览；每个对象实际 IO 前及发布前重新读取权限/取消状态。并发上限 3；连接锁在在途操作完成后释放。重启先按确定 request_id 查询发布审计，再决定是否需要执行。
- API 输入有界，创建幂等键作用域为用户；结果仅限创建者，并再次校验资源权限。错误只传稳定代码。
- 运行 `pnpm --filter slide-api exec vitest run src/metrics/bulk/service.test.ts src/metrics/config/routes.test.ts` 与后端 typecheck。

### 2. 公共契约

- 在 `contracts/metrics/public-api.ts` 登记批量输入/结果和路由，生成 OpenAPI 与客户端。
- 运行 `pnpm contracts:generate`、`pnpm contracts:check`，HTTP focused 验证身份、限额、任务所有权和确认要求。

### 3. R1 三步界面

- 新增 `frontend/src/app/ui/components/metric-bulk-dialog.ts`，共享 app-dialog/card/data-table/badge 和已有布局 token。
- 修改 `resource-metrics-table.ts`：三类列表统一勾选、当前页选择、明确数量、打开共享批量流程；不回退列表分页/列设置/序号。
- 匹配按类型/引擎/版本/能力分组；显示推荐、覆盖缺口和跳过原因。预览显示当前→目标、覆盖字段/保留字段和读取成本；只有明确确认才启动。结果显示逐项状态，失败项重新预览后确认重试；支持取消、刷新、读取持久化任务。
- 前端 focused 测试覆盖空/加载/错误/权限变更、失效响应、跨页选择和重试；运行前端 typecheck/build。

### 4. 业务和视觉验证

- 先核对已有本机服务进程/端口/cwd/版本/日志，再为当前代码启动隔离端口服务；不改 Provider、不调用产品 LLM。
- 代表 MySQL 真实匹配/预览/执行并与 R1 截图对照，然后验证 MySQL/VM 混合和受控部分失败。对权限、CAS冲突、取消、重试、已有覆盖进行可恢复测试，保留基线和准确环境记录。
- Playwright 保存桌面/窄屏、浅/深色截图与键盘焦点证据；受控状态注明模拟边界。物理网络设备可达性边界如实记录。
- 运行受影响模块和最终必要 gate；交付报告记录当前提交、结果及未完成项。创建一个 MAX-191 PR，实际 push 后设置自身 checks/30m/on-timeout wake，读取当前 head 已完成结果；完整验收后交 Chief 独立审查。
