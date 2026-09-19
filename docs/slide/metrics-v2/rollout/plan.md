# MAX-76 Implementation Plan

> **Execution:** Follow this plan within existing authorization and repository rules. Track dependencies and acceptance evidence. No production activation.

**Goal:** 隔离验证三类指标影子差异、唯一正式来源、告警转换去重、容量与保留数据回退。

**Architecture:** 复用 MysqlMetricStorage、MetricStorageAdapter、现有告警服务和评估器。新增显式 opt-in 的数据库控制边界，行锁串行化来源 CAS、正式发布和告警转换；无注册序列保持现有行为。

**Tech Stack:** TypeScript、mysql2、Vitest、MySQL 8、现有 Worker/collector。

## 执行契约

设计 v1 已于 2026-09-19 在 MAX-76 评论批准。原设计文件保留历史；本计划不扩大其范围。基线 6335d9a，当前恢复分支 agent/15astra/3d235fb316ad。硬预算未设定；实际 input/cached/output/费用不可用，子代理 0。停止条件为完成验收/PR，或具体不可恢复环境阻塞；生产部署、全历史重算、全指标迁移、外部通知 exactly-once 排除。

## 1. 持久化控制

- 新增 `apps/db-ops-api/sql/migrations/101_metric_v2_rollout.sql`，来源记录以 series_hash 主键，保存来源、代次、读模式、包 pin、published/applied revision；转换状态和窗口键有数据库唯一约束。
- 新增 `apps/db-ops-api/src/metrics-v2/rollout/control.ts`：初始化不覆盖；切换须匹配期望代次、增加代次；应用确认须匹配发布 revision；事务内检查来源、代次、应用状态再发布。失败不能改变正式值。回退使用同一 CAS 保留观测。
- `rollout/control.mysql.test.ts` 验证竞争切换只有一次成功、旧来源及迟到代次拒绝、未应用 revision 拒绝、事务失败回滚。

## 2. 告警与适配器

- `compatibility.ts` 增加可选控制上下文，旧/新写入通过控制事务；读路径来自持久化模式。影子数据只能保留证据，正式读不能选中它。
- `alert-database-service.ts` 允许内部调用传入事务连接，原调用行为不变。
- 控制服务复用 `evaluateMetric`，将状态与窗口转换及 alerts 写入放在同一事务；未知质量无恢复；恢复后旧窗口不重新触发。
- 实库并发 20 次同键只创建一次；不同维度/规则版本隔离；注入写失败后转换记录也回滚。

## 3. 代表演练与容量

- 复用现有 database/host/snmp collectors 和 fixture 测试，分清模拟目标与真实持久化。
- 新增有界压力与回退场景，实际维度/资源/周期计算点数与保留开销，记录 p50/p95/p99、错误率、索引占用和两倍需求目标。
- 先各类 1 个测试资源，再扩大隔离集合；来源冲突/重复转换/错误映射阈值 0，容量余量至少 30%，失败 no-go。

## 4. 验证交付

- 开发：`METRICS_V2_TEST_MYSQL_PORT=33376 pnpm --filter slide-api exec vitest run src/metrics-v2/rollout/control.mysql.test.ts`。
- 集成：同环境运行 `vitest run src/metrics-v2 src/contracts/metrics-v2`，涵盖 Worker fencing、三类 collector、保留策略、跨模板、CoreProfile、发布/应用及 HTTP/browser。
- 文档：根目录 `pnpm --filter slide-api exec vitest run tests/phase-94-docs-structure.test.ts`；相关模块类型/构建检查。
- 报告写入本目录，区分真实/模拟/fixture、通过/未完成、生产限制；附回退命令、环境和 PR/commit。无需再请求设计批准。
