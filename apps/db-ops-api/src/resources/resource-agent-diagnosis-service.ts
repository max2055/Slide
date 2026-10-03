import { createHash } from 'node:crypto';
import { canReadResource } from './resource-service.js';
import { redactSensitiveData } from '../security/sensitive-data.js';
import type { ActorContext } from '../auth/actor-context.js';
import { dispatchOrReuse } from '../ai-agent-bridge.js';
import { aiAnalysisDatabaseService } from '../ai-analysis-database-service.js';
import { resourceDiagnosticService, type ResourceDiagnosticService } from './resource-diagnostic-service.js';
import type { ResourceRef, ResourceType } from './types.js';
import { analysisAuthorizationVersion } from '../analysis/analysis-identity.js';

export interface ResourceAgentDiagnosisResult {
  success: boolean;
  analysisId?: number;
  status?: 'queued' | 'cached' | 'unknown';
  error?: string;
}

export interface ResourceAgentDiagnosisDependencies {
  evidence: Pick<ResourceDiagnosticService, 'diagnose'>;
  dispatch: typeof dispatchOrReuse;
  now: () => Date;
  readAnalysis?: typeof aiAnalysisDatabaseService.getAnalysisById;
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
    const sameSnapshot = record && (record.cache_key?.startsWith(this.cachePrefix(actor, ref))
      || (Number(record.request_actor_id) === actor.userId && record.authorization_version === analysisAuthorizationVersion(actor)));
    const legacyUnknown = record?.status === 'unknown' && ref.type === 'instance'
      && record.cache_key?.startsWith(`fault:${ref.id}:`) && record.cache_key?.endsWith(`:manual:user:${actor.userId}:session:${actor.sessionVersion}`);
    if (!record || Number(subject) !== ref.id || (!sameSnapshot && !legacyUnknown)) throw new Error('RESOURCE_NOT_FOUND');
    return {
      analysisId: record.id, resource: ref, status: record.status,
      createdAt: record.created_at, completedAt: record.completed_at,
      result: legacyUnknown && !sameSnapshot ? null : redactSensitiveData(record.result),
      error: record.status === 'unknown' ? '供应商可能已经执行，结果未知；重试可能再次计费，需要明确确认' : record.status === 'failed' ? '诊断执行失败，请查看任务日志或重试' : null,
      contextLabel: '历史诊断上下文',
    };
  }

  async diagnose(actor: ActorContext, ref: ResourceRef, retryOf?: number): Promise<ResourceAgentDiagnosisResult> {
    const evidence = await this.dependencies.evidence.diagnose(actor, ref);
    const cacheKey = `${this.cachePrefix(actor, ref)}${this.dependencies.now().toISOString().slice(0, 13)}`;
    const accepted = await this.dependencies.dispatch({
      type: 'resource_diagnosis', resourceType: ref.type as ResourceType, resourceId: ref.id,
      ...dispatchSubjectFields(ref), cacheKey, sessionKey: `resource-diagnosis-${ref.type}-${ref.id}`,
      diagnosticContext: evidence, actor, retryOf,
      userMessage: `请仅依据随请求提供的跨资源 diagnosticContext 诊断 ${ref.type} #${ref.id}。按时间、质量和关系影响范围排序证据；缺失证据保持未知，完成后保存结构化结果。`,
    });
    return {
      success: accepted.success !== false, analysisId: accepted.analysisId,
      status: accepted.status === 'unknown' ? 'unknown' : accepted.cached ? 'cached' : 'queued',
      ...(accepted.status === 'unknown' ? { error: 'ANALYSIS_PROVIDER_RESULT_UNKNOWN：重试可能再次计费，需要明确确认' } : {}),
    };
  }
}

export const resourceAgentDiagnosisService = new ResourceAgentDiagnosisService();
