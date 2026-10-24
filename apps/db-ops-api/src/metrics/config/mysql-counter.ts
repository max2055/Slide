import { createHash } from 'node:crypto';
import type { RawObservation } from '../../contracts/metrics/index.js';
import { AdapterError, type Transport } from '../packages/adapters.js';
import { bindDatabaseDriver } from '../database/collector.js';
import { databaseReads, type DatabaseRead } from '../database/catalog.js';
import { diagnosticReads } from '../database/diagnostics.js';

// One SHOW GLOBAL STATUS also returns Uptime and Uptime_since_flush_status, so
// every counter and its lifecycle durations share one server snapshot.
// performance_schema.global_status is not used: it omits Com_* variables.
const LIFECYCLE = ['Uptime', 'Uptime_since_flush_status'];

/** Every fixed MySQL read whose fields include counters must obtain values and
 * identity from one server statement; ordinary status reads cannot. */
const counterReads = new Map<string, DatabaseRead>();
for (const read of [...databaseReads, ...diagnosticReads]) {
  if (read.engine === 'mysql' && read.shape === 'status' && read.fields.some(f => f.definition.kind === 'counter') && !counterReads.has(read.sql)) {
    counterReads.set(read.sql, read);
  }
}

function snapshotSql(read: DatabaseRead): string {
  const names = [...new Set([...read.fields.map(f => f.name), ...LIFECYCLE])];
  return `SHOW GLOBAL STATUS WHERE Variable_name IN (${names.map(name => `'${name}'`).join(', ')})`;
}

type Reason = 'boot' | 'reset' | 'source_change' | 'initial';
interface Snapshot { sampledMs: number; uptime: number; flushUptime: number }
interface Generation { epoch: string; startAt: string; observedAt: string; sampledMs: number; uptime: number; flushUptime: number }

const lifecycleFailure = () => new AdapterError('parse_error', 'MYSQL_COUNTER_LIFECYCLE_UNAVAILABLE');
function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw lifecycleFailure();
  return value;
}
function values(result: unknown, read: DatabaseRead): Map<string, unknown> {
  if (!Array.isArray(result)) throw lifecycleFailure();
  const map = new Map<string, unknown>();
  for (const item of result) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw lifecycleFailure();
    const row = item as Record<string, unknown>;
    const name = text(row.Variable_name, /^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
    if (map.has(name)) throw lifecycleFailure();
    map.set(name, row.Value);
  }
  // A missing business variable is an omitted field, never a synthetic zero or
  // a lifecycle failure; the durations are the only required rows.
  for (const name of LIFECYCLE) if (!map.has(name)) throw lifecycleFailure();
  return map;
}
function snapshot(map: Map<string, unknown>, sampledMs: number): Snapshot {
  const uptime = Number(text(map.get('Uptime'), /^\d{1,9}$/));
  const flushUptime = Number(text(map.get('Uptime_since_flush_status'), /^\d{1,9}$/));
  if (!Number.isFinite(sampledMs) || flushUptime > uptime + 1) throw lifecycleFailure();
  return { sampledMs, uptime, flushUptime };
}
function classifySql(error: unknown): 'permission_denied' | 'timeout' | 'connection_error' {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : '';
  if (['ER_ACCESS_DENIED_ERROR', 'ER_SPECIFIC_ACCESS_DENIED_ERROR', 'ER_TABLEACCESS_DENIED_ERROR'].includes(code)) return 'permission_denied';
  if (['ETIMEDOUT', 'PROTOCOL_SEQUENCE_TIMEOUT', 'ER_QUERY_TIMEOUT'].includes(code)) return 'timeout';
  return 'connection_error';
}

/** One generation lives until a trusted restart or FLUSH changes a duration by
 * more than rounding. The epoch is produced here, from the same statement as the
 * values; counters never decide continuity and a lost process state only starts
 * a new baseline. */
export class MysqlCounterDiscovery {
  private state?: Generation;
  constructor(private readonly clock = () => new Date().toISOString()) {}
  async read(execute: (sql: string, timeout: number) => Promise<{ rows?: unknown }>, read: DatabaseRead, timeout: number) {
    let result: unknown;
    try { result = (await execute(snapshotSql(read), timeout)).rows; }
    catch (error) { throw new AdapterError(classifySql(error)); }
    const map = values(result, read);
    const sampledMs = Date.parse(this.clock());
    const now = snapshot(map, sampledMs);
    const previous = this.state;
    let generation: Generation, reason: Reason = 'initial';
    const elapsed = previous ? (now.sampledMs - previous.sampledMs) / 1000 : 0;
    const consistent = previous && now.sampledMs >= previous.sampledMs
      && Math.abs((now.uptime - previous.uptime) - elapsed) <= 2
      && Math.abs((now.flushUptime - previous.flushUptime) - elapsed) <= 2;
    if (consistent) {
      generation = { ...previous, sampledMs: now.sampledMs, uptime: now.uptime, flushUptime: now.flushUptime };
    } else {
      const startupMs = now.sampledMs - now.uptime * 1000;
      const flushMs = now.sampledMs - now.flushUptime * 1000;
      const startAt = new Date(now.flushUptime > 0 ? flushMs : startupMs).toISOString();
      reason = !previous ? 'initial' : previous.sampledMs > now.sampledMs ? 'source_change'
        : now.uptime < previous.uptime || Math.abs((now.uptime - previous.uptime) - elapsed) > 2 ? 'boot' : 'reset';
      generation = { epoch: createHash('sha256').update(JSON.stringify(['mysql',
        new Date(startupMs).toISOString(), new Date(flushMs).toISOString()])).digest('hex'),
        startAt, observedAt: startAt, sampledMs: now.sampledMs, uptime: now.uptime, flushUptime: now.flushUptime };
    }
    this.state = generation;
    const kind = reason === 'initial' ? (now.flushUptime > 0 ? 'reset' : 'boot') : reason;
    return { rows: read.fields.filter(f => map.has(f.name)).map(f => ({ Variable_name: f.name,
      Value: map.get(f.name) === null ? null : String(map.get(f.name)) })),
      observed_at: new Date(now.sampledMs).toISOString(),
      counter: { bits: '64', start_at: generation.startAt,
        discontinuity: { epoch: generation.epoch, observed_at: generation.observedAt, reason: kind } } as NonNullable<RawObservation['counter']> };
  }
}

/** Fixed reads only. The declared SQL is never executed; a server-owned snapshot
 * supplies both the business counters and their lifecycle evidence. */
export function mysqlCounterTransport(execute: (sql: string, timeout: number) => Promise<{ rows?: unknown }>,
  discovery = new MysqlCounterDiscovery()): Extract<Transport, { method: 'sql' }> {
  const ordinary = bindDatabaseDriver(execute) as Extract<Transport, { method: 'sql' }>;
  return { ...ordinary, counterQuery: async ({ sql, timeout }) => {
    const read = counterReads.get(sql);
    if (!read) throw new AdapterError('parse_error');
    return discovery.read(execute, read, timeout);
  } };
}

/** Losing process-local discovery starts a fresh baseline; it never invents continuity. */
export class MysqlCounterDiscoveryCache {
  private readonly entries = new Map<number, { fingerprint: string; discovery: MysqlCounterDiscovery }>();
  constructor(private readonly limit = 4096) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('DISCOVERY_CACHE_LIMIT');
  }
  get(id: number, fingerprint: string): MysqlCounterDiscovery {
    const previous = this.entries.get(id);
    const entry = previous?.fingerprint === fingerprint ? previous : { fingerprint, discovery: new MysqlCounterDiscovery() };
    this.entries.delete(id); this.entries.set(id, entry);
    if (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    return entry.discovery;
  }
  forget(id: number): void { this.entries.delete(id); }
}
