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

    const result = await listActiveAlertsTool.handler({ since: '2026-09-08T00:00:00Z' }, { actor, userId: 7 });

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
});
