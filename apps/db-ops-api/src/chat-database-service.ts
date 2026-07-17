/**
 * Actor-scoped chat persistence and sharing boundary.
 */

import { randomUUID } from 'node:crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { dbConnection } from './db-connection.js';
import type { ActorContext } from './auth/actor-context.js';

export type ChatAction =
  | 'read'
  | 'history'
  | 'watch'
  | 'append'
  | 'patch'
  | 'delete'
  | 'cap'
  | 'share';

export type ChatSharePermission = 'read';

export class ChatSessionNotFoundError extends Error {
  constructor() {
    super('Chat session not found');
    this.name = 'ChatSessionNotFoundError';
  }
}

export interface ChatSessionRecord {
  id: number;
  session_id: string;
  user_id: number;
  title: string;
  instance_id: number | null;
  message_count: number;
  last_message_at: Date | null;
  metadata: string | Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export interface ChatMessageRecord {
  id: number;
  message_id: string;
  parent_id: string | null;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  related_tool: string | null;
  related_skill: string | null;
  metadata: string | Record<string, unknown> | null;
  created_at: Date;
}

export interface NewChatMessage {
  messageId: string;
  role: ChatMessageRecord['role'];
  content: string;
  relatedTool?: string | null;
  relatedSkill?: string | null;
  metadata?: Record<string, unknown> | null;
  parentId?: string | null;
}

interface QueryExecutor {
  query<T = any>(sql: string, values?: unknown[]): Promise<[T, unknown?]>;
}

interface TransactionConnection extends QueryExecutor {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

interface ChatPool extends QueryExecutor {
  getConnection?(): Promise<TransactionConnection>;
}

const READ_ACTIONS = new Set<ChatAction>(['read', 'history', 'watch']);

export class ChatDatabaseService {
  private pool: ChatPool | null = null;

  constructor(
    private readonly poolProvider: () => ChatPool | null = () => dbConnection.getPool() as ChatPool | null,
  ) {}

  private getPool(): ChatPool {
    if (!this.pool) this.pool = this.poolProvider();
    if (!this.pool) throw new Error('Chat database is unavailable');
    return this.pool;
  }

  private accessPredicate(action: ChatAction, sessionAlias = 'cs'): string {
    if (!READ_ACTIONS.has(action)) return `${sessionAlias}.user_id = ?`;
    return `(${sessionAlias}.user_id = ? OR EXISTS (
      SELECT 1 FROM chat_session_shares chat_share
      WHERE chat_share.session_id = ${sessionAlias}.session_id
        AND chat_share.recipient_user_id = ?
        AND chat_share.permission = 'read'
    ))`;
  }

  private accessValues(actor: ActorContext, action: ChatAction): number[] {
    return READ_ACTIONS.has(action) ? [actor.userId, actor.userId] : [actor.userId];
  }

  async authorizeSession(
    actor: ActorContext,
    sessionId: string,
    action: ChatAction,
    executor: QueryExecutor = this.getPool(),
    lock = false,
  ): Promise<ChatSessionRecord> {
    const [rows] = await executor.query<RowDataPacket[]>(
      `SELECT cs.* FROM chat_sessions cs
       WHERE cs.session_id = ?
         AND ${this.accessPredicate(action)}
       ${lock ? 'FOR UPDATE' : ''}`,
      [sessionId, ...this.accessValues(actor, action)],
    );
    if (!rows[0]) throw new ChatSessionNotFoundError();
    return this.mapSessionRow(rows[0]);
  }

  async createSession(
    actor: ActorContext,
    input: { title?: string; instanceId?: number | null } = {},
  ): Promise<ChatSessionRecord> {
    const pool = this.getPool();
    const sessionId = randomUUID();
    const title = input.title?.trim() || '新会话';
    const instanceId = input.instanceId ?? null;
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO chat_sessions
         (session_id, user_id, title, instance_id, message_count, last_message_at)
       VALUES (?, ?, ?, ?, 0, NOW())`,
      [sessionId, actor.userId, title, instanceId],
    );
    const now = new Date();
    return {
      id: result.insertId,
      session_id: sessionId,
      user_id: actor.userId,
      title,
      instance_id: instanceId,
      message_count: 0,
      last_message_at: now,
      metadata: null,
      created_at: now,
      updated_at: now,
    };
  }

  async getSessions(actor: ActorContext, limit = 20): Promise<ChatSessionRecord[]> {
    const [rows] = await this.getPool().query<RowDataPacket[]>(
      `SELECT cs.* FROM chat_sessions cs
       WHERE ${this.accessPredicate('read')}
       ORDER BY cs.last_message_at DESC, cs.created_at DESC
       LIMIT ?`,
      [...this.accessValues(actor, 'read'), limit],
    );
    return rows.map((row) => this.mapSessionRow(row));
  }

  async getSessionsForMaintenance(limit: number): Promise<ChatSessionRecord[]> {
    const [rows] = await this.getPool().query<RowDataPacket[]>(
      `SELECT cs.* FROM chat_sessions cs
       ORDER BY cs.last_message_at DESC, cs.created_at DESC
       LIMIT ?`,
      [limit],
    );
    return rows.map((row) => this.mapSessionRow(row));
  }

  async getSession(actor: ActorContext, sessionId: string): Promise<ChatSessionRecord> {
    return this.authorizeSession(actor, sessionId, 'read');
  }

  async getSessionMetadata(actor: ActorContext, sessionId: string): Promise<Record<string, unknown> | null> {
    const session = await this.authorizeSession(actor, sessionId, 'read');
    if (!session.metadata) return null;
    return typeof session.metadata === 'string'
      ? JSON.parse(session.metadata) as Record<string, unknown>
      : session.metadata;
  }

  async getMessages(
    actor: ActorContext,
    sessionId: string,
    limit = 200,
  ): Promise<ChatMessageRecord[]> {
    const [rows] = await this.getPool().query<RowDataPacket[]>(
      `SELECT cm.*, cs.id AS authorized_session_id
       FROM chat_sessions cs
       LEFT JOIN chat_messages cm ON cm.session_id = cs.session_id
       WHERE cs.session_id = ?
         AND ${this.accessPredicate('history')}
       ORDER BY cm.created_at DESC
       LIMIT ?`,
      [sessionId, ...this.accessValues(actor, 'history'), limit],
    );
    if (!rows[0]) throw new ChatSessionNotFoundError();
    return rows
      .filter((row) => row.id !== null && row.message_id !== null)
      .reverse()
      .map((row) => this.mapMessageRow(row));
  }

  async getMessageWithParents(
    actor: ActorContext,
    messageId: string,
    sessionId: string,
    maxDepth = 10,
  ): Promise<ChatMessageRecord[]> {
    await this.authorizeSession(actor, sessionId, 'history');
    const messages: ChatMessageRecord[] = [];
    let currentParentId: string | null = messageId;
    for (let depth = 0; currentParentId && depth < maxDepth; depth += 1) {
      const [rows] = await this.getPool().query<RowDataPacket[]>(
        `SELECT cm.* FROM chat_messages cm
         JOIN chat_sessions cs ON cs.session_id = cm.session_id
         WHERE cm.message_id = ? AND cm.session_id = ?
           AND ${this.accessPredicate('history')}`,
        [currentParentId, sessionId, ...this.accessValues(actor, 'history')],
      );
      if (!rows[0]) break;
      const message = this.mapMessageRow(rows[0]);
      messages.unshift(message);
      currentParentId = message.parent_id;
    }
    return messages;
  }

  async getMessageChildren(
    actor: ActorContext,
    parentId: string,
    sessionId: string,
  ): Promise<ChatMessageRecord[]> {
    const [rows] = await this.getPool().query<RowDataPacket[]>(
      `SELECT cm.* FROM chat_messages cm
       JOIN chat_sessions cs ON cs.session_id = cm.session_id
       WHERE cm.parent_id = ? AND cm.session_id = ?
         AND ${this.accessPredicate('history')}
       ORDER BY cm.created_at ASC`,
      [parentId, sessionId, ...this.accessValues(actor, 'history')],
    );
    return rows.map((row) => this.mapMessageRow(row));
  }

  async addMessage(actor: ActorContext, sessionId: string, message: NewChatMessage): Promise<void> {
    const [result] = await this.getPool().query<ResultSetHeader>(
      `INSERT INTO chat_messages
         (session_id, message_id, parent_id, role, content, related_tool, related_skill, metadata)
       SELECT cs.session_id, ?, ?, ?, ?, ?, ?, ?
       FROM chat_sessions cs
       WHERE cs.session_id = ? AND ${this.accessPredicate('append')}`,
      [
        message.messageId,
        message.parentId ?? null,
        message.role,
        message.content,
        message.relatedTool ?? null,
        message.relatedSkill ?? null,
        message.metadata ? JSON.stringify(message.metadata) : null,
        sessionId,
        ...this.accessValues(actor, 'append'),
      ],
    );
    if (result.affectedRows !== 1) throw new ChatSessionNotFoundError();
    await this.updateSessionStats(this.getPool(), sessionId, actor.userId);
  }

  async addMessageForMaintenance(sessionId: string, message: NewChatMessage): Promise<void> {
    const [result] = await this.getPool().query<ResultSetHeader>(
      `INSERT INTO chat_messages
         (session_id, message_id, parent_id, role, content, related_tool, related_skill, metadata)
       SELECT cs.session_id, ?, ?, ?, ?, ?, ?, ?
       FROM chat_sessions cs WHERE cs.session_id = ?`,
      [
        message.messageId,
        message.parentId ?? null,
        message.role,
        message.content,
        message.relatedTool ?? null,
        message.relatedSkill ?? null,
        message.metadata ? JSON.stringify(message.metadata) : null,
        sessionId,
      ],
    );
    if (result.affectedRows !== 1) throw new ChatSessionNotFoundError();
    await this.updateSessionStats(this.getPool(), sessionId);
  }

  private async updateSessionStats(
    executor: QueryExecutor,
    sessionId: string,
    ownerId?: number,
  ): Promise<void> {
    const ownerClause = ownerId === undefined ? '' : ' AND user_id = ?';
    await executor.query(
      `UPDATE chat_sessions
       SET message_count = (SELECT COUNT(*) FROM chat_messages WHERE session_id = ?),
           last_message_at = (SELECT MAX(created_at) FROM chat_messages WHERE session_id = ?)
       WHERE session_id = ?${ownerClause}`,
      ownerId === undefined
        ? [sessionId, sessionId, sessionId]
        : [sessionId, sessionId, sessionId, ownerId],
    );
  }

  async updateSessionSettings(
    actor: ActorContext,
    sessionId: string,
    settings: { model?: string | null; thinkingLevel?: string | null },
  ): Promise<boolean> {
    const assignments: string[] = [];
    const values: unknown[] = [];
    if (settings.model !== undefined) {
      assignments.push("'$.model', ?");
      values.push(settings.model || null);
    }
    if (settings.thinkingLevel !== undefined) {
      assignments.push("'$.thinkingLevel', ?");
      values.push(settings.thinkingLevel || null);
    }
    if (assignments.length === 0) return true;
    const [result] = await this.getPool().query<ResultSetHeader>(
      `UPDATE chat_sessions cs
       SET cs.metadata = JSON_SET(COALESCE(cs.metadata, JSON_OBJECT()), ${assignments.join(', ')})
       WHERE cs.session_id = ? AND ${this.accessPredicate('patch')}`,
      [...values, sessionId, ...this.accessValues(actor, 'patch')],
    );
    if (result.affectedRows !== 1) throw new ChatSessionNotFoundError();
    return true;
  }

  async updateSessionTitle(actor: ActorContext, sessionId: string, title: string): Promise<boolean> {
    const [result] = await this.getPool().query<ResultSetHeader>(
      `UPDATE chat_sessions cs SET cs.title = ?
       WHERE cs.session_id = ? AND ${this.accessPredicate('patch')}`,
      [title, sessionId, ...this.accessValues(actor, 'patch')],
    );
    if (result.affectedRows !== 1) throw new ChatSessionNotFoundError();
    return true;
  }

  async updateSessionStatus(actor: ActorContext, sessionId: string, status: string): Promise<boolean> {
    const [result] = await this.getPool().query<ResultSetHeader>(
      `UPDATE chat_sessions cs
       SET cs.metadata = JSON_SET(COALESCE(cs.metadata, JSON_OBJECT()), '$.status', ?)
       WHERE cs.session_id = ? AND ${this.accessPredicate('patch')}`,
      [status, sessionId, ...this.accessValues(actor, 'patch')],
    );
    if (result.affectedRows !== 1) throw new ChatSessionNotFoundError();
    return true;
  }

  async grantSessionShare(
    actor: ActorContext,
    sessionId: string,
    recipientUserId: number,
    permission: ChatSharePermission,
  ): Promise<void> {
    const [result] = await this.getPool().query<ResultSetHeader>(
      `INSERT INTO chat_session_shares
         (session_id, granted_by, recipient_user_id, permission, created_at)
       SELECT ?, ?, ?, ?, NOW()
       FROM chat_sessions cs
       WHERE cs.session_id = ? AND ${this.accessPredicate('share')}
       ON DUPLICATE KEY UPDATE
         granted_by = VALUES(granted_by), permission = VALUES(permission)`,
      [sessionId, actor.userId, recipientUserId, permission, sessionId, ...this.accessValues(actor, 'share')],
    );
    if (result.affectedRows < 1) throw new ChatSessionNotFoundError();
  }

  async deleteSession(actor: ActorContext, sessionId: string): Promise<boolean> {
    const pool = this.getPool();
    if (!pool.getConnection) throw new Error('Chat transaction support is unavailable');
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await this.authorizeSession(actor, sessionId, 'delete', connection, true);
      await connection.query(
        `DELETE cm FROM chat_messages cm
         JOIN chat_sessions cs ON cs.session_id = cm.session_id
         WHERE cs.session_id = ? AND ${this.accessPredicate('delete')}`,
        [sessionId, ...this.accessValues(actor, 'delete')],
      );
      const [result] = await connection.query<ResultSetHeader>(
        `DELETE cs FROM chat_sessions cs
         WHERE cs.session_id = ? AND ${this.accessPredicate('delete')}`,
        [sessionId, ...this.accessValues(actor, 'delete')],
      );
      if (result.affectedRows !== 1) throw new ChatSessionNotFoundError();
      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async getSessionCount(actor: ActorContext, sessionId: string): Promise<number> {
    const [rows] = await this.getPool().query<RowDataPacket[]>(
      `SELECT COUNT(cm.id) AS cnt
       FROM chat_sessions cs
       LEFT JOIN chat_messages cm ON cm.session_id = cs.session_id
       WHERE cs.session_id = ? AND ${this.accessPredicate('read')}
       GROUP BY cs.id`,
      [sessionId, ...this.accessValues(actor, 'read')],
    );
    if (!rows[0]) throw new ChatSessionNotFoundError();
    return Number(rows[0].cnt || 0);
  }

  async enforceMessageCap(
    actor: ActorContext,
    sessionId: string,
    maxMessages: number,
  ): Promise<number> {
    return this.capMessagesInTransaction(actor, sessionId, maxMessages);
  }

  async enforceMessageCapForMaintenance(sessionId: string, maxMessages: number): Promise<number> {
    return this.capMessagesInTransaction(null, sessionId, maxMessages);
  }

  private async capMessagesInTransaction(
    actor: ActorContext | null,
    sessionId: string,
    maxMessages: number,
  ): Promise<number> {
    if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 10_000) {
      throw new TypeError('maxMessages must be a positive integer up to 10000');
    }
    const pool = this.getPool();
    if (!pool.getConnection) throw new Error('Chat transaction support is unavailable');
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      if (actor) {
        await this.authorizeSession(actor, sessionId, 'cap', connection, true);
      } else {
        const [rows] = await connection.query<RowDataPacket[]>(
          'SELECT id FROM chat_sessions WHERE session_id = ? FOR UPDATE',
          [sessionId],
        );
        if (!rows[0]) throw new ChatSessionNotFoundError();
      }

      const [countRows] = await connection.query<RowDataPacket[]>(
        'SELECT COUNT(*) AS cnt FROM chat_messages WHERE session_id = ?',
        [sessionId],
      );
      if (Number(countRows[0]?.cnt || 0) <= maxMessages) {
        await connection.commit();
        return 0;
      }

      const [result] = await connection.query<ResultSetHeader>(
        `DELETE FROM chat_messages
         WHERE session_id = ? AND id NOT IN (
           SELECT id FROM (
             SELECT id FROM chat_messages
             WHERE session_id = ?
             ORDER BY created_at DESC, id DESC
             LIMIT ?
           ) AS retained_messages
         )`,
        [sessionId, sessionId, maxMessages],
      );
      await this.updateSessionStats(connection, sessionId, actor?.userId);
      await connection.commit();
      return result.affectedRows || 0;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async deleteOldSessionsForMaintenance(retentionDays: number): Promise<number> {
    const pool = this.getPool();
    const [result] = await pool.query<ResultSetHeader>(
      `DELETE FROM chat_sessions
       WHERE last_message_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [retentionDays],
    );
    await pool.query(
      'DELETE FROM chat_messages WHERE session_id NOT IN (SELECT session_id FROM chat_sessions)',
    );
    return result.affectedRows || 0;
  }

  private mapSessionRow(row: RowDataPacket): ChatSessionRecord {
    return {
      id: row.id,
      session_id: row.session_id,
      user_id: row.user_id,
      title: row.title,
      instance_id: row.instance_id,
      message_count: row.message_count,
      last_message_at: row.last_message_at,
      metadata: row.metadata,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private mapMessageRow(row: RowDataPacket): ChatMessageRecord {
    return {
      id: row.id,
      message_id: row.message_id,
      parent_id: row.parent_id || null,
      session_id: row.session_id,
      role: row.role,
      content: row.content,
      related_tool: row.related_tool,
      related_skill: row.related_skill,
      metadata: row.metadata,
      created_at: row.created_at,
    };
  }
}

export const chatDatabaseService = new ChatDatabaseService();
