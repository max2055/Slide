import type { MetricDefinition } from '../../contracts/metrics/index.js';
import { builtinReleases, canonicalDefinitions } from '../packages/builtins.js';
import { sealRelease, type ImplementationSpec, type PackageRelease } from '../packages/model.js';
import { databaseReads, databaseReleases, databaseVersions, implementationId, type DatabaseRead, type Engine } from './catalog.js';

function field(name: string, id: string, meaning: string, unit: MetricDefinition['unit'] = 'count', float = false) {
  const definition: Extract<MetricDefinition, { category: 'extension' }> = {
    category: 'extension', namespace: id.split('.')[0], id, semantic_version: '1.0.0', meaning, unit,
    resource_type: 'instance', scope: 'resource', kind: 'gauge', roles: ['diagnostic'], temporality: 'instant', monotonic: false,
    value_type: float ? 'float64' : 'uint64', dimensions: { keys: [], max_series_per_resource: 1, max_value_length: 128, overflow: 'reject' },
    aggregation: { time: ['last', 'min', 'max', 'mean'], space: ['none'], missing: 'preserve_null', min_coverage: 1, quantiles: 'not_applicable' }, lifecycle: 'active',
  };
  return { name, definition };
}
function counterField(name:string,id:string,meaning:string,unit:MetricDefinition['unit']='count'){
  const f=field(name,id,meaning,unit);f.definition.kind='counter';f.definition.monotonic=true;f.definition.temporality='cumulative';f.definition.aggregation.time=['last','rate'];return f;
}
// Fixed reads only. Unlike the historical providers these never invent zero/100 on NULL or errors.
const frozenDiagnosticReads: DatabaseRead[] = [
  ...databaseReads.filter(r=>r.engine==='mysql'&&['connections','limit','size','transactions'].includes(r.name)).map(r=>({...r,name:`diagnostics_${r.name}`})),
  {engine:'mysql',name:'diagnostics_queries',shape:'status',sql:"SHOW GLOBAL STATUS WHERE Variable_name='Queries'",permissions:['SHOW GLOBAL STATUS','authoritative counter epoch'],fields:[{name:'Queries',definition:builtinReleases()[0].extensions.find(d=>d.id==='mysql.queries.total')!}]},
  {engine:'mysql',name:'diagnostic_counters',shape:'status',sql:"SHOW GLOBAL STATUS WHERE Variable_name IN ('Slow_queries','Bytes_received','Bytes_sent','Handler_read_rnd_next','Aborted_connects')",
    permissions:['SHOW GLOBAL STATUS','authoritative lifecycle epoch for counter use'],fields:[
      counterField('Slow_queries','mysql.slow_queries.total','Slow_queries cumulative count; never an interval count or zero on failure.'),
      counterField('Bytes_received','mysql.protocol.received_bytes_total','Cumulative bytes received by the MySQL server; not host network traffic.','By'),
      counterField('Bytes_sent','mysql.protocol.sent_bytes_total','Cumulative bytes sent by the MySQL server; not host network traffic.','By'),
      counterField('Handler_read_rnd_next','mysql.handler.read_next_total','Cumulative Handler_read_rnd_next operations, not rows scanned during this interval.'),
      counterField('Aborted_connects','mysql.connections.aborted_total','Cumulative failed connection attempts; epoch required before a rate is calculated.'),
    ]},
  {engine:'mysql',name:'buffer_pages',shape:'object',sql:"SELECT 100*(MAX(CASE WHEN VARIABLE_NAME='Innodb_buffer_pool_pages_total' THEN CAST(VARIABLE_VALUE AS DECIMAL(30,0)) END)-MAX(CASE WHEN VARIABLE_NAME='Innodb_buffer_pool_pages_free' THEN CAST(VARIABLE_VALUE AS DECIMAL(30,0)) END))/NULLIF(MAX(CASE WHEN VARIABLE_NAME='Innodb_buffer_pool_pages_total' THEN CAST(VARIABLE_VALUE AS DECIMAL(30,0)) END),0) AS used FROM performance_schema.global_status WHERE VARIABLE_NAME IN ('Innodb_buffer_pool_pages_total','Innodb_buffer_pool_pages_free')",
    permissions:['SELECT performance_schema.global_status'],fields:[field('used','mysql.buffer_pool.pages_used_percent','Allocated non-free buffer-pool pages/total pages; not host or whole database memory utilization. NULL on missing/zero total.','%',true)]},
  { engine: 'mysql', name: 'uptime_diagnostics', shape: 'status', sql: "SHOW GLOBAL STATUS WHERE Variable_name='Uptime'",
    permissions: ['SHOW GLOBAL STATUS'], fields: [{name:'Uptime',definition:canonicalDefinitions[0]}] },
  { engine: 'mysql', name: 'diagnostic_gauges', shape: 'status',
    sql: "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_running','Threads_connected','Open_files','Key_blocks_used','Key_blocks_unused')",
    permissions: ['SHOW GLOBAL STATUS'], fields: [
      field('Threads_running', 'mysql.threads.running', 'Threads_running snapshot; excludes sleeping client threads, not host CPU.'),
      field('Threads_connected', 'mysql.threads.connected', 'Threads_connected snapshot; not host process utilization.'),
      field('Open_files', 'mysql.files.open', 'Open_files server status snapshot; not an OS descriptor limit.'),
      field('Key_blocks_used', 'mysql.key_cache.used_blocks', 'Key_blocks_used snapshot; not bytes or host memory.'),
      field('Key_blocks_unused', 'mysql.key_cache.unused_blocks', 'Key_blocks_unused snapshot; no synthetic capacity when zero.'),
    ] },
  { engine: 'mysql', name: 'diagnostic_ratios', shape: 'object',
    sql: `SELECT
      100 * (1 - MAX(CASE WHEN VARIABLE_NAME='Innodb_buffer_pool_reads' THEN CAST(VARIABLE_VALUE AS DECIMAL(30,0)) END) / NULLIF(MAX(CASE WHEN VARIABLE_NAME='Innodb_buffer_pool_read_requests' THEN CAST(VARIABLE_VALUE AS DECIMAL(30,0)) END),0)) AS buffer_hit,
      100 * MAX(CASE WHEN VARIABLE_NAME='Table_open_cache_hits' THEN CAST(VARIABLE_VALUE AS DECIMAL(30,0)) END) / NULLIF(SUM(CASE WHEN VARIABLE_NAME IN ('Table_open_cache_hits','Table_open_cache_misses') THEN CAST(VARIABLE_VALUE AS DECIMAL(30,0)) END),0) AS table_hit,
      100 * MAX(CASE WHEN VARIABLE_NAME='Key_blocks_used' THEN CAST(VARIABLE_VALUE AS DECIMAL(30,0)) END) / NULLIF(SUM(CASE WHEN VARIABLE_NAME IN ('Key_blocks_used','Key_blocks_unused') THEN CAST(VARIABLE_VALUE AS DECIMAL(30,0)) END),0) AS key_usage
      FROM performance_schema.global_status WHERE VARIABLE_NAME IN ('Innodb_buffer_pool_reads','Innodb_buffer_pool_read_requests','Table_open_cache_hits','Table_open_cache_misses','Key_blocks_used','Key_blocks_unused')`,
    permissions: ['SELECT performance_schema.global_status'], fields: [
      field('buffer_hit', 'mysql.buffer_pool.read_hit_percent', '1 minus cumulative physical reads/read requests at this snapshot; not interval cache hit rate. NULL for missing/zero denominator.', '%', true),
      field('table_hit', 'mysql.table_cache.hit_percent', 'Cumulative table cache hits/(hits+misses) at this snapshot; overflows are separate events and excluded. NULL for no requests.', '%', true),
      field('key_usage', 'mysql.key_cache.used_percent', 'Used key-cache blocks/(used+unused) snapshot; NULL for no configured blocks.', '%', true),
    ] },
  { engine: 'postgresql', name: 'table_diagnostics', shape: 'object',
    sql: `SELECT SUM(n_dead_tup) AS dead, 100.0*SUM(idx_scan)/NULLIF(SUM(idx_scan)+SUM(seq_scan),0) AS index_ratio,
      COUNT(*) FILTER (WHERE last_vacuum IS NOT NULL) AS vacuum_tables,
      COUNT(*) FILTER (WHERE last_autovacuum IS NOT NULL) AS autovacuum_tables FROM pg_stat_user_tables`,
    permissions: ['SELECT pg_stat_user_tables in bound database'], fields: [
      field('dead', 'postgresql.tables.estimated_dead_rows', 'SUM(n_dead_tup) estimate over visible user tables in current database; NULL on no tables.'),
      field('index_ratio', 'postgresql.tables.index_scan_percent', 'Cumulative idx_scan/(idx_scan+seq_scan) across current database user tables; not an index hit ratio.', '%', true),
      field('vacuum_tables', 'postgresql.tables.manually_vacuumed', 'Number of user tables whose last_vacuum is non-NULL; not vacuum event count.'),
      field('autovacuum_tables', 'postgresql.tables.autovacuumed', 'Number of user tables whose last_autovacuum is non-NULL; not autovacuum event count.'),
    ] },
  { engine: 'postgresql', name: 'cache_diagnostics', shape: 'object',
    sql: 'SELECT 100.0*blks_hit/NULLIF(blks_hit+blks_read,0) AS hit FROM pg_stat_database WHERE datname=current_database()',
    permissions: ['SELECT pg_stat_database'], fields: [field('hit', 'postgresql.database.block_hit_percent', 'Current database cumulative shared-buffer hits/(hits+disk reads); NULL for no block reads. Not OS cache hit rate.', '%', true)] },
  { engine: 'postgresql', name: 'replay_age', shape: 'object',
    sql: 'SELECT EXTRACT(EPOCH FROM (clock_timestamp()-pg_last_xact_replay_timestamp())) AS age',
    permissions: ['pg_last_xact_replay_timestamp'], fields: [field('age', 'postgresql.replication.last_replay_age_seconds', 'Age of last replayed transaction timestamp; NULL without replay. Increases on idle standby and is not actual replication lag.', 's', true)] },
  { engine: 'oracle', name: 'tablespace_diagnostics', shape: 'array',
    sql: `SELECT MAX((1-NVL(f.free_bytes,0)/NULLIF(d.bytes,0))*100) FROM
      (SELECT TABLESPACE_NAME,SUM(BYTES) AS bytes FROM DBA_DATA_FILES GROUP BY TABLESPACE_NAME) d
      LEFT JOIN (SELECT TABLESPACE_NAME,SUM(BYTES) AS free_bytes FROM DBA_FREE_SPACE GROUP BY TABLESPACE_NAME) f ON d.TABLESPACE_NAME=f.TABLESPACE_NAME`,
    permissions: ['SELECT DBA_DATA_FILES', 'SELECT DBA_FREE_SPACE'], fields: [field('usage', 'oracle.tablespaces.max_allocated_used_percent', 'Maximum used/allocated permanent tablespace ratio in bound container, including system; not autoextend max capacity.', '%', true)] },
  {engine:'oracle',name:'executions',shape:'array',sql:"SELECT TO_CHAR(VALUE, 'FM99999999999999999999') FROM V$SYSSTAT WHERE NAME='execute count'",permissions:['SELECT V_$SYSSTAT','authoritative startup epoch'],fields:[counterField('executes','oracle.sql.executions_total','Oracle V$SYSSTAT execute count in the bound instance/container; includes repeated executions, not transaction count.')]},
  {engine:'dameng',name:'executions',shape:'array',sql:"SELECT CAST(STAT_VAL AS VARCHAR(20)) FROM V$SYSSTAT WHERE NAME='sql executed count'",permissions:['SELECT V$SYSSTAT','authoritative startup epoch'],fields:[counterField('executes','dameng.sql.executions_total','DM V$SYSSTAT sql executed count in the bound database; not transaction count.')]},
  {engine:'oracle',name:'active_sessions',shape:'array',sql:"SELECT COUNT(*) FROM V$SESSION WHERE STATUS='ACTIVE'",permissions:['SELECT V_$SESSION'],fields:[field('count','oracle.sessions.active','Active V$SESSION rows in the bound container; not host CPU.')]},
  {engine:'oracle',name:'sga_bytes',shape:'array',sql:"SELECT TO_CHAR(SUM(value), 'FM99999999999999999999') FROM V$SGA",permissions:['SELECT V_$SGA'],fields:[field('bytes','oracle.sga.allocated_bytes','SGA bytes in the bound instance/container. Unrounded bytes replace the old rounded MiB representation.','By')]},
  {engine:'oracle',name:'pga_bytes',shape:'array',sql:"SELECT TO_CHAR(value, 'FM99999999999999999999') FROM V$PGASTAT WHERE NAME='total PGA allocated'",permissions:['SELECT V_$PGASTAT'],fields:[field('bytes','oracle.pga.allocated_bytes','Total PGA allocated bytes in the bound instance. Unrounded bytes replace the old rounded MiB representation.','By')]},
  { engine: 'oracle', name: 'sga_diagnostics', shape: 'array',
    sql: "SELECT (1-SUM(DECODE(NAME,'physical reads',VALUE,0))/NULLIF(SUM(DECODE(NAME,'db block gets',VALUE,'consistent gets',VALUE,0)),0))*100 FROM V$SYSSTAT",
    permissions: ['SELECT V_$SYSSTAT'], fields: [field('hit', 'oracle.buffer_cache.hit_percent', 'Cumulative 1 - physical reads/(db block gets + consistent gets) in bound instance/container; not host memory or PGA utilization.', '%', true)] },
  { engine: 'oracle', name: 'blocking_diagnostics', shape: 'array', sql: 'SELECT COUNT(*) FROM V$LOCK WHERE BLOCK=1',
    permissions: ['SELECT V_$LOCK'], fields: [field('blocking', 'oracle.locks.blocking', 'V$LOCK rows with BLOCK=1; not deadlock count.')] },
  { engine: 'dameng', name: 'memory_diagnostics', shape: 'array', sql: 'SELECT SUM(DATA_SIZE)*100.0/NULLIF(SUM(TOTAL_SIZE),0) FROM V$MEM_POOL',
    permissions: ['SELECT V$MEM_POOL'], fields: [field('usage', 'dameng.memory_pool.used_percent', 'DM memory-pool DATA_SIZE/TOTAL_SIZE; not host memory utilization.', '%', true)] },
  { engine: 'dameng', name: 'buffer_diagnostics', shape: 'array', sql: 'SELECT RAT_HIT*100 FROM V$BUFFERPOOL WHERE ID=0',
    permissions: ['SELECT V$BUFFERPOOL'], fields: [field('hit', 'dameng.buffer_pool.hit_percent', 'RAT_HIT of DM buffer pool ID 0 as percent; missing row is unavailable.', '%', true)] },
  { engine: 'dameng', name: 'blocking_diagnostics', shape: 'array', sql: 'SELECT COUNT(*) FROM V$LOCK WHERE BLOCK=1',
    permissions: ['SELECT V$LOCK'], fields: [field('blocking', 'dameng.locks.blocking', 'DM V$LOCK rows with BLOCK=1; not total locks.')] },
  { engine: 'dameng', name: 'deadlock_diagnostics', shape: 'array', sql: 'SELECT COUNT(*) FROM V$DEADLOCK_HISTORY',
    permissions: ['SELECT V$DEADLOCK_HISTORY'], fields: [field('events', 'dameng.deadlock_history.rows', 'Current retained V$DEADLOCK_HISTORY row count; not monotonic events since startup.')] },
];
// Additive releases: do not change the contents/digests of diagnostics@1.0.0.
const compatibilityReads: DatabaseRead[] = [
  {engine:'mysql',name:'innodb_diagnostics',shape:'status',sql:"SHOW GLOBAL STATUS WHERE Variable_name IN ('Innodb_row_lock_time_avg','Innodb_deadlocks','Created_tmp_disk_tables')",permissions:['SHOW GLOBAL STATUS'],fields:[
    field('Innodb_row_lock_time_avg','mysql.innodb.row_lock_average_ms','Native InnoDB average row-lock acquisition time in milliseconds; not an interval average.','ms'),
    counterField('Innodb_deadlocks','mysql.innodb.deadlocks_total','Cumulative Innodb_deadlocks since engine lifecycle; rate requires trusted epoch.'),
    counterField('Created_tmp_disk_tables','mysql.temporary.disk_tables_total','Cumulative internal on-disk temporary tables; not a ratio.'),
  ]},
  {engine:'mysql',name:'thread_cache',shape:'object',sql:"SELECT 100*(1-MAX(CASE WHEN VARIABLE_NAME='Threads_created' THEN CAST(VARIABLE_VALUE AS DECIMAL(30,0)) END)/NULLIF(MAX(CASE WHEN VARIABLE_NAME='Connections' THEN CAST(VARIABLE_VALUE AS DECIMAL(30,0)) END),0)) AS hit FROM performance_schema.global_status WHERE VARIABLE_NAME IN ('Threads_created','Connections')",permissions:['SELECT performance_schema.global_status'],fields:[field('hit','mysql.thread_cache.hit_percent','Cumulative 1 - Threads_created/Connections; NULL without connections.','%',true)]},
  {engine:'mysql',name:'active_transactions',shape:'object',sql:'SELECT COUNT(*) AS active FROM information_schema.INNODB_TRX',permissions:['PROCESS','SELECT information_schema.INNODB_TRX'],fields:[field('active','mysql.transactions.active','Current InnoDB transactions in INNODB_TRX, including waiting transactions.')]},
  {engine:'mysql',name:'replication_channels',shape:'replication',sql:'SHOW REPLICA STATUS',permissions:['REPLICATION CLIENT'],fields:[
    field('lag','mysql.replication.behind_source_seconds','Native Seconds_Behind_Source per channel; NULL remains unavailable, not zero or measured end-to-end lag.','s',true),
    field('io_running','mysql.replication.io_running','Per-channel receiver reports Yes=1, No/Connecting=0; missing status unavailable.'),
    field('sql_running','mysql.replication.sql_running','Per-channel applier reports Yes=1, No=0; missing status unavailable.'),
  ].map(f=>({...f,definition:{...f.definition,dimensions:{...f.definition.dimensions,max_series_per_resource:100,keys:[{name:'channel',meaning:'Replication channel name; default channel is named default.',required:true}]}}}))},
  {engine:'postgresql',name:'database_diagnostics',shape:'object',database:true,sql:'SELECT datname AS database, tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted, blks_read, blks_hit, temp_files, deadlocks FROM pg_stat_database WHERE datname=current_database()',permissions:['SELECT pg_stat_database','driver startup and stats_reset evidence'],fields:[
    ...['returned','fetched','inserted','updated','deleted'].map(n=>counterField(`tup_${n}`,`postgresql.database.tuples_${n}_total`,`Current database pg_stat_database.tup_${n}; stats_reset epoch required.`)),
    counterField('blks_read','postgresql.database.blocks_read_total','Current database cumulative disk blocks read, not bytes.'),
    counterField('blks_hit','postgresql.database.blocks_hit_total','Current database cumulative shared-buffer block hits.'),
    counterField('temp_files','postgresql.database.temp_files_total','Current database cumulative temporary files created.'),
    counterField('deadlocks','postgresql.database.deadlocks_total','Current database cumulative detected deadlocks.'),
  ].map(f=>({...f,definition:{...f.definition,dimensions:{...f.definition.dimensions,keys:[{name:'database',meaning:'Bound current database name',required:true}]}}}))},
  {engine:'postgresql',name:'active_transactions',shape:'object',sql:'SELECT COUNT(*) AS active FROM pg_stat_activity WHERE xact_start IS NOT NULL',permissions:['SELECT pg_stat_activity'],fields:[field('active','postgresql.transactions.active','Cluster visible backends with non-NULL xact_start; includes idle-in-transaction.')]},
  {engine:'postgresql',name:'waiting_locks',shape:'object',sql:"SELECT COUNT(*) AS waiting FROM pg_stat_activity WHERE wait_event_type='Lock'",permissions:['SELECT pg_stat_activity'],fields:[field('waiting','postgresql.backends.waiting_for_lock','Current visible backends waiting on Lock; not cumulative lock_wait_count (no stock pg_stat_database column).')]},
  {engine:'oracle',name:'library_cache',shape:'array',sql:'SELECT 100*SUM(PINHITS)/NULLIF(SUM(PINS),0) FROM V$LIBRARYCACHE',permissions:['SELECT V_$LIBRARYCACHE'],fields:[field('hit','oracle.library_cache.pin_hit_percent','Cumulative library cache PINHITS/PINS; NULL without pins.','%',true)]},
  {engine:'oracle',name:'user_tablespaces',shape:'array',sql:"SELECT MAX((1-NVL(f.free_bytes,0)/NULLIF(d.bytes,0))*100) FROM (SELECT TABLESPACE_NAME,SUM(BYTES) AS bytes FROM DBA_DATA_FILES WHERE TABLESPACE_NAME NOT IN ('SYSTEM','SYSAUX') GROUP BY TABLESPACE_NAME) d LEFT JOIN (SELECT TABLESPACE_NAME,SUM(BYTES) AS free_bytes FROM DBA_FREE_SPACE GROUP BY TABLESPACE_NAME) f ON d.TABLESPACE_NAME=f.TABLESPACE_NAME",permissions:['SELECT DBA_DATA_FILES','SELECT DBA_FREE_SPACE'],fields:[field('usage','oracle.tablespaces.user_max_allocated_used_percent','Maximum permanent allocated tablespace used ratio excluding SYSTEM/SYSAUX; NULL without user tablespaces.','%',true)]},
  {engine:'dameng',name:'memory_pool_bytes',shape:'array',sql:"SELECT CAST(STAT_VAL AS VARCHAR(20)) FROM V$SYSSTAT WHERE NAME='memory pool size in bytes'",permissions:['SELECT V$SYSSTAT'],fields:[field('bytes','dameng.memory_pool.allocated_bytes','Native memory pool size in bytes; missing row is unavailable.','By')]},
  {engine:'dameng',name:'os_memory_bytes',shape:'array',sql:"SELECT CAST(STAT_VAL AS VARCHAR(20)) FROM V$SYSSTAT WHERE NAME='memory used bytes from os'",permissions:['SELECT V$SYSSTAT'],fields:[field('bytes','dameng.os.allocated_memory_bytes','Native memory used bytes from OS, not host total memory utilization.','By')]},
  {engine:'dameng',name:'active_sessions',shape:'array',sql:"SELECT COUNT(*) FROM V$SESSIONS WHERE STATE='ACTIVE'",permissions:['SELECT V$SESSIONS'],fields:[field('active','dameng.sessions.active','DM active sessions, not active transaction count.')]},
];
export const diagnosticReads = [...frozenDiagnosticReads, ...compatibilityReads];
export const diagnosticSpecs: ImplementationSpec[] = diagnosticReads.map(read => ({
  id: implementationId(read), method: 'sql', resource_type: 'instance',
  applicability: [{ attribute: 'db.engine', values: [read.engine] }, { attribute: 'db.version', values: read.engine === 'mysql' ? [...databaseVersions.mysql, '9.6'] : databaseVersions[read.engine] }],
  outputs: read.fields.map(f => ({ raw_field: f.name, definition: f.definition, input_unit: f.definition.unit })), permissions: read.permissions,
  discovery: 'Singleton diagnostic snapshot; missing data and zero denominators preserve NULL. No inferred counter epoch.',
}));
export function diagnosticReleases(): PackageRelease[] {
  return (Object.keys(databaseVersions) as Engine[]).flatMap(engine => ['1.0.0','1.1.0'].map(version => {
    const base = databaseReleases().find(r => r.package.id === `${engine}-representative`)!;
    const reads = version === '1.0.0' ? frozenDiagnosticReads : diagnosticReads;
    const specs = diagnosticSpecs.filter(s => reads.some(r => implementationId(r)===s.id) && s.applicability[0].values[0] === engine);
    return sealRelease({ ...base, package: { ...base.package, id: `${engine}-diagnostics`, version, applicability: specs[0].applicability,
      collectors: [...(engine === 'mysql' ? [] : base.package.collectors), ...specs.map(s => ({ id: s.id.split('.').at(-2)!, implementation_ref: s.id, method: 'sql' as const,
        timeout_ms: 5000, estimated_cost: 'low' as const, mappings: s.outputs.map(o => ({ metric: { id: o.definition.id, semantic_version: o.definition.semantic_version },
          raw_field: o.raw_field, input_unit: o.input_unit, output_unit: o.definition.unit, transform_version: '1.0.0', steps: ['decode', 'normalize'] as Array<'decode' | 'normalize'> })) }))] },
      extensions: [...new Map([...base.extensions,...specs.flatMap(s=>s.outputs.map(o=>o.definition)).filter((d):d is Extract<MetricDefinition,{category:'extension'}>=>d.category==='extension')].map(d=>[d.id,d])).values()],
      documentation: [...(engine === 'mysql' ? [] : base.documentation), ...specs.map(s => ({collector_id:s.id.split('.').at(-2)!, permissions:s.permissions, discovery:s.discovery}))] });
  }));
}
