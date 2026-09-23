import type { RawObservation } from '../../contracts/metrics-v2/index.js';
import { AdapterError, classifyError, type DecodedRow, type DriverEvidence, type Transport } from '../packages/adapters.js';
import { databaseReads, implementationId, type Engine } from './catalog.js';

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
  const read = databaseReads.find(r => implementationId(r) === id);
  if (!read || transport.method !== 'sql') throw new AdapterError('parse_error');
  let response: unknown, counter = evidence.counter, observed_at: string | undefined;
  try {
    if (read.fields.some(f => f.definition.kind === 'counter') && transport.counterQuery) {
      const snapshot = await transport.counterQuery({ sql: read.sql, timeout: timeoutMs });
      response = snapshot.rows; counter = snapshot.counter; observed_at = snapshot.observed_at;
    } else [response] = await transport.pool.query({ sql: read.sql, timeout: timeoutMs });
  }
  catch (error) { throw new AdapterError(classifyError(error)); }
  if (!Array.isArray(response)) throw new AdapterError('parse_error');
  const values: Record<string, unknown> = {};
  let database: unknown;
  if (read.shape === 'status') {
    for (const item of response) {
      if (!item || typeof item !== 'object' || !read.fields.some(f => f.name === item.Variable_name) || Object.hasOwn(values, item.Variable_name)) throw new AdapterError('parse_error');
      values[item.Variable_name] = item.Value;
    }
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
  const row: DecodedRow = { dimensions: read.database ? { database: database as string } : {}, fields: {}, accuracy: {}, counter, ...(observed_at ? { observed_at } : {}) };
  for (const field of read.fields) {
    // A malformed/missing scalar is omitted so the public runner isolates only this mapping.
    try { row.fields[field.name] = uint(values[field.name]); } catch { continue; }
    if (field.estimated) row.accuracy![field.name] = 'estimated';
  }
  return [row];
}
export const supportedDatabaseEngines: Engine[] = ['mysql', 'postgresql', 'oracle', 'dameng'];
