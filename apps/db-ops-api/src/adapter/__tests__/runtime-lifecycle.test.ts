vi.mock('../../cron/cron-authority.js', () => ({ cronAuthorityService: { authorize: async () => ({ audit: {}, refreshActor: async () => ({ userId: 7 }) }) }, CRON_MAINTENANCE_HANDLERS: new Set() }));
import { canonicalStore } from '../canonical-store.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRunner, ToolRegistry, SessionManager, type LLMProvider, type LLMResponse } from '@slide/agent-core';
import { DirectAdapter } from '../direct-adapter.js';
import { CronExecutor } from '../../cron/cron-executor.js';
import { CronManager } from '../../cron/cron-manager.js';
import { SubagentManager } from '../../agents/subagent-manager.js';
import { subagentRegistry } from '../../agents/subagent-registry.js';
import { chatDatabaseService } from '../../chat-database-service.js';
import type { ActorContext } from '../../auth/actor-context.js';
const directories: string[] = [];
const ok: LLMResponse = { content: 'done', finishReason: 'stop', toolCalls: [], hasToolCalls: false, shouldExecuteTools: false, usage: { prompt_tokens: 10, completion_tokens: 2 } };
const actor: ActorContext = { userId: 71, username: 'test', roles: ['admin'], permissions: [], sessionVersion: 1, instanceScopes: {}, requestId: 'runtime-test' };
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); subagentRegistry.clear(); await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function adapter(provider: LLMProvider, tools = new ToolRegistry()) {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-lifecycle-')); directories.push(directory);
  const sessions = new SessionManager(directory);
  vi.spyOn(sessions, 'save').mockResolvedValue(undefined);
  let checkpoint: Record<string, unknown> | null = null;
  vi.spyOn(chatDatabaseService, 'getSessionMetadata').mockImplementation(async () => ({ canonicalRuntimeCheckpoint: checkpoint }));
  vi.spyOn(chatDatabaseService, 'authorizeSession').mockResolvedValue({} as any);
  vi.spyOn(chatDatabaseService, 'addMessage').mockResolvedValue(1);
  vi.spyOn(canonicalStore, 'getPage').mockResolvedValue({ messages: [], nextBefore: null });
  vi.spyOn(canonicalStore, 'appendToolFacts').mockImplementation(async (_actor, _session, _user, _facts, _iteration, cp) => { if (cp) checkpoint = cp; });
  vi.spyOn(canonicalStore, 'saveCheckpoint').mockImplementation(async (_actor, _session, cp) => { checkpoint = cp; });
  return new DirectAdapter({ llmProvider: { ...provider, getModelCapabilities: model => ({
    model: model ?? provider.getDefaultModel(), contextWindowTokens: 200_000, preferredOutputTokens: 4096,
    source: 'configuration', version: 'test-fixture/v1' }) }, sessionManager: sessions, tools, toolsForActor: () => tools });
}
it('actual chat entry passes 120s with LONG_CHAT and still emits one terminal', async () => {
  vi.stubEnv('AGENT_RUNTIME_LONG_CHAT', 'true'); vi.useFakeTimers();
  let started = false;
  const chatStream = vi.fn<LLMProvider['chatStream']>(async (_m, _t, callbacks) => { started = true; const ticker = setInterval(() => callbacks.onActivity?.(), 10000); try { await new Promise(r => setTimeout(r, 130000)); return ok; } finally { clearInterval(ticker); } });
  const app = await adapter({ getDefaultModel: () => 'fixture', chat: async () => ok, chatStream });
  const events: any[] = []; const run = app.chat('long', 'inspect', e => { events.push(e); });
  await vi.waitFor(() => expect(started).toBe(true));
  await vi.advanceTimersByTimeAsync(130001);
  expect((await run).stopReason).toBe('completed'); expect(events.filter(e => ['complete', 'error', 'cancelled'].includes(e.type))).toHaveLength(1);
});
it('tool timeout holds chat session until real settlement and refuses checkpoint replay', async () => {
  vi.stubEnv('AGENT_RUNTIME_LONG_CHAT', 'true'); vi.useFakeTimers();
  let finish!: (value: unknown) => void; let started = false;
  const tools = new ToolRegistry();
  tools.register({ name: 'write', description: 'write', parameters: { type: 'object', properties: {} }, readOnly: false, concurrencySafe: false, exclusive: true,
    execute: async () => { started = true; return new Promise(r => { finish = r; }); } });
  const stream = vi.fn(async () => ({ ...ok, content: null, finishReason: 'tool_calls', shouldExecuteTools: true, hasToolCalls: true, toolCalls: [{ id: 'one', name: 'write', arguments: {} }] }));
  const app = await adapter({ getDefaultModel: () => 'fixture', chat: async () => ok, chatStream: stream }, tools);
  const first = app.chat('owned', 'write', () => {}, actor);
  await vi.waitFor(() => expect(started).toBe(true)); await vi.advanceTimersByTimeAsync(60001);
  expect((await first).resolution?.reasonCode).toBe('TOOL_TIMEOUT');
  let secondReturned = false;
  const second = app.chat('owned', 'again', () => {}, actor).then(r => { secondReturned = true; return r; });
  await vi.advanceTimersByTimeAsync(100); expect(secondReturned).toBe(false); expect(stream).toHaveBeenCalledTimes(1);
  finish('late'); await vi.advanceTimersByTimeAsync(0);
  expect((await second).resolution?.reasonCode).toBe('TOOL_SETTLEMENT_UNKNOWN'); expect(stream).toHaveBeenCalledTimes(1);
});
it('invoke Stop drives abort and keeps session owned until an ignoring provider settles', async () => {
  vi.stubEnv('AGENT_RUNTIME_LONG_CHAT', 'true');
  let finish!: (value: LLMResponse) => void; let started!: () => void;
  const start = new Promise<void>(r => { started = r; });
  const chat = vi.fn(async () => { started(); return new Promise<LLMResponse>(r => { finish = r; }); });
  const app = await adapter({ getDefaultModel: () => 'fixture', chat, chatStream: async () => ok });
  const controller = new AbortController();
  const first = app.invoke('invoke', 'inspect', undefined, { signal: controller.signal });
  await start; controller.abort(); expect((await first).stopReason).toBe('cancelled');
  let acquired = false;
  const next = (app as any).withSessionLock('invoke', async () => { acquired = true; });
  await Promise.resolve(); expect(acquired).toBe(false);
  finish(ok); await next; expect(acquired).toBe(true); expect(chat).toHaveBeenCalledTimes(1);
});
it('Cron tool deadline retains same-job exclusion through actual settlement', async () => {
  vi.stubEnv('AGENT_RUNTIME_LONG_CHAT', 'true'); vi.useFakeTimers();
  let finish!: (value: unknown) => void; let started = false;
  const tools = new ToolRegistry(); tools.register({ name: 'read', description: 'read', parameters: { type: 'object', properties: {} }, readOnly: true, concurrencySafe: false, exclusive: true,
    execute: async () => { started = true; return new Promise(r => { finish = r; }); } });
  const chat = vi.fn(async () => ({ ...ok, content: null, finishReason: 'tool_calls', shouldExecuteTools: true, hasToolCalls: true, toolCalls: [{ id: 'one', name: 'read', arguments: {} }] }));
  const provider = { getDefaultModel: () => 'fixture', chat, chatStream: chat };
  const executor = new CronExecutor(new AgentRunner(provider), tools, provider);
  const service = { startLog: vi.fn(async () => 1), completeLog: vi.fn(async () => true), updateRunResult: vi.fn() };
  const manager = new CronManager(service as any, executor); const job = { id: 43, name: 'bounded', task_description: 'inspect', timeout_seconds: 300 } as any;
  Object.assign(service, { getJobById: async () => job, recordExecutionAuthority: async () => true });
  const run = manager.executeJob(job); await vi.waitFor(() => expect(started).toBe(true)); await vi.advanceTimersByTimeAsync(60001); await run;
  await manager.executeJob(job); expect(chat).toHaveBeenCalledTimes(1);
  finish('settled'); await vi.advanceTimersByTimeAsync(0);
  expect(service.updateRunResult).toHaveBeenCalledWith(43, 'timeout');
});
it('subagent timeout reports typed resolution but retains actor slot for an ignoring provider', async () => {
  vi.stubEnv('AGENT_RUNTIME_LONG_CHAT', 'true'); vi.stubEnv('AGENT_MAX_CONCURRENT_RUNS', '1'); vi.useFakeTimers();
  let finish!: (value: LLMResponse) => void;
  const chat = vi.fn(() => new Promise<LLMResponse>(r => { finish = r; }));
  const manager = new SubagentManager(new AgentRunner({ getDefaultModel: () => 'fixture', chat, chatStream: chat }));
  const id = await manager.spawn('one', 'inspect', 'parent', actor);
  await vi.advanceTimersByTimeAsync(120001);
  expect(await manager.access(id, actor)).toMatchObject({ status: 'failed', resolution: { kind: 'timed_out', reasonCode: 'RUN_DEADLINE' }, cancellationPending: true });
  await expect(manager.spawn('two', 'inspect', 'parent', actor)).rejects.toThrow('SUBAGENT_CONCURRENCY_LIMIT');
  finish(ok); await vi.advanceTimersByTimeAsync(0);
  expect((await manager.access(id, actor)).cancellationPending).toBeUndefined();
});

it('same request retains an expired deadline while a new terminal-free request gets a fresh budget', async () => {
  vi.stubEnv('AGENT_RUNTIME_LONG_CHAT', 'true'); vi.stubEnv('AGENT_CHAT_RUN_TIMEOUT_MS', '100'); vi.useFakeTimers();
  let first = true;
  const stream = vi.fn<LLMProvider['chatStream']>(async (_m, _t, _c, options) => {
    if (!first) return ok;
    first = false;
    return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(options.signal!.reason)));
  });
  const app = await adapter({ getDefaultModel: () => 'fixture', chat: async () => ok, chatStream: stream });
  const run = app.chat('deadline', 'inspect', () => {}, undefined, undefined, 'request-1');
  await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(1)); await vi.advanceTimersByTimeAsync(101);
  expect((await run).resolution?.reasonCode).toBe('RUN_DEADLINE');
  expect((await app.chat('deadline', 'resume', () => {}, undefined, undefined, 'request-1')).resolution?.reasonCode).toBe('RUN_DEADLINE');
  expect(stream).toHaveBeenCalledTimes(1);
  expect((await app.chat('deadline', 'new task', () => {}, undefined, undefined, 'request-2')).stopReason).toBe('completed');
  expect(stream).toHaveBeenCalledTimes(2);
});
