import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from '../db-connection.js';
import { RbacService } from './rbac-service.js';
import { rbacApiRoutes } from './rbac-api.js';

vi.mock('../db-connection.js', () => ({ dbConnection: { getPool: vi.fn(), isConnected: vi.fn(() => true) } }));
const paths = [
  ['getRolePermissions', '/roles/1/permissions', [{ id: 3, code: 'db:read', name: '读取', resource: 'db', action: 'read' }]],
  ['getUserInstanceAccess', '/users/1/instances', [{ instance_id: 3, access_level: 'read-only' }]],
] as const;
afterEach(() => vi.restoreAllMocks());

async function managementApp() {
  const app = Fastify();
  // Keep the JSON response in flight until after the async handler finishes.
  app.addHook('onSend', async (_request, _reply, payload) => {
    if (payload !== undefined) await new Promise<void>(resolve => setImmediate(resolve));
    return payload;
  });
  app.decorate('verifyToken', async (request: any) => {
    if (request.headers.authorization) request.user = { permissions: request.headers.authorization === 'admin' ? ['admin:*'] : [] };
  });
  await app.register(rbacApiRoutes);
  return app;
}

for (const [method, path, rows] of paths) describe(`MAX-354/356 management read ${method}`, () => {
  it('keeps the default authorization fallback deny-by-default', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(dbConnection.getPool).mockReturnValue({ execute: vi.fn().mockRejectedValue(new Error('storage failure')) } as any);
    expect(await new RbacService()[method](1)).toEqual([]);
    vi.mocked(dbConnection.getPool).mockReturnValue(null);
    expect(await new RbacService()[method](1)).toEqual([]);
  });
  for (const state of ['error', 'no-pool', 'empty', 'rows'] as const) {
    it(`${state}: management HTTP distinguishes unavailability from real results without leaking storage detail`, async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const secret = 'SELECT credential FROM private_table: sensitive-storage-detail';
      const execute = vi.fn().mockImplementation(async () => {
        if (state === 'error') throw new Error(secret);
        return [state === 'empty' ? [] : rows];
      });
      vi.mocked(dbConnection.getPool).mockReturnValue(state === 'no-pool' ? null : { execute } as any);
      const app = await managementApp();
      try {
        // Authentication and permission checks still precede storage access.
        expect((await app.inject({ url: `/api/v1/rbac${path}` })).statusCode).toBe(401);
        expect((await app.inject({ url: `/api/v1/rbac${path}`, headers: { authorization: 'viewer' } })).statusCode).toBe(403);
        expect(execute).not.toHaveBeenCalled();
        const response = await app.inject({ url: `/api/v1/rbac${path}`, headers: { authorization: 'admin' } });
        expect(response.statusCode).toBe(state === 'error' || state === 'no-pool' ? 503 : 200);
        if (response.statusCode === 200) expect(response.json()).toEqual(state === 'empty' ? [] : rows);
        else {
          expect(response.json().error).toEqual(expect.any(String));
          expect(response.body).not.toMatch(/SELECT|credential|private_table|sensitive-storage-detail/);
        }
      } finally { await app.close(); }
    });
  }
});

const rolePermissionsPath = paths[0][1];
const instancePermissionsPath = paths[1][1];
const saveRequests = [
  { action: 'assignPermissionToRole', method: 'POST', path: rolePermissionsPath, body: { permissionId: 2 }, status: 201 },
  { action: 'revokePermissionFromRole', method: 'DELETE', path: `${rolePermissionsPath}/2`, body: undefined, status: 200 },
  { action: 'grantInstanceAccess', method: 'POST', path: instancePermissionsPath, body: { instanceId: 2 }, status: 201 },
  { action: 'revokeInstanceAccess', method: 'DELETE', path: `${instancePermissionsPath}/2`, body: undefined, status: 200 },
] as const;

it.each(saveRequests)('MAX-730 $action returns a JSON write receipt', async ({ action, method, path, body, status }) => {
  vi.spyOn(RbacService.prototype, action).mockResolvedValue({ success: true });
  const app = await managementApp();
  try {
    const reply = await app.inject({
      method, url: `/api/v1/rbac${path}`, headers: { authorization: 'admin' }, payload: body,
    });
    expect(reply.statusCode).toBe(status);
    expect(reply.json()).toEqual({ success: true });
  } finally { await app.close(); }
});
