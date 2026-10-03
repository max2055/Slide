import type { LLMProvider, Message, ToolSchema } from '@slide/agent-core';
import { evidenceHash } from './analysis-evidence.js';

export const ANALYSIS_TOOL_VERSION = 'complete-analysis/binding-v2';
export interface ProviderIdentity { provider: string; providerId?: number; routeVersion: string }
const identities = new WeakMap<LLMProvider, ProviderIdentity>();
export function setAnalysisProviderIdentity(provider: LLMProvider, identity: ProviderIdentity): void { identities.set(provider, identity); }
export function analysisProviderIdentity(provider: LLMProvider): ProviderIdentity {
  return identities.get(provider) ?? { provider: 'unavailable', routeVersion: 'unavailable' };
}
export interface AnalysisExecutionRequest {
  provider: string; providerId?: number; routeVersion: string; model: string;
  promptHash: string; inputHash: string; toolVersions: Record<string, string>;
  requestNumber: number; startedAt: string;
}
export type AnalysisExecutionEvent = { kind: 'request'; request: AnalysisExecutionRequest }
  | { kind: 'response'; requestNumber: number; usage: Record<string, number> | null }
  | { kind: 'finalized' };
export interface AnalysisExecutionTrace {
  schemaVersion: 1; analysisId: number; attemptNumber: number; runtimeRunId: string;
  requests: Array<AnalysisExecutionRequest & { usage?: Record<string, number> | null }>;
  finalized: boolean;
}
export function executionRequest(provider: LLMProvider, messages: Message[], tools: ToolSchema[], model: string, requestNumber: number): AnalysisExecutionRequest {
  return { ...analysisProviderIdentity(provider), model, requestNumber, startedAt: new Date().toISOString(),
    promptHash: evidenceHash({ system: messages.filter(m => m.role === 'system'), tools }),
    inputHash: evidenceHash(messages), toolVersions: tools.length ? { slide_complete_analysis: ANALYSIS_TOOL_VERSION } : {} };
}
