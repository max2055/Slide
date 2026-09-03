import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from './auth/actor-context.js';
import { registerCollectionConfigRoutes } from './collection-config-routes.js';
import {
  CollectionConfigService,
  DEFAULT_COLLECTION_INTERVAL_SECONDS,
  MAX_COLLECTION_INTERVAL_SECONDS,
  MIN_COLLECTION_INTERVAL_SECONDS,
  NETWORK_DEVICE_COLLECTION_INTERVAL_CONFIG_KEY,
  SERVER_COLLECTION_INTERVAL_CONFIG_KEY,
  collectionConfigService,
} from './collection-config.js';

function actor(permissions: string[]): ActorContext {
  return {
    userId: 7,
    username: 'alice',
    roles: [],
    permissions,
    sessionVersion: 1,
    instanceScopes: {},
    requestId: 'collection-config-test',
  };
}

describe('CollectionConfigService', () => {
  it('uses compatible defaults when settings are absent or malformed', async () => {
    const missing = new CollectionConfigService(() => ({ execute: vi.fn().mockResolvedValue([[]]) }));
    const malformed = new CollectionConfigService(() => ({ execute: vi.fn().mockResolvedValue([[
      { config_key: SERVER_COLLECTION_INTERVAL_CONFIG_KEY, config_value: '9' },
      { config_key: NETWORK_DEVICE_COLLECTION_INTERVAL_CONFIG_KEY, config_value: '1.5' },
    ]]) }));

    await expect(missing.get()).resolves.toMatchObject({
      serverIntervalSeconds: DEFAULT_COLLECTION_INTERVAL_SECONDS,
      networkDeviceIntervalSeconds: DEFAULT_COLLECTION_INTERVAL_SECONDS,
    });
    await expect(malformed.get()).resolves.toMatchObject({
      serverIntervalSeconds: DEFAULT_COLLECTION_INTERVAL_SECONDS,
      networkDeviceIntervalSeconds: DEFAULT_COLLECTION_INTERVAL_SECONDS,
    });
  });

  it('reads both stored intervals', async () => {
    const service = new CollectionConfigService(() => ({ execute: vi.fn().mockResolvedValue([[
      { config_key: SERVER_COLLECTION_INTERVAL_CONFIG_KEY, config_value: '120' },
      { config_key: NETWORK_DEVICE_COLLECTION_INTERVAL_CONFIG_KEY, config_value: '600' },
    ]]) }));

    await expect(service.get()).resolves.toEqual({
      serverIntervalSeconds: 120,
      networkDeviceIntervalSeconds: 600,
      minIntervalSeconds: MIN_COLLECTION_INTERVAL_SECONDS,
      maxIntervalSeconds: MAX_COLLECTION_INTERVAL_SECONDS,
    });
  });

  it('persists both intervals with actor attribution', async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 2 }]);
    const service = new CollectionConfigService(() => ({ execute }));

    await expect(service.set({ serverIntervalSeconds: 120, networkDeviceIntervalSeconds: 600 }, 7))
      .resolves.toMatchObject({ serverIntervalSeconds: 120, networkDeviceIntervalSeconds: 600 });
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('ON DUPLICATE KEY UPDATE'), [
      SERVER_COLLECTION_INTERVAL_CONFIG_KEY,
      '120',
      expect.stringContaining('SSH'),
      7,
      NETWORK_DEVICE_COLLECTION_INTERVAL_CONFIG_KEY,
      '600',
      expect.stringContaining('SNMP'),
      7,
    ]);
  });

  it.each([9, 86_401, 5.5, Number.NaN])('rejects an out-of-range interval %s', async (value) => {
    const service = new CollectionConfigService(() => ({ execute: vi.fn() }));
    await expect(service.set({ serverIntervalSeconds: value, networkDeviceIntervalSeconds: 300 }, 7))
      .rejects.toThrow('COLLECTION_CONFIG_UPDATE_INVALID');
  });
});

describe('collection config routes', () => {
  afterEach(() => vi.restoreAllMocks());

  async function appFor(permissions: string[], applyConfig = vi.fn()) {
    const app = Fastify();
    await registerCollectionConfigRoutes(app, async (request) => {
      request.user = actor(permissions);
    }, applyConfig);
    return { app, applyConfig };
  }

  it('keeps collection configuration restricted to administrators', async () => {
    const { app } = await appFor(['collector:manage']);
    expect((await app.inject({ method: 'GET', url: '/api/system/collection-config' })).statusCode).toBe(403);
    expect((await app.inject({
      method: 'PUT',
      url: '/api/system/collection-config',
      payload: { serverIntervalSeconds: 120, networkDeviceIntervalSeconds: 600 },
    })).statusCode).toBe(403);
    await app.close();
  });

  it('updates strict configuration and applies it to running collectors', async () => {
    const next = {
      serverIntervalSeconds: 120,
      networkDeviceIntervalSeconds: 600,
      minIntervalSeconds: 10,
      maxIntervalSeconds: 86_400,
    };
    vi.spyOn(collectionConfigService, 'get').mockResolvedValue(next);
    const set = vi.spyOn(collectionConfigService, 'set').mockResolvedValue(next);
    const { app, applyConfig } = await appFor(['admin:*']);

    expect((await app.inject({ method: 'GET', url: '/api/system/collection-config' })).json()).toEqual(next);
    expect((await app.inject({
      method: 'PUT',
      url: '/api/system/collection-config',
      payload: { serverIntervalSeconds: 120, networkDeviceIntervalSeconds: 600 },
    })).json()).toEqual(next);
    expect(set).toHaveBeenCalledWith({ serverIntervalSeconds: 120, networkDeviceIntervalSeconds: 600 }, 7);
    expect(applyConfig).toHaveBeenCalledWith(next);

    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/system/collection-config',
      payload: { serverIntervalSeconds: 120, networkDeviceIntervalSeconds: 600, unexpected: true },
    });
    expect(invalid.statusCode).toBe(400);
    expect(set).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
