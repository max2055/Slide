# 数据库列表容量（MAX-131）

列表从 `POST /api/metrics-v2/query` 的 `view: core, latest_capacity: true` 读取容量；`database_size` 是产品列键，实际指标 ID 按引擎选择。各指标保持独立语义，不做跨引擎合计。

| 引擎 / 已限定版本 | 指标 ID | 范围与语义 | 采集包 |
| --- | --- | --- | --- |
| MySQL 5.7 / 8.0 / 8.4 | `mysql.tables.estimated_allocated_bytes` | 当前账号可见非系统库的 `data_length + index_length`；估算分配空间，受元数据权限限制 | `mysql-representative@1.0.0` 或新增 `mysql-basic@1.1.0` |
| PostgreSQL 16.4 | `postgresql.database.disk_bytes` | `pg_database_size(current_database())`；当前连接数据库的物理文件大小，保留 database 维度 | `postgresql-representative@1.0.0` |
| Oracle 19.3 | `oracle.datafiles.allocated_bytes` | 当前容器 `DBA_DATA_FILES.BYTES` 合计；永久数据文件已分配空间，含系统表空间 | 新增 `oracle-representative@1.1.0` |
| 达梦 8.1 | `dameng.datafiles.allocated_bytes` | 当前数据库 `DBA_DATA_FILES.BYTES` 合计；永久数据文件已分配空间，含系统表空间 | 新增 `dameng-representative@1.1.0` |
| 其他 | 无 | 暂不支持；Redis 内存不当磁盘大小 | 无 |

Oracle/达梦不含临时文件、日志、备份，不代表已使用空间或自动扩展上限。查询要求 `SELECT DBA_DATA_FILES`。MySQL 使用既有固定 SQL，不把 `SUM(NULL)`、空库或不可见元数据转换为零。所有容量值采用 `uint64` 十进制字符串与 `By` 单位，UI 使用 1024 进制 B/KiB/MiB/GiB；小值不经过 GB 舍入。

## 配置与兼容

既有 `1.0.0` 采集包、digest 和绑定保持不变。缺少容量映射的旧包显示“未配置”，需使用现有指标配置预览、试采、发布流程选择相应新版本；本变更不自动升级运行实例。正式展示仍遵循现有 rollout 的 shadow / 接受 / V2 发布边界，未接收的 shadow 数据不会变成列表容量。首次绑定 PostgreSQL 时按实际 series 预算设置 `max_rows`（受控验收使用 10）。

采集沿用 MetricScheduler → Worker → 固定容量 SQL → 持久化 → 正式发布。列表翻页与刷新只读管理端指标存储，不连接托管数据库、不执行容量 SQL。`latest_capacity` 不与历史时间窗口混用；普通历史查询保持原有语义。最新容量只取已应用正式 V2、对应配置 revision、查询时刻之前的样本。返回 `observed_at` 是容量自身采集时间，不是其他采集器的成功时间。

无样本显示“暂无有效值”；未配置、停用、权限不足、采集失败、不支持分别展示。真实零显示 `0 B`。超出有效期仍保留旧值并标记“已过期”；失败或能力待确认的旧值以“上次”标识，权限不足和停用隐藏旧值。版本不适用由原有 capability 规则判定。

## 验证

- 前端 focused：`pnpm --filter slide-frontend exec vitest run src/app/ui/components/database-size.test.ts src/app/ui/components/resource-metrics-table.test.ts`
- 后端 focused：`pnpm --filter slide-api exec vitest run src/metrics-v2/database/capacity.test.ts src/metrics-v2/consumers/capacity.test.ts src/metrics-v2/database/database.test.ts src/metrics-v2/consumers/service.test.ts`
- 真实集成：启动隔离 MySQL 8.4（root 空密码）与 PostgreSQL 16.4（本地 trust）后，执行 `METRICS_V2_TEST_MYSQL_PORT=13371 MAX131_TEST_PG_PORT=15471 MAX131_EVIDENCE_DIR=../../docs/slide/metrics-v2/database-size pnpm --filter slide-api exec vitest run src/metrics-v2/database/capacity.mysql.test.ts`。测试自行建立与清理数据库/账号，推进调度时钟完成两个周期，不替换真实数据库 SQL 或返回值。
- 集成覆盖：写入 4 KiB 负载、周期采集、shadow 隔离、正式发布、SQL / HTTP / 桌面与移动列表逐值一致、小于 0.01 GiB 非零、数据库名称维度、容量自身时间、过期、403、配置 revision / legacy 读隔离、刷新和翻页容量 SQL 计数不增加。
- Oracle/达梦的固定 SQL、驱动数组解析、uint64 精度、NULL 和拒绝访问已由 focused tests 验证；本次未连接真实 Oracle/达梦实例，不将它们计入真实数据库验收。

`evidence.json` 与 `database-size.png` 是本次隔离集成验收产物，不含凭证。
