import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StructuredMemoryStore, memoryHash, type MemoryRecord, type MemoryScope } from './memory-record.js';

const scope: MemoryScope = { workspaceId: 'workspace', actorId: 'A', sessionId: 'session' };
let directory: string;
let store: StructuredMemoryStore;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-read-'));
  store = new StructuredMemoryStore(directory);
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });

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
  try {
    const result = await Promise.race([store.list(scope), new Promise<null>(r => setTimeout(() => r(null), 200))]);
    expect(result?.map(r => r.id)).toEqual([record(0).id]);
  } finally { release(); await writer; }
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
