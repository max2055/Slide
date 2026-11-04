import { describe, expect, it } from 'vitest';
import { resolveDeploymentBinding, createSourceBinding } from './deployment-binding.js';
import { describeSourceFiles, MAX_FILES, MAX_SNAPSHOT_BYTES } from './source-snapshot-service.js';
import { createHash } from 'node:crypto';

describe('release source binding', () => {
  const commit = 'a'.repeat(40);
  it('allows a mounted manifest when optional Compose overrides are all empty', () => {
    const source = { releaseId: 'release-1', commitSha: commit, treeDigest: 'b'.repeat(64) };
    expect(resolveDeploymentBinding({ SLIDE_RELEASE_ID: '', SLIDE_COMMIT_SHA: '', SLIDE_SOURCE_DIGEST: '' }, { source })).toEqual(source);
  });
  it('uses the exact same stable file digest as source synchronization', () => {
    const files = [{ path: 'src/z.ts', content: 'export const z = 1;' }, { path: 'src/A.ts', content: 'export const a = 1;' }];
    const binding = createSourceBinding('release-1', commit, ['src/'], files);
    expect(binding.treeDigest).toBe(createHash('sha256').update(JSON.stringify(describeSourceFiles(files))).digest('hex'));
    expect(resolveDeploymentBinding({}, { source: binding })).toMatchObject({ releaseId: 'release-1', commitSha: commit, treeDigest: binding.treeDigest });
  });
  it('requires a complete trusted identity but permits flagged content in the digest', () => {
    expect(() => resolveDeploymentBinding({ SLIDE_RELEASE_ID: 'partial' }, { source: { releaseId: 'old', commitSha: commit, treeDigest: 'b'.repeat(64) } })).toThrow('SOURCE_DEPLOYMENT_UNKNOWN');
    expect(() => createSourceBinding('r', commit, ['src/'], [{ path: 'src/a.ts', content: 'const password = "fixture-literal"' }])).not.toThrow();
    expect(() => createSourceBinding('r', commit, ['src/'], [{ path: 'outside/a.ts', content: '' }])).toThrow('SOURCE_PATH_INVALID');
  });
  it('uses the snapshot file-count and byte limits', () => {
    const content = 'export x=1\n';
    const files = (count: number) => Array.from({ length: count }, (_, index) => ({ path: `src/f${index}.ts`, content }));
    expect(Buffer.byteLength(content) * 4001).toBe(44011);
    expect(createSourceBinding('r', commit, ['src/'], files(4000)).fileCount).toBe(4000);
    expect(createSourceBinding('r', commit, ['src/'], files(4001)).fileCount).toBe(4001);
    expect(createSourceBinding('r', commit, ['src/'], files(MAX_FILES)).fileCount).toBe(20000);
    expect(() => createSourceBinding('r', commit, ['src/'], files(MAX_FILES + 1))).toThrow('SOURCE_FILE_COUNT_INVALID');
    const companion = 'export const a = 1;\n';
    const room = MAX_SNAPSHOT_BYTES - Buffer.byteLength(companion);
    const atLimit = [{ path: 'src/a.ts', content: companion }, { path: 'src/b.ts', content: 'a'.repeat(room) }];
    expect(createSourceBinding('r', commit, ['src/'], atLimit).fileCount).toBe(2);
    expect(() => createSourceBinding('r', commit, ['src/'], [{ path: 'src/a.ts', content: companion }, { path: 'src/b.ts', content: 'a'.repeat(room + 1) }])).toThrow('SOURCE_SNAPSHOT_TOO_LARGE');
  });
});
