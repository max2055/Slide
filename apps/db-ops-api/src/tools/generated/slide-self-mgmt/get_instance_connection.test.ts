import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../../../auth/actor-context.js';
import { dbConnection } from '../../../db-connection.js';
import { agentExecutionConfigService } from '../../../security/agent-execution-config-service.js';
import { executeToolWithPolicy } from '../../policy.js';
import { getInstanceConnectionTool as tool } from './get_instance_connection.js';

const owner: ActorContext = {
  userId: 7, username: 'owner', roles: ['admin'], permissions: [],
  sessionVersion: 1, instanceScopes: {}, requestId: 'max382',
};
const metadata = { id: 5, name: 'orders', db_type: 'mysql', host: 'db.example', port: 3306,
  username: 'reader', database_name: 'orders', health_status: 'unknown', environment: 'testing' };
const invalid = [undefined, '5', '', true, false, {}, [], [5], null, 0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1];

describe('MAX-382 / #610 public instance connection arguments', () => {
  const execute = vi.fn();
  beforeEach(() => {
    execute.mockReset().mockResolvedValue([[metadata], []]);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue({ execute } as never);
    vi.spyOn(agentExecutionConfigService, 'get').mockResolvedValue({
      approvalEnabled: true, restrictedNetworkEnabled: false, reasonCode: 'EXECUTION_CONFIG_READY',
    });
  });
  afterEach(() => vi.restoreAllMocks());
  const run = (args: Record<string, unknown>, actor = owner) => executeToolWithPolicy(
    actor, tool, { approvalId: 'test-approval', ...args }, undefined,
    { consume: async () => true }, { record: async () => {} },
  );

  it.each([undefined, null, {}])('reports missing arguments: %j', async args => {
    expect(await tool.handler(args as never)).toMatchObject({ success: false, errorCode: 'MISSING_INSTANCE_ID' });
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([undefined, null])('preserves missing-args handler errors through policy normalization: %j', async args => {
    // Policy itself takes a record. A controlled caller forwards missing args
    // at handler entry to exercise its TOOL_EXECUTION_FAILED catch boundary.
    const forwarded = { ...tool, handler: () => tool.handler(args as never) };
    const outcome = await executeToolWithPolicy(owner, forwarded, { approvalId: 'fixture' }, undefined,
      { consume: async () => true }, { record: async () => {} });
    expect(outcome.result).toMatchObject({ errorCode: 'MISSING_INSTANCE_ID', status: 'error' });
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(invalid.map(value => [value]))('rejects invalid instance_id without querying: %j', async instance_id => {
    expect(await tool.handler({ instance_id })).toMatchObject({ success: false, errorCode: 'RESOURCE_INVALID' });
    expect((await run({ instance_id })).result).toMatchObject({ success: false, errorCode: 'RESOURCE_INVALID', status: 'error' });
    expect(execute).not.toHaveBeenCalled();
  });
  it('maps absent fields through the production policy and preserves the public SQL projection', async () => {
    expect((await run({})).result).toMatchObject({ errorCode: 'MISSING_INSTANCE_ID', status: 'error' });
    const result = (await run({ instance_id: 5 })).result;
    expect(result).toMatchObject({ success: true, data: metadata, details: { instance: metadata } });
    expect(execute).toHaveBeenCalledExactlyOnceWith(expect.any(String), [5]);
    const sql = execute.mock.calls[0]![0] as string;
    expect(sql).toMatch(/SELECT id, name, db_type, host, port, username, database_name,\s+health_status, environment\s+FROM database_instances WHERE id = \? LIMIT 1/);
    expect(sql).not.toMatch(/password|secret|token|encrypted|connection_string|SELECT\s+\*/i);
    expect(Object.keys(result.data as object).sort()).toEqual(Object.keys(metadata).sort());
  });
  it('accepts safe positive integer boundaries without coercion', async () => {
    for (const instance_id of [1, Number.MAX_SAFE_INTEGER]) {
      expect((await run({ instance_id })).result.success).toBe(true);
      expect(execute).toHaveBeenLastCalledWith(expect.any(String), [instance_id]);
    }
  });
  it('distinguishes absent resources only for authorized actors', async () => {
    execute.mockResolvedValue([[], []]);
    expect((await run({ instance_id: 5 })).result).toMatchObject({ errorCode: 'INSTANCE_NOT_FOUND' });
    execute.mockClear();
    for (const instance_id of [5, 999]) {
      const denied = (await run({ instance_id }, { ...owner,
        resourceBoundary: { instanceIds: [], serverIds: [], networkDeviceIds: [] } })).result;
      expect(denied).toMatchObject({ errorCode: 'INSTANCE_SCOPE_DENIED', error: 'Tool access denied' });
      expect(JSON.stringify(denied)).not.toContain('orders');
    }
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects missing actor, non-owner and missing approval before SQL', async () => {
    for (const actor of [undefined, { ...owner, roles: ['viewer'] }]) {
      expect((await executeToolWithPolicy(actor, tool, { instance_id: 5 }, undefined,
        { consume: async () => false }, { record: async () => {} })).result.success).toBe(false);
    }
    expect((await executeToolWithPolicy(owner, tool, { instance_id: 5, approvalId: 'bad' }, undefined,
      { consume: async () => false }, { record: async () => {} })).result).toMatchObject({ errorCode: 'INVALID_APPROVAL' });
    expect(execute).not.toHaveBeenCalled();
  });
});
