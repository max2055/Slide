import { createHash } from 'node:crypto';
import { AdapterError, type Transport } from '../packages/adapters.js';
import { bindDatabaseDriver } from '../database/collector.js';
import { diagnosticReads } from '../database/diagnostics.js';
import { databaseReads } from '../database/catalog.js';

// One server statement binds each value to its database identity and reset timestamp.
// Text timestamps preserve microseconds for identity (JS Date alone would lose them).
export const POSTGRES_COUNTER_SQL = `SELECT datname AS database, datid::text AS database_oid,
  xact_commit::text AS commits, xact_rollback::text AS rollbacks,
  to_char(pg_postmaster_start_time() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS startup,
  to_char(stats_reset AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS reset,
  to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sampled_at
  FROM pg_stat_database WHERE datname = current_database()`;
export const POSTGRES_DIAGNOSTICS_COUNTER_SQL = POSTGRES_COUNTER_SQL.replace('xact_commit::text AS commits, xact_rollback::text AS rollbacks,',
  'tup_returned::text AS tup_returned, tup_fetched::text AS tup_fetched, tup_inserted::text AS tup_inserted, tup_updated::text AS tup_updated, tup_deleted::text AS tup_deleted, blks_read::text AS blks_read, blks_hit::text AS blks_hit, temp_files::text AS temp_files, deadlocks::text AS deadlocks,');
const diagnosticRead=diagnosticReads.find(r=>r.engine==='postgresql'&&r.name==='database_diagnostics')!;
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
    if (sql !== counterSql && sql !== diagnosticRead.sql) throw new AdapterError('parse_error');
    const diagnostic = sql===diagnosticRead.sql;
    const { rows } = await execute(diagnostic?POSTGRES_DIAGNOSTICS_COUNTER_SQL:POSTGRES_COUNTER_SQL, timeout);
    if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object' || Array.isArray(rows[0])) throw new AdapterError('parse_error');
    const row = rows[0];
    if (typeof row.database !== 'string' || !row.database || row.database.length > 128
      || typeof row.database_oid !== 'string' || !/^[1-9]\d{0,9}$/.test(row.database_oid) || BigInt(row.database_oid) > 4294967295n) throw new AdapterError('parse_error');
    const startup = timestamp(row.startup), sampled = timestamp(row.sampled_at);
    const reset = row.reset === null ? null : timestamp(row.reset);
    if (startup > sampled || reset && reset > sampled) throw new AdapterError('parse_error');
    const at = reset && reset > startup ? reset : startup;
    return { rows: [{ database: row.database, ...(diagnostic?Object.fromEntries(diagnosticRead.fields.map(f=>[f.name,row[f.name]])):{commits:row.commits,rollbacks:row.rollbacks}) }], observed_at: new Date(sampled).toISOString(),
      counter: { bits: '64', start_at: new Date(startup).toISOString(), discontinuity: {
        epoch: createHash('sha256').update(JSON.stringify([startup, row.database_oid, reset])).digest('hex'),
        observed_at: new Date(at).toISOString(), reason: at === startup ? 'boot' : 'reset',
      } } };
  } };
}
