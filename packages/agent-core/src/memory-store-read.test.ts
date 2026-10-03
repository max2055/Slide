import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StructuredMemoryStore, memoryHash, type MemoryRecord, type MemoryScope } from './memory-record.js';

const scope: MemoryScope = { workspaceId: 'workspace', actorId: 'A', sessionId: 'session' };
let directory: string;
let store: StructuredMemoryStore;
let children: Array<{ child: ChildProcess; done: Promise<void> }>;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-read-'));
  store = new StructuredMemoryStore(directory);
  children = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.allSettled(children.map(c => c.done));
  await fs.rm(directory, { recursive: true, force: true });
});

function record(index: number, own = scope, sharedWith: string[] = []): MemoryRecord {
  return { schemaVersion: 1, id: 'mem_' + memoryHash([index, own]), scope: { ...own },
    kind: 'fact', subject: 'topic ' + index, content: 'The reporting region is Singapore.',
    sources: [{ id: 'm' + index, hash: memoryHash('The reporting region is Singapore.'), quote: 'The reporting region is Singapore.' }],
    confidence: 0.9, operation: 'new', evidence: 'user_statement', status: 'active',
    createdAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z',
    jobIds: [], supersedes: [], sharedWith, invalidSourceIds: [] };
}
async function seed(records = [record(0)]) {
  await store.transaction(state => { state.records = records; });
}

it('repeated list/export never writes, changes content/mtime/permissions or creates a lock', async () => {
  await seed();
  await fs.utimes(store.file, 1, 1);
  const content = await fs.readFile(store.file, 'utf8');
  const before = await fs.stat(store.file);
  const mutations = [vi.spyOn(fs, 'open'), vi.spyOn(fs, 'writeFile'), vi.spyOn(fs, 'rename'),
    vi.spyOn(fs, 'chmod'), vi.spyOn(fs, 'mkdir'), vi.spyOn(fs, 'unlink')];
  for (let i = 0; i < 10; i++) {
    expect(await store.list(scope)).toHaveLength(1);
    expect(JSON.parse(await store.export(scope)).records).toHaveLength(1);
  }
  for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
  expect(await fs.readFile(store.file, 'utf8')).toBe(content);
  const after = await fs.stat(store.file);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(after.mode & 0o777).toBe(0o600);
  expect(after.ino).toBe(before.ino);
  expect(await fs.readdir(directory)).toEqual(['memory-v1.json']);
});

it('missing store reads as empty without creating a directory or database', async () => {
  const missing = path.join(directory, 'absent');
  const fresh = new StructuredMemoryStore(missing);
  expect(await fresh.list(scope)).toEqual([]);
  expect(JSON.parse(await fresh.export(scope))).toEqual({ schemaVersion: 1, records: [] });
  await expect(fs.stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('reads while a live/foreign write lock exists without acquiring or reclaiming it', async () => {
  await seed();
  const lock = JSON.stringify({ pid: process.pid, host: 'foreign-host', token: 'test' });
  await fs.writeFile(store.file + '.lock', lock, { mode: 0o600 });
  expect(await store.list(scope)).toHaveLength(1);
  expect(JSON.parse(await store.export(scope)).records).toHaveLength(1);
  expect(await fs.readFile(store.file + '.lock', 'utf8')).toBe(lock);
  await expect(store.transaction(() => undefined)).rejects.toThrow('MEMORY_STORE_BUSY');
});

it.each(['{broken', 'null', '{"schemaVersion":2}', '{"schemaVersion":1,"records":[],"jobs":[],"tombstones":[],"budgets":null}'])('bad files fail closed and remain intact: %s', async content => {
  await fs.writeFile(store.file, content, { mode: 0o600 });
  await expect(store.list(scope)).rejects.toThrow();
  await expect(store.export(scope)).rejects.toThrow();
  await expect(store.transaction(() => undefined)).rejects.toThrow();
  expect(await fs.readFile(store.file, 'utf8')).toBe(content);
  expect(await fs.readdir(directory)).toEqual(['memory-v1.json']);
});

it('snapshots isolate workspace/actor/session and retain only explicit workspace-local sharing', async () => {
  const rows = [record(0), record(1, { ...scope, sessionId: 'other' }),
    record(2, { ...scope, actorId: 'B' }), record(3, { ...scope, actorId: 'B', sessionId: 'other' }, ['A']),
    record(4, { ...scope, workspaceId: 'other' }, ['A'])];
  await seed(rows);
  const snapshot = await store.list(scope);
  expect(snapshot.map(r => r.id)).toEqual([rows[0].id, rows[3].id]);
  snapshot[0].scope.actorId = 'intruder'; snapshot[1].sharedWith.push('intruder');
  expect(await store.list(scope)).toEqual([rows[0], rows[3]]);
  expect(JSON.parse(await store.export(scope)).records).toEqual([rows[0], rows[3]]);
  await expect(store.list({ ...scope, actorId: '' })).rejects.toThrow('MEMORY_SCOPE_INVALID');
});

it('an in-flight delete exposes a complete old or new scoped snapshot without waiting for the writer', async () => {
  await seed([record(0), record(1, { ...scope, actorId: 'B' })]);
  let entered!: () => void; let release!: () => void;
  const ready = new Promise<void>(r => { entered = r; });
  const gate = new Promise<void>(r => { release = r; });
  const writer = store.transaction(async state => { state.records = state.records.slice(1); entered(); await gate; });
  await ready;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([store.list(scope), new Promise<null>(r => { timer = setTimeout(() => r(null), 1000); })]);
    expect(result?.map(r => r.id)).toEqual([record(0).id]);
  } finally { clearTimeout(timer); release(); await writer; }
  expect(await store.list(scope)).toEqual([]);
  expect(await store.list({ ...scope, actorId: 'B' })).toEqual([record(1, { ...scope, actorId: 'B' })]);
});

it('atomic replacement publishes restrictive permissions before rename', async () => {
  const rename = fs.rename.bind(fs);
  const modes: number[] = [];
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (to === store.file) modes.push((await fs.stat(from)).mode & 0o777);
    await rename(from, to);
  });
  await seed(); await store.share(scope, record(0).id, ['B']);
  expect(modes).toEqual([0o600, 0o600]);
});

// Real Node processes, isolated temporary data and IPC barriers (no scheduling sleeps).
async function worker(body: string) {
  const script = path.join(directory, `worker-${children.length}.mts`);
  const core = fileURLToPath(new URL('./memory-record.ts', import.meta.url));
  const loader = fileURLToPath(new URL('../../../apps/db-ops-api/node_modules/tsx/dist/loader.mjs', import.meta.url));
  await fs.writeFile(script, `import fs from 'node:fs/promises';
import { StructuredMemoryStore } from ${JSON.stringify(core)};
const store = new StructuredMemoryStore(${JSON.stringify(directory)});
const scope = ${JSON.stringify(scope)};
const row = ${JSON.stringify(record(100))};
const gate = () => new Promise(resolve => process.once('message', resolve));
${body}
process.disconnect();`);
  const child = spawn(process.execPath, ['--import', loader, script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += chunk; });
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`worker exit ${code}/${signal}: ${stderr}`)));
  });
  // Attach a handler immediately; callers still receive the original rejection.
  void done.catch(() => undefined);
  children.push({ child, done });
  const ready = new Promise<void>((resolve, reject) => {
    child.once('message', () => resolve());
    void done.then(() => reject(new Error('worker exited without readiness')), reject);
  });
  await ready;
  return { child, done };
}

it('two processes contend on the writer lock; reads stay available and successful writes are retained', async () => {
  await seed();
  const first = await worker(`await store.transaction(async state => {
    state.records.push(row); state.budgets.test = { attempts: 1, tokens: 17 };
    const wait = gate(); process.send('locked'); await wait;
  });`);
  try {
    expect(await store.list(scope)).toEqual([record(0)]);
    await expect(store.share(scope, record(0).id, ['B'])).rejects.toThrow('MEMORY_STORE_BUSY');
    expect((await fs.readdir(directory)).some(f => f.endsWith('.reclaim'))).toBe(false);
  } finally { first.child.send('commit'); await first.done; }
  const second = await worker(`process.send('started');
await store.transaction(state => { state.budgets.test.attempts++; state.budgets.test.tokens += 3; });`);
  await second.done;
  expect(await store.list(scope)).toEqual([record(0), record(100)]);
  const state = JSON.parse(await fs.readFile(store.file, 'utf8'));
  expect(state.budgets.test).toEqual({ attempts: 2, tokens: 20 });
  await store.delete(scope, record(100).id);
  expect(await store.list(scope)).toEqual([record(0)]);
  expect(JSON.parse(await fs.readFile(store.file, 'utf8')).tombstones).toHaveLength(1);
}, 15000);

it('list/export racing a process doing repeated deletes/updates never mix generations or expose foreign records', async () => {
  const rows = [record(0), record(1), record(2, { ...scope, actorId: 'B' }), record(3, { ...scope, workspaceId: 'other' }, ['A'])];
  await seed(rows);
  const writer = await worker(`const wait = gate(); process.send('ready'); await wait;
for (let i = 1; i <= 30; i++) {
  await store.transaction(state => { for (const r of state.records) r.content = 'generation ' + i; });
}
await store.delete(scope, ${JSON.stringify(rows[0].id)});`);
  writer.child.send('start');
  let samples = 0;
  while (writer.child.exitCode === null && writer.child.signalCode === null) {
    const records = samples % 2 === 0 ? await store.list(scope) : JSON.parse(await store.export(scope)).records as MemoryRecord[];
    expect(records.length === 1 || records.length === 2).toBe(true);
    expect(records.every(r => r.scope.workspaceId === scope.workspaceId && r.scope.actorId === scope.actorId)).toBe(true);
    expect(new Set(records.map(r => r.content)).size).toBe(1);
    samples++;
  }
  await writer.done;
  expect(samples).toBeGreaterThan(0);
  expect((await store.list(scope)).map(r => r.id)).toEqual([rows[1].id]);
  await expect(store.delete({ ...scope, actorId: 'B' }, rows[1].id)).rejects.toThrow('MEMORY_NOT_FOUND');
}, 15000);

it('reconciliation still invalidates a stale job when the current record source is unchanged', async () => {
  await seed();
  const source = record(0).sources[0];
  await store.transaction(state => { state.jobs.push({ schemaVersion: 1, id: 'extract_' + memoryHash('job'), scope,
    boundary: 'test', inputs: [{ id: source.id, hash: memoryHash('old'), content: 'old' }],
    limits: { maxMessages: 1, maxCandidates: 1, maxInputBytes: 100, maxOutputTokens: 100,
      maxTotalTokens: 100, maxProviderAttempts: 1, deadlineMs: 1000 },
    createdAt: 0, deadlineAt: 1000, state: 'succeeded', attempts: 1, usage: {}, reservedTokens: 0, requests: [] }); });
  await store.invalidate(scope, new Map([[source.id, source.hash]]), [source.id]);
  const state = JSON.parse(await fs.readFile(store.file, 'utf8'));
  expect(state.records[0].status).toBe('active');
  expect(state.jobs[0]).toMatchObject({ state: 'obsolete', errorCode: 'MEMORY_SOURCE_CHANGED' });
});

it.each(['before', 'after'])('SIGKILL %s rename preserves a complete snapshot and dead-lock recovery retains budgets/tombstones', async phase => {
  await seed([record(0), record(1)]);
  await store.delete(scope, record(1).id);
  await store.transaction(state => { state.budgets.test = { attempts: 1, tokens: 41 }; });
  const crashed = await worker(`const rename = fs.rename.bind(fs);
fs.rename = async (from, to) => {
  if (${JSON.stringify(phase)} === 'after') await rename(from, to);
  const wait = gate(); process.send('rename barrier'); await wait;
  if (${JSON.stringify(phase)} === 'before') await rename(from, to);
};
await store.transaction(state => { state.records[0].content = 'committed update'; state.budgets.test.tokens += 7; });`);
  const content = phase === 'before' ? record(0).content : 'committed update';
  expect((await store.list(scope))[0].content).toBe(content);
  expect((await fs.stat(store.file)).mode & 0o777).toBe(0o600);
  crashed.child.kill('SIGKILL');
  await expect(crashed.done).rejects.toThrow('SIGKILL');
  expect((await store.list(scope))[0].content).toBe(content);
  // A subsequent writer reclaims only the dead owner's lock; reads leave it intact.
  await fs.stat(store.file + '.lock');
  await store.share(scope, record(0).id, ['B']);
  const state = JSON.parse(await fs.readFile(store.file, 'utf8'));
  expect(state.budgets.test.tokens).toBe(phase === 'before' ? 41 : 48);
  expect(state.tombstones).toHaveLength(1);
  expect(state.records).toHaveLength(1);
  await expect(fs.stat(store.file + '.lock')).rejects.toMatchObject({ code: 'ENOENT' });
}, 15000);

it.each([100, 1000, 10000])('capacity baseline: %i records, repeated lists have zero writes/locks', async count => {
  await seed(Array.from({ length: count }, (_, i) => record(i, i % 2 === 0 ? scope : { ...scope, actorId: 'B' })));
  await fs.utimes(store.file, 1, 1);
  const before = await fs.stat(store.file);
  const hash = memoryHash(await fs.readFile(store.file, 'utf8'));
  const writes = vi.spyOn(fs, 'writeFile');
  const opens = vi.spyOn(fs, 'open');
  const renames = vi.spyOn(fs, 'rename');
  const timings: number[] = [];
  let peakHeapDelta = 0; let peakRssDelta = 0;
  for (let i = 0; i < 20; i++) {
    const memory = process.memoryUsage(); const start = performance.now();
    const result = await store.list(scope);
    timings.push(performance.now() - start);
    const after = process.memoryUsage();
    peakHeapDelta = Math.max(peakHeapDelta, after.heapUsed - memory.heapUsed);
    peakRssDelta = Math.max(peakRssDelta, after.rss - memory.rss);
    expect(result).toHaveLength(count / 2);
  }
  expect(writes).not.toHaveBeenCalled(); expect(opens).not.toHaveBeenCalled(); expect(renames).not.toHaveBeenCalled();
  expect((await fs.stat(store.file)).mtimeMs).toBe(before.mtimeMs);
  expect(memoryHash(await fs.readFile(store.file, 'utf8'))).toBe(hash);
  timings.sort((a, b) => a - b);
  console.log('MEMORY_BASELINE ' + JSON.stringify({ count, fileBytes: before.size, samples: timings.length,
    medianMs: timings[10], p95Ms: timings[18], maxMs: timings[19], peakHeapDeltaBytes: peakHeapDelta,
    peakRssDeltaBytes: peakRssDelta, writes: writes.mock.calls.length, writeLocks: opens.mock.calls.length }));
}, 15000);
