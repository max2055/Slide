import { beforeEach, describe, expect, it, vi } from 'vitest';

const instanceService = vi.hoisted(() => ({
  getAllInstances: vi.fn(),
  updateInstance: vi.fn(),
  getInstanceWithDecryptedPassword: vi.fn(),
  testConnection: vi.fn(),
}));
const credentialService = vi.hoisted(() => ({ consume: vi.fn() }));

vi.mock('../../../instance-database-service.js', () => ({ instanceDatabaseService: instanceService }));
vi.mock('../../../security/credential-reference-service.js', () => ({ credentialReferenceService: credentialService }));

import { updateDbConfigTool } from './update_db_config.js';

const actor = { userId: 7, username: 'operator', roles: ['admin'], permissions: ['*'] } as any;

describe('slide_update_db_config boundary scenarios', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    instanceService.updateInstance.mockResolvedValue({ success: true });
    instanceService.getInstanceWithDecryptedPassword.mockResolvedValue({
      id: 42, db_type: 'mysql', host: 'db.internal', port: 3306, username: 'root', password: 'secret',
    });
    instanceService.testConnection.mockResolvedValue({ success: false, message: 'ECONNREFUSED' });
  });

  it('rejects a zero port instead of silently dropping it', async () => {
    const result = await updateDbConfigTool.handler({ instance_id: 42, port: 0 });
    expect(result).toMatchObject({ success: false, errorCode: 'INVALID_ARGUMENTS' });
    expect(instanceService.updateInstance).not.toHaveBeenCalled();
  });

  it('preserves explicit empty description and reports a warning when the saved config cannot connect', async () => {
    const result = await updateDbConfigTool.handler({ instance_id: 42, port: 3307, description: '' });

    expect(instanceService.updateInstance).toHaveBeenCalledWith(42, { port: 3307, description: '' });
    expect(result).toMatchObject({ success: true, status: 'warning', data: { connectionTested: true, connectionSuccess: false } });
    expect(result.next_actions).toEqual(expect.arrayContaining([expect.stringContaining('slide_test_connection')]));
  });
});
