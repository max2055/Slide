import { describe, expect, it } from 'vitest';
import type { ActorContext } from '../auth/actor-context.js';
import type { PolicyDecision } from '../tools/types.js';
import { AgentToolAuditService } from './agent-tool-audit-service.js';

const actor: ActorContext = {
  userId: 7, username: 'alice', roles: ['dba'], permissions: ['instance:update'],
  sessionVersion: 1, instanceScopes: { 12: 'read-write' }, requestId: 'audit-test',
};

const decision: PolicyDecision = {
  allow: true,
  reasonCode: 'ALLOW',
  actor: { userId: 7, username: 'alice', roles: ['dba'] },
  tool: 'slide_update_db_config',
  resource: { type: 'instance', instanceId: 12 },
  requestId: 'audit-test',
};

describe('Agent tool audit persistence', () => {
  it('persists redacted inputs and outputs', async () => {
    let values: unknown[] = [];
    const service = new AgentToolAuditService(() => ({
      execute: async (_sql: string, input: unknown[]) => {
        values = input;
        return [{ insertId: 1 }];
      },
    } as any));

    await service.record({
      phase: 'result',
      actor,
      decision,
      args: { instance_id: 12, password: 'plain-text' },
      result: { success: false, details: { apiToken: 'secret-token' } },
    });

    expect(String(values[9])).not.toContain('plain-text');
    expect(String(values[10])).not.toContain('secret-token');
    expect(String(values[9])).toContain('[REDACTED]');
  });

  it('returns cursor-paginated summaries and redacted detail', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const row = {
      id: 9, phase: 'result', actor_id: 7, actor_username: 'alice', agent_id: 'slide-db-ops',
      request_id: 'req-9', tool_name: 'slide_update_db_config', allowed: 1, reason_code: 'ALLOW',
      resource_json: '{"type":"instance","instanceId":12}', policy_snapshot: '{"agentPolicy":{"version":2}}',
      args_redacted: '{"password":"[REDACTED]"}', result_redacted: '{"success":true}',
      approval_id: null, created_at: '2026-01-01T00:00:00.000Z',
    };
    const service = new AgentToolAuditService(() => ({
      execute: async (sql: string, values: unknown[]) => {
        calls.push({ sql, values });
        return [sql.includes('a.*') ? [row] : [row, { ...row, id: 8 }]];
      },
    } as any));

    const page = await service.list({ agentId: 'slide-db-ops', allowed: true, limit: 1 });
    expect(page.records).toHaveLength(1);
    expect(page.nextCursor).toBe(9);
    expect(page.records[0]).not.toHaveProperty('args');
    expect(calls[0].sql).toContain('a.agent_id = ?');
    expect(calls[0].values).toEqual(['slide-db-ops', true]);
    expect(calls[0].sql).toContain('LIMIT 2');

    const detail = await service.detail(9);
    expect(detail).toMatchObject({ id: 9, args: { password: '[REDACTED]' }, result: { success: true } });
  });

  it('never persists execute_code source, supporting content, or raw output', async () => {
    let values: unknown[] = [];
    const service = new AgentToolAuditService(() => ({
      execute: async (_sql: string, input: unknown[]) => {
        values = input;
        return [{ insertId: 1 }];
      },
    } as any));

    await service.record({
      phase: 'result',
      actor,
      decision: { ...decision, tool: 'execute_code', resource: { type: 'none' } },
      args: {
        runtime: 'node', code: 'const auditSecret = "source-secret"', timeoutMs: 2000,
        files: [{ path: 'input.txt', content: 'file-secret' }], approvalId: '42',
      },
      result: {
        success: true,
        data: {
          jobId: 'job-1', exitCode: 0, timedOut: false, outputTruncated: false,
          stdout: 'stdout-secret', stderr: 'stderr-secret',
        },
      },
    });

    const stored = `${values[9]} ${values[10]}`;
    expect(stored).not.toContain('source-secret');
    expect(stored).not.toContain('file-secret');
    expect(stored).not.toContain('stdout-secret');
    expect(stored).not.toContain('stderr-secret');
    expect(JSON.parse(String(values[9]))).toEqual({
      runtime: 'node', codeBytes: 35, fileCount: 1, filesBytes: 11, timeoutMs: 2000,
    });
    expect(JSON.parse(String(values[10]))).toEqual({
      success: true,
      data: {
        jobId: 'job-1', exitCode: 0, timedOut: false, outputTruncated: false,
        stdoutBytes: 13, stderrBytes: 13,
      },
    });
  });
});
