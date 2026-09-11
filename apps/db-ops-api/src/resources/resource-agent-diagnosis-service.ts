import { createHash } from 'node:crypto';
import { canReadResource } from './resource-service.js';
import { redactSensitiveData } from '../security/sensitive-data.js';
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
  readAnalysis?: typeof aiAnalysisDatabaseService.getAnalysisById;
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
      readAnalysis: (id) => aiAnalysisDatabaseService.getAnalysisById(id),
    },
  ) {}

  private cachePrefix(actor: ActorContext, ref: ResourceRef): string {
    const access = createHash('sha256').update(JSON.stringify([actor.userId, actor.sessionVersion, [...actor.permissions].sort(), Object.entries(actor.instanceScopes).sort()])).digest('hex').slice(0, 24);
    return `resource:${ref.type}:${ref.id}:${access}:`;
  }

  async result(actor: ActorContext, ref: ResourceRef, analysisId: number) {
    if (!canReadResource(actor, ref)) throw new Error('RESOURCE_FORBIDDEN');
    if (!Number.isSafeInteger(analysisId) || analysisId <= 0) throw new Error('ANALYSIS_ID_INVALID');
    const record = await this.dependencies.readAnalysis?.(analysisId);
    const subject = record && (ref.type === 'instance' ? record.instance_id : ref.type === 'server' ? record.server_id : record.network_device_id);
    // Results may contain related-resource context. Bind reads to the same
    // actor and permission snapshot that created the bounded diagnostic pack.
    if (!record || Number(subject) !== ref.id || !record.cache_key?.startsWith(this.cachePrefix(actor, ref))) throw new Error('RESOURCE_NOT_FOUND');
    return {
      analysisId: record.id, resource: ref, status: record.status,
      createdAt: record.created_at, completedAt: record.completed_at,
      result: redactSensitiveData(record.result),
      error: record.status === 'failed' ? '诊断执行失败，请查看任务日志或重试' : null,
      contextLabel: '历史诊断上下文',
    };
  }

  async diagnose(actor: ActorContext, ref: ResourceRef): Promise<ResourceAgentDiagnosisResult> {
    const evidence = await this.dependencies.evidence.diagnose(actor, ref);
    const cacheKey = `${this.cachePrefix(actor, ref)}${this.dependencies.now().toISOString().slice(0, 13)}`;
    const cached = await this.dependencies.analysisStore.findByCacheKey(cacheKey);
    if (cached?.id && cached.status !== 'failed') return { success: true, analysisId: cached.id, status: 'cached' };

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
