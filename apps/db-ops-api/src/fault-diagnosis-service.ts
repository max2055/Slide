/**
 * Manual fault diagnosis orchestration.
 * Evidence is collected under the requesting actor before any analysis row is created.
 */
import type { ActorContext } from './auth/actor-context.js';
import { dispatchOrReuse } from './ai-agent-bridge.js';
import { aiAnalysisDatabaseService } from './ai-analysis-database-service.js';
import {
  instanceDiagnosticContextService,
  type InstanceDiagnosticContext,
  type InstanceDiagnosticContextService,
} from './instance-diagnostic-context-service.js';

const pendingDiagnoses = new Set<string>();

type FaultAnalysisStore = Pick<typeof aiAnalysisDatabaseService,
  'findByCacheKey' | 'createAnalysis' | 'updateStatus' | 'failAnalysis' | 'waitForCompletion'
  | 'getAnalysisList' | 'getAnalysisStats'>;

export interface FaultDiagnosisDependencies {
  contextCollector: Pick<InstanceDiagnosticContextService, 'collect'>;
  analysisStore: FaultAnalysisStore;
  dispatch: typeof dispatchOrReuse;
}

const defaultDependencies: FaultDiagnosisDependencies = {
  contextCollector: instanceDiagnosticContextService,
  analysisStore: aiAnalysisDatabaseService,
  dispatch: dispatchOrReuse,
};

export class FaultDiagnosisService {
  constructor(private readonly dependencies: FaultDiagnosisDependencies = defaultDependencies) {}

  async diagnoseInstance(
    actor: ActorContext,
    instanceId: number,
  ): Promise<{ success: boolean; analysisId?: number; error?: string; status?: string }> {
    if (!Number.isSafeInteger(instanceId) || instanceId <= 0) throw new Error('RESOURCE_REF_INVALID');
    const pendingKey = this.buildPendingKey(actor, instanceId);
    const cacheKey = this.buildCacheKey(actor, instanceId);
    if (pendingDiagnoses.has(pendingKey)) {
      return { success: false, error: '诊断正在创建中，请稍后重试' };
    }
    pendingDiagnoses.add(pendingKey);
    let releasePendingOnReturn = true;

    try {
      const diagnosticContext = await this.dependencies.contextCollector.collect(actor, instanceId);

      const cached = await this.dependencies.analysisStore.findByCacheKey(cacheKey);
      if (cached?.result) return { success: true, analysisId: cached.id };

      const createResult = await this.dependencies.analysisStore.createAnalysis({
        analysis_type: 'fault_diagnosis',
        instance_id: instanceId,
        trigger_type: 'manual',
        cache_key: cacheKey,
      });
      if (!createResult.success || !createResult.analysisId) {
        return { success: false, error: createResult.error || 'CREATE_ANALYSIS_FAILED' };
      }
      const analysisId = createResult.analysisId;

      const running = await this.dependencies.analysisStore.updateStatus(analysisId, 'running');
      if (!running.success) {
        const error = running.error || 'UPDATE_ANALYSIS_STATUS_FAILED';
        await this.dependencies.analysisStore.failAnalysis(analysisId, error).catch(() => {});
        return { success: false, error };
      }

      const instance = diagnosticContext.database.instance;
      const name = stringMetadata(instance, 'name') || `instance-${instanceId}`;
      const databaseType = stringMetadata(instance, 'db_type') || 'unknown';
      const environment = stringMetadata(instance, 'environment') || 'unknown';
      try {
        await this.dependencies.dispatch({
          type: 'fault_diagnosis',
          cacheKey,
          instanceId,
          sessionKey: `diagnosis-${analysisId}`,
          triggerType: 'manual',
          existingAnalysisId: analysisId,
          diagnosticContext,
          userMessage: `请仅依据随请求提供的 diagnosticContext 分析实例 "${name}" `
            + `(${databaseType}, ${environment}) 的故障证据。缺失证据必须保持未知；完成后保存结构化诊断结果。`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[FaultDiagnosis] Agent 诊断 ${analysisId} 失败:`, message);
        await this.dependencies.analysisStore.failAnalysis(analysisId, message).catch(() => {});
        return { success: false, error: message };
      }

      releasePendingOnReturn = false;
      this.monitorCompletion(analysisId, pendingKey);

      return { success: true, analysisId, status: 'queued' };
    } finally {
      if (releasePendingOnReturn) pendingDiagnoses.delete(pendingKey);
    }
  }

  async getDiagnosisHistory(instanceId: number, limit: number = 10): Promise<any[]> {
    return this.dependencies.analysisStore.getAnalysisList({
      analysis_type: 'fault_diagnosis',
      instance_id: instanceId,
      limit,
    });
  }

  async getLatestDiagnosis(instanceId: number): Promise<any> {
    const results = await this.getDiagnosisHistory(instanceId, 1);
    return results.length > 0 ? results[0] : null;
  }

  async getStatus(): Promise<any> {
    return this.dependencies.analysisStore.getAnalysisStats('fault_diagnosis');
  }

  private buildCacheKey(actor: ActorContext, instanceId: number): string {
    const currentHour = new Date().toISOString().slice(0, 13);
    return `fault:${instanceId}:${currentHour}:manual:user:${actor.userId}:session:${actor.sessionVersion}`;
  }

  private buildPendingKey(actor: ActorContext, instanceId: number): string {
    return `fault:${instanceId}:pending:manual:user:${actor.userId}:session:${actor.sessionVersion}`;
  }

  private monitorCompletion(analysisId: number, pendingKey: string): void {
    void Promise.resolve()
      .then(() => this.dependencies.analysisStore.waitForCompletion(analysisId, 120_000))
      .then((record) => record?.status === 'completed' || record?.status === 'failed')
      .catch(() => false)
      .then((terminal) => {
        if (terminal) {
          pendingDiagnoses.delete(pendingKey);
          return;
        }
        const retry = setTimeout(() => this.monitorCompletion(analysisId, pendingKey), 2_000);
        retry.unref();
      });
  }
}

function stringMetadata(instance: InstanceDiagnosticContext['database']['instance'], key: string): string | null {
  const value = instance?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

export const faultDiagnosisService = new FaultDiagnosisService();
