# MAX-65 存储实施计划

> 按已授权范围执行，复用 MAX-64 契约及 main 的迁移能力。

目标：在 MySQL 提供 Raw/Normalized、attempt 和 inventory 的独立持久化边界，保留旧 API 与数据。
架构：新增 098 migration 与独立 MysqlMetricStorage；JSON 精确保存 uint64/int64 字符串；序列哈希索引和时间索引；原始观测短保留、过期 tombstone；兼容适配器显式选择 legacy/v2。
技术：TypeScript、mysql2、Vitest、MySQL 8。

范围 v1：仅存储、兼容适配、保留策略及隔离验证。不实现转换、采集接入、repair 重构、生产发布。基线 main 7cba40c，包含 MAX-64 合并提交 980d236。
硬预算未设定；实际 token/费用遥测不可用。主代理执行，不委派。停止条件：全部必要本地验收完成并提交 PR；真实外部阻塞则报告证据，不冒称验收通过。

1. 新增 `apps/db-ops-api/sql/migrations/098_metric_v2_storage.sql`：观测、attempt、资源属性表；不修改历史 migration。
2. 新增 `apps/db-ops-api/src/metrics-v2/storage.ts`：契约校验、原子幂等插入/冲突拒绝、稳定序列身份、有效值 latest/range、attempt 状态转换、原始证据到期清理、inventory。
3. 新增 `apps/db-ops-api/src/metrics-v2/compatibility.ts`：旧行明确 legacy 标签，不伪造语义/质量；显式读写模式与回退，不自动把 V2 大整数转 Number。
4. 新增 `apps/db-ops-api/src/metrics-v2/storage.mysql.test.ts`：使用 MAX-64 fixtures，隔离新库/升级、runner 重跑、部分失败与显式恢复、幂等冲突/并发、整数往返、来源版本、维度顺序、超时不刷新、证据清理、旧路径兼容和 EXPLAIN。
5. focused 测试后统一执行契约、迁移 runner、兼容及目录门禁；记录运行命令和真实结果到同目录 README。代码提交并提供 PR；不等待下游接入。
