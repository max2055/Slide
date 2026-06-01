/**
 * TopSQL AI 分析服务
 * 慢查询数据收集 → LLM 分析 → 结果存储
 * 事件触发模式（无 cron 循环）
 */
import { llmService } from './llm-service.js';
import { dispatchOrReuse } from './ai-agent-bridge.js';
import { databaseService } from './database-service.js';
import { aiAnalysisDatabaseService } from './ai-analysis-database-service.js';
import { metricsDatabaseService } from './metrics-database-service.js';
import type { SlowQueryRecord } from './metrics-database-service.js';

class TopSQLAnalysisService {
  /**
   * 分析慢查询（主入口）
   * @returns analysisId - 立即返回，LLM 分析在后台执行
   */
  async analyzeSlowQuery(
    slowQueryId: number,
    instanceId: number,
    trigger: 'manual' | 'auto' = 'manual'
  ): Promise<number> {
    // 获取慢查询详情
    const slowQueries = await metricsDatabaseService.getSlowQueries(instanceId, 100);
    const slowQuery = slowQueries.find((q) => q.id === slowQueryId);

    if (!slowQuery) {
      throw new Error(`慢查询 #${slowQueryId} 不存在`);
    }

    // 缓存去重检查
    const cacheKey = `${slowQuery.sql_hash}:${instanceId}`;
    const existing = await aiAnalysisDatabaseService.findByCacheKey(cacheKey);
    if (existing) {
      return existing.id;
    }

    // 创建分析记录
    const createResult = await aiAnalysisDatabaseService.createAnalysis({
      analysis_type: 'topsql_analysis',
      instance_id: instanceId,
      related_id: slowQueryId,
      trigger_type: trigger,
      cache_key: cacheKey,
    });

    if (!createResult.success || !createResult.analysisId) {
      throw new Error('创建分析记录失败');
    }

    const analysisId = createResult.analysisId;

    // 后台执行分析（非阻塞）
    this._runAnalysis(analysisId, slowQuery, instanceId).catch(async (err) => {
      console.error(`[TopSQL] 后台分析 #${analysisId} 失败:`, err);
      await aiAnalysisDatabaseService.failAnalysis(analysisId, err instanceof Error ? err.message : String(err)).catch(() => {});
    });

    return analysisId;
  }

  /**
   * 强制重新分析（跳过缓存）
   */
  async reanalyzeSlowQuery(
    slowQueryId: number,
    instanceId: number,
    trigger: 'manual' | 'auto' = 'manual'
  ): Promise<number> {
    const slowQueries = await metricsDatabaseService.getSlowQueries(instanceId, 100);
    const slowQuery = slowQueries.find((q) => q.id === slowQueryId);

    if (!slowQuery) {
      throw new Error(`慢查询 #${slowQueryId} 不存在`);
    }

    const cacheKey = `${slowQuery.sql_hash}:${instanceId}`;
    const createResult = await aiAnalysisDatabaseService.createAnalysis({
      analysis_type: 'topsql_analysis',
      instance_id: instanceId,
      related_id: slowQueryId,
      trigger_type: trigger,
      cache_key: cacheKey,
    });

    if (!createResult.success || !createResult.analysisId) {
      throw new Error('创建分析记录失败');
    }

    const analysisId = createResult.analysisId;

    this._runAnalysis(analysisId, slowQuery, instanceId).catch(async (err) => {
      console.error(`[TopSQL] 后台重新分析 #${analysisId} 失败:`, err);
      await aiAnalysisDatabaseService.failAnalysis(analysisId, err instanceof Error ? err.message : String(err)).catch(() => {});
    });

    return analysisId;
  }

  /**
   * 获取分析状态
   */
  async getAnalysisStatus(analysisId: number) {
    return aiAnalysisDatabaseService.getAnalysisById(analysisId);
  }

  /**
   * 获取实例分析历史
   */
  async getInstanceAnalysisHistory(instanceId: number, limit: number = 20) {
    return aiAnalysisDatabaseService.getAnalysisList({
      instance_id: instanceId,
      analysis_type: 'topsql_analysis',
      limit,
    });
  }

  /**
   * 获取服务状态
   */
  async getStatus(): Promise<{ runningAnalyses: number; totalCompleted: number }> {
    const running = await aiAnalysisDatabaseService.getAnalysisList({
      status: 'running',
      limit: 1,
    });
    const completed = await aiAnalysisDatabaseService.getAnalysisList({
      status: 'completed',
      limit: 1,
    });
    return {
      runningAnalyses: running.length,
      totalCompleted: completed.length,
    };
  }

  /**
   * 后台执行分析流程
   */
  private async _runAnalysis(
    analysisId: number,
    slowQuery: SlowQueryRecord,
    instanceId: number
  ): Promise<void> {
    await dispatchOrReuse({
      type: 'topsql_analysis',
      cacheKey: `topsql:${slowQuery.sql_hash || 'no-hash'}:${instanceId}`,
      instanceId,
      sessionKey: `topsql-${analysisId}`,
      existingAnalysisId: analysisId,
      userMessage: `分析以下慢查询并给出优化建议:\n\nSQL:\n\`\`\`sql\n${slowQuery.sql_text}\n\`\`\`\n\n性能: 平均${slowQuery.avg_time_ms}ms 最大${slowQuery.max_time_ms}ms 执行${slowQuery.execution_count}次\n\n请使用 slide_* 工具获取 EXPLAIN 执行计划、表索引信息和表结构。分析瓶颈并给出 SQL 重写和索引优化建议。完成后调用 slide_complete_analysis 保存结果。`,
    });
  }

  /**
   * 获取表索引信息
   */
  private async _getIndexInfo(
    instanceId: number,
    slowQuery: SlowQueryRecord
  ): Promise<string> {
    const tables = this._extractTableNames(slowQuery.sql_text);
    if (tables.length === 0) {
      return '未识别到表名';
    }

    const pool = (await import('./db-connection.js')).dbConnection.getPool();
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
  private async _getTableStats(
    instanceId: number,
    slowQuery: SlowQueryRecord
  ): Promise<string> {
    if (!slowQuery.schema_name) {
      return '无 schema 信息';
    }

    const tables = this._extractTableNames(slowQuery.sql_text);
    if (tables.length === 0) {
      return '未识别到表名';
    }

    try {
      const conn = databaseService.getConnection(instanceId);
      if (!conn || !conn.connected || !conn.pool) {
        return '数据库实例未连接';
      }

      const placeholders = tables.map(() => '?').join(', ');
      const [rows] = await conn.pool.execute(
        `SELECT TABLE_NAME, TABLE_ROWS, AVG_ROW_LENGTH, DATA_LENGTH, INDEX_LENGTH,
                DATA_FREE, CREATE_TIME, UPDATE_TIME
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${placeholders})`,
        [slowQuery.schema_name, ...tables]
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
   * 从 SQL 中提取表名（简单解析）
   */
  private _extractTableNames(sql: string): string[] {
    const tables = new Set<string>();
    const normalized = sql.replace(/\s+/g, ' ').trim();

    // FROM table_name
    const fromMatches = normalized.match(/FROM\s+`?(\w+)`?/gi);
    fromMatches?.forEach((m) => {
      const name = m.replace(/FROM\s+`?/i, '').replace(/`$/, '');
      if (name && !['SELECT', 'WHERE', 'JOIN', 'ON', 'GROUP', 'ORDER', 'LIMIT', 'HAVING', 'INTO'].includes(name.toUpperCase())) {
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
   * 构建 TopSQL 分析 prompt
   */
  private _buildTopSQLPrompt(
    slowQuery: SlowQueryRecord,
    explainPlan: string,
    indexInfo: string,
    tableStats: string
  ): string {
    return `请分析以下慢查询并提供优化建议：

## SQL 语句
\`\`\`sql
${slowQuery.sql_text}
\`\`\`

## 执行统计
- 平均执行时间: ${slowQuery.avg_time_ms}ms
- 最大执行时间: ${slowQuery.max_time_ms}ms
- 最小执行时间: ${slowQuery.min_time_ms}ms
- 扫描行数: ${slowQuery.rows_examined}
- 返回行数: ${slowQuery.rows_sent}
- 执行次数: ${slowQuery.execution_count}
- 总执行时间: ${slowQuery.total_time_ms}ms
- 所属数据库: ${slowQuery.schema_name || 'N/A'}

## EXPLAIN 执行计划
${explainPlan}

## 相关表索引
${indexInfo}

## 表统计信息
${tableStats}

请从以下角度分析：
1. 执行计划解读（全表扫描/索引扫描/临时表/文件排序）
2. 索引优化建议（推荐新增索引、现有索引未命中原因）
3. SQL 改写建议（如果适用）
4. 风险等级评估（P0=严重影响性能，P1=中等影响，P2=轻微影响）`;
  }

  /**
   * 构建 system prompt
   */
  private _buildSystemPrompt(): string {
    return `你是一位资深数据库专家，专门分析 MySQL 慢查询。请用中文回复。
请以结构化的 JSON 格式返回分析结果，包含以下字段：
- execution_plan_interpretation: 执行计划解读（字符串）
- index_recommendations: 索引优化建议（数组，每项包含 table, recommendation, reason）
- sql_rewrite_suggestions: SQL 改写建议（字符串，如无需改写则说明原因）
- risk_level: 风险等级（P0/P1/P2）
- summary: 简要总结（字符串）`;
  }
}

/**
 * Parse LLM output, extracting JSON from potential markdown wrapping
 */
function parseLlmOutput(content: string): any {
  const jsonMatch = content.match(/```(?:json)?\n?([\s\S]*?)```/);
  if (jsonMatch) {
    content = jsonMatch[1].trim();
  }
  try {
    return JSON.parse(content);
  } catch {
    return { raw: content, parse_error: true };
  }
}

export const topsqlAnalysisService = new TopSQLAnalysisService();
