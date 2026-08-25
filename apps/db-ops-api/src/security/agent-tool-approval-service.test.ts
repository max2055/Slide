import { describe, expect, it } from 'vitest';
import type { ActorContext } from '../auth/actor-context.js';
import type { AnyAgentTool, ToolPolicyResource } from '../tools/types.js';
import { AgentToolApprovalService, buildApprovalBinding } from './agent-tool-approval-service.js';

const actor: ActorContext = Object.freeze({
  userId: 7,
  username: 'alice',
  roles: Object.freeze(['dba']),
  permissions: Object.freeze(['instance:update']),
  sessionVersion: 3,
  instanceScopes: Object.freeze({ 12: 'read-write' }),
  requestId: 'approval-test',
});

const tool: AnyAgentTool = {
  name: 'slide_update_db_config',
  description: 'test',
  parameters: { type: 'object', properties: {} },
  handler: async () => ({ success: true }),
};

const resource: ToolPolicyResource = { type: 'instance', instanceId: 12 };

describe('persistent Agent tool approvals', () => {
  it('binds approval to canonical args, resource, actor snapshot, and operator policy', () => {
    const left = buildApprovalBinding('test-hmac-key', actor, tool, { password: 'secret', instance_id: 12 }, resource);
    const right = buildApprovalBinding('test-hmac-key', actor, tool, { instance_id: 12, password: 'secret' }, resource);
    const changed = buildApprovalBinding('test-hmac-key', actor, tool, { instance_id: 13, password: 'secret' }, resource);

    expect(left.bindingHash).toBe(right.bindingHash);
    expect(left.bindingHash).not.toBe(changed.bindingHash);
    expect(left.redactedArgs).toMatchObject({ password: '[REDACTED]' });
    expect(left.policySnapshot).toMatchObject({ actorId: 7, sessionVersion: 3, toolName: tool.name });
  });

  it('atomically consumes an approved binding exactly once', async () => {
    const bindingHash = 'a'.repeat(64);
    let available = true;
    const executor = {
      execute: async (_sql: string, values: unknown[]) => {
        const expectedHash = values[0];
        const affectedRows = available && expectedHash === bindingHash ? 1 : 0;
        if (affectedRows) available = false;
        return [{ affectedRows }] as [unknown];
      },
    };
    const service = new AgentToolApprovalService(() => executor as any, 'test-hmac-key');

    await expect(service.consumeApproved('42', bindingHash, 7)).resolves.toBe(true);
    await expect(service.consumeApproved('42', bindingHash, 7)).resolves.toBe(false);
  });

  it('deduplicates a repeated pending request for the same binding', async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const executor = {
      execute: async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (sql.includes('SELECT id, expires_at')) return [[{ id: 42, expires_at: new Date(Date.now() + 60_000) }]];
        throw new Error('INSERT should not run when a pending request exists');
      },
    };
    const service = new AgentToolApprovalService(() => executor as any, 'test-hmac-key');

    await expect(service.submit(actor, tool, { instance_id: 12 }, resource, { riskLevel: 'medium', scope: 'window', sessionKey: 'session-1' })).resolves.toMatchObject({ id: '42' });
    expect(calls).toHaveLength(1);
  });

  it('allows a reviewed window approval to be reused only in its session and risk ceiling', async () => {
    const executor = {
      execute: async (sql: string, values?: unknown[]) => {
        if (sql.includes('UPDATE agent_tool_approvals') && sql.includes('used_count')) {
          return [{ affectedRows: values?.includes('session-1') ? 1 : 0 }] as [unknown];
        }
        return [[{ scope: 'window', session_key: 'session-1', risk_level: 'medium', used_count: 1, max_uses: 5, status: 'approved', expires_at: new Date(Date.now() + 60_000) }]] as [unknown];
      },
    };
    const service = new AgentToolApprovalService(() => executor as any, 'test-hmac-key');

    await expect(service.consumeApproved('42', 'b'.repeat(64), 7, {
      sessionKey: 'session-1',
      riskLevel: 'medium',
    })).resolves.toBe(true);
    await expect(service.consumeApproved('42', 'b'.repeat(64), 7, {
      sessionKey: 'other-session',
      riskLevel: 'medium',
    })).resolves.toBe(false);
  });

  it('normalizes high-risk requests to one-time scope even when a caller asks for a window', async () => {
    let insertValues: unknown[] = [];
    const executor = {
      execute: async (sql: string, values?: unknown[]) => {
        if (sql.includes('SELECT id, expires_at')) return [[]] as [unknown];
        insertValues = values ?? [];
        return [{ insertId: 43 }] as [unknown];
      },
    };
    const service = new AgentToolApprovalService(() => executor as any, 'test-hmac-key');

    await service.submit(actor, tool, { instance_id: 12 }, resource, {
      scope: 'window', sessionKey: 'session-1', riskLevel: 'high',
    });

    expect(insertValues).toContain('once');
    expect(insertValues).toContain('high');
  });

  it('keeps high-risk review one-time regardless of a requested reusable scope', async () => {
    let updateSql = '';
    const executor = {
      execute: async (sql: string) => {
        updateSql = sql;
        return [{ affectedRows: 1 }] as [unknown];
      },
    };
    const service = new AgentToolApprovalService(() => executor as any, 'test-hmac-key');

    await expect(service.review('43', 9, 'approve', undefined, 'window')).resolves.toBe(true);
    expect(updateSql).toContain("WHEN risk_level = 'high' THEN 'once'");
  });

  it('reports a pending approval distinctly from an invalid approval id', async () => {
    const executor = {
      execute: async () => [[{
        binding_hash: 'c'.repeat(64), status: 'pending', scope: 'once', session_key: null,
        risk_level: 'high', used_count: 0, max_uses: 1, expires_at: new Date(Date.now() + 60_000),
      }]] as [unknown],
    };
    const service = new AgentToolApprovalService(() => executor as any, 'test-hmac-key');

    await expect(service.consumeApprovedDetailed('44', 'c'.repeat(64), 7, { riskLevel: 'high' }))
      .resolves.toEqual({ approved: false, failure: 'APPROVAL_PENDING' });
  });
});
