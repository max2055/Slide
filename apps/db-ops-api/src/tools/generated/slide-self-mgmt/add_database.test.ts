import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { instanceDatabaseService } from '../../../instance-database-service.js';
import { credentialReferenceService } from '../../../security/credential-reference-service.js';
import { addDatabaseTool } from './add_database.js';
import { addDatabaseBatchTool } from './add_database_batch.js';

describe('slide_add_database', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates an instance with pending credentials when no credential reference is supplied', async () => {
    vi.spyOn(instanceDatabaseService, 'getAllInstances').mockResolvedValue([]);
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
    vi.spyOn(instanceDatabaseService, 'getAllInstances').mockResolvedValue([{
      id: 73,
      name: 'mysql_db_internal_3306',
    } as any]);

    const result = await addDatabaseTool.handler({
      db_type: 'mysql',
      host: 'db.internal',
      port: 3306,
      username: 'slide',
    }, { actor: { userId: 7 } as any } as any);

    expect(result).toMatchObject({
      success: false,
      errorCode: 'INSTANCE_EXISTS',
      data: { instanceId: 73, connectionStatus: 'already_managed' },
      details: { terminal: true, retryable: false },
    });
  });
});

// MAX-311 / #389: a failed operation must not invite replay of a single-use reference.
describe('slide_add_database single-use credential recovery', () => {
  const secret = 'synthetic-secret-must-not-reach-model';
  const args = { db_type: 'mysql', host: 'db.internal', port: 3306, username: 'slide', credential_ref: 'ref-once' };
  const context = { actor: { userId: 7 } as any };

  beforeEach(() => {
    vi.spyOn(instanceDatabaseService, 'getAllInstances').mockResolvedValue([]);
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
    expect(instanceDatabaseService.getAllInstances).toHaveBeenCalledTimes(1);
    // Reconciliation finds the row whose acknowledgement was lost; reuse it.
    vi.mocked(instanceDatabaseService.getAllInstances).mockResolvedValue([{ id: 41, name: 'mysql_db_internal_3306' } as any]);
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

  it('does not consume the reference for a duplicate name detected before creation', async () => {
    vi.mocked(instanceDatabaseService.getAllInstances).mockResolvedValue([{ id: 73, name: 'mysql_db_internal_3306' } as any]);
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
    expect(await instanceDatabaseService.getAllInstances()).toEqual([]);
    vi.mocked(credentialReferenceService.consume).mockResolvedValueOnce(secret);
    const recovered = await addDatabaseTool.handler({ ...args, credential_ref: 'fresh-reference' }, context);
    expect(recovered).toMatchObject({ success: true, data: { instanceId: 41, connectionStatus: 'connected' } });
    expect(credentialReferenceService.consume).toHaveBeenLastCalledWith('fresh-reference', 7, addDatabaseTool.name);
    expect(JSON.stringify(recovered)).not.toContain(secret);
  });

  it('does not consume a reference when instance enumeration fails before any creation attempt', async () => {
    vi.mocked(instanceDatabaseService.getAllInstances).mockRejectedValue(new Error(secret));
    const result = await addDatabaseTool.handler(args, context);
    expect(result).toMatchObject({ errorCode: 'ADD_DATABASE_FAILED', details: { terminal: true, retryable: false } });
    expect(result.next_actions?.join(' ')).toContain('尚未消费');
    expect(credentialReferenceService.consume).not.toHaveBeenCalled();
    expect(instanceDatabaseService.createInstance).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
