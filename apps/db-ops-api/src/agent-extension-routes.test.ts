import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('./skills/loader.js', () => ({ skillRegistry: {} }));
vi.mock('./adapter/get-agent-engine.js', () => ({ getAgentEngine: vi.fn() }));
vi.mock('./skills/runtime-policy.js', () => ({ isSkillEnabled: vi.fn(), setSkillEnabled: vi.fn() }));
vi.mock('./tools/security-catalog.js', () => ({ getToolSecurityDefinition: vi.fn() }));
import { agentManagementService as service } from './agent-management-service.js';
import { registerExtensionRoutes } from '../tests/fixtures/extension-routes.js';
afterEach(() => vi.restoreAllMocks());
it.each([['*'], ['ai:view'], ['ai:*'], ['*:view'], ['ai:view', 'admin:*'], []].map(permissions => ({ permissions })))('#415 production routes enforce read/write for $permissions', async ({ permissions }) => {
  const read = vi.spyOn(service, 'listExtensions').mockResolvedValue([]);
  const create = vi.spyOn(service, 'createExtension').mockResolvedValue({ id: 1 } as any);
  const update = vi.spyOn(service, 'updateExtension').mockResolvedValue({ id: 1 } as any);
  const status = vi.spyOn(service, 'setExtensionStatus').mockResolvedValue({ id: 1 } as any);
  const app = Fastify(); registerExtensionRoutes(app, async request => { (request as any).user = { userId: 1, username: 'fixture', roles: [], permissions }; });
  const codes = permissions; const admin = codes.includes('*') || codes.includes('admin:*');
  try {
    expect((await app.inject('/api/agent/extensions?kind=skill')).statusCode).toBe(codes.length ? 200 : 403);
    for (const [method, url] of [['POST', '/api/agent/extensions'], ['PUT', '/api/agent/extensions/1'], ['POST', '/api/agent/extensions/1/publish'], ['DELETE', '/api/agent/extensions/1']] as const) {
      const response = await app.inject({ method, url, ...(method === 'POST' || method === 'PUT' ? { payload: {} } : {}) });
      expect(response.statusCode).toBe(admin ? (method === 'POST' && url.endsWith('extensions') ? 201 : 200) : 403);
    }
    if (!admin) { expect(create).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled(); expect(status).not.toHaveBeenCalled(); }
    expect(read).toHaveBeenCalledTimes(codes.length ? 1 : 0);
  } finally { await app.close(); }
});
