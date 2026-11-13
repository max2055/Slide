import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PromptManager } from './prompt-manager.js';

const temporaryDirectories: string[] = [];
const readOnlyDirectories: string[] = [];

beforeEach(() => {
  vi.stubEnv('PROMPT_VERSION', undefined);
  vi.stubEnv('PROMPT_AB_TEST', 'false');
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'slide-prompts-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(readOnlyDirectories.splice(0).map(directory => chmod(directory, 0o700).catch(() => undefined)));
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await chmod(directory, 0o700).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }));
});

async function fixture() {
  const root = await createTemporaryDirectory();
  const bundledVersionsDir = join(root, 'bundled');
  const versionsDir = join(root, 'persistent');
  await mkdir(bundledVersionsDir);
  await writeFile(join(bundledVersionsDir, 'sample-v2.md'), 'bundled');
  const manager = new PromptManager({ bundledVersionsDir, versionsDir });
  await manager.initialize();
  await manager.setVersionContent('sample', 2, 'custom');
  return { manager, versionsDir, bundledVersionsDir };
}

// These probes exercise the real filesystem; only timing/failure boundaries are injected.
const reload = (manager: PromptManager) => (manager as unknown as { reloadAll(): Promise<void> }).reloadAll();

describe('PromptManager version lifecycle (#360, #545, #696)', () => {
  it('#360 retains the complete snapshot during reload and after directory failure', async () => {
    const { manager, versionsDir } = await fixture();
    const original = fs.promises.readdir.bind(fs.promises);
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(fs.promises, 'readdir').mockImplementationOnce((async (...args: Parameters<typeof original>) => {
      entered();
      await gate;
      return original(...args);
    }) as typeof fs.promises.readdir);
    const pending = reload(manager);
    await blocked;
    try {
      expect(manager.getPrompt('sample')).toBe('custom');
    } finally {
      release();
      await pending;
    }
    await rm(versionsDir, { recursive: true });
    await expect(reload(manager)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(manager.getPrompt('sample')).toBe('custom');
  });

  it('#360 rejects a partial snapshot when an individual file cannot be read', async () => {
    const { manager, versionsDir } = await fixture();
    await rm(join(versionsDir, 'sample-v2.md'));
    await mkdir(join(versionsDir, 'sample-v2.md'));
    await expect(reload(manager)).rejects.toBeDefined();
    expect(manager.getPrompt('sample')).toBe('custom');
  });

  it('#360 serializes reloads with local edits and version creation', async () => {
    const { manager } = await fixture();
    const pending = reload(manager);
    const edit = manager.setVersionContent('sample', 2, 'edited');
    const create = manager.createVersion('sample', 'created');
    const followingReload = reload(manager);
    await Promise.all([pending, edit, create, followingReload]);
    expect(manager.getPrompt('sample')).toBe('edited');
    expect(manager.getVersionContent('sample', 3)).toBe('created');
  });

  it('#545 gives every concurrent request a unique version with its own content', async () => {
    const { manager, versionsDir } = await fixture();
    const contents = Array.from({ length: 12 }, (_, i) => `content-${i}`);
    const results = await Promise.all(contents.map(content => manager.createVersion('sample', content)));
    expect(new Set(results.map(result => result.version)).size).toBe(contents.length);
    for (const [i, result] of results.entries()) {
      expect(await readFile(join(versionsDir, result.fileName), 'utf-8')).toBe(contents[i]);
      expect(manager.getVersionContent('sample', result.version)).toBe(contents[i]);
    }
  });

  it('#545 publishes complete distinct files across competing processes with stale snapshots', async () => {
    const { manager, versionsDir, bundledVersionsDir } = await fixture();
    const children = Array.from({ length: 3 }, (_, worker) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
        import { PromptManager } from ${JSON.stringify(new URL('./prompt-manager.ts', import.meta.url).href)};
        const manager = new PromptManager(${JSON.stringify({ versionsDir, bundledVersionsDir })});
        await manager.initialize();
        process.send('ready');
        await new Promise(resolve => process.once('message', resolve));
        const content = ${JSON.stringify(`worker-${worker}:`)} + 'x'.repeat(65536);
        const results = await Promise.all(Array.from({ length: 4 }, () => manager.createVersion('sample', content)));
        await new Promise((resolve, reject) => process.send({ results, content }, error => error ? reject(error) : resolve()));
        process.disconnect();
      `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], timeout: 8000 });
      let errors = '';
      let receivedResult = false;
      child.stdout!.on('data', data => { errors += data; });
      child.stderr!.on('data', data => { errors += data; });
      const closed = once(child, 'close').then(([code]) => {
        if (code !== 0 || !receivedResult) throw new Error(`worker failed (${code}, ${process.execPath}): ${errors}`);
      });
      // tsx also uses IPC for dependency notifications, so wait for our own messages.
      const ready = new Promise<void>(resolve => {
        child.on('message', message => { if (message === 'ready') resolve(); });
      });
      type WorkerResult = { results: { version: number; fileName: string }[]; content: string };
      const completed = new Promise<WorkerResult>(resolve => {
        child.on('message', message => {
          if (message && typeof message === 'object' && 'results' in message) {
            receivedResult = true;
            resolve(message as WorkerResult);
          }
        });
      });
      return { child, ready, completed, closed };
    });
    try {
      await Promise.all(children.map(({ ready, closed }) => Promise.race([ready, closed])));
      const completed = children.map(({ completed, closed }) => Promise.race([completed, closed.then(() => { throw new Error('worker exited without results'); })]));
      children.forEach(({ child }) => child.send('start'));
      const messages = await Promise.all(completed);
      await Promise.all(children.map(({ closed }) => closed));
      const versions = new Set<number>();
      for (const { results, content } of messages) {
        for (const result of results) {
          versions.add(result.version);
          expect(await readFile(join(versionsDir, result.fileName), 'utf-8')).toBe(content);
        }
      }
      expect(versions.size).toBe(12);
      await reload(manager);
      expect(manager.getTypeInfo('sample')!.versions).toHaveLength(13);
      expect((await readdir(versionsDir)).every(file => file.endsWith('.md'))).toBe(true);
    } finally {
      for (const { child } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
      await Promise.allSettled(children.map(({ closed }) => closed));
    }
  }, 10000);

  it('#545 starts at v1 for an empty collection and rejects exhausted version numbers', async () => {
    const { manager, versionsDir } = await fixture();
    await expect(manager.createVersion('new-type', 'first')).resolves.toMatchObject({ version: 1 });
    manager.getTypeInfo('sample')!.versions.length = 0;
    await expect(manager.createVersion('sample', 'next')).resolves.toMatchObject({ version: 3 });
    await writeFile(join(versionsDir, `full-v${Number.MAX_SAFE_INTEGER}.md`), 'last');
    await expect(manager.createVersion('full', 'overflow')).rejects.toThrow('安全整数');
    expect((await readdir(versionsDir)).some(file => /Infinity|NaN|\.tmp$/.test(file))).toBe(false);
  });

  it('#545 retries only definite filename collisions and preserves the winner', async () => {
    const { manager, versionsDir } = await fixture();
    vi.spyOn(fs.promises, 'link').mockImplementationOnce(async (_source, target) => {
      await writeFile(target, 'other process won');
      throw Object.assign(new Error('already exists'), { code: 'EEXIST' });
    });
    await expect(manager.createVersion('sample', 'mine')).resolves.toMatchObject({ version: 4 });
    expect(await readFile(join(versionsDir, 'sample-v3.md'), 'utf-8')).toBe('other process won');
    expect(await readFile(join(versionsDir, 'sample-v4.md'), 'utf-8')).toBe('mine');
  });

  it('#545 propagates publication failures, cleans staging files and recovers', async () => {
    const { manager, versionsDir } = await fixture();
    vi.spyOn(fs.promises, 'link').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(manager.createVersion('sample', 'failed')).rejects.toMatchObject({ code: 'EACCES' });
    expect(manager.getTypeInfo('sample')!.versions).toHaveLength(1);
    expect(await readdir(versionsDir)).toEqual(['sample-v2.md']);
    await expect(manager.createVersion('sample', 'success')).resolves.toMatchObject({ version: 3 });
  });

  it('#360 watches real events, catches sanitized failures, and recovers after a burst', async () => {
    const { manager, versionsDir } = await fixture();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const original = fs.promises.readdir.bind(fs.promises);
    const read = vi.spyOn(fs.promises, 'readdir').mockRejectedValue(Object.assign(
      new Error('secret body and /private/path'), { code: 'EACCES' },
    ));
    manager.startWatch();
    try {
      await writeFile(join(versionsDir, 'sample-v2.md'), 'changed');
      await vi.waitFor(() => expect(warning).toHaveBeenCalledWith(
        '[PromptManager] 文件监听或热重载失败，保留原快照 (EACCES)',
      ));
      expect(manager.getPrompt('sample')).toBe('custom');
      expect(JSON.stringify(warning.mock.calls)).not.toContain('secret');
      read.mockImplementation(original);
      await Promise.all(Array.from({ length: 5 }, (_, i) => writeFile(join(versionsDir, `extra-v${i + 1}.md`), `event-${i}`)));
      await vi.waitFor(() => {
        expect(manager.getPrompt('sample')).toBe('changed');
        expect(manager.getTypeInfo('extra')!.versions).toHaveLength(5);
      });
    } finally {
      manager.stopWatch();
    }
  });

  it('#696 fails initialization for an explicitly configured missing version', async () => {
    const { versionsDir, bundledVersionsDir } = await fixture();
    vi.stubEnv('PROMPT_VERSION', '99');
    const manager = new PromptManager({ versionsDir, bundledVersionsDir });
    await expect(manager.initialize()).rejects.toThrow(/v99/);
    expect(manager.getPrompt('sample')).toBe('');
  });

  it('#696 returns the requested existing version and never substitutes the highest', async () => {
    const { manager } = await fixture();
    await manager.createVersion('sample', 'newest');
    expect(manager.getPrompt('sample', 2)).toBe('custom');
    expect(manager.getPrompt('sample', 99)).toBe('');
  });

  it('#696 honors an explicitly configured existing version after restart', async () => {
    const { versionsDir, bundledVersionsDir } = await fixture();
    vi.stubEnv('PROMPT_VERSION', '2');
    const manager = new PromptManager({ versionsDir, bundledVersionsDir });
    await manager.initialize();
    expect(manager.getActiveVersion()).toBe(2);
    expect(manager.getPrompt('sample')).toBe('custom');
  });
});

describe('PromptManager persistent version directory', () => {
  it('defaults to the agent workspace instead of the bundled code directory', async () => {
    const workspace = await createTemporaryDirectory();
    const previous = process.env.AGENT_WORKSPACE;
    const previousDir = process.env.PROMPT_VERSIONS_DIR;
    process.env.AGENT_WORKSPACE = workspace;
    delete process.env.PROMPT_VERSIONS_DIR;
    try {
      const manager = new PromptManager();
      expect(manager.getVersionsDir()).toBe(join(workspace, 'prompts'));
      await manager.initialize();
      await expect(manager.createVersion('alert-rca', 'runtime version')).resolves.toMatchObject({ version: 3 });
      await expect(readFile(join(workspace, 'prompts', 'alert-rca-v3.md'), 'utf-8')).resolves.toBe('runtime version');
    } finally {
      if (previous === undefined) delete process.env.AGENT_WORKSPACE;
      else process.env.AGENT_WORKSPACE = previous;
      if (previousDir === undefined) delete process.env.PROMPT_VERSIONS_DIR;
      else process.env.PROMPT_VERSIONS_DIR = previousDir;
    }
  });

  it('fails at startup when the runtime directory is not writable', async () => {
    const root = await createTemporaryDirectory();
    const file = join(root, 'file');
    await writeFile(file, 'not a directory');
    const manager = new PromptManager({ versionsDir: join(file, 'prompts') });
    await expect(manager.initialize()).rejects.toThrow('提示词写入目录不可用');
  });

  it('propagates write failures without mutating the loaded version', async () => {
    const root = await createTemporaryDirectory();
    const bundledDirectory = join(root, 'bundled');
    const versionsDirectory = join(root, 'persistent');
    await mkdir(bundledDirectory);
    await writeFile(join(bundledDirectory, 'alert-rca-v1.md'), 'original');
    const manager = new PromptManager({ bundledVersionsDir: bundledDirectory, versionsDir: versionsDirectory });
    await manager.initialize();
    await rm(versionsDirectory, { recursive: true });
    await expect(manager.setVersionContent('alert-rca', 1, 'edit')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(manager.createVersion('alert-rca', 'new')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(manager.getVersionContent('alert-rca', 1)).toBe('original');
  });
  it('loads bundled prompts and creates versions outside a read-only bundle', async () => {
    const root = await createTemporaryDirectory();
    const bundledDirectory = join(root, 'bundled');
    const versionsDirectory = join(root, 'persistent');
    await mkdir(bundledDirectory);
    await writeFile(join(bundledDirectory, 'alert-rca-v1.md'), 'bundled v1', 'utf-8');
    await chmod(bundledDirectory, 0o555);
    readOnlyDirectories.push(bundledDirectory);

    const manager = new PromptManager({ bundledVersionsDir: bundledDirectory, versionsDir: versionsDirectory });
    await manager.initialize();

    await expect(manager.createVersion('alert-rca', 'custom v2')).resolves.toEqual({
      version: 2,
      fileName: 'alert-rca-v2.md',
    });
    await expect(readFile(join(versionsDirectory, 'alert-rca-v2.md'), 'utf-8')).resolves.toBe('custom v2');
    await expect(readdir(bundledDirectory)).resolves.toEqual(['alert-rca-v1.md']);
    await expect(readdir(versionsDirectory)).resolves.toEqual(['alert-rca-v2.md']);
  });

  it('preserves persisted edits and custom versions across initialization', async () => {
    const root = await createTemporaryDirectory();
    const bundledDirectory = join(root, 'bundled');
    const versionsDirectory = join(root, 'persistent');
    await mkdir(bundledDirectory);
    await writeFile(join(bundledDirectory, 'alert-rca-v1.md'), 'bundled v1', 'utf-8');

    const firstManager = new PromptManager({ bundledVersionsDir: bundledDirectory, versionsDir: versionsDirectory });
    await firstManager.initialize();
    await expect(firstManager.setVersionContent('alert-rca', 1, 'edited v1')).resolves.toBe(true);
    await expect(firstManager.createVersion('alert-rca', 'custom v2')).resolves.toMatchObject({ version: 2 });
    await expect(readFile(join(bundledDirectory, 'alert-rca-v1.md'), 'utf-8')).resolves.toBe('bundled v1');

    const restartedManager = new PromptManager({ bundledVersionsDir: bundledDirectory, versionsDir: versionsDirectory });
    await restartedManager.initialize();

    expect(restartedManager.getVersionContent('alert-rca', 1)).toBe('edited v1');
    expect(restartedManager.getVersionContent('alert-rca', 2)).toBe('custom v2');
  });
});
