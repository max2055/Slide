import type { RawObservation } from '../../contracts/metrics/index.js';
import { AdapterError, classifyError, type DecodedRow, type DriverEvidence, type Transport } from '../packages/adapters.js';
import { databaseReads, capacityReads, implementationId, type Engine } from './catalog.js';
import { diagnosticReads } from './diagnostics.js';

/** Adapt authorized PG/Oracle/DM driver rows. The owner supplies a bounded native execute
 * and must retain its connection until in-flight IO settles; this does not Promise.race IO. */
export function bindDatabaseDriver(execute: (sql: string, timeoutMs: number) => Promise<{ rows?: unknown }>): Transport {
  return { method: 'sql', pool: { query: async ({ sql, timeout }) => [(await execute(sql, timeout)).rows, []] } };
}
function uint(value: unknown): RawObservation['value'] {
  if (value === null) return null;
  const text = typeof value === 'bigint' ? String(value) : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !/^(0|[1-9]\d*)$/.test(text) || text.length > 20 || BigInt(text) >= 1n << 64n) throw new AdapterError('parse_error');
  return { encoding: 'uint64', value: text };
}
export async function collectDatabase(id: string, transport: Transport, evidence: DriverEvidence, timeoutMs: number): Promise<DecodedRow[]> {
  const read = [...databaseReads, ...capacityReads, ...diagnosticReads].find(r => implementationId(r) === id);
  if (!read || transport.method !== 'sql') throw new AdapterError('parse_error');
  let response: unknown, counter = evidence.counter, observed_at: string | undefined;
  try {
    if (read.fields.some(f => f.definition.kind === 'counter') && transport.counterQuery) {
      const snapshot = await transport.counterQuery({ sql: read.sql, timeout: timeoutMs });
      response = snapshot.rows; counter = snapshot.counter; observed_at = snapshot.observed_at;
    } else {
      try { [response] = await transport.pool.query({ sql: read.sql, timeout: timeoutMs }); }
      catch (error) {
        // Only a server syntax rejection permits the documented pre-8.0.22 spelling.
        // Auth/timeout/connection errors never trigger a second query or a healthy default.
        if (read.shape !== 'replication' || (error as {code?:string})?.code !== 'ER_PARSE_ERROR') throw error;
        [response] = await transport.pool.query({sql:'SHOW SLAVE STATUS',timeout:timeoutMs});
      }
    }
  }
  catch (error) { throw new AdapterError(classifyError(error)); }
  if (!Array.isArray(response)) throw new AdapterError('parse_error');
  // Ordinary SHOW GLOBAL STATUS has values but no authoritative startup/reset
  // identity. Uptime/collection clocks cannot supply it, including after FLUSH.
  if (read.engine === 'mysql' && read.fields.some(f => f.definition.kind === 'counter') && !counter) {
    throw new AdapterError('parse_error', 'MYSQL_COUNTER_LIFECYCLE_UNAVAILABLE');
  }
  if (read.shape === 'replication') {
    if (response.length > 100) throw new AdapterError('parse_error');
    const channels = new Set<string>();
    return response.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new AdapterError('parse_error');
      const channel = item.Channel_Name === '' ? 'default' : item.Channel_Name;
      if (typeof channel !== 'string' || !channel || channel.length > 128 || channels.has(channel)) throw new AdapterError('parse_error');
      channels.add(channel);
      const fields: DecodedRow['fields'] = {};
      const lag = item.Seconds_Behind_Source !== undefined ? item.Seconds_Behind_Source : item.Seconds_Behind_Master;
      if (lag === null) fields.lag = null;
      else if ((typeof lag === 'number' || typeof lag === 'string' && /^\d+(\.\d+)?$/.test(lag)) && Number.isFinite(Number(lag)) && Number(lag) >= 0) fields.lag = {encoding:'float64',value:Number(lag)};
      for (const [field, raw] of [['io_running',item.Replica_IO_Running ?? item.Slave_IO_Running],['sql_running',item.Replica_SQL_Running ?? item.Slave_SQL_Running]]) {
        if (raw === null) fields[field!] = null;
        else if (['Yes','No','Connecting'].includes(raw!)) fields[field!] = {encoding:'uint64',value:raw==='Yes'?'1':'0'};
      }
      return {dimensions:{channel},fields};
    });
  }
  const values: Record<string, unknown> = {};
  let database: unknown;
  if (read.shape === 'status') {
    for (const item of response) {
      if (!item || typeof item !== 'object' || !read.fields.some(f => f.name === item.Variable_name) || Object.hasOwn(values, item.Variable_name)) throw new AdapterError('parse_error');
      values[item.Variable_name] = item.Value;
    }
    // A declared variable the server does not expose (e.g. Innodb_deadlocks on
    // MySQL 8.4) is a source capability fact, not a malformed read: emit null so
    // the observation stays unknown instead of failing the whole mapping.
    for (const field of read.fields) if (!Object.hasOwn(values, field.name)) values[field.name] = null;
  } else {
    if (response.length !== 1 || !response[0] || typeof response[0] !== 'object') throw new AdapterError('parse_error');
    if (read.shape === 'array') {
      if (!Array.isArray(response[0]) || response[0].length !== read.fields.length) throw new AdapterError('parse_error');
      read.fields.forEach((f, i) => { values[f.name] = response[0][i]; });
    } else {
      if (Array.isArray(response[0])) throw new AdapterError('parse_error');
      read.fields.forEach(f => { values[f.name] = response[0][f.name]; });
      database = response[0].database;
    }
  }
  if (read.database && (typeof database !== 'string' || !database || database.length > 128)) throw new AdapterError('parse_error');
  const row: DecodedRow = { dimensions: read.database ? { database: database as string } : {}, fields: {}, accuracy: {}, counter, ...(observed_at ? { observed_at } : {}), field_evidence: {} };
  for (const field of read.fields) if (read.shape === 'status' && !response.some((item: any) => item?.Variable_name === field.name)) row.field_evidence![field.name] = { capability: 'unknown' };
  for (const field of read.fields) {
    // A malformed/missing scalar is omitted so the public runner isolates only this mapping.
    try {
      const value = values[field.name];
      if (field.definition.value_type === 'float64' && value !== null) {
        if (!(typeof value === 'number' || typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) || !Number.isFinite(Number(value))) continue;
        row.fields[field.name] = { encoding: 'float64', value: Number(value) };
      } else row.fields[field.name] = uint(value);
    } catch { continue; }
    if (field.estimated) row.accuracy![field.name] = 'estimated';
  }
  return [row];
}
export const supportedDatabaseEngines: Engine[] = ['mysql', 'postgresql', 'oracle', 'dameng'];
