import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { ToolRegistry } from '../../packages/agent-core/src/index.js';
import type { LLMProvider, LLMResponse } from '../../packages/agent-core/src/index.js';
import { DirectAdapter } from '../../apps/db-ops-api/src/adapter/direct-adapter.js';
import { AgentRunService } from '../../apps/db-ops-api/src/adapter/agent-run-service.js';
import { dbConnection } from '../../apps/db-ops-api/src/db-connection.js';
import { platformLogs } from '../../apps/db-ops-api/src/platform/structured-log-evidence-adapter.js';
import type { ActorContext } from '../../apps/db-ops-api/src/auth/actor-context.js';
const require = createRequire(new URL('../../apps/db-ops-api/package.json', import.meta.url));
const mysql = require('mysql2/promise');
const WebSocket = require('ws');
const database = `slide_runtime_${randomUUID().replaceAll('-', '')}`;
const workspace = await mkdtemp(join(tmpdir(), 'slide-runtime-'));
const connection = await mysql.createConnection({ host: process.env.DB_HOST ?? '127.0.0.1', port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_USER ?? 'root', password: process.env.DB_PASSWORD });
let adapter: DirectAdapter | undefined;
try {
  await connection.query(`CREATE DATABASE \`${database}\``);
  process.env.DB_NAME = database;
  process.env.JWT_SECRET_KEY = randomUUID() + randomUUID();
  process.env.ENCRYPTION_KEY = randomUUID();
  process.env.AGENT_WS_PORT = '0'; process.env.AGENT_WS_HOST = '127.0.0.1';
  const init = spawnSync('pnpm', ['--filter', 'slide-api', 'exec', 'tsx', 'init-db.ts'], { cwd: new URL('../..', import.meta.url), env: process.env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(init.status, 0, 'isolated schema initialization failed');
  assert(await dbConnection.initialize()); const pool = dbConnection.getPool()!;
  const [created] = await pool.execute("INSERT INTO users (username, password_hash, status) VALUES (?, 'not-a-login', 'active')", [`runtime-${randomUUID()}`]) as any;
  const actor: ActorContext = { userId: Number(created.insertId), username: 'runtime-qualification', roles: ['viewer'], permissions: [], sessionVersion: 1, instanceScopes: {}, requestId: randomUUID() };
  const bad = '正在分析数据库状态……\n'.repeat(20);
  let requests = 0; let sequence: LLMResponse[] = [];
  const response = (content: string, finishReason = 'stop'): LLMResponse => ({ content, finishReason, toolCalls: [], shouldExecuteTools: false, hasToolCalls: false, usage: { prompt_tokens: 10, completion_tokens: 10 } });
  const provider: LLMProvider = { getDefaultModel: () => 'controlled-mysql', chat: async () => sequence[Math.min(requests++, sequence.length-1)], chatStream: async (_m,_t,c) => { const r = sequence[Math.min(requests++, sequence.length-1)]; await c.onContentDelta(r.content ?? ''); return r; } };
  adapter = new DirectAdapter({ workspace, tools: new ToolRegistry(), llmProvider: provider, actorContextService: { authenticateAccessToken: async () => actor, revalidateActor: async () => actor } });
  await adapter.start();
  const server = (adapter as any).wsServer; if (!server.address()) await once(server, 'listening');
  const port = server.address().port;
  console.log(JSON.stringify({ pid: process.pid, port, cwd: process.cwd(), command: 'tsx agent-runtime.ts mysql', schema: database, log: process.env.QUALIFICATION_RUNTIME_LOG }));
  async function socketExchange(command: Record<string, unknown>, terminal: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`); const events: any[] = [];
    try { return await new Promise<any[]>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WS qualification timeout')), 15000);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: 'controlled-test-token' })));
      ws.on('error', (e: Error) => { clearTimeout(timeout); reject(e); });
      ws.on('message', (raw: Buffer) => { const e = JSON.parse(raw.toString()); events.push(e);
        if (e.type === 'auth_ok') ws.send(JSON.stringify(command));
        if (e.type === terminal) { clearTimeout(timeout); resolve(events); }
      });
    }); } finally { ws.close(); if (ws.readyState !== WebSocket.CLOSED) await once(ws, 'close'); }
  }
  for (const scenario of ['recovery', 'length', 'reject'] as const) {
    requests = 0; sequence = scenario === 'recovery' ? [response(bad), response('安全结论')] : scenario === 'length' ? [response('第一段', 'length'), response('第二段')] : [response(bad)];
    const idempotencyKey = randomUUID(); const messageId = randomUUID();
    const events = await socketExchange({ type: 'chat.send', message: '检查数据库', messageId, idempotencyKey }, scenario === 'reject' ? 'error' : 'complete');
    const started = events.find(e => e.type === 'run.started'); assert(started?.runId);
    const before = requests;
    const replay = await socketExchange({ type: 'chat.send', sessionKey: started.sessionKey, message: '检查数据库', messageId, idempotencyKey }, 'run.snapshot');
    assert.equal(requests, before, 'replay re-executed provider');
    const history = await socketExchange({ type: 'chat.history', sessionKey: started.sessionKey }, 'complete');
    assert(!JSON.stringify(history).includes('正在分析数据库状态'));
    const run = replay.find(e => e.type === 'run.snapshot').run;
    assert.equal(run.state, scenario === 'reject' ? 'failed' : 'completed');
    const [messages] = await pool.query<any[]>('SELECT content FROM chat_messages WHERE session_id = ? AND role = ?', [started.sessionKey, 'assistant']);
    assert.equal(messages.length, scenario === 'reject' ? 0 : 1);
    assert(!JSON.stringify(messages).includes('正在分析数据库状态'));
    if (scenario !== 'reject') assert.equal(messages[0].content, scenario === 'length' ? '第一段第二段' : '安全结论');
    const groups = platformLogs.query({ component: 'agent' }).groups;
    assert(groups.some(g => g.eventType === 'runtime.model.start' && g.correlationIds.includes(started.runId)));
    if (scenario !== 'reject') assert(groups.some(g => g.eventType === 'run.completed' && g.correlationIds.includes(started.runId)));
    console.log(JSON.stringify({ scenario, state: run.state, requests, assistantMessages: messages.length, uniqueFinal: true, correlated: true }));
    // Real SQL intent survives a process/service replacement and concurrent recovery.
    if (scenario === 'recovery') {
      const service = new AgentRunService(); const claimed = await service.claim(actor.userId, started.sessionKey, randomUUID(), randomUUID());
      const failing = new AgentRunService(() => ({ query: pool.query.bind(pool), getConnection: async () => { throw new Error('injected storage unavailable'); } }) as any);
      await assert.rejects(failing.complete(claimed.run, { type: 'complete', finalContent: '持久化恢复结论' }));
      const pending = await service.getForActor(claimed.run.id, actor.userId, started.sessionKey); assert.equal(pending?.state, 'running'); assert((pending?.result as any).completionPending);
      await Promise.all([new AgentRunService().recoverCompletion(pending!), new AgentRunService().recoverCompletion(pending!)]);
      const [rows] = await pool.query<any[]>('SELECT content FROM chat_messages WHERE message_id = ?', [`run_${claimed.run.id}_assistant`]); assert.equal(rows.length, 1);
      console.log(JSON.stringify({ scenario: 'storage-pending-service-restart-concurrent-recovery', uniqueFinal: true }));
      const crashRun = await service.claim(actor.userId, started.sessionKey, randomUUID(), randomUUID());
      const crash = spawnSync('pnpm', ['--filter', 'slide-api', 'exec', 'tsx', '../../tests/qualification/agent-runtime-crash.ts'], {
        cwd: new URL('../..', import.meta.url), env: { ...process.env, QUALIFICATION_CRASH_RUN_ID: crashRun.run.id,
          QUALIFICATION_CRASH_ACTOR_ID: String(actor.userId), QUALIFICATION_CRASH_SESSION_ID: started.sessionKey }, encoding: 'utf8', timeout: 20000 });
      // pnpm may normalize the child's nonzero exit; verify its reported status too.
      assert(crash.status !== 0 && crash.stdout.includes('exit code 74'), 'crash probe must reach the pre-commit exit');
      const afterCrash = await service.getForActor(crashRun.run.id, actor.userId, started.sessionKey);
      assert.equal(afterCrash?.state, 'running'); assert((afterCrash?.result as any).completionPending);
      const [beforeRecovery] = await pool.query<any[]>('SELECT id FROM chat_messages WHERE message_id = ?', [`run_${crashRun.run.id}_assistant`]);
      assert.equal(beforeRecovery.length, 0, 'crashed transaction leaked its uncommitted answer');
      await service.recoverCompletion(afterCrash!);
      const [afterRecovery] = await pool.query<any[]>('SELECT content FROM chat_messages WHERE message_id = ?', [`run_${crashRun.run.id}_assistant`]);
      assert.equal(afterRecovery.length, 1); assert.equal(afterRecovery[0].content, '崩溃恢复结论');
      console.log(JSON.stringify({ scenario: 'OS-process-exit-before-commit', rolledBack: true, uniqueFinal: true }));
    }
  }
} finally {
  await adapter?.dispose(); await dbConnection.close();
  await connection.query(`DROP DATABASE \`${database}\``); await connection.end();
  await rm(workspace, { recursive: true, force: true });
}
