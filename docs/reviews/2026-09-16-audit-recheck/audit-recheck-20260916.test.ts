// Isolated audit probes: assertions document defects, not desired behavior.
import { afterEach, expect, it, vi } from 'vitest';
import { AgentRunner, ToolRegistry } from '@slide/agent-core';
import { CronExecutor } from '../cron/cron-executor.js';
import { CronManager } from '../cron/cron-manager.js';
import { WorkerRuntime } from '../workflows/worker-runtime.js';
import { executeToolWithPolicy } from '../tools/policy.js';
import { agentExecutionConfigService } from '../security/agent-execution-config-service.js';
import { sqlExecutor } from '../sql-executor.js';

const mocks = vi.hoisted(() => ({
  internalExecute: vi.fn(), script: vi.fn(), connection: vi.fn(), audit: vi.fn(), authorize: vi.fn(),
}));
vi.mock('../db-connection', () => ({ dbConnection: { getPool: () => ({ execute: mocks.internalExecute }) } }));
vi.mock('../cron/script-service', () => ({ scriptService: { getScriptById: mocks.script } }));
vi.mock('../database-service', () => ({ databaseService: { ensureConnectionAlive: async () => true, getConnection: mocks.connection } }));
vi.mock('../audit/audit-log', () => ({ auditLogManager: { logSqlExecution: mocks.audit } }));
vi.mock('../security/approval-execution-authorizer', () => ({ authorizeApprovedSqlExecution: mocks.authorize }));
vi.mock('../security/security-event-service', () => ({ securityEventService: { record: async () => {} } }));

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function jobService() {
  return { startLog: vi.fn(async () => 1), completeLog: vi.fn(async () => {}), updateRunResult: vi.fn(async () => {}) };
}

it('Cron permits a second run and both real AgentRunner tools finish after timeout', async () => {
  vi.useFakeTimers();
  const blocked = gate();
  const contexts: any[] = [];
  let effects = 0;
  const tools = new ToolRegistry();
  tools.register({ name: 'probe', description: 'isolated counter', parameters: { type: 'object', properties: {} },
    execute: async (_args, context) => { contexts.push(context); await blocked.promise; effects++; return 'ok'; } } as any);
  const provider = { getDefaultModel: () => 'probe', chat: async (messages: any[]) => {
    const done = messages.some(m => m.role === 'tool');
    return { content: done ? 'done' : null, finishReason: done ? 'stop' : 'tool_calls', usage: {},
      shouldExecuteTools: !done, hasToolCalls: !done, toolCalls: done ? [] : [{ id: 'p', name: 'probe', arguments: {} }] };
  } } as any;
  const runner = new AgentRunner(provider);
  const run = vi.spyOn(runner, 'run');
  const manager = new CronManager(jobService() as any, new CronExecutor(runner, tools, provider));
  const config = { id: 1, name: 'probe', task_type: 'agent', task_description: 'probe', timeout_seconds: 1 } as any;
  const first = manager.executeJob(config);
  await vi.advanceTimersByTimeAsync(1001);
  await first;
  expect(effects).toBe(0);
  expect(contexts).toHaveLength(1);
  const second = manager.executeJob(config);
  await vi.advanceTimersByTimeAsync(1001);
  await second;
  expect(contexts).toHaveLength(2);
  expect(contexts.every(c => c.signal === undefined)).toBe(true);
  blocked.release();
  await Promise.all(run.mock.results.map(r => r.value));
  expect(effects).toBe(2);
});

it('Worker A continues its effect after losing lease and Worker B completes the same job', async () => {
  vi.useFakeTimers();
  const blocked = gate();
  const effects: string[] = [];
  let expires = 0, token = 0, owner = '';
  const store = {
    claim: async (id: string, seconds: number) => {
      if (owner && Date.now() < expires) return null;
      owner = id; expires = Date.now() + seconds * 1000;
      return { id: 'same-job', type: 'probe', payload: {}, attempts: ++token, maxAttempts: 5, fencingToken: token };
    },
    heartbeat: vi.fn(async () => false),
    complete: vi.fn(async (_id, worker, fence) => worker === owner && fence === token),
    fail: vi.fn(async () => true),
  };
  const first = new WorkerRuntime(store, 'A', 3).runOnce(async () => { await blocked.promise; effects.push('A'); });
  await vi.advanceTimersByTimeAsync(3001);
  expect(store.heartbeat).toHaveBeenCalled();
  expect(await new WorkerRuntime(store, 'B', 3).runOnce(async () => { effects.push('B'); })).toBe('completed');
  blocked.release();
  expect(await first).toBe('retry');
  expect(effects).toEqual(['B', 'A']);
  expect(store.complete).toHaveBeenCalledTimes(1);
});

it('Script Cron forwards control-plane mutation to the pool without sqlExecutor', async () => {
  const sql = 'UPDATE users SET status = 0 WHERE id = 999999';
  mocks.script.mockResolvedValue({ content: sql });
  mocks.internalExecute.mockResolvedValue([{ affectedRows: 1 }]);
  const execute = vi.spyOn(sqlExecutor, 'executeSql');
  const service = jobService();
  await new CronManager(service as any, {} as any).executeJob({ id: 2, task_type: 'script', script_id: 3, target_instance_id: null } as any);
  expect(mocks.internalExecute).toHaveBeenCalledWith(sql);
  expect(execute).not.toHaveBeenCalled();
  expect(service.updateRunResult).toHaveBeenCalledWith(2, 'success');
});

it('Approval is consumed even though audit failure prevents the handler', async () => {
  vi.spyOn(agentExecutionConfigService, 'get').mockResolvedValue({ approvalEnabled: true, restrictedNetworkEnabled: false, reasonCode: 'EXECUTION_CONFIG_READY' });
  const calls: string[] = [];
  const handler = vi.fn(async () => ({ success: true }));
  const result = await executeToolWithPolicy(
    { userId: 7, username: 'probe', roles: ['admin'], permissions: ['instance:update'], instanceScopes: { 12: 'admin' }, sessionVersion: 1, requestId: 'probe' },
    { name: 'slide_update_db_config', description: 'probe', parameters: { type: 'object', properties: {} }, handler },
    { instance_id: 12, approvalId: '42' }, async () => ({ instanceId: 12 }),
    { consume: async () => { calls.push('consume'); return true; } },
    { record: async () => { calls.push('audit-failed'); throw new Error('isolated storage failure'); } },
  );
  expect(calls).toEqual(['consume', 'audit-failed']);
  expect(result.decision.reasonCode).toBe('AUDIT_UNAVAILABLE');
  expect(handler).not.toHaveBeenCalled();
});

it('Approved SQL mutation reports success after durable audit fails', async () => {
  mocks.authorize.mockResolvedValue(true);
  mocks.audit.mockRejectedValue(new Error('isolated storage failure'));
  const query = vi.fn(async () => [{ affectedRows: 1 }, []]);
  mocks.connection.mockReturnValue({ name: 'fake', db_type: 'mysql', pool: { getConnection: async () => ({ query, release() {} }) } });
  const sql = 'UPDATE probe SET value = 1 WHERE id = 1';
  const result = await sqlExecutor.executeSql(9, sql, { userId: '7', approvalGrant: { approvalRequestId: 42, reviewerId: 7, operationId: 'probe' } });
  expect(query).toHaveBeenCalledWith(sql);
  expect(mocks.audit).toHaveBeenCalled();
  expect(result.success).toBe(true);
});
