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
    alertService.getAlerts.mockResolvedValue([]);
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
});
