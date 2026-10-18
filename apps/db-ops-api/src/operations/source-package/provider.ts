import type { LLMProvider } from '@slide/agent-core';
import { operationsProductBudget, type OperationsBudgetJournal } from '../product-budget.js';
import { sourceFailure } from './config.js';

/** Wrap the actual HTTP boundary, not an estimated chat count. Reservation is
 * fsynced before send; usage is settled before returning any response. No retry,
 * redirect or streaming lane can escape the canonical batch journal. */
export function bindSourceProvider(provider: LLMProvider, journal: OperationsBudgetJournal = operationsProductBudget()) {
  if (provider.getDefaultModel() !== 'deepseek-flash') sourceFailure('PROVIDER_CONFIGURATION');
  const client = (provider as unknown as { client?: { fetch: typeof fetch; maxRetries: number } }).client;
  if (!client || client.maxRetries !== 0 || typeof client.fetch !== 'function') sourceFailure('PROVIDER_TRANSPORT');
  const original = client.fetch.bind(client);
  client.fetch = async (input, init) => {
    const request = new Request(input, init), bodyText = await request.clone().text(), body = JSON.parse(bodyText);
    if (request.url !== 'https://api.deepseek.com/v1/chat/completions' || request.method !== 'POST'
      || body.model !== 'deepseek-flash' || body.stream || !Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1)
      sourceFailure('PROVIDER_PROTOCOL');
    // UTF-8 bytes conservatively bound text tokenization including JSON/tool overhead.
    const send = journal.reserve(Buffer.byteLength(bodyText) + 4096, body.max_tokens);
    let settled = false;
    try {
      const response = await original(input, { ...init, redirect: 'error' });
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
  return provider;
}
