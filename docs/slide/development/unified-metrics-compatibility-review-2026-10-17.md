# MAX-189 能力不回退整改证据

本记录回应 Chief 对 PR #202 / 6161fd26 的部分交付预审。实现仍在同一草稿 PR；本文不是独立审查批准、合并或真实 VM 验收。原私有 realtime 解析仍仅作历史比较，生产没有恢复第二周期。代码路径均相对仓库根目录。

## 非周期字段逐项核查

原实现证据为 `apps/db-ops-api/src/database-service.ts` 对应 `getMySQLMetrics/getPostgreSQLMetrics/getOracleMetrics/getDamengMetrics` 的查询与返回字段。唯一执行定义为 `src/metrics/database/diagnostics.ts`（均在 apps/db-ops-api 下）；新增内容发布 diagnostics@1.1.0，四个 1.0.0 的 digest 与 6161fd26 逐一相同。合法缺失、权限错误、没有对应版本视图时保留 unknown/NULL，不再补零或 100。

| 引擎／旧字段 | 原实现及确认分类 | 唯一实现／处置 |
|---|---|---|
| MySQL innodb_row_lock_time_avg | GLOBAL STATUS `Innodb_row_lock_time_avg`；有效原生 ms 快照 | `mysql.innodb.row_lock_average_ms`，ms；非区间平均 |
| MySQL innodb_deadlocks | GLOBAL STATUS `Innodb_deadlocks`；有效累计，旧 Number/epoch 不可信 | `mysql.innodb.deadlocks_total` 精确 counter；epoch 未知不生成率 |
| MySQL tmp_table_on_disk | GLOBAL STATUS `Created_tmp_disk_tables`；有效累计，不是比例 | `mysql.temporary.disk_tables_total`；同上 |
| MySQL thread_cache_hit_rate | `1-Threads_created/Connections`；有效累计比率，零分母补100错误 | `mysql.thread_cache.hit_percent`，零分母 NULL |
| MySQL active_transactions | INFORMATION_SCHEMA.INNODB_TRX 的 COUNT；有效快照 | `mysql.transactions.active`，要求 PROCESS |
| MySQL replication_lag | SHOW SLAVE STATUS 的 Seconds_Behind_Master；来源有效，但旧取首通道及 `NULL || 0` 错误；新版本移除旧拼写 | `mysql.replication.behind_source_seconds`，按 channel；SHOW REPLICA STATUS，仅明确语法不支持时用旧拼写，不对认证/超时重试；NULL 不变零 |
| MySQL replication_status | 根据 IO/SQL 字符串合成 running/stopped/error；枚举不可直接同布尔值 | 分成 `mysql.replication.io_running` / `sql_running`，Yes=1、No/Connecting=0；缺失 unknown；不把连接中称为故障原因已确认 |
| PG tup_returned | 当前库 pg_stat_database.tup_returned；有效累计 | `postgresql.database.tuples_returned_total`，保留 database 维度 |
| PG tup_fetched | 同上 tup_fetched；有效累计 | `postgresql.database.tuples_fetched_total` |
| PG tup_inserted | 同上 tup_inserted；有效累计 | `postgresql.database.tuples_inserted_total` |
| PG tup_updated | 同上 tup_updated；有效累计 | `postgresql.database.tuples_updated_total` |
| PG tup_deleted | 同上 tup_deleted；有效累计 | `postgresql.database.tuples_deleted_total` |
| PG blk_read | 来源为标准列 blks_read，旧别名；有效累计块数 | `postgresql.database.blocks_read_total`，count，非字节 |
| PG blk_hit | 来源为标准列 blks_hit，旧别名；有效累计块数 | `postgresql.database.blocks_hit_total` |
| PG temp_files | 当前库 pg_stat_database.temp_files；有效累计 | `postgresql.database.temp_files_total` |
| PG deadlock_count | 当前库 pg_stat_database.deadlocks；有效累计 | `postgresql.database.deadlocks_total` |
| PG lock_wait_count | 旧代码探测非标准 pg_stat_database.lock_wait_count，不存在则补0；在声明支持的标准PG16无该列 | 不等价迁入。新增 `postgresql.backends.waiting_for_lock`：当前 pg_stat_activity.wait_event_type='Lock' 数，单独定义，旧累计阈值不得自动套用 |
| PG active_transactions | pg_stat_activity.xact_start IS NOT NULL；有效可见会话快照（包括 idle in transaction） | `postgresql.transactions.active`，保留集群可见范围语义 |
| Oracle library_cache_hit_rate | V$LIBRARYCACHE SUM(PINHITS)/SUM(PINS)；有效比率，旧零分母未保护 | `oracle.library_cache.pin_hit_percent`；零分母 NULL |
| Oracle pga_cache_hit_rate | 旧公式将 physical reads 次数和 session pga memory 字节相加，维度不兼容 | 确认错误，不迁入伪比率。保留有效 `oracle.pga.allocated_bytes`；需要真实PGA命中语义时新定义，不复用原阈值 |
| Oracle shared_pool_hit_rate | 实际查询是 physical reads/(db block gets+consistent gets)，有效 buffer cache 口径，名称错 | 既有 `oracle.buffer_cache.hit_percent`；不将其声称 shared pool 命中率 |
| Oracle enqueue_deadlocks | 实际 COUNT V$LOCK WHERE BLOCK=1，来源有效但非死锁 | 既有 `oracle.locks.blocking`；语义差异保留，原死锁阈值须复核 |
| Oracle tablespace_usage_percent | DBA_DATA_FILES/FREE_SPACE，排除 SYSTEM/SYSAUX；有效，不能合并成含系统范围 | 新增 `oracle.tablespaces.user_max_allocated_used_percent`，与既有含系统口径并存为不同定义；无用户表空间 NULL |
| DM dm_paged_memory_usage | V$SYSSTAT NAME='memory pool size in bytes'；有效来源，旧名不准确 | `dameng.memory_pool.allocated_bytes`；没有统计行不补0 |
| DM dm_os_memory_usage | V$SYSSTAT NAME='memory used bytes from os'；有效来源 | `dameng.os.allocated_memory_bytes`；不作为主机总内存比例 |
| DM active_transactions | 实际 V$SESSIONS STATE='ACTIVE'；有效活动会话，非事务数 | `dameng.sessions.active`；不复用事务阈值 |

PG新增累计字段由 `postgres-counter.ts` 在**同一条语句**取得值、database_oid、startup、stats_reset、sampled_at；复用可信重置epoch，不能给新查询套旧事务查询结果。MySQL、Oracle、DM 仍按当前驱动提供的证据处理未知counter epoch，不伪造。

`compatibility.test.ts` 验证包增量、分通道/NULL、授权失败不回退查询、旧拼写只在语法拒绝后使用及PG精确累计/重置绑定。现有 diagnostics / database / packages / consumers / rollout 测试继续覆盖解析和正式路径。PG/Oracle/DM仍是解析和协议fixture验证，无真实远端服务证据，不写为实测通过。

## CustomSQL 与自定义模板

原 `collectors/custom-sql.provider.ts` 确有标量只读SQL能力：AST检查、标量包装、既有凭据、超时。因此不能只保留行而永远停用。核查同时确认旧Provider读取 `collection_sql`，但管理API/metric_definitions/metric-registry 保存 `collection_sqls[engine]`，且Oracle/DM共用 LIMIT 拼写。这些具体缺陷不能推定所有合法查询都无效。`compute_expr` 在当前基线只有CRUD/存储字段，无生产求值入口；不运行任意JS来“恢复”它。

本次新增 `database/reviewed-sql.ts`：审核后的SQL、完整Extension定义、单位/种类/含义、固定源digest、SELECT授权、引擎版本和review引用，编译为不可变包/implementation ID。只允许 scalar 单条只读SELECT；延用同一资源授权凭据/目标策略/专用有界session和MetricScheduler→runner→raw/attempt→source gate→publication→唯一查询。没有新增scheduler、writer或远端fallback。NULL与精确整数保留，多行、多列、不可信数字拒绝；未知epoch仍unknown。

可信审核产物入口是 `database/reviewed-sql-catalog.ts`，通过现有代码审查和部署流程安装，**不是HTTP任意SQL执行入口**。产品目录初始为空，没有替用户批准任何已有SQL。测试里的审核条目是隔离fixture，不是用户配置审批。包ID限定 `<engine>-custom-*`，继承准确引擎/版本的diagnostics base pin，不影响依赖现有包引擎约定的消费者。

已有配置迁移操作：

1. 资源管理者 GET `/api/metrics/config/resources/instance/:id/migration`，取得source ID/digest、稳定阻塞码和动作；status同时返回 `legacy_configuration` 和 `LEGACY_CONFIGURATION_REVIEW_REQUIRED`。只读用户不返回管理详情。无SQL、凭据或远端请求。
2. 通过已有授权的 `/api/metrics/registry/:id?target_type=instance` 导出原定义/`collection_sqls[engine]`。复核原生单位、聚合、scope、counter epoch、版本适配、只读授予和成本。源digest包含SQL、unit、kind、interval、compute_expr，变化重新审核。固定SQL审核继续走PR/部署；不能用填一个review字符串绕过代码审查。
3. 在可信catalog添加不可变manifest：`id/version/base{id,version,digest}/engine/source_id/source_digest/sql/definition/permissions/review{reference,reviewed_by}`。定义namespace=`custom`、ID=`custom.*`、资源级单标量；需多维度/派生或counter epoch而没有证据时保持明确阻塞，先冻结有证据的实现，不导入旧错误语义。
4. 部署后获取config/catalog精确pin；使用已有 trial/activate（expected_revision + pin + 已审核overrides）接续，显式将旧秒间隔映射到 interval_ms，停用和资产暂停优先级不变。再验证source gate和正式新样本。迁移状态 `reviewed` 只表示条目审核完成，**不表示已激活或正式出值**，仍标 `CUSTOM_SQL_ACTIVATION_REQUIRED`。
5. 原定义、宏和告警不删除；旧单位/语义不等价的阈值单独复核后发布CAS策略。危险SQL返回 `CUSTOM_SQL_UNSAFE`，未审核返回 `CUSTOM_SQL_REVIEW_REQUIRED`，无当前安全求值路径的表达式返回 `CUSTOM_EXPRESSION_REVIEW_REQUIRED`；均含可操作步骤。

`metric_templates` / `instance_templates`：`sql/schema.sql:1364` 已明确标记在 Phase130 废弃、表仅数据兼容，当前基线没有模板执行器；不是本PR新移除的有效周期能力。其曾保留的实例宏覆盖不能静默丢弃。本次迁移接口按**指定实例**列出保留绑定，返回 `TEMPLATE_MACROS_REVIEW_REQUIRED` 和导出宏→逐规则冻结定义→发布策略组/资源覆盖→核验后保留审计的路径，不重新运行废弃模板引擎。

旧“服务器超过10分钟不可达”由单个资产status推断连续窗口，不具备连续观测证据。暂不恢复该推断；连接探测和历史告警保留。若迁移该告警，需要明确的连续失败/恢复时间窗证据，不能以资产状态更新时间作为伪证明。

## 6161fd26 的全部 CI 结果分类

14项全完成，9成功、5失败；该head没有通过合并门禁。

| 失败检查 | 日志根因 | 归属／处置 |
|---|---|---|
| browser | `frontend/e2e/metric-settings.spec.ts` 导入已不存在 metrics-v2/config/registry.js | A/B组合依赖，B/PR200 a0dae5f8已中性路径；不恢复目录、不越界改B |
| browser-qualification | `max157-business.spec.ts:134` 断言92.4；fixture仅向旧metrics_history插入该值，现改为只读正式来源，不fallback | 受本批唯一来源变更影响的前端验收fixture依赖；ECONNRESET/模型禁用日志不是最终失败断言。交B/Chief使用正式publication fixture或正确unknown预期验证，不恢复旧读源 |
| recovery-qualification | startup-readiness.test.ts:187 首个环境变量 undefined，而期望true | 本PR部署改名遗漏：Compose/.env.production.example已改为METRICS_COLLECTION_ENABLED；retention变量同步中性化；不重新支持旧变量 |
| release-artifact | require all selected checks：browser失败 | 前置门禁拒绝打包的连带失败，不跳过 |
| ci-gate | selected checks中browser失败 | 汇总门禁连带失败，不降低门禁 |

9个成功：plan、security、backend、frontend、agent-core、sandbox-controller、investigation-api-qualification、investigation-rollout-qualification、rootless-sandbox-qualification。新head结果需另读，不能沿用为新head已绿。组合候选不是审定合入，VM认证仍无更新，不重试。
