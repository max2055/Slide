/**
 * @slide/agent-core — Core types for the agent engine.
 *
 * Ported from nanobot (Python) to TypeScript.
 * Language-agnostic design: these types can be implemented
 * in any language that supports async/await.
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
  content: string | null;
  reasoningContent?: string | null;
  thinkingBlocks?: unknown[];
  finishReason: "stop" | "length" | "tool_calls" | "error" | string;
  toolCalls: ToolCallRequest[];
  usage: Record<string, number>;
  rawResponse?: string;
  errorKind?: string;
  shouldExecuteTools: boolean;
  hasToolCalls: boolean;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMProvider {
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
}

export interface StreamCallbacks {
  onContentDelta: (delta: string) => Promise<void> | void;
  onThinkingDelta?: (delta: string) => Promise<void> | void;
  onToolCallDelta?: (delta: Record<string, unknown>) => Promise<void> | void;
}

// ── Messages ──

export interface Message {
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

export interface AgentHook {
  wantsStreaming(): boolean;
  beforeIteration(ctx: AgentHookContext): Promise<void> | void;
  onStream(ctx: AgentHookContext, delta: string): Promise<void> | void;
  onStreamEnd(ctx: AgentHookContext, resuming: boolean): Promise<void> | void;
  beforeExecuteTools(ctx: AgentHookContext): Promise<void> | void;
  emitReasoning(text: string | null): Promise<void> | void;
  emitReasoningEnd(): Promise<void> | void;
  afterIteration(ctx: AgentHookContext): Promise<void> | void;
  finalizeContent(ctx: AgentHookContext, content: string | null): string | null;
}

// ── Agent run spec & result ──

export interface AgentRunSpec {
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
  workspace?: string;
  sessionKey?: string;
  contextWindowTokens?: number;
  contextBlockLimit?: number;
  providerRetryMode?: string;
  progressCallback?: ((incremental: string) => Promise<void>) | null;
  streamProgressDeltas?: boolean;
  retryWaitCallback?: ((content: string) => Promise<void>) | null;
  checkpointCallback?: ((payload: Record<string, unknown>) => Promise<void>) | null;
  injectionCallback?: ((limit?: number) => Promise<Message[]>) | null;
  llmTimeoutS?: number;
}

export interface AgentRunResult {
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
  execute(name: string, params: Record<string, unknown>): Promise<unknown>;
  readonly toolNames: string[];
}

// ── Runtime Checkpoint types ──

export interface RuntimeCheckpoint {
  assistant_message?: Record<string, unknown>;
  completed_tool_results?: Record<string, unknown>[];
  pending_tool_calls?: Record<string, unknown>[];
}

// ── Tool interface ──

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolSchema["parameters"];
  readonly readOnly: boolean;
  readonly concurrencySafe: boolean;
  readonly exclusive: boolean;
  execute(params: Record<string, unknown>): Promise<unknown>;
  castParams?(params: Record<string, unknown>): Record<string, unknown>;
}
