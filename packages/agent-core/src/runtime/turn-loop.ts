import type { AgentHookContext, AgentRunResult, AgentRunSpec, LLMResponse, Message, ToolCallRequest } from "../types.js";

import { ModelStep, TimeoutError } from "./model-step.js";
import { ToolExecutor, executeTools } from "./tool-executor.js";
import { emitCheckpoint } from "./checkpoint.js";
import { createTurnState, transition } from "./turn-state.js";
import { ContextManager, ensureNonemptyToolResult } from './context-manager.js';
import { autoCompact, validateSummaryRecord } from './auto-compact.js';
import { RapidRefill } from './rapid-refill.js';
import { AnomalyGuard } from "./anomaly-guard.js";
import { CompletionSupervisor } from "./supervisor.js";
import { RecoveryPolicy, RuntimeError, runtimeError, cancellationError, backoff } from './recovery-policy.js';
import { OutputContinuation } from './output-continuation.js';
const DEFAULT_ERROR_MESSAGE = "Sorry, I encountered an error calling the AI model.";
const PERSISTED_MODEL_ERROR_PLACEHOLDER =
  "[Assistant reply unavailable due to model error.]";

const MAX_INJECTIONS_PER_TURN = 3;
const MAX_INJECTION_CYCLES = 5;
const EMPTY_FINAL_RESPONSE_MESSAGE = "[No response — task may have completed.]";

export class TurnLoop {
  constructor(
    private readonly getProvider: () => import("../types.js").LLMProvider,
    private readonly executor: Pick<ToolExecutor, "runTool">,
  ) {}
  async run(spec: AgentRunSpec): Promise<AgentRunResult> {
    const hook = spec.hook;
    const recovery = new RecoveryPolicy(spec.resumeCheckpoint?.runtime_state_v1, spec.recoveryLimits);
    const continuation = new OutputContinuation(typeof spec.resumeCheckpoint?.continuation_content === 'string' ? spec.resumeCheckpoint.continuation_content : '');
    const compact = new RapidRefill(spec.resumeCheckpoint?.context_state_v1);
    let manager: ContextManager | undefined;
    let forceCompact = false;
    let checkpoint = spec.resumeCheckpoint ?? {};
    const saveCheckpoint = spec.checkpointCallback;
    spec = { ...spec, checkpointCallback: async payload => {
      const next: Record<string, unknown> = { ...checkpoint, context_state_v1: compact.snapshot(), ...payload, runtime_state_v1: recovery.snapshot(), continuation_content: continuation.content };
      if ('assistantMessage' in payload) { delete next.assistant_message; next.messages_restored = false; }
      if ('completedToolResults' in payload) delete next.completed_tool_results;
      if ('pendingToolCalls' in payload) delete next.pending_tool_calls;
      await saveCheckpoint?.(next);
      if ('context_summary_v1' in payload && spec.signal?.aborted) throw cancellationError(spec.signal);
      checkpoint = next;
    } };
    const persistCounters = () => emitCheckpoint(spec, {});
    const supervisor = new CompletionSupervisor();
    const supervisorMode = spec.supervisorMode ?? 'enforce';
    const progress = new AnomalyGuard();
    let toolEpoch = 0;
    let reminder: string | undefined;
    let safeContent = '';
    let responseReady = false;
    const currentRequest = (messages: Message[]) => {
      const latest = [...messages].reverse().find(m => m.role === 'user');
      return typeof latest?.content === 'string' ? latest.content : '';
    };
    let progressEpoch = 0;
    let request = currentRequest(spec.initialMessages);
    let state = createTurnState(spec.initialMessages);
    const pendingTools = spec.resumeCheckpoint?.pendingToolCalls ?? spec.resumeCheckpoint?.pending_tool_calls;
    if (Array.isArray(pendingTools) && pendingTools.length) {
      const error = new RuntimeError('TOOL_SETTLEMENT_UNKNOWN', 'Interrupted tool intent requires reconciliation', 'tool');
      return { ...state, stopReason: 'tool_error', error: error.message, runtimeError: error,
        resolution: { kind: 'failed', reasonCode: error.code, retryable: false, safePartialContent: '' }, runtimeState: recovery.snapshot() };
    }
    state.usage = { ...state.usage, ...recovery.state.usage };
    for (let iteration = recovery.state.modelSteps; iteration < spec.maxIterations; iteration++) {
      if (spec.signal?.aborted) { state.stopReason = 'cancelled'; state.error = 'Cancelled'; break; }
      state = transition(state, "model_running");
      // Governance must succeed before reserving or dispatching an ordinary request.
      let messagesForModel: Message[];
      try {
        if (!manager) {
          manager = new ContextManager({ ...spec, checkpointCallback: saveCheckpoint }, this.getProvider());
          if (spec.resumeCheckpoint?.context_summary_v1) manager.summary = validateSummaryRecord(spec.resumeCheckpoint.context_summary_v1);
        }
        messagesForModel = manager.project(state.messages);
        if (forceCompact || manager.tokens(messagesForModel) > manager.inputBudget * manager.watermark) {
          const split = manager.split(state.messages);
          if (forceCompact || split.end > (manager.summary?.sourceEnd ?? 0)) {
            await autoCompact(manager, state.messages, this.getProvider(), recovery, compact, async (record, compactState) => {
              await emitCheckpoint(spec, { ...(record ? { context_summary_v1: record } : {}), ...(compactState ? { context_state_v1: compactState } : {}) });
            });
            state.usage = { ...recovery.state.usage };
            messagesForModel = manager.project(state.messages);
          }
        }
        forceCompact = false;
        messagesForModel = continuation.project(messagesForModel);
        if (reminder) messagesForModel = [...messagesForModel, { role: 'user', content: reminder }];
        manager.assertFits(messagesForModel);
      } catch (cause) {
        const error = cause instanceof RuntimeError ? cause : new RuntimeError('CONTEXT_GOVERNANCE_ERROR', 'Context governance failed');
        state.usage = { ...recovery.state.usage };
        state.runtimeError = error;
        state.stopReason = error.code === 'MODEL_REQUEST_TIMEOUT' || error.code === 'MODEL_IDLE_TIMEOUT' ? 'timed_out' : 'error'; state.error = error.message;
        state.finalContent = safeContent + continuation.content;
        state.resolution = { kind: state.stopReason === 'timed_out' ? 'timed_out' : 'failed', reasonCode: error.code, retryable: false, safePartialContent: state.finalContent };
        break;
      }

      // ── Hook: before iteration ──
      const context: AgentHookContext = {
        iteration,
        messages: messagesForModel,
        response: null,
        usage: {},
        toolCalls: [],
        toolResults: [],
        toolEvents: [],
        streamedContent: false,
        streamedReasoning: false,
        finalContent: null,
        stopReason: null,
        error: null,
      };
      reminder = undefined;
      state.modelSteps++; state.providerAttempts++;
      recovery.state.modelSteps++; recovery.state.providerAttempts++;
      recovery.state.unknownRequests++;
      const reservation = (spec.contextWindowTokens ?? 200_000) + (spec.maxTokens ?? 4096);
      recovery.state.reservedTokens += reservation;
      await persistCounters();
      if (spec.signal?.aborted) { state.stopReason = 'cancelled'; break; }

      await hook.beforeIteration(context);
      try { manager.assertFits(messagesForModel); } catch (cause) {
        state.runtimeError = cause as RuntimeError; state.stopReason = 'error'; state.error = state.runtimeError.message;
        state.resolution = { kind: 'failed', reasonCode: state.runtimeError.code, retryable: false, safePartialContent: safeContent + continuation.content };
        break;
      }

      // ── Request LLM ──
      let response: LLMResponse;
      try {
        response = await new ModelStep(this.getProvider()).request(spec, messagesForModel, hook, context);
      } catch (e: unknown) {
        const isTimeout = e instanceof TimeoutError;
        const errMsg = isTimeout ? e.message : (e instanceof Error ? e.message : String(e));
        response = {
          content: isTimeout ? errMsg : null,
          finishReason: "error",
          toolCalls: [],
          usage: {},
          shouldExecuteTools: false,
          hasToolCalls: false,
          errorKind: isTimeout ? "timeout" : "provider_error",
          error: errMsg,
          runtimeError: runtimeError(e, recovery.state.providerAttempts),
        };
        if (!isTimeout) console.error("[AgentRunner] LLM request failed:", errMsg);
      }
      if (spec.signal?.aborted) { state.stopReason = 'cancelled'; state.error = 'Cancelled'; break; }
      const rawUsage = usageDict(response.usage);
      context.response = response;
      context.usage = { ...rawUsage };
      context.toolCalls = [...response.toolCalls];
      accumulateUsage(state.usage, rawUsage);
      recovery.state.usage = { ...state.usage };
      if (Number.isFinite(rawUsage.prompt_tokens) && Number.isFinite(rawUsage.completion_tokens)) {
        recovery.state.unknownRequests--;
        recovery.state.reservedTokens -= reservation;
      }
      await persistCounters();
      if (spec.signal?.aborted) { state.stopReason = 'cancelled'; break; }

      // Extract reasoning content
      if (response.reasoningContent) {
        if (!context.streamedReasoning) {
          // Batch path: reasoning came via reasoning_content field, not streamed
          await hook.emitReasoning(response.reasoningContent);
        }
        // Always signal reasoning end (streaming path already emitted deltas)
        await hook.emitReasoningEnd();
        context.streamedReasoning = true;
      }
      // Providers that stream reasoning through callbacks may not repeat it in
      // the final response object. Close that channel before the next phase.
      if (!response.reasoningContent && context.streamedReasoning) {
        await hook.emitReasoningEnd();
      }

      // ── Tool execution path ──
      if (!response.error && !response.errorKind && response.finishReason !== 'error' && response.finishReason !== 'length' && response.shouldExecuteTools && response.toolCalls.length > 0) {
        state = transition(state, "tools_running");
        state.toolCalls += response.toolCalls.length;
        recovery.state.toolCalls += response.toolCalls.length;
        context.toolCalls = [...response.toolCalls];
        if (hook.wantsStreaming()) {
          await hook.onStreamEnd(context, true); // resuming
        }

        const assistantMsg = buildAssistantMessage(
          response.content || "",
          response.toolCalls,
          (response as any)._extra, // Preserve provider-specific fields (e.g., reasoning_content)
        );
        if (continuation.content) { state.messages.push(buildAssistantMessage(continuation.content)); safeContent += continuation.content; continuation.clear(); }
        safeContent += response.content ?? '';
        state.messages.push(assistantMsg);
        for (const tc of response.toolCalls) state.toolsUsed.push(tc.name);

        await emitCheckpoint(spec, {
          phase: "awaiting_tools",
          iteration,
          model: spec.model,
          assistantMessage: assistantMsg,
          completedToolResults: [],
          pendingToolCalls: response.toolCalls.map((tc) => tcToOpenAI(tc)),
        });

        if (spec.signal?.aborted) { state.stopReason = 'cancelled'; break; }
        await hook.beforeExecuteTools(context);

        // Execute tools (potentially in parallel)
        const { results, events, fatalError } = await executeTools(
          spec,
          response.toolCalls,
          state.externalLookupCounts,
          iteration,
          this.executor,
        );
        if (spec.signal?.aborted) { state.stopReason = 'cancelled'; break; }
        const nextToolEpoch = progress.progress(results);
        if (nextToolEpoch > toolEpoch) progressEpoch++;
        toolEpoch = nextToolEpoch;
        state.toolEvents.push(...events);
        context.toolResults = [...results];
        context.toolEvents = [...events];

        const completedToolResults: Message[] = [];
        for (let i = 0; i < response.toolCalls.length; i++) {
          const tc = response.toolCalls[i];
          const toolMsg: Message = {
            role: "tool",
            tool_call_id: tc.id,
            name: tc.name,
            content: ensureNonemptyToolResult(tc.name, results[i]),
          };
          state.messages.push(toolMsg);
          completedToolResults.push(toolMsg);
        }

        if (fatalError) {
          // Mark every returned tool result as completed before stopping. Leaving
          // the pre-execution checkpoint intact would replay side-effecting tools
          // when the session is restored after a fatal batch error.
          await emitCheckpoint(spec, {
            phase: "tools_completed",
            iteration,
            model: spec.model,
            assistantMessage: assistantMsg,
            completedToolResults,
            pendingToolCalls: [],
          });
          state.error = `Error: ${fatalError}`;
          state.finalContent = state.error;
          state.stopReason = "tool_error";
          context.finalContent = state.finalContent;
          context.error = state.error;
          context.stopReason = state.stopReason;
          await hook.afterIteration(context);
          const [shouldContinue, newCycles] = await tryDrainInjections(
            spec,
            state.messages,
            null,
            state.injectionCycles,
            "after tool error",
            undefined
          );
          state.injectionCycles = newCycles;
          if (shouldContinue) {
            state.hadInjections = true;
            continue;
          }
          break;
        }

        compact.completeBatch();
        await emitCheckpoint(spec, {
          phase: "tools_completed",
          iteration,
          model: spec.model,
          assistantMessage: assistantMsg,
          completedToolResults,
          pendingToolCalls: [],
        });


        const [drained, newCycles2] = await tryDrainInjections(
          spec,
          state.messages,
          null,
          state.injectionCycles,
          "after tool execution",
          undefined
        );
        state.injectionCycles = newCycles2;
        if (drained) { state.hadInjections = true; progressEpoch++; request = currentRequest(state.messages); }

        await hook.afterIteration(context);
        continue;
      }

      // ── Text response path (no tool calls) ──

      state = transition(state, "candidate_final");
      const clean = hook.finalizeContent(context, response.content) || "";

      const decision = supervisor.classify(response, clean, request, progressEpoch, supervisorMode);
      if (decision === 'repetition' || decision === 'unresolved_tools') {
        const reasonCode = decision === 'repetition' ? 'MODEL_REPETITION_LOOP' : 'UNRESOLVED_TOOL_CALLS';
        state.finalContent = safeContent + continuation.content;
        // Clear before callbacks/injections: all exits after rejection see only safe text.
        state.resolution = { kind: 'failed', reasonCode, retryable: false, safePartialContent: safeContent + continuation.content };
        await hook.onCandidateRejected?.(context, safeContent + continuation.content, reasonCode);
        context.finalContent = safeContent + continuation.content;
        await hook.afterIteration(context);
        if (decision === 'repetition' && recovery.consume('repetition') && supervisor.recoverRepetition() && !spec.signal?.aborted) {
          reminder = supervisor.reminder();
          await persistCounters();
          state = transition(state, 'recovering');
          const [drained, cycles] = await tryDrainInjections(spec, state.messages, null, state.injectionCycles, 'after rejected candidate');
          state.injectionCycles = cycles;
          if (drained) { state.hadInjections = true; progressEpoch++; request = currentRequest(state.messages); }
          continue;
        }
        state.stopReason = spec.signal?.aborted ? 'cancelled' : 'error';
        state.error = reasonCode;
        state.runtimeError = new RuntimeError(reasonCode, reasonCode);
        if (recovery.state.total >= recovery.limits.total) state.resolution!.reasonCode = 'RECOVERY_LIMIT';
        break;
      }
      if (decision === 'empty') {
        await hook.onCandidateRejected?.(context, safeContent + continuation.content, 'EMPTY_RESPONSE');
        if (recovery.consume('empty')) {
          reminder = '[Runtime: Your previous response was empty. Please provide a substantive response to the user request.]';
          state = transition(state, 'recovering');
          await persistCounters();
          if (hook.wantsStreaming()) await hook.onStreamEnd(context, false);
          await hook.afterIteration(context);
          continue;
        }
        state.finalContent = continuation.content;
        state.stopReason = 'empty_final_response';
        state.error = EMPTY_FINAL_RESPONSE_MESSAGE;
        state.runtimeError = new RuntimeError('EMPTY_RESPONSE', state.error);
        state.resolution = { kind: 'failed', reasonCode: recovery.state.total >= recovery.limits.total ? 'RECOVERY_LIMIT' : 'EMPTY_RESPONSE', retryable: false, safePartialContent: safeContent + continuation.content };
        context.finalContent = state.finalContent;
        context.error = state.error;
        context.stopReason = state.stopReason;
        await hook.afterIteration(context);
        break;
      } else if (decision === 'length') {
        continuation.append(clean);
        state.finalContent = continuation.content;
        if (recovery.consume('continuation')) {
          state = transition(state, 'recovering');
          await persistCounters();
          if (hook.wantsStreaming()) await hook.onStreamEnd(context, true);
          await hook.afterIteration(context);
          continue;
        }
        state.stopReason = 'output_limit';
        state.error = 'OUTPUT_LIMIT';
        state.runtimeError = new RuntimeError('OUTPUT_LIMIT', 'Output continuation limit reached');
        state.resolution = { kind: 'partial', reasonCode: 'OUTPUT_LIMIT', retryable: false, safePartialContent: safeContent + continuation.content };
        appendFinalMessage(state.messages, continuation.content);
        await persistCounters();
        context.finalContent = state.finalContent;
        context.stopReason = state.stopReason;
        await hook.afterIteration(context);
        break;
      } else if (decision === 'error') {
        const error = response.runtimeError ?? runtimeError(response, recovery.state.providerAttempts);
        if (error.code === 'CONTEXT_OVERFLOW' && !response.toolCalls.length && !response.hasToolCalls) {
          forceCompact = true;
          state = transition(state, 'recovering');
          await hook.onCandidateRejected?.(context, safeContent + continuation.content, error.code);
          await hook.afterIteration(context);
          continue;
        }
        // No tool intent or uncertain side effect is replayed by transport recovery.
        if (error.recoverable && !response.toolCalls.length && !response.hasToolCalls && recovery.consume('stream')) {
          await hook.onCandidateRejected?.(context, safeContent + continuation.content, error.code);
          state = transition(state, 'recovering');
          await persistCounters();
          await hook.afterIteration(context);
          try {
            await backoff(Math.max(recovery.state.counts.stream * 1000, response.retryAfterMs ?? 0), spec.signal);
          } catch { state.stopReason = 'cancelled'; break; }
          continue;
        }
        const afterRejection = state.resolution?.safePartialContent !== undefined;
        if (afterRejection) await hook.onCandidateRejected?.(context, safeContent, error.code);
        state.runtimeError = error;
        state.finalContent = clean || response.error || spec.errorMessage || DEFAULT_ERROR_MESSAGE;
        state.stopReason = error.code === 'MODEL_REQUEST_TIMEOUT' || error.code === 'MODEL_IDLE_TIMEOUT' ? 'timed_out' : 'error';
        state.error = state.finalContent;
        state.resolution = { kind: state.stopReason === 'timed_out' ? 'timed_out' : 'failed', reasonCode: error.code,
          retryable: false, ...((afterRejection || continuation.content) ? { safePartialContent: safeContent + continuation.content } : {}) };
        appendModelErrorPlaceholder(state.messages);
        context.finalContent = state.finalContent;
        context.error = state.error;
        context.stopReason = state.stopReason;
        await hook.afterIteration(context);
        break;
      } else {
        state.finalContent = continuation.append(clean);
        continuation.clear();
      }
      // A successful remedy replaces any earlier candidate failure.
      state.stopReason = 'completed';
      state.error = null;
      state.resolution = undefined;

      // ── Check for mid-turn injections before signaling stream end ──
      const assistantMsg = !isBlankText(state.finalContent)
        ? buildAssistantMessage(state.finalContent!, undefined, (response as any)._extra)
        : undefined;

      const [shouldContinue, newCycles3] = await tryDrainInjections(
        spec,
        state.messages,
        assistantMsg || null,
        state.injectionCycles,
        "after final response",
        iteration
      );
      state.injectionCycles = newCycles3;
      if (shouldContinue) {
        state.hadInjections = true;
        progressEpoch++;
        request = currentRequest(state.messages);
        safeContent += state.finalContent ?? '';
      }

      if (hook.wantsStreaming()) {
        await hook.onStreamEnd(context, shouldContinue);
      }

      if (shouldContinue) {
        await hook.afterIteration(context);
        continue;
      }

      if (assistantMsg) {
        state.messages.push(assistantMsg);
        await emitCheckpoint(spec, {
          phase: "final_response",
          iteration,
          model: spec.model,
          assistantMessage: assistantMsg,
          completedToolResults: [],
          pendingToolCalls: [],
        });
      }

      context.finalContent = state.finalContent;
      context.stopReason = state.stopReason;
      await hook.afterIteration(context);
      responseReady = true;
      break;
    }

    // Only an accepted final candidate can complete; a tool step or recovery at the boundary cannot.
    if (state.stopReason === 'completed' && !responseReady) {
      state.stopReason = 'max_iterations';
      const partial = safeContent + continuation.content;
      state.finalContent = partial || spec.maxIterationsMessage || `[Maximum iterations (${spec.maxIterations}) reached — task may be incomplete.]`;
      state.resolution = { kind: 'partial', reasonCode: 'MAX_MODEL_STEPS', retryable: false, safePartialContent: partial };
      if (state.phase !== 'recovering') appendFinalMessage(state.messages, state.finalContent);
      else state.finalContent = partial;
    }

    if (continuation.content) appendFinalMessage(state.messages, continuation.content);
    const applyCancellation = () => {
      if (!spec.signal?.aborted && state.stopReason !== 'cancelled') return;
      state.runtimeError = cancellationError(spec.signal);
      state.stopReason = state.runtimeError.code === 'RUN_DEADLINE' ? 'timed_out' : 'cancelled';
      state.resolution = { kind: state.stopReason === 'timed_out' ? 'timed_out' : 'cancelled', reasonCode: state.runtimeError.code, retryable: false,
        ...((state.resolution?.safePartialContent !== undefined || continuation.content) ? { safePartialContent: safeContent + continuation.content } : {}) };
    };
    applyCancellation();
    await emitCheckpoint(spec, { terminal_resolution: state.resolution ?? { kind: state.stopReason === 'completed' ? 'response_ready' : 'partial' } });
    applyCancellation();
    state = transition(state, state.stopReason === "completed" ? "response_ready" : "terminal");
    return {
      runtimeState: recovery.snapshot(),
      ...(state.runtimeError ? { runtimeError: state.runtimeError } : {}),
      finalContent: state.finalContent,
      messages: state.messages,
      toolsUsed: state.toolsUsed,
      usage: state.usage,
      stopReason: state.stopReason,
      error: state.error,
      toolEvents: state.toolEvents,
      hadInjections: state.hadInjections,
      ...(state.resolution ? { resolution: state.resolution } : {}),
    };
  }
}

async function tryDrainInjections(
  spec: AgentRunSpec,
  messages: Message[],
  assistantMessage: Message | null,
  injectionCycles: number,
  phase: string,
  iteration?: number
): Promise<[boolean, number]> {
  if (injectionCycles >= MAX_INJECTION_CYCLES) return [false, injectionCycles];

  const injections = await drainInjections(spec);
  if (injections.length === 0) return [false, injectionCycles];

  injectionCycles++;
  if (assistantMessage) {
    messages.push(assistantMessage);
    if (iteration !== undefined) {
      await emitCheckpoint(spec, {
        phase: "final_response",
        iteration,
        model: spec.model,
        assistantMessage,
        completedToolResults: [],
        pendingToolCalls: [],
      });
    }
  }

  appendInjectedMessages(messages, injections);
  return [true, injectionCycles];
}

async function drainInjections(spec: AgentRunSpec): Promise<Message[]> {
  if (!spec.injectionCallback) return [];
  try {
    const items = await spec.injectionCallback(MAX_INJECTIONS_PER_TURN);
    if (!items || items.length === 0) return [];
    return items.slice(0, MAX_INJECTIONS_PER_TURN);
  } catch {
    return [];
  }
}

function appendInjectedMessages(messages: Message[], injections: Message[]): void {
  for (const injection of injections) {
    if (
      messages.length > 0 &&
      injection.role === "user" &&
      messages[messages.length - 1].role === "user"
    ) {
      // Merge consecutive user messages
      const last = messages[messages.length - 1];
      const left = typeof last.content === "string" ? last.content : "";
      const right = typeof injection.content === "string" ? injection.content : "";
      messages[messages.length - 1] = {
        ...last,
        content: left ? `${left}\n\n${right}` : right,
      };
    } else {
      messages.push(injection);
    }
  }
}

function buildAssistantMessage(
  content: string,
  toolCalls?: ToolCallRequest[],
  _extra?: Record<string, unknown>,
): Message {
  const msg: Message = {
    role: "assistant",
    content: content || null,
    tool_calls: toolCalls?.map(tcToOpenAI),
  };
  if (_extra) (msg as any)._extra = _extra;
  return msg;
}

function tcToOpenAI(tc: ToolCallRequest) {
  return {
    id: tc.id,
    type: "function" as const,
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.arguments),
    },
  };
}

function appendFinalMessage(messages: Message[], content: string | null): void {
  if (!content) return;
  const last = messages[messages.length - 1];
  if (
    last &&
    last.role === "assistant" &&
    !last.tool_calls &&
    last.content === content
  )
    return;
  messages.push({ role: "assistant", content });
}

function appendModelErrorPlaceholder(messages: Message[]): void {
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant" && !last.tool_calls) return;
  messages.push({ role: "assistant", content: PERSISTED_MODEL_ERROR_PLACEHOLDER });
}

function isBlankText(text: string | null): boolean {
  return !text || text.trim().length === 0;
}

function usageDict(usage?: Record<string, number>): Record<string, number> {
  if (!usage) return {};
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(usage)) {
    const n = Number(value);
    if (!isNaN(n)) result[key] = n;
  }
  return result;
}

function accumulateUsage(
  target: Record<string, number>,
  addition: Record<string, number>
): void {
  for (const [key, value] of Object.entries(addition)) {
    target[key] = (target[key] || 0) + value;
  }
}

