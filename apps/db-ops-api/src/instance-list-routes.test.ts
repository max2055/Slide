import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerInstanceListRoutes } from './instance-list-routes.js';
import { dbConnection } from './db-connection.js';
import { instanceDatabaseService } from './instance-database-service.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.restoreAllMocks(); });
const reader = { username: 'reader', permissions: ['instance:view'], roles: [], instanceScopes: { 7: 'read-only' } };
async function request(actor: unknown, load = vi.fn().mockResolvedValue([])) {
  const app = Fastify(); apps.push(app);
  await registerInstanceListRoutes(app, async req => { (req as any).user = actor; }, { getManagedInstances: load });
  return { response: await app.inject({ method: 'GET', url: '/api/database/instances' }), load };
}
describe('instance list boundary', () => {
  it.each([[null, 401], [{ ...reader, permissions: [] }, 403]])('rejects unauthorized access before querying', async (actor, code) => {
    const { response, load } = await request(actor); expect(response.statusCode).toBe(code); expect(load).not.toHaveBeenCalled();
  });
  it('preserves a genuinely empty successful list', async () => {
    const { response } = await request(reader); expect(response.statusCode).toBe(200); expect(response.json()).toEqual([]);
  });
  it('reports read failure without leaking driver details', async () => {
    const { response } = await request(reader, vi.fn().mockRejectedValue(new Error('driver credentials detail')));
    expect(response.statusCode).toBe(503); expect(response.json()).toEqual({ error: 'INSTANCE_ENUMERATION_UNAVAILABLE' });
  });
  it('filters inaccessible instances before public serialization', async () => {
    const { response } = await request(reader, vi.fn().mockResolvedValue([{ id: 8, password_encrypted: 'hidden' }]));
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual([]);
  });
  it.each(['getManagedInstances', 'getAllInstances'] as const)('%s never hides DB errors', async method => {
    const error = new Error('database unavailable');
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute: vi.fn().mockRejectedValue(error) } as any);
    await expect(instanceDatabaseService[method]()).rejects.toMatchObject({ message: 'INSTANCE_ENUMERATION_UNAVAILABLE', cause: error });
  });
  it('managed enumeration fails if the pool is missing', async () => {
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(null);
    await expect(instanceDatabaseService.getManagedInstances()).rejects.toThrow('INSTANCE_ENUMERATION_UNAVAILABLE');
  });
});
