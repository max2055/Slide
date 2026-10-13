import { authFetch } from '../../../api/index.ts';
import type { MessageParts } from '../../../../../packages/agent-core/src/message-parts.ts';
import type { MessageProjection, ProjectionDocument } from '../../../../../packages/agent-core/src/message-projection.ts';
import type { InvestigationAccepted, InvestigationCreateRequest, InvestigationEvidence, InvestigationLifecycle,
  InvestigationProblemStatus, InvestigationResultPage, InvestigationExecutionState } from '../../../api/generated/public-api.ts';

export type { InvestigationAccepted, InvestigationCreateRequest, InvestigationEvidence, InvestigationResultPage };
export interface InvestigationRecord {
  id: string; sessionId: string; title: string; goal: string; profileId: 'ops' | 'system'; version: number;
  lifecycle: InvestigationLifecycle; problemStatus: InvestigationProblemStatus; activeRequestId: string | null;
  resources: InvestigationCreateRequest['resourceRefs']; owner: { kind: string; id: number };
  derivedRunState?: InvestigationExecutionState | null; createdAt: string; updatedAt: string;
}
export interface InvestigationList {
  items: InvestigationRecord[]; authorizedCounts: { total: number }; nextCursor: string | null;
}
export interface InvestigationSnapshot {
  investigationId: string; watermark: number; documents: MessageParts[];
  metadata: Pick<InvestigationRecord, 'version' | 'lifecycle' | 'problemStatus'>;
  runs: Array<{ requestId: string; runId: string; state: string; resolution: 'known' | 'outcome_unknown' }>;
  projection: { runs: Record<string, MessageProjection>; documents: ProjectionDocument[] };
  evidenceIds: string[]; truncated: boolean; nextBefore: string | null;
}
export interface FactPage { documents: MessageParts[]; nextBefore: string | null; }
export type InvestigationMessage = Record<string, unknown> & { id: string; messageParts?: MessageParts };
export const factMessages = (page: FactPage): InvestigationMessage[] => page.documents.map(doc => ({ ...doc.legacy, id: doc.id, role: doc.role, runId: doc.runId, messageParts: doc }));
export class InvestigationApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export async function investigationApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await authFetch(`/api/investigations${path}`, { ...options, cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...options.headers } });
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    throw new InvestigationApiError(response.status, value.error ?? `HTTP_${response.status}`);
  }
  return response.json() as Promise<T>;
}
export function investigationErrorText(error: unknown): string {
  if (!(error instanceof InvestigationApiError)) return '连接失败，结果尚未确认。请重试核对原请求。';
  const messages: Record<string, string> = {
    INVESTIGATION_NOT_FOUND: '调查不存在或已无访问权限。', INVESTIGATION_OPERATION_FORBIDDEN: '当前用户没有调查操作权限。',
    VERSION_CONFLICT: '调查已更新，请刷新后再操作。', INVESTIGATION_ACTIVE_REQUEST: '已有执行进行中，请等待结束后继续。',
    INVESTIGATION_INPUT_INVALID: '请检查目标、资源和时间范围。', PROFILE_SUBJECT_UNSUPPORTED: '该 Profile 不支持此调查对象。',
    INVESTIGATION_BUDGET_EXHAUSTED: '调查预算已用尽。', INVESTIGATION_RATE_LIMITED: '调查请求过于频繁，请稍后再试。',
    INVESTIGATION_QUEUE_UNAVAILABLE: '调查服务暂不可用，接受结果尚未确认。请核对原请求。',
    EVIDENCE_EXPIRED: '证据原文已过期，保留元数据和引用。',
  };
  return messages[error.code] ?? (error.status === 401 ? '登录已失效，请重新登录。' : '调查请求失败，请刷新重试。');
}
