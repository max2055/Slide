function boundedInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

export interface AgentRuntimeLimits {
  wsMaxPayloadBytes: number;
  wsFramesPerWindow: number;
  wsRateWindowMs: number;
  authTimeoutMs: number;
  maxMessageChars: number;
  maxConcurrentRunsPerActor: number;
  runTimeoutMs: number;
  maxIterations: number;
  maxToolResultChars: number;
}

export function loadAgentRuntimeLimits(): AgentRuntimeLimits {
  return Object.freeze({
    wsMaxPayloadBytes: boundedInt('AGENT_WS_MAX_PAYLOAD_BYTES', 64 * 1024, 4 * 1024, 1024 * 1024),
    wsFramesPerWindow: boundedInt('AGENT_WS_FRAMES_PER_WINDOW', 60, 5, 1000),
    wsRateWindowMs: boundedInt('AGENT_WS_RATE_WINDOW_MS', 10_000, 1000, 60_000),
    authTimeoutMs: boundedInt('AGENT_WS_AUTH_TIMEOUT_MS', 10_000, 1000, 60_000),
    maxMessageChars: boundedInt('AGENT_MAX_MESSAGE_CHARS', 16_000, 1000, 100_000),
    maxConcurrentRunsPerActor: boundedInt('AGENT_MAX_CONCURRENT_RUNS', 2, 1, 20),
    runTimeoutMs: boundedInt('AGENT_RUN_TIMEOUT_MS', 120_000, 5000, 30 * 60_000),
    maxIterations: boundedInt('AGENT_MAX_ITERATIONS', 40, 1, 200),
    maxToolResultChars: boundedInt('AGENT_MAX_TOOL_RESULT_CHARS', 20_000, 1000, 100_000),
  });
}

export class FixedWindowRateLimiter {
  private windowStartedAt: number;
  private count = 0;

  constructor(private readonly limit: number, private readonly windowMs: number, now = Date.now()) {
    this.windowStartedAt = now;
  }

  allow(now = Date.now()): boolean {
    if (now - this.windowStartedAt >= this.windowMs) {
      this.windowStartedAt = now;
      this.count = 0;
    }
    this.count += 1;
    return this.count <= this.limit;
  }
}

export class ActorConcurrencyLimiter {
  private readonly counts = new Map<number, number>();

  constructor(private readonly limit: number) {}

  acquire(actorId: number): boolean {
    const count = this.counts.get(actorId) ?? 0;
    if (count >= this.limit) return false;
    this.counts.set(actorId, count + 1);
    return true;
  }

  release(actorId: number): void {
    const count = this.counts.get(actorId) ?? 0;
    if (count <= 1) this.counts.delete(actorId);
    else this.counts.set(actorId, count - 1);
  }
}
