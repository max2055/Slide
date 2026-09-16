import { describe, expect, it, vi } from 'vitest';
import { SourceManagementService } from './source-management-service.js';
import { auditLogManager } from '../audit/audit-log.js';
const actor = { userId: 1, username: 'admin', permissions: ['admin:*'], roles: [], instanceScopes: {}, requestId: 'request', sessionVersion: 1 };
describe('source management authorization', () => {
  it('invalidates snapshots when current directory or project access narrows', async () => {
    const config = { baseUrl: 'https://gitlab.example.test', repositoryPath: 'group/project', allowedPaths: ['src/public/'], allowModelContent: true };
    const service = new SourceManagementService(() => ({ execute: vi.fn(async () => [[{ config_value: JSON.stringify(config) }], []]) }), [config.baseUrl]);
    vi.spyOn(service as any, 'deployment').mockReturnValue({ releaseId: 'r', commitSha: 'a'.repeat(40), treeDigest: 'b'.repeat(64) });
    const snapshots = { manifest: vi.fn(async () => ({ projectId: 'group/project', files: [{ path: 'src/private/a.ts' }] })), read: vi.fn() };
    vi.spyOn(service as any, 'snapshots').mockReturnValue(snapshots);
    await expect(service.inspect(actor, 'read', { path: 'src/private/a.ts', startLine: 1, endLine: 1 }, true)).rejects.toThrow('SOURCE_SNAPSHOT_POLICY_CHANGED');
    expect(snapshots.read).not.toHaveBeenCalled();
    snapshots.manifest.mockResolvedValue({ projectId: '8', files: [] });
    await expect(service.inspect(actor, 'manifest')).rejects.toThrow('SOURCE_SNAPSHOT_POLICY_CHANGED');
  });
  it('bounds repeated source analysis calls even through tools', async () => {
    const service = new SourceManagementService(() => ({ execute: vi.fn(async () => [[], []]) }));
    for (let i = 0; i < 30; i++) await expect(service.inspect(actor, 'manifest')).rejects.toThrow('SOURCE_NOT_CONFIGURED');
    await expect(service.inspect(actor, 'manifest')).rejects.toThrow('SOURCE_RATE_LIMITED');
  });
  it('audits configuration changes without source text or credentials', async () => {
    const audit = vi.spyOn(auditLogManager, 'logConfigChange').mockResolvedValue(undefined as any);
    const service = new SourceManagementService(() => ({ execute: vi.fn(async () => [[], []]) }), ['https://gitlab.example.test']);
    await service.save(actor, { baseUrl: 'https://gitlab.example.test', repositoryPath: 'group/project', allowedPaths: ['src/'], allowModelContent: false });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ userId: '1', configKey: 'source.gitlab' }));
    audit.mockRestore();
  });
  it('requires administrator to configure a repository and never saves its token', async () => {
    const execute = vi.fn(async () => [[], []]); const service = new SourceManagementService(() => ({ execute }), ['https://gitlab.example.test']);
    const config = { baseUrl: 'https://gitlab.example.test', repositoryPath: 'group/project', allowedPaths: ['src/'], allowModelContent: false };
    await expect(service.save({ ...actor, permissions: [] }, config)).rejects.toThrow('SOURCE_ADMIN_REQUIRED');
    await expect(service.save(actor, { ...config, token: 'secret' })).rejects.toThrow('SOURCE_CONFIG_INVALID');
    expect(execute).not.toHaveBeenCalled();
    await service.save(actor, config); expect(JSON.stringify(execute.mock.calls)).not.toContain('secret');
  });
  it('rejects unapproved source hosts before persistence', async () => {
    const execute = vi.fn(); const service = new SourceManagementService(() => ({ execute }), ['https://gitlab.example.test']);
    await expect(service.save(actor, { baseUrl: 'https://evil.test', repositoryPath: 'group/project', allowedPaths: ['src/'], allowModelContent: false })).rejects.toThrow('SOURCE_ORIGIN_DENIED');
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('Git repository configuration', () => {
  const config = { provider: 'gitlab', baseUrl: 'https://gitlab.example.test', repositoryPath: 'group/subgroup/project', allowedPaths: ['src/'], allowModelContent: false };
  it('saves GitLab subgroup paths with a canonical field', async () => {
    const service = new SourceManagementService(() => ({ execute: vi.fn(async () => [[], []]) }), [config.baseUrl]);
    await expect(service.save(actor, config)).resolves.toMatchObject({ repositoryPath: config.repositoryPath });
  });
  it('migrates legacy GitHub paths on read', async () => {
    const legacy = { ...config, provider: 'github', repositoryPath: undefined, projectId: 'owner/repo' };
    const service = new SourceManagementService(() => ({ execute: vi.fn(async () => [[{ config_value: JSON.stringify(legacy) }], []]) }), [config.baseUrl]);
    await expect(service.load(actor)).resolves.toMatchObject({ repositoryPath: 'owner/repo' });
  });
  it.each(['123', '../repo', 'group/../repo', 'group//repo', 'group/repo.git', 'group/repo?token=x'])('rejects invalid repository path %s', async repositoryPath => {
    const execute = vi.fn();
    const service = new SourceManagementService(() => ({ execute }), [config.baseUrl]);
    await expect(service.save(actor, { ...config, repositoryPath })).rejects.toThrow('SOURCE_CONFIG_INVALID');
    expect(execute).not.toHaveBeenCalled();
  });
});
