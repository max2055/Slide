import { describe, expect, it, vi } from 'vitest';
import { platformTools } from './platform_tools.js';
import { sourceManagementService } from '../../../platform/source-management-service.js';
const actor = { userId: 1, username: 'admin', permissions: ['config:view'], roles: [], instanceScopes: {}, requestId: 'request', sessionVersion: 1 };
describe('platform tool boundaries', () => {
  it('always applies model egress policy even if arguments pretend to be local', async () => {
    const inspect = vi.spyOn(sourceManagementService, 'inspect').mockRejectedValue(new Error('SOURCE_MODEL_EGRESS_DENIED'));
    const tool = platformTools.find(tool => tool.name === 'read_source_region')!;
    const result = await tool.handler({ path: 'src/a.ts', startLine: 1, endLine: 1, model: false }, { actor });
    expect(result.success).toBe(false); expect(inspect).toHaveBeenCalledWith(actor, 'read', expect.anything(), true);
    inspect.mockRestore();
  });
  it('refuses platform logs without operator permissions', async () => {
    const tool = platformTools.find(tool => tool.name === 'get_platform_observations')!;
    expect((await tool.handler({}, { actor: { ...actor, permissions: [] } })).success).toBe(false);
    expect((await tool.handler({}, undefined)).success).toBe(false);
  });
});
