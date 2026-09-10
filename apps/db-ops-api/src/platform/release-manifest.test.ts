import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { expect, it } from 'vitest';

it('generates root-relative deployment source from the API package working directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'slide-manifest-test-'));
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const destination = join(directory, 'RELEASE.json');
    execFileSync(process.execPath, ['--import', 'tsx', resolve('../../scripts/release/write-release-manifest.ts'), destination, 'qualification', commit], { env: { ...process.env, SLIDE_SOURCE_PATHS: 'apps/db-ops-api/src/evidence/' }, stdio: 'pipe' });
    const manifest = JSON.parse(await readFile(destination, 'utf8'));
    expect(manifest.source).toMatchObject({ releaseId: 'qualification', commitSha: commit });
    expect(manifest.source.treeDigest).toMatch(/^[a-f0-9]{64}$/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('omits source binding when no reviewed source paths are configured', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'slide-manifest-test-'));
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const destination = join(directory, 'RELEASE.json');
    const env = { ...process.env };
    delete env.SLIDE_SOURCE_PATHS;
    execFileSync(process.execPath, ['--import', 'tsx', resolve('../../scripts/release/write-release-manifest.ts'), destination, 'qualification', commit], { env, stdio: 'pipe' });
    const manifest = JSON.parse(await readFile(destination, 'utf8'));
    expect(manifest).not.toHaveProperty('source');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
