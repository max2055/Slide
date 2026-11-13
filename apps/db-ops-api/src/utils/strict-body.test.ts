import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rejectUnknown, strictBody, warnUnknown } from './strict-body.js';

const invalid = [null, undefined, [], ['username'], '', 'text', 0, 42, true, false];
afterEach(() => vi.restoreAllMocks());

describe('MAX-647 / #395 request body boundary', () => {
  it.each(invalid)('rejects non-object input %j in both strict helpers', body => {
    expect(strictBody(body as any, ['username'], 'test')).toEqual({
      body: null, error: { error: expect.stringContaining('JSON 对象') },
    });
    expect(rejectUnknown(body as any, ['username'], 'test')).toContain('JSON 对象');
  });

  it.each([new Date(), new Map(), new (class Body {})()])('rejects non-plain runtime objects', body => {
    expect(strictBody(body as any, [], 'test').error).not.toBeNull();
  });

  it.each([{}, { username: 'operator' }, Object.create(null)])('preserves valid plain objects', body => {
    expect(strictBody(body, ['username'], 'test')).toEqual({ body, error: null });
    expect(strictBody(body, ['username'], 'test').body).toBe(body);
  });

  it('preserves unknown-field rejection and role guidance together', () => {
    const result = strictBody({ username: 'operator', role: 'admin', extra: 1 }, ['username'], 'POST /api/users', { role: '请使用 RBAC API' });
    expect(result).toEqual({ body: null, error: { error: '未知字段: extra；字段 "role" 不被 POST /api/users 接受。请使用 RBAC API；允许的字段: username' } });
  });

  it.each(['Username', 'user_name', 'user-name', '__proto__', 'constructor', 'toString'])('rejects undeclared own key %s', key => {
    expect(strictBody(JSON.parse(`{"${key}":"value"}`), ['username'], 'test').error).not.toBeNull();
  });

  it.each(invalid)('warnUnknown returns a readable error for %j without throwing or logging values', body => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(warnUnknown(body as any, ['username'], 'test')).toEqual({ error: expect.stringContaining('JSON 对象') });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warnUnknown still allows objects, warns once per field set and never logs values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(warnUnknown({ username: 'ok' }, ['username'], 'warn-test')).toBeNull();
    expect(warnUnknown({ extra: 'private-value', other: 1 }, ['username'], 'warn-test')).toBeNull();
    expect(warnUnknown({ other: 2, extra: 'changed' }, ['username'], 'warn-test')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('extra, other');
    expect(warn.mock.calls[0][0]).not.toContain('private-value');
  });
});

// Execute the production registrations unchanged in real Fastify. Only auth/service
// dependencies are stubs here; full-server MySQL/JWT acceptance is a separate script.
const source = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);
const endpoints = [
  ['post', '/api/auth/login'], ['post', '/api/users'], ['put', '/api/users/:id'],
  ['post', '/api/llm/configs'], ['post', '/api/database/instances'], ['put', '/api/database/instances/:id'],
  ['post', '/api/servers'], ['put', '/api/servers/:id'], ['post', '/api/servers/:id/rotate-key'],
] as const;

async function fixture(method: string, path: string) {
  let registration = '';
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(parsed) === 'fastify' && node.expression.name.text === method
      && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === path) registration = node.getText(parsed);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  expect(registration).not.toBe('');
  const app = Fastify();
  const service = {
    getUserByUsername: vi.fn(async () => null),
    createUser: vi.fn(async () => ({ success: true })),
    updateUserById: vi.fn(async () => ({ success: true })),
    configureProvider: vi.fn(async () => ({ success: false })),
    createInstance: vi.fn(async () => ({ success: true, instanceId: 1 })),
    updateInstance: vi.fn(async () => ({ success: true })),
    createServer: vi.fn(async () => ({ success: true, serverId: 1 })),
    updateServer: vi.fn(async () => ({ success: true })),
    rotateKey: vi.fn(async () => ({ success: true })),
  };
  const dependencies = {
    fastify: app, strictBody, warnUnknown,
    verifyToken: async () => {}, requirePermission: () => async () => {}, requireInstanceAccess: () => async () => {},
    createLoginIpRateLimit: () => async () => {}, loginRateLimitConfig: {},
    authDatabaseService: service, instanceDatabaseService: service, serverDatabaseService: service, llmDatabaseService: service,
    auditLogManager: { logLogin: async () => {} }, PlatformUnavailableError: class extends Error {},
  };
  new Function(...Object.keys(dependencies), ts.transpileModule(registration, {}).outputText)(...Object.values(dependencies));
  return { app, service };
}

describe.each(endpoints)('production %s %s body validation', (method, path) => {
  it.each(invalid)('returns 400 for %j before any service side effect', async body => {
    const { app, service } = await fixture(method, path);
    try {
      const response = await app.inject({ method: method.toUpperCase() as 'POST' | 'PUT', url: path.replace(':id', '1'),
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) }) });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain('JSON 对象');
      for (const call of Object.values(service)) expect(call).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});

it('production login keeps required-field, unknown-field and credential-failure semantics', async () => {
  const { app } = await fixture('post', '/api/auth/login');
  try {
    for (const [payload, status, message] of [
      [{}, 400, '用户名和密码不能为空'],
      [{ username: 'u', password: 'p', extra: 1 }, 400, '未知字段: extra'],
      [{ username: 'u', password: 'p' }, 401, '用户名或密码错误'],
    ] as const) {
      const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload });
      expect(response.statusCode).toBe(status);
      expect(response.json().error).toContain(message);
    }
  } finally { await app.close(); }
});

it('production user creation retains role guidance and accepts a normal object', async () => {
  const { app, service } = await fixture('post', '/api/users');
  try {
    const payload = { username: 'u', password: 'synthetic-password' };
    const rejected = await app.inject({ method: 'POST', url: '/api/users', payload: { ...payload, role: 'admin' } });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toMatch(/POST \/api\/v1\/rbac\/users\/\{userId\}\/roles/);
    expect(service.createUser).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'POST', url: '/api/users', payload })).statusCode).toBe(201);
    expect(service.createUser).toHaveBeenCalledWith('u', 'synthetic-password', undefined);
  } finally { await app.close(); }
});

it('production warning-only server update still forwards unknown object fields', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { app, service } = await fixture('put', '/api/servers/:id');
  try {
    const payload = { label: 'new', extra: true };
    expect((await app.inject({ method: 'PUT', url: '/api/servers/1', payload })).statusCode).toBe(200);
    expect(service.updateServer).toHaveBeenCalledWith(1, payload);
  } finally { await app.close(); }
});
