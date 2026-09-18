# 数据库代表指标接入（MAX-71）

内部入口：`apps/db-ops-api/src/metrics-v2/database/index.ts`。使用 `createDatabaseRegistry()` 替代宿主注入的 registry，可同时识别原有不可变包和四个新代表包。`databaseReleases()` 返回精确 id/version/digest；通过现有 PolicyService 发布选择，再由 MAX-70 MetricScheduler 与既有 Worker 运行。未在生产 `server.ts` 启用另一条采集循环，不切换旧正式来源。

## 接入契约

1. 资源发现/授权层将 `db.engine`、`db.version`（真实版本字符串）写入 `MysqlMetricStorage.writeInventory`，向 PolicyService 和 CollectorAccess 返回同一资源。版本是属性，不是观测或维度；关联 Host 不复制为 DB 指标。
2. PolicyService 与 MetricScheduler 使用同一个 `createDatabaseRegistry()`；资源凭据仍为引用，解析器只返回已授权目标连接。目标 MySQL 使用现有 `bindMySql`，mysql2 建议 `supportBigNumbers: true, bigNumberStrings: true`。
3. PG/Oracle/DM 使用 `bindDatabaseDriver(execute)` 包装可信驱动端口：`execute(sql, timeoutMs)` 返回驱动原生 `{rows}`。PG 是对象行，Oracle/DM 是数组行。端口须由宿主设置原生有界执行（Oracle 独占连接的 callTimeout、PG server statement_timeout、DM 原生连接/语句超时），保持连接直到在途请求实际收敛；本包装器不声称实现 driver 取消，也不以 Promise.race 提前释放在途连接。配置文件不能传入 execute 或 SQL。
4. CollectorAccess 提供稳定的 `evidence.counter`：MySQL 必须含 server startup / FLUSH STATUS 等重置证据，PG 必须含启动与当前数据库 stats_reset，Oracle/DM 含实例启动/统计重置证据。不能每次用“现在减 uptime”生成漂移 epoch；持久保留驱动确认的同一 epoch。缺证据时 counter 被公共校验拒绝，健康 gauge 仍保留。驱动检测到无值下降的重置也必须更新 epoch。
5. 调度、配置 revision、租约 fencing、取消、迟到隔离、状态与观测事务均继续由公共链路负责。每条实际 SQL 前沿用 runner 的取消检查。库存写入归资源发现，不借采集提交绕过其独立权限。

数据库代表包默认 60s、timeout 5s，容量扫描标为 high cost，遵循资源显式周期，不另设高频循环。MySQL 每批5条 SQL（原 status 共享读取2个指标，加连接、限额、事务共享读取、容量）；PG4条；Oracle/DM3条。权限要求随不可变包发布，来源是授权账号可见范围；要取得完整 MySQL processlist/非系统 schema 数据，账号需具备包中列出的可见性权限。缺行、NULL、权限失败不会补151/300/500等默认值。

## 语义边界与 MAX-63 映射

|引擎|连接/容量 gauge|事务 counter 与派生|大小与可比边界|
|---|---|---|---|
|MySQL|`mysql.processlist.count`、`mysql.connections.limit`|`mysql.transaction_commands.commit_total` / `rollback_total`，各自 `_rate`；`completed_rate` 先逐 counter 处理重置再相加|`mysql.tables.estimated_allocated_bytes`：非系统 schema 可见 data_length+index_length，`accuracy=estimated`，不是逻辑大小/主机磁盘|
|PostgreSQL|`postgresql.activity.count`（含后台 backend）、`postgresql.connections.limit`（客户端限额）|`postgresql.transactions.commit_total` / `rollback_total` 及各自 rate、completed_rate；均有 `database` 维度|`postgresql.database.disk_bytes` 是当前库物理文件，不映射 MySQL 分配统计或逻辑字节|
|Oracle|`oracle.sessions.count`、`oracle.processes.limit`|`oracle.transactions.commit_total` / `commit_rate`；不含 rollback|绑定实例/container 的 V$ 视图；processes 不是 sessions 容量，不合成利用率|
|DM|`dameng.sessions.count`、`dameng.sessions.limit`|`dameng.transactions.commit_total` / `commit_rate`；不含 rollback|不将旧 disk=45 占位值升级为测量，也不扩大表空间诊断范围|

MAX-63 的 outcome 维度候选在本包实现为独立 commit/rollback Extension ID，以保持公共 same_resource_and_dimensions DAG 对每个 counter 独立重置后合并，不先累加两个累计值。范围和单位仍为 count/count/s，含义写入各 Definition；不得映射为一个跨引擎事务 Canonical。

MySQL 保留 MAX-67 已发布的 `mysql.queries.total` / `mysql.queries.per_second`（MAX-63 statements 候选的已有命名决定），不重写旧包；其 Queries 含存储程序语句，绝不与 PG xact_commit 强行当作 QPS。唯一数据库 Canonical 代表继续为 `db.uptime_seconds`；MySQL 5.7/8.0/8.4 fixture 证明同一含义、同一契约。原 package pins/digest 不变。

版本资格保守限定：MySQL 5.7、8.0、8.4；PG 16.4；Oracle 19.3；DM 8.1。仍按现有 major.minor applicability 契约匹配后续补丁段；未列家族 unsupported，缺版本 unknown，在 I/O 前拒绝。PG/Oracle/DM fixture 是对应版本原生响应形状的**合成**样本，不是厂商实库兼容认证，不外推到其他版本。

## 失败、精度与血缘

- 固定 SQL 与允许的 implementation_ref 保存在代码里，包只包含映射。纯数值 counter 使用 uint64 字符串；Oracle/DM 在 SQL 中转为字符串，拒绝损失精度的 Number、负数、溢出。
- 每个 Collector 独立 attempt。单查询失败保留其他查询；同一 status 的一个标量缺失只丢该字段，并标记 partial；空行集/重复字段为 parse_error，不能变成真实零。
- 原有 timeout capability 缓存、首次基线 null、重启 reset、间隔缺口与配置切换规则不变。事务总速率由有效同窗口的两个 rate 求和，任一缺失不会用0补齐。
- 所有输出经公共 normalize/Counter/Derived，保留 package/transform/config 版本和 raw/normalized 血缘；数据库作用域公式只在匹配维度组执行，禁止向实例级组广播。
- 估算 allocation 仅 accuracy=estimated；production=measured 表示读到源端统计，不等于 exact。NULL 对应 unknown。没有新增 CPU/内存启发式或把关联 Host 资源值当 DB 利用率。

## 验证与回退

[fixture](fixtures.json)、[发布契约](releases.json)、[执行契约](plan.md)、[验收证据](validation.md)。旧 collector、database-service、历史/评分代码未修改；回归由原测试及新旧 connection 数值对比覆盖。

回退：停用代表包绑定并恢复原 pin/旧来源，宿主停止对应调度注册，保留历史与 counter 状态；切换 package 会按既有规则重置基线。不删除数据，不修改 schema，无生产发布。本项交付可注入现有链路的包/适配与闭环证据；新 UI、告警、Agent 统一消费归 MAX-75，整体联调归 MAX-76。
