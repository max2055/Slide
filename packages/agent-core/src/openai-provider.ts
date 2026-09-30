/**
 * OpenAIProvider — implements LLMProvider via OpenAI-compatible API.
 *
 * Supports OpenAI, DeepSeek, Aliyun (Qwen), Kimi, Ollama, and any
 * other OpenAI-compatible endpoint. Configured with apiKey + optional baseURL.
 */

import OpenAI from "openai";
import { projectProviderMessages, hasMessageAttachments } from './message-parts.js';
import { FamilyTokenCounter } from './token-estimation.js';
import { isNativeOpenAIEndpoint, openAIModelCapabilities, type ModelCapabilities } from './model-context.js';
import type {
  LLMProvider,
  Message,
  ToolSchema,
  LLMResponse,
  LLMCallOptions,
  StreamCallbacks,
} from "./types.js";

const THINK_OPEN_TAG_PREFIXES = [
  '<', '<t', '<th', '<thi', '<thin', '<think', '<thinki', '<thinkin', '<thinking',
];

/** Keep only a suffix that can still become a split <think> opening tag. */
export function retainPartialThinkOpenTag(value: string): string {
  const lower = value.toLowerCase();
  for (let length = Math.min(THINK_OPEN_TAG_PREFIXES.at(-1)!.length, value.length); length > 0; length -= 1) {
    const suffix = lower.slice(-length);
    if (THINK_OPEN_TAG_PREFIXES.includes(suffix)) return value.slice(-length);
  }
  return '';
}

export interface NormalizedProviderError {
  message: string;
  errorCode?: string;
  status?: number;
  retryAfterMs?: number;
}

/** Convert provider HTTP failures into messages an operator can act on. */
export function normalizeProviderError(error: unknown, options?: { media?: boolean }): NormalizedProviderError {
  const normalized = normalizeError(error);
  const headers = (error as { headers?: Headers | Record<string, string> })?.headers;
  const retry = headers instanceof Headers ? headers.get('retry-after') : headers?.['retry-after'];
  const delay = retry == null ? NaN : /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
  return { ...normalized, ...(options?.media ? { message: `LLM_MEDIA_REQUEST_FAILED${normalized.status ? ` (${normalized.status})` : ''}` } : {}),
    ...(Number.isFinite(delay) ? { retryAfterMs: Math.max(0, delay) } : {}) };
}
function normalizeError(error: unknown): NormalizedProviderError {
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown; error?: { message?: unknown } } | null;
  const status = Number(candidate?.status);
  const rawMessage = String(candidate?.message ?? candidate?.error?.message ?? error ?? 'Unknown provider error');
  const lower = rawMessage.toLowerCase();
  if (status === 402 || lower.includes('insufficient balance') || lower.includes('insufficient funds')) {
    return {
      status: 402,
      errorCode: 'LLM_INSUFFICIENT_BALANCE',
      message: '当前大模型服务余额不足，请充值或切换可用模型提供商后重试。',
    };
  }
  if (status === 401 || status === 403) {
    return { status, errorCode: 'LLM_AUTHENTICATION_FAILED', message: '大模型服务认证失败，请检查 API Key 和提供商配置。' };
  }
  if (status === 429) {
    return { status, errorCode: 'LLM_RATE_LIMITED', message: '大模型服务达到频率或配额限制，请稍后重试或切换提供商。' };
  }
  if (status >= 500 && status <= 599) {
    return { status, errorCode: 'LLM_PROVIDER_UNAVAILABLE', message: '大模型服务暂时不可用，请稍后重试或切换提供商。' };
  }
  return {
    ...(Number.isFinite(status) && status > 0 ? { status } : {}),
    ...(typeof candidate?.code === 'string' ? { errorCode: candidate.code } : /APIConnectionError|connection error|fetch failed/i.test(String((error as Error)?.name) + rawMessage) ? { errorCode: 'APIConnectionError' } : {}),
    message: rawMessage,
  };
}

export class OpenAIProvider implements LLMProvider {
  projectMessages(messages: Message[], model = this.getDefaultModel()): Message[] {
    return projectProviderMessages(messages, { supportsVision: this.getModelCapabilities(model)?.supportsVision === true,
      reasoning: /deepseek|kimi|glm/i.test(model) ? 'tool-turn' : 'omit' });
  }
  private client: OpenAI;
  private model: string;
  private readonly tokenCounter = new FamilyTokenCounter();
  private readonly nativeOpenAI: boolean;
  private readonly capabilities?: ModelCapabilities;

  constructor(opts: {
    apiKey: string;
    baseURL?: string;
    model?: string;
    capabilities?: ModelCapabilities;
  }) {
    this.client = new OpenAI({
      maxRetries: 0, // Runtime owns the shared attempt/recovery budget.
      apiKey: opts.apiKey,
      baseURL: opts.baseURL || undefined,
    });
    this.model = opts.model || "gpt-4.1";
    this.nativeOpenAI = isNativeOpenAIEndpoint(this.client.baseURL);
    this.capabilities = opts.capabilities ? { ...opts.capabilities } : undefined;
  }

  getModelCapabilities(model = this.model): ModelCapabilities | undefined {
    if (this.capabilities?.model === model) return { ...this.capabilities };
    return this.nativeOpenAI ? openAIModelCapabilities(model) : undefined;
  }
  countPromptTokens(messages: Message[], tools: ToolSchema[], model = this.model) {
    return this.nativeOpenAI ? this.tokenCounter.count(messages, tools, model) : undefined;
  }
  invalidateTokenCache(): void { this.tokenCounter.invalidate(); }

  getDefaultModel(): string {
    return this.model;
  }

  async chat(
    messages: Message[],
    tools: ToolSchema[],
    options?: LLMCallOptions,
  ): Promise<LLMResponse> {
    const media = hasMessageAttachments(messages);
    if (messages.some(m => m.messageParts || Array.isArray(m.content) || (m as any).attachments)) messages = this.projectMessages(messages, options?.model);
    try {
      const response = await this.client.chat.completions.create({
        model: options?.model || this.model,
        messages: messages.map(toOpenAIMessage),
        tools: tools.length > 0 ? tools.map(toOpenAITool) : undefined,
        temperature: options?.temperature ?? 0,
        max_tokens: options?.maxTokens,
      }, { signal: options?.signal });

      return { ...parseOpenAIResponse(response), requestId: response._request_id ?? undefined };
    } catch (err) {
      const normalized = normalizeProviderError(err, { media });
      const message = normalized.message;
      console.error("[OpenAIProvider] chat() failed:", message);
      return {
        content: null,
        finishReason: "error",
        toolCalls: [],
        usage: {},
        shouldExecuteTools: false,
        hasToolCalls: false,
        errorKind: "provider_error",
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
    const media = hasMessageAttachments(messages);
    if (messages.some(m => m.messageParts || Array.isArray(m.content) || (m as any).attachments)) messages = this.projectMessages(messages, options?.model);
    try {
      const stream = await this.client.chat.completions.create({
        model: options?.model || this.model,
        messages: messages.map(toOpenAIMessage),
        tools: tools.length > 0 ? tools.map(toOpenAITool) : undefined,
        temperature: options?.temperature ?? 0,
        max_tokens: options?.maxTokens,
        stream: true,
        ...(options?.reasoningEffort ? { reasoning_effort: options.reasoningEffort } as any : {}),
      }, { signal: options?.signal });

      let content = "";
      let finishReason = "error";
      let usage: Record<string, number> = {};
      let reasoningContent = "";
      // Track partial <think> tag streaming across chunks.
      // Some models (e.g. DeepSeek without native thinking mode) embed reasoning
      // inside <think>...</think> tags in the content field rather than using
      // the reasoning_content delta field.
      let thinkTagBuffer = "";
      let inThinkTag = false;
      const THINK_OPEN = /<\s*think(?:ing)?\s*>/i;
      const THINK_CLOSE = /<\s*\/\s*think(?:ing)?\s*>/i;
      const toolCalls: Record<number, { id: string; name: string; arguments: string }> = {};

      for await (const chunk of stream as unknown as AsyncIterable<any>) {
        callbacks.onActivity?.();
        if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
        if (chunk.usage) usage = { prompt_tokens: chunk.usage.prompt_tokens, completion_tokens: chunk.usage.completion_tokens, ...(chunk.usage.prompt_tokens_details?.cached_tokens !== undefined ? { cached_tokens: chunk.usage.prompt_tokens_details.cached_tokens } : {}) };
        const delta = chunk.choices?.[0]?.delta;
        const hasReasoningField = !!(delta as any)?.reasoning_content;

        // Native reasoning_content path (DeepSeek with thinking mode enabled)
        if (hasReasoningField) {
          const rc = (delta as any).reasoning_content || '';
          reasoningContent += rc;
          if (rc && callbacks.onThinkingDelta) await callbacks.onThinkingDelta(rc);
        }

        let deltaContent = delta?.content || '';
        if (!deltaContent) {
          // Still check tool calls even without content
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCalls[idx]) {
                toolCalls[idx] = { id: tc.id || "", name: tc.function?.name || "", arguments: "" };
              }
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function?.name) toolCalls[idx].name = tc.function.name;
              if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
              await callbacks.onToolCallDelta?.(tc);
            }
          }
          continue;
        }

        // ── <think> tag stripping for models that embed reasoning in content ──
        // Accumulate into a buffer so we can detect partial tags across chunks.
        thinkTagBuffer += deltaContent;

        if (inThinkTag) {
          const closeIdx = thinkTagBuffer.search(THINK_CLOSE);
          if (closeIdx !== -1) {
            // Found closing tag — extract reasoning text, keep remaining content
            const reasoningText = thinkTagBuffer.slice(0, closeIdx);
            reasoningContent += reasoningText;
            if (callbacks.onThinkingDelta) await callbacks.onThinkingDelta(reasoningText);
            thinkTagBuffer = thinkTagBuffer.slice(closeIdx + (thinkTagBuffer.match(THINK_CLOSE)?.[0]?.length || 0));
            inThinkTag = false;
            // « fall through » — process any remaining content after </think>
            deltaContent = thinkTagBuffer;
            thinkTagBuffer = "";
          } else {
            // Still inside think tag, no close yet — buffer more
            deltaContent = "";
          }
        }

        if (!inThinkTag && deltaContent) {
          const openMatch = THINK_OPEN.exec(deltaContent);
          if (openMatch) {
            // Content before <think> is real content
            const beforeThink = deltaContent.slice(0, openMatch.index);
            if (beforeThink.trim()) {
              content += beforeThink;
              await callbacks.onContentDelta(beforeThink);
            }
            // Everything after <think> goes to reasoning (may include close tag later)
            thinkTagBuffer = deltaContent.slice(openMatch.index + openMatch[0].length);
            inThinkTag = true;

            // Check if close tag is in the same chunk
            const closeIdx = thinkTagBuffer.search(THINK_CLOSE);
            if (closeIdx !== -1) {
              const reasoningText = thinkTagBuffer.slice(0, closeIdx);
              reasoningContent += reasoningText;
              if (callbacks.onThinkingDelta) await callbacks.onThinkingDelta(reasoningText);
              const afterClose = thinkTagBuffer.slice(closeIdx + (thinkTagBuffer.match(THINK_CLOSE)?.[0]?.length || 0));
              thinkTagBuffer = "";
              inThinkTag = false;
              if (afterClose.trim()) {
                content += afterClose;
                await callbacks.onContentDelta(afterClose);
              }
            }
          } else {
            // Regular content, no <think> tags
            const partial = retainPartialThinkOpenTag(thinkTagBuffer);
            const safeContent = partial ? thinkTagBuffer.slice(0, -partial.length) : thinkTagBuffer;
            if (safeContent) {
              content += safeContent;
              await callbacks.onContentDelta(safeContent);
            }
            thinkTagBuffer = partial;
          }
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCalls[idx]) {
              toolCalls[idx] = { id: tc.id || "", name: tc.function?.name || "", arguments: "" };
            }
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.function?.name) toolCalls[idx].name = tc.function.name;
            if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
            await callbacks.onToolCallDelta?.(tc);
          }
        }
      }

      // Flush any trailing think tag content as reasoning
      if (thinkTagBuffer.trim()) {
        reasoningContent += thinkTagBuffer;
      }

      const parsedToolCalls = Object.values(toolCalls).map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: safeParseJSON(tc.arguments),
      }));

      return {
        content: content || null,
        reasoningContent: reasoningContent || null,
        finishReason,
        toolCalls: parsedToolCalls,
        usage,
        ...(finishReason === 'error' ? { error: 'Provider stream ended without a finish reason', errorKind: 'provider_error', errorCode: 'INCOMPLETE_STREAM' } : {}),
        shouldExecuteTools: finishReason === 'tool_calls' && parsedToolCalls.length > 0,
        hasToolCalls: parsedToolCalls.length > 0,
        // Preserve reasoning_content for DeepSeek thinking mode (required on next turn)
        ...(reasoningContent ? { _extra: { reasoning_content: reasoningContent } } as any : {}),
      };
    } catch (err) {
      const normalized = normalizeProviderError(err, { media });
      const message = normalized.message;
      console.error("[OpenAIProvider] chatStream() failed:", message);
      return {
        content: null,
        finishReason: "error",
        toolCalls: [],
        usage: {},
        shouldExecuteTools: false,
        hasToolCalls: false,
        errorKind: "provider_error",
        error: message,
        errorCode: normalized.errorCode,
        providerStatus: normalized.status,
        retryAfterMs: normalized.retryAfterMs,
      };
    }
  }
}

// ── Helpers ──

function toOpenAIMessage(msg: Message): OpenAI.ChatCompletionMessageParam {
  const extra = (msg as any)._extra as Record<string, unknown> | undefined;
  const reasoningContent = msg.reasoning_content || (extra?.reasoning_content as string | undefined);
  if (msg.role === "system") {
    return { role: "system", content: msg.content as string, ...extra };
  }
  if (msg.role === "tool") {
    return {
      role: "tool",
      tool_call_id: (msg as any).tool_call_id || "",
      content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      ...extra,
    };
  }
  if (msg.role === "assistant" && (msg as any).tool_calls) {
    const toolCalls = (msg as any).tool_calls;
    return {
      role: "assistant",
      content: typeof msg.content === "string" ? msg.content : null,
      tool_calls: toolCalls.map((tc: any) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.function?.name || tc.name,
          arguments: typeof tc.function?.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function?.arguments || tc.arguments || {}),
        },
      })),
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      ...extra,
    };
  }
  return {
    role: msg.role === "assistant" ? "assistant" : "user",
    content: Array.isArray(msg.content) ? msg.content.map(block => block.type === 'text' ? { type: 'text', text: block.text } : { type: 'image_url', image_url: block.image_url }) : msg.content ?? "",
    ...(msg.role === "assistant" && reasoningContent ? { reasoning_content: reasoningContent } : {}),
    ...extra,
  } as OpenAI.ChatCompletionMessageParam;
}

function toOpenAITool(tool: ToolSchema): OpenAI.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    },
  };
}

function parseOpenAIResponse(
  response: OpenAI.ChatCompletion,
): LLMResponse {
  const choice = response.choices?.[0];
  const msg = choice?.message;
  const content = msg?.content || "";
  const toolCalls = (msg?.tool_calls || []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: safeParseJSON(tc.function.arguments),
  }));
  const reasoningContent = (msg as any)?.reasoning_content as string | undefined;

  const result: LLMResponse = {
    content: typeof content === "string" ? content || null : null,
    finishReason: choice?.finish_reason ?? "error",
    toolCalls,
    usage: {
      ...(response.usage ? { prompt_tokens: response.usage.prompt_tokens, completion_tokens: response.usage.completion_tokens, ...(response.usage.prompt_tokens_details?.cached_tokens !== undefined ? { cached_tokens: response.usage.prompt_tokens_details.cached_tokens } : {}) } : {}),
    },
    shouldExecuteTools: choice?.finish_reason === 'tool_calls' && toolCalls.length > 0,
    hasToolCalls: toolCalls.length > 0,
  };
  if (reasoningContent) {
    (result as any)._extra = { reasoning_content: reasoningContent };
  }
  return result;
}

function safeParseJSON(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}
