import { describe, expect, it, vi } from 'vitest';
import { approvalFlowManager } from '../auth/approval-flow.js';
import type { ActorContext } from '../auth/actor-context.js';
import type { AnyAgentTool } from './types.js';
import { decideToolPolicy, executeToolWithPolicy } from './policy.js';

const actor = (roles: string[], permissions: string[] = [], scopes: Record<number, 'read-only' | 'read-write' | 'admin'> = {}): ActorContext => Object.freeze({
  userId: 7,
  username: 'alice',
  roles: Object.freeze(roles),
  permissions: Object.freeze(permissions),
  sessionVersion: 1,
  instanceScopes: Object.freeze(scopes),
  requestId: 'policy-test',
});

const tool = (overrides: Partial<AnyAgentTool> = {}): AnyAgentTool => ({
  name: 'operate_instance',
  description: 'test',
  parameters: { type: 'object', properties: {} },
  handler: async () => ({ success: true }),
  ...overrides,
});

describe('actor tool policy', () => {
  it('rejects viewer owner-only actions before a handler can run', () => {
    const decision = decideToolPolicy(actor(['viewer']), tool({ ownerOnly: true }), {});
    expect(decision).toMatchObject({ allow: false, reasonCode: 'OWNER_REQUIRED', tool: 'operate_instance' });
  });

  it('requires declared permissions for DBA and allows an authorized administrator', () => {
    expect(decideToolPolicy(actor(['dba']), tool({ requiredPermissions: ['instances:write'] }), {}).reasonCode)
      .toBe('MISSING_PERMISSION');
    expect(decideToolPolicy(actor(['admin'], ['instances:write']), tool({ requiredPermissions: ['instances:write'] }), {}))
      .toMatchObject({ allow: true, reasonCode: 'ALLOW' });
  });

  it('denies an instance outside the server-side actor scope', () => {
    expect(decideToolPolicy(actor(['dba'], [], { 12: 'read-only' }), tool(), { instance_id: 13 }))
      .toMatchObject({ allow: false, reasonCode: 'INSTANCE_SCOPE_DENIED' });
  });

  it('denies missing and forged approval ids', () => {
    approvalFlowManager.clear();
    const dangerous = tool({ name: 'dangerous_operation', requiresApproval: true });
    const admin = actor(['admin'], [], { 12: 'admin' });
    expect(decideToolPolicy(admin, dangerous, { instance_id: 12 }))
      .toMatchObject({ allow: false, reasonCode: 'APPROVAL_REQUIRED' });
    expect(decideToolPolicy(admin, dangerous, { instance_id: 12, approvalId: 'forged' }))
      .toMatchObject({ allow: false, reasonCode: 'INVALID_APPROVAL' });
  });

  it('accepts only a server-approved request bound to the same actor and arguments', () => {
    approvalFlowManager.clear();
    const approved = approvalFlowManager.createRequest({
      operationName: 'slide_update_config',
      operationParams: { instance_id: 12 },
      requesterId: '7',
      requesterRole: 'admin',
    });
    expect(approvalFlowManager.approve(approved.requestId, '9', 'admin').approved).toBe(true);
    const dangerous = tool({ name: 'slide_update_config', requiresApproval: true });
    const admin = actor(['admin'], [], { 12: 'admin' });
    expect(decideToolPolicy(admin, dangerous, { instance_id: 12, approvalId: approved.requestId }))
      .toMatchObject({ allow: true, reasonCode: 'ALLOW' });
    expect(decideToolPolicy(admin, dangerous, { instance_id: 13, approvalId: approved.requestId }))
      .toMatchObject({ allow: false, reasonCode: 'INSTANCE_SCOPE_DENIED' });
  });

  it('does not invoke a handler when policy denies the call', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true });
    const result = await executeToolWithPolicy(actor(['viewer']), tool({ ownerOnly: true, handler }), {});
    expect(result.decision.allow).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
