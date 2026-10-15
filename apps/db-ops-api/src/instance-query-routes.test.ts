import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { databaseService } from './database-service.js';
import { registerInstanceQueryRoutes } from './instance-query-routes.js';
afterEach(() => vi.restoreAllMocks());
async function appWithAccess(permissions: string[] = ['instance:view'], instanceScopes: Record<number, string> = { 991: 'read-only' }) {
  const app = Fastify();
  await registerInstanceQueryRoutes(app, async request => { (request as any).user = { permissions, instanceScopes }; });
  return app;
}
describe('instance query routes keep array success and unavailable distinct', () => {
  it('keeps the array body and attaches the actual fallback source', async () => {
    vi.spyOn(databaseService, 'getSlowQueries').mockImplementation(async (_id, _limit, source) => { source?.('mysql-slow-log'); return []; });
    const app = await appWithAccess();
    try {
      const response = await app.inject('/api/database/instances/991/topsql');
      expect(response.statusCode).toBe(200); expect(response.json()).toEqual([]);
      expect(response.headers['x-slide-query-source']).toBe('mysql-slow-log');
    } finally { await app.close(); }
  });
  it.each(['topsql', 'sessions'])('%s unavailable does not return a successful empty array', async kind => {
    vi.spyOn(databaseService, kind === 'topsql' ? 'getSlowQueries' : 'getActiveSessions').mockResolvedValue(null);
    const app = await appWithAccess();
    try { const response = await app.inject(`/api/database/instances/991/${kind}`); expect(response.statusCode).toBe(404); expect(response.json()).toHaveProperty('error'); }
    finally { await app.close(); }
  });
  it.each([['no permission', [], { 991: 'read-only' }], ['no instance access', ['instance:view'], {}]] as const)('blocks %s before querying either source', async (_name, permissions, scopes) => {
    const slow = vi.spyOn(databaseService, 'getSlowQueries'), sessions = vi.spyOn(databaseService, 'getActiveSessions');
    const app = await appWithAccess([...permissions], scopes);
    try {
      for (const kind of ['topsql', 'sessions']) expect((await app.inject(`/api/database/instances/991/${kind}`)).statusCode).toBe(403);
      expect(slow).not.toHaveBeenCalled(); expect(sessions).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
