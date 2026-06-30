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
   * 获取会话元数据（model、thinkingLevel 等）
   */
  async getSessionMetadata(sessionKey: string): Promise<Record<string, unknown> | null> {
    const pool = this.getPool();
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT metadata FROM chat_sessions WHERE session_id = ?',
      [sessionKey],
    );
    if (rows.length === 0) return null;
    return (rows[0].metadata as Record<string, unknown>) ?? null;
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
   * 删除过期会话（超过保留天数的）
   */
  async deleteOldSessions(retentionDays: number): Promise<number> {
    try {
      const pool = this.getPool();
      // 先统计要删除的会话数
      const [countRows] = await pool.query<RowDataPacket[]>(
        'SELECT COUNT(*) as cnt FROM chat_sessions WHERE last_message_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
        [retentionDays],
      );
      const sessionCount = countRows[0]?.cnt ?? 0;

      // 删除过期会话的消息
      await pool.query(
        'DELETE FROM chat_messages WHERE session_id IN (SELECT session_id FROM chat_sessions WHERE last_message_at < DATE_SUB(NOW(), INTERVAL ? DAY))',
        [retentionDays],
      );

      // 删除过期会话
      const [result] = await pool.query<ResultSetHeader>(
        'DELETE FROM chat_sessions WHERE last_message_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
        [retentionDays],
      );

      // 清理孤立消息（session 已不存在但消息还在的）
      await pool.query(
        'DELETE FROM chat_messages WHERE session_id NOT IN (SELECT session_id FROM chat_sessions)',
      );

      return result.affectedRows ?? sessionCount;
    } catch (error) {
      console.error('[ChatDatabaseService] deleteOldSessions error:', error);
      throw error;
    }
  }

  /**
   * 获取会话的消息数量
   */
  async getSessionCount(sessionId: string): Promise<number> {
    try {
      const pool = this.getPool();
      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT COUNT(*) as cnt FROM chat_messages WHERE session_id = ?',
        [sessionId],
      );
      return rows[0]?.cnt ?? 0;
    } catch (error) {
      console.error('[ChatDatabaseService] getSessionCount error:', error);
      return 0;
    }
  }

  /**
   * 更新会话状态（存储在 metadata JSON 中）
   */
  async updateSessionStatus(sessionId: string, status: string): Promise<boolean> {
    try {
      const pool = this.getPool();
      const sql = `UPDATE chat_sessions SET metadata = JSON_SET(COALESCE(metadata, '{}'), '$.status', ?) WHERE session_id = ?`;
      const [result] = await pool.query<ResultSetHeader>(sql, [status, sessionId]);
      return result.affectedRows > 0;
    } catch (error) {
      console.error('[ChatDatabaseService] updateSessionStatus error:', error);
      return false;
    }
  }

  /**
   * 强制限制会话的消息数量（保留最近的消息，不拆分 tool_call/tool_result 对）
   */
  async enforceMessageCap(sessionId: string, maxMessages: number): Promise<number> {
    try {
      const pool = this.getPool();

      // 获取总消息数
      const [countRows] = await pool.query<RowDataPacket[]>(
        'SELECT COUNT(*) as cnt FROM chat_messages WHERE session_id = ?',
        [sessionId],
      );
      const totalMessages = countRows[0]?.cnt ?? 0;

      if (totalMessages <= maxMessages) {
        return 0; // 不需要截断
      }

      // 找到安全的截断点：从最新的 user 消息开始，偏移 maxMessages 个 user 消息
      // 确保不会拆分 tool_call/tool_result 对
      const [cutoffRows] = await pool.query<RowDataPacket[]>(
        `SELECT created_at FROM chat_messages
         WHERE session_id = ? AND role = 'user'
         ORDER BY created_at DESC
         LIMIT 1 OFFSET ?`,
        [sessionId, Math.max(0, maxMessages - 1)],
      );

      if (cutoffRows.length === 0) {
        // 没有足够的 user 消息作为截断点，尝试按总消息数截断
        const [fallbackRows] = await pool.query<RowDataPacket[]>(
          `SELECT created_at FROM chat_messages
           WHERE session_id = ?
           ORDER BY created_at DESC
           LIMIT 1 OFFSET ?`,
          [sessionId, maxMessages - 1],
        );
        if (fallbackRows.length === 0) return 0;

        const cutoffTime = fallbackRows[0].created_at;
        const [deleteResult] = await pool.query<ResultSetHeader>(
          'DELETE FROM chat_messages WHERE session_id = ? AND created_at < ?',
          [sessionId, cutoffTime],
        );
        return deleteResult.affectedRows ?? 0;
      }

      const cutoffTime = cutoffRows[0].created_at;

      // 删除截断点之前的消息
      const [deleteResult] = await pool.query<ResultSetHeader>(
        'DELETE FROM chat_messages WHERE session_id = ? AND created_at < ?',
        [sessionId, cutoffTime],
      );

      // 更新会话统计
      await this.updateSessionStats(pool, sessionId);

      return deleteResult.affectedRows ?? 0;
    } catch (error) {
      console.error('[ChatDatabaseService] enforceMessageCap error:', error);
      return 0;
    }
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
   * 更新会话设置（model、thinkingLevel 等元数据）。
   * 如果会话尚不存在（新会话未发消息），自动创建占位行。
   */
  async updateSessionSettings(
    sessionKey: string,
    settings: { model?: string | null; thinkingLevel?: string | null },
  ): Promise<boolean> {
    const pool = this.getPool();
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT metadata FROM chat_sessions WHERE session_id = ?',
      [sessionKey],
    );

    const metadata: Record<string, unknown> = {};
    if (settings.model !== undefined) metadata.model = settings.model || null;
    if (settings.thinkingLevel !== undefined) metadata.thinkingLevel = settings.thinkingLevel || null;

    if (rows.length === 0) {
      // Session not in DB yet — create a placeholder row (no userId until first message)
      await pool.query(
        'INSERT INTO chat_sessions (session_id, user_id, title, message_count, metadata) VALUES (?, NULL, ?, 0, ?)',
        [sessionKey, '新会话', JSON.stringify(metadata)],
      );
      return true;
    }

    const current = (rows[0].metadata as Record<string, unknown>) ?? {};
    const updated: Record<string, unknown> = { ...current, ...metadata };
    const sql = 'UPDATE chat_sessions SET metadata = ? WHERE session_id = ?';
    const [result] = await pool.query<ResultSetHeader>(sql, [JSON.stringify(updated), sessionKey]);
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
