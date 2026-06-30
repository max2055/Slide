/**
 * 故障自动诊断服务
 * 对数据库实例进行全面诊断，收集多维度数据并生成诊断报告
 */
import { dbConnection } from './db-connection.js';
import { dispatchOrReuse } from './ai-agent-bridge.js';
import { aiAnalysisDatabaseService } from './ai-analysis-database-service.js';
import { databaseService } from './database-service.js';
import { instanceDatabaseService } from './instance-database-service.js';

// In-memory lock to prevent concurrent duplicate diagnoses
const pendingDiagnoses = new Set<string>();

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

      // g. 通过 Agent 执行诊断
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
}

// 单例
export const faultDiagnosisService = new FaultDiagnosisService();
export { FaultDiagnosisService };
