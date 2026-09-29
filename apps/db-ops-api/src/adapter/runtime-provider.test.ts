import { createServer, type Server, type RequestListener } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { AgentRunner, NoopHook, OpenAIProvider, ToolRegistry, type LLMProvider } from '@slide/agent-core';
import { AnthropicProvider } from './llm-provider.js';
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } });
async function fixture(handler: RequestListener) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as {port: number}).port}`;
}
const providers = [
  ['OpenAI', (baseURL: string) => new OpenAIProvider({ apiKey: 'fixture', baseURL })],
  ['Anthropic', (baseURL: string) => new AnthropicProvider({ apiKey: 'fixture', baseURL })],
] as const;
for (const [name, create] of providers) {
  it(`${name}: actual SDK request honors model-boundary idle cancellation before first token`, async () => {
    const baseURL = await fixture((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); });
    const hook = new NoopHook(); hook.wantsStreaming = () => true;
    const requests: Promise<unknown>[] = [];
    const result = await new AgentRunner(create(baseURL) as LLMProvider).run({ initialMessages: [{ role: 'user', content: 'test' }],
      tools: new ToolRegistry(), model: 'fixture', maxIterations: 10, maxToolResultChars: 1000, hook,
      llmTimeoutS: 2, streamIdleTimeoutS: 0.1, onProviderRequest: p => { requests.push(p); } });
    expect(result.resolution?.reasonCode).toBe('MODEL_IDLE_TIMEOUT');
    await Promise.allSettled(requests);
    expect(requests).toHaveLength(1);
  });
  it(`${name}: SDK 401 preserves status and never retries`, async () => {
    let calls = 0;
    const baseURL = await fixture((_req, res) => { calls++; res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'invalid key', type: 'authentication_error' } })); });
    const result = await new AgentRunner(create(baseURL) as LLMProvider).run({ initialMessages: [{ role: 'user', content: 'test' }],
      tools: new ToolRegistry(), model: 'fixture', maxIterations: 10, maxToolResultChars: 1000, hook: new NoopHook() });
    expect(calls).toBe(1);
    expect(result.runtimeError).toMatchObject({ code: 'PROVIDER_AUTH', providerStatus: 401, attemptId: 1, retryable: false });
  });
}

it.each([false, true])('Anthropic SDK preserves incomplete usage reservation (missing all=%s)', async missingAll => {
  const baseURL = await fixture((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'fixture', type: 'message', role: 'assistant', model: 'fixture', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: 'Complete.' }], ...(missingAll ? {} : { usage: { input_tokens: 12 } }) }));
  });
  const result = await new AgentRunner(new AnthropicProvider({ apiKey: 'fixture', baseURL })).run({ initialMessages: [{ role: 'user', content: 'test' }],
    tools: new ToolRegistry(), model: 'fixture', maxIterations: 2, maxToolResultChars: 1000, hook: new NoopHook(),
    budgetLimits: { maxToolCalls: 500, maxProviderAttempts: 600, maxTotalTokens: 1_000_000, maxNoProgressSteps: 12 } });
  expect(result.runtimeState).toMatchObject({ unknownRequests: 1, reservedTokens: 204096 });
});
it.each(['OpenAI', 'Anthropic'])('%s SDK normalizes cached tokens as an input subset', async name => {
  const baseURL = await fixture((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(name === 'OpenAI'
      ? { id: 'fixture', choices: [{ message: { role: 'assistant', content: 'Complete.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 60 } } }
      : { id: 'fixture', type: 'message', role: 'assistant', model: 'fixture', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Complete.' }], usage: { input_tokens: 20, cache_read_input_tokens: 60, cache_creation_input_tokens: 20, output_tokens: 10 } }));
  });
  const provider = providers.find(([n]) => n === name)![1](baseURL);
  const response = await provider.chat([{ role: 'user', content: 'test' }], [], { model: 'fixture' });
  expect(response.usage).toEqual({ prompt_tokens: 100, completion_tokens: 10, cached_tokens: 60 });
});
