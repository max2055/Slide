import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../../../auth/actor-context.js';
import { dbConnection } from '../../../db-connection.js';
import { instanceDatabaseService, type DatabaseInstance } from '../../../instance-database-service.js';
import { agentExecutionConfigService } from '../../../security/agent-execution-config-service.js';
import { executeToolWithPolicy } from '../../policy.js';
import { listDatabaseInstancesTool as tool } from './list_database_instances.js';

const types = ['mysql', 'postgresql', 'oracle', 'dameng', 'mongodb', 'redis', 'elasticsearch'] as const;
const caller: ActorContext = { userId: 7, username: 'reader', roles: ['viewer'], permissions: ['instance:view'],
  sessionVersion: 1, instanceScopes: Object.fromEntries(types.map((_, i) => [i + 1, 'read-only'])), requestId: 'max383' };
const rows = types.map((db_type, i) => ({ id: i + 1, name: `visible-${db_type}`, db_type,
  host: 'db.example', port: 3306, environment: 'testing', status: 'active', health_status: 'healthy',
  password_encrypted: 'fixture-secret', connection_string: 'fixture-private-uri', username: 'fixture-user',
})) as DatabaseInstance[];

describe('MAX-383 / #611 instance type filtering', () => {
  beforeEach(() => {
    vi.spyOn(instanceDatabaseService, 'getAllInstances').mockResolvedValue([
      ...rows, { ...rows[0]!, id: 99, name: 'hidden-instance' },
    ]);
    vi.spyOn(agentExecutionConfigService, 'get').mockResolvedValue({ approvalEnabled: true,
      restrictedNetworkEnabled: false, reasonCode: 'EXECUTION_CONFIG_READY' });
  });
  afterEach(() => vi.restoreAllMocks());
  const run = (args: Record<string, unknown>, actor: ActorContext | undefined = caller) => executeToolWithPolicy(
    actor, tool, args, undefined, { consume: async () => false }, { record: async () => {} },
  );

  it.each(types.flatMap(type => [type, type.toUpperCase(), ` \t${type}\r\n`, ` ${type.toUpperCase()} `]))(
    'normalizes %j at the production policy entry and reports the visible count', async db_type => {
      const result = (await run({ db_type })).result;
      const expected = rows.find(row => row.db_type === db_type.trim().toLowerCase())!;
      expect(result).toMatchObject({ success: true, status: 'success', data: [{ id: expected.id }],
        details: { count: 1, instances: [{ id: expected.id }] }, summary: `找到 1 个 ${expected.db_type}数据库实例` });
      expect(result.data).toHaveLength(1);
      expect(JSON.stringify(result)).not.toMatch(/hidden-instance|fixture-secret|fixture-private-uri|fixture-user|password|connection_string/);
    },
  );
  it.each(['MySQL', ' mysql '])('reproduces the original false-empty input %j at the handler', async db_type => {
    expect(await tool.handler({ db_type }, { actor: caller })).toMatchObject({ success: true, details: { count: 1 } });
  });
  it.each(['', ' \t\r\n', null, 0, 1, true, false, [], ['mysql'], {}, new String('mysql')])(
    'rejects invalid input %j without enumerating resources', async db_type => {
      expect((await run({ db_type })).result).toMatchObject({ success: false, errorCode: 'INVALID_ARGUMENTS' });
      expect(instanceDatabaseService.getAllInstances).not.toHaveBeenCalled();
    },
  );
  it('does not coerce objects into a type string', async () => {
    const toString = vi.fn(() => { throw new Error('must not coerce'); });
    expect((await run({ db_type: { toString } })).result.errorCode).toBe('INVALID_ARGUMENTS');
    expect(toString).not.toHaveBeenCalled();
  });
  it.each([{}, { db_type: undefined }])('returns the entire visible collection without filtering', async args => {
    const result = (await run(args)).result;
    expect(result).toMatchObject({ success: true, details: { count: 7 }, summary: '找到 7 个数据库实例' });
    expect((result.data as Array<{ id: number }>).map(row => row.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it('preserves the unknown string contract as a successful empty collection', async () => {
    expect((await run({ db_type: ' unsupported ' })).result).toMatchObject({ success: true, data: [], details: { count: 0 } });
  });
  it('returns no match when only an unauthorized instance has the requested type', async () => {
    expect((await run({ db_type: ' MYSQL ' }, { ...caller, instanceScopes: { 2: 'read-only' } })).result)
      .toMatchObject({ success: true, data: [], details: { count: 0 } });
  });
  it('retains empty boundaries and revocation despite matching types', async () => {
    for (const actor of [{ ...caller, instanceScopes: {} }, { ...caller,
      resourceBoundary: { instanceIds: [], serverIds: [], networkDeviceIds: [] } }]) {
      expect((await run({ db_type: 'MySQL' }, actor)).result).toMatchObject({ success: true, data: [], details: { count: 0 } });
    }
    expect((await run({ db_type: 'MySQL' }, { ...caller, permissions: [] })).result.success).toBe(false);
  });
  it('rejects missing identity and permissions before enumeration', async () => {
    expect(await tool.handler({ db_type: 'MySQL' })).toMatchObject({ errorCode: 'MISSING_ACTOR', data: [] });
    expect((await executeToolWithPolicy(undefined, tool, { db_type: 'MySQL' })).result.success).toBe(false);
    expect((await run({ db_type: 'MySQL' }, { ...caller, permissions: [] })).result.success).toBe(false);
    expect(instanceDatabaseService.getAllInstances).not.toHaveBeenCalled();
  });
  it('does not expose backend errors or resource existence when SQL enumeration fails', async () => {
    vi.mocked(instanceDatabaseService.getAllInstances).mockRestore();
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute: vi.fn().mockRejectedValue(
      new Error('hidden-instance password=fixture-secret'),
    ) } as never);
    const result = (await run({ db_type: ' MySQL ' })).result;
    expect(result).toMatchObject({ success: false, errorCode: 'LIST_INSTANCES_FAILED' });
    expect(JSON.stringify(result)).not.toMatch(/hidden-instance|fixture-secret|password/);
  });
});
