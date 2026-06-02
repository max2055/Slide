/**
 * 审计日志系统
 *
 * 复用 upstream before-tool-call 审计日志模式
 * 记录所有危险操作和审批流程
 */

import { EventEmitter } from 'node:events';
import type { SystemRole } from '../auth/role-permissions.js';
import type { ApprovalRequest } from '../auth/approval-flow.js';
import type mysql from 'mysql2/promise';

// ============== 审计日志类型定义 ==============

/**
 * 审计事件类型
 */
export type AuditEventType =
  | 'tool_call'
  | 'approval_request'
  | 'approval_approved'
  | 'approval_rejected'
  | 'approval_expired'
  | 'login'
  | 'logout'
  | 'config_change'
  | 'user_change'
  | 'instance_change'
  | 'permission_denied'
  | 'sql_execution';

/**
 * 审计级别
 */
export type AuditLevel = 'info' | 'warning' | 'error' | 'critical';

/**
 * 审计日志条目
 */
export interface AuditLogEntry {
  /** 日志 ID */
  id: string;
  /** 事件类型 */
  eventType: AuditEventType;
  /** 审计级别 */
  level: AuditLevel;
  /** 操作用户 ID */
  userId?: string;
  /** 操作用户名 */
  username?: string;
  /** 操作用户角色 */
  userRole?: SystemRole;
  /** 操作类型/工具名称 */
  action: string;
  /** 资源类型 */
  resourceType?: string;
  /** 资源 ID */
  resourceId?: string;
  /** 操作详情 */
  details?: Record<string, unknown>;
  /** 审批请求 ID（如果有） */
  approvalRequestId?: string;
  /** 客户端 IP */
  clientIp?: string;
  /** 用户代理 */
  userAgent?: string;
  /** 操作结果 */
  result: 'success' | 'failure' | 'pending';
  /** 错误信息 */
  errorMessage?: string;
  /** 时间戳 */
  timestamp: number;
}

/**
 * 审计日志查询参数
 */
export interface AuditLogQuery {
  /** 事件类型过滤 */
  eventType?: AuditEventType;
  /** 用户 ID 过滤 */
  userId?: string;
  /** 用户角色过滤 */
  userRole?: SystemRole;
  /** 操作类型过滤 */
  action?: string;
  /** 资源类型过滤 */
  resourceType?: string;
  /** 时间范围开始 */
  startTime?: number;
  /** 时间范围结束 */
  endTime?: number;
  /** 结果过滤 */
  result?: 'success' | 'failure' | 'pending';
  /** 资源 ID 过滤（用于 query-history 的 instance 过滤） */
  resourceId?: string;
  /** 搜索文本（用于 SQL 文本模糊搜索） */
  search?: string;
  /** 分页限制 */
  limit?: number;
  /** 分页偏移 */
  offset?: number;
}

/**
 * 审计日志处理器
 */
export interface AuditLogHandler {
  /** 写入日志 */
  write(entry: AuditLogEntry): Promise<void>;
  /** 查询日志 */
  query(params: AuditLogQuery): Promise<{ entries: AuditLogEntry[]; total: number }>;
  /** 导出日志 */
  export(params: AuditLogQuery): Promise<string>;
}

// ============== 内存审计日志存储 ==============

/**
 * 内存审计日志存储（用于测试和原型）
 */
export class MemoryAuditLogStore implements AuditLogHandler {
  private logs: AuditLogEntry[] = [];
  private events = new EventEmitter();

  async write(entry: AuditLogEntry): Promise<void> {
    this.logs.push(entry);
    this.events.emit('log:written', entry);
  }

  async query(params: AuditLogQuery): Promise<{ entries: AuditLogEntry[]; total: number }> {
    let filtered = [...this.logs];

    if (params.eventType) {
      filtered = filtered.filter(log => log.eventType === params.eventType);
    }

    if (params.userId) {
      filtered = filtered.filter(log => log.userId === params.userId);
    }

    if (params.userRole) {
      filtered = filtered.filter(log => log.userRole === params.userRole);
    }

    if (params.action) {
      filtered = filtered.filter(log => log.action === params.action);
    }

    if (params.resourceType) {
      filtered = filtered.filter(log => log.resourceType === params.resourceType);
    }

    if (params.resourceId) {
      filtered = filtered.filter(log => log.resourceId === params.resourceId);
    }

    if (params.startTime) {
      filtered = filtered.filter(log => log.timestamp >= params.startTime);
    }

    if (params.endTime) {
      filtered = filtered.filter(log => log.timestamp <= params.endTime);
    }

    if (params.result) {
      filtered = filtered.filter(log => log.result === params.result);
    }

    if (params.search) {
      const lowerSearch = params.search.toLowerCase();
      filtered = filtered.filter(log =>
        log.details?.sql && String(log.details.sql).toLowerCase().includes(lowerSearch)
      );
    }

    filtered.sort((a, b) => b.timestamp - a.timestamp);

    const offset = params.offset ?? 0;
    const limit = params.limit ?? 100;
    const total = filtered.length;

    return {
      entries: filtered.slice(offset, offset + limit),
      total,
    };
  }

  async export(params: AuditLogQuery): Promise<string> {
    const result = await this.query(params);
    return JSON.stringify(result.entries, null, 2);
  }

  on(event: string, handler: (...args: any[]) => void): void {
    this.events.on(event, handler);
  }

  clear(): void {
    this.logs = [];
  }

  getCount(): number {
    return this.logs.length;
  }
}

// ============== 数据库审计日志存储 ==============

/**
 * 数据库审计日志存储 — 持久化写入 MySQL 的 sql_execution_history 表
 * 专为 SQL 执行历史设计，实现了 AuditLogHandler 接口
 */
export class DatabaseAuditLogStore implements AuditLogHandler {
  private pool: mysql.Pool;

  constructor(pool: mysql.Pool) {
    this.pool = pool;
  }

  async write(entry: AuditLogEntry): Promise<void> {
    const userId = entry.userId ? (Number.isNaN(parseInt(entry.userId, 10)) ? null : parseInt(entry.userId, 10)) : null;
    const instanceId = entry.resourceId ? (Number.isNaN(parseInt(entry.resourceId, 10)) ? null : parseInt(entry.resourceId, 10)) : null;

    await this.pool.execute(
      `INSERT INTO sql_execution_history
       (user_id, username, instance_id, instance_name, db_type, database_name,
        sql_text, status, duration_ms, row_count, error_message, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        entry.username ?? null,
        instanceId,
        entry.details?.instanceName ?? null,
        entry.details?.dbType ?? null,
        entry.details?.database ?? null,
        entry.details?.sql ? String(entry.details.sql).substring(0, 5000) : null,
        entry.result === 'failure' ? 'error' : entry.result === 'success' ? 'success' : 'success',
        entry.details?.durationMs ?? 0,
        entry.details?.rowCount ?? 0,
        entry.details?.errorMessage ?? null,
        entry.clientIp ?? null,
      ]
    );
  }

  async query(filter: AuditLogQuery): Promise<{ entries: AuditLogEntry[]; total: number }> {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filter.userId) {
      const uid = Number.isNaN(parseInt(filter.userId, 10)) ? null : parseInt(filter.userId, 10);
      if (uid !== null) {
        conditions.push('h.user_id = ?');
        params.push(uid);
      }
    }
    if (filter.resourceId) {
      conditions.push('h.instance_id = ?');
      params.push(Number(filter.resourceId));
    }
    if (filter.startTime) {
      conditions.push('h.created_at >= FROM_UNIXTIME(?)');
      params.push(Math.floor(filter.startTime / 1000));
    }
    if (filter.endTime) {
      conditions.push('h.created_at <= FROM_UNIXTIME(?)');
      params.push(Math.floor(filter.endTime / 1000));
    }
    if (filter.search) {
      conditions.push('h.sql_text LIKE ?');
      params.push(`%${filter.search}%`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [countRows] = await this.pool.query(
      `SELECT COUNT(*) as total FROM sql_execution_history h ${where}`,
      params
    ) as any;
    const total = Number(countRows[0]?.total ?? 0);

    const limit = Math.min(filter.limit ?? 50, 200);
    const offset = filter.offset ?? 0;

    const [rows] = await this.pool.query(
      `SELECT h.* FROM sql_execution_history h ${where} ORDER BY h.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    ) as any;

    const entries: AuditLogEntry[] = (rows as any[]).map((row: any) => {
      let timestamp: number;
      if (row.created_at instanceof Date) {
        timestamp = row.created_at.getTime();
      } else if (typeof row.created_at === 'string') {
        timestamp = new Date(row.created_at).getTime();
      } else if (typeof row.created_at === 'number') {
        timestamp = row.created_at;
      } else {
        timestamp = Date.now();
      }

      return {
        id: String(row.id),
        timestamp,
        eventType: 'sql_execution' as const,
        level: row.status === 'error' ? 'error' as const : 'info' as const,
        userId: row.user_id != null ? String(row.user_id) : undefined,
        username: row.username || undefined,
        action: 'sql_execute',
        resourceType: 'database',
        resourceId: row.instance_id != null ? String(row.instance_id) : undefined,
        clientIp: row.ip_address || undefined,
        result: row.status === 'error' ? 'failure' as const : 'success' as const,
        errorMessage: row.error_message || undefined,
        details: {
          instanceName: row.instance_name,
          dbType: row.db_type,
          database: row.database_name,
          sql: row.sql_text,
          durationMs: row.duration_ms,
          rowCount: row.row_count,
          errorMessage: row.error_message,
        },
      };
    });

    return { entries, total };
  }

  async export(params: AuditLogQuery): Promise<string> {
    const result = await this.query({ ...params, limit: 10000, offset: 0 });
    return JSON.stringify(result.entries, null, 2);
  }
}

// ============== 审计日志管理器 ==============

/**
 * 审计日志管理器
 */
export class AuditLogManager implements AuditLogHandler {
  private handler: AuditLogHandler;
  private persistentStore?: AuditLogHandler;
  private events = new EventEmitter();

  constructor(handler: AuditLogHandler, persistentStore?: AuditLogHandler) {
    this.handler = handler;
    this.persistentStore = persistentStore;
  }

  /**
   * 记录工具调用
   */
  async logToolCall(params: {
    userId?: string;
    username?: string;
    userRole?: SystemRole;
    toolName: string;
    toolParams?: Record<string, unknown>;
    result?: 'success' | 'failure' | 'pending';
    errorMessage?: string;
    clientIp?: string;
  }): Promise<void> {
    const entry: AuditLogEntry = {
      id: this.generateId(),
      eventType: 'tool_call',
      level: this.determineLevel('tool_call', params.result),
      userId: params.userId,
      username: params.username,
      userRole: params.userRole,
      action: params.toolName,
      resourceType: 'tool',
      details: params.toolParams,
      result: params.result ?? 'success',
      errorMessage: params.errorMessage,
      clientIp: params.clientIp,
      timestamp: Date.now(),
    };

    await this.handler.write(entry);
    this.events.emit('log:tool_call', entry);
  }

  /**
   * 记录审批请求
   */
  async logApprovalRequest(request: ApprovalRequest): Promise<void> {
    const entry: AuditLogEntry = {
      id: this.generateId(),
      eventType: 'approval_request',
      level: this.determineLevel('approval_request', 'pending'),
      userId: request.requesterId,
      userRole: request.requesterRole,
      action: request.operationName,
      resourceType: 'operation',
      details: request.operationParams,
      approvalRequestId: request.requestId,
      result: 'pending',
      timestamp: Date.now(),
    };

    await this.handler.write(entry);
    this.events.emit('log:approval_request', entry);
  }

  /**
   * 记录审批批准
   */
  async logApprovalApproved(request: ApprovalRequest, approverId: string, approverRole: SystemRole): Promise<void> {
    const entry: AuditLogEntry = {
      id: this.generateId(),
      eventType: 'approval_approved',
      level: 'info',
      userId: approverId,
      userRole: approverRole,
      action: request.operationName,
      resourceType: 'operation',
      details: {
        originalRequester: request.requesterId,
        approvalNote: request.approvalNote,
      },
      approvalRequestId: request.requestId,
      result: 'success',
      timestamp: Date.now(),
    };

    await this.handler.write(entry);
    this.events.emit('log:approval_approved', entry);
  }

  /**
   * 记录审批拒绝
   */
  async logApprovalRejected(request: ApprovalRequest, approverId: string, approverRole: SystemRole, reason: string): Promise<void> {
    const entry: AuditLogEntry = {
      id: this.generateId(),
      eventType: 'approval_rejected',
      level: 'warning',
      userId: approverId,
      userRole: approverRole,
      action: request.operationName,
      resourceType: 'operation',
      details: {
        originalRequester: request.requesterId,
        rejectionReason: reason,
      },
      approvalRequestId: request.requestId,
      result: 'failure',
      errorMessage: reason,
      timestamp: Date.now(),
    };

    await this.handler.write(entry);
    this.events.emit('log:approval_rejected', entry);
  }

  /**
   * 记录审批过期
   */
  async logApprovalExpired(request: ApprovalRequest): Promise<void> {
    const entry: AuditLogEntry = {
      id: this.generateId(),
      eventType: 'approval_expired',
      level: 'warning',
      userId: request.requesterId,
      userRole: request.requesterRole,
      action: request.operationName,
      resourceType: 'operation',
      details: request.operationParams,
      approvalRequestId: request.requestId,
      result: 'failure',
      errorMessage: '审批已过期',
      timestamp: Date.now(),
    };

    await this.handler.write(entry);
    this.events.emit('log:approval_expired', entry);
  }

  /**
   * 记录权限拒绝
   */
  async logPermissionDenied(params: {
    userId?: string;
    username?: string;
    userRole?: SystemRole;
    action: string;
    reason: string;
    clientIp?: string;
  }): Promise<void> {
    const entry: AuditLogEntry = {
      id: this.generateId(),
      eventType: 'permission_denied',
      level: 'warning',
      userId: params.userId,
      username: params.username,
      userRole: params.userRole,
      action: params.action,
      resourceType: 'permission',
      result: 'failure',
      errorMessage: params.reason,
      clientIp: params.clientIp,
      timestamp: Date.now(),
    };

    await this.handler.write(entry);
    this.events.emit('log:permission_denied', entry);
  }

  /**
   * 记录配置变更
   */
  async logConfigChange(params: {
    userId?: string;
    username?: string;
    userRole?: SystemRole;
    configKey: string;
    oldValue?: unknown;
    newValue: unknown;
    clientIp?: string;
  }): Promise<void> {
    const entry: AuditLogEntry = {
      id: this.generateId(),
      eventType: 'config_change',
      level: 'info',
      userId: params.userId,
      username: params.username,
      userRole: params.userRole,
      action: 'update_config',
      resourceType: 'config',
      resourceId: params.configKey,
      details: {
        oldValue: params.oldValue,
        newValue: params.newValue,
      },
      result: 'success',
      clientIp: params.clientIp,
      timestamp: Date.now(),
    };

    await this.handler.write(entry);
    this.events.emit('log:config_change', entry);
  }

  /**
   * 记录用户变更
   */
  async logUserChange(params: {
    userId?: string;
    username?: string;
    userRole?: SystemRole;
    targetUserId: string;
    action: string;
    details?: Record<string, unknown>;
    clientIp?: string;
  }): Promise<void> {
    const entry: AuditLogEntry = {
      id: this.generateId(),
      eventType: 'user_change',
      level: this.determineLevel('user_change', 'success'),
      userId: params.userId,
      username: params.username,
      userRole: params.userRole,
      action: params.action,
      resourceType: 'user',
      resourceId: params.targetUserId,
      details: params.details,
      result: 'success',
      clientIp: params.clientIp,
      timestamp: Date.now(),
    };

    await this.handler.write(entry);
    this.events.emit('log:user_change', entry);
  }

  /**
   * 记录实例变更
   */
  async logInstanceChange(params: {
    userId?: string;
    username?: string;
    userRole?: SystemRole;
    targetInstanceId: string;
    action: string;
    details?: Record<string, unknown>;
    clientIp?: string;
  }): Promise<void> {
    const entry: AuditLogEntry = {
      id: this.generateId(),
      eventType: 'instance_change',
      level: 'info',
      userId: params.userId,
      username: params.username,
      userRole: params.userRole,
      action: params.action,
      resourceType: 'instance',
      resourceId: params.targetInstanceId,
      details: params.details,
      result: 'success',
      clientIp: params.clientIp,
      timestamp: Date.now(),
    };

    await this.handler.write(entry);
    this.events.emit('log:instance_change', entry);
  }

  /**
   * 记录登录事件
   */
  async logLogin(params: {
    userId: string;
    username: string;
    userRole?: SystemRole;
    success: boolean;
    errorMessage?: string;
    clientIp?: string;
    userAgent?: string;
  }): Promise<void> {
    const entry: AuditLogEntry = {
      id: this.generateId(),
      eventType: 'login',
      level: params.success ? 'info' : 'warning',
      userId: params.userId,
      username: params.username,
      userRole: params.userRole,
      action: params.success ? 'login_success' : 'login_failed',
      result: params.success ? 'success' : 'failure',
      errorMessage: params.errorMessage,
      clientIp: params.clientIp,
      userAgent: params.userAgent,
      timestamp: Date.now(),
    };

    await this.handler.write(entry);
    this.events.emit('log:login', entry);
  }

  /**
   * 记录登出事件
   */
  async logLogout(params: {
    userId: string;
    username: string;
    clientIp?: string;
  }): Promise<void> {
    const entry: AuditLogEntry = {
      id: this.generateId(),
      eventType: 'logout',
      level: 'info',
      userId: params.userId,
      username: params.username,
      action: 'logout',
      result: 'success',
      clientIp: params.clientIp,
      timestamp: Date.now(),
    };

    await this.handler.write(entry);
    this.events.emit('log:logout', entry);
  }

  /**
   * 查询审计日志
   */
  async query(params: AuditLogQuery): Promise<{ entries: AuditLogEntry[]; total: number }> {
    if (this.persistentStore) {
      return await this.persistentStore.query(params);
    }
    return await this.handler.query(params);
  }

  /**
   * 导出审计日志
   */
  async export(params: AuditLogQuery): Promise<string> {
    if (this.persistentStore) {
      return await this.persistentStore.export(params);
    }
    return await this.handler.export(params);
  }

  /**
   * 注册事件监听
   */
  on(event: string, handler: (...args: any[]) => void): void {
    this.events.on(event, handler);
  }

  /**
   * 根据事件类型和结果确定审计级别
   */
  private determineLevel(eventType: AuditEventType, result?: string): AuditLevel {
    if (result === 'failure') {
      return 'warning';
    }

    switch (eventType) {
      case 'permission_denied':
        return 'warning';
      case 'approval_rejected':
        return 'warning';
      case 'approval_expired':
        return 'warning';
      case 'tool_call':
        return result === 'failure' ? 'error' : 'info';
      default:
        return 'info';
    }
  }

  /**
   * 记录 SQL 执行审计
   */
  async logSqlExecution(params: {
    userId: string;
    username: string;
    instanceId: number;
    instanceName: string;
    dbType: string;
    sqlText: string;
    durationMs: number;
    status: 'success' | 'error';
    rowCount?: number;
    errorMessage?: string;
    ipAddress?: string;
  }): Promise<void> {
    const entry: AuditLogEntry = {
      id: this.generateId(),
      eventType: 'sql_execution',
      level: params.status === 'error' ? 'error' : 'info',
      userId: params.userId,
      username: params.username,
      action: 'sql_execute',
      resourceType: 'database',
      resourceId: String(params.instanceId),
      details: {
        instanceName: params.instanceName,
        dbType: params.dbType,
        sql: params.sqlText,
        durationMs: params.durationMs,
        rowCount: params.rowCount,
        errorMessage: params.errorMessage,
      },
      clientIp: params.ipAddress,
      timestamp: Date.now(),
      result: params.status === 'success' ? 'success' : 'failure',
    };
    await this.handler.write(entry);
    // 双写：同时持久化到数据库
    if (this.persistentStore) {
      await this.persistentStore.write(entry).catch(err => {
        console.error('[AuditLogManager] 持久化 SQL 历史失败:', err);
      });
    }
  }

  /**
   * 设置持久化存储（用于双写模式，在 server 初始化后注入）
   */
  setPersistentStore(store: AuditLogHandler): void {
    this.persistentStore = store;
  }

  /**
   * 生成日志 ID
   */
  private generateId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `audit_${timestamp}_${random}`;
  }
}

// ============== 全局实例 ==============

export const memoryAuditLogStore = new MemoryAuditLogStore();
export const auditLogManager = new AuditLogManager(memoryAuditLogStore);

// ============== 辅助函数 ==============

/**
 * 记录工具调用审计日志
 */
export async function auditToolCall(params: {
  userId?: string;
  username?: string;
  userRole?: SystemRole;
  toolName: string;
  toolParams?: Record<string, unknown>;
  result?: 'success' | 'failure' | 'pending';
  errorMessage?: string;
  clientIp?: string;
}): Promise<void> {
  await auditLogManager.logToolCall(params);
}

/**
 * 记录权限拒绝审计日志
 */
export async function auditPermissionDenied(params: {
  userId?: string;
  username?: string;
  userRole?: SystemRole;
  action: string;
  reason: string;
  clientIp?: string;
}): Promise<void> {
  await auditLogManager.logPermissionDenied(params);
}

/**
 * 查询审计日志
 */
export async function queryAuditLogs(params: AuditLogQuery): Promise<{ entries: AuditLogEntry[]; total: number }> {
  return await auditLogManager.query(params);
}

/**
 * 导出审计日志
 */
export async function exportAuditLogs(params: AuditLogQuery): Promise<string> {
  return await auditLogManager.export(params);
}
