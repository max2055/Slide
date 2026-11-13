import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerCronRoutes } from './cron-routes.js';
import { scriptService } from './script-service.js';
import { sqlExecutor } from '../sql-executor.js';

afterEach(() => vi.restoreAllMocks());
// MAX-423 / #654: exercise production HTTP validation and authorization.
async function request(payload: unknown, user: any = { userId: 7, username: 'tester', permissions: ['cron:manage'], instanceScopes: { 9: 'read-only' } }) {
  const app = Fastify();
  registerCronRoutes(app, async req => { (req as any).user = user; }, () => undefined);
  try { return await app.inject({ method: 'POST', url: '/api/cron/scripts/test', payload: payload as any }); }
  finally { await app.close(); }
}
describe('unsaved Cron script HTTP test', () => {
  it('executes a draft, limits output and never creates a script', async () => {
    const create = vi.spyOn(scriptService, 'createScript');
    const get = vi.spyOn(scriptService, 'getScriptById');
    const execute = vi.spyOn(sqlExecutor, 'executeSql').mockResolvedValue({ success: true, rows: Array.from({ length: 101 }, () => ({ n: 1 })), rowCount: 101 } as any);
    const result = await request({ instance_id: 9, content: 'SELECT 1', database: 'inspection' });
    expect(result.statusCode).toBe(200); expect(result.json().rows).toHaveLength(100);
    expect(result.json().rowCount).toBe(100);
    expect(execute).toHaveBeenCalledWith(9, 'SELECT 1', expect.objectContaining({ database: 'inspection', userId: '7', username: 'tester' }));
    expect(create).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
  });
  it.each([null, {}, { instance_id: '9', content: 'SELECT 1' }, { instance_id: 0, content: 'SELECT 1' }, { instance_id: 9.5, content: 'SELECT 1' }, { instance_id: 9, content: ' ' }, { instance_id: 9, content: {} }, { instance_id: 9, content: 'SELECT 1', database: {} }])('rejects invalid input %j before execution', async payload => {
    const execute = vi.spyOn(sqlExecutor, 'executeSql');
    expect((await request(payload)).statusCode).toBe(400); expect(execute).not.toHaveBeenCalled();
  });
  it.each([
    [undefined, 401],
    [{ userId: 7, permissions: ['cron:view'], instanceScopes: { 9: 'read-only' } }, 403],
    [{ userId: 7, permissions: ['cron:manage'], instanceScopes: { 10: 'read-write' } }, 403],
  ])('denies missing or revoked authority before execution', async (user, status) => {
    const execute = vi.spyOn(sqlExecutor, 'executeSql');
    // null is intentional so the helper default does not supply an actor.
    const result = await request({ instance_id: 9, content: 'SELECT 1' }, user ?? null);
    expect(result.statusCode).toBe(status); expect(execute).not.toHaveBeenCalled();
  });
  it('returns execution failure without saving a draft or replaying it', async () => {
    const execute = vi.spyOn(sqlExecutor, 'executeSql').mockRejectedValue(new Error('executor unavailable'));
    const create = vi.spyOn(scriptService, 'createScript');
    expect((await request({ instance_id: 9, content: 'SELECT 1' })).statusCode).toBe(500);
    expect(execute).toHaveBeenCalledTimes(1); expect(create).not.toHaveBeenCalled();
  });
});
