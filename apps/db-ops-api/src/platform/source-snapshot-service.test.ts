import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceSnapshotService } from './source-snapshot-service.js';

const roots: string[] = [];
const commit = 'a'.repeat(40);
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'slide-source-test-')); roots.push(root);
  const service = new SourceSnapshotService(root, 'test-signing-key-not-production-123456');
  const manifest = await service.publish({ releaseId: 'release-1', commitSha: commit, projectId: '7' }, [{ path: 'src/example.ts', content: 'export function inspect() { return 1; }\n' }]);
  return { root, service, manifest };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('source snapshot boundary', () => {
  it('reads version-bound snippets and locates TypeScript symbols without execution', async () => {
    const { service, manifest } = await setup();
    const binding = { commitSha: commit, treeDigest: manifest.treeDigest };
    const result = await service.read('release-1', binding, 'src/example.ts', 1, 1);
    expect(result.content).toContain('function inspect');
    expect(result.fileDigest).toHaveLength(64);
    expect(await service.search('release-1', binding, 'inspect')).toHaveLength(1);
    expect(await service.symbols('release-1', binding, 'inspect')).toEqual([expect.objectContaining({ name: 'inspect', path: 'src/example.ts', line: 1 })]);
  });
  it('rejects traversal, wrong deployments, unlisted paths and oversized regions', async () => {
    const { service, manifest } = await setup(); const binding = { commitSha: commit, treeDigest: manifest.treeDigest };
    await expect(service.read('release-1', binding, '../secret', 1, 1)).rejects.toThrow('SOURCE_PATH_INVALID');
    await expect(service.read('release-1', { ...binding, commitSha: 'b'.repeat(40) }, 'src/example.ts', 1, 1)).rejects.toThrow('SOURCE_SNAPSHOT_UNTRUSTED');
    await expect(service.read('release-1', binding, 'src/missing.ts', 1, 1)).rejects.toThrow('SOURCE_PATH_NOT_ALLOWED');
    await expect(service.read('release-1', binding, 'src/example.ts', 1, 201)).rejects.toThrow('SOURCE_REGION_INVALID');
  });
  it('detects filesystem and manifest tampering after publication', async () => {
    const { root, service, manifest } = await setup(); const binding = { commitSha: commit, treeDigest: manifest.treeDigest };
    await chmod(join(root, 'release-1', 'src/example.ts'), 0o600);
    await writeFile(join(root, 'release-1', 'src/example.ts'), 'changed');
    await expect(service.read('release-1', binding, 'src/example.ts', 1, 1)).rejects.toThrow('SOURCE_SNAPSHOT_UNTRUSTED');
    const path = join(root, 'release-1', 'manifest.json'); const parsed = JSON.parse(await readFile(path, 'utf8'));
    parsed.signature = '0'.repeat(64); await chmod(path, 0o600); await writeFile(path, JSON.stringify(parsed));
    await expect(service.manifest('release-1', binding)).rejects.toThrow('SOURCE_SNAPSHOT_UNTRUSTED');
  });
  it('rejects sensitive files, secret literals, duplicate paths and symbolic links', async () => {
    const { root, service, manifest } = await setup(); const identity = { releaseId: 'release-2', commitSha: commit, projectId: '7' };
    await expect(service.publish(identity, [{ path: '.env', content: 'value' }])).rejects.toThrow('SOURCE_PATH_INVALID');
    await expect(service.publish(identity, [{ path: 'src/a.ts', content: 'const password = "sensitive-example";' }])).rejects.toThrow('SOURCE_SENSITIVE_CONTENT');
    await expect(service.publish(identity, [{ path: 'src/a.ts', content: '' }, { path: 'src/a.ts', content: '' }])).rejects.toThrow('SOURCE_DUPLICATE_PATH');
    await rm(join(root, 'release-1', 'src/example.ts')); await symlink('/etc/hosts', join(root, 'release-1', 'src/example.ts'));
    await expect(service.read('release-1', { commitSha: commit, treeDigest: manifest.treeDigest }, 'src/example.ts', 1, 1)).rejects.toThrow('SOURCE_SNAPSHOT_UNTRUSTED');
  });
});
