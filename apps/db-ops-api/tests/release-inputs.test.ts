import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
const fixtures: string[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
it('rejects tracked and untracked build input changes but permits report-only changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slide-release-test-')); fixtures.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.invalid');
  await mkdir(join(dir, 'frontend')); await writeFile(join(dir, 'frontend/main.ts'), 'original');
  git('add', '.'); git('commit', '-m', 'baseline');
  const check = () => spawnSync('bash', [resolve('../../scripts/release/assert-clean-source.sh')], { cwd: dir, encoding: 'utf8' });
  expect(check().status).toBe(0);
  await writeFile(join(dir, 'frontend/main.ts'), 'modified'); expect(check().stderr).toContain('RELEASE_SOURCE_DIRTY');
  git('restore', 'frontend/main.ts'); await writeFile(join(dir, 'frontend/new.ts'), 'new'); expect(check().status).toBe(1);
  await rm(join(dir, 'frontend/new.ts')); await mkdir(join(dir, 'docs')); await writeFile(join(dir, 'docs/review.md'), 'report'); expect(check().status).toBe(0);
});
