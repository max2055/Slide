import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { instanceDatabaseService } from '../../../instance-database-service.js';
import { credentialReferenceService } from '../../../security/credential-reference-service.js';
import { addDatabaseTool } from './add_database.js';
import { addDatabaseBatchTool } from './add_database_batch.js';

const visibleActor = {
  userId: 7, username: 'dba', roles: ['dba'], permissions: ['instance:*'], instanceScopes: {}, sessionVersion: 1, requestId: 'unit',
};
const hiddenActor = {
  userId: 8, username: 'operator', roles: ['operator'], permissions: ['instance:create', 'instance:update'], instanceScopes: {}, sessionVersion: 1, requestId: 'unit-hidden',
};

describe('slide_add_database', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates an instance with pending credentials when no credential reference is supplied', async () => {
    vi.spyOn(instanceDatabaseService, 'listAvailableInstancesByNormalizedName').mockResolvedValue([]);
    const createInstance = vi.spyOn(instanceDatabaseService, 'createInstance').mockResolvedValue({
      success: true,
      instanceId: 41,
    });

    const result = await addDatabaseTool.handler({
      db_type: 'mysql',
      host: 'db.internal',
      port: 3306,
      username: 'slide',
    }, {
      actor: { userId: 7 } as any,
    } as any);

    expect(result).toMatchObject({
      success: true,
      data: { instanceId: 41, connectionStatus: 'pending_credentials' },
    });
    expect((result as any).details).toMatchObject({ terminal: false, retryable: false });
    expect((result as any).summary).toContain('等待补充凭据');
    expect((result as any).details.message).toContain('未执行（等待补充凭据）');
    expect(createInstance).toHaveBeenCalledWith(expect.objectContaining({ password: '' }));
  });

  it('returns the existing instance id as a terminal result for duplicate names', async () => {
    vi.spyOn(instanceDatabaseService, 'listAvailableInstancesByNormalizedName').mockResolvedValue([{
      id: 73,
      name: 'mysql_db_internal_3306',
      environment: 'development',
    }]);

    const result = await addDatabaseTool.handler({
      db_type: 'mysql',
      host: 'db.internal',
      port: 3306,
      username: 'slide',
    }, { actor: visibleActor } as any);

    expect(result).toMatchObject({
      success: false,
      errorCode: 'INSTANCE_EXISTS',
      data: { instanceId: 73, connectionStatus: 'already_managed' },
      details: { terminal: true, retryable: false },
    });
  });

  it('rejects a hidden same-environment name without disclosing its identity or existence', async () => {
    vi.spyOn(instanceDatabaseService, 'listAvailableInstancesByNormalizedName').mockResolvedValue([{
      id: 73,
      name: 'hidden-orders',
      environment: 'development',
    }]);
    const createInstance = vi.spyOn(instanceDatabaseService, 'createInstance');
    const result = await addDatabaseTool.handler({
      db_type: 'mysql',
      name: 'hidden-orders',
      host: '192.0.2.77',
      port: 3306,
      username: 'slide',
    }, { actor: hiddenActor } as any);
    const packed = JSON.stringify(result);
    expect(result).toMatchObject({
      success: false,
      errorCode: 'INSTANCE_CREATE_DENIED',
      error: '无法完成纳管',
      details: { terminal: true, retryable: false },
    });
    expect(result.data).toBeUndefined();
    expect(result.details).not.toHaveProperty('instanceId');
    expect(packed).not.toContain('73');
    expect(packed).not.toContain('hidden-orders');
    expect(packed).not.toContain('已存在');
    expect(packed).not.toContain('INSTANCE_EXISTS');
    expect(createInstance).not.toHaveBeenCalled();
  });

  it('still discloses a duplicate when the caller can see that instance', async () => {
    vi.spyOn(instanceDatabaseService, 'listAvailableInstancesByNormalizedName').mockResolvedValue([{
      id: 73,
      name: 'orders',
      environment: 'development',
    }]);
    const scoped = { ...hiddenActor, instanceScopes: { 73: 'read-only' as const } };
    const result = await addDatabaseTool.handler({
      db_type: 'mysql', name: 'orders', host: '192.0.2.77', port: 3306, username: 'slide',
    }, { actor: scoped } as any);
    expect(result).toMatchObject({ errorCode: 'INSTANCE_EXISTS', data: { instanceId: 73 } });
  });

  it('hides an occupant outside the caller resource boundary even with global instance permission', async () => {
    vi.spyOn(instanceDatabaseService, 'listAvailableInstancesByNormalizedName').mockResolvedValue([{
      id: 73, name: 'orders', environment: 'development',
    }]);
    const bounded = { ...visibleActor, resourceBoundary: { instanceIds: [4], serverIds: [], networkDeviceIds: [] } };
    const result = await addDatabaseTool.handler({
      db_type: 'mysql', name: 'orders', host: '192.0.2.77', port: 3306, username: 'slide',
    }, { actor: bounded } as any);
    expect(JSON.stringify(result)).not.toContain('73');
    expect(result.errorCode).toBe('INSTANCE_CREATE_DENIED');
  });

  it('allows the same trimmed name in another environment and stores the normalized name', async () => {
    vi.spyOn(instanceDatabaseService, 'listAvailableInstancesByNormalizedName').mockResolvedValue([{
      id: 73,
      name: 'orders',
      environment: 'production',
    }]);
    const createInstance = vi.spyOn(instanceDatabaseService, 'createInstance').mockResolvedValue({
      success: true,
      instanceId: 74,
    });

    const result = await addDatabaseTool.handler({
      db_type: 'mysql',
      name: '  orders  ',
      host: '192.0.2.11',
      port: 3306,
      username: 'slide',
      environment: 'development',
    }, { actor: { userId: 7 } as any } as any);

    expect(result).toMatchObject({ success: true, data: { instanceId: 74, name: 'orders' } });
    expect(createInstance).toHaveBeenCalledWith(expect.objectContaining({
      name: 'orders',
      environment: 'development',
      host: '192.0.2.11',
    }));
  });

  it('rejects a blank name before enumeration or creation', async () => {
    const list = vi.spyOn(instanceDatabaseService, 'listAvailableInstancesByNormalizedName');
    const createInstance = vi.spyOn(instanceDatabaseService, 'createInstance');
    const result = await addDatabaseTool.handler({
      db_type: 'mysql',
      name: '   ',
      host: '192.0.2.11',
      port: 3306,
      username: 'slide',
    }, { actor: { userId: 7 } as any } as any);
    expect(result).toMatchObject({ success: false, errorCode: 'INVALID_ARGUMENTS' });
    expect(list).not.toHaveBeenCalled();
    expect(createInstance).not.toHaveBeenCalled();
  });
});

// MAX-311 / #389: a failed operation must not invite replay of a single-use reference.
describe('slide_add_database single-use credential recovery', () => {
  const secret = 'synthetic-secret-must-not-reach-model';
  const args = { db_type: 'mysql', host: 'db.internal', port: 3306, username: 'slide', credential_ref: 'ref-once' };
  const context = { actor: visibleActor as any };

  beforeEach(() => {
    vi.spyOn(instanceDatabaseService, 'listAvailableInstancesByNormalizedName').mockResolvedValue([]);
    vi.spyOn(instanceDatabaseService, 'testConnection').mockResolvedValue({ success: true, message: 'OK' });
    vi.spyOn(instanceDatabaseService, 'createInstance').mockResolvedValue({ success: true, instanceId: 41 });
    vi.spyOn(credentialReferenceService, 'consume').mockResolvedValueOnce(secret).mockResolvedValue(null);
  });
  afterEach(() => vi.restoreAllMocks());

  it('terminates a connection rejection before creation and requires a new reference', async () => {
    vi.mocked(instanceDatabaseService.testConnection).mockResolvedValue({ success: false, message: secret });
    const result = await addDatabaseTool.handler(args, context);
    expect(result).toMatchObject({ errorCode: 'CONNECTION_FAILED', details: { terminal: true, retryable: false } });
    expect(result.next_actions?.join(' ')).toContain('新的 credential_ref');
    expect(instanceDatabaseService.createInstance).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('does not replay a failed create with an already consumed reference', async () => {
    vi.mocked(instanceDatabaseService.createInstance).mockResolvedValue({ success: false, error: '数据库未连接' });
    const first = await addDatabaseTool.handler(args, context);
    expect(first).toMatchObject({ errorCode: 'CREATE_INSTANCE_FAILED', details: { terminal: true, retryable: false } });
    expect(first.next_actions?.join(' ')).toMatch(/确认未创建.*新的 credential_ref/);
    const second = await addDatabaseTool.handler(args, context);
    expect(second.errorCode).toBe('INVALID_CREDENTIAL_REF');
    expect(instanceDatabaseService.createInstance).toHaveBeenCalledTimes(1);
  });

  it.each(['returned', 'thrown'])('requires reconciliation when a committed insert has an unknown %s result', async (mode) => {
    let writes = 0;
    vi.mocked(instanceDatabaseService.createInstance).mockImplementation(async () => {
      writes++;
      if (mode === 'thrown') throw new Error(secret);
      return { success: false, error: secret };
    });
    const result = await addDatabaseTool.handler(args, context);
    expect(result).toMatchObject({ success: false, details: { terminal: true, retryable: false } });
    expect(result.error).toContain('结果未知');
    expect(result.next_actions?.[0]).toMatch(/对账.*不要.*重试/);
    expect(result.next_actions?.join(' ')).toMatch(/确认未创建.*新的 credential_ref/);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(writes).toBe(1);
    expect(instanceDatabaseService.listAvailableInstancesByNormalizedName).toHaveBeenCalledTimes(1);
    // Reconciliation finds the row whose acknowledgement was lost; reuse it.
    vi.mocked(instanceDatabaseService.listAvailableInstancesByNormalizedName).mockResolvedValue([{ id: 41, name: 'mysql_db_internal_3306', environment: 'development' }]);
    expect(await addDatabaseTool.handler(args, context)).toMatchObject({ errorCode: 'INSTANCE_EXISTS', data: { instanceId: 41 } });
    expect(writes).toBe(1);
    expect(credentialReferenceService.consume).toHaveBeenCalledTimes(1);
  });

  it('reuses an already managed address without suggesting another create', async () => {
    vi.mocked(instanceDatabaseService.createInstance).mockResolvedValue({ success: false, instanceId: 73, error: secret });
    const result = await addDatabaseTool.handler(args, context);
    expect(result).toMatchObject({ errorCode: 'INSTANCE_EXISTS', data: { instanceId: 73 }, details: { terminal: true, retryable: false } });
    expect(result.next_actions?.join(' ')).toContain('复用已有实例 ID 73');
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('does not disclose a hidden physical occupant id, name, or existence', async () => {
    const occupant = 'occupant-name-must-stay-hidden';
    vi.mocked(instanceDatabaseService.createInstance).mockResolvedValue({
      success: false,
      instanceId: 73,
      error: `该地址已被实例 "${occupant}" (ID: 73) 纳管，请勿重复添加`,
    });
    const result = await addDatabaseTool.handler(args, { actor: hiddenActor as any });
    const packed = JSON.stringify(result);
    expect(result).toMatchObject({ errorCode: 'INSTANCE_CREATE_DENIED', details: { terminal: true, retryable: false } });
    expect(result.data).toBeUndefined();
    expect(packed).not.toContain('73');
    expect(packed).not.toContain(occupant);
    expect(packed).not.toContain('已存在');
    expect(packed).not.toContain('已被实例');
    expect(packed).not.toContain(secret);
    expect(credentialReferenceService.consume).toHaveBeenCalledTimes(1);
  });

  it('does not consume the reference for a duplicate name detected before creation', async () => {
    vi.mocked(instanceDatabaseService.listAvailableInstancesByNormalizedName).mockResolvedValue([{ id: 73, name: 'mysql_db_internal_3306', environment: 'development' }]);
    expect(await addDatabaseTool.handler(args, context)).toMatchObject({ errorCode: 'INSTANCE_EXISTS' });
    expect(credentialReferenceService.consume).not.toHaveBeenCalled();
    expect(instanceDatabaseService.createInstance).not.toHaveBeenCalled();
  });

  it.each(['consume', 'testConnection'])('handles a %s exception before creation without leaking secrets or reusing credentials', async (stage) => {
    if (stage === 'consume') vi.mocked(credentialReferenceService.consume).mockReset().mockRejectedValue(new Error(secret));
    else vi.mocked(instanceDatabaseService.testConnection).mockRejectedValue(new Error(secret));
    const result = await addDatabaseTool.handler(args, context);
    expect(result).toMatchObject({ errorCode: 'ADD_DATABASE_FAILED', details: { terminal: true, retryable: false } });
    expect(result.error).toContain('尚未提交创建');
    expect(result.next_actions?.join(' ')).toContain('新的 credential_ref');
    expect(instanceDatabaseService.createInstance).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('requires reconciliation even without credentials when creation returns failure', async () => {
    vi.mocked(instanceDatabaseService.createInstance).mockResolvedValue({ success: false, error: secret });
    const { credential_ref: _, ...pendingArgs } = args;
    const result = await addDatabaseTool.handler(pendingArgs, context);
    expect(result).toMatchObject({ errorCode: 'CREATE_INSTANCE_FAILED', details: { terminal: true, retryable: false } });
    expect(result.next_actions?.[0]).toContain('对账');
    expect(result.next_actions?.join(' ')).not.toContain('新的 credential_ref');
    expect(credentialReferenceService.consume).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('keeps recovery instructions in batch reasons and disables automatic item replay', async () => {
    vi.mocked(instanceDatabaseService.createInstance).mockResolvedValue({ success: false, error: secret });
    const result = await addDatabaseBatchTool.handler({ databases: [args] }, context);
    expect(result).toMatchObject({ success: true, details: { terminal: true, retryable: false }, data: { results: [{ retryable: false }] } });
    expect((result.data as any).results[0].reason).toMatch(/对账.*确认未创建.*新的 credential_ref/);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('can create with a fresh reference after confirming the prior attempt did not create an instance', async () => {
    vi.mocked(instanceDatabaseService.createInstance).mockResolvedValueOnce({ success: false, error: '数据库未连接' });
    expect(await addDatabaseTool.handler(args, context)).toMatchObject({ errorCode: 'CREATE_INSTANCE_FAILED' });
    expect(await instanceDatabaseService.listAvailableInstancesByNormalizedName('mysql_db_internal_3306')).toEqual([]);
    vi.mocked(credentialReferenceService.consume).mockResolvedValueOnce(secret);
    const recovered = await addDatabaseTool.handler({ ...args, credential_ref: 'fresh-reference' }, context);
    expect(recovered).toMatchObject({ success: true, data: { instanceId: 41, connectionStatus: 'connected' } });
    expect(credentialReferenceService.consume).toHaveBeenLastCalledWith('fresh-reference', 7, addDatabaseTool.name);
    expect(JSON.stringify(recovered)).not.toContain(secret);
  });

  it('does not consume a reference when instance enumeration fails before any creation attempt', async () => {
    vi.mocked(instanceDatabaseService.listAvailableInstancesByNormalizedName).mockRejectedValue(new Error(secret));
    const result = await addDatabaseTool.handler(args, context);
    expect(result).toMatchObject({ errorCode: 'ADD_DATABASE_FAILED', details: { terminal: true, retryable: false } });
    expect(result.next_actions?.join(' ')).toContain('尚未消费');
    expect(credentialReferenceService.consume).not.toHaveBeenCalled();
    expect(instanceDatabaseService.createInstance).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
