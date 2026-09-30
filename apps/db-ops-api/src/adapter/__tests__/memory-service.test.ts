import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { ToolRegistry, MemoryPipeline, StructuredMemoryStore, memoryHash, type MemoryInput, type MemoryExtractor, type LLMProvider } from '@slide/agent-core';
import { BusinessMemoryService } from '../memory-service.js';
import { DirectAdapter } from '../direct-adapter.js';
import { CanonicalStore, canonicalStore } from '../canonical-store.js';
import { chatDatabaseService } from '../../chat-database-service.js';
import { agentRunService, type AgentRun } from '../agent-run-service.js';
import type { ActorContext } from '../../auth/actor-context.js';
const actor = { userId: 1, username: 'A', roles: [], permissions: [], sessionVersion: 1, instanceScopes: {}, requestId: 'test' } as ActorContext;
const run: AgentRun = { id: 'r1', actorId: 1, sessionId: 's1', state: 'completed', messageId: 'request', idempotencyKey: 'request' };
let directory: string;
let inputs: MemoryInput[];
let pipelines: MemoryPipeline[];
let adapters: DirectAdapter[];
let clients: WebSocket[];
let provider: LLMProvider;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'business-memory-')); pipelines = []; adapters = []; clients = [];
  inputs = [{ id: 'run_r1_user', content: 'I prefer concise Chinese replies.', hash: memoryHash('I prefer concise Chinese replies.') }];
  provider = { getDefaultModel: () => 'fake', chat: vi.fn(async () => ({ content: '[]', finishReason: 'stop', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 2 }, shouldExecuteTools: false, hasToolCalls: false })) } as unknown as LLMProvider;
  vi.spyOn(chatDatabaseService, 'authorizeSession').mockImplementation(async (a, s) => { if (a.userId !== 1 || s !== 's1') throw new Error('not owner'); return {} as any; });
  vi.spyOn(agentRunService, 'getForActor').mockResolvedValue(run);
  vi.spyOn(canonicalStore, 'getCommittedMemoryInputs').mockImplementation(async () => inputs);
});
afterEach(async () => {
  for (const c of clients) c.terminate();
  await Promise.all(adapters.map(a => a.dispose())); await Promise.all(pipelines.map(p => p.close()));
  vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(directory, { recursive: true, force: true });
});
function pipeline(extract: MemoryExtractor['extract'] = vi.fn(async (sources: readonly MemoryInput[]) => ({ candidates: sources.map(s => ({ kind: 'preference', subject: 'reply style', content: s.content, sources: [{ id: s.id, hash: s.hash, quote: s.content }], confidence: 1, operation: 'new' })), usage: { prompt_tokens: 10, completion_tokens: 5 } }))) {
  const p = new MemoryPipeline(new StructuredMemoryStore(path.join(directory, 'structured-memory')), { extract }, async (_scope, ids) => inputs.filter(s => ids.includes(s.id)), true);
  pipelines.push(p); return p;
}
it('default off causes no admission, canonical query or provider call', async () => {
  const service = new BusinessMemoryService(directory, undefined, async () => provider);
  await service.completed(actor, 's1', 'r1');
  expect(agentRunService.getForActor).not.toHaveBeenCalled(); expect(canonicalStore.getCommittedMemoryInputs).not.toHaveBeenCalled(); expect(provider.chat).not.toHaveBeenCalled();
  expect(await fs.readdir(directory)).toEqual([]);
});
it('enabled requires configured workspace identity independent of cwd', () => {
  vi.stubEnv('SLIDE_MEMORY_PIPELINE_ENABLED', 'true');
  expect(() => new BusinessMemoryService(directory, undefined, async () => provider)).toThrow('WORKSPACE_ID_REQUIRED');
});
it.each(['running', 'partial', 'cancelled', 'failed', 'timed_out'] as const)('does not extract %s or completion-pending candidates', async state => {
  vi.mocked(agentRunService.getForActor).mockResolvedValue({ ...run, state, result: { completionPending: true } });
  const p = pipeline(); const spy = vi.spyOn(p, 'run'); const service = new BusinessMemoryService(directory, 'workspace', async () => provider, p);
  await service.completed(actor, 's1', 'r1'); expect(spy).not.toHaveBeenCalled(); expect(await fs.readdir(directory)).toEqual([]);
});
it('durable completed entrance creates retrievable, exportable scoped records; replay is idempotent', async () => {
  const p = pipeline(); const service = new BusinessMemoryService(directory, 'workspace', async () => provider, p);
  await service.completed(actor, 's1', 'r1'); await service.completed(actor, 's1', 'r1');
  const records = await service.request(actor, 's1', 'memory.list', {}) as any[];
  expect(records).toHaveLength(1); expect(records[0].scope).toEqual({ workspaceId: 'workspace', actorId: '1', sessionId: 's1' });
  expect(await service.request(actor, 's1', 'memory.export', {})).toEqual({ schemaVersion: 1, records });
  await expect(service.request({ ...actor, userId: 2 }, 's1', 'memory.delete', { recordId: records[0].id })).rejects.toThrow('not owner');
  await service.request(actor, 's1', 'memory.delete', { recordId: records[0].id }); await service.completed(actor, 's1', 'r1');
  expect(await service.request(actor, 's1', 'memory.list', {})).toEqual([]);
});
it('actor ownership gates share and retry; invalid source does not return active memory', async () => {
  const service = new BusinessMemoryService(directory, 'workspace', async () => provider, pipeline());
  await service.completed(actor, 's1', 'r1'); const records = await service.request(actor, 's1', 'memory.list', {}) as any[];
  await expect(service.request({ ...actor, userId: 2 }, 's1', 'memory.retry', { runId: 'r1' })).rejects.toThrow();
  await expect(service.request(actor, 's1', 'memory.share', { recordId: records[0].id, actorIds: ['2'] })).rejects.toThrow('SHARE_INVALID');
  await service.request(actor, 's1', 'memory.share', { recordId: records[0].id, actorIds: [2] });
  inputs = []; expect(await service.request(actor, 's1', 'memory.list', {})).toMatchObject([{ status: 'uncertain', invalidSourceIds: ['run_r1_user'] }]);
});
it('canonical query enforces SQL owner, user role and completed-run boundary', async () => {
  const query = vi.fn(async (..._args: any[]) => [[{ message_id: inputs[0].id, content: inputs[0].content }], []]);
  const sql = new CanonicalStore(() => ({ query } as any));
  expect(await sql.getCommittedMemoryInputs(1, 's1', ['run_r1_user'])).toEqual(inputs);
  expect(query.mock.calls[0][0]).toContain("ar.state = 'completed'"); expect(query.mock.calls[0][0]).toContain("cm.role = 'user'");
  expect(query.mock.calls[0][1]).toEqual([1, 's1', ['run_r1_user'][0]]);
});
async function connection(p: MemoryPipeline) {
  vi.stubEnv('AGENT_WS_PORT', '0'); vi.stubEnv('JWT_SECRET_KEY', 'fake-jwt-secret-for-memory-test');
  const adapter = new DirectAdapter({ workspace: directory, tools: new ToolRegistry(), llmProvider: provider, memoryWorkspaceId: 'workspace', memoryPipeline: p,
    actorContextService: { authenticateAccessToken: vi.fn(async () => actor), revalidateActor: vi.fn(async a => a) } });
  adapters.push(adapter); await adapter.start();
  const server = (adapter as any).wsServer;
  if (!server.address()) await new Promise<void>(r => server.once('listening', r));
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`); clients.push(client);
  await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
  const socket = [...server.clients][0] as WebSocket; const send = vi.spyOn(socket, 'send');
  const handle = (msg: unknown) => Promise.resolve(socket.listeners('message')[0].call(socket, Buffer.from(JSON.stringify(msg))));
  await handle({ type: 'auth', token: 'fake-access-token' }); send.mockClear();
  return { adapter, handle, send };
}
it('authenticated WS completion waits for commit, delivers success before extraction and supports memory.list', async () => {
  const p = pipeline(); const { adapter, handle, send } = await connection(p);
  vi.spyOn(agentRunService, 'findByIdempotencyKey').mockResolvedValue(null);
  vi.spyOn(agentRunService, 'claim').mockResolvedValue({ run: { ...run, state: 'running' }, created: true });
  vi.spyOn(chatDatabaseService, 'addMessage').mockResolvedValue(1);
  const complete = vi.spyOn(agentRunService, 'complete').mockImplementation(async (_run, event) => ({ ...run, result: { event } }));
  vi.spyOn(adapter, 'chat').mockImplementation(async (_session, _message, event) => { await event({ type: 'complete', finalContent: 'Answer', stopReason: 'completed' }); return { stopReason: 'completed', finalContent: 'Answer', usage: {} }; });
  const extraction = vi.spyOn(adapter, 'extractCompletedMemory');
  await handle({ type: 'chat.send', sessionKey: 's1', message: inputs[0].content, messageId: 'request', idempotencyKey: 'request' });
  expect(complete).toHaveBeenCalledTimes(1); expect(extraction).toHaveBeenCalledTimes(1);
  expect(complete.mock.invocationCallOrder[0]).toBeLessThan(extraction.mock.invocationCallOrder[0]);
  const sent = send.mock.calls.map(([value]) => JSON.parse(value as string)); expect(sent.some(e => e.type === 'complete')).toBe(true);
  await handle({ type: 'memory.list', sessionKey: 's1', messageId: 'memory-query' });
  const result = send.mock.calls.map(([value]) => JSON.parse(value as string)).find(e => e.type === 'memory.result'); expect(result.result).toHaveLength(1);
  expect(result.messageId).toBe('memory-query');
});
it('extraction failure never changes the committed business completion', async () => {
  const p = pipeline(vi.fn(async () => { throw new Error('fake provider failure'); }));
  const { adapter } = await connection(p); const finish = vi.spyOn(agentRunService, 'finish');
  await adapter.extractCompletedMemory(actor, 's1', 'r1'); expect(finish).not.toHaveBeenCalled(); expect(run.state).toBe('completed');
  expect((await p.store.transaction(s => s.jobs))[0].state).toBe('failed');
});
it('explicit Stop cancels memory without changing completed chat state; close drains', async () => {
  let entered!: () => void; const ready = new Promise<void>(r => { entered = r; });
  const p = pipeline(vi.fn(async (_inputs, options: any) => {
    entered(); await new Promise<void>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); return { candidates: [], usage: {} };
  }));
  const { adapter, handle } = await connection(p);
  const active = adapter.extractCompletedMemory(actor, 's1', 'r1'); await ready;
  await handle({ type: 'memory.stop', sessionKey: 's1', runId: 'r1' }); await active; await adapter.dispose();
  expect(run.state).toBe('completed'); expect((await p.store.transaction(s => s.jobs))[0]).toMatchObject({ state: 'cancelled', attempts: 1 });
});
