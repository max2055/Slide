export interface SandboxJobSummary {
  jobId: string;
  runtime: string;
  status: 'succeeded' | 'failed' | 'timed_out';
  exitCode: number | null;
  timedOut: boolean;
  outputTruncated: boolean;
  createdAt: string;
  completedAt: string;
  durationMs: number;
}

export class SandboxJobHistory {
  private readonly entries: SandboxJobSummary[] = [];

  constructor(private readonly capacity = 50) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1000) throw new Error('SANDBOX_HISTORY_CAPACITY_INVALID');
  }

  add(entry: SandboxJobSummary): void {
    this.entries.unshift(Object.freeze({ ...entry }));
    if (this.entries.length > this.capacity) this.entries.length = this.capacity;
  }

  list(limit = 20): SandboxJobSummary[] {
    const bounded = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), this.capacity) : 20;
    return this.entries.slice(0, bounded).map((entry) => ({ ...entry }));
  }
}
