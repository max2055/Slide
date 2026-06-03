# Phase 96: Oracle Database Support - Context

**Gathered:** 2026-05-19
**Status:** Ready for planning

## Phase Boundary

为 Slide 添加 Oracle 数据库的完整纳管能力：连接管理、指标采集、SQL 控制台（PL/SQL 方言）、实例详情。代码库已有 Oracle 后端实现（database-service.ts 中完整的连接、指标、慢查询、健康检查、EXPLAIN、容量、会话方法），本阶段主要是注册/启用 Oracle 到剩余触点 + 前端 CodeMirror 方言 + 连接池升级。

**In scope**: 连接管理（TCPS + 连接池）、指标采集（8 通用 + 3 Oracle 专属）、SQL 控制台（PL/SQL CodeMirror 方言 + 增强补全）、实例详情页、Agent 工具（4 个扩展现有 + 3 个新增 Oracle 专属）。

**Out of scope**: Slow Query 慢查询分析（已实现，直接启用）、QAN 查询分析（已实现，直接启用）、PDB/CDB 多租户、Oracle RAC 集群。

## Implementation Decisions

### 指标注册与采集
- **D-01:** Oracle 添加到全部 8 个内置指标的 db_types 数组（connections, qps, tps, cpu_usage, memory_usage, disk_usage, health_score, slow_queries）。
- **D-02:** 新增 3 个 Oracle 专属内置指标：tablespace_usage（表空间使用率 %）、sga_hit_rate（SGA 命中率 %）、deadlock_count（死锁数）。注册模式对齐 buffer_pool_hit_rate。
- **D-03:** 间隔/阈值按 metric-registry 各自定义管理，沿用默认配置。

### CodeMirror 方言
- **D-04:** 创建独立 OracleDialect（SQLDialect.define()），包含完整 PL/SQL 关键字 + Oracle 系统视图（V$SESSION, V$SQL, DBA_TABLESPACES, DBA_DATA_FILES 等）+ 常用函数（NVL, DECODE, TO_CHAR, TO_DATE 等）。结构对齐 DamengDialect。
- **D-05:** sql-console.ts 实例选择逻辑新增 `db_type === 'oracle' → OracleDialect` 分支。
- **D-06:** autocomplete 基于 OracleDialect 增强：系统视图、函数、PL/SQL 关键字补全。

### 实例详情页
- **D-07:** 复用现有 6 tab 布局（概览、监控、TopSQL、慢查询、容量、会话），与 Dameng D-03 一致。不新增 Oracle 专属 tab。
- **D-08:** 概览 tab 展示 Oracle 版本 + SGA 大小 + PGA 大小 + 表空间总数/使用率。

### Agent 工具
- **D-09:** 扩展 4 个现有工具的 db_type 枚举添加 `oracle`：test_connection、add_database、update_db_config、get_instance_summary。
- **D-10:** 新增 3 个 Oracle 专属 Agent 工具：oracle_ash_report（ASH 活跃会话历史报告）、oracle_awr_report（AWR 自动工作负载报告）、oracle_tablespace_detail（表空间使用详情）。
- **D-11:** ASH/AWR 报告保留 Oracle 原生 HTML 格式，支持在线分析和下载。

### 连接管理
- **D-12:** add-instance 表单新增单一"Oracle 数据库标识"字段，支持 SID 或 Service Name。oracledb Easy Connect 格式（host:port/database_identifier）自动判断。
- **D-13:** 强制 TCPS 加密连接（TLS）。代码支持但不强制证书验证 — 开发/测试环境可跳过 wallet 配置。
- **D-14:** 显式使用 oracledb.createPool() 替代单连接 getConnection()，使用默认池参数（poolMax=4, poolMin=0, poolTimeout=60s）。

### 功能范围
- **D-15:** 全部已有 Oracle 功能直接启用 — 慢查询、EXPLAIN、容量、会话查询、健康检查均在 database-service.ts 中已实现。
- **D-16:** monitor-collector 无需额外修改。Oracle 实例连接建立后通过 getAllInstances() → getRealtimeMetrics() → getOracleMetrics() 自动进入采集循环。
- **D-17:** 数据类型使用 oracledb 配置处理：fetchAsString 处理 NUMBER（避免精度丢失），fetchAsBuffer 处理 CLOB。
- **D-18:** 字符集依赖 oracledb 默认 NLS_LANG=AMERICAN_AMERICA.AL32UTF8，不做额外转换。

### 版本与兼容性
- **D-19:** 支持 Oracle 11g / 12c / 19c。11g 需要 oracledb Thick mode（Thin mode 最低 12.1），12c/19c 使用 Thin mode。
- **D-20:** 不支持 PDB/CDB 多租户架构。连接直接针对数据库实例。

### 测试验证
- **D-21:** 用户本地 Oracle 19c Docker 容器用于端到端验证。11g/12c 代码路径由单元测试和 schema 校验自行保证。

### Claude's Discretion
- Oracle 默认端口 1521（前端已有），db_type 标识使用 'oracle'
- CodeMirror OracleDialect 结构对齐 DamengDialect 模式（SQLDialect.define + keywords/builtin 两段）
- metric-registry 专属指标结构对齐 buffer_pool_hit_rate 注册模式
- oracle_ash_report / oracle_awr_report 工具内部使用 DBMS_WORKLOAD_REPOSITORY 包（Oracle 内置）

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing Oracle Backend Implementation (关键 — Oracle 后端已实现)
- `apps/db-ops-api/src/database-service.ts` — **主要参考**：完整的 Oracle 连接（L181-203）、指标采集 getOracleMetrics()（L779-892）、慢查询 getOracleSlowQueries()（L1162-1195）、健康检查 checkOracleHealth()（L1547-1720）、EXPLAIN getOracleExplainPlan()（L2173-2210）、容量 getOracleCapacity()（L2567-2610）、会话 getOracleActiveSessions()（L2360-2395）
- `apps/db-ops-api/src/sql-executor.ts` L49-51 — Oracle SQL 执行分支（conn.db_type === 'oracle' && conn.oracleConnection）
- `apps/db-ops-api/src/instance-database-service.ts` — db_type 联合类型（含 'oracle'）、Oracle 连接测试（L361-375）
- `apps/db-ops-api/src/monitor-collector.ts` — 采集调度，需确认 Oracle 已通过 getAllInstances() 进入采集循环

### 注册/启用目标文件
- `apps/db-ops-api/src/metric-registry.ts` — 所有内置指标的 db_types 数组需添加 'oracle'，新增 3 个 Oracle 专属指标
- `frontend/src/openclaw/ui/views/sql-console.ts` — CodeMirror OracleDialect 定义 + db_type 选择分支 + autocomplete 增强
- `frontend/src/openclaw/ui/views/instances-db.ts` — add-instance 表单新增 Oracle 数据库标识字段
- `frontend/src/openclaw/ui/views/instance-detail.ts` — 实例详情概览 tab Oracle 特有信息展示
- `apps/db-ops-api/src/tools/generated/slide-self-mgmt/test_connection.ts` — enum 添加 oracle
- `apps/db-ops-api/src/tools/generated/slide-self-mgmt/add_database.ts` — enum 添加 oracle
- `apps/db-ops-api/src/tools/generated/slide-self-mgmt/update_db_config.ts` — enum 添加 oracle
- `apps/db-ops-api/src/tools/ops/get_instance_summary.ts` — enum 添加 oracle

### 前端 API 类型
- `frontend/src/api/database.ts` — API 类型定义（已含 'oracle'），确认无需额外修改

### Phase 95 Analog
- `.planning/phases/95-dameng-database-support/95-CONTEXT.md` — Dameng 实现的参考模板（决策 D-03/D-04/D-06 模式可复用）

## Existing Code Insights

### Reusable Assets
- **database-service.ts getOracleMetrics()**: 已采集连接数、活跃会话、SGA 统计、Library Cache 命中率、PGA 内存、Shared Pool、表空间、死锁、版本 — 完整可用
- **database-service.ts checkOracleHealth()**: 14 项健康检查，含连接验证、SGA、表空间、Library Cache、死锁
- **sql-executor.ts Oracle 执行分支**: 使用 conn.oracleConnection.execute(sql) 执行 SQL
- **instance-database-service.ts Oracle testConnection()**: 动态 import oracledb + Easy Connect 格式连接
- **前端 instances-db.ts Oracle 选项**: 端口 1521，Oracle 选项已渲染

### Established Patterns
- MySQL/PostgreSQL/Dameng 的完整流程可作为 Oracle 注册的参考模板
- 每种数据库在 metric-registry 中都有对应的 db_types 数组
- CodeMirror DamengDialect 的 SQLDialect.define() 结构直接适用于 OracleDialect
- Agent 工具的 db_type 枚举扩展模式：在 enum 数组中添加 'oracle'

### Integration Points
- `metric-registry.ts` — Oracle 需添加到所有 db_types + 新增 3 个专属指标
- `sql-console.ts` — OracleDialect 注册 + db_type 选择分支
- `instances-db.ts` — 新增数据库标识字段
- `instance-detail.ts` — Oracle 概览数据展示
- `monitor-collector.ts` — 验证 Oracle 实例入采集循环（理论上无需修改）
- Agent 工具 — 4 个现有工具 enum 扩展 + 3 个新工具文件

## Specific Ideas

- OracleDialect 关键字应包含 PL/SQL 特有词：VARCHAR2, PLS_INTEGER, PACKAGE, PROCEDURE, FUNCTION, EXCEPTION, CURSOR, BULK, FORALL, RETURNING, ROWTYPE, TYPE, RECORD, VARRAY, NESTED TABLE, PIPELINED
- Oracle 系统视图应包含：V$SESSION, V$SQL, V$SQLAREA, V$SGA, V$PGASTAT, V$SYSSTAT, V$PARAMETER, DBA_TABLESPACES, DBA_DATA_FILES, DBA_USERS, V$INSTANCE, V$DATABASE, V$LOCK, V$DEADLOCK, V$SQL_PLAN, DBA_HIST_SQLTEXT, DBA_HIST_ACTIVE_SESS_HISTORY
- Oracle 数据库标识字段建议名为 `service_name`/`sid`，在 instance 表的连接配置 JSON 中存储
- 11g Thick mode 需要检测 oracledb.initOracleClient() 是否可用，必要时降级提示用户安装 Instant Client

## Deferred Ideas

- **PDB/CDB 多租户支持**: 用户确认目标客户环境未使用，暂不支持
- **Oracle RAC 集群**: 多节点连接管理和负载均衡，后续单独规划
- **Oracle Data Guard**: 主备切换和灾备监控，后续单独规划

---

*Phase: 96-oracle-database-support*
*Context gathered: 2026-05-19*
