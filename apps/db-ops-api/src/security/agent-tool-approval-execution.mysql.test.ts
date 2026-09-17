import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import mysql, { type Pool } from 'mysql2/promise';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbConnection } from '../db-connection.js';
import { executeToolWithPolicy } from '../tools/policy.js';
import type { ActorContext } from '../auth/actor-context.js';
import type { AnyAgentTool } from '../tools/types.js';
import { AgentToolApprovalService } from './agent-tool-approval-service.js';
import { AgentToolApprovalExecution } from './agent-tool-approval-execution.js';
import { AgentToolAuditService } from './agent-tool-audit-service.js';
import { agentExecutionConfigService } from './agent-execution-config-service.js';
import { agentSecurityPolicyService } from './agent-security-policy-service.js';

// Explicitly opt into a disposable MySQL database; never use the application's DB.
const port = Number(process.env.APPROVAL_TEST_MYSQL_PORT);
describe.skipIf(!port)('approval dispatch: real MySQL transactions', () => {
  let pool: Pool;
  const database = `approval_test_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  const store = {
    execute: (sql: string, values?: unknown[]) => pool.execute(sql, values as any[]),
    getConnection: async () => {
      const connection = await pool.getConnection();
      return {
        execute: (sql: string, values?: unknown[]) => connection.execute(sql, values as any[]),
        beginTransaction: () => connection.beginTransaction(), commit: () => connection.commit(),
        rollback: () => connection.rollback(), release: () => connection.release(), destroy: () => connection.destroy(),
      };
    },
  };
  let service: AgentToolApprovalService;
  let audit: AgentToolAuditService;
  let actor: ActorContext;
  let args: Record<string, unknown>;
  let handler: ReturnType<typeof vi.fn<AnyAgentTool['handler']>>;
  let tool: AnyAgentTool;
  const key = 'approval-test-hmac-key-32-characters';
  const resource = { type: 'none' as const };

  beforeAll(async () => {
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', connectionLimit: 8 });
    await pool.query(`CREATE DATABASE ${database}`);
    created = true;
    await pool.end();
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', database, connectionLimit: 8 });
    await pool.query('CREATE TABLE IF NOT EXISTS users (id INT UNSIGNED PRIMARY KEY)');
    await pool.query('INSERT IGNORE INTO users VALUES (7)');
    for (const name of ['054_agent_tool_approvals', '055_agent_tool_audit', '068_agent_tool_approval_scopes', '094_agent_tool_execution_intents']) {
      await pool.query(await readFile(new URL(`../../sql/migrations/${name}.sql`, import.meta.url), 'utf8'));
    }
    await pool.query("ALTER TABLE agent_tool_audit ADD agent_id VARCHAR(128) NOT NULL DEFAULT 'slide-db-ops'");
    service = new AgentToolApprovalService(() => store, key);
    audit = new AgentToolAuditService(() => store);
  });
  afterAll(async () => {
    if (created) await pool.query(`DROP DATABASE ${database}`);
    await pool?.end();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  beforeEach(async () => {
    await pool.query('DELETE FROM agent_tool_audit');
    await pool.query('DELETE FROM agent_tool_execution_intents');
    await pool.query('DELETE FROM agent_tool_approvals');
    vi.stubEnv('AGENT_APPROVAL_HMAC_KEY', key);
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    vi.spyOn(agentExecutionConfigService, 'get').mockResolvedValue({
      approvalEnabled: true, restrictedNetworkEnabled: false, reasonCode: 'EXECUTION_CONFIG_READY',
    });
    actor = { userId: 7, username: 'admin', roles: ['admin'], permissions: [], instanceScopes: {}, sessionVersion: 1, requestId: randomUUID() };
    handler = vi.fn(async () => ({ success: true }));
    tool = { name: 'execute_code', description: 'test', parameters: { type: 'object', properties: {} }, handler };
    args = { runtime: 'shell', code: 'curl https://example.com' };
    const request = await service.submit(actor, tool, args, resource);
    await service.review(request.id, 7, 'approve');
    args.approvalId = request.id;
  });
  const execute = (recorder = audit, signal?: AbortSignal) => executeToolWithPolicy(
    actor, tool, args, async () => resource, undefined, recorder, 'slide-db-ops', { signal },
  );
  const state = async () => {
    const [rows] = await pool.query<any[]>('SELECT status, used_count FROM agent_tool_approvals WHERE id = ?', [args.approvalId]);
    const [intents] = await pool.query<any[]>('SELECT state FROM agent_tool_execution_intents WHERE approval_id = ?', [args.approvalId]);
    return { ...rows[0], intents: intents.map(row => row.state) };
  };

  it('commits one consumption, allow audit and handler execution under a concurrent once replay', async () => {
    const results = await Promise.all([execute(), execute()]);
    expect(results.filter(r => r.result.success)).toHaveLength(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await state()).toEqual({ status: 'consumed', used_count: 0, intents: ['finished'] });
    const [rows] = await pool.query<any[]>("SELECT allowed FROM agent_tool_audit WHERE phase = 'decision'");
    expect(rows.map(r => r.allowed).sort()).toEqual([0, 1]);
  });

  it('rolls back consumption and intent when the real audit INSERT fails', async () => {
    const failingAudit = new AgentToolAuditService(() => store);
    vi.spyOn(failingAudit, 'record').mockImplementation((record, connection) =>
      audit.record({ ...record, actor: { ...record.actor, userId: 99999 } }, connection));
    expect((await execute(failingAudit)).result.errorCode).toBe('AUDIT_UNAVAILABLE');
    expect(handler).not.toHaveBeenCalled();
    expect(await state()).toEqual({ status: 'approved', used_count: 0, intents: [] });
    expect((await execute()).result.success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it.each(['APPROVAL_PENDING', 'APPROVAL_REJECTED', 'APPROVAL_EXPIRED', 'INVALID_APPROVAL'])(
    'rejects %s without execution', async (failure) => {
      if (failure === 'INVALID_APPROVAL') args.code = 'curl https://other.example.com';
      else if (failure === 'APPROVAL_EXPIRED') await pool.query('UPDATE agent_tool_approvals SET expires_at = NOW() - INTERVAL 1 SECOND');
      else await pool.query('UPDATE agent_tool_approvals SET status = ?', [failure === 'APPROVAL_PENDING' ? 'pending' : 'rejected']);
      expect((await execute()).result.errorCode).toBe(failure);
      expect(handler).not.toHaveBeenCalled();
      expect((await state()).intents).toEqual([]);
    },
  );

  it('agent policy denial does not consume a valid approval', async () => {
    vi.spyOn(agentSecurityPolicyService, 'evaluateTool').mockReturnValue({ allowed: false, reasonCode: 'AGENT_TOOL_DENIED' });
    expect((await execute()).decision.reasonCode).toBe('AGENT_TOOL_DENIED');
    expect(handler).not.toHaveBeenCalled();
    expect(await state()).toEqual({ status: 'approved', used_count: 0, intents: [] });
  });

  it('cancellation during audit rolls back; cancellation after commit refunds before dispatch', async () => {
    const controller = new AbortController();
    const cancellingAudit = new AgentToolAuditService(() => store);
    vi.spyOn(cancellingAudit, 'record').mockImplementation(async (record, connection) => {
      await audit.record(record, connection);
      controller.abort();
    });
    expect((await execute(cancellingAudit, controller.signal)).result.errorCode).toBe('TOOL_EXECUTION_CANCELLED');
    expect(await state()).toEqual({ status: 'approved', used_count: 0, intents: [] });

    const afterCommit = new AbortController();
    const authorize = AgentToolApprovalExecution.prototype.authorize;
    vi.spyOn(AgentToolApprovalExecution.prototype, 'authorize').mockImplementation(async function (...params) {
      const receipt = await authorize.apply(this, params);
      afterCommit.abort();
      return receipt;
    });
    expect((await execute(audit, afterCommit.signal)).result.errorCode).toBe('TOOL_EXECUTION_CANCELLED');
    expect(handler).not.toHaveBeenCalled();
    expect(await state()).toEqual({ status: 'approved', used_count: 0, intents: ['released'] });
    vi.restoreAllMocks();
  });

  it('does not refund a handler throw after a possible side effect', async () => {
    handler.mockRejectedValue(new Error('after side effect'));
    expect((await execute()).result.errorCode).toBe('TOOL_EXECUTION_FAILED');
    expect((await execute()).result.errorCode).toBe('APPROVAL_CONSUMED');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await state()).toEqual({ status: 'consumed', used_count: 0, intents: ['finished'] });
  });

  it('result-audit failure leaves durable dispatch evidence and cannot replay', async () => {
    const failingAudit = new AgentToolAuditService(() => store);
    vi.spyOn(failingAudit, 'record').mockImplementation(async (record, connection) => {
      if (record.phase === 'result') throw new Error('result unavailable');
      await audit.record(record, connection);
    });
    expect((await execute(failingAudit)).result.errorCode).toBe('AUDIT_UNAVAILABLE');
    expect(await state()).toEqual({ status: 'consumed', used_count: 0, intents: ['dispatching'] });
    expect((await execute()).result.errorCode).toBe('APPROVAL_CONSUMED');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('an ambiguous commit keeps the intent and forbids replay without running the handler', async () => {
    const getConnection = pool.getConnection.bind(pool);
    vi.spyOn(pool, 'getConnection').mockImplementation(async () => {
      const connection = await getConnection();
      const commit = connection.commit.bind(connection);
      connection.commit = async () => { await commit(); throw new Error('lost commit acknowledgement'); };
      return connection;
    });
    expect((await execute()).result.errorCode).toBe('AUDIT_UNAVAILABLE');
    expect(handler).not.toHaveBeenCalled();
    expect(await state()).toEqual({ status: 'consumed', used_count: 0, intents: ['dispatching'] });
  });

  it('a failed refund reports explicit recovery and never invokes the handler', async () => {
    const controller = new AbortController();
    const authorize = AgentToolApprovalExecution.prototype.authorize;
    vi.spyOn(AgentToolApprovalExecution.prototype, 'authorize').mockImplementation(async function (...params) {
      const receipt = await authorize.apply(this, params);
      controller.abort();
      receipt.releaseBeforeHandler = async () => { throw new Error('offline'); };
      return receipt;
    });
    const result = await execute(audit, controller.signal);
    expect(result.result).toMatchObject({ errorCode: 'AUDIT_UNAVAILABLE', data: {
      handlerStarted: false, recovery: 'reconcile-before-new-approval',
    } });
    expect(handler).not.toHaveBeenCalled();
    expect(await state()).toEqual({ status: 'consumed', used_count: 0, intents: ['dispatching'] });
  });

  it('refund is idempotent and never reinstates a revoked approval', async () => {
    const binding = service.binding(actor, tool, args, resource);
    const receipt = await new AgentToolApprovalExecution(store).authorize(
      String(args.approvalId), binding.bindingHash, 7, actor.requestId, undefined, async () => {},
    );
    await pool.query("UPDATE agent_tool_approvals SET status = 'rejected'");
    await Promise.all([receipt.releaseBeforeHandler!(), receipt.releaseBeforeHandler!()]);
    expect(await state()).toEqual({ status: 'rejected', used_count: 0, intents: ['released'] });
    expect((await execute()).result.errorCode).toBe('APPROVAL_REJECTED');
    expect(handler).not.toHaveBeenCalled();
  });

  it('a reusable receipt refunds only its own use, preserving binding and session checks', async () => {
    await pool.query("UPDATE agent_tool_approvals SET scope = 'session', risk_level = 'medium', session_key = 's', max_uses = 3");
    const binding = service.binding(actor, tool, args, resource);
    const auth = new AgentToolApprovalExecution(store);
    const consume = (hash = binding.bindingHash, sessionKey = 's', riskLevel: 'medium' | 'high' = 'medium') => auth.authorize(
      String(args.approvalId), hash, 7, actor.requestId, { sessionKey, riskLevel }, async () => {},
    );
    expect((await consume(binding.bindingHash, 'wrong')).approved).toBe(false);
    expect((await consume(binding.bindingHash, 's', 'high')).approved).toBe(false);
    const [first, second] = await Promise.all([consume(), consume()]);
    expect(first.approved && second.approved).toBe(true);
    expect((await consume('b'.repeat(64))).approved).toBe(false);
    await Promise.all([first.releaseBeforeHandler!(), first.releaseBeforeHandler!()]);
    await second.finish!();
    await second.releaseBeforeHandler!();
    expect(await state()).toMatchObject({ status: 'approved', used_count: 1 });
  });
});
