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
import { chatDatabaseService } from '../../apps/db-ops-api/src/chat-database-service.js';
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
  process.env.AGENT_RUN_TIMEOUT_MS = '5000';
  process.env.AGENT_WS_PORT = '0'; process.env.AGENT_WS_HOST = '127.0.0.1';
  const init = spawnSync('pnpm', ['--filter', 'slide-api', 'exec', 'tsx', 'init-db.ts'], { cwd: new URL('../..', import.meta.url), env: process.env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(init.status, 0, 'isolated schema initialization failed');
  assert(await dbConnection.initialize()); const pool = dbConnection.getPool()!;
  const [created] = await pool.execute("INSERT INTO users (username, password_hash, status) VALUES (?, 'not-a-login', 'active')", [`runtime-${randomUUID()}`]) as any;
  const actor: ActorContext = { userId: Number(created.insertId), username: 'runtime-qualification', roles: ['viewer'], permissions: [], sessionVersion: 1, instanceScopes: {}, requestId: randomUUID() };
  const bad = '正在分析数据库状态……\n'.repeat(20);
  let activeScenario = '';
  let notifySnapshot!: () => void; let releaseSnapshot!: () => void;
  let snapshotReady = new Promise<void>(resolve => { notifySnapshot = resolve; });
  let snapshotRelease = new Promise<void>(resolve => { releaseSnapshot = resolve; });
  let requests = 0; let toolExecutions = 0; let sequence: LLMResponse[] = [];
  await pool.query('CREATE TABLE stream_fixture_effects (id INT AUTO_INCREMENT PRIMARY KEY)');
  const tools = new ToolRegistry();
  tools.register({ name: 'fixture_read', description: 'isolated fixture', parameters: { type: 'object', properties: {} }, readOnly: true, concurrencySafe: true, exclusive: false,
    execute: async () => { toolExecutions++; await pool.query('INSERT INTO stream_fixture_effects VALUES ()'); return 'settled fixture'; } });
  const response = (content: string, finishReason = 'stop'): LLMResponse => ({ content, finishReason, toolCalls: [], shouldExecuteTools: false, hasToolCalls: false, usage: { prompt_tokens: 10, completion_tokens: 10 } });
  const provider: LLMProvider = { getDefaultModel: () => 'controlled-mysql', chat: async () => sequence[Math.min(requests++, sequence.length-1)], chatStream: async (_m,_t,c,options) => { if (['thinking-reset', 'partial-tool-reset', 'tool-reset', 'snapshot-reset'].includes(activeScenario)) {
      requests++;
      if (activeScenario === 'tool-reset' && requests === 1) {
        await c.onThinkingDelta?.('durable reasoning'); await c.onContentDelta('durable narration');
        return { ...response('durable narration'), toolCalls: [{ id: 'fixture-intent', name: 'fixture_read', arguments: {} }], hasToolCalls: true, shouldExecuteTools: true };
      }
      const interrupted = requests === (activeScenario === 'tool-reset' ? 2 : 1);
      await c.onThinkingDelta?.(interrupted ? 'discarded reasoning' : 'valid reasoning');
      if (interrupted) {
        if (activeScenario !== 'thinking-reset') { await c.onContentDelta('discarded text'); await c.onToolCallDelta?.({ index: 0, arguments: '{' } as any); }
        throw Object.assign(new Error('fixture stream reset'), { code: 'ECONNRESET' });
      }
      await c.onContentDelta('安全结论');
      if (activeScenario === 'snapshot-reset') { notifySnapshot(); await snapshotRelease; }
      return response('安全结论');
    } if (activeScenario === 'deadline' || activeScenario === 'cancel') { requests++; if (activeScenario === 'cancel') await c.onContentDelta('准备检查。'); await new Promise((_resolve, reject) => { const cancel = () => reject(options?.signal?.reason); if (options?.signal?.aborted) cancel(); else options?.signal?.addEventListener('abort', cancel, { once: true }); }); } const r = sequence[Math.min(requests++, sequence.length-1)]; await c.onContentDelta(r.content ?? ''); return r; } };
  adapter = new DirectAdapter({ workspace, tools, toolsForActor: () => tools, llmProvider: provider, actorContextService: { authenticateAccessToken: async () => actor, revalidateActor: async () => actor } });
  await adapter.start();
  const server = (adapter as any).wsServer; if (!server.address()) await once(server, 'listening');
  const port = server.address().port;
  console.log(JSON.stringify({ pid: process.pid, port, cwd: process.cwd(), command: 'tsx agent-runtime.ts mysql', schema: database, log: process.env.QUALIFICATION_RUNTIME_LOG }));
  async function socketExchange(command: Record<string, unknown>, terminal: string, cancelOnDelta = false) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`); const events: any[] = [];
    try { return await new Promise<any[]>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WS qualification timeout')), 15000);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: 'controlled-test-token' })));
      ws.on('error', (e: Error) => { clearTimeout(timeout); reject(e); });
      ws.on('message', (raw: Buffer) => { const e = JSON.parse(raw.toString()); events.push(e);
        if (e.type === 'auth_ok') ws.send(JSON.stringify(command));
        if (cancelOnDelta && e.type === 'text_delta') { const run = events.find(r => r.type === 'run.started'); ws.send(JSON.stringify({ type: 'chat.cancel', runId: run.runId, sessionKey: run.sessionKey })); }
        if (e.type === terminal) { clearTimeout(timeout); resolve(events); }
      });
    }); } finally { ws.close(); if (ws.readyState !== WebSocket.CLOSED) await once(ws, 'close'); }
  }
  for (const scenario of ['recovery', 'length', 'reject', 'deadline', 'cancel', 'thinking-reset', 'partial-tool-reset', 'tool-reset'] as const) {
    activeScenario = scenario;
    const success = ['recovery', 'length', 'thinking-reset', 'partial-tool-reset', 'tool-reset'].includes(scenario);
    requests = 0; sequence = scenario === 'recovery' ? [response(bad), response('安全结论')] : scenario === 'length' ? [response('第一段', 'length'), response('第二段')] : [response(bad)];
    const idempotencyKey = randomUUID(); const messageId = randomUUID();
    const events = await socketExchange({ type: 'chat.send', message: '检查数据库', messageId, idempotencyKey }, success ? 'complete' : scenario === 'cancel' ? 'cancelled' : 'error', scenario === 'cancel');
    const started = events.find(e => e.type === 'run.started'); assert(started?.runId);
    const before = requests;
    const replay = await socketExchange({ type: 'chat.send', sessionKey: started.sessionKey, message: '检查数据库', messageId, idempotencyKey }, 'run.snapshot');
    assert.equal(requests, before, 'replay re-executed provider');
    const history = await socketExchange({ type: 'chat.history', sessionKey: started.sessionKey }, 'complete');
    assert(!JSON.stringify(history).includes('正在分析数据库状态'));
    const run = replay.find(e => e.type === 'run.snapshot').run;
    assert.equal(run.state, success ? 'completed' : scenario === 'deadline' ? 'timed_out' : scenario === 'cancel' ? 'cancelled' : 'failed');
    const [messages] = await pool.query<any[]>('SELECT content FROM chat_messages WHERE session_id = ? AND role = ?', [started.sessionKey, 'assistant']);
    assert.equal(messages.length, success ? 1 : 0);
    assert(!JSON.stringify(messages).includes('正在分析数据库状态'));
    if (success && !scenario.includes('reset')) assert.equal(messages[0].content, scenario === 'length' ? '第一段第二段' : '安全结论');
    if (scenario.includes('reset')) {
      assert(!JSON.stringify(history).includes('discarded'));
      const reset = events.find(e => e.type === 'text_delta' && e.reset);
      assert(reset?.anchorId && reset.sourceRequestId && reset.discardedBytes > 0);
      assert.equal(events.at(-1).thinkingContent, scenario === 'tool-reset' ? 'durable reasoningvalid reasoning' : 'valid reasoning');
      if (scenario === 'tool-reset') {
        assert.equal(reset.delta, 'durable narration'); assert.equal(reset.thinkingContent, 'durable reasoning');
        assert.equal(toolExecutions, 1);
        const [effects] = await pool.query<any[]>('SELECT COUNT(*) AS count FROM stream_fixture_effects'); assert.equal(effects[0].count, 1);
      }
      console.log(JSON.stringify({ scenario, anchorId: reset.anchorId, sourceRequestId: reset.sourceRequestId, discardedBytes: reset.discardedBytes, toolExecutions, attempt: events.at(-1).attempt }));
    }
    const groups = platformLogs.query({ component: 'agent' }).groups;
    assert(groups.some(g => g.eventType === 'runtime.model.start' && g.correlationIds.includes(started.runId)));
    if (success) assert(groups.some(g => g.eventType === 'run.completed' && g.correlationIds.includes(started.runId)));
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

  // Reconnect while a new attempt is still active: only its effective snapshot is sent.
  activeScenario = 'snapshot-reset'; requests = 0;
  const watched = await chatDatabaseService.createSession(actor, { title: 'active stream snapshot' });
  const foreground = socketExchange({ type: 'chat.send', sessionKey: watched.session_id, message: '检查数据库', messageId: randomUUID(), idempotencyKey: randomUUID() }, 'complete');
  void foreground.catch(() => {});
  await snapshotReady;
  const watcher = await socketExchange({ type: 'chat.watch', sessionKey: watched.session_id }, 'text_delta');
  const snapshot = watcher.find(e => e.type === 'text_delta');
  assert(snapshot.reset && snapshot.attempt === 2 && snapshot.delta === '安全结论' && snapshot.thinkingContent === 'valid reasoning');
  assert(!JSON.stringify(watcher).includes('discarded'));
  releaseSnapshot(); await foreground;
  console.log(JSON.stringify({ scenario: 'active-WS-reconnect-effective-attempt-snapshot', passed: true, attempt: snapshot.attempt, sequence: snapshot.sequence }));

  // Kill a real process after a tool checkpoint and during a provisional next attempt.
  const crashedSession = await chatDatabaseService.createSession(actor, { title: 'stream crash restore' });
  const service = new AgentRunService(); const crashKey = randomUUID();
  const claimed = await service.claim(actor.userId, crashedSession.session_id, randomUUID(), crashKey);
  const userFactId = `run_${claimed.run.id}_user`;
  await chatDatabaseService.addMessage(actor, crashedSession.session_id, { messageId: userFactId, role: 'user', content: '检查数据库', metadata: { canonicalRunId: claimed.run.id, canonicalTurnId: userFactId } });
  const crash = spawnSync('pnpm', ['--filter', 'slide-api', 'exec', 'tsx', '../../tests/qualification/stream-boundary-crash.ts'], {
    cwd: new URL('../..', import.meta.url), env: { ...process.env, QUALIFICATION_CRASH_RUN_ID: claimed.run.id,
      QUALIFICATION_CRASH_ACTOR_ID: String(actor.userId), QUALIFICATION_CRASH_SESSION_ID: crashedSession.session_id, QUALIFICATION_CRASH_REQUEST_KEY: crashKey,
      QUALIFICATION_CRASH_WORKSPACE: workspace }, encoding: 'utf8', timeout: 20000 });
  assert(crash.status !== 0 && crash.stdout.includes('exit code 75'), 'stream process must exit inside the provisional attempt');
  const saved = (await chatDatabaseService.getSessionMetadata(actor, crashedSession.session_id))?.canonicalRuntimeCheckpoint as any;
  assert.equal(saved.stream_state_v1.attempt, 2); assert.equal(saved.stream_state_v1.anchor.text, 'durable crash narration');
  const restored = new DirectAdapter({ workspace, tools, toolsForActor: () => tools, llmProvider: { getDefaultModel: () => 'restored', chat: async () => response('安全结论'),
    chatStream: async (messages, _t, c) => {
      assert(messages.some(m => m.role === 'tool' && m.content === 'crash tool settled'), 'durable tool result must reach restored provider context');
      assert(!JSON.stringify(messages).includes('discarded'));
      await c.onThinkingDelta?.('valid restored reasoning'); await c.onContentDelta('安全结论'); return response('安全结论');
    } } });
  try {
    const events: any[] = [];
    const result = await restored.chat(crashedSession.session_id, '检查数据库', e => { events.push(e); }, actor, undefined, crashKey, claimed.run.id, userFactId);
    assert.equal(result.stopReason, 'completed'); assert.equal(events.at(-1).attempt, 3);
    assert.equal(result.thinkingContent, 'durable crash reasoningvalid restored reasoning');
    assert.equal((await chatDatabaseService.getSessionMetadata(actor, crashedSession.session_id))?.canonicalRuntimeCheckpoint?.stream_state_v1?.discardedBytesIncomplete, true);
    assert.equal(result.usage?.prompt_tokens, 20); // two settled requests, the crashed request remains reserved
    const pending = await service.getForActor(claimed.run.id, actor.userId, crashedSession.session_id);
    await service.complete(pending!, events.at(-1));
    const [effects] = await pool.query<any[]>('SELECT COUNT(*) AS count FROM stream_fixture_effects'); assert.equal(effects[0].count, 2);
    const [answers] = await pool.query<any[]>('SELECT id FROM chat_messages WHERE message_id = ?', [`run_${claimed.run.id}_assistant`]); assert.equal(answers.length, 1);
    console.log(JSON.stringify({ scenario: 'OS-stream-crash-durable-tool-anchor-restored', passed: true, anchorId: saved.stream_state_v1.anchor.checkpointId,
      beforeAttempt: 2, afterAttempt: 3, toolExecutionsForCrashedRun: 1, finalAssistantCount: answers.length }));
  } finally { await restored.dispose(); }

  const unknownSession = await chatDatabaseService.createSession(actor, { title: 'unknown tool settlement' });
  const unknownKey = randomUUID(); const unknown = await service.claim(actor.userId, unknownSession.session_id, randomUUID(), unknownKey);
  const unknownUser = `run_${unknown.run.id}_user`;
  await chatDatabaseService.addMessage(actor, unknownSession.session_id, { messageId: unknownUser, role: 'user', content: '检查数据库', metadata: { canonicalRunId: unknown.run.id, canonicalTurnId: unknownUser } });
  const interrupted = spawnSync('pnpm', ['--filter', 'slide-api', 'exec', 'tsx', '../../tests/qualification/stream-boundary-crash.ts'], {
    cwd: new URL('../..', import.meta.url), env: { ...process.env, QUALIFICATION_CRASH_RUN_ID: unknown.run.id, QUALIFICATION_CRASH_ACTOR_ID: String(actor.userId),
      QUALIFICATION_CRASH_SESSION_ID: unknownSession.session_id, QUALIFICATION_CRASH_REQUEST_KEY: unknownKey, QUALIFICATION_CRASH_WORKSPACE: workspace, QUALIFICATION_CRASH_MODE: 'unknown' }, encoding: 'utf8', timeout: 20000 });
  assert(interrupted.status !== 0 && interrupted.stdout.includes('exit code 76'));
  let forbiddenRequests = 0;
  const reconciliation = new DirectAdapter({ workspace, tools, toolsForActor: () => tools, llmProvider: { getDefaultModel: () => 'must-not-dispatch',
    chat: async () => { forbiddenRequests++; return response('bad'); }, chatStream: async () => { forbiddenRequests++; return response('bad'); } } });
  try {
    const result = await reconciliation.chat(unknownSession.session_id, '检查数据库', () => {}, actor, undefined, unknownKey, unknown.run.id, unknownUser);
    assert.equal(result.resolution?.reasonCode, 'TOOL_SETTLEMENT_UNKNOWN'); assert.equal(forbiddenRequests, 0);
    const [effects] = await pool.query<any[]>('SELECT COUNT(*) AS count FROM stream_fixture_effects'); assert.equal(effects[0].count, 3);
    const pending = (await chatDatabaseService.getSessionMetadata(actor, unknownSession.session_id))?.canonicalRuntimeCheckpoint as any;
    assert.equal(pending.pendingToolCalls.length, 1);
    console.log(JSON.stringify({ scenario: 'OS-crash-unknown-tool-settlement-no-replay', passed: true, toolExecutionsForUnknownRun: 1, providerRequestsAfterRestart: 0, pendingIntents: 1 }));
  } finally { await reconciliation.dispose(); }
} finally {
  await adapter?.dispose(); await dbConnection.close();
  await connection.query(`DROP DATABASE \`${database}\``); await connection.end();
  await rm(workspace, { recursive: true, force: true });
}
