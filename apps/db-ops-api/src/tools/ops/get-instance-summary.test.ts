import { beforeEach, describe, expect, it, vi } from 'vitest';

const instanceService = vi.hoisted(() => ({
  getInstanceById: vi.fn(),
  getAllInstances: vi.fn(),
}));

vi.mock('../../instance-database-service.js', () => ({ instanceDatabaseService: instanceService }));
vi.mock('../../auth/rbac-service.js', () => ({
  RbacService: class {
    getUserInstanceAccess = vi.fn().mockResolvedValue([]);
  },
}));

import { getInstanceSummaryTool } from './get_instance_summary.js';

describe('get_instance_summary health readiness', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not report a stale score for an unknown instance without credentials', async () => {
    instanceService.getInstanceById.mockResolvedValue({
      id: 29,
      name: 'dameng-pending',
      db_type: 'dameng',
      status: 'active',
      host: '203.0.113.29',
      port: 5236,
      health_status: 'unknown',
      health_score: 100,
      password_encrypted: '',
    });

    const result = await getInstanceSummaryTool.handler({ instance_id: 29 });

    expect(result).toMatchObject({
      success: true,
      data: { instances: [{ id: 29, health_status: 'unknown', health_score: 0 }] },
    });
  });

  it('normalizes a stale healthy status when the stored credential is unusable', async () => {
    instanceService.getInstanceById.mockResolvedValue({
      id: 30,
      name: 'dameng-unusable',
      db_type: 'dameng',
      status: 'active',
      host: '203.0.113.30',
      port: 5236,
      username: 'monquery',
      health_status: 'healthy',
      health_score: 100,
      password_encrypted: 'opaque-ciphertext',
    });

    const result = await getInstanceSummaryTool.handler({ instance_id: 30 });

    expect(result).toMatchObject({
      success: true,
      data: { instances: [{ id: 30, health_status: 'unknown', health_score: 0 }] },
    });
  });
});
