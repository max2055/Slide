import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { MAX_FILE_BYTES, MAX_FILES } from './source-snapshot-service.js';

const script = fileURLToPath(new URL('../../../../scripts/release/write-release-manifest.ts', import.meta.url));
const TREE_LIST_BYTES = MAX_FILES * (512 + 1);
const FOUR_MIB = 4 * 1024 * 1024;
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'manifest',
  GIT_AUTHOR_EMAIL: 'manifest@example.com',
  GIT_COMMITTER_NAME: 'manifest',
  GIT_COMMITTER_EMAIL: 'manifest@example.com',
};

function git(cwd: string, args: string[], input?: Buffer | string, maxBuffer = 64 * 1024 * 1024) {
  return execFileSync('git', args, { cwd, env: gitEnv, input, encoding: 'utf8', maxBuffer });
}

async function commitEntries(entries: Array<{ path: string; content: Buffer | string }>) {
  const directory = await mkdtemp(join(tmpdir(), 'slide-manifest-buffer-'));
  git(directory, ['init', '-b', 'main']);
  const lines = entries.map(entry => {
    const sha = git(directory, ['hash-object', '-w', '--stdin'], entry.content, 1024 * 1024).trim();
    return `100644 ${sha}\t${entry.path}`;
  });
  git(directory, ['update-index', '--index-info'], `${lines.join('\n')}\n`);
  git(directory, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
  return { directory, commit: git(directory, ['rev-parse', 'HEAD']).trim() };
}

function treeBytes(directory: string, commit: string) {
  return Buffer.byteLength(git(directory, ['ls-tree', '--full-tree', '-r', '--name-only', '-z', commit]));
}

function fillerEntryBytes(width: number) {
  return `bulk/00000/${'n'.repeat(width)}.ts`.length + 1;
}

function fillers(count: number, width: number) {
  return Array.from({ length: count }, (_, index) => ({
    path: `bulk/${String(index).padStart(5, '0')}/${'n'.repeat(width)}.ts`,
    content: 'x',
  }));
}

function runManifest(directory: string, commit: string, sourcePaths: string) {
  const destination = join(directory, 'RELEASE.json');
  try {
    execFileSync(process.execPath, ['--import', 'tsx', script, destination, 'qualification', commit], {
      env: { ...gitEnv, SLIDE_SOURCE_PATHS: sourcePaths, GIT_DIR: join(directory, '.git'), GIT_WORK_TREE: directory },
      stdio: 'pipe',
    });
    return { status: 0, stderr: '', destination };
  } catch (error) {
    const failed = error as { status?: number; stderr?: Buffer };
    return { status: failed.status ?? 1, stderr: String(failed.stderr ?? ''), destination };
  }
}

it('writes a manifest for a 32MiB file and a tree listing above 4MiB', async () => {
  const count = Math.ceil((FOUR_MIB + 1) / fillerEntryBytes(4000));
  const { directory, commit } = await commitEntries([
    { path: 'apps/keep/large.ts', content: Buffer.alloc(MAX_FILE_BYTES, 0x61) },
    { path: 'secrets/key.ts', content: 'export const token = "abcdefghijklmnop";\n' },
    { path: 'node_modules/pkg/index.ts', content: 'export const bundled = true;\n' },
    { path: 'apps/keep/.hidden.ts', content: 'export const hidden = true;\n' },
    ...fillers(count, 4000),
  ]);
  try {
    const listed = treeBytes(directory, commit);
    expect(listed).toBeGreaterThan(FOUR_MIB);
    expect(listed).toBeLessThanOrEqual(TREE_LIST_BYTES);
    const result = runManifest(directory, commit, 'apps/keep/,secrets/,node_modules/');
    expect(result.status).toBe(0);
    const manifest = JSON.parse(await readFile(result.destination, 'utf8'));
    expect(manifest).toMatchObject({ version: 'qualification', commit, source: { releaseId: 'qualification', commitSha: commit, fileCount: 1, allowedPaths: ['apps/keep/', 'secrets/', 'node_modules/'] } });
    expect(manifest.source.treeDigest).toMatch(/^[a-f0-9]{64}$/);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 120_000);

it('rejects one file above the 32MiB contract with a domain error and no manifest', async () => {
  const { directory, commit } = await commitEntries([
    { path: 'apps/keep/large.ts', content: Buffer.alloc(MAX_FILE_BYTES + 1, 0x61) },
  ]);
  try {
    const result = runManifest(directory, commit, 'apps/keep/');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Error: SOURCE_FILE_TOO_LARGE/);
    expect(result.stderr).not.toContain('spawnSync git ENOBUFS');
    await expect(readFile(result.destination)).rejects.toThrow(/ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 120_000);

it('rejects a snapshot above 32MiB after both files are read', async () => {
  const { directory, commit } = await commitEntries([
    { path: 'apps/keep/a.ts', content: Buffer.alloc(MAX_FILE_BYTES, 0x61) },
    { path: 'apps/keep/b.ts', content: 'b' },
  ]);
  try {
    const result = runManifest(directory, commit, 'apps/keep/');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Error: SOURCE_SNAPSHOT_TOO_LARGE/);
    expect(result.stderr).not.toContain('spawnSync git ENOBUFS');
    await expect(readFile(result.destination)).rejects.toThrow(/ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 120_000);

it('rejects a complete tree listing above the file-count contract', async () => {
  const width = 8000;
  const count = Math.floor(TREE_LIST_BYTES / fillerEntryBytes(width)) + 2;
  const { directory, commit } = await commitEntries([
    { path: 'apps/keep/ok.ts', content: 'export const value = 1;\n' },
    ...fillers(count, width),
  ]);
  try {
    expect(treeBytes(directory, commit)).toBeGreaterThan(TREE_LIST_BYTES);
    const result = runManifest(directory, commit, 'apps/keep/');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Error: SOURCE_FILE_COUNT_INVALID/);
    expect(result.stderr).not.toContain('spawnSync git ENOBUFS');
    await expect(readFile(result.destination)).rejects.toThrow(/ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 120_000);

it('rejects a selected binary file before writing the manifest', async () => {
  const { directory, commit } = await commitEntries([
    { path: 'apps/keep/bad.ts', content: Buffer.from('a\0b') },
  ]);
  try {
    const result = runManifest(directory, commit, 'apps/keep/');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('SOURCE_BINARY_FILE');
    await expect(readFile(result.destination)).rejects.toThrow(/ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
