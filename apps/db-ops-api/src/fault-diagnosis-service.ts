import { assertWorkflowActive } from './workflows/execution-context.js';
/**
 * Fault diagnosis orchestration.
 * Evidence is collected under the requesting actor before any analysis row is created.
 */
import { randomUUID } from 'node:crypto';
import type { ActorContext } from './auth/actor-context.js';
import { dispatchOrReuse } from './ai-agent-bridge.js';
import { aiAnalysisDatabaseService } from './ai-analysis-database-service.js';
import { databaseService } from './database-service.js';
import { instanceDatabaseService } from './instance-database-service.js';
import {
  instanceDiagnosticContextService,
  type InstanceDiagnosticContext,
  type InstanceDiagnosticContextService,
} from './instance-diagnostic-context-service.js';

type FaultDiagnosisTrigger = 'manual' | 'auto';
type FaultDiagnosisStatus = 'queued' | 'in_progress' | 'unknown';
type FaultDiagnosisResult = { success: boolean; analysisId?: number; error?: string; status?: FaultDiagnosisStatus };

type FaultAnalysisStore = Pick<typeof aiAnalysisDatabaseService, 'getAnalysisList' | 'getAnalysisStats'>;

export interface FaultDiagnosisDependencies {
  listActiveInstances: () => Promise<readonly { id: number }[]>;
  checkHealth: (instanceId: number) => Promise<{ status: string } | null>;
  randomUUID: () => string;
  contextCollector: Pick<InstanceDiagnosticContextService, 'collect'>;
  analysisStore: FaultAnalysisStore;
  dispatch: typeof dispatchOrReuse;
}

const defaultDependencies: FaultDiagnosisDependencies = {
  listActiveInstances: async () => (await instanceDatabaseService.listActiveInstanceIds()).map((id) => ({ id })),
  checkHealth: (instanceId) => databaseService.checkHealth(instanceId),
  randomUUID,
  contextCollector: instanceDiagnosticContextService,
  analysisStore: aiAnalysisDatabaseService,
  dispatch: dispatchOrReuse,
};

export class FaultDiagnosisService {
  constructor(private readonly dependencies: FaultDiagnosisDependencies = defaultDependencies) {}

  async diagnoseInstance(
    actor: ActorContext,
    instanceId: number,
    retryOf?: number,
  ): Promise<FaultDiagnosisResult> {
    return this.diagnose(actor, instanceId, 'manual', retryOf);
  }

  async diagnoseUnhealthyInstances(): Promise<number[]> {
    assertWorkflowActive();
    const instances = await this.dependencies.listActiveInstances();
    const analysisIds: number[] = [];
    const failedInstanceIds: number[] = [];
    for (const instance of instances) {
      try {
        assertWorkflowActive();
        const health = await this.dependencies.checkHealth(instance.id);
        if (!health || health.status === 'healthy') continue;
        const actor: ActorContext = Object.freeze({
          userId: 0,
          username: 'slide-fault-diagnosis',
          roles: Object.freeze(['system']),
          permissions: Object.freeze([
            'instance:view',
            'metric:view',
            'alert:view',
            'log:view',
            'servers:view',
          ]),
          sessionVersion: 0,
          instanceScopes: Object.freeze({ [instance.id]: 'read-only' as const }),
          requestId: `fault-diagnosis:${instance.id}:${this.dependencies.randomUUID()}`,
        });
        assertWorkflowActive();
        const result = await this.diagnose(actor, instance.id, 'auto');
        if (result.status === 'in_progress') continue;
        if (result.success && result.analysisId !== undefined) {
          analysisIds.push(result.analysisId);
        } else {
          failedInstanceIds.push(instance.id);
        }
      } catch {
        assertWorkflowActive();
        failedInstanceIds.push(instance.id);
      }
    }
    if (failedInstanceIds.length > 0) {
      throw new Error(`FAULT_DIAGNOSIS_BATCH_FAILED:${failedInstanceIds.join(',')}`);
    }
    return analysisIds;
  }

  private async diagnose(
    actor: ActorContext,
    instanceId: number,
    trigger: FaultDiagnosisTrigger,
    retryOf?: number,
  ): Promise<FaultDiagnosisResult> {
    if (!Number.isSafeInteger(instanceId) || instanceId <= 0) throw new Error('RESOURCE_REF_INVALID');
    assertWorkflowActive();
    const diagnosticContext = await this.dependencies.contextCollector.collect(actor, instanceId);
    if (diagnosticContext.subject?.type !== 'instance' || diagnosticContext.subject.id !== instanceId) throw new Error('DIAGNOSTIC_CONTEXT_SUBJECT_MISMATCH');
    const instance = diagnosticContext.database.instance;
    const name = stringMetadata(instance, 'name') || `instance-${instanceId}`;
    const databaseType = stringMetadata(instance, 'db_type') || 'unknown';
    const environment = stringMetadata(instance, 'environment') || 'unknown';
    assertWorkflowActive();
    const result = await this.dependencies.dispatch({
      type: 'fault_diagnosis', cacheKey: this.buildCacheKey(actor, instanceId, trigger), instanceId,
      sessionKey: 'diagnosis', triggerType: trigger, diagnosticContext, actor, retryOf,
      userMessage: `请仅依据随请求提供的 diagnosticContext 分析实例 "${name}" `
        + `(${databaseType}, ${environment}) 的故障证据。缺失证据必须保持未知；完成后保存结构化诊断结果。`,
    });
    if (result.status === 'unknown') return { success: false, analysisId: result.analysisId, status: 'unknown', error: 'ANALYSIS_PROVIDER_RESULT_UNKNOWN：重试可能再次计费，需要明确确认' };
    return { success: true, analysisId: result.analysisId, status: result.status === 'running' ? 'in_progress' : 'queued' };
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

  private buildCacheKey(actor: ActorContext, instanceId: number, trigger: FaultDiagnosisTrigger): string {
    const currentHour = new Date().toISOString().slice(0, 13);
    return `fault:${instanceId}:${currentHour}:${trigger}:user:${actor.userId}:session:${actor.sessionVersion}`;
  }

}

function stringMetadata(instance: InstanceDiagnosticContext['database']['instance'], key: string): string | null {
  const value = instance?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

export const faultDiagnosisService = new FaultDiagnosisService();
