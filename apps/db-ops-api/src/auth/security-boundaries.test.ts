import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@slide/agent-core';
import { WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import {
  ActorAuthenticationError,
  ActorContextService,
  signAccessToken,
  type ActorContext,
} from './actor-context.js';
import { createVerifyToken } from '../auth-middleware.js';
import { DirectAdapter } from '../adapter/direct-adapter.js';
import { authDatabaseService } from '../auth-database-service.js';
import { RbacService } from './rbac-service.js';
import { dbConnection } from '../db-connection.js';

vi.mock('../chat-database-service.js', () => ({
  chatDatabaseService: {
    addMessage: vi.fn().mockResolvedValue(undefined),
    getMessages: vi.fn().mockResolvedValue([]),
    getSessionMetadata: vi.fn().mockResolvedValue(null),
  },
}));

const ACTIVE_ROWS = [
  {
    id: 7,
    username: 'alice',
    status: 'active',
    session_version: 4,
    role_name: 'dba',
    permission_code: 'instance:view',
    instance_id: 12,
    access_level: 'read-write',
  },
  {
    id: 7,
    username: 'alice',
    status: 'active',
    session_version: 4,
    role_name: 'dba',
    permission_code: 'sql:execute',
    instance_id: 12,
    access_level: 'read-write',
  },
];

function actor(requestId = 'request-1'): ActorContext {
  return Object.freeze({
    userId: 7,
    username: 'alice',
    roles: Object.freeze(['dba']),
    permissions: Object.freeze(['instance:view']),
    sessionVersion: 4,
    instanceScopes: Object.freeze({ 12: 'read-write' as const }),
    requestId,
  });
}

function waitForMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('websocket message timeout')), 2_000);
    ws.once('message', (raw) => {
      clearTimeout(timeout);
      resolve(JSON.parse(raw.toString()));
    });
  });
}

function waitForClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('websocket close timeout')), 2_000);
    ws.once('close', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

describe('actor context security boundary', () => {
  it('actor builds an immutable authorization snapshot for an active user', async () => {
    const execute = vi.fn().mockResolvedValue([ACTIVE_ROWS]);
    const service = new ActorContextService(() => ({ execute } as any));

    const result = await service.loadActiveActor(7, 4, 'request-1');

    expect(result).toEqual({
      userId: 7,
      username: 'alice',
      roles: ['dba'],
      permissions: ['instance:view', 'sql:execute'],
      sessionVersion: 4,
      instanceScopes: { 12: 'read-write' },
      requestId: 'request-1',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.roles)).toBe(true);
    expect(Object.isFrozen(result.permissions)).toBe(true);
    expect(Object.isFrozen(result.instanceScopes)).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing', []],
    ['inactive', [{ ...ACTIVE_ROWS[0], status: 'inactive' }]],
    ['stale version', ACTIVE_ROWS],
  ])('actor rejects a %s user/session', async (kind, rows) => {
    const service = new ActorContextService(() => ({
      execute: vi.fn().mockResolvedValue([rows]),
    } as any));

    const expectedVersion = kind === 'stale version' ? 3 : 4;
    await expect(service.loadActiveActor(7, expectedVersion, 'request-2'))
      .rejects.toBeInstanceOf(ActorAuthenticationError);
  });

  it('actor fails closed when the authorization snapshot query fails', async () => {
    const service = new ActorContextService(() => ({
      execute: vi.fn().mockRejectedValue(new Error('database unavailable')),
    } as any));

    await expect(service.loadActiveActor(7, 4, 'request-3'))
      .rejects.toBeInstanceOf(ActorAuthenticationError);
  });

  it('actor access tokens contain only the server session index claims', async () => {
    const execute = vi.fn().mockResolvedValue([ACTIVE_ROWS]);
    const service = new ActorContextService(() => ({ execute } as any));
    const token = signAccessToken(actor(), 'access-secret');

    const result = await service.authenticateAccessToken(token, 'access-secret', 'access-request');
    const decoded = jwt.verify(token, 'access-secret') as Record<string, unknown>;

    expect(result.userId).toBe(7);
    expect(result.requestId).toBe('access-request');
    expect(decoded.userId).toBe(7);
    expect(decoded.sessionVersion).toBe(4);
    expect(decoded.roles).toBeUndefined();
    expect(decoded.permissions).toBeUndefined();
  });

  it('actor login refresh issuance fails if persistence fails', async () => {
    const service = new ActorContextService(() => ({
      execute: vi.fn().mockRejectedValue(new Error('insert failed')),
    } as any));

    await expect(service.issueRefreshToken(actor()))
      .rejects.toBeInstanceOf(ActorAuthenticationError);
  });

  it('actor login refresh issuance stores the current session version', async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }]);
    const service = new ActorContextService(() => ({ execute } as any));

    const token = await service.issueRefreshToken(actor(), new Date('2030-01-01T00:00:00Z'));

    expect(token).toMatch(/^[a-f0-9]{96}$/);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO refresh_tokens'),
      [expect.any(String), 7, 4, new Date('2030-01-01T00:00:00Z')],
    );
  });

  it('refresh consumes and rotates the token before returning a current actor', async () => {
    const operations: string[] = [];
    const connection = {
      beginTransaction: vi.fn(async () => { operations.push('begin'); }),
      execute: vi.fn(async (sql: string) => {
        if (sql.includes('FROM refresh_tokens')) {
          operations.push('select-refresh');
          return [[{
            id: 31,
            user_id: 7,
            revoked: false,
            expires_at: new Date(Date.now() + 60_000),
            session_version: 4,
          }]];
        }
        if (sql.includes('FROM users')) {
          operations.push('select-actor');
          return [ACTIVE_ROWS];
        }
        if (sql.startsWith('UPDATE refresh_tokens')) {
          operations.push('consume');
          return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('INSERT INTO refresh_tokens')) {
          operations.push('insert');
          return [{ affectedRows: 1 }];
        }
        throw new Error(`unexpected SQL: ${sql}`);
      }),
      commit: vi.fn(async () => { operations.push('commit'); }),
      rollback: vi.fn(),
      release: vi.fn(),
    };
    const service = new ActorContextService(() => ({
      getConnection: vi.fn().mockResolvedValue(connection),
    } as any));

    const result = await service.rotateRefreshToken('raw-refresh-token', 'refresh-request');

    expect(result.actor.userId).toBe(7);
    expect(result.actor.sessionVersion).toBe(4);
    expect(result.refreshToken).toMatch(/^[a-f0-9]{96}$/);
    expect(operations).toEqual([
      'begin', 'select-refresh', 'select-actor', 'consume', 'insert', 'commit',
    ]);
  });

  it('refresh never rotates a token for an inactive user', async () => {
    const insert = vi.fn();
    const connection = {
      beginTransaction: vi.fn(),
      execute: vi.fn(async (sql: string) => {
        if (sql.includes('FROM refresh_tokens')) {
          return [[{
            id: 31,
            user_id: 7,
            revoked: false,
            expires_at: new Date(Date.now() + 60_000),
            session_version: 4,
          }]];
        }
        if (sql.includes('FROM users')) return [[{ ...ACTIVE_ROWS[0], status: 'inactive' }]];
        if (sql.startsWith('INSERT INTO refresh_tokens')) return insert();
        throw new Error(`unexpected SQL: ${sql}`);
      }),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn(),
    };
    const service = new ActorContextService(() => ({
      getConnection: vi.fn().mockResolvedValue(connection),
    } as any));

    await expect(service.rotateRefreshToken('raw-refresh-token', 'refresh-request'))
      .rejects.toBeInstanceOf(ActorAuthenticationError);
    expect(insert).not.toHaveBeenCalled();
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledOnce();
  });

  it('actor REST middleware replaces JWT claims with the server snapshot', async () => {
    const currentActor = actor('rest-request');
    const contexts = {
      authenticateAccessToken: vi.fn().mockResolvedValue(currentActor),
    };
    const middleware = createVerifyToken('test-secret', contexts as any);
    const request = {
      id: 'rest-request',
      headers: { authorization: 'Bearer opaque-access-token' },
      user: undefined as ActorContext | undefined,
    };
    const reply = { code: vi.fn().mockReturnThis(), send: vi.fn() };

    await middleware(request, reply);

    expect(contexts.authenticateAccessToken)
      .toHaveBeenCalledWith('opaque-access-token', 'test-secret', 'rest-request');
    expect(request.user).toBe(currentActor);
    expect(reply.send).not.toHaveBeenCalled();
  });
});

describe('actor session revocation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('actor status changes bump the session and revoke refresh tokens atomically', async () => {
    const state = { status: 'active', sessionVersion: 4, refreshRevoked: false };
    const connection = {
      beginTransaction: vi.fn(),
      execute: vi.fn(async (sql: string, values: unknown[]) => {
        if (sql.startsWith('UPDATE users')) {
          state.status = String(values[0]);
          state.sessionVersion += 1;
          return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('UPDATE refresh_tokens')) {
          state.refreshRevoked = true;
          return [{ affectedRows: 1 }];
        }
        throw new Error(`unexpected SQL: ${sql}`);
      }),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn(),
    };
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({
      getConnection: vi.fn().mockResolvedValue(connection),
    } as any);

    const result = await authDatabaseService.updateUserById(7, { status: 'inactive' });

    expect(result.success).toBe(true);
    expect(state).toEqual({ status: 'inactive', sessionVersion: 5, refreshRevoked: true });
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it('actor role assignment bumps the session and revokes refresh tokens atomically', async () => {
    const state = { roleAssigned: false, sessionVersion: 4, refreshRevoked: false };
    const connection = {
      beginTransaction: vi.fn(),
      execute: vi.fn(async (sql: string) => {
        if (sql.startsWith('INSERT IGNORE INTO user_roles')) {
          state.roleAssigned = true;
          return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('UPDATE users')) {
          state.sessionVersion += 1;
          return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('UPDATE refresh_tokens')) {
          state.refreshRevoked = true;
          return [{ affectedRows: 1 }];
        }
        throw new Error(`unexpected SQL: ${sql}`);
      }),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn(),
    };
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({
      getConnection: vi.fn().mockResolvedValue(connection),
    } as any);

    const result = await new RbacService().assignRoleToUser(7, 2);

    expect(result.success).toBe(true);
    expect(state).toEqual({ roleAssigned: true, sessionVersion: 5, refreshRevoked: true });
    expect(connection.commit).toHaveBeenCalledOnce();
  });
});

describe('websocket actor boundary', () => {
  const adapters: DirectAdapter[] = [];
  const sockets: WebSocket[] = [];
  let nextPort = 29120;

  beforeEach(() => {
    process.env.JWT_SECRET_KEY = 'test-ws-secret';
  });

  afterEach(async () => {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.close();
    }
    sockets.length = 0;
    for (const adapter of adapters) await adapter.dispose();
    adapters.length = 0;
  });

  it('websocket authenticates through ActorContextService and ignores client userId', async () => {
    const currentActor = actor('ws-auth');
    const contexts = {
      authenticateAccessToken: vi.fn().mockResolvedValue(currentActor),
      revalidateActor: vi.fn().mockResolvedValue(currentActor),
    };
    const adapter = new DirectAdapter({
      tools: new ToolRegistry(),
      llmProvider: {} as any,
      actorContextService: contexts as any,
      heartbeatIntervalMs: 30_000,
    });
    adapters.push(adapter);
    const chat = vi.spyOn(adapter, 'chat').mockImplementation(async (_key, _message, onEvent) => {
      onEvent({ type: 'complete', finalContent: 'ok' });
      return { finalContent: 'ok' } as any;
    });
    process.env.AGENT_WS_PORT = String(nextPort++);
    await adapter.start();

    const ws = new WebSocket(`ws://127.0.0.1:${process.env.AGENT_WS_PORT}`);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ type: 'auth', token: 'ws-access-token' }));
    expect(await waitForMessage(ws)).toEqual({ type: 'auth_ok' });

    ws.send(JSON.stringify({
      type: 'chat.send',
      sessionKey: 'actor-session',
      message: 'hello',
      userId: 999,
    }));
    await vi.waitFor(() => expect(chat).toHaveBeenCalled());

    expect(contexts.authenticateAccessToken)
      .toHaveBeenCalledWith('ws-access-token', 'test-ws-secret', expect.any(String));
    expect(chat.mock.calls[0][3]).toBe(currentActor);
  });

  it('websocket periodically revalidates its actor and closes on revocation', async () => {
    const currentActor = actor('ws-auth');
    const contexts = {
      authenticateAccessToken: vi.fn().mockResolvedValue(currentActor),
      revalidateActor: vi.fn().mockRejectedValue(new ActorAuthenticationError()),
    };
    const adapter = new DirectAdapter({
      tools: new ToolRegistry(),
      llmProvider: {} as any,
      actorContextService: contexts as any,
      heartbeatIntervalMs: 20,
    });
    adapters.push(adapter);
    process.env.AGENT_WS_PORT = String(nextPort++);
    await adapter.start();

    const ws = new WebSocket(`ws://127.0.0.1:${process.env.AGENT_WS_PORT}`);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ type: 'auth', token: 'ws-access-token' }));
    expect(await waitForMessage(ws)).toEqual({ type: 'auth_ok' });

    const closeCode = await waitForClose(ws);

    expect(contexts.revalidateActor).toHaveBeenCalledWith(currentActor, expect.any(String));
    expect(closeCode).toBe(4001);
  });
});
