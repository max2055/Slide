/**
 * 故障自动诊断服务
 * 对数据库实例进行全面诊断，收集多维度数据并生成诊断报告
 */
import { dbConnection } from './db-connection.js';
import { llmService, ChatMessage } from './llm-service.js';
import { dispatchOrReuse } from './ai-agent-bridge.js';
import { aiAnalysisDatabaseService } from './ai-analysis-database-service.js';
import { databaseService } from './database-service.js';
import { metricsDatabaseService } from './metrics-database-service.js';
import { alertDatabaseService } from './alert-database-service.js';
import { instanceDatabaseService } from './instance-database-service.js';

// In-memory lock to prevent concurrent duplicate diagnoses
const pendingDiagnoses = new Set<string>();

interface InstanceInfo {
  name: string;
  db_type: string;
  environment: string;
}

class FaultDiagnosisService {
  /**
   * 诊断单个数据库实例
   * @param instanceId 实例 ID
   * @param trigger 触发类型：manual 或 auto
   * @returns analysisId
   */
  async diagnoseInstance(
    instanceId: number,
    trigger: 'manual' | 'auto' = 'auto'
  ): Promise<{ success: boolean; analysisId?: number; error?: string; status?: string }> {
    // a. 验证实例存在
    const instance = await instanceDatabaseService.getInstanceById(instanceId);
    if (!instance) {
      return { success: false, error: `实例 ${instanceId} 不存在` };
    }

    // b. 构建缓存键（小时级粒度）
    const cacheKey = this.buildCacheKey(instanceId, trigger);

    // c. In-memory lock: prevent concurrent duplicate diagnoses
    if (pendingDiagnoses.has(cacheKey)) {
      return { success: false, error: '诊断正在创建中，请稍后重试' };
    }
    // Acquire lock atomically before any await to prevent race condition
    pendingDiagnoses.add(cacheKey);
    let lockReleased = false;
    const releaseLock = () => {
      if (!lockReleased) {
        pendingDiagnoses.delete(cacheKey);
        lockReleased = true;
      }
    };

    try {
      // d. 缓存检查
      const cached = await aiAnalysisDatabaseService.findByCacheKey(cacheKey);
      if (cached) {
        releaseLock();
        return { success: true, analysisId: cached.id };
      }

      // e. 创建分析记录 (lock held)
      const createResult = await aiAnalysisDatabaseService.createAnalysis({
        analysis_type: 'fault_diagnosis',
        instance_id: instanceId,
        trigger_type: trigger,
        cache_key: cacheKey,
      });
      if (!createResult.success) {
        releaseLock();
        return { success: false, error: createResult.error };
      }
      const analysisId = createResult.analysisId!;

      // f. 更新状态为 running
      await aiAnalysisDatabaseService.updateStatus(analysisId, 'running');

      // g. 通过 OpenClaw Agent 执行诊断
      dispatchOrReuse({
        type: 'fault_diagnosis',
        cacheKey: `diagnosis:${instanceId}`,
        instanceId,
        sessionKey: `diagnosis-${analysisId}`,
        triggerType: trigger,
        existingAnalysisId: analysisId,
        userMessage: `对实例 "${instance.name || `instance-${instanceId}`}" (${instance.db_type || 'mysql'}, ${instance.environment || 'production'}) 进行故障诊断。请使用 slide_* 工具采集指标、告警、慢查询、复制状态等数据，分析故障根因并给出修复建议。完成后调用 slide_complete_analysis 保存结果。`,
      }).catch((err) => {
        console.error(`[FaultDiagnosis] Agent 诊断 ${analysisId} 失败:`, err);
        aiAnalysisDatabaseService.failAnalysis(analysisId, err.message).catch(() => {});
      });

      releaseLock();
      return { success: true, analysisId, status: 'queued' };
    } catch (err) {
      releaseLock();
      throw err;
    }
  }

  /**
   * @deprecated Replaced by dispatchOrReuse Agent path
   * 执行实际的数据收集和 LLM 诊断
   */
  private async _executeDiagnosis(
    analysisId: number,
    instanceId: number,
    instanceInfo: InstanceInfo
  ): Promise<void> {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
    const now = new Date();

    // 健康评分
    let healthText = '健康评分数据不可用';
    try {
      const health = await databaseService.checkHealth(instanceId);
      if (health) {
        healthText = this._formatHealthScore(health);
      }
    } catch (err: any) {
      console.warn('[FaultDiagnosis] 获取健康评分失败:', err.message);
    }

    // 最近指标
    let metricsText = '无指标数据';
    try {
      const metrics = await metricsDatabaseService.getHistoricalMetrics(
        instanceId, thirtyMinAgo, now
      );
      const limited = metrics.slice(-60);
      metricsText = this._formatMetricsTrend(limited);
    } catch (err: any) {
      console.warn('[FaultDiagnosis] 获取指标失败:', err.message);
    }

    // 活跃会话
    let sessionsText = '无会话数据';
    try {
      const sessions = await databaseService.getActiveSessions(instanceId);
      sessionsText = this._formatSessionsDetailed(sessions || []);
    } catch (err: any) {
      console.warn('[FaultDiagnosis] 获取活跃会话失败:', err.message);
    }

    // 慢查询
    let slowQueriesText = '无慢查询数据';
    try {
      const slowQueries = await metricsDatabaseService.getSlowQueries(instanceId, 10);
      slowQueriesText = this._formatSlowQueries(slowQueries);
    } catch (err: any) {
      console.warn('[FaultDiagnosis] 获取慢查询失败:', err.message);
    }

    // 最近告警
    let recentAlertsText = '无最近告警';
    try {
      const alerts = await alertDatabaseService.getAlerts({ instance_id: instanceId, limit: 10 });
      recentAlertsText = this._formatRecentAlerts(alerts);
    } catch (err: any) {
      console.warn('[FaultDiagnosis] 获取最近告警失败:', err.message);
    }

    // 索引状态
    let indexText = '索引状态数据不可用';
    try {
      indexText = await this._getIndexStatus(instanceId);
    } catch (err: any) {
      console.warn('[FaultDiagnosis] 获取索引状态失败:', err.message);
    }

    // 复制状态
    let replicationText = '复制状态数据不可用';
    try {
      replicationText = await this._getReplicationStatus(instanceId);
    } catch (err: any) {
      console.warn('[FaultDiagnosis] 获取复制状态失败:', err.message);
    }

    // g. 构建 prompt
    const prompt = this.buildFaultDiagnosisPrompt(
      instanceInfo,
      healthText,
      metricsText,
      sessionsText,
      slowQueriesText,
      recentAlertsText,
      indexText,
      replicationText
    );

    const systemPrompt = `你是一位资深数据库专家，专门进行数据库故障诊断。请用中文回复。
请以结构化的 JSON 格式返回诊断报告，包含以下字段：
- health_overview: 健康概述（对象: {health_score, health_status, trend, key_concerns}）
- issues_found: 发现的问题（数组，每项包含 {issue, severity, description, impact}）
- root_causes: 根因分析（数组，按可能性排序，每项包含 {cause, confidence, explanation}）
- recommended_actions: 建议操作（数组，按优先级排序，每项包含 {priority, action, steps, estimated_time}）
- risk_assessment: 风险评估（对象: {overall_risk, risk_factors, mitigation_strategy}）
- summary: 简要总结（字符串）

只返回 JSON，不要添加其他文本。`;

    // h. 调用 LLM
    const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
    const llmResult = await llmService.chatWithTracking(messages, {
      system: systemPrompt,
      purpose: 'fault_diagnosis',
      sessionId: `fault-${analysisId}`,
      instanceId,
      maxTokens: 8192,
    });

    // i. Store result with JSON validation
    if (llmResult.success) {
      const validatedResult = parseLlmOutput(llmResult.content);
      await aiAnalysisDatabaseService.completeAnalysis(analysisId, {
        result: validatedResult,
        usage: llmResult.usage,
        duration_ms: llmResult.duration_ms,
      });
      console.log(`[FaultDiagnosis] 诊断 ${analysisId} 完成，耗时 ${llmResult.duration_ms}ms`);
    } else {
      await aiAnalysisDatabaseService.failAnalysis(analysisId, llmResult.error || 'LLM 调用失败');
      console.error(`[FaultDiagnosis] 诊断 ${analysisId} 失败:`, llmResult.error);
    }
  }

  /**
   * 诊断所有不健康实例
   */
  async diagnoseUnhealthyInstances(trigger: 'auto' = 'auto'): Promise<number[]> {
    const instances = await instanceDatabaseService.getAllInstances();
    if (!instances || instances.length === 0) return [];

    const analysisIds: number[] = [];
    for (const instance of instances) {
      // 先检查健康状态
      try {
        const health = await databaseService.checkHealth(instance.id);
        if (health && health.status !== 'healthy') {
          const result = await this.diagnoseInstance(instance.id, trigger);
          if (result.success && result.analysisId) {
            analysisIds.push(result.analysisId);
          }
        }
      } catch {
        // 无法获取健康状态，跳过
      }
    }

    return analysisIds;
  }

  /**
   * 获取诊断历史
   */
  async getDiagnosisHistory(
    instanceId: number,
    limit: number = 10
  ): Promise<any[]> {
    return aiAnalysisDatabaseService.getAnalysisList({
      analysis_type: 'fault_diagnosis',
      instance_id: instanceId,
      limit,
    });
  }

  /**
   * 获取最新诊断结果
   */
  async getLatestDiagnosis(instanceId: number): Promise<any> {
    const results = await this.getDiagnosisHistory(instanceId, 1);
    return results.length > 0 ? results[0] : null;
  }

  /**
   * 获取诊断服务状态统计
   */
  async getStatus(): Promise<any> {
    return aiAnalysisDatabaseService.getAnalysisStats('fault_diagnosis');
  }

  // ==================== 私有方法 ====================

  /**
   * 构建缓存键（小时级粒度，包含触发类型）
   */
  private buildCacheKey(instanceId: number, trigger: 'manual' | 'auto' = 'auto'): string {
    const currentHour = new Date().toISOString().slice(0, 13);
    return `fault:${instanceId}:${currentHour}:${trigger}`;
  }

  /**
   * @deprecated Replaced by dispatchOrReuse Agent path
   * 格式化健康评分
   */
  private _formatHealthScore(health: any): string {
    const score = health.score ?? health.totalScore ?? 'N/A';
    const status = health.status ?? 'unknown';
    const dimensions = health.dimensions || health.scores || {};
    const dimText = Object.entries(dimensions)
      .map(([k, v]) => `  - ${k}: ${v}`)
      .join('\n');
    return `当前评分: ${score}/100\n健康状态: ${status}\n各维度得分:\n${dimText}`;
  }

  /**
   * @deprecated Replaced by dispatchOrReuse Agent path
   * 格式化指标趋势
   */
  private _formatMetricsTrend(metrics: any[]): string {
    if (!metrics || metrics.length === 0) return '无指标数据';

    const formatTrend = (
      values: number[], label: string, unit: string
    ): string => {
      if (values.length === 0) return `${label}: 无数据`;
      const first = values[0].toFixed(1);
      const last = values[values.length - 1].toFixed(1);
      const avg = (values.reduce((a, b) => a + b, 0) / values.length).toFixed(1);
      const max = Math.max(...values).toFixed(1);
      const min = Math.min(...values).toFixed(1);
      return `${label}: ${first}${unit} → ${last}${unit} (均值: ${avg}, 峰值: ${max}, 最低: ${min})`;
    };

    const cpuValues = metrics.map((m) => m.cpu_usage ?? 0);
    const memValues = metrics.map((m) => m.memory_usage ?? 0);
    const connValues = metrics.map((m) => m.connections ?? 0);
    const qpsValues = metrics.map((m) => m.qps ?? 0);
    const diskValues = metrics.map((m) => m.disk_usage ?? 0);

    return [
      formatTrend(cpuValues, 'CPU', '%'),
      formatTrend(memValues, '内存', '%'),
      formatTrend(connValues, '连接数', ''),
      formatTrend(qpsValues, 'QPS', ''),
      formatTrend(diskValues, '磁盘', '%'),
    ].join('\n');
  }

  /**
   * @deprecated Replaced by dispatchOrReuse Agent path
   * 格式化活跃会话（详细版）
   */
  private _formatSessionsDetailed(sessions: any[]): string {
    if (!sessions || sessions.length === 0) return '无活跃会话';

    let longTxCount = 0;
    let lockWaitCount = 0;

    const lines = sessions.slice(0, 20).map((s, i) => {
      const cmd = s.command || 'Unknown';
      const state = s.state || 'Unknown';
      const time = s.time || 0;
      const info = s.info || '';
      const host = s.host || '';

      if (time > 60) longTxCount++;
      if (state.toLowerCase().includes('lock')) lockWaitCount++;

      return `  ${i + 1}. [${cmd}] ${state} (${time}s) ${host}${info ? ' | ' + info.substring(0, 100) : ''}`;
    });

    const summary = `共 ${sessions.length} 个活跃会话`;
    const warnings = [];
    if (longTxCount > 0) warnings.push(`${longTxCount} 个长事务 (>60s)`);
    if (lockWaitCount > 0) warnings.push(`${lockWaitCount} 个锁等待`);

    return [
      summary + (warnings.length ? ' (' + warnings.join(', ') + ')' : '') + ':',
      lines.join('\n'),
    ].join('\n');
  }

  /**
   * @deprecated Replaced by dispatchOrReuse Agent path
   * 格式化慢查询
   */
  private _formatSlowQueries(queries: any[]): string {
    if (!queries || queries.length === 0) return '无慢查询数据';

    const lines = queries.slice(0, 10).map((q, i) => {
      const avgTime = (q.avg_time_ms || 0).toFixed(0);
      const maxTime = (q.max_time_ms || 0).toFixed(0);
      const count = q.execution_count || 0;
      const rowsExam = q.rows_examined || 0;
      const sql = q.sql_text ? q.sql_text.substring(0, 100) : '';
      return `  ${i + 1}. 平均: ${avgTime}ms, 最大: ${maxTime}ms, 执行: ${count}次, 扫描行数: ${rowsExam} | ${sql}`;
    });

    return `Top ${Math.min(queries.length, 10)} 慢查询:\n${lines.join('\n')}`;
  }

  /**
   * @deprecated Replaced by dispatchOrReuse Agent path
   * 格式化最近告警
   */
  private _formatRecentAlerts(alerts: any[]): string {
    if (!alerts || alerts.length === 0) return '无最近告警';

    const lines = alerts.slice(0, 10).map((a, i) => {
      const level = a.level || a.severity || 'unknown';
      const title = a.title || 'Unknown';
      const time = a.created_at
        ? new Date(a.created_at).toLocaleString('zh-CN')
        : '';
      return `  ${i + 1}. [${level.toUpperCase()}] ${title} (${time})`;
    });

    return `最近 ${alerts.length} 条告警:\n${lines.join('\n')}`;
  }

  /**
   * @deprecated Replaced by dispatchOrReuse Agent path
   * 获取索引状态
   */
  private async _getIndexStatus(instanceId: number): Promise<string> {
    const pool = dbConnection.getPool();
    if (!pool) return '索引状态数据不可用';

    try {
      const [rows] = await pool.execute(
        `SELECT table_schema, table_name, index_name, cardinality,
                non_unique, index_type, seq_in_index, column_name
         FROM index_info
         WHERE instance_id = ?
         ORDER BY table_schema, table_name, index_name
         LIMIT 100`,
        [instanceId]
      ) as any;

      if (!Array.isArray(rows) || rows.length === 0) {
        return '未采集到索引信息';
      }

      // 统计：总数、主键、唯一、普通
      const uniqueCount = rows.filter((r: any) => r.non_unique === 0).length;
      const normalCount = rows.filter((r: any) => r.non_unique !== 0 && r.index_name !== 'PRIMARY').length;
      const pkCount = rows.filter((r: any) => r.index_name === 'PRIMARY').length;

      // 查找可能缺失索引的表（rows_examined > 10000 但无索引）
      const indexSummary = `共 ${rows.length} 个索引记录 (主键: ${pkCount}, 唯一: ${uniqueCount}, 普通: ${normalCount})`;
      return indexSummary;
    } catch {
      return '索引状态数据不可用';
    }
  }

  /**
   * @deprecated Replaced by dispatchOrReuse Agent path
   * 获取复制状态
   */
  private async _getReplicationStatus(instanceId: number): Promise<string> {
    try {
      const conn = databaseService.getConnection(instanceId);
      if (!conn) return '无法获取数据库连接';

      const [rows] = await conn.pool!.execute('SHOW SLAVE STATUS') as any;
      if (!Array.isArray(rows) || rows.length === 0) {
        return '该实例未配置复制（或非从库）';
      }

      const results = rows.slice(0, 3).map((r: any, i: number) => {
        const ioRunning = r.Slave_IO_Running || 'Unknown';
        const sqlRunning = r.Slave_SQL_Running || 'Unknown';
        const lag = r.Seconds_Behind_Master ?? 'N/A';
        const masterHost = r.Master_Host || 'N/A';
        return `  ${i + 1}. Master: ${masterHost}, IO: ${ioRunning}, SQL: ${sqlRunning}, 延迟: ${lag}s`;
      });

      return `复制状态 (${rows.length} 个从库):\n${results.join('\n')}`;
    } catch {
      return '复制状态数据不可用';
    }
  }

  /**
   * @deprecated Replaced by dispatchOrReuse Agent path
   * 构建故障诊断 Prompt
   */
  buildFaultDiagnosisPrompt(
    instanceInfo: InstanceInfo,
    healthText: string,
    metricsText: string,
    sessionsText: string,
    slowQueriesText: string,
    recentAlertsText: string,
    indexText: string,
    replicationText: string
  ): string {
    const lines = [
      '## 实例信息',
      `- 实例名称: ${instanceInfo.name}`,
      `- 数据库类型: ${instanceInfo.db_type}`,
      `- 环境: ${instanceInfo.environment}`,
      '',
      '## 健康评分',
      healthText,
      '',
      '## 最近 30 分钟指标趋势',
      metricsText,
      '',
      '## 活跃会话',
      sessionsText,
      '',
      '## 慢查询 (Top 10)',
      slowQueriesText,
      '',
      '## 最近告警',
      recentAlertsText,
      '',
      '## 索引状态',
      indexText,
      '',
      '## 复制状态',
      replicationText,
      '',
      '请对以上数据库实例进行全面诊断，找出潜在问题并提供修复建议。',
    ];

    return lines.join('\n');
  }
}

/**
 * @deprecated Replaced by dispatchOrReuse Agent path
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

// 单例
export const faultDiagnosisService = new FaultDiagnosisService();
export { FaultDiagnosisService };
