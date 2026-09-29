import { RuntimeError } from "./recovery-policy.js";
export interface CompactState {
  schemaVersion: 1;
  compactCount: number;
  successfulCompacts: number;
  toolBatchesSinceCompact: number;
  rapidRefills: number;
}
export class RapidRefill {
  private state: CompactState;
  constructor(value?: unknown) {
    const s = value as CompactState | undefined;
    if (
      s !== undefined &&
      (!s ||
        s.schemaVersion !== 1 ||
        ![s.compactCount, s.successfulCompacts, s.toolBatchesSinceCompact, s.rapidRefills].every(
          (n) => Number.isSafeInteger(n) && n >= 0,
        ) ||
        s.successfulCompacts > s.compactCount ||
        s.rapidRefills > 3)
    ) {
      throw new RuntimeError("INVALID_CHECKPOINT", "Invalid compact checkpoint");
    }
    this.state = s
      ? {
          schemaVersion: 1,
          compactCount: s.compactCount,
          successfulCompacts: s.successfulCompacts,
          toolBatchesSinceCompact: s.toolBatchesSinceCompact,
          rapidRefills: s.rapidRefills,
        }
      : {
          schemaVersion: 1,
          compactCount: 0,
          successfulCompacts: 0,
          toolBatchesSinceCompact: 0,
          rapidRefills: 0,
        };
  }
  begin(): void {
    const s = this.state;
    if (s.successfulCompacts)
      s.rapidRefills = s.toolBatchesSinceCompact < 3 ? s.rapidRefills + 1 : 0;
    if (s.rapidRefills >= 3) {
      s.rapidRefills = 3;
      throw new RuntimeError("CONTEXT_RAPID_REFILL", "CONTEXT_RAPID_REFILL");
    }
    s.compactCount++;
  }
  commit(): void {
    this.state.successfulCompacts++;
    this.state.toolBatchesSinceCompact = 0;
  }
  completeBatch(): void {
    this.state.toolBatchesSinceCompact++;
  }
  snapshot(): CompactState {
    return { ...this.state };
  }
}
