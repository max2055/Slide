import { describe, expect, it, vi } from 'vitest';
import { resolveToolResource, resolveToolResourceFromArgs } from './resource-resolver.js';

describe('Agent tool resource resolver', () => {
  it('normalizes instance and server argument aliases into canonical resources', () => {
    expect(resolveToolResourceFromArgs('get_instance_summary', { instance_id: 12 }))
      .toMatchObject({ type: 'instance', instanceId: 12 });
    expect(resolveToolResourceFromArgs('get_server_metrics', { serverId: 8 }))
      .toMatchObject({ type: 'server', serverId: 8 });
    expect(resolveToolResourceFromArgs('get_server_alerts', { server_id: 9 }))
      .toMatchObject({ type: 'server', serverId: 9 });
  });

  it('resolves an instance name before authorization', async () => {
    const findInstanceIdByName = vi.fn().mockResolvedValue(21);
    await expect(resolveToolResource(
      'slide_update_db_config',
      { instance_name: 'orders-prod' },
      { findInstanceIdByName },
    )).resolves.toMatchObject({ type: 'instance', instanceId: 21 });
    expect(findInstanceIdByName).toHaveBeenCalledWith('orders-prod');
  });

  it('marks invalid and unknown resource references as resolution failures', async () => {
    expect(resolveToolResourceFromArgs('query_metrics', { instance_id: -1 }))
      .toMatchObject({ error: 'RESOURCE_INVALID' });
    await expect(resolveToolResource(
      'slide_test_connection',
      { instance_name: 'missing' },
      { findInstanceIdByName: async () => null },
    )).resolves.toMatchObject({ error: 'RESOURCE_NOT_FOUND' });
  });

  it('captures direct database targets without treating model input as an instance id', () => {
    expect(resolveToolResourceFromArgs('slide_add_database', { host: 'db.internal', port: 5432 }))
      .toMatchObject({
        type: 'database-target',
        databaseTarget: { host: 'db.internal', port: 5432 },
      });
  });
});
