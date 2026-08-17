import { describe, expect, it } from 'vitest';
import { buildDockerRunArgs, parseImageAllowlist, validateRelativeFilePath } from './sandbox-policy.js';

describe('rootless Docker sandbox policy', () => {
  const images = { node: 'node:22-alpine@sha256:' + 'a'.repeat(64) };

  it('hard-codes isolation controls around an allowlisted digest image', () => {
    const args = buildDockerRunArgs({
      jobId: '11111111-1111-1111-1111-111111111111',
      workspace: '/var/lib/slide-sandbox/job',
      job: { runtime: 'node', command: ['node', 'main.js'] },
      images,
    });
    expect(args).toEqual(expect.arrayContaining([
      '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges=true', '--user', '65532:65532',
    ]));
    expect(args.at(-3)).toBe(images.node);
    expect(args).toContain('type=bind,src=/var/lib/slide-sandbox/job,dst=/workspace');
    expect(args).not.toContain('type=bind,src=/var/lib/slide-sandbox/job,dst=/workspace,rw');
    expect(args).not.toContain('--privileged');
  });

  it('rejects mutable image tags and workspace traversal', () => {
    expect(() => parseImageAllowlist('{"node":"node:latest"}')).toThrow('SANDBOX_IMAGE_ALLOWLIST_INVALID');
    expect(() => parseImageAllowlist('{"node":"node@sha256:abcd"}')).toThrow('SANDBOX_IMAGE_ALLOWLIST_INVALID');
    expect(() => validateRelativeFilePath('../../etc/passwd')).toThrow('SANDBOX_FILE_PATH_INVALID');
  });

  it('bounds the environment passed into a sandbox job', () => {
    const env = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`KEY_${index}`, 'value']));
    expect(() => buildDockerRunArgs({
      jobId: '11111111-1111-1111-1111-111111111111',
      workspace: '/var/lib/slide-sandbox/job',
      job: { runtime: 'node', command: ['node', 'main.js'], env },
      images,
    })).toThrow('SANDBOX_ENV_INVALID');
  });
});
