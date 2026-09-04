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
