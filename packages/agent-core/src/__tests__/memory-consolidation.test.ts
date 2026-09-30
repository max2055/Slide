import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ts from 'typescript';
import { Consolidator, MemoryStore } from '../memory.js';

describe('durable memory consolidation', () => {
  let workspace: string;
  let store: MemoryStore;
  const consolidator = new Consolidator();
  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-consolidation-'));
    store = new MemoryStore(workspace);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const seed = async (count: number, target: MemoryStore) => {
    for (let n = 0; n < count; n++) await target.appendHistory({ n, message: `entry-${n}` });
  };
  const archives = async () => {
    const dir = path.join(store.getMemoryDir(), 'memory-archive');
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    return (await Promise.all(files.filter(f => f.endsWith('.json')).map(async file =>
      JSON.parse(await fs.readFile(path.join(dir, file), 'utf8')).entries,
    ))).flat() as Array<{ id: string; entry: { n: number } }>;
  };

  it.each([51, 1000])('preserves all %i entries across bounded batches and restarts', async count => {
    await seed(count, store);
    await consolidator.consolidateToMemory(store);
    expect(await store.getHistoryCount()).toBe(count - 50);
    for (let remaining = count - 50; remaining > 0; remaining -= 50) {
      store = new MemoryStore(workspace);
      await consolidator.consolidateToMemory(store);
    }
    await consolidator.consolidateToMemory(store);
    const entries = await archives();
    expect(entries).toHaveLength(count);
    expect(new Set(entries.map(e => e.id)).size).toBe(count);
    expect(entries.map(e => e.entry.n).sort((a, b) => a - b)).toEqual(Array.from({ length: count }, (_, i) => i));
    expect(await store.getHistoryCount()).toBe(0);
  }, 30000);

  it('keeps legacy payloads and duplicate rows, with stable IDs after migration', async () => {
    await fs.mkdir(store.getMemoryDir(), { recursive: true });
    await fs.writeFile(store.getHistoryPath(), '{"message":"same"}\n{"message":"same"}\n');
    const before = await store.readUnprocessedHistory(0);
    await consolidator.consolidateToMemory(store, 1);
    const after = await new MemoryStore(workspace).readUnprocessedHistory(0);
    expect(after[0].entry).toEqual(before[1].entry);
    expect(after[0].id).toBe(before[1].id);
    await consolidator.consolidateToMemory(new MemoryStore(workspace), 1);
    expect(new Set((await archives()).map(e => e.id)).size).toBe(2);
  });

  it('does not consume concurrent append made after the batch snapshot', async () => {
    await seed(3, store);
    const rename = fs.rename.bind(fs);
    let appended = false;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).includes('memory-archive') && !appended) {
        appended = true;
        await new MemoryStore(workspace).appendHistory({ n: 99 });
      }
      await rename(from, to);
    });
    await consolidator.consolidateToMemory(store);
    expect((await store.readUnprocessedHistory(0)).map(e => e.entry.n)).toEqual([99]);
    await consolidator.consolidateToMemory(store);
    expect((await archives()).map(e => e.entry.n).sort((a, b) => a - b)).toEqual([0, 1, 2, 99]);
  });

  it.each(['archive-write', 'archive-rename', 'memory-rename', 'cursor-rename', 'history-ack'])
    ('recovers from %s failure without missing or duplicate sources', async failure => {
      await seed(3, store);
      const rename = fs.rename.bind(fs);
      const write = fs.writeFile.bind(fs);
      let failed = false;
      const shouldFail = (file: string) => {
        if (failed) return false;
        return failure === 'archive-write' || failure === 'archive-rename' ? file.includes('memory-archive')
          : failure === 'memory-rename' ? file.endsWith('MEMORY.md')
          : failure === 'cursor-rename' ? file.endsWith('consolidation-cursor.json')
          : file.endsWith('history.jsonl');
      };
      if (failure === 'archive-write') {
        vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
          if (shouldFail(String(args[0]))) { failed = true; throw new Error('injected write failure'); }
          return write(...args);
        });
      } else {
        vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
          if (shouldFail(String(to))) { failed = true; throw new Error('injected rename failure'); }
          await rename(from, to);
        });
      }
      await expect(consolidator.consolidateToMemory(store)).rejects.toThrow('injected');
      expect(await store.getHistoryCount()).toBe(3);
      if (failure.startsWith('archive') || failure === 'memory-rename') {
        await expect(fs.access(path.join(store.getMemoryDir(), 'consolidation-cursor.json'))).rejects.toThrow();
      }
      vi.restoreAllMocks();
      await consolidator.consolidateToMemory(new MemoryStore(workspace));
      await consolidator.consolidateToMemory(new MemoryStore(workspace));
      expect(await archives()).toHaveLength(3);
      expect(await store.getHistoryCount()).toBe(0);
      const memory = await store.readMemory();
      expect(memory?.match(/entry-0/g)).toHaveLength(1);
    });

  it('serializes independent stores consolidating the same workspace', async () => {
    await seed(60, store);
    await Promise.all([
      consolidator.consolidateToMemory(store),
      new Consolidator().consolidateToMemory(new MemoryStore(workspace)),
    ]);
    expect(await archives()).toHaveLength(60);
    expect(await store.getHistoryCount()).toBe(0);
  });

  it.each(['MEMORY.md', 'consolidation-cursor.json', 'history.jsonl'])
    ('recovers after an actual process exits immediately after %s rename', async boundary => {
      await seed(3, store);
      const fixture = path.join(workspace, 'worker');
      await fs.mkdir(fixture);
      await fs.writeFile(path.join(fixture, 'package.json'), '{"type":"module"}');
      for (const name of ['memory', 'memory-history']) {
        const source = await fs.readFile(new URL(`../${name}.ts`, import.meta.url), 'utf8');
        await fs.writeFile(path.join(fixture, `${name}.js`), ts.transpileModule(source, {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        }).outputText);
      }
      await fs.writeFile(path.join(fixture, 'crash.mjs'), `
        import fs from 'node:fs/promises';
        import { Consolidator, MemoryStore } from './memory.js';
        const rename = fs.rename.bind(fs);
        fs.rename = async (from, to) => {
          await rename(from, to);
          if (String(to).endsWith(process.argv[3])) process.exit(17);
        };
        await new Consolidator().consolidateToMemory(new MemoryStore(process.argv[2]));
      `);
      await expect(promisify(execFile)(process.execPath, [path.join(fixture, 'crash.mjs'), workspace, boundary]))
        .rejects.toMatchObject({ code: 17 });
      await consolidator.consolidateToMemory(new MemoryStore(workspace));
      await consolidator.consolidateToMemory(new MemoryStore(workspace));
      expect(await store.getHistoryCount()).toBe(0);
      expect(await archives()).toHaveLength(3);
      expect((await store.readMemory())?.match(/entry-0/g)).toHaveLength(1);
    });

  it('retains a stable compaction high-water mark with concurrent append across batches', async () => {
    await seed(60, store);
    const rename = fs.rename.bind(fs);
    let appended = false;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).includes('memory-archive') && !appended) {
        appended = true;
        await new MemoryStore(workspace).appendHistory({ n: 99 });
      }
      await rename(from, to);
    });
    await store.compactHistory(3);
    expect((await store.readUnprocessedHistory(0)).map(e => e.entry.n)).toEqual([57, 58, 59, 99]);
    expect(await archives()).toHaveLength(57);
  });

  it('preserves old MEMORY text and serializes updates during archival publication', async () => {
    await store.writeMemory('Original user memory');
    await seed(3, store);
    await Promise.all([
      consolidator.consolidateToMemory(store),
      new MemoryStore(workspace).updateMemory('Concurrent note'),
    ]);
    const memory = await store.readMemory();
    expect(memory).toContain('Original user memory');
    expect(memory).toContain('Concurrent note');
    expect(memory).toContain('entry-0');
  });

  it('blocks explicit clear until an interrupted batch is recovered', async () => {
    await seed(2, store);
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).includes('memory-archive')) throw new Error('interrupted archive');
      await rename(from, to);
    });
    await expect(consolidator.consolidateToMemory(store)).rejects.toThrow('interrupted');
    await expect(store.clearHistory()).rejects.toThrow('pending');
    expect(await store.getHistoryCount()).toBe(2);
    vi.restoreAllMocks();
    await consolidator.consolidateToMemory(store);
    await store.appendHistory({ n: 3 });
    await store.clearHistory();
    expect(await store.getHistoryCount()).toBe(0);
  });

  it('archives compacted prefixes before deleting them and keeps new entries', async () => {
    await seed(10, store);
    const before = await store.readUnprocessedHistory(0);
    await store.compactHistory(3);
    const after = await store.readUnprocessedHistory(0);
    expect(after.map(e => e.id)).toEqual(before.slice(-3).map(e => e.id));
    expect((await archives()).map(e => e.id).sort()).toEqual(before.slice(0, 7).map(e => e.id).sort());
    await consolidator.consolidateToMemory(store, 2);
    expect(await store.getHistoryCount()).toBe(1);
    expect(await archives()).toHaveLength(9);
  });

  it('fails closed on unreadable history rather than treating it as empty', async () => {
    await seed(2, store);
    await fs.appendFile(store.getHistoryPath(), '{broken\n');
    const original = await fs.readFile(store.getHistoryPath(), 'utf8');
    await expect(consolidator.consolidateToMemory(store)).rejects.toThrow();
    expect(await fs.readFile(store.getHistoryPath(), 'utf8')).toBe(original);
  });

  it('does not acknowledge sources after archive fsync fails', async () => {
    await seed(2, store);
    const before = await store.readUnprocessedHistory(0);
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).includes('memory-archive') && String(args[0]).endsWith('.tmp')) {
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('injected fsync failure'));
      }
      return handle;
    });
    await expect(consolidator.consolidateToMemory(store)).rejects.toThrow('fsync');
    expect(await store.readUnprocessedHistory(0)).toEqual(before);
    await expect(fs.access(path.join(store.getMemoryDir(), 'consolidation-cursor.json'))).rejects.toThrow();
    vi.restoreAllMocks();
    await consolidator.consolidateToMemory(new MemoryStore(workspace));
    expect(await archives()).toHaveLength(2);
  });

  it('refuses a corrupt journal without deleting or overwriting history', async () => {
    await seed(2, store);
    const before = await fs.readFile(store.getHistoryPath(), 'utf8');
    await fs.writeFile(path.join(store.getMemoryDir(), 'consolidation-pending.json'), '{"version":1,"id":"bad","entries":[]}');
    await expect(consolidator.consolidateToMemory(store)).rejects.toThrow('journal');
    expect(await fs.readFile(store.getHistoryPath(), 'utf8')).toBe(before);
    expect(await archives()).toHaveLength(0);
  });

  it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid batch limit %s without mutation', async limit => {
    await seed(2, store);
    await expect(consolidator.consolidateToMemory(store, limit)).rejects.toThrow();
    expect(await store.getHistoryCount()).toBe(2);
  });
});
