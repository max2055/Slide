import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { ToolRegistry } from '@slide/agent-core';
import type { LLMProvider, LLMResponse } from '@slide/agent-core';
import { DirectAdapter } from '../direct-adapter.js';
import { agentRunService } from '../agent-run-service.js';
import { canonicalStore } from '../canonical-store.js';
import { chatDatabaseService } from '../../chat-database-service.js';
import type { ActorContext } from '../../auth/actor-context.js';

const actor: ActorContext = { userId: 626, username: 'steer', roles: [], permissions: [], sessionVersion: 1, instanceScopes: {}, requestId: 'steer' };
const run = { id: 'run626', actorId: actor.userId, sessionId: 's626', messageId: 'm626', idempotencyKey: 'k626', state: 'running' as const };
const final: LLMResponse = { content: 'answer', finishReason: 'stop', toolCalls: [], usage: {}, shouldExecuteTools: false, hasToolCalls: false };
let workspace: string;
let adapter: DirectAdapter;
let client: WebSocket;
let revalidate: ReturnType<typeof vi.fn<() => Promise<ActorContext>>>;
let handle: (msg: unknown) => Promise<void>;
let sent: ReturnType<typeof vi.spyOn>;
let active: { actorId: number; sessionId: string; controller: AbortController; injections: unknown[] };

beforeEach(async () => {
  vi.stubEnv('AGENT_WS_PORT', '0');
  vi.stubEnv('JWT_SECRET_KEY', 'steer-fixture-secret-long-enough');
  workspace = mkdtempSync(join(tmpdir(), 'max626-'));
  vi.spyOn(chatDatabaseService, 'authorizeSession').mockResolvedValue({} as never);
  vi.spyOn(chatDatabaseService, 'addMessage').mockResolvedValue(1);
  vi.spyOn(chatDatabaseService, 'getSessionMetadata').mockResolvedValue(null);
  vi.spyOn(canonicalStore, 'getPage').mockResolvedValue({ messages: [], nextBefore: null });
  vi.spyOn(canonicalStore, 'saveCheckpoint').mockResolvedValue(undefined);
  vi.spyOn(agentRunService, 'findByIdempotencyKey').mockResolvedValue(null);
  vi.spyOn(agentRunService, 'getForActor').mockResolvedValue(run);
  vi.spyOn(agentRunService, 'claim').mockResolvedValue({ run, created: true });
  vi.spyOn(agentRunService, 'pendingCompletions').mockResolvedValue([]);
  vi.spyOn(agentRunService, 'finish').mockResolvedValue(true);
  vi.spyOn(agentRunService, 'complete').mockImplementation(async (r, event) => ({ ...r, state: 'completed', result: { event } }));
  revalidate = vi.fn(async () => actor);
  const provider: LLMProvider = { getDefaultModel: () => 'fixture', chat: async () => final, chatStream: async () => final };
  adapter = new DirectAdapter({ workspace, tools: new ToolRegistry(), llmProvider: provider,
    actorContextService: { authenticateAccessToken: async () => actor, revalidateActor: revalidate } });
  await adapter.start();
  const server = (adapter as any).wsServer;
  if (!server.address()) await once(server, 'listening');
  client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  await once(client, 'open');
  const socket = [...server.clients][0] as WebSocket;
  sent = vi.spyOn(socket, 'send');
  handle = async msg => { await socket.listeners('message')[0].call(socket, Buffer.from(JSON.stringify(msg)), false); };
  await handle({ type: 'auth', token: 'test-token' });
  active = { actorId: actor.userId, sessionId: run.sessionId, controller: new AbortController(), injections: [] };
  (adapter as any).activeRuns.set(run.id, active);
  sent.mockClear();
});
afterEach(async () => {
  client?.terminate();
  await adapter?.dispose();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});
const steer = (extra = {}) => handle({ type: 'chat.steer', requestId: 'request626', sessionKey: run.sessionId, message: 'adjust', ...extra });
const result = () => sent.mock.calls.map(([frame]) => JSON.parse(String(frame))).find(e => e.type === 'steer.result');

describe('MAX-628 authoritative steer admission (#414)', () => {
  it('queues exactly in the live actor/session Run without creating another Run', async () => {
    await steer();
    expect(result()).toMatchObject({ status: 'queued', runId: run.id });
    expect(active.injections).toHaveLength(1);
    expect(agentRunService.claim).not.toHaveBeenCalled();
    expect(chatDatabaseService.authorizeSession).toHaveBeenCalledWith(actor, run.sessionId, 'append');
  });
  it.each(['completed', 'cancelled', 'failed', 'timed_out', 'partial', 'unknown'])('rejects persisted %s even with a local Run', async state => {
    vi.mocked(agentRunService.getForActor).mockResolvedValue({ ...run, state } as never);
    await steer(); expect(result().status).toBe('no_active_run'); expect(active.injections).toHaveLength(0);
  });
  it('rejects idle, foreign actor, switched session and aborted Run', async () => {
    for (const patch of [{ actorId: 999 }, { sessionId: 'other' }, { controller: AbortSignal.abort() }]) {
      const previous = { ...active };
      if ('controller' in patch) active.controller.abort(); else Object.assign(active, patch);
      await steer(); expect(result().status).toBe('no_active_run'); expect(active.injections).toHaveLength(0);
      Object.assign(active, previous); sent.mockClear();
    }
    (adapter as any).activeRuns.clear(); await steer(); expect(result().status).toBe('no_active_run');
  });
  it('rejects completion staging, ambiguous Runs and a full queue', async () => {
    vi.mocked(agentRunService.getForActor).mockResolvedValueOnce({ ...run, result: { completionPending: true } });
    await steer(); expect(result().status).toBe('no_active_run'); sent.mockClear();
    (adapter as any).activeRuns.set('other', { ...active }); await steer(); expect(result().status).toBe('ambiguous'); sent.mockClear();
    (adapter as any).activeRuns.delete('other'); active.injections = Array.from({ length: 15 });
    await steer(); expect(result().status).toBe('queue_full'); expect(active.injections).toHaveLength(15);
  });
  it('does not redirect a command to a replacement Run across an async lookup', async () => {
    vi.mocked(agentRunService.getForActor).mockImplementationOnce(async () => {
      (adapter as any).activeRuns.set(run.id, { ...active, injections: [] }); return run;
    });
    await steer(); expect(result().status).toBe('no_active_run'); expect(active.injections).toHaveLength(0);
  });
  it('denies an owner change and a revoked login', async () => {
    vi.mocked(chatDatabaseService.authorizeSession).mockRejectedValueOnce(new Error('not owner'));
    await steer(); expect(result().status).toBe('unavailable'); expect(active.injections).toHaveLength(0);
    sent.mockClear(); revalidate.mockRejectedValueOnce(new Error('revoked'));
    await steer(); expect(result()).toBeUndefined(); expect(active.injections).toHaveLength(0);
  });
  it.each([{ message: '' }, { sessionKey: '' }, { requestId: '' }, { message: 1 }])('rejects malformed command %j', async extra => {
    await steer(extra); expect(result().status).toBe('invalid'); expect(active.injections).toHaveLength(0);
  });
  it('drains the queue into the actual runner and persists the injected user fact', async () => {
    active.injections.push({ id: 'injection626', message: 'focus on rollback' });
    const response = await adapter.chat(run.sessionId, 'start', async () => {}, actor, active.controller.signal, run.idempotencyKey, run.id, 'user626');
    expect(response.stopReason).toBe('completed');
    expect(chatDatabaseService.addMessage).toHaveBeenCalledWith(actor, run.sessionId,
      expect.objectContaining({ messageId: 'steer_injection626', content: 'focus on rollback' }));
    expect(active.injections).toHaveLength(0);
  });
  it('refuses admission while the finished runtime is committing its result', async () => {
    Object.assign(active, { acceptingSteers: false });
    await steer(); expect(result().status).toBe('no_active_run'); expect(active.injections).toHaveLength(0);
  });
  it.each(['revoked', 'unknown-write'])('fails closed after queued drain %s without replay', async mode => {
    active.injections.push({ id: 'failed626', message: 'must not repeat' });
    if (mode === 'revoked') revalidate.mockRejectedValue(new Error('revoked'));
    else vi.mocked(chatDatabaseService.addMessage).mockRejectedValue(new Error('write result unknown'));
    await adapter.chat(run.sessionId, 'start', async () => {}, actor, active.controller.signal, run.idempotencyKey, run.id, 'user626');
    expect(active.controller.signal.aborted).toBe(true);
    expect(chatDatabaseService.addMessage).toHaveBeenCalledTimes(mode === 'revoked' ? 0 : 1);
  });

});
