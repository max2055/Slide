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
});
