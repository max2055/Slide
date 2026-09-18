# MAX-65：MySQL 增量存储与兼容边界

基线 `main@7cba40c` 包含 MAX-64 的合并提交 `980d236`（[PR #76](https://github.com/max2055/Slide/pull/76)）。契约及 fixture 直接导入 `apps/db-ops-api/src/contracts/metrics-v2/`。不依赖 MAX-66，不接管采集接入、来源发布控制或查询 HTTP API。

## 存储与调用

- `apps/db-ops-api/sql/migrations/098_metric_v2_storage.sql` 仅新增三张表。旧 migration、runner、旧表和现有 API 返回结构未修改。
- `apps/db-ops-api/src/metrics-v2/storage.ts` 的 `MysqlMetricStorage` 是内部持久化边界，由已授权的调用服务传入 mysql2 pool。每次 `write(observation, definition)` 使用 MAX-64 校验器检查定义、单位、整数范围、维度、质量和幂等 ID。
- Canonical/Extension 共用表、校验和读写方法。完整 JSON 存储 value、dimensions、source、versions、counter 和 lineage。int64/uint64 是十进制字符串，不经 Number 或 MySQL 浮点类型；stored_at 由适配器首次写入，UTC 毫秒时间。
- `latest(series)` 仅返回 normalized 的 good/partial 非空值；`range(series, from, to, limit)` 保留 unknown/invalid 空值。失败 attempt 只写 attempt 表，不改变观测。latest 依据 observed_at，迟到数据不替代新值；同一时刻按 ID 确定排序，不据此推断配置发布优先级。
- `writeAttempt` 在事务内串行化初始插入及 running→terminal 转换，terminal 不可改写。`writeInventory` 独立存储属性，逐属性保留较新时间，等时不同值报冲突。
- 观测主键复用 MAX-64 的 `observationIdentity`。相同 ID 的并发重试只保存一行；规范化时间/键顺序后比较 payload hash，不同值拒绝。重复写不刷新 stored_at 或原始证据期限。
- `seriesIdentity` 的资源类型、资源 ID、指标 ID、语义版本、排序维度共同生成索引哈希，配置、包、转换版本作为每条观测 provenance 保存。来源鉴别、跨批维度基数预算和资源授权仍由调用计划/服务执行，不把裸存储接口暴露给外部请求。

## 旧数据与切换/回退

`apps/db-ops-api/src/metrics-v2/compatibility.ts` 提供 `MetricStorageAdapter`，默认 `{read:'legacy', write:'legacy'}`。调用者显式传入旧读写函数，不自动别名映射或反向转换数字。

| 模式 | 行为 |
|---|---|
| legacy read | 原旧行数值、时间、维度，附 `provenance.contract=legacy`、来源表、空语义版本/revision 和 `unknown/legacy_unknown`；不把旧质量推断为 exact |
| v2 read | 使用明确 V2 series；没有 V2 数据返回 null/空数组，不悄悄混入不等价旧值 |
| legacy write | 仅调用旧写入函数 |
| shadow write | 先旧写入，再 V2 写入；V2 错误向上传递，不宣称双写事务或 exactly-once |
| v2 write | 仅写 V2；不把 64 位整数转 Number 写回旧列 |

旧行无需批量改写或伪造 Raw；进入新兼容读边界时明确标记 legacy。现有旧 API 原样保留。接入方从 legacy→shadow→v2 显式创建适配器，测试通过后才切读；本项不默认启用任何业务接入。shadow 重试要求旧写回调自身幂等。

回退：停止接入方 V2 写入，重新构建 `{read:'legacy',write:'legacy'}` 适配器并恢复旧采集；暂停调用 `prune`，保留三张新增表。无需 DROP/逆向 DDL，历史旧值未被修改。V2-only 期间的值不能保证可无损写回旧 API，回退后旧路径可能暂时陈旧，应按原时间展示。保留期限缩短前备份，已删除数据只能从备份恢复，修改期限无法恢复 payload。

## 证据、脱敏与期限

Raw 只保存契约内的单项数值、白名单维度、原字段标识、来源与版本。严格 schema 拒绝额外 SQL/SNMP 响应字段；不保存全响应、SQL 文本、连接串、密码或 Token。调用方必须在产生 Raw 前选择允许的字段，并用不含秘密的资源/维度标识；结构校验不是任意文本的秘密检测器。观测 JSON 超过 65,536 字节拒绝。

默认 Raw payload 7 天；normalized、Raw 身份 tombstone 30 天；attempt 7 天。Raw 到期即 `evidence(id) → expired`，即使维护尚未执行也不再返回 payload；`prune(limit≤1000)` 清空 payload，保留 hash/身份直至历史期限。最终清理后返回 `not_retained`，不得视为有效证据。Normalized 的 lineage 引用保留，读取者必须解析每条引用的证据状态。到期重试不恢复证据；幂等去重保证覆盖保留窗口，窗口外重放由调用方禁止。

维护由授权任务显式调度；本项不引入后台 job。每次最多更新 1000 个 raw payload，并分别删除 1000 个超期 raw、normalized、attempt。可调 `rawMs/historyMs/attemptMs`，必须是正安全整数且 raw≤history。暂停维护保留物理数据，但不延长已记录证据的可用截止时间。inventory 保留当前资源属性，资源删除由资源生命周期管理接入。

## 容量与索引

公式：每日点数 = 资源数 × 每资源序列数 × 86400 / 周期秒。序列数包含维度展开，不能只数指标名。

MAX-64 的 8 条 normalized fixture 紧凑 JSON 实测 825–1030 字节，均值 896；raw fixture 750 字节。这是 fixture 字节数，不是 InnoDB 实测容量或生产吞吐。100 资源 × 10 序列 × 60 秒：16.7 点/秒、144 万点/天；30 天 normalized JSON 约 38.71 GB，7 天同频 Raw JSON 约 7.56 GB。加上 tombstone、attempt、行开销、四个二级索引和碎片，按至少 2 倍规划约 93 GB，另留备份空间。实际实例/磁盘容量未在本项确定；上线前必须用实际序列数与表大小复核，不能据此承诺生产规模。

索引：主键防重复；`(series_hash,stage,valid_value,observed_at,id)` 支持 latest；`(series_hash,stage,observed_at,id)` 支持范围；`(stage,stored_at)` 和 `(stage,evidence_expires_at)` 支持清理。MySQL 8.0 在 300 行有效/无效混合样本中对范围查询误选 latest 索引并 filesort，因此范围查询显式使用 `idx_metric_v2_range`。验收对实际查询形状 EXPLAIN，要求 latest/range 各使用对应索引且无 filesort。不引入分区、汇总或新时序数据库。

## 迁移与显式恢复

沿用 main 的 MigrationRunner。098 使用普通 CREATE TABLE，重跑成功 migration 的测试若意外执行 DDL 会直接失败；不可用 IF NOT EXISTS 掩盖重复执行。

真实恢复顺序：停止同库迁移竞争，检查 ledger 的 checksum/status/statement_index 与 SHOW CREATE TABLE；备份；比对当前 098 的每条 DDL，仅人工执行缺失部分；验证所有列、索引与独立全新库一致；以记录 checksum 绑定的只读 verifier 调用现有 `acknowledgeExternallyRepairedMigration(id, actor, reason)`，最后重跑 runner。不要删生产 ledger、改历史 SQL 或跳过 verifier。本项未给生产授权。

自动化恢复实验在隔离库预造第二张冲突表，确认第一条 DDL 已提交、statement_index=1；重跑被拒绝；完成剩余 DDL，验证三表全部列和索引后显式确认，再重跑成功。实验删除 ledger/表仅用于制造隔离故障，不是恢复操作指导。

## 复现验收

仓库根目录，独立空密码 localhost MySQL（不能指向业务库）：

```bash
docker run --name slide-max65-mysql -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -p 127.0.0.1:13365:3306 -d mysql:8.0
# 待 MySQL ready 后执行；测试自建 max65_<PID> 和升级库，结束删除自建库。
METRICS_V2_TEST_MYSQL_PORT=13365 pnpm --filter slide-api exec vitest run src/metrics-v2/storage.mysql.test.ts
pnpm --filter slide-api exec vitest run src/contracts/metrics-v2/contracts.test.ts tests/migration-runner.test.ts src/resources/resource-service.test.ts src/resources/resource-routes.test.ts tests/phase-94-docs-structure.test.ts
pnpm --filter slide-api typecheck
python3 docs/slide/metrics-v2/v1/verify.py
docker stop slide-max65-mysql
```

未设置测试端口时，实库测试会 skip；skip 不是验收通过。测试覆盖全链新库和升级、legacy 原值/时间、runner 重跑、部分 DDL 故障恢复、三资源及 Extension、int64/uint64 边界、并发幂等冲突、质量/尝试分离、版本维度隔离、证据期限和 inventory、索引计划。HTTP 兼容由现有资源路由回归覆盖，实库兼容使用现有 ObservationService/Store。

最终命令结果见同目录 `validation.md`。本项未运行生产发布、真实采集源接入或生产容量压测。
