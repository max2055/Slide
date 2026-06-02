/**
 * 审批流程单元测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ApprovalFlowManager,
  approvalFlowManager,
  AutoApprovalHandler,
  createAndWaitForApproval,
  checkApprovalRequired,
} from './approval-flow.js';

describe('ApprovalFlowManager', () => {
  let manager: ApprovalFlowManager;

  beforeEach(() => {
    manager = new ApprovalFlowManager();
  });

  describe('createRequest', () => {
    it('应该创建审批请求', () => {
      const request = manager.createRequest({
        operationName: 'slide_update_config',
        operationParams: { key: 'value' },
        requesterId: 'user123',
        requesterRole: 'dba',
      });

      expect(request.requestId).toMatch(/^approval_[a-z0-9]+_[a-z0-9]+$/);
      expect(request.operationName).toBe('slide_update_config');
      expect(request.requesterId).toBe('user123');
      expect(request.requesterRole).toBe('dba');
      expect(request.dangerLevel).toBe(2);
      expect(request.status).toBe('pending');
      expect(request.createdAt).toBeDefined();
      expect(request.expiresAt).toBeDefined();
    });

    it('应该为 Level 3 操作创建请求', () => {
      const request = manager.createRequest({
        operationName: 'slide_delete_instance',
        operationParams: { instanceId: 'db-001' },
        requesterId: 'user123',
        requesterRole: 'dba',
      });

      expect(request.dangerLevel).toBe(3);
    });

    it('应该为 Level 4 操作创建请求', () => {
      const request = manager.createRequest({
        operationName: 'slide_reset_system',
        operationParams: {},
        requesterId: 'user123',
        requesterRole: 'admin',
      });

      expect(request.dangerLevel).toBe(4);
    });

    it('应该抛错对于未知的操作', () => {
      expect(() =>
        manager.createRequest({
          operationName: 'unknown_operation',
          operationParams: {},
          requesterId: 'user123',
          requesterRole: 'dba',
        }),
      ).toThrow('Unknown operation');
    });

    it('应该使用自定义超时时间', () => {
      const request = manager.createRequest({
        operationName: 'slide_update_config',
        operationParams: {},
        requesterId: 'user123',
        requesterRole: 'dba',
        timeoutMs: 60000,
      });

      expect(request.expiresAt).toBe(request.createdAt + 60000);
    });

    it('应该触发新请求事件', () => {
      const handler = vi.fn();
      manager.on('request:new', handler);

      manager.createRequest({
        operationName: 'slide_update_config',
        operationParams: {},
        requesterId: 'user123',
        requesterRole: 'dba',
      });

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('getRequest', () => {
    it('应该获取审批请求', () => {
      const created = manager.createRequest({
        operationName: 'slide_update_config',
        operationParams: {},
        requesterId: 'user123',
        requesterRole: 'dba',
      });

      const retrieved = manager.getRequest(created.requestId);
      expect(retrieved).toEqual(created);
    });

    it('应该返回 undefined 对于不存在的请求', () => {
      const retrieved = manager.getRequest('non-existent');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('getPendingRequests', () => {
    beforeEach(() => {
      manager.createRequest({
        operationName: 'slide_update_config',
        operationParams: {},
        requesterId: 'user1',
        requesterRole: 'dba',
      });

      manager.createRequest({
        operationName: 'slide_delete_instance',
        operationParams: {},
        requesterId: 'user2',
        requesterRole: 'developer',
      });
    });

    it('应该获取所有待审批请求', () => {
      const pending = manager.getPendingRequests();
      expect(pending).toHaveLength(2);
    });

    it('应该按请求者 ID 过滤', () => {
      const pending = manager.getPendingRequests({ requesterId: 'user1' });
      expect(pending).toHaveLength(1);
      expect(pending[0].requesterId).toBe('user1');
    });
  });

  describe('approve', () => {
    it('应该批准审批请求', () => {
      const request = manager.createRequest({
        operationName: 'slide_update_config',
        operationParams: {},
        requesterId: 'user123',
        requesterRole: 'dba',
      });

      const result = manager.approve(
        request.requestId,
        'admin123',
        'admin',
        'Approved for testing',
      );

      expect(result.approved).toBe(true);
      expect(result.requestId).toBe(request.requestId);

      const updated = manager.getRequest(request.requestId);
      expect(updated?.status).toBe('approved');
      expect(updated?.approverId).toBe('admin123');
      expect(updated?.approverRole).toBe('admin');
    });

    it('应该拒绝批准对于不存在的请求', () => {
      const result = manager.approve('non-existent', 'admin123', 'admin');
      expect(result.approved).toBe(false);
      expect(result.reason).toContain('不存在');
    });

    it('应该拒绝批准对于已处理的请求', () => {
      const request = manager.createRequest({
        operationName: 'slide_update_config',
        operationParams: {},
        requesterId: 'user123',
        requesterRole: 'dba',
      });

      manager.approve(request.requestId, 'admin123', 'admin');

      const result = manager.approve(request.requestId, 'admin123', 'admin');
      expect(result.approved).toBe(false);
      expect(result.reason).toContain('已');
    });

    it('应该拒绝批准对于权限不足的审批人', () => {
      const request = manager.createRequest({
        operationName: 'slide_reset_system',
        operationParams: {},
        requesterId: 'user123',
        requesterRole: 'dba',
      });

      // Level 3 操作需要 admin 审批，dba 无权审批
      const result = manager.approve(request.requestId, 'dba123', 'dba');
      expect(result.approved).toBe(false);
      expect(result.reason).toBe('审批人权限不足');
    });

    it('应该触发批准事件', () => {
      const request = manager.createRequest({
        operationName: 'slide_update_config',
        operationParams: {},
        requesterId: 'user123',
        requesterRole: 'dba',
      });

      const handler = vi.fn();
      manager.on('request:approved', handler);

      manager.approve(request.requestId, 'admin123', 'admin');

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('reject', () => {
    it('应该拒绝审批请求', () => {
      const request = manager.createRequest({
        operationName: 'slide_update_config',
        operationParams: {},
        requesterId: 'user123',
        requesterRole: 'dba',
      });

      const result = manager.reject(
        request.requestId,
        'admin123',
        'admin',
        'Security concern',
      );

      expect(result.approved).toBe(false);
      expect(result.requestId).toBe(request.requestId);
      expect(result.reason).toBe('Security concern');

      const updated = manager.getRequest(request.requestId);
      expect(updated?.status).toBe('rejected');
      expect(updated?.approverId).toBe('admin123');
    });

    it('应该拒绝不存在的请求', () => {
      const result = manager.reject('non-existent', 'admin123', 'admin', 'Reason');
      expect(result.approved).toBe(false);
      expect(result.reason).toContain('不存在');
    });

    it('应该触发拒绝事件', () => {
      const request = manager.createRequest({
        operationName: 'slide_update_config',
        operationParams: {},
        requesterId: 'user123',
        requesterRole: 'dba',
      });

      const handler = vi.fn();
      manager.on('request:rejected', handler);

      manager.reject(request.requestId, 'admin123', 'admin', 'Reason');

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('registerHandler', () => {
    it('应该注册审批处理器', () => {
      const handler = {
        handle: vi.fn(),
      };

      manager.registerHandler('slide_update_config', handler);
      expect(manager.hasHandler('slide_update_config')).toBe(true);
    });

    it('应该返回 false 对于未注册的处理器', () => {
      expect(manager.hasHandler('slide_update_config')).toBe(false);
    });
  });

  describe('executeApproval', () => {
    it('应该使用注册的处理器', async () => {
      const handler = {
        handle: vi.fn().mockResolvedValue({ approved: true, requestId: 'test' }),
      };

      manager.registerHandler('slide_update_config', handler);

      const request = manager.createRequest({
        operationName: 'slide_update_config',
        operationParams: {},
        requesterId: 'user123',
        requesterRole: 'dba',
      });

      const result = await manager.executeApproval(request);
      expect(handler.handle).toHaveBeenCalledWith(request);
      expect(result.approved).toBe(true);
    });

    it('应该等待人工审批当没有处理器', async () => {
      const request = manager.createRequest({
        operationName: 'slide_update_config',
        operationParams: {},
        requesterId: 'user123',
        requesterRole: 'dba',
      });

      // 在后台批准请求
      setTimeout(() => {
        manager.approve(request.requestId, 'admin123', 'admin');
      }, 10);

      const result = await manager.executeApproval(request);
      expect(result.approved).toBe(true);
    });
  });

  describe('requiresApprovalForOperation', () => {
    it('应该检查操作是否需要审批', () => {
      expect(manager.requiresApprovalForOperation('slide_update_config', 'dba')).toBe(true);
      expect(manager.requiresApprovalForOperation('slide_delete_instance', 'dba')).toBe(true);
    });

    it('应该返回 false 对于不需要审批的操作', () => {
      expect(manager.requiresApprovalForOperation('db_query', 'dba')).toBe(false);
    });
  });

  describe('canApprove', () => {
    it('应该检查 Level 1 操作的审批权限', () => {
      const request = {
        requestId: 'test',
        operationName: 'test_op',
        dangerLevel: 1 as const,
        status: 'pending' as const,
        createdAt: Date.now(),
        requesterId: 'user1',
        requesterRole: 'dba' as const,
        operationParams: {},
      };

      expect(manager.canApprove(request, 'dba')).toBe(true);
      expect(manager.canApprove(request, 'admin')).toBe(true);
      expect(manager.canApprove(request, 'auditor')).toBe(true);
    });

    it('应该检查 Level 2 操作的审批权限', () => {
      const request = {
        requestId: 'test',
        operationName: 'test_op',
        dangerLevel: 2 as const,
        status: 'pending' as const,
        createdAt: Date.now(),
        requesterId: 'user1',
        requesterRole: 'dba' as const,
        operationParams: {},
      };

      expect(manager.canApprove(request, 'dba')).toBe(true);
      expect(manager.canApprove(request, 'admin')).toBe(true);
      expect(manager.canApprove(request, 'auditor')).toBe(false);
    });

    it('应该检查 Level 3 操作的审批权限', () => {
      const request = {
        requestId: 'test',
        operationName: 'test_op',
        dangerLevel: 3 as const,
        status: 'pending' as const,
        createdAt: Date.now(),
        requesterId: 'user1',
        requesterRole: 'dba' as const,
        operationParams: {},
      };

      expect(manager.canApprove(request, 'admin')).toBe(true);
      expect(manager.canApprove(request, 'dba')).toBe(false);
    });

    it('应该检查 Level 4 操作的审批权限', () => {
      const request = {
        requestId: 'test',
        operationName: 'test_op',
        dangerLevel: 4 as const,
        status: 'pending' as const,
        createdAt: Date.now(),
        requesterId: 'user1',
        requesterRole: 'dba' as const,
        operationParams: {},
      };

      expect(manager.canApprove(request, 'admin')).toBe(true);
      expect(manager.canApprove(request, 'dba')).toBe(false);
    });
  });

  describe('cleanupExpiredRequests', () => {
    it('应该清理过期的请求', async () => {
      const request = manager.createRequest({
        operationName: 'slide_update_config',
        operationParams: {},
        requesterId: 'user123',
        requesterRole: 'dba',
        timeoutMs: 10,
      });

      await new Promise(resolve => setTimeout(resolve, 20));

      const count = manager.cleanupExpiredRequests();
      expect(count).toBeGreaterThanOrEqual(0);

      const updated = manager.getRequest(request.requestId);
      expect(updated?.status).toBe('expired');
    });
  });
});

describe('approvalFlowManager singleton', () => {
  it('应该导出单例', () => {
    expect(approvalFlowManager).toBeInstanceOf(ApprovalFlowManager);
  });
});

describe('AutoApprovalHandler', () => {
  it('应该自动批准配置的操作', async () => {
    const handler = new AutoApprovalHandler(['slide_update_config']);

    const request = {
      requestId: 'test',
      operationName: 'slide_update_config',
      operationParams: {},
      requesterId: 'user1',
      requesterRole: 'dba' as const,
      dangerLevel: 2 as const,
      status: 'pending' as const,
      createdAt: Date.now(),
    };

    const result = await handler.handle(request);
    expect(result.approved).toBe(true);
  });

  it('应该拒绝未配置的操作', async () => {
    const handler = new AutoApprovalHandler(['slide_update_config']);

    const request = {
      requestId: 'test',
      operationName: 'slide_delete_instance',
      operationParams: {},
      requesterId: 'user1',
      requesterRole: 'dba' as const,
      dangerLevel: 3 as const,
      status: 'pending' as const,
      createdAt: Date.now(),
    };

    const result = await handler.handle(request);
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('需要人工审批');
  });
});

describe('createAndWaitForApproval', () => {
  beforeEach(() => {
    approvalFlowManager.clear();
  });

  it('应该创建请求并等待批准', async () => {
    const requestPromise = createAndWaitForApproval({
      operationName: 'slide_update_config',
      operationParams: {},
      requesterId: 'user123',
      requesterRole: 'dba',
    });

    // 等待一小段时间让请求被创建
    await new Promise(resolve => setTimeout(resolve, 10));

    // 获取请求并批准
    const pending = approvalFlowManager.getPendingRequests();
    if (pending.length > 0) {
      approvalFlowManager.approve(pending[0].requestId, 'admin123', 'admin');
    }

    const result = await requestPromise;
    expect(result.approved).toBe(true);
  });
});

describe('checkApprovalRequired', () => {
  it('应该检查是否需要审批', () => {
    const result = checkApprovalRequired('slide_update_config', 'dba');
    expect(result.requiresApproval).toBe(true);
    expect(result.dangerLevel).toBe(2);
  });

  it('应该返回 false 对于不需要审批的操作', () => {
    const result = checkApprovalRequired('db_query', 'dba');
    expect(result.requiresApproval).toBe(false);
    expect(result.dangerLevel).toBeUndefined();
  });
});
