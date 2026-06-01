/**
 * 审计日志单元测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  MemoryAuditLogStore,
  AuditLogManager,
  memoryAuditLogStore,
  auditLogManager,
  auditToolCall,
  auditPermissionDenied,
  queryAuditLogs,
  exportAuditLogs,
} from './audit-log.js';
import type { ApprovalRequest } from '../auth/approval-flow.js';

describe('MemoryAuditLogStore', () => {
  let store: MemoryAuditLogStore;

  beforeEach(() => {
    store = new MemoryAuditLogStore();
  });

  describe('write', () => {
    it('应该写入日志条目', async () => {
      const entry = {
        id: 'audit_test_001',
        eventType: 'tool_call' as const,
        level: 'info' as const,
        action: 'db_query',
        result: 'success' as const,
        timestamp: Date.now(),
      };

      await store.write(entry);
      expect(store.getCount()).toBe(1);
    });

    it('应该触发 log:written 事件', async () => {
      const handler = vi.fn();
      store.on('log:written', handler);

      const entry = {
        id: 'audit_test_001',
        eventType: 'tool_call' as const,
        level: 'info' as const,
        action: 'db_query',
        result: 'success' as const,
        timestamp: Date.now(),
      };

      await store.write(entry);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(entry);
    });
  });

  describe('query', () => {
    beforeEach(async () => {
      const now = Date.now();
      await store.write({
        id: 'audit_001',
        eventType: 'tool_call',
        level: 'info',
        userId: 'user1',
        userRole: 'dba',
        action: 'db_query',
        resourceType: 'tool',
        result: 'success',
        timestamp: now - 10000,
      });

      await store.write({
        id: 'audit_002',
        eventType: 'approval_request',
        level: 'warning',
        userId: 'user2',
        userRole: 'developer',
        action: 'slide_update_config',
        resourceType: 'operation',
        result: 'pending',
        timestamp: now - 5000,
      });

      await store.write({
        id: 'audit_003',
        eventType: 'tool_call',
        level: 'error',
        userId: 'user1',
        userRole: 'dba',
        action: 'db_delete',
        resourceType: 'tool',
        result: 'failure',
        errorMessage: 'Permission denied',
        timestamp: now,
      });
    });

    it('应该返回所有日志', async () => {
      const result = await store.query({});
      expect(result.entries).toHaveLength(3);
      expect(result.total).toBe(3);
    });

    it('应该按事件类型过滤', async () => {
      const result = await store.query({ eventType: 'tool_call' });
      expect(result.entries).toHaveLength(2);
    });

    it('应该按用户 ID 过滤', async () => {
      const result = await store.query({ userId: 'user1' });
      expect(result.entries).toHaveLength(2);
    });

    it('应该按用户角色过滤', async () => {
      const result = await store.query({ userRole: 'dba' });
      expect(result.entries).toHaveLength(2);
    });

    it('应该按操作过滤', async () => {
      const result = await store.query({ action: 'db_query' });
      expect(result.entries).toHaveLength(1);
    });

    it('应该按资源类型过滤', async () => {
      const result = await store.query({ resourceType: 'tool' });
      expect(result.entries).toHaveLength(2);
    });

    it('应该按时间范围过滤', async () => {
      const now = Date.now();
      const result = await store.query({ startTime: now - 8000 });
      expect(result.entries).toHaveLength(2);
    });

    it('应该按结果过滤', async () => {
      const result = await store.query({ result: 'failure' });
      expect(result.entries).toHaveLength(1);
    });

    it('应该按时间倒序排序', async () => {
      const result = await store.query({});
      const entries = result.entries;
      expect(entries[0].timestamp).toBeGreaterThanOrEqual(entries[1].timestamp);
      expect(entries[1].timestamp).toBeGreaterThanOrEqual(entries[2].timestamp);
    });

    it('应该支持分页', async () => {
      const result = await store.query({ limit: 2, offset: 0 });
      expect(result.entries).toHaveLength(2);

      const result2 = await store.query({ limit: 2, offset: 2 });
      expect(result2.entries).toHaveLength(1);
    });
  });

  describe('export', () => {
    beforeEach(async () => {
      await store.write({
        id: 'audit_001',
        eventType: 'tool_call',
        level: 'info',
        action: 'db_query',
        result: 'success',
        timestamp: Date.now(),
      });
    });

    it('应该导出 JSON 格式', async () => {
      const json = await store.export({});
      const parsed = JSON.parse(json);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].id).toBe('audit_001');
    });
  });

  describe('clear', () => {
    it('应该清除所有日志', async () => {
      await store.write({
        id: 'audit_001',
        eventType: 'tool_call',
        level: 'info',
        action: 'db_query',
        result: 'success',
        timestamp: Date.now(),
      });

      expect(store.getCount()).toBe(1);
      store.clear();
      expect(store.getCount()).toBe(0);
    });
  });
});

describe('AuditLogManager', () => {
  let manager: AuditLogManager;
  let store: MemoryAuditLogStore;

  beforeEach(() => {
    store = new MemoryAuditLogStore();
    manager = new AuditLogManager(store);
  });

  describe('logToolCall', () => {
    it('应该记录工具调用日志', async () => {
      await manager.logToolCall({
        userId: 'user123',
        username: 'testuser',
        userRole: 'dba',
        toolName: 'db_query',
        toolParams: { query: 'SELECT * FROM users' },
        result: 'success',
        clientIp: '192.168.1.100',
      });

      const logs = await store.query({ eventType: 'tool_call' });
      expect(logs).toHaveLength(1);
      expect(logs[0].userId).toBe('user123');
      expect(logs[0].action).toBe('db_query');
      expect(logs[0].result).toBe('success');
    });

    it('应该触发 log:tool_call 事件', async () => {
      const handler = vi.fn();
      manager.on('log:tool_call', handler);

      await manager.logToolCall({
        userId: 'user123',
        toolName: 'db_query',
        result: 'success',
      });

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('logApprovalRequest', () => {
    it('应该记录审批请求日志', async () => {
      const request: ApprovalRequest = {
        requestId: 'approval_test',
        operationName: 'slide_update_config',
        operationParams: { key: 'value' },
        requesterId: 'user123',
        requesterRole: 'dba',
        dangerLevel: 2,
        createdAt: Date.now(),
        status: 'pending',
      };

      await manager.logApprovalRequest(request);

      const logs = await store.query({ eventType: 'approval_request' });
      expect(logs).toHaveLength(1);
      expect(logs[0].approvalRequestId).toBe('approval_test');
      expect(logs[0].result).toBe('pending');
    });
  });

  describe('logApprovalApproved', () => {
    it('应该记录审批批准日志', async () => {
      const request: ApprovalRequest = {
        requestId: 'approval_test',
        operationName: 'slide_update_config',
        operationParams: {},
        requesterId: 'user123',
        requesterRole: 'dba',
        dangerLevel: 2,
        createdAt: Date.now(),
        status: 'approved',
        approverId: 'admin123',
        approverRole: 'admin',
        approvedAt: Date.now(),
      };

      await manager.logApprovalApproved(request, 'admin123', 'admin');

      const logs = await store.query({ eventType: 'approval_approved' });
      expect(logs).toHaveLength(1);
      expect(logs[0].userId).toBe('admin123');
    });
  });

  describe('logApprovalRejected', () => {
    it('应该记录审批拒绝日志', async () => {
      const request: ApprovalRequest = {
        requestId: 'approval_test',
        operationName: 'slide_update_config',
        operationParams: {},
        requesterId: 'user123',
        requesterRole: 'dba',
        dangerLevel: 2,
        createdAt: Date.now(),
        status: 'rejected',
      };

      await manager.logApprovalRejected(request, 'admin123', 'admin', 'Security concern');

      const logs = await store.query({ eventType: 'approval_rejected' });
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('warning');
      expect(logs[0].errorMessage).toBe('Security concern');
    });
  });

  describe('logApprovalExpired', () => {
    it('应该记录审批过期日志', async () => {
      const request: ApprovalRequest = {
        requestId: 'approval_test',
        operationName: 'slide_delete_instance',
        operationParams: {},
        requesterId: 'user123',
        requesterRole: 'developer',
        dangerLevel: 3,
        createdAt: Date.now(),
        status: 'expired',
      };

      await manager.logApprovalExpired(request);

      const logs = await store.query({ eventType: 'approval_expired' });
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('warning');
    });
  });

  describe('logPermissionDenied', () => {
    it('应该记录权限拒绝日志', async () => {
      await manager.logPermissionDenied({
        userId: 'user123',
        username: 'testuser',
        userRole: 'viewer',
        action: 'slide_delete_instance',
        reason: '权限不足',
        clientIp: '192.168.1.100',
      });

      const logs = await store.query({ eventType: 'permission_denied' });
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('warning');
      expect(logs[0].errorMessage).toBe('权限不足');
    });
  });

  describe('logConfigChange', () => {
    it('应该记录配置变更日志', async () => {
      await manager.logConfigChange({
        userId: 'admin123',
        username: 'admin',
        userRole: 'admin',
        configKey: 'system.name',
        oldValue: 'Old System',
        newValue: 'New System',
        clientIp: '192.168.1.1',
      });

      const logs = await store.query({ eventType: 'config_change' });
      expect(logs).toHaveLength(1);
      expect(logs[0].resourceId).toBe('system.name');
      expect(logs[0].details).toEqual({
        oldValue: 'Old System',
        newValue: 'New System',
      });
    });
  });

  describe('logUserChange', () => {
    it('应该记录用户变更日志', async () => {
      await manager.logUserChange({
        userId: 'admin123',
        username: 'admin',
        userRole: 'admin',
        targetUserId: 'user456',
        action: 'modify_role',
        details: { oldRole: 'viewer', newRole: 'dba' },
      });

      const logs = await store.query({ eventType: 'user_change' });
      expect(logs).toHaveLength(1);
      expect(logs[0].resourceId).toBe('user456');
      expect(logs[0].details).toEqual({ oldRole: 'viewer', newRole: 'dba' });
    });
  });

  describe('logInstanceChange', () => {
    it('应该记录实例变更日志', async () => {
      await manager.logInstanceChange({
        userId: 'dba123',
        username: 'dba',
        userRole: 'dba',
        targetInstanceId: 'db-001',
        action: 'update_config',
        details: { host: '192.168.1.100' },
      });

      const logs = await store.query({ eventType: 'instance_change' });
      expect(logs).toHaveLength(1);
      expect(logs[0].resourceId).toBe('db-001');
    });
  });

  describe('logLogin', () => {
    it('应该记录成功登录日志', async () => {
      await manager.logLogin({
        userId: 'user123',
        username: 'testuser',
        userRole: 'dba',
        success: true,
        clientIp: '192.168.1.100',
        userAgent: 'Mozilla/5.0',
      });

      const logs = await store.query({ eventType: 'login' });
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('info');
      expect(logs[0].result).toBe('success');
    });

    it('应该记录失败登录日志', async () => {
      await manager.logLogin({
        userId: 'user123',
        username: 'testuser',
        success: false,
        errorMessage: '密码错误',
        clientIp: '192.168.1.100',
      });

      const logs = await store.query({ eventType: 'login' });
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('warning');
      expect(logs[0].result).toBe('failure');
    });
  });

  describe('logLogout', () => {
    it('应该记录登出日志', async () => {
      await manager.logLogout({
        userId: 'user123',
        username: 'testuser',
        clientIp: '192.168.1.100',
      });

      const logs = await store.query({ eventType: 'logout' });
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('info');
    });
  });

  describe('query', () => {
    it('应该查询日志', async () => {
      await manager.logToolCall({
        userId: 'user123',
        toolName: 'db_query',
        result: 'success',
      });

      const result = await manager.query({ userId: 'user123' });
      expect(result.entries).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });

  describe('export', () => {
    it('应该导出日志', async () => {
      await manager.logToolCall({
        userId: 'user123',
        toolName: 'db_query',
        result: 'success',
      });

      const json = await manager.export({ userId: 'user123' });
      const parsed = JSON.parse(json);
      expect(parsed).toHaveLength(1);
    });
  });
});

describe('auditLogManager singleton', () => {
  it('应该导出单例', () => {
    expect(auditLogManager).toBeDefined();
    expect(memoryAuditLogStore).toBeDefined();
  });
});

describe('auditToolCall', () => {
  beforeEach(() => {
    memoryAuditLogStore.clear();
  });

  it('应该记录工具调用', async () => {
    await auditToolCall({
      userId: 'user123',
      username: 'testuser',
      userRole: 'dba',
      toolName: 'db_query',
      result: 'success',
    });

    const result = await queryAuditLogs({ eventType: 'tool_call' });
    expect(result.entries).toHaveLength(1);
  });
});

describe('auditPermissionDenied', () => {
  beforeEach(() => {
    memoryAuditLogStore.clear();
  });

  it('应该记录权限拒绝', async () => {
    await auditPermissionDenied({
      userId: 'user123',
      username: 'testuser',
      userRole: 'viewer',
      action: 'slide_delete_instance',
      reason: '权限不足',
    });

    const result = await queryAuditLogs({ eventType: 'permission_denied' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].level).toBe('warning');
  });
});

describe('queryAuditLogs', () => {
  beforeEach(() => {
    memoryAuditLogStore.clear();
  });

  it('应该查询审计日志', async () => {
    await auditToolCall({
      userId: 'user123',
      toolName: 'db_query',
      result: 'success',
    });

    const result = await queryAuditLogs({});
    expect(result.entries).toHaveLength(1);
    expect(result.total).toBe(1);
  });
});

describe('exportAuditLogs', () => {
  beforeEach(() => {
    memoryAuditLogStore.clear();
  });

  it('应该导出审计日志', async () => {
    await auditToolCall({
      userId: 'user123',
      toolName: 'db_query',
      result: 'success',
    });

    const json = await exportAuditLogs({});
    expect(json).toBeDefined();
    expect(typeof json).toBe('string');

    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(1);
  });
});
