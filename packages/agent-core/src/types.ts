/**
 * @slide/agent-core — Core types for the agent engine.
 *
 * TypeScript contracts defined for the Slide Agent runtime.
 */

// ── Tool definitions ──

export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, JsonSchemaProperty>;
    required?: string[];
  };
  metadata?: {
    readOnly?: boolean;
    scope?: string[];
    ownerOnly?: boolean;
    group?: string;
    pluginId?: string;
    requiresApproval?: boolean;
    dangerLevel?: number;
  };
}

export interface JsonSchemaProperty {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  nullable?: boolean;
}

// ── LLM provider interface ──

export interface LLMResponse {
  /** Provider HTTP request identifier when available; never a credential. */
  requestId?: string;
  content: string | null;
  reasoningContent?: string | null;
  thinkingBlocks?: unknown[];
  finishReason: "stop" | "length" | "tool_calls" | "error" | string;
  toolCalls: ToolCallRequest[];
  usage: Record<string, number>;
  rawResponse?: string;
  runtimeError?: import("./runtime/recovery-policy.js").RuntimeError;
  retryAfterMs?: number;
  errorKind?: string;
  error?: string;
  errorCode?: string;
  providerStatus?: number;
  shouldExecuteTools: boolean;
  hasToolCalls: boolean;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMProvider {
  /** Optional exact provider-aware count including schemas and images. */
  countPromptTokens?(messages: Message[], tools: ToolSchema[]): number;
  /** Default model name. */
  getDefaultModel(): string;

  /** Non-streaming chat call. */
  chat(
    messages: Message[],
    tools: ToolSchema[],
    options?: LLMCallOptions
  ): Promise<LLMResponse>;

  /** Streaming chat call. Returns response with `content` set to final text. */
  chatStream(
    messages: Message[],
    tools: ToolSchema[],
    callbacks: StreamCallbacks,
    options?: LLMCallOptions
  ): Promise<LLMResponse>;
}

export interface LLMCallOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: string;
  /** Wall-clock timeout in seconds for non-streaming requests. Default: NANOBOT_LLM_TIMEOUT_S (300). */
  timeoutS?: number;
  /** Idle timeout in seconds for streaming requests (no token for this long → abort). */
  streamIdleTimeoutS?: number;
  signal?: AbortSignal;
}

export interface StreamCallbacks {
  /** Providers must await each delta callback; resolution means bounded admission.
   * The model boundary drains consumers before returning the response. */
  onActivity?: () => void;
  onContentDelta: (delta: string) => Promise<void> | void;
  onThinkingDelta?: (delta: string) => Promise<void> | void;
  onToolCallDelta?: (delta: Record<string, unknown>) => Promise<void> | void;
}

// ── Messages ──

export interface Message {
  id?: string;
  runId?: string;
  turnId?: string;
  /** Local provenance; provider adapters serialize only provider-supported fields. */
  source?: 'fact' | 'derived' | 'runtime' | 'synthetic';
  /** Assigned only by the trusted assembler; never parsed from context text. */
  contextAuthority?: 'policy';
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentBlock[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string | null;
  thinking_blocks?: unknown[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string }; _meta?: Record<string, unknown> };

// ── Agent hook ──

export interface AgentHookContext {
  iteration: number;
  messages: Message[];
  response: LLMResponse | null;
  usage: Record<string, number>;
  toolCalls: ToolCallRequest[];
  toolResults: unknown[];
  toolEvents: ToolEvent[];
  streamedContent: boolean;
  streamedReasoning: boolean;
  finalContent: string | null;
  stopReason: string | null;
  error: string | null;
}

export interface ToolEvent {
  name: string;
  status: "ok" | "error";
  detail: string;
}

export interface RuntimeResolution {
  kind: "response_ready" | "partial" | "cancelled" | "timed_out" | "failed";
  reasonCode: string;
  retryable: boolean;
  safePartialContent?: string;
}

export interface AgentHook {
  onCandidateRejected?(ctx: AgentHookContext, safeContent: string, reasonCode: string): Promise<void> | void;
  wantsStreaming(): boolean;
  beforeIteration(ctx: AgentHookContext): Promise<void> | void;
  onStream(ctx: AgentHookContext, delta: string, signal?: AbortSignal): Promise<void> | void;
  onStreamEnd(ctx: AgentHookContext, resuming: boolean): Promise<void> | void;
  beforeExecuteTools(ctx: AgentHookContext): Promise<void> | void;
  emitReasoning(text: string | null, signal?: AbortSignal): Promise<void> | void;
  emitReasoningEnd(): Promise<void> | void;
  afterIteration(ctx: AgentHookContext): Promise<void> | void;
  finalizeContent(ctx: AgentHookContext, content: string | null): string | null;
}

// ── Agent run spec & result ──

export interface AgentRunSpec {
  streamingLimits?: import('./runtime/streaming-coordinator.js').StreamingLimits;
  runtimeRunId?: string;
  onRuntimeEvent?: (event: import("./runtime/events.js").RuntimeEvent) => void | Promise<void>;
  budgetLimits?: import("./runtime/contracts.js").RuntimeBudgetLimits;
  runTimeoutMs?: number;
  toolTimeoutMs?: number;
  resumeCheckpoint?: Record<string, unknown>;
  recoveryLimits?: import("./runtime/recovery-policy.js").RecoveryLimits;
  streamIdleTimeoutS?: number;
  onToolExecution?: (execution: Promise<unknown>) => void;
  supervisorMode?: "observe" | "enforce";
  initialMessages: Message[];
  tools: ToolRegistry;
  model: string;
  maxIterations: number;
  maxToolResultChars: number;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: string;
  hook: AgentHook;
  errorMessage?: string;
  maxIterationsMessage?: string;
  concurrentTools?: boolean;
  failOnToolError?: boolean;
  /** Maximum number of consecutive identical tool calls before the loop guard blocks one. */
  loopGuardThreshold?: number;
  workspace?: string;
  sessionKey?: string;
  contextPolicy?: { watermark?: number; target?: number; summaryMaxTokens?: number };
  /** Caller-owned facts. Never derive authorization from model summaries. */
  contextPins?: { goal?: string; constraints?: string[]; pending?: string[]; evidence?: string[]; uncertain?: string[] };
  contextWindowTokens?: number;
  contextBlockLimit?: number;
  providerRetryMode?: string;
  progressCallback?: ((incremental: string) => Promise<void>) | null;
  streamProgressDeltas?: boolean;
  retryWaitCallback?: ((content: string) => Promise<void>) | null;
  checkpointCallback?: ((payload: Record<string, unknown>) => Promise<void>) | null;
  injectionCallback?: ((limit?: number) => Promise<Message[]>) | null;
  llmTimeoutS?: number;
  signal?: AbortSignal;
  /** Observe the actual provider request, which may outlive cancellation of the run.
   * Synchronous lifecycle observer; must not throw or leave rejections unhandled. */
  onProviderRequest?: (request: Promise<LLMResponse>) => void;
  /** Stable caller-supplied key for idempotent side-effecting tools. */
  idempotencyKey?: string;
  /** Progress emitted by a long-running tool operation. */
  toolProgressCallback?: ((event: Record<string, unknown>) => Promise<void> | void) | null;
}

export interface AgentRunResult {
  runtimeError?: import("./runtime/recovery-policy.js").RuntimeError;
  runtimeState?: import("./runtime/recovery-policy.js").RecoverySnapshot;
  resolution?: RuntimeResolution;
  finalContent: string | null;
  messages: Message[];
  toolsUsed: string[];
  usage: Record<string, number>;
  stopReason: string;
  error: string | null;
  toolEvents: ToolEvent[];
  hadInjections: boolean;
}

// ── Tool registry (interface for the spec) ──

export interface ToolRegistry {
  register(tool: Tool): void;
  unregister(name: string): void;
  get(name: string): Tool | undefined;
  has(name: string): boolean;
  getDefinitions(): ToolSchema[];
  execute(name: string, params: Record<string, unknown>, context?: ToolExecutionContext): Promise<unknown>;
  readonly toolNames: string[];
}

// ── Runtime Checkpoint types ──

export interface RuntimeCheckpoint {
  assistant_message?: Record<string, unknown>;
  completed_tool_results?: Record<string, unknown>[];
  pending_tool_calls?: Record<string, unknown>[];
}

// ── Tool interface ──

export interface ToolExecutionContext {
  signal?: AbortSignal;
  sessionKey?: string;
  idempotencyKey?: string;
  progressCallback?: ((event: Record<string, unknown>) => Promise<void> | void) | null;
  /** Let AgentRunner observe thrown exceptions instead of stringifying them. */
  preserveErrors?: boolean;
}

export interface Tool {
  /** Trusted server-side handler boundary; never supplied by model arguments. */
  readonly timeoutMs?: number;
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolSchema["parameters"];
  readonly readOnly: boolean;
  readonly concurrencySafe: boolean;
  readonly exclusive: boolean;
  /** Tool scopes for auto-discovery filtering. Default ["core"]. "subagent" scope allows use in subagents. */
  readonly scope?: string[];
  readonly ownerOnly?: boolean;
  readonly group?: string;
  readonly pluginId?: string;
  readonly requiresApproval?: boolean;
  readonly dangerLevel?: number;
  execute(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<unknown>;
  castParams?(params: Record<string, unknown>): Record<string, unknown>;
}
export type { TurnPhase, RunControl, RuntimeStateSnapshot } from './runtime/contracts.js';
