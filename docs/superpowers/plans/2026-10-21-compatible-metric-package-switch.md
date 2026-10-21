# MAX-214 兼容采集模板切换实施计划

> **Execution:** 在 MAX-214 与父 MAX-208 已批准范围内执行，不新增代理，不重启共享服务。

**Goal:** 正常预览、试采、activate 可将已绑定资源切到兼容诊断包，保留覆盖、审计和旧 revision 隔离。

**Architecture:** 复用 `PolicyService.changeBinding` 的 CAS、resolver、事务审计及能力重置。去掉模板 ID 相等限制，改为变更包必须符合资源类型及已知版本；未知能力仍由真实试采/来源门禁判定。覆盖不做自动删除或语义转换，目标包缺少覆盖指标时继续明确失败。正式查询继续按 revision/generation 过滤，回退通过发布新 revision。

**Tech Stack:** Fastify、TypeScript、Vitest、MySQL、Lit 既有配置组件。

## 1. 复现与策略修改

- 在 `apps/db-ops-api/src/metrics/policy/package-switch.test.ts` 验证 mysql-basic@2 → mysql-diagnostics@1.1、linux-basic → linux-host；覆盖资源/策略组保留、未知指标冲突、权限、版本/类型拒绝、CAS、能力重置、审计失败原子回滚与回退。
- 运行 `pnpm --filter slide-api exec vitest run src/metrics/policy/package-switch.test.ts`，确认业务 RED 并提交测试检查点。
- 最小修改 `apps/db-ops-api/src/metrics/policy/service.ts`，运行相同测试确认 GREEN 后提交。

## 2. 激活和正式来源隔离

- 扩展 `apps/db-ops-api/src/metrics/config/candidate.test.ts`，覆盖跨包真实 runner 试采、失败不发布、远程 IO 后权限撤销、组/CAS 变化。
- 新增 MySQL 集成测试，在独立数据库中运行生产 scheduler/formalization/formal-store；用真实 MySQL SQL 验证切换后至少三周期、旧在途拒绝提交、旧系列不混读、回退仍用新 revision。
- 真实资源测试只复制当前 instance1/server3 配置与受控凭据到独立平台库，目标只执行固定只读 SQL/SSH。复用配置页面，保存试采、激活、正式 API 和截图；不冒充完整 JWT/共享 main 已部署验收。

## 3. 遗留配置核实

- 使用受控只读连接读取当前 qps/disk_usage、模板规则及宏，核对 `reviewed-sql.ts` 的摘要和 SQL 分类、定义的单位/kind/scope、阈值语义。
- 可等价项记录现有不可变审查包及正常 activate 路径；无法证明等价的记录具体阻塞，不自动激活或更改原记录。
- 核实 MySQL counter 的 lifecycle 证据来源；没有可信 epoch 时记录 unknown 原因，不推断重置时间或制造 qps。

## 4. 最终 gate 与交付

- 运行 metrics/contracts 相关模块、后端 typecheck、contracts:check。复用前端仅测试时运行相关组件/浏览器验证；修改公共契约才重新生成契约。
- 记录准确候选 SHA、RED/GREEN、真实读数周期和限制。推送并创建修复 PR 后，将 PR 关联 MAX-214，设置 30m checks 条件接续，回读状态。
- 若 MAX-209 稳定集成环境尚未交付，独立开发完成但真实共享服务复验明确保持待完成；不把 trial/applied、PR 或 CI 当作整体验收通过。
