/**
 * SQL 审批服务
 * 高危 SQL 需 DBA 审批后才能执行，LLM 辅助风险评估
 */
import crypto from 'crypto';
import { dbConnection } from './db-connection';
import { llmService } from './llm-service';
import { sqlExecutor } from './sql-executor';
import { dispatchOrReuse } from './ai-agent-bridge.js';

interface ApprovalRequest {
  id: number;
  instance_id: number;
  sql_text: string;
  sql_hash: string;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  ai_recommendation: any;
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'cancelled';
  submitted_by: number | null;
  reviewed_by: number | null;
  review_notes: string | null;
  execution_result: any;
  target_database: string | null;
  created_at: string;
  updated_at: string;
}

const HIGH_RISK_PATTERNS = [
  /\bDROP\b/i,
  /\bTRUNCATE\b/i,
  /\bALTER\s+(TABLE|DATABASE|SCHEMA)\b/i,
  /\bCREATE\s+(TABLE|DATABASE|SCHEMA|INDEX)\b/i,
  /\bGRANT\b/i,
  /\bREVOKE\b/i,
  /\bDELETE\b/i,
  /\bUPDATE\b/i,
  /\bINSERT\b/i,
  /\bRENAME\b/i,
];

function isHighRisk(sql: string): boolean {
  return HIGH_RISK_PATTERNS.some(p => p.test(sql));
}

class ApprovalService {
  private getPool() { return dbConnection.getPool(); }

  /**
   * 提交 SQL 审批
   */
  async submitForApproval(data: {
    instance_id: number;
    sql_text: string;
    submitted_by?: number;
    target_database?: string;
  }): Promise<{
    request_id?: number;
    risk_level: string;
    ai_recommendation?: any;
    requires_approval: boolean;
    auto_approved?: boolean;
  }> {
    const { instance_id, sql_text, submitted_by, target_database } = data;
    const sqlHash = crypto.createHash('md5').update(sql_text).digest('hex');
    const isDangerous = isHighRisk(sql_text);

    // SELECT 直接放行
    if (!isDangerous && /^\s*SELECT\b|^\s*SHOW\b|^\s*DESCRIBE\b|^\s*EXPLAIN\b/i.test(sql_text)) {
      return { requires_approval: false, auto_approved: true, risk_level: 'low' };
    }

    // LLM 风险评估
    let aiRecommendation = null;
    try {
      const llmResult = await llmService.chat(
        [{ role: 'user', content: sql_text }],
        undefined, undefined, 0.1, 4096,
        '你是数据库安全审核专家。评估以下 SQL 的风险等级（low/medium/high/critical），给出建议（approve/reject）和理由。只返回 JSON: {"risk_level":"...","recommendation":"...","reasoning":"..."}',
      );
      if (llmResult?.content) {
        const jsonMatch = llmResult.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            aiRecommendation = JSON.parse(jsonMatch[0]);
          } catch {
            console.warn('LLM 返回了无效 JSON，降级为模式匹配风险判断');
          }
        }
      }
    } catch (err) {
      console.warn('LLM 不可用，降级为模式匹配风险判断:', err);
    }

    const riskLevel = aiRecommendation?.risk_level || (isDangerous ? 'high' : 'low');

    // 写入数据库
    const pool = this.getPool();
    if (!pool) return { requires_approval: true, risk_level: riskLevel, ai_recommendation: aiRecommendation };

    const [result] = await pool.execute(
      `INSERT INTO approval_requests (instance_id, sql_text, sql_hash, risk_level, ai_recommendation, status, submitted_by, target_database)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [instance_id, sql_text, sqlHash, riskLevel, aiRecommendation ? JSON.stringify(aiRecommendation) : null, submitted_by || null, target_database || null]
    ) as any;

    const requestId = (result as any).insertId;

    // 写入提交审批事件
    if (requestId) {
      await this.writeEvent(requestId, 'submitted', {}, submitted_by || null);

      // 如果 AI 分析完成，写入 AI 风险评估事件
      if (aiRecommendation) {
        await this.writeEvent(requestId, 'ai_reviewed', {
          risk_level: riskLevel,
          recommendation: aiRecommendation.recommendation,
          reasoning: aiRecommendation.reasoning,
        }, submitted_by || null);
      }
    }

    return {
      request_id: result.insertId,
      risk_level: riskLevel,
      ai_recommendation: aiRecommendation,
      requires_approval: true,
    };
  }

  /**
   * 审批人审核
   */
  async reviewRequest(requestId: number, review: {
    action: 'approve' | 'reject';
    reviewed_by?: number;
    notes?: string;
    execute_after_approve?: boolean;
  }): Promise<{ success: boolean; error?: string; execution_result?: any }> {
    const pool = this.getPool();
    if (!pool) return { success: false, error: '数据库未连接' };

    const [rows] = await pool.execute(
      'SELECT * FROM approval_requests WHERE id = ? AND status = ?',
      [requestId, 'pending']
    ) as any;

    if (!rows.length) return { success: false, error: '审批请求不存在或已处理' };

    const req = rows[0] as ApprovalRequest;

    if (review.action === 'reject') {
      await pool.execute(
        'UPDATE approval_requests SET status = ?, reviewed_by = ?, review_notes = ? WHERE id = ?',
        ['rejected', review.reviewed_by || null, review.notes || null, requestId]
      );
      await this.writeEvent(requestId, 'rejected', { notes: review.notes }, review.reviewed_by);
      return { success: true };
    }

    let execResult = null;
    if (review.execute_after_approve !== false) {
      // 先执行 SQL，再根据执行结果设置状态，避免状态不一致窗口
      execResult = await sqlExecutor.executeSql(req.instance_id, req.sql_text, {
        userId: String(review.reviewed_by || ''),
        username: 'dba-approver',
        database: req.target_database || undefined,
      });
      const status = execResult.success ? 'executed' : 'approved';
      await pool.execute(
        'UPDATE approval_requests SET status = ?, reviewed_by = ?, review_notes = ?, execution_result = ? WHERE id = ?',
        [status, review.reviewed_by || null, review.notes || null,
         JSON.stringify(execResult.success ? execResult : { error: execResult.error }), requestId]
      );
      await this.writeEvent(requestId, 'approved', { execute_after_approve: true }, review.reviewed_by);
      if (execResult.success) {
        await this.writeEvent(requestId, 'executed', { rows: execResult.rowsAffected, duration: execResult.duration }, review.reviewed_by);
      } else {
        await this.writeEvent(requestId, 'execution_failed', { error: execResult.error }, review.reviewed_by);
      }
    } else {
      // 纯审批，不自动执行
      await pool.execute(
        'UPDATE approval_requests SET status = ?, reviewed_by = ?, review_notes = ? WHERE id = ?',
        ['approved', review.reviewed_by || null, review.notes || null, requestId]
      );
      await this.writeEvent(requestId, 'approved', { execute_after_approve: false }, review.reviewed_by);
    }

    const success = execResult ? execResult.success : true;
    return { success, execution_result: execResult };
  }

  /**
   * 获取待审批列表
   */
  async getPendingRequests(): Promise<ApprovalRequest[]> {
    const pool = this.getPool();
    if (!pool) return [];
    const [rows] = await pool.execute(
      'SELECT * FROM approval_requests WHERE status = ? ORDER BY created_at DESC',
      ['pending']
    ) as any;
    return rows;
  }

  /**
   * 获取已处理的审批历史
   */
  async getProcessedRequests(limit = 50): Promise<ApprovalRequest[]> {
    const pool = this.getPool();
    if (!pool) return [];
    const safeLimit = Math.min(Math.max(1, limit), 200);
    const [rows] = await pool.query(
      'SELECT * FROM approval_requests WHERE status IN (\'approved\',\'rejected\',\'executed\') ORDER BY updated_at DESC LIMIT ?',
      [safeLimit]
    ) as any;
    return rows;
  }

  /**
   * 获取审批请求详情
   */
  async getRequestById(id: number): Promise<ApprovalRequest | null> {
    const pool = this.getPool();
    if (!pool) return null;
    const [rows] = await pool.execute(
      'SELECT * FROM approval_requests WHERE id = ?', [id]
    ) as any;
    return rows[0] || null;
  }

  /**
   * 写入审批事件
   */
  async writeEvent(requestId: number, eventType: string, eventData?: any, userId?: number): Promise<void> {
    const pool = this.getPool();
    if (!pool) return;
    try {
      await pool.execute(
        `INSERT INTO approval_events (request_id, event_type, event_data, created_by, created_at)
         VALUES (?, ?, ?, ?, NOW())`,
        [requestId, eventType, eventData ? JSON.stringify(eventData) : null, userId || null],
      );
    } catch (err) {
      console.error('写入审批事件失败:', err);
    }
  }

  /**
   * 获取审批事件列表
   */
  async getApprovalEvents(requestId: number): Promise<any[]> {
    const pool = this.getPool();
    if (!pool) return [];
    const [rows] = await pool.execute(
      'SELECT * FROM approval_events WHERE request_id = ? ORDER BY created_at ASC',
      [requestId],
    ) as any;
    return rows.map((row: any) => ({
      ...row,
      event_data: typeof row.event_data === 'string' ? JSON.parse(row.event_data) : row.event_data,
    }));
  }

  /**
   * 批量审批
   */
  async batchReview(data: {
    items: Array<{ id: number; action: 'approve' | 'reject'; execute_after_approve: boolean }>;
    reviewed_by: number;
    notes: string;
  }): Promise<Array<{ id: number; success: boolean; error?: string; execution_result?: any }>> {
    const results: Array<{ id: number; success: boolean; error?: string; execution_result?: any }> = [];
    for (const item of data.items) {
      try {
        const result = await this.reviewRequest(item.id, {
          action: item.action,
          reviewed_by: data.reviewed_by,
          notes: data.notes,
          execute_after_approve: item.execute_after_approve,
        });
        results.push({ id: item.id, ...result });
      } catch (e: any) {
        results.push({ id: item.id, success: false, error: e.message });
      }
    }
    return results;
  }
}

export const approvalService = new ApprovalService();
