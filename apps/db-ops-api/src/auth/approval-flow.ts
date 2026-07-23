/**
 * DB-Ops 审批流程
 *
 * 复用 upstream before-tool-call 机制
 * 实现危险操作的审批流程
 */

import { EventEmitter } from 'node:events';
import type { SystemRole } from './role-permissions.js';
import {
  getOperationDangerLevel,
  requiresApproval,
  isOperationInApprovalList,
  type DangerLevel,
} from './role-permissions.js';

// ============== 审批类型定义 ==============

/**
 * 审批状态
 */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired';

/**
 * 审批请求
 */
export interface ApprovalRequest {
  /** 审批请求 ID */
  requestId: string;
  /** 操作名称 */
  operationName: string;
  /** 操作参数 */
  operationParams: Record<string, unknown>;
  /** 请求者 ID */
  requesterId: string;
  /** 请求者角色 */
  requesterRole: SystemRole;
  /** 危险等级 */
  dangerLevel: DangerLevel;
  /** 创建时间 */
  createdAt: number;
  /** 过期时间 */
  expiresAt?: number;
  /** 状态 */
  status: ApprovalStatus;
  /** 审批理由 */
  reason?: string;
  /** 审批人 ID */
  approverId?: string;
  /** 审批人角色 */
  approverRole?: SystemRole;
  /** 审批时间 */
  approvedAt?: number;
  /** 审批备注 */
  approvalNote?: string;
}

/**
 * 审批结果
 */
export interface ApprovalResult {
  /** 是否批准 */
  approved: boolean;
  /** 审批请求 ID */
  requestId?: string;
  /** 拒绝原因 */
  reason?: string;
  /** 附加参数（审批时可能修改） */
  modifiedParams?: Record<string, unknown>;
}

/**
 * 审批处理器
 */
export interface ApprovalHandler {
  /** 处理审批请求 */
  handle(request: ApprovalRequest): Promise<ApprovalResult>;
}

// ============== 审批事件 ==============

export interface ApprovalEvents {
  /** 新的审批请求 */
  'request:new': (request: ApprovalRequest) => void;
  /** 审批通过 */
  'request:approved': (request: ApprovalRequest) => void;
  /** 审批拒绝 */
  'request:rejected': (request: ApprovalRequest) => void;
  /** 审批过期 */
  'request:expired': (request: ApprovalRequest) => void;
}

// ============== 审批流程管理类 ==============

/**
 * 审批流程管理器
 */
export class ApprovalFlowManager extends EventEmitter {
  private requests: Map<string, ApprovalRequest> = new Map();
  private handlers: Map<string, ApprovalHandler> = new Map();
  private defaultTimeoutMs: number = 30 * 60 * 1000; // 30 分钟

  /**
   * 创建审批请求
   */
  createRequest(params: {
    operationName: string;
    operationParams: Record<string, unknown>;
    requesterId: string;
    requesterRole: SystemRole;
    timeoutMs?: number;
  }): ApprovalRequest {
    const dangerLevel = getOperationDangerLevel(params.operationName);

    if (dangerLevel === undefined) {
      throw new Error(`Unknown operation: ${params.operationName}`);
    }

    const requestId = this.generateRequestId();
    const now = Date.now();

    const request: ApprovalRequest = {
      requestId,
      operationName: params.operationName,
      operationParams: params.operationParams,
      requesterId: params.requesterId,
      requesterRole: params.requesterRole,
      dangerLevel,
      createdAt: now,
      expiresAt: now + (params.timeoutMs ?? this.defaultTimeoutMs),
      status: 'pending',
    };

    this.requests.set(requestId, request);

    // 触发事件
    this.emit('request:new', request);

    // 设置过期定时器
    this.scheduleExpiration(request);

    return request;
  }

  /**
   * 获取审批请求
   */
  getRequest(requestId: string): ApprovalRequest | undefined {
    return this.requests.get(requestId);
  }

  /**
   * 获取待审批的请求列表
   */
  getPendingRequests(filter?: {
    requesterId?: string;
    approverRole?: SystemRole;
  }): ApprovalRequest[] {
    let requests = Array.from(this.requests.values()).filter(r => r.status === 'pending');

    if (filter?.requesterId) {
      requests = requests.filter(r => r.requesterId === filter.requesterId);
    }

    return requests;
  }

  /**
   * 批准审批请求
   */
  approve(
    requestId: string,
    approverId: string,
    approverRole: SystemRole,
    note?: string,
    modifiedParams?: Record<string, unknown>,
  ): ApprovalResult {
    const request = this.requests.get(requestId);

    if (!request) {
      return {
        approved: false,
        reason: '审批请求不存在',
      };
    }

    if (request.status !== 'pending') {
      return {
        approved: false,
        reason: `审批请求状态已是 ${request.status}`,
      };
    }

    // 检查审批人权限
    if (!this.canApprove(request, approverRole)) {
      return {
        approved: false,
        reason: '审批人权限不足',
      };
    }

    // 更新请求状态
    request.status = 'approved';
    request.approverId = approverId;
    request.approverRole = approverRole;
    request.approvedAt = Date.now();
    request.approvalNote = note;

    this.requests.set(requestId, request);

    // 触发事件
    this.emit('request:approved', request);

    return {
      approved: true,
      requestId,
      modifiedParams,
    };
  }

  /**
   * 拒绝审批请求
   */
  reject(
    requestId: string,
    approverId: string,
    approverRole: SystemRole,
    reason: string,
  ): ApprovalResult {
    const request = this.requests.get(requestId);

    if (!request) {
      return {
        approved: false,
        reason: '审批请求不存在',
      };
    }

    if (request.status !== 'pending') {
      return {
        approved: false,
        reason: `审批请求状态已是 ${request.status}`,
      };
    }

    // 更新请求状态
    request.status = 'rejected';
    request.approverId = approverId;
    request.approverRole = approverRole;
    request.approvedAt = Date.now();
    request.reason = reason;

    this.requests.set(requestId, request);

    // 触发事件
    this.emit('request:rejected', request);

    return {
      approved: false,
      requestId,
      reason,
    };
  }

  /**
   * 注册审批处理器
   */
  registerHandler(operationName: string, handler: ApprovalHandler): void {
    this.handlers.set(operationName, handler);
  }

  /**
   * 检查是否有处理器
   */
  hasHandler(operationName: string): boolean {
    return this.handlers.has(operationName);
  }

  /**
   * 执行审批流程
   */
  async executeApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    const handler = this.handlers.get(request.operationName);

    if (handler) {
      return await handler.handle(request);
    }

    // 默认处理器：等待人工审批
    return new Promise((resolve) => {
      const checkStatus = () => {
        const updated = this.requests.get(request.requestId);
        if (!updated || updated.status === 'pending') {
          setTimeout(checkStatus, 1000);
          return;
        }

        if (updated.status === 'approved') {
          resolve({
            approved: true,
            requestId: updated.requestId,
          });
        } else {
          resolve({
            approved: false,
            reason: updated.reason || '审批被拒绝',
          });
        }
      };

      checkStatus();
    });
  }

  /**
   * 检查操作是否需要审批
   */
  requiresApprovalForOperation(operationName: string, roleName: SystemRole): boolean {
    return requiresApproval(operationName, roleName) || isOperationInApprovalList(operationName, roleName);
  }

  /**
   * 检查审批人是否有权限审批
   */
  canApprove(request: ApprovalRequest, approverRole: SystemRole): boolean {
    // 危险等级越高，需要的审批人级别越高
    const { dangerLevel } = request;

    switch (dangerLevel) {
      case 1:
        // Level 1: DBA 及以上
        return ['dba', 'admin', 'auditor'].includes(approverRole);
      case 2:
        // Level 2: DBA 及以上
        return ['dba', 'admin'].includes(approverRole);
      case 3:
        // Level 3: admin
        return approverRole === 'admin';
      case 4:
        // Level 4: 需要多重审批（这里简化为 admin）
        return approverRole === 'admin';
      default:
        return false;
    }
  }

  /**
   * 清理过期的请求
   */
  cleanupExpiredRequests(): number {
    const now = Date.now();
    let count = 0;

    for (const request of this.requests.values()) {
      if (request.status === 'pending' && request.expiresAt && now > request.expiresAt) {
        request.status = 'expired';
        this.requests.set(request.requestId, request);
        this.emit('request:expired', request);
        count++;
      }
    }

    return count;
  }

  /**
   * 生成请求 ID
   */
  private generateRequestId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `approval_${timestamp}_${random}`;
  }

  /**
   * 安排过期检查
   */
  private scheduleExpiration(request: ApprovalRequest): void {
    if (!request.expiresAt) {
      return;
    }

    const delay = request.expiresAt - Date.now();
    if (delay > 0) {
      setTimeout(() => {
        this.cleanupExpiredRequests();
      }, delay);
    }
  }

  /**
   * 清除所有请求和处理器（用于测试）
   */
  clear(): void {
    this.requests.clear();
    this.handlers.clear();
  }
}

// ============== 默认审批处理器 ==============

/**
 * 自动审批处理器（用于测试或特定场景）
 */
export class AutoApprovalHandler implements ApprovalHandler {
  private autoApproveOperations: Set<string> = new Set();

  constructor(autoApproveOperations: string[] = []) {
    for (const op of autoApproveOperations) {
      this.autoApproveOperations.add(op);
    }
  }

  async handle(request: ApprovalRequest): Promise<ApprovalResult> {
    if (this.autoApproveOperations.has(request.operationName)) {
      return {
        approved: true,
        requestId: request.requestId,
      };
    }

    // 默认拒绝
    return {
      approved: false,
      reason: '需要人工审批',
    };
  }
}

// ============== 全局实例 ==============

export const approvalFlowManager = new ApprovalFlowManager();

// ============== 辅助函数 ==============

/**
 * 创建审批请求并等待结果
 */
export async function createAndWaitForApproval(params: {
  operationName: string;
  operationParams: Record<string, unknown>;
  requesterId: string;
  requesterRole: SystemRole;
  timeoutMs?: number;
}): Promise<ApprovalResult> {
  const request = approvalFlowManager.createRequest(params);
  return await approvalFlowManager.executeApproval(request);
}

/**
 * 检查操作是否需要审批
 */
export function checkApprovalRequired(
  operationName: string,
  roleName: SystemRole,
): { requiresApproval: boolean; dangerLevel?: DangerLevel } {
  const dangerLevel = getOperationDangerLevel(operationName);

  if (dangerLevel === undefined) {
    return { requiresApproval: false };
  }

  const requires = requiresApproval(operationName, roleName);

  return {
    requiresApproval: requires,
    dangerLevel,
  };
}
