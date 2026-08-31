import type { ActorContext } from '../auth/actor-context.js';
import { dispatchOrReuse } from '../ai-agent-bridge.js';
import { aiAnalysisDatabaseService } from '../ai-analysis-database-service.js';
import { resourceDiagnosticService, type ResourceDiagnosticService } from './resource-diagnostic-service.js';
import type { ResourceRef, ResourceType } from './types.js';

export interface ResourceAgentDiagnosisResult {
  success: boolean;
  analysisId?: number;
  status?: 'queued' | 'cached';
  error?: string;
}

type AnalysisStore = Pick<typeof aiAnalysisDatabaseService,
  'findByCacheKey' | 'createAnalysis' | 'updateStatus' | 'markDispatched'>;

export interface ResourceAgentDiagnosisDependencies {
  evidence: Pick<ResourceDiagnosticService, 'diagnose'>;
  analysisStore: AnalysisStore;
  dispatch: typeof dispatchOrReuse;
  now: () => Date;
}

function subjectFields(ref: ResourceRef): { instance_id?: number; server_id?: number; network_device_id?: number } {
  if (ref.type === 'instance') return { instance_id: ref.id };
  if (ref.type === 'server') return { server_id: ref.id };
  return { network_device_id: ref.id };
}

function dispatchSubjectFields(ref: ResourceRef): { instanceId?: number; serverId?: number; networkDeviceId?: number } {
  if (ref.type === 'instance') return { instanceId: ref.id };
  if (ref.type === 'server') return { serverId: ref.id };
  return { networkDeviceId: ref.id };
}

export class ResourceAgentDiagnosisService {
  constructor(
    private readonly dependencies: ResourceAgentDiagnosisDependencies = {
      evidence: resourceDiagnosticService,
      analysisStore: aiAnalysisDatabaseService,
      dispatch: dispatchOrReuse,
      now: () => new Date(),
    },
  ) {}

  async diagnose(actor: ActorContext, ref: ResourceRef): Promise<ResourceAgentDiagnosisResult> {
    const evidence = await this.dependencies.evidence.diagnose(actor, ref);
    const cacheKey = `resource:${ref.type}:${ref.id}:${this.dependencies.now().toISOString().slice(0, 13)}`;
    const cached = await this.dependencies.analysisStore.findByCacheKey(cacheKey);
    if (cached?.id) return { success: true, analysisId: cached.id, status: 'cached' };

    const created = await this.dependencies.analysisStore.createAnalysis({
      analysis_type: 'fault_diagnosis',
      ...subjectFields(ref),
      trigger_type: 'manual',
      cache_key: cacheKey,
    });
    if (!created.success || !created.analysisId) return { success: false, error: created.error || 'CREATE_ANALYSIS_FAILED' };
    const analysisId = created.analysisId;
    const running = await this.dependencies.analysisStore.updateStatus(analysisId, 'running');
    if (!running.success) return { success: false, analysisId, error: running.error || 'UPDATE_ANALYSIS_STATUS_FAILED' };

    const sessionKey = `resource-diagnosis-${ref.type}-${ref.id}-${analysisId}`;
    try {
      await this.dependencies.dispatch({
        type: 'resource_diagnosis',
        resourceType: ref.type as ResourceType,
        resourceId: ref.id,
        ...dispatchSubjectFields(ref),
        cacheKey,
        sessionKey,
        existingAnalysisId: analysisId,
        diagnosticContext: evidence,
        userMessage: `请仅依据随请求提供的跨资源 diagnosticContext 诊断 ${ref.type} #${ref.id}。按时间、质量和关系影响范围排序证据；缺失证据保持未知，完成后保存结构化结果。`,
      });
      const marked = await this.dependencies.analysisStore.markDispatched(analysisId, sessionKey);
      if (!marked) return { success: false, analysisId, error: 'DISPATCH_MARKER_UNCONFIRMED' };
      return { success: true, analysisId, status: 'queued' };
    } catch (error) {
      return { success: false, analysisId, error: error instanceof Error ? error.message : 'DISPATCH_FAILED' };
    }
  }
}

export const resourceAgentDiagnosisService = new ResourceAgentDiagnosisService();
