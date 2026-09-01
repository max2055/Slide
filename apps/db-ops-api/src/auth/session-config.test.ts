import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from './actor-context.js';
import { registerAuthSessionConfigRoutes } from './session-config-routes.js';
import {
  AuthSessionConfigService,
  DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES,
  MAX_SESSION_IDLE_TIMEOUT_MINUTES,
  MIN_SESSION_IDLE_TIMEOUT_MINUTES,
  SESSION_IDLE_TIMEOUT_CONFIG_KEY,
  authSessionConfigService,
} from './session-config.js';

function actor(permissions: string[]): ActorContext {
  return {
    userId: 7,
    username: 'alice',
    roles: [],
    permissions,
    sessionVersion: 1,
    instanceScopes: {},
    requestId: 'session-config-test',
  };
}

describe('AuthSessionConfigService', () => {
  it('uses the compatible seven-day default when the setting is absent or malformed', async () => {
    const missing = new AuthSessionConfigService(() => ({ execute: vi.fn().mockResolvedValue([[]]) }));
    const malformed = new AuthSessionConfigService(() => ({
      execute: vi.fn().mockResolvedValue([[{ config_value: '4.5' }]]),
    }));

    await expect(missing.get()).resolves.toMatchObject({
      idleTimeoutMinutes: DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES,
    });
    await expect(malformed.get()).resolves.toMatchObject({
      idleTimeoutMinutes: DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES,
    });
  });

  it('reads a valid timeout and calculates its expiry from the supplied clock', async () => {
    const service = new AuthSessionConfigService(() => ({
      execute: vi.fn().mockResolvedValue([[{ config_value: '60' }]]),
    }));
    const config = await service.get();

    expect(config).toEqual({
      idleTimeoutMinutes: 60,
      minIdleTimeoutMinutes: MIN_SESSION_IDLE_TIMEOUT_MINUTES,
      maxIdleTimeoutMinutes: MAX_SESSION_IDLE_TIMEOUT_MINUTES,
    });
    expect(service.expiresAt(config, Date.parse('2030-01-01T00:00:00Z')).toISOString())
      .toBe('2030-01-01T01:00:00.000Z');
  });

  it('persists a validated timeout with actor attribution', async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }]);
    const service = new AuthSessionConfigService(() => ({ execute }));

    await expect(service.set(120, 7)).resolves.toMatchObject({ idleTimeoutMinutes: 120 });
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('ON DUPLICATE KEY UPDATE'), [
      SESSION_IDLE_TIMEOUT_CONFIG_KEY,
      '120',
      'number',
      expect.stringContaining('无操作'),
      7,
    ]);
  });

  it.each([4, 43_201, 5.5, Number.NaN])('rejects an out-of-range timeout %s', async (value) => {
    const service = new AuthSessionConfigService(() => ({ execute: vi.fn() }));
    await expect(service.set(value, 7)).rejects.toThrow('SESSION_CONFIG_UPDATE_INVALID');
  });
});

describe('auth session config routes', () => {
  afterEach(() => vi.restoreAllMocks());

  async function appFor(permissions: string[]) {
    const app = Fastify();
    await registerAuthSessionConfigRoutes(app, async (request) => {
      request.user = actor(permissions);
    });
    return app;
  }

  it('keeps configuration restricted to administrators', async () => {
    const app = await appFor(['config:view']);
    expect((await app.inject({ method: 'GET', url: '/api/auth/session-config' })).statusCode).toBe(403);
    expect((await app.inject({
      method: 'PUT',
      url: '/api/auth/session-config',
      payload: { idleTimeoutMinutes: 60 },
    })).statusCode).toBe(403);
    await app.close();
  });

  it('returns and updates the setting through a strict request body', async () => {
    vi.spyOn(authSessionConfigService, 'get').mockResolvedValue({
      idleTimeoutMinutes: 60,
      minIdleTimeoutMinutes: 5,
      maxIdleTimeoutMinutes: 43_200,
    });
    const set = vi.spyOn(authSessionConfigService, 'set').mockResolvedValue({
      idleTimeoutMinutes: 120,
      minIdleTimeoutMinutes: 5,
      maxIdleTimeoutMinutes: 43_200,
    });
    const app = await appFor(['admin:*']);

    expect((await app.inject({ method: 'GET', url: '/api/auth/session-config' })).json())
      .toMatchObject({ idleTimeoutMinutes: 60 });
    expect((await app.inject({
      method: 'PUT',
      url: '/api/auth/session-config',
      payload: { idleTimeoutMinutes: 120 },
    })).json()).toMatchObject({ idleTimeoutMinutes: 120 });
    expect(set).toHaveBeenCalledWith(120, 7);

    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/auth/session-config',
      payload: { idleTimeoutMinutes: 120, unexpected: true },
    });
    expect(invalid.statusCode).toBe(400);
    expect(set).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
