# 逐项迁移映射 v1

版本统一 `1.0.0-candidate.1`。C=Canonical Metric，E=Extension Metric，I=资源属性/inventory；G=gauge，K=counter，S=string/enum 属性。每行是候选决策，旧 API 暂保留；“废弃”禁止新契约采纳其假语义，不删除历史。未注明的维度为 `{}`，作用域是单个资源；E 默认仅同引擎、同公式/版本可比，C 仅在本行限定相同口径下跨实现可比。I 不参与时序聚合。时间聚合 G 默认 last（窗口 avg/max 按消费需求显式选择），K 必须先按基线差分，不直接 sum 样本。

来源简称均在 `apps/db-ops-api/src/`：M=`collectors/mysql.provider.ts`，P=`collectors/postgresql.provider.ts`，O=`collectors/oracle.provider.ts`，D=`collectors/dameng.provider.ts`，RT=`database-service.ts`，S=`server-metric-provider.ts`+`server-collector.ts`，N=`network-devices/huawei-adapter.ts`。成本 SQL1/2 表示一次采样的 SQL 次数；表扫描/统计视图规模另标。RT 一次取整个快照（多个 SQL），并非按单字段一次请求；各字段成本仅描述来源子查询。默认定时间隔见 inventory.json；不得将默认值当有效配置。

作用域补充：MySQL GLOBAL STATUS/VARIABLES 与 Oracle/DM V$ 统计是实例级；MySQL 表大小跨非系统 schema 聚合。PG pg_stat_activity 是集群可见 backend 范围，pg_stat_database 查询有 current_database 过滤，pg_stat_user_tables 与 pg_database_size 是当前数据库范围，后三者新身份要求 `database` 维度（旧无维度，仅可在绑定数据库确定时恢复；否则保留 legacy scope）。Oracle 表空间 max 为实例上的表空间集合归约，DM buffer 固定 pool=0；集合过滤条件属于语义版本。host 指标不能因实例与主机关联而复制成 db 指标。

类型补充：表中 G/K 是审核后的真实/候选类型；原注册类型、aggregation、默认间隔另见 inventory.json。counter 先求差、再按同时间窗口合并不重叠维度；百分比必须保留分母与过滤口径，不跨不同容量简单平均。无raw基线的旧rate不能逆推出counter。

## 数据库：公共旧 ID 的引擎分流

|旧 ID / 引擎|分类/处置 → 新 ID|类型/单位|实际口径、来源与成本；理由|
|---|---|---|---|
|cpu_usage / mysql|E 拆分 → mysql.legacy.cpu_estimate_percent|G %，estimated|M/RT SQL2，min(100,round(Threads_running/max_connections*60+20))；非 CPU 时间|
|cpu_usage / postgresql|E 拆分 → postgresql.active_capacity_percent|G %，estimated|P/RT SQL2，active/max_connections*100；非 CPU|
|cpu_usage / oracle|E 拆分 → oracle.active_session_process_limit_percent|G %，estimated|O/RT SQL2，ACTIVE sessions/processes；分子分母对象不同，不准入资源利用率|
|cpu_usage / dameng|E 拆分 → dameng.active_session_capacity_percent|G %，estimated|D/RT SQL2，ACTIVE sessions/max_sessions；非 CPU|
|memory_usage / mysql|E 拆分 → mysql.innodb.pool_used_percent|G %|M/RT SQL1，(pages_total-pages_free)/pages_total；仅 buffer pool，缺省回退不算有效观测|
|memory_usage / postgresql|E 废弃 → postgresql.legacy.memory_estimate_percent|G %，estimated|P/RT SQL1，active/max(1,total)*50+20；不是内存|
|memory_usage / oracle|E 废弃 → oracle.legacy.memory_estimate_percent|G %，estimated|O/RT SQL2，PGA 错误混合量纲公式与表空间比例加权；不是内存|
|memory_usage / dameng|E 拆分 → dameng.memory.pool_used_percent|G %|D/RT collectDamengMemoryUsage SQL1，SUM(DATA_SIZE)/SUM(TOTAL_SIZE)；V$MEM_POOL，非物理内存；保留 MAX-30 null|
|disk_usage / mysql,postgresql|E 废弃 → mysql.legacy.disk_estimate_percent / postgresql.legacy.disk_estimate_percent|G %，estimated|M/P SQL1，round(已舍入 GiB/10*100)，上限95；10GiB 假定容量，不是磁盘利用率|
|disk_usage / oracle|E 拆分 → oracle.tablespace.max_used_percent|G %|O SQL1 聚合 DBA_DATA_FILES/DBA_FREE_SPACE；RT 排除 SYSTEM/SYSAUX，O 未排除，必须区分 source/filter 版本，不直接别名|
|disk_usage / dameng|E 废弃 → dameng.legacy.disk_placeholder_percent|G %，estimated|D/RT 固定45，成本0；无测量证据|
|connections / mysql|E 拆分 → mysql.processlist.count|G count|M/RT SQL1 COUNT(PROCESSLIST)，非仅 active；不与其他引擎 session/backend 合并|
|connections / postgresql|E 拆分 → postgresql.activity.count|G count|P/RT SQL1 COUNT(pg_stat_activity)，集群可见 backend 行，非仅 active/client|
|connections / oracle|E 拆分 → oracle.sessions.count|G count|O/RT SQL1 COUNT(V$SESSION)，包括非活跃/后台会话|
|connections / dameng|E 拆分 → dameng.sessions.count|G count|D/RT SQL1 COUNT(V$SESSIONS)，不是 OS 进程|
|qps / mysql|E 拆分 → mysql.statements.rate|G statements/s，derived|M/RT SQL1 Queries 差分；含存储程序中的语句，非 Questions 请求数|
|qps / postgresql|E 拆分 → postgresql.transactions.commit_rate|G transactions/s，derived|P/RT SQL1 当前数据库 xact_commit 差分，不是查询|
|qps / oracle|E 拆分 → oracle.executions.rate|G executions/s，derived|O/RT SQL1 V$SYSSTAT execute count 差分；RT 首次 executes/100 回退不可升级|
|qps / dameng|E 拆分 → dameng.sql_executions.rate|G executions/s，derived|D/RT SQL1 V$SYSSTAT sql executed count 差分；保留引擎边界|
|tps / mysql|E 拆分 → mysql.transaction_commands.rate|G commands/s，derived|M/RT SQL1 Com_commit+Com_rollback 差分；不等于包含 autocommit 的所有事务|
|tps / postgresql|E 拆分 → postgresql.transactions.completed_rate|G transactions/s，derived|P/RT SQL1 当前数据库 xact_commit+xact_rollback 差分|
|tps / oracle,dameng|E 拆分 → oracle.transactions.commit_rate / dameng.transactions.commit_rate|G transactions/s，derived|O/D SQL1 user commits / transaction commit count；不含 rollback；RT Oracle 首次回退不可升级|
|slow_queries / mysql|E 保留 → mysql.slow_queries.total|K count|M/RT SQL1 Slow_queries 累计，受 long_query_time 等配置影响；旧 sum 不可继续|
|slow_queries / postgresql,oracle,dameng|E 废弃 → legacy.unsupported.slow_queries|G count（旧占位）|P/O/D/RT 固定0，不能当真实零；不自动注册跨引擎新指标|
|data_size_gb / mysql|E 拆分 → mysql.tables.estimated_allocated_bytes|G bytes，estimated|M/RT SQL1 information_schema.tables 扫描，非系统 schema 的 data_length+index_length；旧 GiB*2^30 仅近似|
|data_size_gb / postgresql|E 拆分 → postgresql.database.disk_bytes|G bytes|P/RT SQL1 pg_database_size(current_database())，数据库维度必须附数据库名；旧 GiB 只有0.01精度|
|health_score|E 保留 → slide.health.score|G score 0..100，derived|RT health checks + scoring-service，查询量依引擎；算法/权重 revision 必须随结果保存，非引擎性能指标|
|active_transactions / mysql|E 拆分 → mysql.innodb.transactions.active|G count|RT SQL1 COUNT(INNODB_TRX)，不是连接数|
|active_transactions / postgresql|E 拆分 → postgresql.transactions.open|G count|RT SQL1 pg_stat_activity WHERE xact_start IS NOT NULL；包含 idle in transaction，不等于正在执行的会话|
|active_transactions / oracle,dameng|E 拆分 → oracle.sessions.active / dameng.sessions.active|G count|RT ACTIVE 会话，同 active_sessions，不是事务|
|max_connections / mysql|E 保留 → mysql.connections.limit|G count|RT SHOW max_connections SQL1，配置限值|
|max_connections, connections_max / postgresql|E 别名 → postgresql.connections.limit|G count|P/RT SHOW max_connections SQL1，不能作为所有 backend 数的严格容量|
|max_connections, connections_max / oracle|E 拆分 → oracle.processes.limit|G count|O/RT V$PARAMETER processes SQL1，是进程限额，不是会话限额|
|max_connections, connections_max / dameng|E 别名 → dameng.sessions.limit|G count|D/RT max_sessions SQL1，缺省500不可冒充观测|
|version, db_version|I 别名 → db.version|S string|RT VERSION()/version()/V$INSTANCE 等 SQL1；无聚合|
|db_type|I 别名 → db.engine|S string|资源配置，0额外请求|
|is_estimated|I 保留 → legacy.row_estimated|boolean 元数据|旧行级提示，非 metric kind；不能推广到每一项|
|uptime_seconds / mysql|C 别名 → db.uptime_seconds|G seconds|RT SHOW GLOBAL STATUS Uptime，共享状态查询，实例启动至今；不求差；首期 DB 代表|

## 数据库：已有扩展及别名（不新增厂商范围）

|旧 ID / 引擎|分类/处置 → 新 ID|类型/单位|实际口径、来源与成本；理由|
|---|---|---|---|
|buffer_pool_hit_rate, innodb_buffer_pool_hit_rate / mysql|E 别名 → mysql.innodb.buffer_hit_percent|G %|M/RT SQL1，1-physical_reads/read_requests，累计比值；不等于短窗口命中率|
|table_open_cache_hit_rate / mysql|E 保留 → mysql.table_cache.hit_percent|G %|M/RT SQL1 hits/(hits+misses)，忽略 overflow|
|handler_read_rnd_next / mysql|E 保留 → mysql.handler.read_rnd_next_total|K count|M/RT SQL1 原计数；不能标成完整表扫描次数|
|handler_read_rnd_next_rate / mysql|E 别名 → mysql.handler.read_rnd_next_rate|G operations/s，derived|M/RT 同计数差分，provider 每指标单查|
|key_blocks_usage / mysql|E 保留 → mysql.myisam.key_blocks_used_percent|G %|M/RT SQL1 used/(used+unused)，零分母旧返回0|
|open_files / mysql|E 保留 → mysql.files.open|G count|M/RT SQL1 Open_files|
|aborted_connects / mysql|E 保留 → mysql.connections.failed_total|K count|M/RT SQL1 Aborted_connects，不是当前拒绝数|
|aborted_connects_rate / mysql|E 别名 → mysql.connections.failed_rate|G connections/s，derived|M/RT 同累计值差分|
|threads_running / mysql|E 保留 → mysql.threads.running|G count|M/RT SQL1 Threads_running，非 OS process|
|threads_connected / mysql|E 保留 → mysql.threads.connected|G count|M/RT SQL1 Threads_connected；与 PROCESSLIST 不强行别名|
|bytes_received, bytes_sent / mysql|E 拆分 → mysql.network.bytes_total|K bytes，direction=in/out|M/RT SQL1 Bytes_received/Bytes_sent；DB 协议流量，非主机所有网络|
|queries_total / mysql|E 别名 → mysql.statements.total|K statements|M/RT SQL1 Queries|
|commits_total, rollbacks_total / mysql|E 拆分 → mysql.transaction_commands.total|K commands，outcome=commit/rollback|M/RT SQL1 Com_commit/Com_rollback|
|innodb_row_lock_time_avg / mysql|E 保留 → mysql.innodb.row_lock_wait_avg_ms|G ms|RT SQL1 Innodb_row_lock_time_avg，源端累计平均|
|innodb_deadlocks / mysql|E 保留 → mysql.innodb.deadlocks_total|K count|RT SQL1 Innodb_deadlocks|
|tmp_table_on_disk / mysql|E 保留 → mysql.temp_tables.disk_total|K count|RT SQL1 Created_tmp_disk_tables，不是当前临时表个数|
|thread_cache_hit_rate / mysql|E 保留 → mysql.thread_cache.hit_percent|G %|RT 共享状态查询，1-Threads_created/Connections|
|replication_lag / mysql|E 保留 → mysql.replication.lag_seconds|G seconds|RT SHOW SLAVE STATUS SQL1；无复制/权限失败旧0不可判定同步|
|replication_status / mysql|E 保留 → mysql.replication.status|G enum|RT 同上，running/stopped/error；不是资源属性，运行状态需要时间|
|cache_hit_ratio, cache_hit_rate / postgresql|E 别名 → postgresql.blocks.hit_percent|G %|P SQL2（列发现+统计），RT 共享查询；blks_hit/(blks_hit+blks_read)，当前数据库|
|idx_scan_ratio / postgresql|E 保留 → postgresql.scans.index_percent|G %|P/RT SQL1 pg_stat_user_tables 聚合，idx/(idx+seq)，非行比例|
|dead_tuples / postgresql|E 保留 → postgresql.tuples.dead_estimate|G count，estimated|P/RT SQL1 SUM(n_dead_tup)，当前数据库用户表|
|connections_used / postgresql|E 别名 → postgresql.activity.count|G count|P/RT SQL1，同 connections|
|vacuum_count, autovacuum_count / postgresql|E 拆分 → postgresql.tables.vacuum_seen / postgresql.tables.autovacuum_seen|G tables|P/RT SQL1 COUNT(last_* IS NOT NULL)，不是 vacuum 次数；registry 默认不采集|
|replication_lag_seconds / postgresql|E 保留 → postgresql.replay.age_seconds|G seconds|P/RT SQL1 now()-pg_last_xact_replay_timestamp；空闲时间不等于复制积压，NULL/失败旧0不可升级|
|xact_commit, xact_rollback / postgresql|E 拆分 → postgresql.transactions.total|K transactions，outcome=commit/rollback；database|RT pg_stat_database 共享 SQL，不能同 MySQL command counter 合并|
|tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted / postgresql|E 拆分 → postgresql.tuples.total|K count，operation=returned/fetched/inserted/updated/deleted；database|RT 同 pg_stat_database 共享 SQL；returned 与 fetched 不能相加为唯一行数|
|blk_read, blk_hit / postgresql|E 拆分 → postgresql.blocks.total|K blocks，operation=read/hit；database|RT 同共享 SQL，不能未经 block size 换算 bytes；缺列旧0不可升级|
|temp_files / postgresql|E 保留 → postgresql.temp_files.total|K files；database|RT pg_stat_database 共享 SQL|
|deadlock_count / postgresql|E 拆分 → postgresql.deadlocks.total|K count；database|RT pg_stat_database deadlocks；不同于 Oracle 同名|
|lock_wait_count / postgresql|E 保留 → postgresql.legacy.lock_wait_count|G count（未确认）|RT 检查 pg_stat_database 非标准列，缺列写0；不准入 Canonical，实际类型需能力证据|
|tablespace_usage / oracle|E 保留 → oracle.tablespace.max_used_percent|G %|O SQL1，所有表空间 max，见公共 disk_usage 行|
|tablespace_usage_percent / oracle|E 拆分 → oracle.user_tablespace.max_used_percent|G %|RT SQL1 排除 SYSTEM/SYSAUX；与 O 不同过滤，不能直接别名|
|sga_hit_rate, shared_pool_hit_rate / oracle|E 别名 → oracle.buffer_cache.hit_percent|G %|O/RT SQL1，1-physical reads/(db block gets+consistent gets)；实际不是整个 SGA/shared pool|
|pga_cache_hit_rate / oracle|E 废弃 → oracle.legacy.pga_hit_percent|G %，estimated|RT SQL1 将 physical reads 次数与 session pga memory 字节相加，异量纲；不作有效缓存命中率|
|library_cache_hit_rate / oracle|E 保留 → oracle.library_cache.hit_percent|G %|RT SQL1 SUM(pinhits)/SUM(pins)|
|deadlock_count, enqueue_deadlocks / oracle|E 别名 → oracle.locks.blocking_count|G count|O/RT SQL1 COUNT(V$LOCK WHERE BLOCK=1)，不是死锁累计|
|active_sessions / oracle|E 别名 → oracle.sessions.active|G count|O/RT SQL1 V$SESSION STATUS=ACTIVE|
|sga_size_mb, pga_size_mb / oracle|E 拆分 → oracle.sga.bytes / oracle.pga.allocated_bytes|G bytes|O/RT SQL1 V$SGA / V$PGASTAT，旧 MiB*2^20 且有舍入误差|
|dm_buffer_hit_rate / dameng|E 保留 → dameng.buffer_pool.hit_percent|G %|D/RT SQL1 V$BUFFERPOOL ID=0 RAT_HIT*100；固定 pool0，需 pool 身份|
|dm_lock_wait / dameng|E 拆分 → dameng.locks.blocking_count / dameng.locks.count|G count|D/RT SQL1，失败再 SQL1 回退到全表 COUNT；旧值无来源时不能确定哪种语义|
|dm_deadlock_count / dameng|E 保留 → dameng.deadlock_history.count|G count|D/RT SQL1 COUNT(V$DEADLOCK_HISTORY)，受历史保留/清理影响，不保证单调|
|dm_paged_memory_usage / dameng|E 别名 → dameng.memory.pool_bytes|G bytes|RT SQL1 V$SYSSTAT memory pool size in bytes；不是百分比|
|dm_os_memory_usage / dameng|E 别名 → dameng.memory.from_os_bytes|G bytes|RT SQL1 V$SYSSTAT memory used bytes from os；不是整个主机内存|

## Server

|旧 ID|分类/处置 → 新 ID|类型/单位；维度|实际口径、来源与成本；理由|
|---|---|---|---|
|cpu_usage|E 拆分 → linux.cpu.user_system_percent|G %|S top 一次命令 user+system，不含全部非 idle 状态，不能承诺通用 CPU busy|
|memory_usage|E 保留 → linux.memory.free_used_percent|G %|S free 一次命令 used/total；free 版本 used 定义需随包版本固定|
|memory_used|C 别名 → host.memory.used_bytes|G bytes|S free -b 一次命令；准入须声明 used 定义及工具版本，禁止与 available 推导口径混合|
|memory_total|C 别名 → host.memory.total_bytes|G bytes|S free -b 一次命令物理总内存|
|disk_usage|C 拆分 → host.filesystem.used_percent|G %；mount/device/fs_type|S 文件系统批次，使用 OS 报告 usagePercent（df used/(used+available) 含舍入），不是 used/size；资源总量必须单独定义，不能平均各挂载点|
|disk_usage_<mount>|C 别名 → host.filesystem.used_percent|G %；mount（其余可能未知）|历史编码名称，规范化挂载点；同时间新维度数据优先，不双计；无法恢复 device/fs_type 不伪造|
|filesystem_size_bytes|C 别名 → host.filesystem.size_bytes|G bytes；mount/device/fs_type|S df 文件系统批次，总容量|
|filesystem_used_bytes|C 别名 → host.filesystem.used_bytes|G bytes；mount/device/fs_type|S 同批次，已用字节；Server 首期代表|
|filesystem_available_bytes|C 别名 → host.filesystem.available_bytes|G bytes；mount/device/fs_type|S 同批次，非特权用户可用；不必等于 size-used|
|filesystem_inode_usage|C 别名 → host.filesystem.inode_used_percent|G %；mount/device/fs_type|S inode df 批次；无 inode 的 FS 为 unsupported|
|load_1min, load_5min, load_15min|E 拆分 → linux.load.1m / linux.load.5m / linux.load.15m|G load|S 各一条 /proc/loadavg 命令，不是百分比、不除 CPU 核数|
|swap_usage|E 保留 → linux.swap.used_percent|G %|S free 一次命令 used/total，无 swap 旧0与真实0需区分|
|uptime|C 别名 → host.uptime_seconds|G seconds|S /proc/uptime 一次命令，主机启动时长，不当 counter|
|os_type|I 拆分 → host.os.type|S string|registry 有定义但 S 不发数值；server 资源字段为来源|
|network_rx_bytes, network_tx_bytes|C 拆分 → host.network.bytes_total|K bytes；interface/direction=in/out|S /proc/net/dev 同一次命令，rx/tx→in/out；registry 缺省 gauge 错位；不可跨接口名重建续基线|
|network_rx_errors, network_tx_errors|C 拆分 → host.network.errors_total|K count；interface/direction=in/out|S 同批次，每方向错误累计|
|network_rx_drops, network_tx_drops|C 拆分 → host.network.drops_total|K count；interface/direction=in/out|S 同批次，每方向丢弃累计|
|disk_read_bytes, disk_write_bytes|C 拆分 → host.disk.bytes_total|K bytes；device/direction=read/write|S /proc/diskstats 同一次命令，扇区*512；分区/整盘不能重叠 sum|
|disk_io_time_ms|E 别名 → linux.disk.io_time_ms_total|K ms；device|S 同 diskstats，I/O busy 时间，不是请求延迟|
|process_count|C 别名 → host.process.count|G count|S ps 全进程一次命令；与 DB session 区分|
|top_processes_cpu|E 保留 → linux.process_sample.max_cpu_percent|G %|S ps top20 一次命令，原单进程 CPU 已截断100；不是主机CPU|
|top_processes_memory|E 保留 → linux.process_sample.max_memory_percent|G %|S 与 top_processes_cpu 共享 ps；按CPU选出的20项内存最大，不是全机内存最大|
|disk_detail|I 保留 → host.filesystems.snapshot|结构化 inventory|S 内部 df 批次名，不是注册数值指标；数值字段按 filesystem_* 映射|

旧 Server 网络维度最多128接口，块设备256，process证据20项，字符串128字符。filesystem 的 mount/device/fs_type 保持完整；名称只是身份的一部分，未来应引入资源/接口世代，不能把改名当同一 counter 连续性。

## 网络设备

|旧 ID|分类/处置 → 新 ID|类型/单位；维度|实际口径、来源与成本；理由|
|---|---|---|---|
|device_reachability|C 别名 → network.device.reachable|G state 0/1|资源服务由最近 probe 状态合成；collector 更新设备状态，并非直接写此 observation；必须携带检查时间/协议，不表示业务可用|
|device_uptime_seconds|C 别名 → network.management.uptime_seconds|G seconds|N sysUpTime ticks*0.01，系统 scalars 单批 GET；管理子系统重启可能不同于设备重启|
|device_cpu_percent|E 保留 → huawei.device.cpu_percent|G %|N 可选版本化厂商 OID，同批 GET；默认无 OID，unknown/mib_unsupported；不扩容|
|device_memory_percent|E 保留 → huawei.device.memory_percent|G %|N 同上，厂商分母需 MIB fixture 证明，不能与主机 memory 混合|
|device_temperature_celsius|E 保留 → huawei.device.temperature_celsius|G °C|N 同上，传感器位置需版本化证据|
|interface_oper_status|C 别名 → network.interface.oper_up|G state 0/1；if_index/interface|N IF-MIB ifOperStatus，up→1/down→0/其他→null；保留接口身份|
|interface_in_bps, interface_out_bps|C 拆分 → network.interface.traffic_bps|G bit/s，derived；if_index/interface/direction=in/out|N IF-MIB 64/32 bit octets 差分/秒*8；单接口表遍历，最多2000行；不是 counter|
|interface_error_rate|C 别名 → network.interface.errors_rate|G errors/s，derived；if_index/interface/direction=in/out|N ifInErrors/ifOutErrors 差分；registry 描述只写入方向但实际含双向|
|interface_drop_rate|C 别名 → network.interface.drops_rate|G drops/s，derived；if_index/interface/direction=in/out|N ifInDiscards/ifOutDiscards 差分；双向，不丢 direction|
|speedBps / speed_bps|I 别名 → network.interface.speed_bps|number bit/s；if_index|N ifSpeed；属性分母，0/饱和值不可算利用率；当前无 ifHighSpeed 来源|
|model, osVersion / os_version|I 保留 → network.device.model / network.device.os_version|S string|资源配置/探测，0额外指标请求；不构造成 metric|
|ifName, ifAlias, ifIndex|I 保留 → network.interface.name / alias / index|S string/整数|N 接口表，与设备 ID 关联；别名不作无限维度|

`network.interface.utilization_percent` 是尚未实现的 C 派生候选（旧 ID：无），G %，身份 if_index/direction；同时间 traffic_bps/speed_bps*100。它不在首期必采集集合；只有已有容量证据有效时可计算。SNMP 表 GET 与原始 64位值不得经 JS Number 丢精度；fixture 用十进制字符串。

## 自定义与不支持路径

`collection_sqls`/`compute_expr` 的旧 ID 原样保留，分类 E、作用域继承 target_type；类型/单位/维度/语义不能仅凭名字推断。自定义 SQL 的单次查询成本与结果基数须审核，不给未审脚本 Canonical 身份。当前 DB providers 仅 mysql/postgresql/oracle/dameng；架构中的 Redis/MongoDB/Elasticsearch 不代表这些引擎已有本路径指标，不能从 registry 的泛化描述补造映射。
