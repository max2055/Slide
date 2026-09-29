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
