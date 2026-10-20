import type { LLMProvider } from '@slide/agent-core';
import { AsyncLocalStorage } from 'node:async_hooks';
import { operationsProductBudget, type OperationsBudgetJournal } from '../product-budget.js';
import { sourceFailure } from './config.js';

/** Wrap the actual HTTP boundary, not an estimated chat count. Reservation is
 * fsynced before send; usage is settled before returning any response. No retry,
 * redirect or streaming lane can escape the canonical batch journal. */
export function bindSourceProvider(provider: LLMProvider, journal: OperationsBudgetJournal = operationsProductBudget()) {
  if (provider.getDefaultModel() !== 'deepseek-flash') sourceFailure('PROVIDER_CONFIGURATION');
  const client = (provider as unknown as { client?: { fetch: typeof fetch; maxRetries: number } }).client;
  if (!client || client.maxRetries !== 0 || typeof client.fetch !== 'function') sourceFailure('PROVIDER_TRANSPORT');
  const calls = new AsyncLocalStorage<{ summary: boolean }>();
  const chat = provider.chat.bind(provider);
  provider.chat = (messages, tools, options) => calls.run({
    summary: (options as typeof options & { requestIdentity?: { purpose?: string } })?.requestIdentity?.purpose === 'summary',
  }, () => chat(messages, tools, options));
  const original = client.fetch.bind(client);
  client.fetch = async (input, init) => {
    const request = new Request(input, init);
    let bodyText = await request.clone().text();
    let effectiveInit = { ...init, redirect: 'error' as const };
    const body = JSON.parse(bodyText);
    if (request.url !== 'https://api.deepseek.com/v1/chat/completions' || request.method !== 'POST'
      || body.model !== 'deepseek-flash' || body.stream || !Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1)
      sourceFailure('PROVIDER_PROTOCOL');
    if (calls.getStore()?.summary) {
      // DeepSeek Flash defaults to high thinking. Internal compaction is bounded
      // JSON extraction; reserve its existing ceiling for the actual summary.
      bodyText = JSON.stringify({ ...body, thinking: { type: 'disabled' } });
      const headers = Object.fromEntries(request.headers.entries());
      headers['content-length'] = String(Buffer.byteLength(bodyText));
      // Keep the SDK's URL + init contract, including its Node agent/signal.
      // Its installed node-fetch cannot consume a global WHATWG Request.
      effectiveInit = { ...effectiveInit, headers, body: bodyText };
    }
    // UTF-8 bytes conservatively bound text tokenization including JSON/tool overhead.
    const send = journal.reserve(Buffer.byteLength(bodyText) + 4096, body.max_tokens);
    let settled = false;
    try {
      const response = await original(input, effectiveInit);
      if (!response.ok) sourceFailure('PROVIDER_RESULT_UNKNOWN');
      const raw = await response.clone().json() as any;
      const state = journal.settle(send.sequence, { inputTokens: raw.usage?.prompt_tokens,
        outputTokens: raw.usage?.completion_tokens,
        cachedInputTokens: raw.usage?.prompt_cache_hit_tokens ?? raw.usage?.prompt_tokens_details?.cached_tokens ?? 0 });
      settled = true;
      if (state.phase !== 'normal') console.info(JSON.stringify({ code: 'V23_SOURCE_BUDGET_CHECKPOINT',
        phase: state.phase, usedTokens: state.usedTokens, remainingTokens: state.remainingTokens }));
      if (state.stopped) sourceFailure('BUDGET_STOPPED');
      return response;
    } catch {
      // A lost response retains a pending/stop record. Never automatically reopen it.
      if (!settled) { try { journal.settle(send.sequence, null); } catch { /* journal preserves uncertainty */ } }
      sourceFailure('PROVIDER_RESULT_UNKNOWN');
    }
  };
  // The source DirectAdapter requests streaming callbacks. Keep its HTTP lane
  // non-streaming so the complete response is durably metered before exposure.
  // Tool-call/usage/error fields remain the original SDK-normalized response.
  provider.chatStream = async (messages, tools, callbacks, options) => {
    const response = await provider.chat(messages, tools, options);
    if (response.finishReason !== 'error') {
      callbacks.onActivity?.();
      if (response.reasoningContent) await callbacks.onThinkingDelta?.(response.reasoningContent);
      if (response.content) await callbacks.onContentDelta(response.content);
    }
    return response;
  };
  return provider;
}
