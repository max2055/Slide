import type { LLMResponse } from '../types.js';
import { AnomalyGuard } from './anomaly-guard.js';

export type CandidateDecision = 'error' | 'unresolved_tools' | 'empty' | 'repetition' | 'length' | 'accept';
export class CompletionSupervisor {
  private guard = new AnomalyGuard();
  private rejected = 0;
  classify(response: LLMResponse, content: string, request: string, epoch: number, mode: 'enforce' | 'observe'): CandidateDecision {
    if (response.finishReason === 'error' || response.error || response.errorKind) return 'error';
    if (response.toolCalls.length || response.hasToolCalls || response.finishReason === 'tool_calls') return 'unresolved_tools';
    if (!['stop', 'end_turn', 'stop_sequence', 'length'].includes(response.finishReason)) return 'error';
    if (!content.trim()) return 'empty';
    const anomaly = this.guard.inspect(content, request, epoch);
    if (anomaly.repeated && mode === 'enforce') return 'repetition';
    if (response.finishReason === 'length') return 'length';
    return 'accept';
  }
  recoverRepetition(): boolean { return ++this.rejected <= 2; }
  reminder(): string {
    return this.rejected === 1
      ? '[Runtime: The previous candidate repeated itself. Give a concise substantive answer using available evidence; do not repeat the rejected text.]'
      : '[Runtime: Start a fresh concise answer using the original request and tool evidence. Avoid repetitive narration.]';
  }
}
