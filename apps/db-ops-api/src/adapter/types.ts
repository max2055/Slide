/**
 * IAgentEngine — Agent abstraction layer interface contract.
 *
 * Defines the platform contract for agent adapters (DirectAdapter, OpenClawAdapter).
 * Platform code depends ONLY on this interface, not on any specific adapter.
 *
 * @slide/agent-core integration:
 *   - ToolSchema is imported from @slide/agent-core (NOT from tools/types.ts)
 *   - Adapters wrap AgentRunner behind this interface
 *
 * ChatEvent union types (6 variants):
 *   text_delta | tool_start | tool_result | tool_error | complete | error
 */

import type { ToolSchema } from '@slide/agent-core';

// ── ChatEvent discriminated union ──

export interface TextDeltaEvent {
  type: 'text_delta';
  delta: string;
}

export interface ToolStartEvent {
  type: 'tool_start';
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolResultEvent {
  type: 'tool_result';
  toolName: string;
  result: unknown;
}

export interface ToolErrorEvent {
  type: 'tool_error';
  toolName: string;
  error: string;
}

export interface CompleteEvent {
  type: 'complete';
  finalContent?: string;
  thinkingContent?: string;
}

export interface ThinkingDeltaEvent {
  type: 'thinking_delta';
  delta: string;
}

export interface ThinkingEndEvent {
  type: 'thinking_end';
}

export interface ErrorEvent {
  type: 'error';
  error: string;
}

export type ChatEvent =
  | TextDeltaEvent
  | ToolStartEvent
  | ToolResultEvent
  | ToolErrorEvent
  | ThinkingDeltaEvent
  | ThinkingEndEvent
  | CompleteEvent
  | ErrorEvent;

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
}

// ── Chat result ──

export interface ChatResult {
  /** Final assistant content, null if no response */
  finalContent: string | null;
  /** Token usage stats (input/output tokens) */
  usage?: Record<string, number>;
}

// ── Invoke result ──

export interface InvokeResult {
  /** Assistant content from fire-and-forget execution */
  content: string | null;
  /** Token usage stats */
  usage?: Record<string, number>;
}

// ── IAgentEngine interface ──

export interface IAgentEngine {
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
    onEvent: (event: ChatEvent) => void,
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
