import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../auth/actor-context.js';
import { instanceDatabaseService } from '../instance-database-service.js';
import { listDatabaseInstancesTool } from './generated/slide-self-mgmt/list_database_instances.js';

function actor(
  scopes: Record<number, 'read-only' | 'read-write' | 'admin'>,
  permissions: string[] = ['instance:view'],
): ActorContext {
  return Object.freeze({
    userId: 1,
    username: 'scope-test',
    roles: Object.freeze(['viewer']),
    permissions: Object.freeze(permissions),
    sessionVersion: 1,
    instanceScopes: Object.freeze(scopes),
    requestId: 'scope-test',
  });
}

afterEach(() => vi.restoreAllMocks());

describe('Agent collection resource filtering', () => {
  it('returns only database instances present in the immutable actor scope', async () => {
    vi.spyOn(instanceDatabaseService, 'getAllInstances').mockResolvedValue([
      { id: 1, name: 'visible', db_type: 'mysql', host: 'db-1', port: 3306, health_status: 'healthy', environment: 'production', status: 'active' },
      { id: 2, name: 'hidden', db_type: 'mysql', host: 'db-2', port: 3306, health_status: 'healthy', environment: 'production', status: 'active' },
    ] as any);

    const result = await listDatabaseInstancesTool.handler({}, { actor: actor({ 1: 'read-only' }) });

    expect(result.success).toBe(true);
    expect(result.data).toEqual([expect.objectContaining({ id: 1, name: 'visible' })]);
  });

  it('fails closed when an actor-facing collection handler has no actor context', async () => {
    vi.spyOn(instanceDatabaseService, 'getAllInstances').mockResolvedValue([
      { id: 1, name: 'hidden', db_type: 'mysql', host: 'db-1', port: 3306, health_status: 'healthy', environment: 'production', status: 'active' },
    ] as any);

    const result = await listDatabaseInstancesTool.handler({});

    expect(result.data).toEqual([]);
  });
});
