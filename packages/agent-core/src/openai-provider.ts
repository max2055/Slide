/**
 * OpenAIProvider — implements LLMProvider via OpenAI-compatible API.
 *
 * Supports OpenAI, DeepSeek, Aliyun (Qwen), Kimi, Ollama, and any
 * other OpenAI-compatible endpoint. Configured with apiKey + optional baseURL.
 */

import OpenAI from "openai";
import type {
  LLMProvider,
  Message,
  ToolSchema,
  LLMResponse,
  LLMCallOptions,
  StreamCallbacks,
} from "./types.js";

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;

  constructor(opts: {
    apiKey: string;
    baseURL?: string;
    model?: string;
  }) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL || undefined,
    });
    this.model = opts.model || "gpt-4.1";
  }

  getDefaultModel(): string {
    return this.model;
  }

  async chat(
    messages: Message[],
    tools: ToolSchema[],
    options?: LLMCallOptions,
  ): Promise<LLMResponse> {
    try {
      const response = await this.client.chat.completions.create({
        model: options?.model || this.model,
        messages: messages.map(toOpenAIMessage),
        tools: tools.length > 0 ? tools.map(toOpenAITool) : undefined,
        temperature: options?.temperature ?? 0,
        max_tokens: options?.maxTokens,
      });

      return parseOpenAIResponse(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[OpenAIProvider] chat() failed:", message);
      return {
        content: null,
        finishReason: "error",
        toolCalls: [],
        usage: {},
        shouldExecuteTools: false,
        hasToolCalls: false,
        errorKind: "provider_error",
      };
    }
  }

  async chatStream(
    messages: Message[],
    tools: ToolSchema[],
    callbacks: StreamCallbacks,
    options?: LLMCallOptions,
  ): Promise<LLMResponse> {
    try {
      const stream = await this.client.chat.completions.create({
        model: options?.model || this.model,
        messages: messages.map(toOpenAIMessage),
        tools: tools.length > 0 ? tools.map(toOpenAITool) : undefined,
        temperature: options?.temperature ?? 0,
        max_tokens: options?.maxTokens,
        stream: true,
        ...(options?.reasoningEffort ? { reasoning_effort: options.reasoningEffort } as any : {}),
      });

      let content = "";
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

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;
        const hasReasoningField = !!(delta as any)?.reasoning_content;

        // Native reasoning_content path (DeepSeek with thinking mode enabled)
        if (hasReasoningField) {
          const rc = (delta as any).reasoning_content || '';
          reasoningContent += rc;
          if (rc && callbacks.onThinkingDelta) await callbacks.onThinkingDelta(rc);
          continue;
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
            content += deltaContent;
            await callbacks.onContentDelta(deltaContent);
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
        finishReason: parsedToolCalls.length > 0 ? "tool_calls" : "stop",
        toolCalls: parsedToolCalls,
        usage: {},
        shouldExecuteTools: parsedToolCalls.length > 0,
        hasToolCalls: parsedToolCalls.length > 0,
        // Preserve reasoning_content for DeepSeek thinking mode (required on next turn)
        ...(reasoningContent ? { _extra: { reasoning_content: reasoningContent } } as any : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[OpenAIProvider] chatStream() failed:", message);
      return {
        content: null,
        finishReason: "error",
        toolCalls: [],
        usage: {},
        shouldExecuteTools: false,
        hasToolCalls: false,
        errorKind: "provider_error",
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
    content: typeof msg.content === "string" ? msg.content : "",
    ...(msg.role === "assistant" && reasoningContent ? { reasoning_content: reasoningContent } : {}),
    ...extra,
  };
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
    finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
    toolCalls,
    usage: {
      prompt_tokens: response.usage?.prompt_tokens || 0,
      completion_tokens: response.usage?.completion_tokens || 0,
    },
    shouldExecuteTools: toolCalls.length > 0,
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
