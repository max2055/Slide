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
  it('returns successful arrays over an actual HTTP socket and limits topsql to ten', async () => {
    const slow = vi.spyOn(databaseService, 'getSlowQueries').mockImplementation(async (_id, _limit, source) => {
      source?.('mysql-performance-schema');
      return [];
    });
    vi.spyOn(databaseService, 'getActiveSessions').mockResolvedValue([{ id: 7 }]);
    const app = await appWithAccess();
    await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const base = app.listeningOrigin + '/api/database/instances/991/';
      const top = await fetch(base + 'topsql?limit=80');
      expect(top.status).toBe(200);
      expect(await top.json()).toEqual([]);
      expect(top.headers.get('x-slide-query-source')).toBe('mysql-performance-schema');
      expect(slow.mock.calls[0][1]).toBe(10);
      const sessions = await fetch(base + 'sessions');
      expect(sessions.status).toBe(200);
      expect(await sessions.json()).toEqual([{ id: 7 }]);
    } finally { await app.close(); }
  });
  it.each([
    ['source-forbidden', 424, 'SOURCE_PERMISSION_DENIED'],
    ['source-unavailable', 503, 'SOURCE_UNAVAILABLE'],
    ['read-failed', 502, 'SOURCE_READ_FAILED'],
  ] as const)('%s is distinct from no connection and from object permissions', async (issue, status, error) => {
    vi.spyOn(databaseService, 'getSlowQueries').mockImplementation(async (_id, _limit, _source, report) => {
      report?.(issue);
      return null;
    });
    const app = await appWithAccess();
    try {
      const response = await app.inject('/api/database/instances/991/topsql');
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ error });
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
