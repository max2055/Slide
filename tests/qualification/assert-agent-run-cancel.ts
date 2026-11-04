import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export interface CancelQualificationSocket {
  send(data: string): void;
  close(): void;
  on(event: 'open' | 'message' | 'error', listener: (payload?: unknown) => void): void;
}

export interface CancelQualificationWatch {
  connect: () => CancelQualificationSocket;
  findRunId: () => Promise<string | undefined>;
  messageId: string;
  idempotencyKey: string;
  timeoutMs?: number;
  maxPolls?: number;
  pollDelayMs?: number;
}

export function isDirectExecution(argv1: string | undefined = process.argv[1], moduleUrl: string = import.meta.url): boolean {
  if (!argv1) return false;
  return resolve(argv1) === fileURLToPath(moduleUrl);
}

/**
 * Collect cancel-qualification events.
 * The claim poll stays on this promise: every terminal path clears the timer
 * and socket, then settles only after the poll stops, keeping the first cause.
 * The caller closes the database after this promise settles.
 */
export function collectCancelEvents(options: CancelQualificationWatch): Promise<Array<Record<string, unknown>>> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxPolls = options.maxPolls ?? 40;
  const pollDelayMs = options.pollDelayMs ?? 25;

  return new Promise((resolve, reject) => {
    const received: Array<Record<string, unknown>> = [];
    const ws = options.connect();
    let settled = false;
    let stopPoll = false;
    let pollStarted = false;
    let wakeSleep: (() => void) | undefined;
    let pollPromise: Promise<void> = Promise.resolve();

    const timeout = setTimeout(() => {
      finish(() => reject(new Error('agent cancellation qualification timed out')));
    }, timeoutMs);

    function finish(settle: () => void) {
      if (settled) return;
      settled = true;
      stopPoll = true;
      clearTimeout(timeout);
      wakeSleep?.();
      try { ws.close(); } catch { /* socket already closed */ }
      void pollPromise.then(() => settle(), () => settle());
    }

    function send(payload: Record<string, unknown>) {
      if (stopPoll) return;
      try {
        ws.send(JSON.stringify(payload));
      } catch (error) {
        finish(() => reject(error));
      }
    }

    function interruptibleDelay(ms: number): Promise<void> {
      return new Promise((done) => {
        if (stopPoll) { done(); return; }
        const timer = setTimeout(() => {
          if (wakeSleep === cancel) wakeSleep = undefined;
          done();
        }, ms);
        function cancel() {
          clearTimeout(timer);
          if (wakeSleep === cancel) wakeSleep = undefined;
          done();
        }
        wakeSleep = cancel;
      });
    }

    function startPoll(sessionKey: string) {
      if (pollStarted || settled) return;
      pollStarted = true;
      let resolvePoll = () => {};
      pollPromise = new Promise<void>((resolvePollDone) => { resolvePoll = resolvePollDone; });
      void (async () => {
        try {
          for (let attempt = 0; attempt < maxPolls; attempt += 1) {
            if (stopPoll) return;
            const runId = await options.findRunId();
            if (stopPoll) return;
            if (runId) {
              send({ type: 'chat.cancel', runId, sessionKey });
              return;
            }
            await interruptibleDelay(pollDelayMs);
          }
          if (!stopPoll) finish(() => reject(new Error('cancelled run was never claimed')));
        } catch (error) {
          finish(() => reject(error));
        } finally {
          resolvePoll();
        }
      })();
    }

    ws.on('open', () => send({ type: 'auth', token: 'qualification-token' }));
    ws.on('message', (raw) => {
      if (settled) return;
      let event: Record<string, unknown>;
      try {
        const text = typeof raw === 'string' ? raw : (raw as { toString(): string }).toString();
        event = JSON.parse(text) as Record<string, unknown>;
      } catch (error) {
        finish(() => reject(error));
        return;
      }
      received.push(event);
      if (event.type === 'auth_ok') {
        send({ type: 'chat.send', message: 'wait for cancellation', messageId: options.messageId, idempotencyKey: options.idempotencyKey });
      }
      if (event.type === 'session.created' && typeof event.sessionKey === 'string') startPoll(event.sessionKey);
      if (event.type === 'cancelled') finish(() => resolve(received));
    });
    ws.on('error', (error) => finish(() => reject(error)));
  });
}

async function main(): Promise<void> {
  const { randomUUID } = await import('node:crypto');
  const { ToolRegistry } = await import('../../packages/agent-core/src/index.js');
  const { default: WebSocket } = await import('../../apps/db-ops-api/node_modules/ws/index.js');
  const { DirectAdapter } = await import('../../apps/db-ops-api/src/adapter/direct-adapter.js');
  const { dbConnection } = await import('../../apps/db-ops-api/src/db-connection.js');

  class CancellableProvider {
    getDefaultModel(): string { return 'qualification-cancellable-provider'; }
    async chat(_messages: unknown, _tools: unknown, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>> {
      return new Promise((resolve) => options?.signal?.addEventListener('abort', () => resolve({ content: null, finishReason: 'error', toolCalls: [], usage: {}, shouldExecuteTools: false, hasToolCalls: false, errorKind: 'provider_error' }), { once: true }));
    }
    async chatStream(_messages: unknown, _tools: unknown, _callbacks: unknown, options?: { signal?: AbortSignal }) {
      return this.chat([], [], options);
    }
  }

  process.env.ENCRYPTION_KEY ??= 'qualification-encryption-key-2026-07-19-not-production';
  process.env.JWT_SECRET_KEY ??= 'qualification-jwt-secret-2026-07-19-long';
  process.env.AGENT_WS_PORT = '28891';
  if (!await dbConnection.initialize()) throw new Error('qualification database connection failed');
  const pool = dbConnection.getPool();
  if (!pool) throw new Error('qualification database pool unavailable');
  const username = `qualification-cancel-${process.pid}-${Date.now()}`;
  const [user] = await pool.execute("INSERT INTO users (username, password_hash, status) VALUES (?, 'qualification-not-a-login', 'active')", [username]) as any;
  const actor = Object.freeze({ userId: Number(user.insertId), username, roles: Object.freeze(['viewer']), permissions: Object.freeze([]), sessionVersion: 1, instanceScopes: Object.freeze({}), requestId: 'qualification-agent-run-cancel' });
  const idempotencyKey = `qualification-cancel-${randomUUID()}`;
  const messageId = `qualification-message-${randomUUID()}`;
  const adapter = new DirectAdapter({ tools: new ToolRegistry(), llmProvider: new CancellableProvider(), actorContextService: { authenticateAccessToken: async () => actor, revalidateActor: async () => actor } });

  try {
    await adapter.start();
    const events = await collectCancelEvents({
      connect: () => new WebSocket('ws://127.0.0.1:28891') as CancelQualificationSocket,
      findRunId: async () => {
        const [rows] = await pool.execute<Array<{ id: string }>>('SELECT id FROM agent_runs WHERE actor_id = ? AND idempotency_key = ?', [actor.userId, idempotencyKey]);
        return rows[0]?.id;
      },
      messageId,
      idempotencyKey,
    });
    if (!events.some((event) => event.type === 'cancelled') || events.some((event) => event.type === 'complete')) throw new Error('cancel produced an invalid event sequence');
    const [runs] = await pool.execute<Array<{ state: string; finished_at: Date | null }>>('SELECT state, finished_at FROM agent_runs WHERE actor_id = ? AND idempotency_key = ?', [actor.userId, idempotencyKey]);
    if (runs[0]?.state !== 'cancelled' || !runs[0]?.finished_at) throw new Error('cancelled Agent run was not durably persisted');
    console.log(`agent-run cancellation valid: actor=${actor.userId} state=${runs[0].state}`);
  } finally {
    await adapter.dispose();
    await dbConnection.close();
  }
}

if (isDirectExecution()) await main();
