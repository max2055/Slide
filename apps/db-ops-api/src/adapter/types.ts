/**
 * IAgentEngine — Agent abstraction layer interface contract.
 *
 * Defines the platform contract for agent adapters (DirectAdapter).
 * Platform code depends ONLY on this interface, not on any specific adapter.
 *
 * @slide/agent-core integration:
 *   - ToolSchema is imported from @slide/agent-core (NOT from tools/types.ts)
 *   - Adapters wrap AgentRunner behind this interface
 *
 * ChatEvent union types (6 variants):
 *   text_delta | tool_start | tool_result | tool_error | complete | error
 */

import type { ToolSchema, RuntimeResolution } from '@slide/agent-core';

// ── ChatEvent discriminated union ──

export interface TextDeltaEvent {
  type: 'text_delta';
  delta: string;
  partId?: string;
  partText?: string;
  /** Replace text and reasoning together; old clients already replace delta. */
  reset?: boolean;
  thinkingContent?: string;
  anchorId?: string;
  sourceRequestId?: string;
  discardedBytes?: number;
}


export type ToolStartEvent = Extract<import('@slide/agent-core/tool-stream').ToolWireEvent, { type: 'tool_start' }>;
export type ToolResultEvent = Extract<import('@slide/agent-core/tool-stream').ToolWireEvent, { type: 'tool_result' }>;
export type ToolErrorEvent = Extract<import('@slide/agent-core/tool-stream').ToolWireEvent, { type: 'tool_error' }>;
export type ToolStateEvent = Extract<import('@slide/agent-core/tool-stream').ToolWireEvent, { type: 'tool_state' }>;

export interface ChatTerminalContent {
  resolution?: RuntimeResolution;
  finalContent?: string;
  thinkingContent?: string;
  stopReason?: string;
  /** Monotonic chat_messages.id assigned by the shared database. */
  messageSequence?: number;
}

export interface CompleteEvent extends ChatTerminalContent {
  type: 'complete';
}

export type ToolProgressEvent = Extract<import('@slide/agent-core/tool-stream').ToolWireEvent, { type: 'tool_progress' }>;

export interface ThinkingDeltaEvent {
  type: 'thinking_delta';
  delta: string;
}

export interface ThinkingEndEvent {
  type: 'thinking_end';
}

export interface ErrorEvent extends ChatTerminalContent {
  type: 'error';
  error: string;
}

export interface CancelledEvent extends ChatTerminalContent {
  type: 'cancelled';
}

export type ChatEvent = (
  | TextDeltaEvent
  | ToolStartEvent
  | ToolResultEvent
  | ToolErrorEvent
  | ThinkingDeltaEvent
  | ThinkingEndEvent
  | ToolStateEvent
  | ToolProgressEvent
  | CompleteEvent
  | CancelledEvent
  | ErrorEvent) & {
    /** Ordered delivery ordinal; only checkpoint snapshots are durable watermarks. */
    sequence?: number;
    /** Model request epoch persisted across checkpoint recovery. */
    attempt?: number;
  };

/** Async consumers are awaited. Honor signal to stop external work on abort. */
export type ChatEventConsumer = ((event: ChatEvent, signal?: AbortSignal) => void)
  | ((event: ChatEvent, signal?: AbortSignal) => Promise<void>);

// ── Adapter capabilities ──

export interface AgentCapabilities {
  /** Whether streaming chat is supported */
  streaming: boolean;
  /** Whether tool calling is supported */
  toolCalling: boolean;
  /** Maximum context window tokens */
  maxContextTokens: number;
  /** Whether custom system prompts are supported */
  supportsCustomSystemPrompt: boolean;
  features: Record<AgentFeature, AgentFeatureCapability>;
}

export type AgentFeature =
  | 'sessions' | 'files' | 'tools' | 'skills' | 'cron'
  | 'modelSelection' | 'fallback' | 'reload' | 'edit';

export interface AgentFeatureCapability {
  state: 'supported' | 'readonly' | 'unsupported';
  reason?: string;
}

// ── Chat result ──

export interface ChatResult {
  resolution?: RuntimeResolution;
  thinkingContent?: string;
  /** Final assistant content, null if no response */
  finalContent: string | null;
  /** Token usage stats (input/output tokens) */
  usage?: Record<string, number>;
  stopReason?: string;
}

// ── Invoke result ──

export interface InvokeResult {
  resolution?: RuntimeResolution;
  /** Assistant content from fire-and-forget execution */
  content: string | null;
  /** Token usage stats */
  usage?: Record<string, number>;
  /** Tool events from agent execution (name, status, detail) */
  toolEvents?: Array<{ name: string; status: string; detail: string }>;
  /** Runner stop reason: completed, max_iterations, error, etc. */
  stopReason?: string;
  /** Concrete provider or tool failure retained when the run is not completed */
  error?: string | null;
  /** Number of LLM iterations executed */
  iterationCount?: number;
}

export interface InvokeOptions {
  purpose?: string;
  signal?: AbortSignal;
  /** Bind the internal completion tool to exactly one analysis record. */
  analysisId?: number;
  /** Trusted durable execution callbacks; never accepted from model/HTTP arguments. */
  runtimeRunId?: string;
  beforeProviderRequest?: () => Promise<void>;
  recordAnalysisExecution?: (event: import('../analysis/analysis-execution.js').AnalysisExecutionEvent) => Promise<void>;
  completeAnalysis?: (envelope: unknown) => Promise<{ success: boolean; error?: string }>;
}

// ── IAgentEngine interface ──

export interface IAgentEngine {
  /** Close partially initialized transport and owned resources on startup failure. */
  dispose?(): Promise<void>;
  /**
   * Start the WebSocket transport layer service.
   * - DirectAdapter starts a minimal WS server on AGENT_WS_PORT (default 28888)
   * - Idempotent: repeated calls do NOT start a second server
   *
   * Called by server.ts after startup to ensure WS port is ready
   * before the frontend Chat connects.
   */
  start(): Promise<void>;

  /**
   * Streaming chat session.
   * @param sessionKey - Unique session identifier
   * @param message - User message
   * @param onEvent - Callback receiving typed ChatEvent payloads
   * @returns ChatResult with final content and usage
   */
  chat(
    sessionKey: string,
    message: string,
    onEvent: ChatEventConsumer,
  ): Promise<ChatResult>;

  /**
   * Fire-and-forget task execution (AI analysis, alerts, etc.).
   * Non-streaming, no session persistence.
   * @param sessionKey - Session identifier
   * @param message - Task message
   * @param systemPrompt - Optional custom system prompt
   * @returns InvokeResult with content and usage
   */
  invoke(
    sessionKey: string,
    message: string,
    systemPrompt?: string,
    options?: InvokeOptions,
  ): Promise<InvokeResult>;

  /**
   * List all registered tools with their schemas.
   * @returns ToolSchema array from @slide/agent-core
   */
  listTools(): ToolSchema[];

  /**
   * Query adapter capabilities for graceful degradation.
   */
  capabilities(): AgentCapabilities;
}
