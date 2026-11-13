import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { approvalService } = vi.hoisted(() => ({
  approvalService: {
    reviewPendingByTool: vi.fn(),
  },
}));

vi.mock('./agent-tool-approval-service.js', () => ({
  getAgentToolApprovalService: () => approvalService,
}));

import { registerAgentToolApprovalRoutes } from './agent-tool-approval-routes.js';

beforeEach(() => {
  approvalService.reviewPendingByTool.mockReset();
});

describe('Agent tool approval routes', () => {
  it('exposes an uncertain commit distinctly without leaking the storage error', async () => {
    approvalService.reviewPendingByTool.mockRejectedValue(new Error('AGENT_APPROVAL_BATCH_REVIEW_OUTCOME_UNKNOWN'));
    const app = Fastify();
    await registerAgentToolApprovalRoutes(app, async request => {
      (request as any).user = { userId: 9, permissions: ['approval:approve'], roles: ['admin'] };
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/agent/approvals/batch-review',
        payload: { toolName: 'execute_code', action: 'approve' } });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ reasonCode: 'AGENT_APPROVAL_BATCH_REVIEW_OUTCOME_UNKNOWN' });
      expect(approvalService.reviewPendingByTool).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });
  it('batch reviews all pending approvals for the requested tool', async () => {
    approvalService.reviewPendingByTool.mockResolvedValue(['41', '42']);
    const app = Fastify();
    await registerAgentToolApprovalRoutes(app, async (request) => {
      (request as any).user = {
        userId: 9,
        username: 'reviewer',
        roles: ['admin'],
        permissions: ['approval:approve'],
        sessionVersion: 1,
        instanceScopes: {},
        requestId: 'route-test',
      };
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/agent/approvals/batch-review',
      payload: { toolName: 'slide_check_status', action: 'approve', scope: 'once' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      toolName: 'slide_check_status',
      approvalIds: ['41', '42'],
      count: 2,
    });
    expect(approvalService.reviewPendingByTool).toHaveBeenCalledWith(
      'slide_check_status', 9, 'approve', undefined, 'once',
    );
    await app.close();
  });
});
