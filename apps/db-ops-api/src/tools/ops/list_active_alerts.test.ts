import { beforeEach, describe, expect, it, vi } from 'vitest';

const alertService = vi.hoisted(() => ({ getAlerts: vi.fn() }));
const rbacService = vi.hoisted(() => ({ getUserInstanceAccess: vi.fn() }));

vi.mock('../../alert-database-service.js', () => ({ alertDatabaseService: alertService }));
vi.mock('../../auth/rbac-service.js', () => ({ RbacService: class { getUserInstanceAccess = rbacService.getUserInstanceAccess; } }));

import { listActiveAlertsTool } from './list_active_alerts.js';

const actor = { userId: 7, username: 'operator', roles: ['admin'], permissions: ['*'] } as any;

describe('list_active_alerts boundary scenarios', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    alertService.getAlerts.mockResolvedValue({ items: [], total: 0 });
    rbacService.getUserInstanceAccess.mockResolvedValue([]);
  });

  it('rejects invalid severity and time instead of silently broadening the query', async () => {
    const invalidSeverity = await listActiveAlertsTool.handler({ severity: 'fatal' }, { actor });
    expect(invalidSeverity).toMatchObject({ success: false, errorCode: 'INVALID_ARGUMENTS' });

    const invalidSince = await listActiveAlertsTool.handler({ since: 'tomorrow-ish' }, { actor });
    expect(invalidSince).toMatchObject({ success: false, errorCode: 'INVALID_ARGUMENTS' });
  });

  it('requires an authenticated actor before reading the alert collection', async () => {
    const result = await listActiveAlertsTool.handler({});
    expect(result).toMatchObject({ success: false, errorCode: 'MISSING_ACTOR' });
    expect(alertService.getAlerts).not.toHaveBeenCalled();
  });

  it('reads the paginated service response before applying time and instance filters', async () => {
    alertService.getAlerts.mockResolvedValue({
      items: [
        { id: 1, instance_id: 10, severity: 'warning', created_at: '2026-09-08T10:00:00Z' },
        { id: 2, instance_id: 20, severity: 'warning', created_at: '2026-09-08T10:00:00Z' },
        { id: 3, instance_id: 10, severity: 'warning', created_at: '2026-09-01T10:00:00Z' },
      ],
      total: 3,
    });
    rbacService.getUserInstanceAccess.mockResolvedValue([{ instance_id: 10 }]);

    const result = await listActiveAlertsTool.handler({ since: '2026-09-08T00:00:00Z' }, { actor: { ...actor, roles: ['operator'], permissions: ['alert:view'], instanceScopes: { 10: 'read-only' } }, userId: 7 });

    expect(result).toMatchObject({ success: true, data: { total: 1, alerts: [{ id: 1, level: 'warning' }] } });
  });

  it('returns an empty paginated result without an array-method exception', async () => {
    await expect(listActiveAlertsTool.handler({}, { actor })).resolves.toMatchObject({
      success: true, data: { total: 0, alerts: [] },
    });
  });

  it('supports the legacy array response', async () => {
    alertService.getAlerts.mockResolvedValue([{ id: 1, instance_id: 10 }]);
    await expect(listActiveAlertsTool.handler({}, { actor })).resolves.toMatchObject({
      success: true, data: { total: 1, alerts: [{ id: 1 }] },
    });
  });
  it('#393 pushes the authorized intersection down before the database applies LIMIT', async () => {
    const rows = [{ id: 30, instance_id: 30 }, { id: 20, instance_id: 20 }, { id: 10, instance_id: 10 }];
    alertService.getAlerts.mockImplementation(async (options) => ({ items: rows
      .filter(row => options.allowed_instance_ids === null || options.allowed_instance_ids?.includes(row.instance_id))
      .slice(0, options.limit) }));
    const scoped = { ...actor, roles: ['viewer'], permissions: ['alert:view'],
      instanceScopes: { 10: 'read-only', 20: 'read-write' }, resourceBoundary: { instanceIds: [10, 30] } };
    expect(await listActiveAlertsTool.handler({ limit: 1 }, { actor: scoped })).toMatchObject({
      success: true, data: { total: 1, alerts: [{ id: 10 }] },
    });
    expect(alertService.getAlerts).toHaveBeenCalledWith({ allowed_instance_ids: [10], instance_only: true,
      level: undefined, limit: 1, strict: true });
  });

  it('pushes an empty scope for a disjoint task boundary', async () => {
    await listActiveAlertsTool.handler({}, { actor: { ...actor, roles: ['viewer'], permissions: ['alert:view'],
      instanceScopes: { 10: 'read-only' }, resourceBoundary: { instanceIds: [20] } } });
    expect(alertService.getAlerts).toHaveBeenCalledWith(expect.objectContaining({ allowed_instance_ids: [] }));
  });

  it('leaves global admins unrestricted unless a task boundary is present', async () => {
    await listActiveAlertsTool.handler({}, { actor });
    expect(alertService.getAlerts).toHaveBeenLastCalledWith(expect.objectContaining({ allowed_instance_ids: null }));
    await listActiveAlertsTool.handler({}, { actor: { ...actor, resourceBoundary: { instanceIds: [10] } } });
    expect(alertService.getAlerts).toHaveBeenLastCalledWith(expect.objectContaining({ allowed_instance_ids: [10] }));
  });

  it('reports service errors instead of a successful empty collection', async () => {
    alertService.getAlerts.mockRejectedValue(new Error('ALERTS_QUERY_FAILED'));
    expect(await listActiveAlertsTool.handler({}, { actor })).toMatchObject({ success: false });
  });

  it.each([0, -1, 101, 1.5])('rejects invalid limit %s before reading alerts', async limit => {
    expect(await listActiveAlertsTool.handler({ limit }, { actor })).toMatchObject({ success: false, errorCode: 'INVALID_ARGUMENTS' });
    expect(alertService.getAlerts).not.toHaveBeenCalled();
  });

});
