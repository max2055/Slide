import { expect, it, vi, afterEach } from 'vitest';
import { ToolExecutor, executeTools } from '../runtime/tool-executor.js';
import { ToolRegistry } from '../tool-registry.js';
import { NoopHook } from '../runner.js';
import type { AgentRunSpec } from '../types.js';
import { normalizeToolEvent, buildToolPreview, type ToolLifecycleEvent } from '../tool-stream.js';

const spec = (tools: ToolRegistry, onToolEvent: AgentRunSpec['onToolEvent']): AgentRunSpec => ({
  initialMessages: [], model: 'fixture', tools, maxIterations: 3, maxToolResultChars: 1000, hook: new NoopHook(), concurrentTools: true, onToolEvent,
});
const call = (id: string) => ({ id, name: 'query', arguments: { id } });
afterEach(() => vi.useRealTimers());

it('same-name parallel calls settle independently, retaining request identity on progress', async () => {
  const tools = new ToolRegistry();
  let release!: () => void;
  let fastSettled!: () => void;
  const fast = new Promise<void>(resolve => { fastSettled = resolve; });
  tools.register({ name: 'query', description: '', parameters: { type: 'object', properties: {} }, readOnly: true, exclusive: false, concurrencySafe: true,
    execute: async (args, context) => {
      await context?.progressCallback?.({ toolCallId: 'forged', completed: 1, total: 2 });
      if (args.id === 'slow') await new Promise<void>(resolve => { release = resolve; });
      return { rows: [args.id] };
    } });
  const events: ToolLifecycleEvent[] = [];
  const pending = executeTools(spec(tools, event => { events.push(event); if (event.toolCallId === 'fast' && event.phase === 'settled') fastSettled(); }),
    [call('slow'), call('fast')], {}, 1, new ToolExecutor());
  await fast;
  expect(events.find(e => e.toolCallId === 'slow' && e.phase === 'settled')).toBeUndefined();
  expect(events.filter(e => e.progress).map(e => e.toolCallId)).toEqual(['slow', 'fast']);
  release();
  expect((await pending).events.map(e => e.toolCallId)).toEqual(['slow', 'fast']);
  expect(events.filter(e => e.toolCallId === 'fast').map(e => e.phase)).toEqual(['planned', 'queued', 'running', 'running', 'settled']);
});

it('structured and thrown errors are failures; a blocked repeated call never runs', async () => {
  const tools = new ToolRegistry();
  const execute = vi.fn(async () => ({ success: false, error: 'denied' }));
  tools.register({ name: 'query', description: '', parameters: { type: 'object', properties: {} }, readOnly: true, exclusive: false, concurrencySafe: true, execute });
  const events: ToolLifecycleEvent[] = [];
  const settings = { ...spec(tools, e => { events.push(e); }), loopGuardThreshold: 1 };
  const counts = {};
  const executor = new ToolExecutor();
  expect((await executor.runTool(settings, call('a'), counts)).event.status).toBe('error');
  await executor.runTool(settings, { ...call('b'), arguments: call('a').arguments }, counts);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(events.filter(e => e.toolCallId === 'b').map(e => e.phase)).toEqual(['settled']);
  tools.register({ name: 'query', description: '', parameters: { type: 'object', properties: {} }, readOnly: true, exclusive: false, concurrencySafe: true, execute: async () => { throw new Error('broken'); } });
  expect((await executor.runTool(settings, call('c'), {})).event).toMatchObject({ toolCallId: 'c', status: 'error' });
});

it('unknown timeout settlement cannot turn into success on late return/progress', async () => {
  vi.useFakeTimers();
  const tools = new ToolRegistry();
  let release!: (value: unknown) => void;
  let progress!: (e: Record<string, unknown>) => Promise<void> | void;
  tools.register({ name: 'query', description: '', parameters: { type: 'object', properties: {} }, readOnly: true, exclusive: false, concurrencySafe: true, execute: async (_a, ctx) => {
    progress = ctx!.progressCallback!;
    return new Promise(resolve => { release = resolve; });
  } });
  const events: ToolLifecycleEvent[] = [];
  const pending = new ToolExecutor().runTool({ ...spec(tools, e => { events.push(e); }), toolTimeoutMs: 20, onToolExecution: () => {} }, call('a'), {});
  await vi.advanceTimersByTimeAsync(21);
  expect((await pending).event.outcome).toBe('unknown');
  const length = events.length;
  await progress({ completed: 2 }); release('late success');
  await vi.advanceTimersByTimeAsync(0);
  expect(events).toHaveLength(length);
});

it('already cancelled calls never publish running or success', async () => {
  const controller = new AbortController(); controller.abort();
  const events: ToolLifecycleEvent[] = [];
  await new ToolExecutor().runTool({ ...spec(new ToolRegistry(), e => { events.push(e); }), signal: controller.signal }, call('a'), {});
  expect(events).toMatchObject([{ phase: 'settled', outcome: 'cancelled', toolCallId: 'a' }]);
});

it('wire validation rejects malformed fields and legacy unidentified calls', () => {
  const start = { type: 'tool_start', toolCallId: 'a', toolName: 'query', occurredAt: 1, args: {} };
  expect(normalizeToolEvent(start)).toMatchObject({ name: 'query', phase: 'running' });
  for (const invalid of [{ ...start, toolCallId: '' }, { ...start, toolName: 1 }, { ...start, occurredAt: NaN }, { ...start, args: [] },
    { ...start, outcome: 'success' }, { ...start, sequence: -1 }, { ...start, type: 'tool_state', phase: 'fake' },
    { ...start, type: 'tool_progress', progress: null }, { ...start, type: 'tool_error', error: {} },
    { ...start, type: 'tool_result', preview: { kind: 'text', text: 'x'.repeat(4097), truncated: true } },
    { type: 'tool_start', toolName: 'query', args: {} }]) expect(normalizeToolEvent(invalid)).toBeNull();
});

it('result previews are bounded, structured, redacted and reference only their authorized call', () => {
  const preview = buildToolPreview({ password: 'hidden', nested: { api_key: 'hidden', token: 'hidden' }, rows: Array.from({ length: 1000 }, () => 'x'.repeat(1000)) }, 'a');
  expect(preview.kind).toBe('json'); expect(preview.text.length).toBeLessThanOrEqual(4096);
  expect(preview.text).not.toContain('hidden'); expect(preview.truncated).toBe(true);
  expect(preview.detailsRef).toEqual({ kind: 'tool-call', toolCallId: 'a' });
  expect(buildToolPreview('token=hidden Bearer hidden-secret', 'a').text).not.toContain('hidden');
  const circular: Record<string, unknown> = {}; circular.self = circular;
  expect(buildToolPreview(circular, 'a').text).toContain('[CIRCULAR]');
});
