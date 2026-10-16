import type { Ref } from '../policy/model.js';
// Explicit, versioned read-time migration. Never writes over user policy or changes threshold units.
const maps: Record<string, Record<string, string>> = {
  mysql: { uptime_seconds: 'db.uptime_seconds', connections: 'mysql.processlist.count', max_connections: 'mysql.connections.limit', qps: 'mysql.queries.per_second',
    threads_running:'mysql.threads.running',threads_connected:'mysql.threads.connected',open_files:'mysql.files.open',
    buffer_pool_hit_rate:'mysql.buffer_pool.read_hit_percent',table_open_cache_hit_rate:'mysql.table_cache.hit_percent',key_blocks_usage:'mysql.key_cache.used_percent' },
  postgresql: { connections: 'postgresql.activity.count', max_connections: 'postgresql.connections.limit',connections_used:'postgresql.activity.count',
    idx_scan_ratio:'postgresql.tables.index_scan_percent',dead_tuples:'postgresql.tables.estimated_dead_rows',cache_hit_ratio:'postgresql.database.block_hit_percent',
    vacuum_count:'postgresql.tables.manually_vacuumed',autovacuum_count:'postgresql.tables.autovacuumed' },
  oracle: { connections: 'oracle.sessions.count', max_connections: 'oracle.processes.limit',tablespace_usage:'oracle.tablespaces.max_allocated_used_percent',
    sga_hit_rate:'oracle.buffer_cache.hit_percent' },
  dameng: { connections: 'dameng.sessions.count', max_connections: 'dameng.sessions.limit',dm_buffer_hit_rate:'dameng.buffer_pool.hit_percent' },
  network_device: { device_uptime_seconds: 'snmp.agent.uptime_seconds', interface_in_bps: 'snmp.interface.rx_bits_per_second', interface_out_bps: 'snmp.interface.tx_bits_per_second' },
  server: { cpu_usage: 'linux.cpu.user_system_percent', memory_usage: 'linux.memory.used_percent', load_1min: 'linux.load.one_minute',
    uptime:'linux.uptime.seconds',memory_used:'linux.memory.used_bytes',memory_total:'linux.memory.total_bytes',load_5min:'linux.load.five_minutes',load_15min:'linux.load.fifteen_minutes',
    swap_usage:'linux.swap.used_percent',process_count:'linux.processes.count',top_processes_cpu:'linux.processes.sample_max_cpu_percent',
    top_processes_memory:'linux.processes.cpu_sample_max_memory_percent',filesystem_used_bytes:'host.filesystem.used_bytes',filesystem_size_bytes:'host.filesystem.size_bytes',
    filesystem_available_bytes:'linux.filesystem.available_bytes',filesystem_inode_usage:'linux.filesystem.inode_used_percent' },
};
export function migrateReference(resource: Ref, engine: string, oldId: string) {
  const metricId = oldId.includes('.') ? oldId : maps[resource.type === 'instance' ? engine : resource.type]?.[oldId];
  return { version: '1.0.0', resource, old_id: oldId, metric_id: metricId ?? null,
    status: metricId ? 'mapped' : 'review_required', threshold_conversion: 'none',
    reason: metricId ? 'Pinned definition; threshold and resource scope preserved' : 'No proven equivalent; never substitute ratio, Host CPU or zero' };
}
