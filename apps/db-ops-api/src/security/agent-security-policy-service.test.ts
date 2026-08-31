import { describe, expect, it } from 'vitest';
import { AgentSecurityPolicyService, validateAgentSecurityPolicyUpdate } from './agent-security-policy-service.js';

function row(overrides: Record<string, unknown> = {}) {
  return {
    agent_id: 'slide-db-ops', tool_allowlist: '["query_metrics"]', skill_allowlist: '["health-check"]',
    allowed_effects: '["read"]', resource_scope: '{"instanceIds":[12],"serverIds":null,"networkDeviceIds":null}',
    version: 3, updated_by: 7, updated_at: '2026-01-01T00:00:00.000Z', ...overrides,
  };
}

describe('AgentSecurityPolicyService', () => {
  it('enforces tool, effect, and resource restrictions from the cached policy', async () => {
    const service = new AgentSecurityPolicyService(() => ({ execute: async () => [[row()]] } as any));
    await service.initialize();
    expect(service.evaluateTool('slide-db-ops', 'query_metrics', 'read', { type: 'instance', instanceId: 12 }).allowed).toBe(true);
    expect(service.evaluateTool('slide-db-ops', 'other', 'read').reasonCode).toBe('AGENT_TOOL_DENIED');
    expect(service.evaluateTool('slide-db-ops', 'query_metrics', 'write').reasonCode).toBe('AGENT_EFFECT_DENIED');
    expect(service.evaluateTool('slide-db-ops', 'query_metrics', 'read', { type: 'instance', instanceId: 13 }).reasonCode)
      .toBe('AGENT_RESOURCE_DENIED');
    expect(service.evaluateTool('slide-db-ops', 'query_metrics', 'read', { type: 'network_device', networkDeviceId: 17 }).allowed).toBe(true);
    const restricted = new AgentSecurityPolicyService(() => ({ execute: async () => [[row({
      resource_scope: '{"instanceIds":null,"serverIds":null,"networkDeviceIds":[18]}',
    })]] } as any));
    await restricted.initialize();
    expect(restricted.evaluateTool('slide-db-ops', 'query_metrics', 'read', { type: 'network_device', networkDeviceId: 17 }).reasonCode)
      .toBe('AGENT_RESOURCE_DENIED');
    expect(restricted.evaluateTool('slide-db-ops', 'query_metrics', 'read', { type: 'network_device', networkDeviceId: 18 }).allowed).toBe(true);
    expect([...service.skillAllowlist('slide-db-ops')!]).toEqual(['health-check']);
  });

  it('writes the current policy and immutable history in one transaction', async () => {
    const calls: string[] = [];
    const connection = {
      beginTransaction: async () => { calls.push('begin'); },
      execute: async (sql: string) => {
        calls.push(sql);
        return sql.startsWith('SELECT version') ? [[{ version: 3 }]] : [{ affectedRows: 1 }];
      },
      commit: async () => { calls.push('commit'); },
      rollback: async () => { calls.push('rollback'); },
      release: () => { calls.push('release'); },
    };
    const service = new AgentSecurityPolicyService(() => ({
      execute: async () => [[row()]], getConnection: async () => connection,
    } as any));
    await service.initialize();
    const updated = await service.update('slide-db-ops', {
      toolAllowlist: [], skillAllowlist: null, allowedEffects: ['read'],
      resourceScope: { instanceIds: null, serverIds: [], networkDeviceIds: null }, changeNote: 'restrict tools',
    }, 7);
    expect(updated.version).toBe(4);
    expect(calls.some((sql) => sql.includes('agent_security_policy_history'))).toBe(true);
    expect(calls.indexOf('commit')).toBeGreaterThan(calls.findIndex((sql) => sql.includes('agent_security_policy_history')));
    expect(service.evaluateTool('slide-db-ops', 'query_metrics', 'read').reasonCode).toBe('AGENT_TOOL_DENIED');
  });

  it('rejects empty effects and invalid resource identifiers', () => {
    expect(() => validateAgentSecurityPolicyUpdate({
      toolAllowlist: null, skillAllowlist: null, allowedEffects: [],
      resourceScope: { instanceIds: null, serverIds: null, networkDeviceIds: null }, changeNote: 'x',
    })).toThrow('AGENT_ALLOWED_EFFECTS_INVALID');
    expect(() => validateAgentSecurityPolicyUpdate({
      toolAllowlist: null, skillAllowlist: null, allowedEffects: ['read'],
      resourceScope: { instanceIds: [0], serverIds: null, networkDeviceIds: null }, changeNote: 'x',
    })).toThrow('AGENT_INSTANCE_SCOPE_INVALID');
    expect(() => validateAgentSecurityPolicyUpdate({
      toolAllowlist: null, skillAllowlist: null, allowedEffects: ['read'],
      resourceScope: { instanceIds: null, serverIds: null, networkDeviceIds: [0] }, changeNote: 'x',
    })).toThrow('AGENT_NETWORK_DEVICE_SCOPE_INVALID');
    expect(() => validateAgentSecurityPolicyUpdate({
      toolAllowlist: null, skillAllowlist: null, allowedEffects: ['read'],
      resourceScope: undefined as any, changeNote: 'x',
    })).toThrow('AGENT_RESOURCE_SCOPE_INVALID');
    expect(() => validateAgentSecurityPolicyUpdate(null as any)).toThrow('AGENT_RESOURCE_SCOPE_INVALID');
  });
});
