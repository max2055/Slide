import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PromptManager } from './prompt-manager.js';

const temporaryDirectories: string[] = [];
const readOnlyDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'slide-prompts-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(readOnlyDirectories.splice(0).map(directory => chmod(directory, 0o700).catch(() => undefined)));
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await chmod(directory, 0o700).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }));
});

describe('PromptManager persistent version directory', () => {
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
