/**
 * Chat 会话数据库服务
 */

import { dbConnection } from './db-connection.js';
import { RowDataPacket, ResultSetHeader } from 'mysql2/promise';

export interface ChatSessionRecord {
  id: number;
  session_id: string;
  user_id: number | null;
  title: string;
  instance_id: number | null;
  message_count: number;
  last_message_at: Date | null;
  metadata: string | null;
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
  metadata: string | null;
  created_at: Date;
}

class ChatDatabaseService {
  private pool: any = null;

  private getPool() {
    if (!this.pool) {
      this.pool = dbConnection.getPool();
    }
    return this.pool;
  }

  /**
   * 创建会话
   */
  async createSession(
    sessionId: string,
    userId: number | null,
    title: string,
    instanceId?: number | null
  ): Promise<ChatSessionRecord> {
    const pool = this.getPool();
    const sql = `
      INSERT INTO chat_sessions (session_id, user_id, title, instance_id, message_count, last_message_at)
      VALUES (?, ?, ?, ?, 0, NOW())
    `;
    const [result] = await pool.query<ResultSetHeader>(sql, [
      sessionId,
      userId,
      title,
      instanceId || null,
    ]);

    return this.getSessionById(result.insertId);
  }

  /**
   * 获取会话列表
   */
  async getSessions(
    userId: number | null,
    limit: number = 20
  ): Promise<ChatSessionRecord[]> {
    const pool = this.getPool();
    // 查询所有会话（不限制 user_id）
    const sql = `SELECT * FROM chat_sessions ORDER BY last_message_at DESC, created_at DESC LIMIT ?`;
    const [rows] = await pool.query<RowDataPacket[]>(sql, [limit]);
    return rows.map(this.mapSessionRow);
  }

  /**
   * 获取单个会话
   */
  async getSessionById(id: number): Promise<ChatSessionRecord | null> {
    const pool = this.getPool();
    const sql = 'SELECT * FROM chat_sessions WHERE id = ?';
    const [rows] = await pool.query<RowDataPacket[]>(sql, [id]);
    if (rows.length === 0) return null;
    return this.mapSessionRow(rows[0]);
  }

  /**
   * 根据 session_id 获取会话
   */
  async getSessionBySessionId(sessionId: string): Promise<ChatSessionRecord | null> {
    const pool = this.getPool();
    const sql = 'SELECT * FROM chat_sessions WHERE session_id = ?';
    const [rows] = await pool.query<RowDataPacket[]>(sql, [sessionId]);
    if (rows.length === 0) return null;
    return this.mapSessionRow(rows[0]);
  }

  /**
   * 获取会话消息列表
   */
  async getMessages(sessionId: string, limit: number = 200): Promise<ChatMessageRecord[]> {
    const pool = this.getPool();
    const sql = `
      SELECT * FROM (
        SELECT * FROM chat_messages
        WHERE session_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      ) AS recent ORDER BY created_at ASC
    `;
    const [rows] = await pool.query<RowDataPacket[]>(sql, [sessionId, limit]);
    return rows.map(this.mapMessageRow);
  }

  /**
   * 获取消息及其父消息（消息链查询）
   * 用于构建消息 threading 视图
   */
  async getMessageWithParents(
    messageId: string,
    sessionId: string,
    maxDepth: number = 10
  ): Promise<ChatMessageRecord[]> {
    const pool = this.getPool();
    const messages: ChatMessageRecord[] = [];
    let currentParentId: string | null = messageId;
    let depth = 0;

    // 向上追溯父消息
    while (currentParentId && depth < maxDepth) {
      const sql = `
        SELECT * FROM chat_messages
        WHERE message_id = ? AND session_id = ?
      `;
      const [rows] = await pool.query<RowDataPacket[]>(sql, [currentParentId, sessionId]);
      if (rows.length === 0) break;

      const message = this.mapMessageRow(rows[0]);
      messages.unshift(message); // 添加到开头
      currentParentId = message.parent_id;
      depth++;
    }

    return messages;
  }

  /**
   * 获取消息的子消息（回复链）
   */
  async getMessageChildren(
    parentId: string,
    sessionId: string
  ): Promise<ChatMessageRecord[]> {
    const pool = this.getPool();
    const sql = `
      SELECT * FROM chat_messages
      WHERE parent_id = ? AND session_id = ?
      ORDER BY created_at ASC
    `;
    const [rows] = await pool.query<RowDataPacket[]>(sql, [parentId, sessionId]);
    return rows.map(this.mapMessageRow);
  }

  /**
   * 获取消息树（递归查询所有子孙消息）
   */
  async getMessageTree(
    rootMessageId: string,
    sessionId: string,
    maxDepth: number = 20
  ): Promise<ChatMessageRecord[]> {
    const pool = this.getPool();
    const allMessages: ChatMessageRecord[] = [];
    const queue: Array<{ messageId: string; depth: number }> = [
      { messageId: rootMessageId, depth: 0 }
    ];

    while (queue.length > 0) {
      const { messageId, depth } = queue.shift()!;
      if (depth >= maxDepth) continue;

      const children = await this.getMessageChildren(messageId, sessionId);
      for (const child of children) {
        allMessages.push(child);
        queue.push({ messageId: child.message_id, depth: depth + 1 });
      }
    }

    return allMessages;
  }

  /**
   * 添加消息到会话
   */
  async addMessage(
    sessionId: string,
    messageId: string,
    role: 'user' | 'assistant' | 'system',
    content: string,
    relatedTool?: string | null,
    relatedSkill?: string | null,
    metadata?: Record<string, unknown> | null,
    parentId?: string | null
  ): Promise<void> {
    const pool = this.getPool();
    const sql = `
      INSERT INTO chat_messages (session_id, message_id, parent_id, role, content, related_tool, related_skill, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    await pool.query(sql, [
      sessionId,
      messageId,
      parentId || null,
      role,
      content,
      relatedTool || null,
      relatedSkill || null,
      metadata ? JSON.stringify(metadata) : null,
    ]);

    // 更新会话的消息计数和最后消息时间
    await this.updateSessionStats(pool, sessionId);
  }

  /**
   * 更新会话统计
   */
  private async updateSessionStats(pool: any, sessionId: string): Promise<void> {
    const sql = `
      UPDATE chat_sessions
      SET message_count = (
        SELECT COUNT(*) FROM chat_messages WHERE session_id = ?
      ),
      last_message_at = (
        SELECT MAX(created_at) FROM chat_messages WHERE session_id = ?
      )
      WHERE session_id = ?
    `;
    await pool.query(sql, [sessionId, sessionId, sessionId]);
  }

  /**
   * 删除会话
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    const pool = this.getPool();
    const [result] = await pool.query<ResultSetHeader>(
      'DELETE FROM chat_sessions WHERE session_id = ?',
      [sessionId]
    );
    // 同时删除相关消息
    await pool.query('DELETE FROM chat_messages WHERE session_id = ?', [sessionId]);
    return result.affectedRows > 0;
  }

  /**
   * 更新会话标题
   */
  async updateSessionTitle(sessionId: string, title: string): Promise<boolean> {
    const pool = this.getPool();
    const sql = 'UPDATE chat_sessions SET title = ? WHERE session_id = ?';
    const [result] = await pool.query<ResultSetHeader>(sql, [title, sessionId]);
    return result.affectedRows > 0;
  }

  /**
   * 映射会话行
   */
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

  /**
   * 映射消息行
   */
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

// 导出单例
export const chatDatabaseService = new ChatDatabaseService();
