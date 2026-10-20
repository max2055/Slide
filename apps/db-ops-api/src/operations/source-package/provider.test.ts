import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationsBudgetJournal } from '../product-budget.js';
import { bindSourceProvider } from './provider.js';
import { OpenAIProvider } from '@slide/agent-core';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
function fixture(reply: () => Promise<Response>) {
  const dir = mkdtempSync(join(tmpdir(), 'v23-source-budget-')); directories.push(dir);
  const journal = new OperationsBudgetJournal(join(dir, 'synthetic.jsonl')); journal.initialize();
  const client = { maxRetries: 0, fetch: vi.fn(reply) as unknown as typeof fetch };
  const provider = { getDefaultModel: () => 'deepseek-flash', client, chat: vi.fn(), chatStream: vi.fn() };
  bindSourceProvider(provider, journal);
  const send = (body: unknown = {}) => client.fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST', body: JSON.stringify({ model: 'deepseek-flash', max_tokens: 100, messages: [], ...body as object }) });
  return { client, journal, send };
}
describe('source provider reuses one durable batch budget (synthetic transport)', () => {
  it('meters the real SDK/provider request while substituting only its HTTP transport', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'v23-source-budget-')); directories.push(dir);
    const journal = new OperationsBudgetJournal(join(dir, 'synthetic.jsonl')); journal.initialize();
    const provider = new OpenAIProvider({ apiKey: 'synthetic-no-key', model: 'deepseek-flash', baseURL: 'https://api.deepseek.com/v1' });
    const client = (provider as unknown as { client: { fetch: typeof fetch } }).client;
    client.fetch = vi.fn(async () => {
      expect(journal.read().pending).not.toBeNull();
      return Response.json({ id: 'synthetic', model: 'deepseek-flash', choices: [{ index: 0, finish_reason: 'stop',
        message: { role: 'assistant', content: 'synthetic response' } }], usage: { prompt_tokens: 70, completion_tokens: 20 } });
    });
    bindSourceProvider(provider, journal);
    expect(await provider.chat([], [], { maxTokens: 100 })).toMatchObject({ content: 'synthetic response' });
    expect(journal.read()).toMatchObject({ usedTokens: 90, requests: 1, reservedTokens: 0 });
  });
  it('reserves before HTTP and settles actual usage; cached input is a subset', async () => {
    let f: ReturnType<typeof fixture>;
    f = fixture(async () => {
      expect(f.journal.read().pending).not.toBeNull();
      return Response.json({ usage: { prompt_tokens: 70, completion_tokens: 20, prompt_cache_hit_tokens: 60 } });
    });
    await f.send(); expect(f.journal.read()).toMatchObject({ usedTokens: 90, reservedTokens: 0, requests: 1 });
  });
  it.each(['lost', 'missing'])('quarantines %s response and does not retry', async kind => {
    const original = vi.fn(async () => {
      if (kind === 'lost') throw Error('unknown network result');
      return Response.json({ usage: {} });
    });
    const f = fixture(original);
    await expect(f.send()).rejects.toThrow('PROVIDER_RESULT_UNKNOWN');
    expect(f.journal.read().stopped).toBe(true);
    await expect(f.send()).rejects.toThrow('OPERATIONS_BUDGET_STOPPED');
    expect(original).toHaveBeenCalledTimes(1);
  });
  it('rejects streaming, changed model and retry transport before any reservation', async () => {
    const f = fixture(async () => Response.json({}));
    await expect(f.send({ stream: true })).rejects.toThrow('PROVIDER_PROTOCOL');
    await expect(f.send({ model: 'other' })).rejects.toThrow('PROVIDER_PROTOCOL');
    expect(f.journal.read().requests).toBe(0);
    expect(() => bindSourceProvider({ getDefaultModel: () => 'deepseek-flash', client: { fetch, maxRetries: 1 } } as never, f.journal)).toThrow('PROVIDER_TRANSPORT');
  });
});
