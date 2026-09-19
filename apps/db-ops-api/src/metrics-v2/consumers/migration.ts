import type { Ref } from '../policy/model.js';
// Explicit, versioned read-time migration. Never writes over user policy or changes threshold units.
const maps: Record<string, Record<string, string>> = {
  mysql: { uptime_seconds: 'db.uptime_seconds', connections: 'mysql.processlist.count', max_connections: 'mysql.connections.limit', qps: 'mysql.queries.per_second' },
  postgresql: { connections: 'postgresql.activity.count', max_connections: 'postgresql.connections.limit' },
  oracle: { connections: 'oracle.sessions.count', max_connections: 'oracle.processes.limit' },
  dameng: { connections: 'dameng.sessions.count', max_connections: 'dameng.sessions.limit' },
  network_device: { device_uptime_seconds: 'snmp.agent.uptime_seconds', interface_in_bps: 'snmp.interface.rx_bits_per_second', interface_out_bps: 'snmp.interface.tx_bits_per_second' },
  server: { cpu_usage: 'linux.cpu.user_system_percent', memory_usage: 'linux.memory.used_percent', load_1min: 'linux.load.one_minute' },
};
export function migrateReference(resource: Ref, engine: string, oldId: string) {
  const metricId = oldId.includes('.') ? oldId : maps[resource.type === 'instance' ? engine : resource.type]?.[oldId];
  return { version: '1.0.0', resource, old_id: oldId, metric_id: metricId ?? null,
    status: metricId ? 'mapped' : 'review_required', threshold_conversion: 'none',
    reason: metricId ? 'Pinned definition; threshold and resource scope preserved' : 'No proven equivalent; never substitute ratio, Host CPU or zero' };
}
