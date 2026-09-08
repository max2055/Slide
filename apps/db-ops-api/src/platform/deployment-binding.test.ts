import { describe, expect, it } from 'vitest';
import { resolveDeploymentBinding, createSourceBinding } from './deployment-binding.js';
import { describeSourceFiles } from './source-snapshot-service.js';
import { createHash } from 'node:crypto';

describe('release source binding', () => {
  const commit = 'a'.repeat(40);
  it('uses the exact same stable file digest as source synchronization', () => {
    const files = [{ path: 'src/z.ts', content: 'export const z = 1;' }, { path: 'src/A.ts', content: 'export const a = 1;' }];
    const binding = createSourceBinding('release-1', commit, ['src/'], files);
    expect(binding.treeDigest).toBe(createHash('sha256').update(JSON.stringify(describeSourceFiles(files))).digest('hex'));
    expect(resolveDeploymentBinding({}, { source: binding })).toMatchObject({ releaseId: 'release-1', commitSha: commit, treeDigest: binding.treeDigest });
  });
  it('requires a complete trusted identity and rejects partial overrides or unsafe files', () => {
    expect(() => resolveDeploymentBinding({ SLIDE_RELEASE_ID: 'partial' }, { source: { releaseId: 'old', commitSha: commit, treeDigest: 'b'.repeat(64) } })).toThrow('SOURCE_DEPLOYMENT_UNKNOWN');
    expect(() => createSourceBinding('r', commit, ['src/'], [{ path: 'src/a.ts', content: 'const password = "unsafe-literal"' }])).toThrow('SOURCE_SENSITIVE_CONTENT');
    expect(() => createSourceBinding('r', commit, ['src/'], [{ path: 'outside/a.ts', content: '' }])).toThrow('SOURCE_PATH_INVALID');
  });
});
