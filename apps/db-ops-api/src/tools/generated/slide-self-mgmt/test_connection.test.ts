import { beforeEach, describe, expect, it, vi } from 'vitest';

const instanceService = vi.hoisted(() => ({
  getInstanceWithDecryptedPassword: vi.fn(),
  testConnection: vi.fn(),
}));
const databaseService = vi.hoisted(() => ({ getConnection: vi.fn() }));
const credentialService = vi.hoisted(() => ({ consume: vi.fn() }));

vi.mock('../../../instance-database-service.js', () => ({ instanceDatabaseService: instanceService }));
vi.mock('../../../database-service.js', () => ({ databaseService }));
vi.mock('../../../security/credential-reference-service.js', () => ({ credentialReferenceService: credentialService }));

import { testConnectionTool } from './test_connection.js';

const actor = { userId: 7, username: 'operator', roles: ['admin'], permissions: ['*'] } as any;

describe('slide_test_connection boundary scenarios', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseService.getConnection.mockReturnValue(null);
    instanceService.testConnection.mockResolvedValue({ success: true });
  });

  it('rejects mixed instance and direct connection selectors before consuming credentials', async () => {
    const result = await testConnectionTool.handler({
      instance_id: 1,
      host: 'db.internal',
      port: 3306,
      db_type: 'mysql',
      username: 'root',
      credential_ref: 'cred-1',
    }, { actor });

    expect(result).toMatchObject({ success: false, errorCode: 'MUTUALLY_EXCLUSIVE_ARGUMENTS' });
    expect(credentialService.consume).not.toHaveBeenCalled();
  });

  it('requires a complete direct target and one-time credential reference', async () => {
    const result = await testConnectionTool.handler({ host: 'db.internal' }, { actor });
    expect(result).toMatchObject({ success: false, errorCode: 'INVALID_ARGUMENTS' });
    expect(credentialService.consume).not.toHaveBeenCalled();
  });

  it('reuses an existing managed connection instead of opening a second temporary connection', async () => {
    const query = vi.fn().mockResolvedValue([{}]);
    databaseService.getConnection.mockReturnValue({ connected: true, pool: { query } });
    instanceService.getInstanceWithDecryptedPassword.mockResolvedValue({
      id: 42, db_type: 'mysql', host: 'db.internal', port: 3306, username: 'root', password: 'secret',
    });

    const result = await testConnectionTool.handler({ instance_id: 42 });

    expect(result).toMatchObject({ success: true, status: 'success', data: { connected: true } });
    expect(query).toHaveBeenCalledWith('SELECT 1');
    expect(instanceService.testConnection).not.toHaveBeenCalled();
  });
});
