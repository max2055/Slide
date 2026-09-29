import type { AgentRunSpec, ToolCallRequest, ToolEvent } from "../types.js";

export class ToolExecutor {
  async runTool(
    spec: AgentRunSpec,
    toolCall: ToolCallRequest,
    externalLookupCounts: Record<string, number>,
    /** @deprecated Retained for callers compiled against the pre-guard API. */
    _workspaceViolationCounts?: Record<string, number>,
    iteration?: number,
  ): Promise<{ result: unknown; event: ToolEvent; error: Error | null }> {
    const HINT = "\n\n[Analyze the error above and try a different approach.]";

    // Repeated identical tool-call guard. Different arguments start a new sequence.
    const lookupError = repeatedExternalLookupError(
      toolCall.name,
      toolCall.arguments,
      externalLookupCounts,
      spec.loopGuardThreshold,
    );
    if (lookupError) {
      console.warn('[AgentRunner] repeated tool call blocked', {
        tool: toolCall.name,
        signature: redactedToolCallSignature(toolCall.arguments),
        count: lookupError.count,
        threshold: lookupError.threshold,
        iteration: iteration ?? null,
      });
      return {
        result: lookupError.message + HINT,
        event: { name: toolCall.name, status: "error", detail: "repeated identical tool call blocked" },
        // A guard hit is an expected, per-call safety result. It must not abort a batch.
        error: null,
      };
    }

    try {
      if (spec.signal?.aborted) {
        const error = new Error('Tool execution cancelled');
        return {
          result: `Error: ${error.message}`,
          event: { name: toolCall.name, status: 'error', detail: error.message },
          error,
        };
      }
      const execution = spec.tools.execute(toolCall.name, toolCall.arguments, {
        signal: spec.signal,
        sessionKey: spec.sessionKey,
        idempotencyKey: spec.idempotencyKey,
        progressCallback: spec.toolProgressCallback,
        preserveErrors: true,
      });
      spec.onToolExecution?.(execution);
      const result = await execution;
      if (spec.signal?.aborted) throw new Error('Tool execution cancelled after settlement');
      const detail = result === undefined || result === null
        ? "(empty)"
        : String(result).replace(/\n/g, " ").trim().slice(0, 120);
      return {
        result,
        event: { name: toolCall.name, status: "ok", detail: detail || "(empty)" },
        error: null,
      };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        result: `Error: ${message}` + (spec.failOnToolError ? "" : HINT),
        event: { name: toolCall.name, status: "error", detail: message.slice(0, 120) },
        error: spec.failOnToolError ? (e instanceof Error ? e : new Error(message)) : null,
      };
    }
  }

}

export async function executeTools(
  spec: AgentRunSpec,
  toolCalls: ToolCallRequest[],
  externalLookupCounts: Record<string, number>,
  iteration: number,
  executor: Pick<ToolExecutor, "runTool">,
): Promise<{
  results: unknown[];
  events: ToolEvent[];
  fatalError: string | null;
}> {
  const batches = partitionToolBatches(spec, toolCalls);
  const allResults: unknown[] = [];
  const allEvents: ToolEvent[] = [];
  let fatalError: string | null = null;

  for (const batch of batches) {
    if (spec.concurrentTools && batch.length > 1) {
      const batchResults = await Promise.all(
        batch.map((tc) =>
          executor.runTool(spec, tc, externalLookupCounts, undefined, iteration)
        )
      );
      for (const r of batchResults) {
        allResults.push(r.result);
        allEvents.push(r.event);
        if (r.error && !fatalError) fatalError = r.error.message;
      }
    } else {
      for (const tc of batch) {
        const r = await executor.runTool(
          spec,
          tc,
          externalLookupCounts,
          undefined,
          iteration,
        );
        allResults.push(r.result);
        allEvents.push(r.event);
        if (r.error && !fatalError) fatalError = r.error.message;
      }
    }
  }

  return { results: allResults, events: allEvents, fatalError };
}

function partitionToolBatches(
  spec: AgentRunSpec,
  toolCalls: ToolCallRequest[]
): ToolCallRequest[][] {
  if (!spec.concurrentTools) return toolCalls.map((tc) => [tc]);

  const batches: ToolCallRequest[][] = [];
  let current: ToolCallRequest[] = [];

  for (const tc of toolCalls) {
    const tool = spec.tools.get(tc.name);
    const canBatch = tool?.concurrencySafe === true;
    if (canBatch) {
      current.push(tc);
    } else {
      if (current.length > 0) {
        batches.push(current);
        current = [];
      }
      batches.push([tc]);
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

const DEFAULT_LOOP_GUARD_THRESHOLD = 5;
const MAX_LOOP_GUARD_THRESHOLD = 1000;
const loopGuardStates = new WeakMap<object, { key: string; count: number }>();

interface LoopGuardHit {
  message: string;
  count: number;
  threshold: number;
}

function repeatedExternalLookupError(
  toolName: string,
  arguments_: Record<string, unknown>,
  counts: Record<string, number>,
  configuredThreshold?: number,
): LoopGuardHit | null {
  const threshold = resolveLoopGuardThreshold(configuredThreshold);
  const key = `${toolName}:${stableJson(arguments_, false)}`;
  const previous = loopGuardStates.get(counts);
  const count = previous?.key === key ? previous.count + 1 : 1;
  loopGuardStates.set(counts, { key, count });
  if (count > threshold) {
    return {
      message: `Error: Tool '${toolName}' has been called ${count} times with the same parameters — possible loop detected. Do not retry the same parameters.`,
      count,
      threshold,
    };
  }
  return null;
}

function resolveLoopGuardThreshold(configuredThreshold?: number): number {
  const value = configuredThreshold ?? Number(process.env.AGENT_LOOP_THRESHOLD);
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_LOOP_GUARD_THRESHOLD
    ? value
    : DEFAULT_LOOP_GUARD_THRESHOLD;
}

function stableRedactedJson(value: unknown): string {
  return stableJson(value, true);
}

function stableJson(value: unknown, redactSensitive: boolean): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item, redactSensitive)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => {
        const normalized = key.toLowerCase();
        const redacted = redactSensitive && /(password|passwd|secret|credential|token|api[_-]?key|private[_-]?key)/i.test(normalized)
          ? JSON.stringify('[REDACTED]')
          : stableJson(child, redactSensitive);
        return `${JSON.stringify(key)}:${redacted}`;
      });
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function redactedToolCallSignature(arguments_: Record<string, unknown>): string {
  const signature = stableRedactedJson(arguments_);
  return signature.length > 512 ? `${signature.slice(0, 509)}...` : signature;
}

