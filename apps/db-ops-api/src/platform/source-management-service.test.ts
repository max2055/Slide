import { describe, expect, it, vi } from 'vitest';
import { SourceManagementService } from './source-management-service.js';
const actor = { userId: 1, username: 'admin', permissions: ['admin:*'], roles: [], instanceScopes: {}, requestId: 'request', sessionVersion: 1 };
describe('source management authorization', () => {
  it('requires administrator to configure a repository and never saves its token', async () => {
    const execute = vi.fn(async () => [[], []]); const service = new SourceManagementService(() => ({ execute }), ['https://gitlab.example.test']);
    const config = { baseUrl: 'https://gitlab.example.test', projectId: '7', allowedPaths: ['src/'], allowModelContent: false };
    await expect(service.save({ ...actor, permissions: [] }, config)).rejects.toThrow('SOURCE_ADMIN_REQUIRED');
    await expect(service.save(actor, { ...config, token: 'secret' })).rejects.toThrow('SOURCE_CONFIG_INVALID');
    expect(execute).not.toHaveBeenCalled();
    await service.save(actor, config); expect(JSON.stringify(execute.mock.calls)).not.toContain('secret');
  });
  it('rejects unapproved source hosts before persistence', async () => {
    const execute = vi.fn(); const service = new SourceManagementService(() => ({ execute }), ['https://gitlab.example.test']);
    await expect(service.save(actor, { baseUrl: 'https://evil.test', projectId: '7', allowedPaths: ['src/'], allowModelContent: false })).rejects.toThrow('SOURCE_ORIGIN_DENIED');
    expect(execute).not.toHaveBeenCalled();
  });
});
