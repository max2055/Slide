/** Isolated real MySQL qualification. Paid extraction is opt-in and limited to one request. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dbConnection, decryptData } from '../../apps/db-ops-api/src/db-connection.js';
import { chatDatabaseService } from '../../apps/db-ops-api/src/chat-database-service.js';
import { canonicalStore } from '../../apps/db-ops-api/src/adapter/canonical-store.js';
import { agentRunService } from '../../apps/db-ops-api/src/adapter/agent-run-service.js';
import { BusinessMemoryService } from '../../apps/db-ops-api/src/adapter/memory-service.js';
import { AnthropicProvider } from '../../apps/db-ops-api/src/adapter/llm-provider.js';
import { resolveProviderConnection } from '../../apps/db-ops-api/src/llm/provider-connection.js';
import { MemoryPipeline, ProviderMemoryExtractor, StructuredMemoryStore, OpenAIProvider, ToolRegistry } from '../../packages/agent-core/src/index.js';
import { DirectAdapter } from '../../apps/db-ops-api/src/adapter/direct-adapter.js';
import type { ActorContext } from '../../apps/db-ops-api/src/auth/actor-context.js';
const require = createRequire(new URL('../../apps/db-ops-api/package.json', import.meta.url));
const mysql = require('mysql2/promise');
const database = `slide_memory_${randomUUID().replaceAll('-', '')}`;
const workspace = await mkdtemp(join(tmpdir(), 'slide-memory-qualification-'));
const originalDatabase = process.env.DB_NAME;
const connection = await mysql.createConnection({ host: process.env.DB_HOST ?? '127.0.0.1', port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_USER ?? 'root', password: process.env.DB_PASSWORD, connectTimeout: 5000 });
const results: unknown[] = [];
let pipeline: MemoryPipeline | undefined;
let adapter: DirectAdapter | undefined;
try {
  let realProvider;
  if (process.env.SLIDE_MEMORY_QUALIFY_REAL === '1') {
    // Read-only provider lookup: do not trigger credential migration in the live DB.
    assert(originalDatabase && /^[a-zA-Z0-9_]+$/.test(originalDatabase));
    const [rows] = await connection.query(`SELECT * FROM \`${originalDatabase}\`.llm_providers WHERE enabled AND is_default LIMIT 1`);
    assert(rows[0], 'No configured default provider');
    const cfg = resolveProviderConnection(rows[0], rows[0].api_key_encrypted ? decryptData(rows[0].api_key_encrypted) : null);
    realProvider = cfg.format === 'anthropic-messages' ? new AnthropicProvider(cfg)
      : new OpenAIProvider({ ...cfg, baseURL: cfg.format === 'ollama' ? cfg.baseURL!.replace(/\/+$/, '') + '/v1' : cfg.baseURL });
  }
  await connection.query(`CREATE DATABASE \`${database}\``);
  process.env.DB_NAME = database;
  process.env.JWT_SECRET_KEY = randomUUID() + randomUUID(); process.env.ENCRYPTION_KEY = randomUUID();
  const init = spawnSync('pnpm', ['--filter', 'slide-api', 'exec', 'tsx', 'init-db.ts'], { cwd: new URL('../..', import.meta.url), env: process.env, encoding: 'utf8', timeout: 120000 });
  assert.equal(init.status, 0, 'Isolated schema initialization failed');
  assert(await dbConnection.initialize()); const pool = dbConnection.getPool()!;
  const [insert] = await pool.execute("INSERT INTO users (username,password_hash,status) VALUES (?, 'not-a-login', 'active')", [`memory-${randomUUID()}`]) as any;
  const actor: ActorContext = { userId: Number(insert.insertId), username: 'memory-qualification', roles: ['viewer'], permissions: [], sessionVersion: 1, instanceScopes: {}, requestId: randomUUID() };
  const [second] = await pool.execute("INSERT INTO users (username,password_hash,status) VALUES (?, 'not-a-login', 'active')", [`memory-other-${randomUUID()}`]) as any;
  const other = { ...actor, userId: Number(second.insertId) };
  const session = await chatDatabaseService.createSession(actor, { title: 'memory qualification' });
  const claim = await agentRunService.claim(actor.userId, session.session_id, randomUUID(), randomUUID());
  const run = claim.run; const id = `run_${run.id}_user`;
  const content = 'I prefer concise Chinese replies.';
  await chatDatabaseService.addMessage(actor, session.session_id, { messageId: id, role: 'user', content });
  assert.deepEqual(await canonicalStore.getCommittedMemoryInputs(actor.userId, session.session_id, [id]), []);
  await agentRunService.complete(run, { type: 'complete', finalContent: 'Acknowledged.', stopReason: 'completed' });
  const source = await canonicalStore.getCommittedMemoryInputs(actor.userId, session.session_id, [id]); assert.equal(source.length, 1);
  assert.deepEqual(await canonicalStore.getCommittedMemoryInputs(other.userId, session.session_id, [id]), []);
  results.push({ scenario: 'real-MySQL-committed-only-actor-owned-source-snapshot', passed: true, snapshot: source });
  const controlled: any = { getDefaultModel: () => 'controlled', chat: async () => { throw new Error('Unexpected business LLM call'); } };
  const scope = { workspaceId: 'qualification', actorId: String(actor.userId), sessionId: session.session_id };
  pipeline = new MemoryPipeline(new StructuredMemoryStore(join(workspace, 'memory')), { extract: async inputs => ({ candidates: inputs.map(s => ({ kind: 'preference', subject: 'reply style', content: s.content, sources: [{ id: s.id, hash: s.hash, quote: s.content }], confidence: 1, operation: 'new' })), usage: { prompt_tokens: 10, completion_tokens: 5 } }) },
    async (_scope, ids) => canonicalStore.getCommittedMemoryInputs(actor.userId, session.session_id, ids), true);
  adapter = new DirectAdapter({ workspace, tools: new ToolRegistry(), llmProvider: controlled, memoryWorkspaceId: 'qualification', memoryPipeline: pipeline });
  await adapter.extractCompletedMemory(actor, session.session_id, run.id); await adapter.extractCompletedMemory(actor, session.session_id, run.id);
  const records = await pipeline.list(scope); assert.equal(records.length, 1); assert.equal(records[0].status, 'active');
  const memory = new BusinessMemoryService(workspace, 'qualification', async () => controlled, pipeline);
  await assert.rejects(memory.request(other, session.session_id, 'memory.list', {}), /not found/);
  await pipeline.store.share(scope, records[0].id, [String(other.userId)]);
  assert.equal((await pipeline.list({ ...scope, actorId: String(other.userId) })).length, 1);
  await pool.execute('UPDATE chat_messages SET content = ? WHERE session_id = ? AND message_id = ?', ['I now prefer English instead.', session.session_id, id]);
  assert.equal((await pipeline.list(scope))[0].status, 'uncertain');
  await pool.execute('DELETE FROM chat_messages WHERE session_id = ? AND message_id = ?', [session.session_id, id]);
  assert((await pipeline.list(scope))[0].invalidSourceIds.includes(id));
  await pipeline.store.delete(scope, records[0].id); await adapter.extractCompletedMemory(actor, session.session_id, run.id); assert.equal((await pipeline.list(scope)).length, 0);
  assert.equal((await agentRunService.getForActor(run.id, actor.userId, session.session_id))?.state, 'completed');
  results.push({ scenario: 'real-MySQL-business-entrance-replay-share-source-edit-delete-tombstone-chat-completion-preserved', passed: true });
  if (realProvider) {
    await chatDatabaseService.addMessage(actor, session.session_id, { messageId: id, role: 'user', content });
    const paid = new MemoryPipeline(new StructuredMemoryStore(join(workspace, 'paid')), new ProviderMemoryExtractor(async () => realProvider),
      async (_scope, ids) => canonicalStore.getCommittedMemoryInputs(actor.userId, session.session_id, ids), true,
      { maxProviderAttempts: 1, maxOutputTokens: 512, maxTotalTokens: 4096, deadlineMs: 15000 });
    const oldError = console.error; console.error = () => {}; // Provider errors may contain sensitive server text.
    try {
      const job = await paid.run({ scope, boundary: run.id, completed: true, messages: source.map(s => ({ ...s, role: 'user', source: 'fact', timestamp: '2026-09-30' })) });
      const output = await paid.list(scope);
      results.push({ scenario: 'limited-real-provider-one-attempt', passed: job?.state === 'succeeded' && output.length > 0, model: realProvider.getDefaultModel(), job, records: output,
        billingEvidence: 'Provider-reported tokens/request ID; invoice or monetary cost not available.' });
    } finally { await paid.close(); console.error = oldError; }
  } else results.push({ scenario: 'limited-real-provider', passed: false, reason: 'Not requested; use SLIDE_MEMORY_QUALIFY_REAL=1 with authorized provider configuration.' });
} finally {
  await adapter?.dispose(); await pipeline?.close(); await dbConnection.close();
  await connection.query(`DROP DATABASE IF EXISTS \`${database}\``); await connection.end(); await rm(workspace, { recursive: true, force: true });
}
const report = { schemaVersion: 1, results };
if (process.env.MEMORY_QUALIFICATION_REPORT) await writeFile(process.env.MEMORY_QUALIFICATION_REPORT, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ scenarios: results.map((s: any) => ({ scenario: s.scenario, passed: s.passed })) }));
