import Fastify, { type FastifyInstance, type HTTPMethods } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rbacApiRoutes } from './rbac-api.js';
import { dbConnection } from '../db-connection.js';

vi.mock('../db-connection.js', () => ({
  dbConnection: { getPool: vi.fn(), isConnected: vi.fn(() => true) },
}));

const writes = [
  ['POST', '/roles', { name: 'operator' }],
  ['PUT', '/roles/1', { description: 'updated' }],
  ['POST', '/permissions', { code: 'fixture:read', name: '读取', resource: 'fixture', action: 'read' }],
  ['POST', '/roles/1/permissions', { permissionId: 2 }],
  ['POST', '/users/1/roles', { roleId: 2 }],
  ['POST', '/users/1/instances', { instanceId: 2 }],
] as const;

// Every path parameter position is exercised, including the second ID in deletes.
const idRoutes: Array<[HTTPMethods, string, unknown?]> = [
  ['GET', '/roles/BAD'], ['PUT', '/roles/BAD', { description: 'updated' }],
  ['DELETE', '/roles/BAD'], ['DELETE', '/permissions/BAD'],
  ['POST', '/roles/BAD/permissions', { permissionId: 2 }],
  ['DELETE', '/roles/BAD/permissions/2'], ['DELETE', '/roles/1/permissions/BAD'],
  ['GET', '/roles/BAD/permissions'], ['POST', '/users/BAD/roles', { roleId: 2 }],
  ['DELETE', '/users/BAD/roles/2'], ['DELETE', '/users/1/roles/BAD'],
  ['GET', '/users/BAD/roles'], ['POST', '/users/BAD/instances', { instanceId: 2 }],
  ['DELETE', '/users/BAD/instances/2'], ['DELETE', '/users/1/instances/BAD'],
  ['GET', '/users/BAD/instances'],
];

describe('RBAC route input boundaries (#493 / #494 / #495)', () => {
  let app: FastifyInstance;
  let execute: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    vi.clearAllMocks();
    execute = vi.fn(async (sql: string) => sql.startsWith('SELECT')
      ? [[], []] : [{ insertId: 7, affectedRows: 1 }, []]);
    const connection = { execute, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() };
    vi.mocked(dbConnection.getPool).mockReturnValue({ execute, getConnection: vi.fn(async () => connection) } as any);
    app = Fastify();
    app.decorate('verifyToken', async (request: any) => {
      if (request.headers.authorization) request.user = { username: 'fixture', permissions: request.headers.authorization === 'admin' ? ['admin:*'] : [] };
    });
    await app.register(rbacApiRoutes);
    await app.ready();
  });
  afterEach(async () => { await app.close(); });

  async function send(method: HTTPMethods, path: string, body?: unknown, authorization: string | undefined = 'admin') {
    return app.inject({ method, url: `/api/v1/rbac${path}`,
      headers: { ...(authorization ? { authorization } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
  }

  for (const [method, path] of writes) {
    it(`${method} ${path}: rejects null, absent, array and primitive bodies before DB`, async () => {
      for (const body of [null, undefined, [], ['x'], 'text', 1, true, false]) {
        const response = await send(method, path, body);
        expect(response.statusCode, JSON.stringify(body)).toBe(400);
        expect(response.json().error).toEqual(expect.any(String));
      }
      expect(dbConnection.getPool).not.toHaveBeenCalled();
    });
  }

  for (const [method, path, body] of idRoutes) {
    it(`${method} ${path}: rejects invalid IDs before DB`, async () => {
      for (const id of ['not-a-number', '0', '-1', '1.5', '9007199254740992', 'Infinity', '1e2', '0x10', '%20', '%20%31', '1abc']) {
        expect((await send(method, path.replace('BAD', id), body)).statusCode, id).toBe(400);
      }
      expect(dbConnection.getPool).not.toHaveBeenCalled();
    });
  }

  for (const [path, key] of [['/roles/1/permissions', 'permissionId'], ['/users/1/roles', 'roleId'], ['/users/1/instances', 'instanceId']]) {
    it(`${key}: rejects unsafe and coercible non-ID body values`, async () => {
      for (const value of [null, true, [], [1], {}, 0, -1, 1.5, 9007199254740992, 'NaN', '1e2', '0x10', ' 1 ']) {
        expect((await send('POST', path, { [key]: value })).statusCode, JSON.stringify(value)).toBe(400);
      }
      expect(dbConnection.getPool).not.toHaveBeenCalled();
    });
  }

  it('permission required fields, lengths and code consistency reject before DB', async () => {
    const valid = writes[2][2];
    const invalid: unknown[] = [{ code: valid.code }];
    for (const field of ['code', 'name', 'resource', 'action']) {
      for (const value of [undefined, null, '', '  ', 1, true, [], {}]) invalid.push({ ...valid, [field]: value });
    }
    for (const [field, length] of [['code', 101], ['name', 101], ['resource', 51], ['action', 51], ['description', 256]] as const) {
      invalid.push({ ...valid, [field]: 'a'.repeat(length) });
    }
    invalid.push({ ...valid, resource: 'other' }, { ...valid, action: 'write' }, { ...valid, code: 'Fixture:read' },
      { ...valid, description: {} });
    for (const body of invalid) expect((await send('POST', '/permissions', body)).statusCode, JSON.stringify(body)).toBe(400);
    expect(dbConnection.getPool).not.toHaveBeenCalled();
  });

  it('role create/update reject malformed names and descriptions before DB', async () => {
    for (const method of ['POST', 'PUT'] as const) {
      const path = method === 'POST' ? '/roles' : '/roles/1';
      for (const name of [null, '', '  ', 1, {}, [], 'a'.repeat(51)]) {
        expect((await send(method, path, { name })).statusCode).toBe(400);
      }
      for (const description of [1, {}, [], 'a'.repeat(256)]) {
        expect((await send(method, path, { name: 'valid', description })).statusCode).toBe(400);
      }
    }
    expect(dbConnection.getPool).not.toHaveBeenCalled();
  });

  it('keeps authenticated administrator requests and numeric string IDs working', async () => {
    for (const [method, path, body] of writes) {
      expect((await send(method, path, body)).statusCode).toBe(method === 'PUT' ? 200 : 201);
    }
    for (const [path, key] of [['/roles/1/permissions', 'permissionId'], ['/users/1/roles', 'roleId'], ['/users/1/instances', 'instanceId']]) {
      expect((await send('POST', path, { [key]: '2' })).statusCode).toBe(201);
    }
    expect(execute).toHaveBeenCalled();
  });

  it('accepts schema boundary lengths and preserves optional descriptions', async () => {
    expect((await send('POST', '/roles', { name: '角'.repeat(50), description: '描'.repeat(255) })).statusCode).toBe(201);
    const resource = 'r'.repeat(49), action = 'a'.repeat(50);
    expect((await send('POST', '/permissions', { code: `${resource}:${action}`, name: '权'.repeat(100), resource, action, description: '描'.repeat(255) })).statusCode).toBe(201);
    expect((await send('PUT', '/roles/1', { description: '' })).statusCode).toBe(200);
  });

  it('keeps valid missing role IDs as 404 including maximum safe integer', async () => {
    for (const id of ['2147483647', '9007199254740991']) {
      expect((await send('GET', `/roles/${id}`)).statusCode).toBe(404);
      expect(execute).toHaveBeenLastCalledWith(expect.any(String), [Number(id)]);
    }
  });

  it('keeps authentication and permission guards ahead of validation', async () => {
    for (const [method, path, body] of [...writes, ...idRoutes.map(([method, path, body]) => [method, path.replace('BAD', 'bad'), body] as const)]) {
      expect((await send(method, path, body, '')).statusCode).toBe(401);
      expect((await send(method, path, body, 'viewer')).statusCode).toBe(403);
    }
    expect(dbConnection.getPool).not.toHaveBeenCalled();
  });
});
