import { randomUUID } from 'node:crypto';
import { ToolRegistry } from '../../packages/agent-core/src/index.js';
import type { LLMCallOptions, LLMProvider, LLMResponse, Message, StreamCallbacks, ToolSchema } from '../../packages/agent-core/src/index.js';
import WebSocket from '../../apps/db-ops-api/node_modules/ws/index.js';
import { DirectAdapter } from '../../apps/db-ops-api/src/adapter/direct-adapter.js';
import { dbConnection } from '../../apps/db-ops-api/src/db-connection.js';
import type { ActorContext } from '../../apps/db-ops-api/src/auth/actor-context.js';

class CancellableProvider implements LLMProvider {
  getDefaultModel(): string { return 'qualification-cancellable-provider'; }
  async chat(_messages: Message[], _tools: ToolSchema[], options?: LLMCallOptions): Promise<LLMResponse> {
    return new Promise((resolve) => options?.signal?.addEventListener('abort', () => resolve({ content: null, finishReason: 'error', toolCalls: [], usage: {}, shouldExecuteTools: false, hasToolCalls: false, errorKind: 'provider_error' }), { once: true }));
  }
  async chatStream(_messages: Message[], _tools: ToolSchema[], _callbacks: StreamCallbacks, options?: LLMCallOptions): Promise<LLMResponse> { return this.chat([], [], options); }
}

process.env.ENCRYPTION_KEY ??= 'qualification-encryption-key-2026-07-19-not-production';
process.env.JWT_SECRET_KEY ??= 'qualification-jwt-secret-2026-07-19-long';
process.env.AGENT_WS_PORT = '28891';
if (!await dbConnection.initialize()) throw new Error('qualification database connection failed');
const pool = dbConnection.getPool();
if (!pool) throw new Error('qualification database pool unavailable');
const username = `qualification-cancel-${process.pid}-${Date.now()}`;
const [user] = await pool.execute("INSERT INTO users (username, password_hash, status) VALUES (?, 'qualification-not-a-login', 'active')", [username]) as any;
const actor: ActorContext = Object.freeze({ userId: Number(user.insertId), username, roles: Object.freeze(['viewer']), permissions: Object.freeze([]), sessionVersion: 1, instanceScopes: Object.freeze({}), requestId: 'qualification-agent-run-cancel' });
const idempotencyKey = `qualification-cancel-${randomUUID()}`;
const messageId = `qualification-message-${randomUUID()}`;
const adapter = new DirectAdapter({ tools: new ToolRegistry(), llmProvider: new CancellableProvider(), actorContextService: { authenticateAccessToken: async () => actor, revalidateActor: async () => actor } });

try {
  await adapter.start();
  const events = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
    const received: Array<Record<string, unknown>> = [];
    const ws = new WebSocket('ws://127.0.0.1:28891');
    const timeout = setTimeout(() => { ws.close(); reject(new Error('agent cancellation qualification timed out')); }, 10_000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: 'qualification-token' })));
    ws.on('message', (raw) => {
      const event = JSON.parse(raw.toString()) as Record<string, unknown>;
      received.push(event);
      if (event.type === 'auth_ok') ws.send(JSON.stringify({ type: 'chat.send', message: 'wait for cancellation', messageId, idempotencyKey }));
      if (event.type === 'session.created' && typeof event.sessionKey === 'string') {
        void (async () => {
          for (let i = 0; i < 40; i += 1) {
            const [rows] = await pool.execute<Array<{ id: string }>>('SELECT id FROM agent_runs WHERE actor_id = ? AND idempotency_key = ?', [actor.userId, idempotencyKey]);
            if (rows[0]?.id) { ws.send(JSON.stringify({ type: 'chat.cancel', runId: rows[0].id, sessionKey: event.sessionKey })); return; }
            await new Promise((done) => setTimeout(done, 25));
          }
          reject(new Error('cancelled run was never claimed'));
        })();
      }
      if (event.type === 'cancelled') { clearTimeout(timeout); ws.close(); resolve(received); }
    });
    ws.on('error', (error) => { clearTimeout(timeout); reject(error); });
  });
  if (!events.some((event) => event.type === 'cancelled') || events.some((event) => event.type === 'complete')) throw new Error('cancel produced an invalid event sequence');
  const [runs] = await pool.execute<Array<{ state: string; finished_at: Date | null }>>('SELECT state, finished_at FROM agent_runs WHERE actor_id = ? AND idempotency_key = ?', [actor.userId, idempotencyKey]);
  if (runs[0]?.state !== 'cancelled' || !runs[0]?.finished_at) throw new Error('cancelled Agent run was not durably persisted');
  console.log(`agent-run cancellation valid: actor=${actor.userId} state=${runs[0].state}`);
} finally {
  await adapter.dispose();
  await dbConnection.close();
}
