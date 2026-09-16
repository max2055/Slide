import { describe, expect, it } from 'vitest';
import { resolveDeploymentBinding, createSourceBinding } from './deployment-binding.js';
import { describeSourceFiles } from './source-snapshot-service.js';
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
});
