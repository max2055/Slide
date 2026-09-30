/** Real isolated MySQL + JWT authenticated WS + provider boundary. No paid model calls. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { dbConnection } from '../../apps/db-ops-api/src/db-connection.js';
import { chatDatabaseService } from '../../apps/db-ops-api/src/chat-database-service.js';
import { canonicalStore } from '../../apps/db-ops-api/src/adapter/canonical-store.js';
import { agentRunService } from '../../apps/db-ops-api/src/adapter/agent-run-service.js';
import { actorContextService, signAccessToken } from '../../apps/db-ops-api/src/auth/actor-context.js';
import { MemoryPipeline, StructuredMemoryStore, ToolRegistry, memoryReferenceTokens, type LLMProvider, type Message } from '../../packages/agent-core/src/index.js';
import { DirectAdapter } from '../../apps/db-ops-api/src/adapter/direct-adapter.js';
const require = createRequire(new URL('../../apps/db-ops-api/package.json', import.meta.url));
const mysql = require('mysql2/promise'); const WebSocket = require('ws');
const database = `slide_retrieval_${randomUUID().replaceAll('-', '')}`;
const workspace = await mkdtemp(join(tmpdir(), 'slide-retrieval-qualification-'));
const connection = await mysql.createConnection({ host: process.env.DB_HOST ?? '127.0.0.1', port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_USER ?? 'root', password: process.env.DB_PASSWORD, connectTimeout: 5000 });
const results: unknown[] = []; const providerRequests: Message[][] = [];
let adapter: DirectAdapter | undefined; let pipeline: MemoryPipeline | undefined;
try {
  await connection.query(`CREATE DATABASE \`${database}\``); process.env.DB_NAME = database;
  process.env.JWT_SECRET_KEY = randomUUID() + randomUUID(); process.env.ENCRYPTION_KEY = randomUUID();
  process.env.AGENT_WS_PORT = '0'; process.env.AGENT_WS_HOST = '127.0.0.1';
  const init = spawnSync('pnpm', ['--filter', 'slide-api', 'exec', 'tsx', 'init-db.ts'], { cwd: new URL('../..', import.meta.url), env: process.env, encoding: 'utf8', timeout: 120000 });
  assert.equal(init.status, 0, 'Isolated schema initialization failed'); assert(await dbConnection.initialize());
  const pool = dbConnection.getPool()!;
  async function user() {
    const [created] = await pool.execute("INSERT INTO users (username,password_hash,status) VALUES (?, 'not-a-login', 'active')", [`retrieval-${randomUUID()}`]) as any;
    return actorContextService.loadActiveActor(Number(created.insertId));
  }
  const actor = await user(); const other = await user();
  const session = await chatDatabaseService.createSession(actor, { title: 'Retrieval qualification' });
  const otherSession = await chatDatabaseService.createSession(other, { title: 'Private foreign memory' });
  const text = 'Production MySQL backups retain fourteen days.';
  pipeline = new MemoryPipeline(new StructuredMemoryStore(join(workspace, 'structured-memory')), { extract: async inputs => ({ candidates: inputs.filter(s => s.content === text).map(s => ({ kind: 'constraint', subject: 'MySQL backup retention', content: s.content, sources: [{ id: s.id, hash: s.hash, quote: s.content }], confidence: 1, operation: 'new' })), usage: { prompt_tokens: 20, completion_tokens: 10 } }) },
    async (scope, ids) => canonicalStore.getCommittedMemoryInputs(Number(scope.actorId), scope.sessionId, ids), true);
  async function seed(owner: typeof actor, sessionId: string) {
    const run = (await agentRunService.claim(owner.userId, sessionId, randomUUID(), randomUUID())).run;
    const sourceId = `run_${run.id}_user`;
    await chatDatabaseService.addMessage(owner, sessionId, { messageId: sourceId, role: 'user', content: text });
    await agentRunService.complete(run, { type: 'complete', finalContent: 'Acknowledged.', stopReason: 'completed' });
    const scope = { workspaceId: 'retrieval-qualification', actorId: String(owner.userId), sessionId };
    const inputs = await canonicalStore.getCommittedMemoryInputs(owner.userId, sessionId, [sourceId]);
    const job = await pipeline!.run({ scope, boundary: run.id, completed: true, messages: inputs.map(s => ({ id: s.id, content: s.content, role: 'user', source: 'fact', timestamp: '2026-09-30' })) });
    assert.equal(job?.state, 'succeeded'); return { scope, sourceId, record: (await pipeline!.list(scope))[0] };
  }
  const own = await seed(actor, session.session_id); const foreign = await seed(other, otherSession.session_id);
  // Chat completions may still maintain memory, but this controlled provider is never the extractor.
  const response = { content: 'The retention reference is available.', finishReason: 'stop' as const, toolCalls: [], usage: { prompt_tokens: 100, completion_tokens: 10 }, shouldExecuteTools: false, hasToolCalls: false };
  const provider: LLMProvider = { getDefaultModel: () => 'controlled-retrieval', chat: async messages => { providerRequests.push(structuredClone(messages)); return response; },
    chatStream: async (messages, _tools, callbacks) => { providerRequests.push(structuredClone(messages)); await callbacks.onContentDelta(response.content); return response; } };
  adapter = new DirectAdapter({ workspace, tools: new ToolRegistry(), llmProvider: provider, memoryWorkspaceId: 'retrieval-qualification', memoryPipeline: pipeline, memoryRetrievalLimits: { maxCount: 2, maxTokens: 2000 } });
  await adapter.start(); const server = (adapter as any).wsServer; if (!server.address()) await once(server, 'listening');
  const port = server.address().port;
  // The production WS sends complete before owned extraction drains. Await exact
  // message-handler promises before sending another run or modifying its sources.
  const handlers = new Set<Promise<unknown>>();
  server.on('connection', (socket: any) => {
    const handler = socket.listeners('message')[0]; socket.removeListener('message', handler);
    socket.on('message', (raw: Buffer) => {
      const work = Promise.resolve(handler.call(socket, raw)); handlers.add(work);
      void work.then(() => handlers.delete(work), () => handlers.delete(work));
    });
  });
  results.push({ scenario: 'isolated-instance-identity', pid: process.pid, port, cwd: process.cwd(), command: 'tsx memory-retrieval-mysql.ts', database, model: 'controlled-retrieval', paidProvider: false });
  async function exchange(owner: typeof actor, command: Record<string, unknown>, terminal: string) {
    const client = new WebSocket(`ws://127.0.0.1:${port}`); const events: any[] = [];
    try { return await new Promise<any[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('RETRIEVAL_WS_TIMEOUT')), 15000);
      client.on('open', () => client.send(JSON.stringify({ type: 'auth', token: signAccessToken(owner, process.env.JWT_SECRET_KEY!) })));
      client.on('error', (error: Error) => { clearTimeout(timer); reject(error); });
      client.on('close', () => { clearTimeout(timer); reject(new Error('RETRIEVAL_WS_CLOSED')); });
      client.on('message', (raw: Buffer) => {
        const event = JSON.parse(raw.toString()); events.push(event);
        if (event.type === 'auth_ok') client.send(JSON.stringify(command));
        if (terminal === 'complete' && ['error', 'protocol.error'].includes(event.type)) { clearTimeout(timer); reject(new Error('RETRIEVAL_WS_ERROR_' + (event.code ?? 'UNKNOWN'))); }
        if (event.type === terminal) { clearTimeout(timer); resolve(events); }
      });
    }); } finally { await Promise.allSettled(handlers); client.close(); }
  }
  const query = 'MySQL backup retention';
  const events = await exchange(actor, { type: 'chat.send', sessionKey: session.session_id, message: query, messageId: randomUUID(), idempotencyKey: randomUUID() }, 'complete');
  assert(events.some(e => e.type === 'auth_ok'));
  const request = providerRequests[0]; const memory = request.find(m => m.role === 'tool' && m.name === 'runtime_memory'); assert(memory);
  const reference = JSON.parse(String(memory.content).split('\n').slice(1).join('\n'));
  assert.equal(reference.records.length, 1); assert.equal(reference.records[0].id, own.record.id);
  assert.equal(reference.records[0].sources[0].id, own.sourceId); assert(memoryReferenceTokens(reference.records) <= 2000);
  assert(!JSON.stringify(request).includes(foreign.record.id)); assert(!request.filter(m => m.role === 'system').some(m => String(m.content).includes(text)));
  assert(request.some(m => m.role === 'user' && m.content === query));
  const started = events.find(e => e.type === 'run.started'); assert.equal((await agentRunService.getForActor(started.runId, actor.userId, session.session_id))?.state, 'completed');
  results.push({ scenario: 'real-JWT-MySQL-WS-chat-provider-reference', passed: true, selectedIds: reference.records.map((r: any) => r.id), sources: reference.records.flatMap((r: any) => r.sources), memoryTokensUpperBound: memoryReferenceTokens(reference.records), providerInput: request, canonical: (await canonicalStore.getPage(actor, session.session_id)).messages });
  const denied = await exchange(other, { type: 'memory.list', sessionKey: session.session_id }, 'error'); assert(!JSON.stringify(denied).includes(own.record.id));
  await pool.execute('UPDATE chat_messages SET content = ? WHERE session_id = ? AND message_id = ?', ['The previous backup statement is incorrect.', session.session_id, own.sourceId]);
  const before = providerRequests.length;
  await exchange(actor, { type: 'chat.send', sessionKey: session.session_id, message: query, messageId: randomUUID(), idempotencyKey: randomUUID() }, 'complete');
  assert(!providerRequests[before].some(m => m.name === 'runtime_memory'));
  results.push({ scenario: 'real-source-edit-and-cross-actor-denial', passed: true, providerInputAfterSourceEdit: providerRequests[before] });
  await pool.execute('DELETE FROM chat_messages WHERE session_id = ? AND message_id = ?', [session.session_id, own.sourceId]);
  const after = providerRequests.length;
  await exchange(actor, { type: 'chat.send', sessionKey: session.session_id, message: 'galactic llama', messageId: randomUUID(), idempotencyKey: randomUUID() }, 'complete');
  assert(!providerRequests[after].some(m => m.name === 'runtime_memory'));
  results.push({ scenario: 'real-source-delete-no-match-no-fulltext-fallback', passed: true });
} finally {
  await adapter?.dispose(); await pipeline?.close(); await dbConnection.close();
  await connection.query(`DROP DATABASE IF EXISTS \`${database}\``); await connection.end(); await rm(workspace, { recursive: true, force: true });
}
if (process.env.MEMORY_RETRIEVAL_MYSQL_REPORT) await writeFile(process.env.MEMORY_RETRIEVAL_MYSQL_REPORT, JSON.stringify({ schemaVersion: 1, results }, null, 2));
console.log(JSON.stringify({ results: results.map((r: any) => ({ scenario: r.scenario, passed: r.passed })) }));
