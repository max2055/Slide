import { afterEach, describe, expect, it, vi } from 'vitest';
import { instanceDatabaseService } from '../../../instance-database-service.js';
import { addDatabaseTool } from './add_database.js';

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
