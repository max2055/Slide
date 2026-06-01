/**
 * SQL 审核服务
 * 用户提交 SQL → 预 LLM 风险检测 → 收集上下文 → LLM 分析 → 存储结果
 * 事件触发模式（无 cron 循环）
 */
import { llmService } from './llm-service.js';
import { databaseService } from './database-service.js';
import { aiAnalysisDatabaseService } from './ai-analysis-database-service.js';
import { dbConnection } from './db-connection.js';
import crypto from 'crypto';

export interface SqlRiskItem {
  level: 'warning' | 'error';
  pattern: string;
  message: string;
}

export interface SqlAuditResult {
  analysisId: number;
  recordId: number;
  preAuditResults: SqlRiskItem[];
}

export interface SqlAuditRecord {
  id: number;
  instance_id: number;
  sql_text: string;
  sql_hash: string | null;
  audit_level: 'info' | 'warning' | 'error';
  risk_level: 'P0' | 'P1' | 'P2';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'reviewed';
  reviewer_id: number | null;
  review_comment: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

class SqlAuditService {
  /**
   * 提交 SQL 审核（主入口）
   * @returns analysisId, recordId, preAuditResults — 立即返回，LLM 分析在后台执行
   */
  async submitAudit(
    sqlText: string,
    instanceId: number,
    createdBy?: string
  ): Promise<SqlAuditResult> {
    // MD5 hash SQL 文本
    const sqlHash = crypto.createHash('md5').update(sqlText).digest('hex');

    // 缓存去重检查：相同 sql_hash + instance_id 且 status='completed' 且 TTL 内
    const cacheKey = `${sqlHash}:${instanceId}`;
    const existing = await aiAnalysisDatabaseService.findByCacheKey(cacheKey);
    if (existing) {
      return {
        analysisId: existing.id,
        recordId: existing.related_id || 0,
        preAuditResults: [],
      };
    }

    // 预 LLM 风险检测
    const preAuditResults = this.detectRisks(sqlText);

    // 创建 sql_audit_records 记录
    const pool = dbConnection.getPool();
    if (!pool) {
      throw new Error('数据库未连接');
    }

    const [insertResult] = await pool.execute(
      `INSERT INTO sql_audit_records
       (instance_id, sql_text, sql_hash, audit_level, risk_level, status, created_by)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      [
        instanceId,
        sqlText,
        sqlHash,
        this._calculateAuditLevel(preAuditResults),
        this._calculateRiskLevel(preAuditResults),
        createdBy || null,
      ]
    ) as any;

    const recordId = insertResult.insertId;

    // 创建 ai_analysis 记录
    const createResult = await aiAnalysisDatabaseService.createAnalysis({
      analysis_type: 'sql_audit',
      instance_id: instanceId,
      related_id: recordId,
      trigger_type: 'manual',
      cache_key: cacheKey,
    });

    if (!createResult.success || !createResult.analysisId) {
      throw new Error('创建分析记录失败');
    }

    const analysisId = createResult.analysisId;

    // 后台执行分析（非阻塞）
    this._runAnalysis(analysisId, recordId, sqlText, instanceId).catch(async (err) => {
      console.error(`[SQLAudit] 后台分析 #${analysisId} 失败:`, err);
      await aiAnalysisDatabaseService
        .failAnalysis(analysisId, err instanceof Error ? err.message : String(err))
        .catch(() => {});
      await pool
        .execute('UPDATE sql_audit_records SET status = ? WHERE id = ?', ['failed', recordId])
        .catch(() => {});
    });

    return { analysisId, recordId, preAuditResults };
  }

  /**
   * 后台执行审核分析流程
   */
  private async _runAnalysis(
    analysisId: number,
    recordId: number,
    sqlText: string,
    instanceId: number
  ): Promise<void> {
    const startTime = Date.now();

    // 更新状态为运行中
    await aiAnalysisDatabaseService.updateStatus(analysisId, 'running');
    const pool = dbConnection.getPool();
    if (pool) {
      await pool.execute(
        'UPDATE sql_audit_records SET status = ? WHERE id = ?',
        ['running', recordId]
      );
    }

    // 收集上下文数据
    // 1. 获取 EXPLAIN 执行计划
    let explainPlan = '';
    try {
      const explain = await databaseService.getExplainPlan(instanceId, sqlText);
      explainPlan = explain || 'EXPLAIN 获取失败';
    } catch (err: any) {
      console.warn(`[SQLAudit] EXPLAIN 获取失败: ${err.message}`);
      explainPlan = 'EXPLAIN 获取失败';
    }

    // 2. 获取表索引信息
    let indexInfo = '索引信息获取失败';
    try {
      indexInfo = await this._getIndexInfo(instanceId, sqlText);
    } catch (err: any) {
      console.warn(`[SQLAudit] 索引信息获取失败: ${err.message}`);
    }

    // 3. 获取表统计信息
    let tableStats = '表统计信息获取失败';
    try {
      tableStats = await this._getTableStats(instanceId, sqlText);
    } catch (err: any) {
      console.warn(`[SQLAudit] 表统计信息获取失败: ${err.message}`);
    }

    // 预检测结果
    const preAuditResults = this.detectRisks(sqlText);

    // 构建 prompt
    const prompt = this._buildAuditPrompt(sqlText, explainPlan, indexInfo, tableStats, preAuditResults);
    const systemPrompt = this._buildSystemPrompt();

    // 调用 LLM
    const llmResult = await llmService.chatWithTracking(
      [{ role: 'user', content: prompt }],
      {
        system: systemPrompt,
        purpose: 'sql_audit',
        sessionId: `sql-audit-${analysisId}`,
        instanceId,
        maxTokens: 4096,
      }
    );

    const duration_ms = Date.now() - startTime;

    // 存储结果
    if (llmResult.success && llmResult.content) {
      const usage = {
        input_tokens: llmResult.usage?.input_tokens || 0,
        output_tokens: llmResult.usage?.output_tokens || 0,
        cost_usd: llmResult.usage?.cost_usd || 0,
        provider: llmResult.provider || 'unknown',
        model: llmResult.model || 'unknown',
      };

      await aiAnalysisDatabaseService.completeAnalysis(analysisId, {
        result: {
          raw_content: llmResult.content,
          duration_ms: llmResult.duration_ms,
          pre_audit_results: preAuditResults,
          explain_plan: explainPlan,
          index_info: indexInfo,
          table_stats: tableStats,
        },
        usage,
        duration_ms,
      });

      // 更新 sql_audit_records 状态
      if (pool) {
        await pool.execute(
          'UPDATE sql_audit_records SET status = ? WHERE id = ?',
          ['completed', recordId]
        );
      }

      console.log(`[SQLAudit] 审核 #${analysisId} 完成 (${duration_ms}ms)`);
    } else {
      await aiAnalysisDatabaseService.failAnalysis(
        analysisId,
        llmResult.error || 'LLM 分析失败'
      );
      if (pool) {
        await pool.execute(
          'UPDATE sql_audit_records SET status = ? WHERE id = ?',
          ['failed', recordId]
        );
      }
      console.error(`[SQLAudit] 审核 #${analysisId} 失败: ${llmResult.error}`);
    }
  }

  /**
   * 预 LLM 风险检测（正则匹配常见 SQL 反模式）
   */
  detectRisks(sqlText: string): SqlRiskItem[] {
    const results: SqlRiskItem[] = [];
    const normalized = sqlText.replace(/\s+/g, ' ').trim();
    const upper = normalized.toUpperCase();

    // SELECT *
    if (/SELECT\s+\*/i.test(upper)) {
      results.push({
        level: 'warning',
        pattern: 'SELECT *',
        message: 'SELECT * 可能导致不必要的列传输，建议明确指定所需列',
      });
    }

    // 缺少 WHERE 子句（有 FROM 但无 WHERE 的 SELECT/UPDATE/DELETE）
    if (
      /(SELECT|UPDATE|DELETE)\s+.*FROM\s+\w+/i.test(normalized) &&
      !/WHERE/i.test(upper)
    ) {
      results.push({
        level: 'error',
        pattern: 'MISSING WHERE',
        message: '缺少 WHERE 条件，可能影响全表数据，请确认是否需要过滤条件',
      });
    }

    // LIKE 前缀通配符
    const likeMatches = normalized.match(/LIKE\s+'([^']*)'/gi);
    if (likeMatches) {
      for (const m of likeMatches) {
        const value = m.match(/'([^']*)'/)?.[1] || '';
        if (value.startsWith('%')) {
          results.push({
            level: 'warning',
            pattern: 'LIKE PREFIX WILDCARD',
            message: '前缀通配符 LIKE 无法使用索引，可能导致全表扫描',
          });
          break;
        }
      }
    }

    // ORDER BY 无 LIMIT
    if (/ORDER\s+BY/i.test(upper) && !/LIMIT/i.test(upper)) {
      results.push({
        level: 'warning',
        pattern: 'ORDER BY WITHOUT LIMIT',
        message: '无 LIMIT 的 ORDER BY 可能导致大量排序，建议添加 LIMIT 限制',
      });
    }

    // JOIN 超过 3 个
    const joinCount = (upper.match(/JOIN/g) || []).length;
    if (joinCount > 3) {
      results.push({
        level: 'warning',
        pattern: 'MULTIPLE JOINS',
        message: `多表 JOIN（${joinCount} 个）可能导致性能问题，建议减少关联表数量`,
      });
    }

    // INSERT INTO ... SELECT
    if (/INSERT\s+INTO\s+\w+.*SELECT/i.test(normalized)) {
      results.push({
        level: 'warning',
        pattern: 'INSERT SELECT',
        message: 'INSERT...SELECT 可能锁表，建议分批处理或调整事务隔离级别',
      });
    }

    // DDL 语句
    if (/\b(DROP|TRUNCATE)\b/i.test(upper) || /ALTER\s+TABLE/i.test(upper)) {
      results.push({
        level: 'error',
        pattern: 'DDL STATEMENT',
        message: 'DDL 语句（DROP/TRUNCATE/ALTER TABLE）在生产环境有高风险，需 DBA 审批',
      });
    }

    // IN (...) 超过 100 个值
    const inMatches = normalized.match(/IN\s*\(([^)]+)\)/gi);
    if (inMatches) {
      for (const m of inMatches) {
        // Count values, ignoring commas inside string literals
        const content = m.replace(/IN\s*\(/i, '').replace(/\)$/, '');
        const cleaned = content.replace(/'[^']*'/g, "'x'");
        const valueCount = cleaned.split(',').filter(s => s.trim().length > 0).length;
        if (valueCount > 100) {
          results.push({
            level: 'warning',
            pattern: 'LARGE IN CLAUSE',
            message: `大量 IN 值（${valueCount} 个）可能超出优化器处理能力，建议用临时表或 JOIN`,
          });
          break;
        }
      }
    }

    // NOT IN (SELECT ...)
    if (/NOT\s+IN\s*\(\s*SELECT/i.test(normalized)) {
      results.push({
        level: 'error',
        pattern: 'NOT IN SUBQUERY',
        message: 'NOT IN 子查询在存在 NULL 时行为异常，建议用 NOT EXISTS 替代',
      });
    }

    return results;
  }

  /**
   * 获取审核历史
   */
  async getAuditHistory(instanceId: number, limit: number = 20): Promise<any[]> {
    return aiAnalysisDatabaseService.getAnalysisList({
      analysis_type: 'sql_audit',
      instance_id: instanceId,
      limit,
    });
  }

  /**
   * 获取单个审核结果
   */
  async getAuditResult(analysisId: number): Promise<any> {
    const analysis = await aiAnalysisDatabaseService.getAnalysisById(analysisId);
    if (!analysis) return null;

    // 获取对应的 sql_audit_records 信息
    const pool = dbConnection.getPool();
    if (!pool || !analysis.related_id) return analysis;

    try {
      const [rows] = await pool.execute(
        'SELECT id, sql_text, sql_hash, audit_level, risk_level, status, created_by, created_at FROM sql_audit_records WHERE id = ?',
        [analysis.related_id]
      ) as any;

      if (Array.isArray(rows) && rows.length > 0) {
        return {
          ...analysis,
          audit_record: rows[0],
        };
      }
    } catch (err) {
      console.warn(`[SQLAudit] 获取审核记录失败:`, err);
    }

    return analysis;
  }

  /**
   * 从 SQL 中提取表名
   */
  private _extractTableNames(sql: string): string[] {
    const tables = new Set<string>();
    const normalized = sql.replace(/\s+/g, ' ').trim();

    // FROM table_name
    const fromMatches = normalized.match(/FROM\s+`?(\w+)`?/gi);
    fromMatches?.forEach((m) => {
      const name = m.replace(/FROM\s+`?/i, '').replace(/`$/, '');
      if (
        name &&
        ![
          'SELECT',
          'WHERE',
          'JOIN',
          'ON',
          'GROUP',
          'ORDER',
          'LIMIT',
          'HAVING',
          'INTO',
        ].includes(name.toUpperCase())
      ) {
        tables.add(name);
      }
    });

    // JOIN table_name
    const joinMatches = normalized.match(/JOIN\s+`?(\w+)`?/gi);
    joinMatches?.forEach((m) => {
      const name = m.replace(/JOIN\s+`?/i, '').replace(/`$/, '');
      if (name) tables.add(name);
    });

    // INSERT INTO table_name / UPDATE table_name
    const insertMatch = normalized.match(/INSERT\s+INTO\s+`?(\w+)`?/i);
    if (insertMatch) tables.add(insertMatch[1]);

    const updateMatch = normalized.match(/^UPDATE\s+`?(\w+)`?/i);
    if (updateMatch) tables.add(updateMatch[1]);

    return Array.from(tables);
  }

  /**
   * 获取表索引信息
   */
  private async _getIndexInfo(instanceId: number, sqlText: string): Promise<string> {
    const tables = this._extractTableNames(sqlText);
    if (tables.length === 0) {
      return '未识别到表名';
    }

    const pool = dbConnection.getPool();
    if (!pool) return '数据库未连接';

    let output = '';
    for (const table of tables) {
      try {
        const [rows] = await pool.execute(
          `SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX, NON_UNIQUE, INDEX_TYPE
           FROM index_info
           WHERE instance_id = ? AND TABLE_NAME = ?
           ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
          [instanceId, table]
        ) as any;

        if (Array.isArray(rows) && rows.length > 0) {
          output += `\n表: ${table}\n`;
          let currentIndex: string | null = null;
          let columns: string[] = [];
          let indexType = '';
          let nonUnique = false;

          for (const row of rows) {
            if (row.INDEX_NAME !== currentIndex && currentIndex !== null) {
              output += `  ${currentIndex} (${columns.join(', ')})${nonUnique ? '' : ' [UNIQUE]'} ${indexType}\n`;
              columns = [];
            }
            currentIndex = row.INDEX_NAME;
            columns.push(row.COLUMN_NAME);
            indexType = row.INDEX_TYPE || '';
            nonUnique = row.NON_UNIQUE === 1;
          }
          if (currentIndex) {
            output += `  ${currentIndex} (${columns.join(', ')})${nonUnique ? '' : ' [UNIQUE]'} ${indexType}\n`;
          }
        } else {
          output += `表: ${table} - 无索引信息（可能未被采集）\n`;
        }
      } catch {
        output += `表: ${table} - 索引查询失败\n`;
      }
    }

    return output || '无索引信息';
  }

  /**
   * 获取表统计信息
   */
  private async _getTableStats(instanceId: number, sqlText: string): Promise<string> {
    const tables = this._extractTableNames(sqlText);
    if (tables.length === 0) {
      return '未识别到表名';
    }

    try {
      const conn = databaseService.getConnection(instanceId);
      if (!conn || !conn.connected || !conn.pool) {
        return '数据库实例未连接';
      }

      // 获取 schema 名（如果有）
      const schemaName = conn.config?.database || '';

      const placeholders = tables.map(() => '?').join(', ');
      const [rows] = await conn.pool.execute(
        `SELECT TABLE_NAME, TABLE_ROWS, AVG_ROW_LENGTH, DATA_LENGTH, INDEX_LENGTH,
                DATA_FREE, CREATE_TIME, UPDATE_TIME
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${placeholders})`,
        [schemaName, ...tables]
      ) as any;

      if (!Array.isArray(rows) || rows.length === 0) {
        return '未找到表统计信息';
      }

      let output = '';
      for (const row of rows) {
        output += `\n表: ${row.TABLE_NAME}\n`;
        output += `  行数: ${row.TABLE_ROWS ?? 'N/A'}\n`;
        output += `  平均行大小: ${row.AVG_ROW_LENGTH ? row.AVG_ROW_LENGTH + ' bytes' : 'N/A'}\n`;
        output += `  数据大小: ${row.DATA_LENGTH ? this._formatBytes(row.DATA_LENGTH) : 'N/A'}\n`;
        output += `  索引大小: ${row.INDEX_LENGTH ? this._formatBytes(row.INDEX_LENGTH) : 'N/A'}\n`;
        output += `  碎片: ${row.DATA_FREE ? this._formatBytes(row.DATA_FREE) : 'N/A'}\n`;
      }

      return output;
    } catch {
      return '表统计信息查询失败';
    }
  }

  /**
   * 格式化字节数
   */
  private _formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * 构建 SQL 审核 prompt
   */
  private _buildAuditPrompt(
    sqlText: string,
    explainPlan: string,
    indexInfo: string,
    tableStats: string,
    preAuditResults: SqlRiskItem[]
  ): string {
    let prompt = `请审核以下 SQL 语句，分析潜在风险并给出优化建议：

## SQL 语句
\`\`\`sql
${sqlText}
\`\`\`

## 预检测结果
`;

    if (preAuditResults.length > 0) {
      prompt += preAuditResults
        .map(
          (r) =>
            `- [${r.level.toUpperCase()}] ${r.pattern}: ${r.message}`
        )
        .join('\n');
    } else {
      prompt += '预检测未发现明显风险模式';
    }

    prompt += `

## EXPLAIN 执行计划
${explainPlan}

## 相关表索引
${indexInfo}

## 表统计信息
${tableStats}

请从以下角度审核：
1. **风险评估**：语法风险、性能风险、安全风险
2. **执行计划分析**：全表扫描/索引扫描/临时表/文件排序
3. **索引优化建议**：推荐新增索引、现有索引未命中原因
4. **SQL 改写建议**：如果适用，提供优化后的 SQL
5. **风险等级**：P0=严重影响（阻止执行），P1=中等影响（建议优化），P2=轻微影响（可接受）`;

    return prompt;
  }

  /**
   * 构建 system prompt
   */
  private _buildSystemPrompt(): string {
    return `你是一位资深数据库专家（DBA），专门审核 SQL 语句的风险和性能。请用中文回复。
请以结构化的 JSON 格式返回审核结果，包含以下字段：
- risk_assessment: 风险评估（包含语法风险、性能风险、安全风险）
- execution_plan_analysis: 执行计划解读
- index_recommendations: 索引优化建议（数组，每项包含 table, recommendation, reason）
- sql_rewrite: SQL 改写建议（提供优化后的 SQL，如无需改写则说明原因）
- risk_level: 风险等级（P0/P1/P2）
- summary: 简要总结（字符串）`;
  }

  /**
   * 计算审核级别
   */
  private _calculateAuditLevel(results: SqlRiskItem[]): 'info' | 'warning' | 'error' {
    if (results.some((r) => r.level === 'error')) return 'error';
    if (results.some((r) => r.level === 'warning')) return 'warning';
    return 'info';
  }

  /**
   * 计算风险等级
   */
  private _calculateRiskLevel(results: SqlRiskItem[]): 'P0' | 'P1' | 'P2' {
    if (results.some((r) => r.level === 'error')) return 'P0';
    if (results.filter((r) => r.level === 'warning').length > 2) return 'P1';
    return 'P2';
  }
}

// 单例
export const sqlAuditService = new SqlAuditService();
