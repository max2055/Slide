import type { AgentHookContext, AgentRunResult, AgentRunSpec, LLMResponse, Message, ToolCallRequest } from "../types.js";

import { ModelStep, TimeoutError, requestFinalizationRetry } from "./model-step.js";
import { ToolExecutor, executeTools } from "./tool-executor.js";
import { emitCheckpoint } from "./checkpoint.js";
import { createTurnState, transition } from "./turn-state.js";
import { dropOrphanToolResults, backfillMissingToolResults, microcompact, applyToolResultBudget, snipHistory, normalizeToolResult } from "./legacy-context.js";
const DEFAULT_ERROR_MESSAGE = "Sorry, I encountered an error calling the AI model.";
const PERSISTED_MODEL_ERROR_PLACEHOLDER =
  "[Assistant reply unavailable due to model error.]";
const MAX_EMPTY_RETRIES = 2;
const MAX_LENGTH_RECOVERIES = 3;
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
    let state = createTurnState(spec.initialMessages);
    for (let iteration = 0; iteration < spec.maxIterations; iteration++) {
      if (spec.signal?.aborted) { state.stopReason = 'cancelled'; state.error = 'Cancelled'; break; }
      state = transition(state, "model_running");
      state.modelSteps++;
      state.providerAttempts++;
      // ── Context governance ──
      let messagesForModel: Message[];
      try {
        messagesForModel = dropOrphanToolResults(state.messages);
        messagesForModel = backfillMissingToolResults(messagesForModel);
        messagesForModel = microcompact(messagesForModel);
        messagesForModel = applyToolResultBudget(spec, messagesForModel);
        messagesForModel = snipHistory(spec, messagesForModel, this.getProvider());
        messagesForModel = dropOrphanToolResults(messagesForModel);
        messagesForModel = backfillMissingToolResults(messagesForModel);
      } catch {
        try {
          messagesForModel = dropOrphanToolResults(state.messages);
          messagesForModel = backfillMissingToolResults(messagesForModel);
        } catch {
          messagesForModel = state.messages;
        }
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
      await hook.beforeIteration(context);

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
        };
        if (!isTimeout) console.error("[AgentRunner] LLM request failed:", errMsg);
      }
      if (spec.signal?.aborted) { state.stopReason = 'cancelled'; state.error = 'Cancelled'; break; }
      const rawUsage = usageDict(response.usage);
      context.response = response;
      context.usage = { ...rawUsage };
      context.toolCalls = [...response.toolCalls];
      accumulateUsage(state.usage, rawUsage);

      // Extract reasoning content
      let cleanedContent = response.content || "";
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
      if (response.shouldExecuteTools && response.toolCalls.length > 0) {
        state = transition(state, "tools_running");
        state.toolCalls += response.toolCalls.length;
        context.toolCalls = [...response.toolCalls];
        if (hook.wantsStreaming()) {
          await hook.onStreamEnd(context, true); // resuming
        }

        const assistantMsg = buildAssistantMessage(
          response.content || "",
          response.toolCalls,
          (response as any)._extra, // Preserve provider-specific fields (e.g., reasoning_content)
        );
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

        await hook.beforeExecuteTools(context);

        // Execute tools (potentially in parallel)
        const { results, events, fatalError } = await executeTools(
          spec,
          response.toolCalls,
          state.externalLookupCounts,
          iteration,
          this.executor,
        );
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
            content: normalizeToolResult(spec, tc.id, tc.name, results[i]),
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

        await emitCheckpoint(spec, {
          phase: "tools_completed",
          iteration,
          model: spec.model,
          assistantMessage: assistantMsg,
          completedToolResults,
          pendingToolCalls: [],
        });

        state.emptyContentRetries = 0;
        state.lengthRecoveryCount = 0;

        const [drained, newCycles2] = await tryDrainInjections(
          spec,
          state.messages,
          null,
          state.injectionCycles,
          "after tool execution",
          undefined
        );
        state.injectionCycles = newCycles2;
        if (drained) state.hadInjections = true;

        await hook.afterIteration(context);
        continue;
      }

      // ── Text response path (no tool calls) ──

      state = transition(state, "candidate_final");
      const clean = hook.finalizeContent(context, response.content) || "";

      // Empty response retry
      if (response.finishReason !== "error" && isBlankText(clean)) {
        state.emptyContentRetries++;
        if (state.emptyContentRetries < MAX_EMPTY_RETRIES) {
          if (hook.wantsStreaming()) {
            await hook.onStreamEnd(context, false);
          }
          await hook.afterIteration(context);
          continue;
        }
        // Retry with finalization prompt
        if (hook.wantsStreaming()) {
          await hook.onStreamEnd(context, false);
        }
        state.providerAttempts++;
        const retryResp = await requestFinalizationRetry(spec, messagesForModel, this.getProvider());
        const retryUsage = usageDict(retryResp.usage);
        accumulateUsage(state.usage, retryUsage);
        const retryClean = hook.finalizeContent(context, retryResp.content) || "";

        if (retryResp.finishReason === "error") {
          state.finalContent = retryResp.error || spec.errorMessage || DEFAULT_ERROR_MESSAGE;
          state.stopReason = retryResp.errorKind === 'timeout' ? 'timed_out' : 'error';
          state.error = state.finalContent;
          appendModelErrorPlaceholder(state.messages);
          context.finalContent = state.finalContent;
          context.error = state.error;
          context.stopReason = state.stopReason;
          await hook.afterIteration(context);
          break;
        }

        if (isBlankText(retryClean)) {
          state.finalContent = EMPTY_FINAL_RESPONSE_MESSAGE;
          state.stopReason = "empty_final_response";
          state.error = state.finalContent;
          appendFinalMessage(state.messages, state.finalContent);
          context.finalContent = state.finalContent;
          context.error = state.error;
          context.stopReason = state.stopReason;
          await hook.afterIteration(context);
          const [sc, nc] = await tryDrainInjections(
            spec, state.messages, null, state.injectionCycles, "after empty response", undefined
          );
          state.injectionCycles = nc;
          if (sc) { state.hadInjections = true; continue; }
          break;
        }

        // Use retry result
        state.finalContent = retryClean;
      } else if (response.finishReason === "length" && !isBlankText(clean)) {
        // Length recovery
        state.lengthRecoveryCount++;
        if (state.lengthRecoveryCount <= MAX_LENGTH_RECOVERIES) {
          if (hook.wantsStreaming()) {
            await hook.onStreamEnd(context, true);
          }
          state.messages.push(buildAssistantMessage(clean));
          state.messages.push(buildLengthRecoveryMessage());
          await hook.afterIteration(context);
          continue;
        }
        state.finalContent = clean;
      } else if (response.finishReason === "error") {
        state.finalContent = clean || response.error || spec.errorMessage || DEFAULT_ERROR_MESSAGE;
        state.stopReason = response.errorKind === 'timeout' ? 'timed_out' : "error";
        state.error = state.finalContent;
        appendModelErrorPlaceholder(state.messages);
        context.finalContent = state.finalContent;
        context.error = state.error;
        context.stopReason = state.stopReason;
        await hook.afterIteration(context);
        const [sc, nc] = await tryDrainInjections(
          spec, state.messages, null, state.injectionCycles, "after LLM error", undefined
        );
        state.injectionCycles = nc;
        if (sc) { state.hadInjections = true; continue; }
        break;
      } else {
        state.finalContent = clean;
      }

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
      if (shouldContinue) state.hadInjections = true;

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
      break;
    }

    // Max iterations reached
    if (state.stopReason === "completed" && !state.finalContent) {
      state.stopReason = "max_iterations";
      state.finalContent =
        spec.maxIterationsMessage ||
        `[Maximum iterations (${spec.maxIterations}) reached — task may be incomplete.]`;
      appendFinalMessage(state.messages, state.finalContent);
    }

    state = transition(state, state.stopReason === "completed" ? "response_ready" : "terminal");
    return {
      finalContent: state.finalContent,
      messages: state.messages,
      toolsUsed: state.toolsUsed,
      usage: state.usage,
      stopReason: state.stopReason,
      error: state.error,
      toolEvents: state.toolEvents,
      hadInjections: state.hadInjections,
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

function buildLengthRecoveryMessage(): Message {
  return {
    role: "user",
    content:
      "[System: Your previous response was truncated due to output length. " +
      "Please continue from where you left off.]",
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

