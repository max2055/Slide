import { dbConnection } from '../../apps/db-ops-api/src/db-connection.js';
import { DirectAdapter } from '../../apps/db-ops-api/src/adapter/direct-adapter.js';
import { ToolRegistry } from '../../packages/agent-core/src/index.js';
import type { ActorContext } from '../../apps/db-ops-api/src/auth/actor-context.js';

if (!/^slide_runtime_[a-f0-9]{32}$/.test(process.env.DB_NAME ?? '')) throw new Error('Stream crash probe requires an isolated schema');
if (!await dbConnection.initialize()) throw new Error('Crash database unavailable');
const pool = dbConnection.getPool()!;
const tools = new ToolRegistry();
tools.register({ name: 'fixture_read', description: 'isolated fixture', parameters: { type: 'object', properties: {} }, readOnly: true, concurrencySafe: true, exclusive: false,
  execute: async () => { await pool.query('INSERT INTO stream_fixture_effects VALUES ()'); if (process.env.QUALIFICATION_CRASH_MODE === 'unknown') process.exit(76); return 'crash tool settled'; } });
const actor: ActorContext = { userId: Number(process.env.QUALIFICATION_CRASH_ACTOR_ID), username: 'stream-crash-fixture', roles: ['admin'], permissions: [], sessionVersion: 1, instanceScopes: {}, requestId: 'stream-crash' };
let requests = 0;
const adapter = new DirectAdapter({ workspace: process.env.QUALIFICATION_CRASH_WORKSPACE, tools, toolsForActor: () => tools, llmProvider: {
  getDefaultModel: () => 'stream-crash', chat: async () => { throw new Error('unused'); }, chatStream: async (_m, _t, c) => {
    if (++requests === 2) { await c.onThinkingDelta?.('discarded crash reasoning'); await c.onContentDelta('discarded crash text'); process.exit(75); }
    await c.onThinkingDelta?.('durable crash reasoning'); await c.onContentDelta('durable crash narration');
    return { content: 'durable crash narration', finishReason: 'tool_calls', toolCalls: [{ id: 'crash-intent', name: 'fixture_read', arguments: {} }], hasToolCalls: true, shouldExecuteTools: true,
      usage: { prompt_tokens: 10, completion_tokens: 10 } };
  },
} });
const runId = process.env.QUALIFICATION_CRASH_RUN_ID!;
await adapter.chat(process.env.QUALIFICATION_CRASH_SESSION_ID!, '检查数据库', () => {}, actor, undefined, process.env.QUALIFICATION_CRASH_REQUEST_KEY, runId, `run_${runId}_user`);
throw new Error('Crash injection did not fire');
