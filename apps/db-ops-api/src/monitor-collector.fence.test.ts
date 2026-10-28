/**
 * MAX-238 / B2F — the compatibility monitor's `enabled` reader. A template row is
 * never dereferenced as `Published` and never becomes enabled by a null/exception
 * fallback; only a validated legacy row can report its own enabled setting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { monitorCollector } from './monitor-collector.js';
import { dbConnection } from './db-connection.js';
import { instanceDatabaseService } from './instance-database-service.js';
import { databaseService } from './database-service.js';
import { createBuiltinRegistry } from './metrics/packages/builtins.js';
import { resolvePolicy } from './metrics/policy/resolver.js';
import { at, binding, capabilities, resource } from './metrics/policy/test-support.js';

vi.mock('./metrics/config/effective-state.js', () => ({ assetCollectionEnabled: async () => true }));

const registry = createBuiltinRegistry();
const legacyRow = (enabled: boolean) => {
  const value = { ...binding(7), overrides: { enabled: enabled ? 'enable' as const : 'disable' as const } };
  const resolved = resolvePolicy(registry, value, null, resource(7), capabilities(7), at);
  return JSON.stringify({
    binding: value, resolved, published_at: at,
    application: { applied_revision: 1, reported_at: at, status: 'applied', error_code: null },
  });
};
const poolWith = (payload: string | null): Pool => ({
  execute: async () => [payload === null ? [] : [{ payload }], []],
} as unknown as Pool);

describe('compatibility monitor fence', () => {
  const getPool = vi.spyOn(dbConnection, 'getPool');
  const instances = vi.spyOn(instanceDatabaseService, 'getAllInstances');
  const slowQueries = vi.spyOn(databaseService, 'getSlowQueries');
  beforeEach(() => {
    process.env.METRICS_COLLECTION_ENABLED = 'true';
    instances.mockResolvedValue([{ id: 7, name: 'fixture', status: 'active' }] as never);
    slowQueries.mockResolvedValue([]);
  });
  afterEach(() => {
    getPool.mockReset();
    instances.mockReset();
    slowQueries.mockReset();
    delete process.env.METRICS_COLLECTION_ENABLED;
  });

  it('does not execute the diagnostic source for a template row', async () => {
    getPool.mockReturnValue(poolWith(JSON.stringify({ envelope: 'templates-v1', binding: {} })));
    await monitorCollector.collectSlowQueriesNow();
    expect(slowQueries).not.toHaveBeenCalled();
  });

  it('fails closed for a corrupt row instead of defaulting to enabled', async () => {
    getPool.mockReturnValue(poolWith('{"not":"a binding"}'));
    await monitorCollector.collectSlowQueriesNow();
    expect(slowQueries).not.toHaveBeenCalled();
  });

  it('keeps the legacy reader working for a validated package row', async () => {
    getPool.mockReturnValue(poolWith(legacyRow(true)));
    await monitorCollector.collectSlowQueriesNow();
    expect(slowQueries).toHaveBeenCalledTimes(1);

    slowQueries.mockClear();
    getPool.mockReturnValue(poolWith(legacyRow(false)));
    await monitorCollector.collectSlowQueriesNow();
    expect(slowQueries).not.toHaveBeenCalled();
  });
});
