/**
 * AnthropicProvider — implements @slide/agent-core LLMProvider interface.
 *
 * Wraps the Anthropic SDK to provide chat (non-streaming) and chatStream
 * methods. Receives an immutable connection configuration.
 *
 * Imports ToolSchema from @slide/agent-core (type only).
 * Only this adapter provides Anthropic; OpenAI/Ollama providers can be
 * added later as needed.
 */

import Anthropic from '@anthropic-ai/sdk';
import { normalizeProviderError } from '@slide/agent-core';
import type {
  LLMProvider,
  Message,
  ToolSchema,
  LLMResponse,
  LLMCallOptions,
  StreamCallbacks,
  ModelCapabilities,
} from '@slide/agent-core';
import type {
  TextBlockParam,
  ToolUseBlockParam,
  ToolResultBlockParam,
  ToolUseBlock,
  Tool as AnthropicTool,
} from '@anthropic-ai/sdk/resources/messages';

/**
 * Converts agent-core Message[] to Anthropic SDK messages.
 * System messages are extracted separately.
 */
function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  const anthropicMessages: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') continue; // system goes in system param, not messages

    const content = typeof msg.content === 'string'
      ? msg.content
      : msg.content?.map((b) => (b.type === 'text' ? b.text : '')).join(' ') ?? '';

    // Handle tool results
    if (msg.role === 'tool') {
      const toolResultBlock: ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id || '',
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      };
      anthropicMessages.push({ role: 'user', content: [toolResultBlock] });
      continue;
    }

    // Handle assistant messages with tool calls
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const blocks: (TextBlockParam | ToolUseBlockParam)[] = [];
      if (content) {
        blocks.push({ type: 'text', text: content });
      }
      for (const tc of msg.tool_calls) {
        const toolUseBlock: ToolUseBlockParam = {
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || '{}'),
        };
        blocks.push(toolUseBlock);
      }
      anthropicMessages.push({ role: 'assistant', content: blocks });
      continue;
    }

    anthropicMessages.push({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content,
    });
  }

  return anthropicMessages;
}

/**
 * Extracts system prompt from messages array.
 */
function extractSystemPrompt(messages: Message[]): string | undefined {
  const systemMessages = messages.filter((m) => m.role === 'system');
  if (systemMessages.length === 0) return undefined;
  return systemMessages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
}

/**
 * Converts Anthropic ToolUseBlock to agent-core ToolCallRequest-like object.
 */
function toToolCallRequest(toolUse: ToolUseBlock): {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
} {
  return {
    id: toolUse.id,
    name: toolUse.name,
    arguments: toolUse.input as Record<string, unknown>,
  };
}

/**
 * Converts agent-core ToolSchema to Anthropic tool format.
 */
function toAnthropicTools(tools: ToolSchema[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as AnthropicTool.InputSchema,
  }));
}

export class AnthropicProvider implements LLMProvider {
  private client_: Anthropic | null = null;

  private readonly config: { apiKey?: string; baseURL?: string; model?: string; capabilities?: ModelCapabilities };

  constructor(config: string | { apiKey?: string; baseURL?: string; model?: string; capabilities?: ModelCapabilities } = {}) {
    this.config = typeof config === 'string' ? { apiKey: config } : { ...config,
      ...(config.capabilities ? { capabilities: { ...config.capabilities } } : {}) };
  }

  getModelCapabilities(model = this.getDefaultModel()): ModelCapabilities | undefined {
    return this.config.capabilities?.model === model ? { ...this.config.capabilities } : undefined;
  }

  private get client(): Anthropic {
    if (!this.client_) {
      if (!this.config.apiKey) throw new Error('LLM_CREDENTIAL_NOT_CONFIGURED');
      this.client_ = new Anthropic({ maxRetries: 0, apiKey: this.config.apiKey, baseURL: this.config.baseURL });
    }
    return this.client_;
  }

  getDefaultModel(): string {
    return this.config.model || 'claude-sonnet-4-20250929';
  }

  async chat(
    messages: Message[],
    tools: ToolSchema[],
    options?: LLMCallOptions,
  ): Promise<LLMResponse> {
    const model = options?.model || this.getDefaultModel();
    const systemPrompt = extractSystemPrompt(messages);
    const anthropicMessages = toAnthropicMessages(messages);
    const anthropicTools = tools.length > 0 ? toAnthropicTools(tools) : undefined;

    try {
      const { data: response, response: httpResponse } = await this.client.messages.create({
        model,
        system: systemPrompt,
        messages: anthropicMessages,
        tools: anthropicTools,
        max_tokens: options?.maxTokens || 4096,
        temperature: options?.temperature ?? 0.0,
      }, { signal: options?.signal }).withResponse();

      return { ...this.parseResponse(response), requestId: httpResponse.headers.get('request-id') ?? undefined };
    } catch (err) {
      const normalized = normalizeProviderError(err);
      const message = normalized.message;
      console.error('[AnthropicProvider] chat() failed:', message);
      return {
        content: null,
        finishReason: 'error',
        toolCalls: [],
        usage: {},
        shouldExecuteTools: false,
        hasToolCalls: false,
        errorKind: 'provider_error',
        error: message,
        errorCode: normalized.errorCode,
        providerStatus: normalized.status,
        retryAfterMs: normalized.retryAfterMs,
      };
    }
  }

  async chatStream(
    messages: Message[],
    tools: ToolSchema[],
    callbacks: StreamCallbacks,
    options?: LLMCallOptions,
  ): Promise<LLMResponse> {
    const model = options?.model || this.getDefaultModel();
    const systemPrompt = extractSystemPrompt(messages);
    const anthropicMessages = toAnthropicMessages(messages);
    const anthropicTools = tools.length > 0 ? toAnthropicTools(tools) : undefined;

    try {
      const stream = await this.client.messages.stream({
        model,
        system: systemPrompt,
        messages: anthropicMessages,
        tools: anthropicTools,
        max_tokens: options?.maxTokens || 4096,
        temperature: options?.temperature ?? 0.0,
      }, { signal: options?.signal });

      for await (const event of stream) {
        callbacks.onActivity?.();
        const delta = event.type === 'content_block_delta' ? event.delta as { type: string; thinking?: string } : undefined;
        if (delta?.type === 'thinking_delta' && delta.thinking) await callbacks.onThinkingDelta?.(delta.thinking);
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          await callbacks.onContentDelta(event.delta.text);
        }
      }

      const finalMessage = await stream.finalMessage();
      return this.parseResponse(finalMessage);
    } catch (err) {
      const normalized = normalizeProviderError(err);
      const message = normalized.message;
      console.error('[AnthropicProvider] chatStream() failed:', message);
      return {
        content: null,
        finishReason: 'error',
        toolCalls: [],
        usage: {},
        shouldExecuteTools: false,
        hasToolCalls: false,
        errorKind: 'provider_error',
        error: message,
        errorCode: normalized.errorCode,
        providerStatus: normalized.status,
        retryAfterMs: normalized.retryAfterMs,
      };
    }
  }

  private parseResponse(response: Anthropic.Message): LLMResponse {
    let content = '';
    const toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push(toToolCallRequest(block));
      }
    }

    const finishReason = mapStopReason(response.stop_reason);
    const cacheUsage = response.usage as typeof response.usage & { cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    const usage: Record<string, number> = {};
    if (Number.isSafeInteger(cacheUsage?.input_tokens) && cacheUsage.input_tokens >= 0) {
      usage.prompt_tokens = cacheUsage.input_tokens + (cacheUsage.cache_read_input_tokens ?? 0) + (cacheUsage.cache_creation_input_tokens ?? 0);
      usage.cached_tokens = cacheUsage.cache_read_input_tokens ?? 0;
    }
    if (Number.isSafeInteger(cacheUsage?.output_tokens) && cacheUsage.output_tokens >= 0) usage.completion_tokens = cacheUsage.output_tokens;


    return {
      content: content || null,
      finishReason,
      toolCalls,
      usage,
      shouldExecuteTools: finishReason === 'tool_calls' && toolCalls.length > 0,
      hasToolCalls: toolCalls.length > 0,
    };
  }
}

function mapStopReason(stopReason: string | null | undefined): LLMResponse['finishReason'] {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'error':
      return 'error';
    default:
      return stopReason || 'stop';
  }
}
