# 唯一指标能力与依赖清单

本清单对应 MAX-189 实现；机器可读完整包、定义、口径、单位、维度和引用见 `unified-metrics-capabilities.json`。类型声明不是支持证明，`mapped` 只是等价引用映射；实际可用还取决于包、版本、权限、epoch、来源验收及新鲜度。历史策略数据不被覆盖，阈值不自动转换。

## 包覆盖

| 包 | 语义版本 | 输出定义数 |
|---|---|---|
| mysql-basic | 1.0.0 | 7 |
| linux-basic | 1.0.0 | 7 |
| if-mib-basic | 1.0.0 | 5 |
| linux-host | 1.0.0 | 11 |
| mysql-basic | 2.0.0 | 5 |
| mysql-representative | 1.0.0 | 15 |
| postgresql-representative | 1.0.0 | 13 |
| oracle-representative | 1.0.0 | 9 |
| dameng-representative | 1.0.0 | 9 |
| mysql-basic | 1.1.0 | 8 |
| oracle-representative | 1.1.0 | 10 |
| dameng-representative | 1.1.0 | 10 |
| mysql-diagnostics | 1.0.0 | 29 |
| postgresql-diagnostics | 1.0.0 | 19 |
| oracle-diagnostics | 1.0.0 | 16 |
| dameng-diagnostics | 1.0.0 | 14 |
| linux-host | 1.1.0 | 24 |
| snmp-standard | 1.0.0 | 20 |

## 原注册项及 Provider 额外入口逐项映射

覆盖64个注册项及四类数据库 Provider 的额外 case（去重后 106 个资源/引擎/引用）。`待复核` 包含原本伪比例、常数、单位或维度变化；不代表把原始数据删除。

| 资源/引擎 | 原引用 | 等价引用（无阈值转换） |
|---|---|---|
| mysql | cpu_usage | 待复核 |
| postgresql | cpu_usage | 待复核 |
| dameng | cpu_usage | 待复核 |
| oracle | cpu_usage | 待复核 |
| mysql | memory_usage | 待复核 |
| postgresql | memory_usage | 待复核 |
| dameng | memory_usage | 待复核 |
| oracle | memory_usage | 待复核 |
| mysql | disk_usage | 待复核 |
| postgresql | disk_usage | 待复核 |
| dameng | disk_usage | 待复核 |
| oracle | disk_usage | 待复核 |
| mysql | connections | mysql.processlist.count |
| postgresql | connections | postgresql.activity.count |
| dameng | connections | dameng.sessions.count |
| oracle | connections | oracle.sessions.count |
| mysql | qps | mysql.queries.per_second |
| postgresql | qps | 待复核 |
| dameng | qps | 待复核 |
| oracle | qps | 待复核 |
| mysql | tps | 待复核 |
| postgresql | tps | 待复核 |
| dameng | tps | 待复核 |
| oracle | tps | 待复核 |
| mysql | slow_queries | 待复核 |
| postgresql | slow_queries | 待复核 |
| oracle | slow_queries | 待复核 |
| mysql | buffer_pool_hit_rate | mysql.buffer_pool.read_hit_percent |
| mysql | health_score | 待复核 |
| postgresql | health_score | 待复核 |
| dameng | health_score | 待复核 |
| oracle | health_score | 待复核 |
| mysql | table_open_cache_hit_rate | mysql.table_cache.hit_percent |
| mysql | handler_read_rnd_next | 待复核 |
| mysql | handler_read_rnd_next_rate | 待复核 |
| mysql | key_blocks_usage | mysql.key_cache.used_percent |
| mysql | open_files | mysql.files.open |
| mysql | aborted_connects | 待复核 |
| mysql | aborted_connects_rate | 待复核 |
| postgresql | idx_scan_ratio | postgresql.tables.index_scan_percent |
| postgresql | dead_tuples | postgresql.tables.estimated_dead_rows |
| postgresql | cache_hit_ratio | postgresql.database.block_hit_percent |
| postgresql | connections_used | postgresql.activity.count |
| postgresql | vacuum_count | postgresql.tables.manually_vacuumed |
| postgresql | autovacuum_count | postgresql.tables.autovacuumed |
| postgresql | replication_lag_seconds | 待复核 |
| mysql | data_size_gb | 待复核 |
| postgresql | data_size_gb | 待复核 |
| oracle | tablespace_usage | oracle.tablespaces.max_allocated_used_percent |
| oracle | sga_hit_rate | oracle.buffer_cache.hit_percent |
| oracle | deadlock_count | 待复核 |
| server | cpu_usage | linux.cpu.user_system_percent |
| server | memory_usage | linux.memory.used_percent |
| server | memory_used | linux.memory.used_bytes |
| server | memory_total | linux.memory.total_bytes |
| server | disk_usage | 待复核 |
| server | filesystem_size_bytes | host.filesystem.size_bytes |
| server | filesystem_used_bytes | host.filesystem.used_bytes |
| server | filesystem_available_bytes | linux.filesystem.available_bytes |
| server | filesystem_inode_usage | linux.filesystem.inode_used_percent |
| server | load_1min | linux.load.one_minute |
| server | load_5min | linux.load.five_minutes |
| server | load_15min | linux.load.fifteen_minutes |
| server | swap_usage | linux.swap.used_percent |
| server | uptime | linux.uptime.seconds |
| server | os_type | 待复核 |
| server | network_rx_bytes | 待复核 |
| server | network_tx_bytes | 待复核 |
| server | network_rx_errors | 待复核 |
| server | network_tx_errors | 待复核 |
| server | network_rx_drops | 待复核 |
| server | network_tx_drops | 待复核 |
| server | disk_read_bytes | 待复核 |
| server | disk_write_bytes | 待复核 |
| server | disk_io_time_ms | 待复核 |
| server | process_count | linux.processes.count |
| server | top_processes_cpu | linux.processes.sample_max_cpu_percent |
| server | top_processes_memory | linux.processes.cpu_sample_max_memory_percent |
| network_device | device_reachability | 待复核 |
| network_device | device_uptime_seconds | snmp.agent.uptime_seconds |
| network_device | device_cpu_percent | 待复核 |
| network_device | device_memory_percent | 待复核 |
| network_device | device_temperature_celsius | 待复核 |
| network_device | interface_oper_status | 待复核 |
| network_device | interface_error_rate | 待复核 |
| network_device | interface_drop_rate | 待复核 |
| network_device | interface_in_bps | snmp.interface.rx_bits_per_second |
| network_device | interface_out_bps | snmp.interface.tx_bits_per_second |
| mysql | threads_running | mysql.threads.running |
| mysql | threads_connected | mysql.threads.connected |
| mysql | bytes_received | 待复核 |
| mysql | bytes_sent | 待复核 |
| mysql | queries_total | 待复核 |
| mysql | commits_total | 待复核 |
| mysql | rollbacks_total | 待复核 |
| postgresql | cache_hit_rate | 待复核 |
| postgresql | connections_max | 待复核 |
| oracle | connections_max | 待复核 |
| oracle | active_sessions | 待复核 |
| oracle | sga_size_mb | 待复核 |
| oracle | pga_size_mb | 待复核 |
| dameng | connections_max | 待复核 |
| dameng | slow_queries | 待复核 |
| dameng | dm_buffer_hit_rate | dameng.buffer_pool.hit_percent |
| dameng | dm_lock_wait | 待复核 |
| dameng | dm_deadlock_count | 待复核 |

## 原始数值能力及非等价决定

- MySQL：连接数/上限、Queries、commit/rollback、数据估计分配字节、慢查询累计、协议收发累计、Handler_read_rnd_next、Aborted_connects、buffer pages、threads、Open_files、key blocks 和三种缓存/块占比纳入 diagnostics。counter 的精确累计与可信 epoch 替代内存 Number 差分，旧首样本零速率不能导入；新鲜率未知不补零。mysql-basic@2.0.0 仍只表达其冻结的 uptime 能力；正常推荐使用版本适配包，不能改写已有 digest。
- PostgreSQL：activity/连接上限、当前数据库 commit/rollback、数据库磁盘字节、dead tuples 估计、index scan 比例、block hit、vacuum/autovacuum 表数量和最后 replay 年龄可采。原 qps 实际为 commit rate，不改名成查询吞吐；最后 replay 年龄不等价实际复制延迟；vacuum_count 不是事件计数。
- Oracle：会话/进程上限、commit、execute、active sessions、SGA/PGA 分配字节、buffer cache hit、最大已分配表空间使用比例、blocking locks 可采。processes 不是会话容量；原 deadlock_count 是 BLOCK=1 锁数；旧 SGA SQL 使用不存在 bytes 列，改用 V$SGA.value。旧 MiB 四舍五入和排除 SYSTEM/SYSAUX 的诊断口径不自动迁移为含系统表空间的标准口径。
- 达梦：会话/上限、commit/execute、memory pool 占比、buffer pool ID0 命中率、blocking locks、保留死锁历史行数可采。原锁等待 fallback 会改为全表计数，拒绝视为等价；保留历史行数不是自启动累计死锁。
- 数据库 cpu_usage 多为会话比例或带基数估算，disk_usage 包含固定10GiB分母/常数45，memory_usage 多为复合估计。不得映射 Host CPU、主机内存或文件系统容量；原 health_score 和动态阈值须复核，缺失为 unknown。
- Linux：原 CPU user+system、free 内存、uptime/load1/5/15、swap、进程数、top20 CPU样本的最大CPU/内存、逐挂载bytes/available/inode纳入 linux-host@1.1.0。filesystem used_ratio 是 used/size，区别 df 舍入百分比；fs_type/mount/device 为序列身份，拒绝无维度阈值猜选。network bytes/errors/drops 区分 interface、rx/tx和事件；block bytes/io time 需要可信 boot/device epoch，不导入旧 Number 累计与 in/out 维度。os_type 是 inventory。
- SNMP：uptime、admin/oper状态、速度及逐接口/方向的octets/errors/discards和对应速率纳入 snmp-standard。旧 state 枚举不自动等同布尔 up；合并双方向错误/丢包阈值需复核。默认 vendor enterprise OID 为空时 CPU/内存/温度原本没有可用来源，保持 unsupported。reachability 是资产连接探测，不伪造正式数值指标。服务器旧“超过十分钟不可达”由单个旧status时间推断，不能证明连续窗口；兼容hook停用该推断，既有告警保留，不自动恢复。
- 原CustomSQL经可信catalog审核后编译为不可变包，在唯一runner内执行；GET config/resources/instance/:id/migration及status给出未审核/不安全/表达式/旧模板宏的稳定阻塞码和迁移步骤。审核、激活与正式可见分开，详见专项兼容记录。MongoDB/Redis/Elasticsearch有资产类型，不代表已有固定SQL指标包。

## 非周期旧诊断 DTO 字段兼容整改

Chief预审后的逐字段原实现证据、有效能力/错误来源/不兼容语义分类、唯一实现与验证见 `unified-metrics-compatibility-review-2026-10-17.md`。不能再将这些字段整批声明为错误或未来新增能力。

MySQL行锁平均ms、死锁/临时磁盘表累计、线程缓存、活动事务、分通道复制lag与IO/SQL状态；PG当前库元组/块/temp/deadlock累计、活动事务及独立当前锁等待定义；Oracle library-cache和不含SYSTEM/SYSAUX的原表空间口径；DM两项原生内存字节和活动会话，已纳入diagnostics@1.1.0。四个1.0.0保持原digest。PG累计通过单语句绑定stats_reset/startup和database_oid；未知epoch不虚构。Oracle伪PGA比例、PG非标准lock_wait_count、DM把活动会话称事务等逐项保留语义差异与迁移动作。版本、db_type等元数据不混入数值指标。

## 唯一执行与消费者

| 依赖 | 当前接线 | 历史保留/边界 |
|---|---|---|
| 写入者 | MetricScheduler + WorkerRuntime，唯一 metric_observations/attempts writer | collector/server/network/monitor 为兼容适配；旧具体实现仅 migrations/metric-history；手动试采不写正式publication |
| 配置与策略 | activate→试采→CAS发布→scheduler apply→source verification→formal publication | 发布/应用/正式可见分层；组列表逐资源授权过滤 |
| 资源/API/Agent | MetricConsumerService、resourceMetricRead、FormalObservationService、query_metrics | exact uint64保留；旧number DTO拒绝精度损失和维度歧义；无fallback |
| 告警/恢复/基线 | evaluateOperationalRule、正式revision基线 | 无正式引用/epoch/coverage不触发或恢复；原阈值和告警记录保留 |
| 健康/评分/一致性 | 正式指标；不可证实评分项unknown | 资产连接探测独立；不把连接成功或旧复合分数当正式健康 |
| 报告/诊断/预测 | 正式consumer及来源/时间/coverage | slow_queries与capacity的结构化明细仍独立保留，不是第二套周期数值来源；容量分母无来源时unsupported |
| 历史与迁移 | 原表、lineage/audit/revision保留，121原子改名 | source-history仅检查历史来源存在；同实际响应旧解析对照不增加远端请求，不是独立双源周期 |

## 验证边界

MySQL 9.6 正常配置、旧来源对照、至少三正式周期、暂停/恢复及正式API已真实运行；迁移在独立MySQL8.4 schema验证。PG/Oracle/DM为固定响应/解析测试，不能称真实远端通过。Linux真实VM验收尚被SSH认证失败阻塞；fixture不能替代。人工读屏/VoiceOver听读不列为门禁。
