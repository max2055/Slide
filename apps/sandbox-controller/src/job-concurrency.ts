export interface JobConcurrencyLease {
  release(): void;
}

export class JobConcurrencyLimiter {
  private activeJobs = 0;

  constructor(private readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('SANDBOX_CONCURRENCY_LIMIT_INVALID');
  }

  get active(): number {
    return this.activeJobs;
  }

  tryAcquire(): JobConcurrencyLease | undefined {
    if (this.activeJobs >= this.maximum) return undefined;
    this.activeJobs += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.activeJobs -= 1;
      },
    };
  }
}
