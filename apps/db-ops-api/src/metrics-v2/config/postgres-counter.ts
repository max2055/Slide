import { createHash } from 'node:crypto';
import { AdapterError, type Transport } from '../packages/adapters.js';
import { bindDatabaseDriver } from '../database/collector.js';
import { databaseReads } from '../database/catalog.js';

// One server statement binds each value to its database identity and reset timestamp.
// Text timestamps preserve microseconds for identity (JS Date alone would lose them).
export const POSTGRES_COUNTER_SQL = `SELECT datname AS database, datid::text AS database_oid,
  xact_commit::text AS commits, xact_rollback::text AS rollbacks,
  to_char(pg_postmaster_start_time() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS startup,
  to_char(stats_reset AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS reset,
  to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sampled_at
  FROM pg_stat_database WHERE datname = current_database()`;
const counterSql = databaseReads.find(r => r.engine === 'postgresql' && r.name === 'transactions')!.sql;
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 23) !== value.slice(0, 23)) throw new AdapterError('parse_error');
  return value;
}

/** execute owns an authorized, bounded private session; no address or credentials enter evidence. */
export function postgresCounterTransport(execute: (sql: string, timeout: number) => Promise<{ rows?: unknown }>): Extract<Transport, { method: 'sql' }> {
  const ordinary = bindDatabaseDriver(execute) as Extract<Transport, { method: 'sql' }>;
  return { ...ordinary, counterQuery: async ({ sql, timeout }) => {
    if (sql !== counterSql) throw new AdapterError('parse_error');
    const { rows } = await execute(POSTGRES_COUNTER_SQL, timeout);
    if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object' || Array.isArray(rows[0])) throw new AdapterError('parse_error');
    const row = rows[0];
    if (typeof row.database !== 'string' || !row.database || row.database.length > 128
      || typeof row.database_oid !== 'string' || !/^[1-9]\d{0,9}$/.test(row.database_oid) || BigInt(row.database_oid) > 4294967295n) throw new AdapterError('parse_error');
    const startup = timestamp(row.startup), sampled = timestamp(row.sampled_at);
    const reset = row.reset === null ? null : timestamp(row.reset);
    if (startup > sampled || reset && reset > sampled) throw new AdapterError('parse_error');
    const at = reset && reset > startup ? reset : startup;
    return { rows: [{ database: row.database, commits: row.commits, rollbacks: row.rollbacks }], observed_at: new Date(sampled).toISOString(),
      counter: { bits: '64', start_at: new Date(startup).toISOString(), discontinuity: {
        epoch: createHash('sha256').update(JSON.stringify([startup, row.database_oid, reset])).digest('hex'),
        observed_at: new Date(at).toISOString(), reason: at === startup ? 'boot' : 'reset',
      } } };
  } };
}
