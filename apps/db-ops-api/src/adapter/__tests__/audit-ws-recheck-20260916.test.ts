import { expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { ToolRegistry } from '@slide/agent-core';
import { DirectAdapter } from '../direct-adapter.js';
import { chatDatabaseService } from '../../chat-database-service.js';
import { agentRunService } from '../agent-run-service.js';

it.each(['legacy', 'durable'])('%s assistant persistence failure never announces durable completion', async (protocol) => {
  vi.stubEnv('AGENT_WS_PORT', '0');
  vi.stubEnv('JWT_SECRET_KEY', 'isolated-audit-websocket-secret-long-enough');
  const actor = { userId: 74, username: 'probe', roles: ['viewer'], permissions: [], sessionVersion: 1, instanceScopes: {}, requestId: 'probe' };
  vi.spyOn(chatDatabaseService, 'getSessionMetadata').mockResolvedValue(null);
  vi.spyOn(chatDatabaseService, 'createSession').mockResolvedValue({ session_id: 'probe-session' } as any);
  const durable: string[] = [];
  const addMessage = vi.spyOn(chatDatabaseService, 'addMessage').mockImplementation(async (_actor, _session, message) => {
    if (message.role === 'assistant') throw new Error('INJECTED_ASSISTANT_STORAGE_FAILURE');
    durable.push(message.role);
    return 1;
  });
  vi.spyOn(agentRunService, 'findByIdempotencyKey').mockResolvedValue(null);
  vi.spyOn(agentRunService, 'claim').mockResolvedValue({ created: true, run: { id: 'probe-run', actorId: 74, sessionId: 'probe-session', messageId: 'probe-message', idempotencyKey: 'probe-key', state: 'running' } });
  const finish = vi.spyOn(agentRunService, 'finish').mockResolvedValue(true);
  const complete = vi.spyOn(agentRunService, 'complete').mockRejectedValue(new Error('INJECTED_ASSISTANT_STORAGE_FAILURE'));
  vi.spyOn(agentRunService, 'failUnstagedCompletion').mockResolvedValue();
  const answer = { content: 'visible answer', finishReason: 'stop', toolCalls: [], usage: {}, shouldExecuteTools: false, hasToolCalls: false };
  const adapter = new DirectAdapter({ tools: new ToolRegistry(), llmProvider: {
    getDefaultModel: () => 'probe', chat: async () => answer,
    chatStream: async (_m: any, _t: any, callbacks: any) => { await callbacks.onContentDelta('visible answer'); return answer; },
  } as any, actorContextService: { authenticateAccessToken: async () => actor, revalidateActor: async () => actor } });
  let ws: WebSocket | undefined;
  try {
    await adapter.start();
    const server = (adapter as any).wsServer;
    if (!server.address()) await new Promise<void>(resolve => server.once('listening', resolve));
    const events: any[] = [];
    await new Promise<void>((resolve, reject) => {
      ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
      const timer = setTimeout(() => { ws?.terminate(); reject(new Error('probe timeout')); }, 3000);
      ws.on('open', () => ws!.send(JSON.stringify({ type: 'auth', token: 'probe-token' })));
      ws.on('error', error => { clearTimeout(timer); reject(error); });
      ws.on('message', raw => {
        const message = JSON.parse(raw.toString()); events.push(message);
        if (message.type === 'auth_ok') ws!.send(JSON.stringify({ type: 'chat.send', message: 'probe', ...(protocol === 'durable' ? { messageId: 'probe-message', idempotencyKey: 'probe-key' } : {}) }));
        if (message.type === 'complete') { clearTimeout(timer); resolve(); }
        if (message.type === 'error') { clearTimeout(timer); resolve(); }
      });
    });
    expect(finish).not.toHaveBeenCalledWith('probe-run', 'completed', { stopReason: 'completed' });
    expect(events.some(e => e.type === 'complete')).toBe(false);
    expect(addMessage).toHaveBeenCalledTimes(protocol === 'durable' ? 1 : 2);
    if (protocol === 'durable') expect(complete).toHaveBeenCalledOnce();
    expect(durable).toEqual(['user']);
  } finally {
    ws?.terminate();
    await adapter.dispose();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});
