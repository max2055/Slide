import { createHash } from 'node:crypto';
import { bindDatabaseDriver } from '../database/collector.js';
import { databaseReads, vendorLifecycleSql } from '../database/catalog.js';
import { AdapterError, type Transport } from '../packages/adapters.js';

// Values and opaque native startup identity come from one server statement.
// Startup text is never interpreted in the collector host's timezone.
export const ORACLE_COUNTER_SQL = vendorLifecycleSql.oracle;
export const DAMENG_COUNTER_SQL = vendorLifecycleSql.dameng;
export interface VendorCounterState { epoch?: string; firstObservedAt?: string }

/** The state belongs to one live asset connection, never to a credential string.
 * A collector-process restart deliberately establishes a fresh baseline. */
export function vendorCounterTransport(engine: 'oracle' | 'dameng',
  execute: (sql: string, timeout: number) => Promise<{ rows?: unknown }>, state: VendorCounterState = {},
  clock = () => new Date().toISOString()): Extract<Transport, { method: 'sql' }> {
  const ordinary = bindDatabaseDriver(execute) as Extract<Transport, { method: 'sql' }>;
  const read = databaseReads.find(r => r.engine === engine && r.name === 'transactions')!;
  return { ...ordinary, counterQuery: async ({ sql, timeout }) => {
    if (sql !== read.sql) throw new AdapterError('parse_error');
    const observed_at = clock();
    const { rows } = await execute(engine === 'oracle' ? ORACLE_COUNTER_SQL : DAMENG_COUNTER_SQL, timeout);
    if (!Array.isArray(rows) || rows.length !== 1 || !Array.isArray(rows[0]) || rows[0].length !== (engine === 'oracle' ? 4 : 3)) throw new AdapterError('parse_error');
    const [value, startup, instance, container] = rows[0];
    if (typeof startup !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(startup)
      || !Number.isFinite(Date.parse(startup.replace(' ', 'T') + 'Z'))
      || typeof instance !== 'string' || !instance || instance.length > 128
      || engine === 'oracle' && (typeof container !== 'string' || !container || container.length > 128)
      || typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value) || BigInt(value) >= 1n << 64n) throw new AdapterError('parse_error');
    const epoch = createHash('sha256').update(JSON.stringify([engine, startup, instance, container ?? null])).digest('hex');
    if (state.epoch !== epoch) { state.epoch = epoch; state.firstObservedAt = observed_at; }
    return { rows: [[value]], observed_at, counter: { bits: '64', discontinuity: {
      epoch, observed_at: state.firstObservedAt!, reason: 'initial',
    } } };
  } };
}
