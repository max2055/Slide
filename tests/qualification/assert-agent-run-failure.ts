import { randomUUID } from 'node:crypto';
import { ToolRegistry } from '../../packages/agent-core/src/index.js';
import type { LLMCallOptions, LLMProvider, LLMResponse, Message, StreamCallbacks, ToolSchema } from '../../packages/agent-core/src/index.js';
import WebSocket from '../../apps/db-ops-api/node_modules/ws/index.js';
import { DirectAdapter } from '../../apps/db-ops-api/src/adapter/direct-adapter.js';
import { dbConnection } from '../../apps/db-ops-api/src/db-connection.js';
import type { ActorContext } from '../../apps/db-ops-api/src/auth/actor-context.js';

class FailingProvider implements LLMProvider {
  getDefaultModel(): string { return 'qualification-failing-provider'; }
  async chat(_messages: Message[], _tools: ToolSchema[], _options?: LLMCallOptions): Promise<LLMResponse> {
    return { content: null, finishReason: 'error', toolCalls: [], usage: {}, shouldExecuteTools: false, hasToolCalls: false, errorKind: 'provider_error' };
  }
  async chatStream(_messages: Message[], _tools: ToolSchema[], _callbacks: StreamCallbacks, _options?: LLMCallOptions): Promise<LLMResponse> {
    return this.chat([], []);
  }
}

process.env.ENCRYPTION_KEY ??= 'qualification-encryption-key-2026-07-19-not-production';
process.env.JWT_SECRET_KEY ??= 'qualification-jwt-secret-2026-07-19-long';
process.env.AGENT_WS_PORT = '28891';
if (!await dbConnection.initialize()) throw new Error('qualification database connection failed');
const pool = dbConnection.getPool();
if (!pool) throw new Error('qualification database pool unavailable');

const username = `qualification-agent-${process.pid}-${Date.now()}`;
const [userResult] = await pool.execute(
  "INSERT INTO users (username, password_hash, status) VALUES (?, 'qualification-not-a-login', 'active')",
  [username],
) as any;
const actor: ActorContext = Object.freeze({
  userId: Number(userResult.insertId), username, roles: Object.freeze(['viewer']), permissions: Object.freeze([]),
  sessionVersion: 1, instanceScopes: Object.freeze({}), requestId: 'qualification-agent-run-failure',
});
const idempotencyKey = `qualification-failure-${randomUUID()}`;
const messageId = `qualification-message-${randomUUID()}`;
const adapter = new DirectAdapter({
  tools: new ToolRegistry(),
  llmProvider: new FailingProvider(),
  actorContextService: {
    authenticateAccessToken: async () => actor,
    revalidateActor: async () => actor,
  },
});

try {
  await adapter.start();
  const events = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
    const received: Array<Record<string, unknown>> = [];
    const ws = new WebSocket('ws://127.0.0.1:28891');
    const timeout = setTimeout(() => { ws.close(); reject(new Error('agent run failure qualification timed out')); }, 10_000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: 'qualification-token' })));
    let sessionKey = '';
    let replayed = false;
    ws.on('message', (raw) => {
      const event = JSON.parse(raw.toString()) as Record<string, unknown>;
      received.push(event);
      if (event.type === 'session.created' && typeof event.sessionKey === 'string') sessionKey = event.sessionKey;
      if (event.type === 'auth_ok') {
        ws.send(JSON.stringify({ type: 'chat.send', message: 'trigger deterministic provider failure', messageId, idempotencyKey }));
      }
      if (event.type === 'error' && !replayed) {
        if (!sessionKey) { clearTimeout(timeout); ws.close(); reject(new Error('missing created session key')); return; }
        replayed = true;
        ws.send(JSON.stringify({ type: 'chat.send', sessionKey, message: 'replay deterministic provider failure', messageId, idempotencyKey }));
      }
      if (event.type === 'run.snapshot') { clearTimeout(timeout); ws.close(); resolve(received); }
    });
    ws.on('error', (error) => { clearTimeout(timeout); reject(error); });
  });
  const snapshot = events.find((event) => event.type === 'run.snapshot') as { run?: { state?: string; id?: string } } | undefined;
  if (events.some((event) => event.type === 'complete') || !events.some((event) => event.type === 'error') || snapshot?.run?.state !== 'failed' || !snapshot.run.id) {
    throw new Error('failed provider emitted an invalid terminal event sequence');
  }
  const [runs] = await pool.execute<Array<{ state: string; result_json: unknown; error_json: unknown; finished_at: Date | null }>>(
    'SELECT state, result_json, error_json, finished_at FROM agent_runs WHERE actor_id = ? AND idempotency_key = ?',
    [actor.userId, idempotencyKey],
  );
  const run = runs[0];
  const result = typeof run?.result_json === 'string' ? JSON.parse(run.result_json) : run?.result_json;
  if (!run || run.state !== 'failed' || !run.finished_at || (!run.error_json && (result as any)?.stopReason !== 'error')) {
    throw new Error('failed Agent run was not durably persisted');
  }
  console.log(`agent-run failure/readback/replay valid: actor=${actor.userId} state=${run.state} snapshot=${snapshot.run.id}`);
} finally {
  await adapter.dispose();
  await dbConnection.close();
}
