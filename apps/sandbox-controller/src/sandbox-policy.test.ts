import { describe, expect, it } from 'vitest';
import { buildDockerRunArgs, parseExecutionProfiles, parseImageAllowlist, validateRelativeFilePath } from './sandbox-policy.js';

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

  it('uses only the preconfigured restricted network for network jobs', () => {
    const args = buildDockerRunArgs({
      jobId: '11111111-1111-1111-1111-111111111111',
      workspace: '/var/lib/slide-sandbox/job',
      job: { runtime: 'node', command: ['node', 'main.js'], networkMode: 'restricted' },
      images,
      restrictedNetwork: 'slide-restricted-egress',
      networkImage: 'slide-network-tools@sha256:' + 'b'.repeat(64),
    });
    expect(args).toContain('--network');
    expect(args).toContain('slide-restricted-egress');
    expect(() => buildDockerRunArgs({
      jobId: '11111111-1111-1111-1111-111111111111',
      workspace: '/var/lib/slide-sandbox/job',
      job: { runtime: 'node', command: ['node', 'main.js'], networkMode: 'restricted' },
      images,
    })).toThrow('SANDBOX_NETWORK_UNAVAILABLE');
  });

  it('resolves a logical execution profile to a digest-pinned image', () => {
    const args = buildDockerRunArgs({
      jobId: '123e4567-e89b-12d3-a456-426614174000', workspace: '/var/lib/slide-sandbox/job',
      job: { runtime: 'shell', command: ['nmap', '-V'], networkMode: 'restricted', executionProfile: 'database-network-scan' },
      images: { shell: 'node@sha256:' + 'a'.repeat(64) },
      executionProfiles: { 'database-network-scan': 'nmap@sha256:' + 'b'.repeat(64) },
      restrictedNetwork: 'restricted-net',
    });
    expect(args).toContain('nmap@sha256:' + 'b'.repeat(64));
    expect(args).not.toContain('node@sha256:' + 'a'.repeat(64));
  });

  it('rejects unpinned or malformed execution profiles', () => {
    expect(() => parseExecutionProfiles('{"database-network-scan":"nmap:latest"}')).toThrow('SANDBOX_EXECUTION_PROFILES_INVALID');
  });
});
