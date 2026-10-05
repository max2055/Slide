import { createServer, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { AgentRunner, NoopHook, OpenAIProvider, ToolRegistry } from '@slide/agent-core';
import { AnthropicProvider } from './llm-provider.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
async function endpoint(events: object[], anthropic = false) {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain SDK request */ }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const event of events) response.write(`${anthropic ? `event: ${(event as any).type}\n` : ''}data: ${JSON.stringify(event)}\n\n`);
    response.end(anthropic ? '' : 'data: [DONE]\n\n');
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function callbacks() {
  const events: { kind: string; value: any }[] = [];
  return { events, callbacks: {
    onContentDelta: async (value: string) => { events.push({ kind: 'text', value }); },
    onThinkingDelta: async (value: string) => { events.push({ kind: 'thinking', value }); },
    onToolCallDelta: async (value: unknown) => { events.push({ kind: 'input', value }); },
  } };
}
it.each([false, true])('Anthropic actual SDK forwards JSON fragments with real ID (thinking=%s)', async thinking => {
  const blocks: object[] = [];
  let index = 0;
  if (thinking) {
    blocks.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: '先思考' } },
      { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'opaque' } },
      { type: 'content_block_stop', index }); index++;
  }
  blocks.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index, delta: { type: 'text_delta', text: '检查' } },
    { type: 'content_block_stop', index }); index++;
  blocks.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: 'anthropic-call', name: 'query', input: {} } },
    { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{"sql":' } },
    { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '"SELECT 1"}' } },
    { type: 'content_block_stop', index });
  const baseURL = await endpoint([
    { type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    ...blocks, { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }, { type: 'message_stop' },
  ], true);
  const c = callbacks(); const result = await new AnthropicProvider({ apiKey: 'fixture', baseURL }).chatStream([{ role: 'user', content: 'check' }], [], c.callbacks);
  expect(result.toolCalls).toEqual([{ id: 'anthropic-call', name: 'query', arguments: { sql: 'SELECT 1' } }]);
  expect(c.events.filter(e => e.kind === 'input').map(e => e.value)).toEqual([
    { index, id: 'anthropic-call', function: { name: 'query', arguments: '' } },
    { index, id: 'anthropic-call', function: { arguments: '{"sql":' } },
    { index, id: 'anthropic-call', function: { arguments: '"SELECT 1"}' } },
  ]);
  expect(c.events.filter(e => e.kind === 'thinking').map(e => e.value)).toEqual(thinking ? ['先思考'] : []);
  if (thinking) expect(c.events[0].kind).toBe('thinking');
  expect(result.shouldExecuteTools).toBe(true);
});

it.each(['OpenAI', 'Ollama-compatible'])('%s actual SDK drains trailing thinking callbacks before resolving', async name => {
  const chunk = (delta: object, finish_reason: string | null = null) => ({ id: name, choices: [{ index: 0, delta, finish_reason }] });
  const baseURL = await endpoint([chunk({ content: '<think>未闭合思考' }), chunk({}, 'stop')]);
  const c = callbacks(); const result = await new OpenAIProvider({ apiKey: 'fixture', baseURL, model: name }).chatStream([], [], c.callbacks);
  expect(result.reasoningContent).toBe('未闭合思考');
  expect(c.events).toEqual([{ kind: 'thinking', value: '未闭合思考' }]);
});

it.each(['OpenAI', 'Ollama-compatible'])('%s actual SDK keeps reasoning optional and drains split tool JSON', async name => {
  const chunk = (delta: object, finish_reason: string | null = null) => ({ id: name, choices: [{ index: 0, delta, finish_reason }] });
  const baseURL = await endpoint([chunk({ content: '检查' }),
    chunk({ tool_calls: [{ index: 0, id: 'openai-call', function: { name: 'query', arguments: '{"sql":' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"SELECT 1"}' } }] }, 'tool_calls')]);
  const c = callbacks(); const result = await new OpenAIProvider({ apiKey: 'fixture', baseURL, model: name }).chatStream([], [], c.callbacks);
  expect(c.events.filter(e => e.kind === 'thinking')).toEqual([]);
  expect(c.events.filter(e => e.kind === 'input').map(e => e.value.id)).toEqual(['openai-call', 'openai-call']);
  expect(result.toolCalls).toEqual([{ id: 'openai-call', name: 'query', arguments: { sql: 'SELECT 1' } }]);
});

it.each(['OpenAI', 'Anthropic'])('%s empty event heartbeat cannot extend provider idle deadline or produce progress', async name => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders();
    const heartbeat = name === 'Anthropic' ? 'event: ping\ndata: {"type":"ping"}\n\n' : 'data: {"choices":[{"index":0,"delta":{},"finish_reason":null}]}\n\n';
    const timer = setInterval(() => response.write(heartbeat), 10); response.on('close', () => clearInterval(timer));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const provider = name === 'Anthropic' ? new AnthropicProvider({ apiKey: 'fixture', baseURL }) : new OpenAIProvider({ apiKey: 'fixture', baseURL });
  const hook = new NoopHook(); hook.wantsStreaming = () => true;
  const phases: string[] = []; const pending: Promise<unknown>[] = [];
  const result = await new AgentRunner(provider).run({ initialMessages: [{ role: 'user', content: 'fixture' }], tools: new ToolRegistry(), model: 'fixture',
    hook, maxIterations: 2, maxToolResultChars: 1000, llmTimeoutS: .4, streamIdleTimeoutS: .08,
    onRuntimePhase: phase => { phases.push(phase); }, onProviderRequest: request => { pending.push(request); } });
  await Promise.allSettled(pending);
  expect(result.resolution?.reasonCode).toBe('MODEL_IDLE_TIMEOUT');
  expect(phases).not.toContain('generating');
});
