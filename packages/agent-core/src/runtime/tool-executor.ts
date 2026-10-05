import { withBudgetDispatchSignal } from './budget.js';
import { RuntimeError, cancellationError } from './recovery-policy.js';
import type { AgentRunSpec, ToolCallRequest, ToolEvent } from "../types.js";

export class ToolExecutor {
  async runTool(
    spec: AgentRunSpec, toolCall: ToolCallRequest, counts: Record<string, number>,
    legacyCounts?: Record<string, number>, iteration?: number,
  ): Promise<{ result: unknown; event: ToolEvent; error: Error | null }> {
    const returned = await this.executeTool(spec, toolCall, counts, legacyCounts, iteration);
    await spec.onToolEvent?.({ toolCallId: toolCall.id, toolName: toolCall.name,
      phase: 'settled', occurredAt: Date.now(), outcome: returned.event.outcome ?? (returned.event.status === 'ok' ? 'ok' : 'error'),
      result: returned.result });
    return returned;
  }

  private async executeTool(
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
        event: { toolCallId: toolCall.id, name: toolCall.name, status: "error", detail: "repeated identical tool call blocked" },
        // A guard hit is an expected, per-call safety result. It must not abort a batch.
        error: null,
      };
    }

    const controller = new AbortController();
    const cancel = () => controller.abort(spec.signal?.reason);
    spec.signal?.addEventListener('abort', cancel, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let executionOpen = false;
    let boundaryListener: (() => void) | undefined;
    try {
      if (spec.signal?.aborted) {
        const error = new Error('Tool execution cancelled');
        return {
          result: `Error: ${error.message}`,
          event: { toolCallId: toolCall.id, name: toolCall.name, status: 'error', outcome: 'cancelled', detail: error.message },
          error,
        };
      }
      const declaredTimeout = spec.tools.get(toolCall.name)?.timeoutMs;
      const timeout = Math.min(spec.toolTimeoutMs ?? Infinity, declaredTimeout ?? Infinity);
      if (timeout !== Infinity && (!Number.isSafeInteger(timeout) || timeout <= 0)) throw new RuntimeError('INVALID_POLICY', 'Invalid tool timeout', 'tool');
      if (timeout !== Infinity) timer = setTimeout(() => controller.abort(new RuntimeError('TOOL_TIMEOUT', 'Tool deadline exceeded; cancellation requested, settlement may still be pending', 'tool')), timeout);
      await spec.onToolEvent?.({ toolCallId: toolCall.id, toolName: toolCall.name, phase: 'running', occurredAt: Date.now(), args: toolCall.arguments });
      controller.signal.throwIfAborted();
      executionOpen = true;
      const execution = withBudgetDispatchSignal(controller.signal, () => spec.tools.execute(toolCall.name, toolCall.arguments, {
        signal: timeout === Infinity ? spec.signal : controller.signal,
        sessionKey: spec.sessionKey,
        idempotencyKey: spec.idempotencyKey,
        progressCallback: async event => {
          if (!executionOpen || controller.signal.aborted) return;
          await spec.onToolEvent?.({ toolCallId: toolCall.id, toolName: toolCall.name, phase: 'running', occurredAt: Date.now(), progress: event });
          await spec.toolProgressCallback?.({ ...event, toolCallId: toolCall.id, toolName: toolCall.name });
        },
        preserveErrors: true,
      }));
      spec.onToolExecution?.(execution);
      // A caller tracking the actual execution can safely receive the boundary result early.
      // Without an observer retain ownership here until the underlying operation settles.
      const boundary = new Promise<never>((_, reject) => {
        boundaryListener = () => reject(cancellationError(controller.signal));
        controller.signal.addEventListener('abort', boundaryListener, { once: true });
        if (controller.signal.aborted) boundaryListener();
      });
      // Always handle boundary rejection, including the legacy wait-for-settlement path.
      void boundary.catch(() => {});
      const result = spec.onToolExecution && timeout !== Infinity ? await Promise.race([execution, boundary]) : await execution;
      if (controller.signal.aborted) throw cancellationError(controller.signal);
      if (spec.signal?.aborted) throw new Error('Tool execution cancelled after settlement');
      const failed = !spec.tools.get(toolCall.name) || typeof result === 'string' && result.startsWith('Error') || !!result && typeof result === 'object' && ((result as Record<string, unknown>).success === false || (result as Record<string, unknown>).status === 'error');
      const detail = result === undefined || result === null
        ? "(empty)"
        : String(result).replace(/\n/g, " ").trim().slice(0, 120);
      return {
        result,
        event: { toolCallId: toolCall.id, name: toolCall.name, status: failed ? "error" : "ok", detail: detail || "(empty)" },
        error: null,
      };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        result: `Error: ${message}` + (spec.failOnToolError ? "" : HINT),
        event: { toolCallId: toolCall.id, name: toolCall.name, status: "error", outcome: controller.signal.aborted ? "unknown" : "error", detail: message.slice(0, 120) },
        error: e instanceof RuntimeError || spec.failOnToolError ? (e instanceof Error ? e : new Error(message)) : null,
      };
    } finally {
      executionOpen = false;
      clearTimeout(timer);
      spec.signal?.removeEventListener('abort', cancel);
      if (boundaryListener) controller.signal.removeEventListener('abort', boundaryListener);
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
  runtimeError?: RuntimeError;
}> {
  for (const tc of toolCalls) {
    await spec.onToolEvent?.({ toolCallId: tc.id, toolName: tc.name, phase: 'planned', occurredAt: Date.now(), args: tc.arguments });
    await spec.onToolEvent?.({ toolCallId: tc.id, toolName: tc.name, phase: 'queued', occurredAt: Date.now() });
  }
  const batches = partitionToolBatches(spec, toolCalls);
  const allResults: unknown[] = [];
  const allEvents: ToolEvent[] = [];
  let fatalError: string | null = null;
  let runtimeError: RuntimeError | undefined;

  for (const batch of batches) {
    if (spec.signal?.aborted || runtimeError) break;
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
        if (r.error instanceof RuntimeError) runtimeError = r.error;
      }
    } else {
      for (const tc of batch) {
        if (spec.signal?.aborted || runtimeError) break;
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
        if (r.error instanceof RuntimeError) runtimeError = r.error;
      }
    }
  }

  for (const tc of toolCalls) {
    if (!allEvents.some(event => event.toolCallId === tc.id)) await spec.onToolEvent?.({ toolCallId: tc.id, toolName: tc.name, phase: 'settled', occurredAt: Date.now(), outcome: 'cancelled' });
  }
  return { results: allResults, events: allEvents, fatalError, runtimeError };
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

