// Qualification-only instrumentation: never imported by the application.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function safeSqlLabel(value: unknown): string {
  const sql = (typeof value === 'string' ? value : String((value as { sql?: unknown })?.sql ?? ''))
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').trim();
  if (/^SELECT\s+(?:GET_LOCK|RELEASE_LOCK)\s*\(/i.test(sql)) return /GET_LOCK/i.test(sql) ? 'migration-lock-acquire' : 'migration-lock-release';
  const verb = /^(CREATE|ALTER|DROP|SELECT|INSERT|UPDATE|DELETE|SET|START|COMMIT|ROLLBACK|SHOW)\b/i.exec(sql)?.[1]?.toLowerCase();
  // No SQL text, object names, values, parameters, or errors leave the process.
  return verb ?? 'other';
}

export function recoveryObservation(database: string) {
  const directory = process.env.RECOVERY_OBSERVATION_DIR;
  if (directory && !/^investigation_test_\d+_[a-f0-9]{32}$/.test(database)) throw new Error('Invalid qualification database identity');
  const pending = new Map<number, { label: string; started: number }>();
  const proxies = new WeakMap<object, object>();
  const started = performance.now();
  let sequence = 0;
  let failed = false;
  let active = Boolean(directory);
  const emit = (event: Record<string, unknown>) => {
    if (!active) return;
    try {
      appendFileSync(join(directory!, `hook-${process.pid}.jsonl`), JSON.stringify({
        utc: new Date().toISOString(), monotonicNs: process.hrtime.bigint().toString(), monoMs: performance.now() - started, pid: process.pid,
        commit: process.env.RECOVERY_OBSERVATION_COMMIT, database, ...event,
      }) + '\n');
    } catch {
      if (!failed) process.stderr.write('RECOVERY_OBSERVATION_WRITE_FAILED\n');
      failed = true;
    }
  };
  const operation = async <T>(kind: string, label: string, fn: () => Promise<T>): Promise<T> => {
    if (!active) return fn();
    const id = ++sequence;
    const begin = performance.now();
    pending.set(id, { label, started: begin });
    emit({ event: 'begin', kind, id, label });
    try {
      const value = await fn();
      emit({ event: 'end', kind, id, label, durationMs: performance.now() - begin });
      return value;
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      emit({ event: 'error', kind, id, label, durationMs: performance.now() - begin,
        code: typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'UNCLASSIFIED' });
      throw error;
    } finally { pending.delete(id); }
  };
  function wrap<T extends object>(client: T): T {
    if (!active) return client;
    const known = proxies.get(client);
    if (known) return known as T;
    const emitter = client as { on?: (event: string, listener: (connection: { threadId?: number }) => void) => void };
    emitter.on?.('connection', connection => {
      if (Number.isSafeInteger(connection.threadId)) emit({ event: 'mysql-connection', connectionId: connection.threadId });
    });
    const proxy = new Proxy(client, { get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      if (property === 'query' || property === 'execute') return (...args: unknown[]) =>
        operation('sql', safeSqlLabel(args[0]), () => value.apply(target, args));
      if (property === 'getConnection') return (...args: unknown[]) =>
        operation('connection', 'get-connection', async () => wrap(await value.apply(target, args)));
      return value.bind(target);
    } });
    proxies.set(client, proxy);
    return proxy;
  }
  return {
    wrap,
    stage: <T>(label: string, fn: () => Promise<T>) => operation('stage', label, fn),
    async beforeCleanup() {
      if (!directory) return;
      const request = join(directory, `cleanup-${process.pid}`);
      writeFileSync(request, database);
      const deadline = performance.now() + 4000;
      while (!existsSync(`${request}.ack`) && performance.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (!existsSync(`${request}.ack`)) throw new Error('Recovery cleanup snapshot missing');
    },
    finish(checkWrite = true) {
      emit({ event: 'hook-exit', pending: [...pending].map(([id, item]) => ({ id, label: item.label, durationMs: performance.now() - item.started })) });
      active = false;
      if (failed && checkWrite) throw new Error('Recovery observation could not be written');
    },
  };
}
