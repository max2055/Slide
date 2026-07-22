import { beforeEach, describe, expect, it, vi } from 'vitest';

const execute = vi.fn();

vi.mock('../db-connection', () => ({
  dbConnection: {
    getPool: () => ({ execute }),
    isConnected: () => true,
  },
  encryptData: vi.fn((value: string) => value),
  decryptData: vi.fn((value: string) => value),
}));

import { instanceDatabaseService } from '../instance-database-service';

describe('instance management list', () => {
  beforeEach(() => execute.mockReset());

  it('returns inactive instances to management consumers', async () => {
    execute.mockResolvedValueOnce([[{ id: 7, status: 'inactive' }]]);

    await expect(instanceDatabaseService.getManagedInstances()).resolves.toEqual([
      { id: 7, status: 'inactive' },
    ]);
    expect(execute.mock.calls[0][0]).not.toContain("WHERE status = 'active'");
  });

  it('keeps background collection restricted to active instances', async () => {
    execute.mockResolvedValueOnce([[]]);

    await instanceDatabaseService.getAllInstances();
    expect(execute.mock.calls[0][0]).toContain("WHERE status = 'active'");
  });
});
