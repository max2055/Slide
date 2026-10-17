import type { Observation, Computation } from './observation.js';

export interface CounterState {
  series: string;
  segment: string;
  processing_revision: string;
  baseline: Observation;
}
export interface StateSnapshot { revision: string; state: CounterState | null }
/** Production adapter must atomically fence, compare revision, and save state + output + receipt.
 * Receipt lookup precedes calculation: same id/payload returns the ORIGINAL output, changed payload conflicts.
 * Revision protects the logical series (not a source-specific subkey); fencing tokens are monotonically increasing.
 * No database, lease service or exactly-once external effects are implemented by this interface.
 */
export interface CounterStateAdapter {
  load(series: string, replayNamespace: string): Promise<StateSnapshot>;
  receipt(inputId: string, replayNamespace: string): Promise<{ payloadDigest: string; outputs: Computation[] } | null>;
  commit(request: {
    series: string; replayNamespace: string; expectedRevision: string; fencingToken: string;
    state: CounterState | null; inputId: string; payloadDigest: string; outputs: Computation[];
  }): Promise<'committed' | 'replayed' | 'revision_conflict' | 'fenced' | 'payload_conflict'>;
}
