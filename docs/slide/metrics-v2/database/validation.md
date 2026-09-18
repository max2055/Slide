# MAX-71 验收报告

日期：2026-09-18。分支 `agent/15astra/max71-database`，起点 main `eea42aaa6c97b0a208386d03e18a5fe3381a92a6`。最终 commit/PR 以任务交付评论的链接为准。

## 实际验证

所有命令从仓库根执行（corepack 提供项目锁定 pnpm）。

|层级|命令|结果|
|---|---|---|
|最终 focused|`corepack pnpm --filter slide-api exec vitest run src/metrics-v2/database/database.test.ts src/metrics-v2/packages/packages.test.ts`|102/102；数据库新 fixture 36项|
|模块/兼容阶段|`METRICS_V2_TEST_MYSQL_PORT=13371 corepack pnpm --filter slide-api exec vitest run src/metrics-v2/database src/metrics-v2/packages src/metrics-v2/scheduler src/metrics-v2/query.test.ts src/metrics-v2/query.mysql.test.ts src/collectors/__tests__ src/database-service.dameng-metrics.test.ts src/database-service.health-scoring.test.ts src/metrics-database-service.test.ts src/scoring-service.test.ts src/scoring-config-service.test.ts --maxWorkers=4`|阶段188/188；随后增加13项 fixture，最终全量覆盖|
|最终完整后端|`METRICS_V2_TEST_MYSQL_PORT=13371 corepack pnpm --filter slide-api exec vitest run --maxWorkers=4`|276文件通过、4文件条件跳过；2576测试通过、55条件跳过；23.51s|
|类型|`corepack pnpm --filter slide-api typecheck`|通过|
|文档目录|`corepack pnpm --filter slide-api exec vitest run tests/phase-94-docs-structure.test.ts`|最终全量包含并通过11项；文档完成后单独重跑记录在交付评论|
|数据库 release/schema|`corepack pnpm --filter slide-api exec tsx src/metrics-v2/database/export.ts --check`|通过，所有 release 经过公共 schema/registry 验证|
|原不可变包|`corepack pnpm --filter slide-api exec tsx src/metrics-v2/packages/export.ts --check`|通过，原发布内容无漂移|
|API/资格矩阵/秘密扫描|`corepack pnpm contracts:check`、`corepack pnpm qualification:matrix`、`corepack pnpm security:scan`|通过；37/37资格条目|

MySQL 是一次性 `mysql:8.4` 容器，实际 `SELECT VERSION()` = **8.4.10**，localhost:13371，单独数据库 `max71_<pid>`，不读取应用 .env、不连接既有 MySQL。测试 afterAll 删除自身数据库；测试结束删除本次容器。

## MySQL 必需闭环证据

`apps/db-ops-api/src/metrics-v2/database/database.mysql.test.ts` 两项实库测试通过：

- 真实目标查询返回 uptime、Queries、processlist、连接限额、Com_commit/Com_rollback、表大小；每批5条 SQL，同时验证 scheduler 事件 logical_reads=5。
- PolicyService 发布 pin、MetricScheduler/既有 Worker 应用 revision，存储 normalized gauges/counters 与首次 null 派生。大小估算标记保留。
- 执行实际 COMMIT/ROLLBACK 后重建 scheduler/store/Worker，利用持久 counter state 续算；rate 与所存精确计数差/60s一致。
- SemanticQueryService 查询返回同一派生值和 package 血缘；库存读取返回真实 db.version，版本没有进入 metric 维度。
- 初次集成运行末尾库存断言失败，原因是测试资源发现没有调用 inventory 写入边界。补上既有 `writeInventory` 后受影响测试与最终 gate 全通过，未改变公共调度契约。

## fixture 与兼容覆盖

`fixtures.json` 明确标为合成驱动响应。MySQL 5.7/8.0/8.4 同一 Canonical uptime；PG16.4、Oracle19.3、DM8.1 的对象/数组行、版本拒绝、缺属性、uint64>2^53、权限失败、单查询失败隔离、缺失/损失精度、重启 reset、首样本 null、取消后无新 SQL；原生 PG/Oracle/DM 错误字段分类不保留异常文本。

PG 当前库 counter/rate 带 database 维度，不在实例 gauge 组计算数据库公式；连接/会话/进程限额、物理容量/分配估算、命令计数/事务计数保持不同 Extension。MySQL/PG completed_rate 先各自 reset/rate 再相加。与原四引擎 provider 的连接 gauge 做数值对比。原 live/history/score 与 MAX-9/30/37 相关测试在完整 gate 通过；没有改动这些消费方源码或旧 ID。

## 限制、回退与资源

- PG/Oracle/DM 未做实库验证；fixture 只证明匹配版本响应适配。超时参数交给宿主原生驱动执行端口，未声称 generic 包装器可以撤销目标 SQL。
- Counter epoch 由可信资源驱动提供；MySQL 集成使用一次发现并固定的 uptime 启动证据，重启/统计重置语义由确定性 fixture 验证。部署时须由驱动维护 stats_reset/FLUSH STATUS 等证据，不能每次制造新 epoch。
- 尚未开启生产 V2 采集或新消费 UI；没有生产写入。CI 由 PR 触发，状态独立于本地通过证据，交付评论记录当时状态。
- 回退为撤销代表包绑定、恢复原 pin/旧来源并停止对应调度；保留历史与状态，不删表。跨包切换按既有规则使 counter 重新基线。
- 硬预算未设定，子代理0、最大深度0、并发代理峰值1；实际 input/cached input/output token 与费用遥测不可用，不以内部计数冒充实测。
