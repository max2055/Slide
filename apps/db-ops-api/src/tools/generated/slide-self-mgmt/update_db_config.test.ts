import { beforeEach, describe, expect, it, vi } from 'vitest';

const instanceService = vi.hoisted(() => ({
  getAllInstances: vi.fn(),
  listAvailableInstancesByNormalizedName: vi.fn(),
  updateInstance: vi.fn(),
  getInstanceWithDecryptedPassword: vi.fn(),
  testConnection: vi.fn(),
}));
const credentialService = vi.hoisted(() => ({ consume: vi.fn(), consumeInTransaction: vi.fn() }));

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

  it.each([
    ['rolled_back', 'UPDATE_FAILED', true],
    ['unknown', 'UPDATE_OUTCOME_UNKNOWN', false],
    ['invalid', 'INVALID_CREDENTIAL_REF', false],
  ])('reports %s credential outcome without blindly replaying updates', async (status, errorCode, retryable) => {
    credentialService.consumeInTransaction.mockResolvedValue({ status });
    const result = await updateDbConfigTool.handler({ instance_id: 42, credential_ref: 'ref' }, { actor });
    expect(result).toMatchObject({ success: false, errorCode, details: { retryable } });
    expect(credentialService.consumeInTransaction).toHaveBeenCalledWith('ref', 7, updateDbConfigTool.name, expect.any(Function));
    expect(credentialService.consume).not.toHaveBeenCalled();
    expect(instanceService.updateInstance).not.toHaveBeenCalled();
    expect(instanceService.testConnection).not.toHaveBeenCalled();
    if (status === 'unknown') expect(result.next_actions?.[0]).toContain('对账');
  });

  it('rejects a missing actor before touching a credential reference', async () => {
    const result = await updateDbConfigTool.handler({ instance_id: 42, credential_ref: 'ref' });
    expect(result.errorCode).toBe('MISSING_ACTOR');
    expect(credentialService.consumeInTransaction).not.toHaveBeenCalled();
  });

  it('does not misreport a post-commit test exception as a retryable update failure', async () => {
    credentialService.consumeInTransaction.mockResolvedValue({ status: 'committed' });
    instanceService.testConnection.mockRejectedValue(new Error('synthetic password with spaces'));
    const result = await updateDbConfigTool.handler({ instance_id: 42, credential_ref: 'ref' }, { actor });
    expect(result).toMatchObject({ success: true, status: 'warning', details: { configCommitted: true, retryable: false } });
    expect(JSON.stringify(result)).not.toContain('synthetic password');
    expect(instanceService.updateInstance).not.toHaveBeenCalled();
  });

  it('suppresses update error text and requests reconciliation for an unconfirmed noncredential update', async () => {
    instanceService.updateInstance.mockRejectedValue(new Error('synthetic password with spaces'));
    const result = await updateDbConfigTool.handler({ instance_id: 42, description: '' }, { actor });
    expect(result).toMatchObject({ errorCode: 'UPDATE_OUTCOME_UNKNOWN', details: { retryable: false } });
    expect(JSON.stringify(result)).not.toContain('synthetic password');
  });

  const writer = { userId: 7, username: 'operator', roles: ['dba'], permissions: ['instance:update'], instanceScopes: { 8: 'read-write', 9: 'read-write' }, sessionVersion: 1, requestId: 'r' } as any;
  const limited = { ...writer, instanceScopes: { 8: 'read-write' } };

  it('updates the trimmed unique name and stores a trimmed new name', async () => {
    instanceService.listAvailableInstancesByNormalizedName.mockResolvedValue([{ id: 8, name: 'orders', environment: 'development' }]);
    const result = await updateDbConfigTool.handler({ instance_name: '  orders  ', name: '  orders-2  ', description: 'kept' }, { actor: writer });
    expect(instanceService.listAvailableInstancesByNormalizedName).toHaveBeenCalledWith('orders');
    expect(instanceService.updateInstance).toHaveBeenCalledWith(8, { name: 'orders-2', description: 'kept' });
    expect(result).toMatchObject({ success: true, data: { instanceId: 8 } });
  });

  it('rejects the same name in two environments without using the new environment as a selector', async () => {
    instanceService.listAvailableInstancesByNormalizedName.mockResolvedValue([
      { id: 8, name: 'orders', environment: 'development' },
      { id: 9, name: 'orders', environment: 'staging' },
    ]);
    const result = await updateDbConfigTool.handler({ instance_name: 'orders', environment: 'staging', description: 'nope' }, { actor: writer });
    expect(result).toMatchObject({ success: false, errorCode: 'AMBIGUOUS_INSTANCE_NAME' });
    expect(JSON.stringify(result)).not.toContain('staging');
    expect(instanceService.updateInstance).not.toHaveBeenCalled();
  });

  it('does not reveal or update another environment when the caller can write only one match', async () => {
    instanceService.listAvailableInstancesByNormalizedName.mockResolvedValue([
      { id: 8, name: 'orders', environment: 'development' },
      { id: 9, name: 'orders', environment: 'staging' },
    ]);
    const result = await updateDbConfigTool.handler({ instance_name: 'orders', description: 'nope' }, { actor: limited });
    expect(result).toMatchObject({ success: false, errorCode: 'INSTANCE_NOT_FOUND' });
    expect(JSON.stringify(result)).not.toMatch(/staging|9/);
    expect(instanceService.updateInstance).not.toHaveBeenCalled();
  });

  it('keeps an explicit id update on that id when another environment shares the name', async () => {
    const result = await updateDbConfigTool.handler({ instance_id: 8, description: 'only-8' }, { actor: limited, instanceId: 8 });
    expect(instanceService.listAvailableInstancesByNormalizedName).not.toHaveBeenCalled();
    expect(instanceService.updateInstance).toHaveBeenCalledWith(8, { description: 'only-8' });
    expect(result).toMatchObject({ success: true, data: { instanceId: 8 } });
  });
});
