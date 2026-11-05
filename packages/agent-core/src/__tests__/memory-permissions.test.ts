import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ts from 'typescript';
import { MemoryHistory } from '../memory-history.js';

// #723: use child processes so umask changes cannot affect other test workers.
describe.skipIf(process.platform === 'win32')('private memory files on a real filesystem', () => {
  it('refuses append when existing history permissions cannot be tightened (#723)', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-permissions-'));
    try {
      const history = new MemoryHistory(workspace);
      await history.append({ text: 'synthetic original' });
      const previous = await fs.readFile(history.file, 'utf8');
      await fs.chmod(history.file, 0o644);
      const open = fs.open.bind(fs);
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (args[0] === history.file && args[1] === 'a') {
          vi.spyOn(handle, 'chmod').mockRejectedValueOnce(new Error('synthetic chmod failure'));
        }
        return handle;
      });
      await expect(history.append({ text: 'must not append' })).rejects.toThrow('synthetic chmod failure');
      expect(await fs.readFile(history.file, 'utf8')).toBe(previous);
    } finally {
      vi.restoreAllMocks();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it.each(['022', '077'])('keeps new, replaced and recovered files private with umask %s', async mask => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-permissions-'));
    try {
      const fixture = path.join(workspace, 'worker');
      await fs.mkdir(fixture);
      await fs.writeFile(path.join(fixture, 'package.json'), '{"type":"module"}');
      for (const name of ['memory', 'memory-history', 'memory-record']) {
        const source = await fs.readFile(new URL(`../${name}.ts`, import.meta.url), 'utf8');
        await fs.writeFile(path.join(fixture, `${name}.js`), ts.transpileModule(source, {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        }).outputText);
      }
      await fs.writeFile(path.join(fixture, 'verify.mjs'), `
        import assert from 'node:assert/strict';
        import fs from 'node:fs/promises';
        import path from 'node:path';
        import { MemoryStore } from './memory.js';
        import { MemoryHistory } from './memory-history.js';
        import { StructuredMemoryStore } from './memory-record.js';
        process.umask(parseInt(process.argv[3], 8));
        const root = process.argv[2];
        const store = new MemoryStore(root);
        const history = new MemoryHistory(root);
        const records = new StructuredMemoryStore(store.getMemoryDir());
        const mode = async file => (await fs.stat(file)).mode & 0o777;
        const privateFile = async file => assert.equal(await mode(file), 0o600, file);
        const textFiles = [
          ['MEMORY.md', value => store.writeMemory(value)],
          ['SOUL.md', value => store.writeSoul(value)],
          ['AGENTS.md', value => store.writeAgents(value)],
        ];
        // Inspect the actual temporary inode before every atomic publication.
        const rename = fs.rename.bind(fs);
        let publications = 0;
        fs.rename = async (from, to) => {
          await privateFile(from);
          publications++;
          await rename(from, to);
        };
        for (const [name, write] of textFiles) {
          const file = path.join(root, name);
          await write('synthetic original');
          await privateFile(file);
          for (const prior of [0o600, 0o644, 0o666, 0o400]) {
            await fs.chmod(file, prior);
            await write('synthetic replacement');
            await privateFile(file);
            assert.equal(await fs.readFile(file, 'utf8'), 'synthetic replacement');
          }
        }
        await store.updateMemory('synthetic append');
        await privateFile(path.join(root, 'MEMORY.md'));
        await records.transaction(state => { state.tombstones.push('synthetic-a'); });
        await privateFile(records.file);
        await fs.chmod(records.file, 0o644);
        await records.transaction(state => { state.tombstones.push('synthetic-b'); });
        await privateFile(records.file);
        assert.deepEqual((await records.readSnapshot()).tombstones, ['synthetic-a', 'synthetic-b']);
        await store.appendHistory({ text: 'synthetic first' });
        await privateFile(history.file);
        await fs.chmod(history.file, 0o644);
        await store.appendHistory({ text: 'synthetic second' });
        await privateFile(history.file);
        assert.equal((await history.list()).length, 2);
        // Pause at the public archive callback with a durable journal and archive.
        const journal = path.join(history.directory, 'consolidation-pending.json');
        const cursor = path.join(history.directory, 'consolidation-cursor.json');
        let archive;
        await assert.rejects(history.archiveBatch(1, async id => {
          archive = path.join(history.directory, 'memory-archive', id + '.json');
          await privateFile(journal);
          await privateFile(archive);
          throw new Error('synthetic interruption');
        }), /synthetic interruption/);
        const batch = JSON.parse(await fs.readFile(journal, 'utf8'));
        await fs.chmod(journal, 0o644);
        await fs.chmod(archive, 0o644);
        // Recovery reuses existing immutable content, and must tighten it too.
        await new MemoryHistory(root).archiveBatch(1, async () => {
          await privateFile(journal);
          await privateFile(archive);
        });
        await privateFile(cursor);
        await privateFile(history.file);
        assert.equal((await history.list()).length, 1);
        assert.deepEqual(JSON.parse(await fs.readFile(archive, 'utf8')), batch);
        await assert.rejects(fs.access(journal), { code: 'ENOENT' });
        await fs.chmod(cursor, 0o644);
        await store.archiveHistoryBatch(1);
        await privateFile(cursor);
        await privateFile(path.join(root, 'MEMORY.md'));
        assert.equal((await history.list()).length, 0);
        // Legacy history migration and clear both use atomic replacement.
        await fs.writeFile(history.file, JSON.stringify({ text: 'synthetic legacy' }) + '\\n');
        await fs.chmod(history.file, 0o644);
        await store.appendHistory({ text: 'synthetic after migration' });
        await privateFile(history.file);
        assert.equal((await history.list()).length, 2);
        await fs.chmod(history.file, 0o644);
        await store.clearHistory();
        await privateFile(history.file);
        assert.equal((await history.list()).length, 0);
        // A failed publication preserves the old content and removes the temp file.
        const file = path.join(root, 'SOUL.md');
        const previous = await fs.readFile(file, 'utf8');
        fs.rename = async () => { throw new Error('synthetic rename failure'); };
        await assert.rejects(store.writeSoul('synthetic failed'), /synthetic rename failure/);
        assert.equal(await fs.readFile(file, 'utf8'), previous);
        await privateFile(file);
        assert.equal((await fs.readdir(root)).filter(name => name.endsWith('.tmp')).length, 0);
        fs.rename = rename;
        assert.ok(publications > 20);
        console.log('PASS umask=' + process.argv[3] + ' publications=' + publications + ' real filesystem, synthetic content');
      `);
      const result = await promisify(execFile)(process.execPath, [path.join(fixture, 'verify.mjs'), workspace, mask]);
      console.log(result.stdout.trim());
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
