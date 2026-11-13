import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { MAX_FILES } from './source-snapshot-service.js';

const script = fileURLToPath(new URL('../../../../scripts/release/write-release-manifest.ts', import.meta.url));
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'manifest',
  GIT_AUTHOR_EMAIL: 'manifest@example.com',
  GIT_COMMITTER_NAME: 'manifest',
  GIT_COMMITTER_EMAIL: 'manifest@example.com',
};

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
}

async function commitFiles(count: number) {
  const directory = await mkdtemp(join(tmpdir(), 'slide-manifest-count-'));
  git(directory, ['init', '-b', 'main']);
  const source = join(directory, 'src');
  mkdirSync(source);
  for (let index = 0; index < count; index += 1) writeFileSync(join(source, `f${index}.ts`), 'export x=1\n');
  git(directory, ['add', 'src']);
  git(directory, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
  return { directory, commit: git(directory, ['rev-parse', 'HEAD']).trim() };
}

function runManifest(directory: string, commit: string) {
  const destination = join(directory, 'RELEASE.json');
  const bin = join(directory, 'bin'), calls = join(directory, 'git-calls');
  mkdirSync(bin);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const wrapper = join(bin, 'git');
  writeFileSync(wrapper, '#!/bin/sh\nprintf "%s\\n" "$1" >> "$MANIFEST_GIT_LOG"\nexec "$MANIFEST_REAL_GIT" "$@"\n');
  chmodSync(wrapper, 0o755);
  try {
    execFileSync(process.execPath, ['--import', 'tsx', script, destination, 'qualification', commit], {
      env: { ...gitEnv, PATH: `${bin}:${process.env.PATH}`, MANIFEST_GIT_LOG: calls, MANIFEST_REAL_GIT: realGit, SLIDE_SOURCE_PATHS: 'src/', GIT_DIR: join(directory, '.git'), GIT_WORK_TREE: directory },
      stdio: 'pipe',
      timeout: 60_000,
    });
    return { status: 0, stderr: '', destination, calls };
  } catch (error) {
    const failed = error as { status?: number; stderr?: Buffer };
    return { status: failed.status ?? 1, stderr: String(failed.stderr ?? ''), destination, calls };
  }
}

it.each([4000, 4001, MAX_FILES])('the release manifest script binds %i files inside the snapshot contract', async count => {
  const { directory, commit } = await commitFiles(count);
  try {
    const result = runManifest(directory, commit);
    expect(result.status).toBe(0);
    // MAX-640 CI recovery: process count must stay constant at the 20,000-file boundary.
    expect((await readFile(result.calls, 'utf8')).trim().split('\n')).toEqual(['ls-tree', 'cat-file', 'cat-file']);
    const manifest = JSON.parse(await readFile(result.destination, 'utf8'));
    expect(manifest).toMatchObject({
      version: 'qualification',
      commit,
      source: { releaseId: 'qualification', commitSha: commit, fileCount: count, allowedPaths: ['src/'] },
    });
    expect(manifest.source.treeDigest).toMatch(/^[a-f0-9]{64}$/);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it('the release manifest script rejects one file past the snapshot count', async () => {
  const { directory, commit } = await commitFiles(MAX_FILES + 1);
  try {
    const result = runManifest(directory, commit);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Error: SOURCE_FILE_COUNT_INVALID/);
    expect(result.stderr).not.toContain('spawnSync git ENOBUFS');
    expect((await readFile(result.calls, 'utf8')).trim()).toBe('ls-tree');
    await expect(readFile(result.destination)).rejects.toThrow(/ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);
