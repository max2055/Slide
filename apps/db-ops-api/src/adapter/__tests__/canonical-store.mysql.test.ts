import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { WebSocket, type WebSocketServer } from 'ws';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry, Session, checkpointFacts, migrateMessageParts, acknowledgeMessageParts, type SessionEntry, type LLMProvider } from '@slide/agent-core';
import { hydrateMessageProjection } from '@slide/agent-core/message-projection';
import { MigrationRunner } from '../../migrations/runner.js';
import { ActorContextService, signAccessToken, type ActorContext } from '../../auth/actor-context.js';
import { dbConnection } from '../../db-connection.js';
import { chatDatabaseService } from '../../chat-database-service.js';
import { CanonicalStore } from '../canonical-store.js';
import { DirectAdapter } from '../direct-adapter.js';

const port = Number(process.env.AGENT_RUN_TEST_MYSQL_PORT);
// Opt-in matches existing SQL qualifications; only a run with a real port is evidence.
describe.skipIf(!port)('T05-A canonical fact integrity with production MySQL', () => {
  const database = `canonical_integrity_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool, pool: Pool, store: CanonicalStore, actor: ActorContext, other: ActorContext;
  const cachedChat = chatDatabaseService as unknown as { pool: Pool | null };
  const priorChatPool = cachedChat.pool;
  beforeAll(async () => {
    const options = { host: '127.0.0.1', port, user: 'root', password: process.env.AGENT_RUN_TEST_MYSQL_PASSWORD ?? '', timezone: 'Z' };
    admin = mysql.createPool(options);
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...options, database, connectionLimit: 10 });
    await new MigrationRunner(pool).run();
    await pool.query("INSERT INTO users (id, username, password_hash) VALUES (7, 'fact-owner', 'not-a-login'), (8, 'other-owner', 'not-a-login')");
    const contexts = new ActorContextService(() => pool as never);
    actor = await contexts.loadActiveActor(7, 1); other = await contexts.loadActiveActor(8, 1);
    store = new CanonicalStore(() => pool as never);
  }, 60_000);
  beforeEach(async () => {
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool); cachedChat.pool = pool;
    for (const table of ['chat_session_shares', 'agent_canonical_facts', 'chat_messages', 'agent_runs', 'chat_sessions']) await pool.query(`DELETE FROM ${table}`);
    await pool.query("INSERT INTO chat_sessions (session_id, user_id, title) VALUES ('owned', 7, 'Owned'), ('other', 8, 'Other')");
    await chatDatabaseService.addMessage(actor, 'owned', { messageId: 'turn', role: 'user', content: 'inspect' });
    await chatDatabaseService.addMessage(actor, 'owned', { messageId: 'turn-2', role: 'user', content: 'second' });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); cachedChat.pool = priorChatPool; });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); } });

  function intent(): SessionEntry {
    return migrateMessageParts({ id: 'intent', role: 'assistant', content: null, source: 'fact', runId: 'run', turnId: 'turn',
      metadata: { trace: { origin: 'fixture', tags: ['one', 'two'] } }, timestamp: '2026-10-12T00:00:00.000Z',
      tool_calls: [{ id: 'call', type: 'function', function: { name: 'read', arguments: '{}' } }] }, { status: 'partial' });
  }
  const result = (): SessionEntry => ({ id: 'result', role: 'tool', content: 'durable result', name: 'read', tool_call_id: 'call', source: 'fact', runId: 'run', turnId: 'turn' });
  const append = (entries: SessionEntry[], cp = { marker: 'before' }) => store.appendToolFacts(actor, 'owned', 'turn', entries, 1, cp);
  async function rows() { return (await pool.query<RowDataPacket[]>('SELECT * FROM agent_canonical_facts ORDER BY id'))[0]; }
  async function snapshot() { return { facts: await rows(), checkpoint: (await chatDatabaseService.getSessionMetadata(actor, 'owned'))?.canonicalRuntimeCheckpoint }; }
  async function rejectUnchanged(entries: SessionEntry[]) {
    const before = await snapshot();
    await expect(append(entries, { marker: 'after' })).rejects.toThrow('CANONICAL_ID_CONFLICT');
    expect(await snapshot()).toEqual(before);
  }

  it('replays the entire payload concurrently without duplicate facts or new page identities', async () => {
    const entries = [intent(), result()]; await append(entries);
    const before = await rows();
    await Promise.all(Array.from({ length: 12 }, () => append(structuredClone(entries))));
    expect(await rows()).toEqual(before);
  });
  it('ignores JSON object member order but preserves array order', async () => {
    const entry = intent(); await append([entry]);
    const reordered = { ...entry, metadata: { trace: { tags: ['one', 'two'], origin: 'fixture' } } };
    await append([reordered]);
    reordered.metadata.trace.tags.reverse(); await rejectUnchanged([reordered]);
  });
  it.each(['metadata', 'timestamp', 'name', 'unknown-field', 'parts-text', 'parts-added', 'parts-legacy', 'parts-attempt', 'parts-request', 'parts-terminal', 'parts-tool'])('rejects same-ID %s changes atomically', async field => {
    const entry = intent(); await append([entry]); const changed = structuredClone(entry);
    if (field === 'metadata') changed.metadata = { trace: 'changed' };
    if (field === 'timestamp') changed.timestamp = '2026-10-12T00:01:00.000Z';
    if (field === 'name') changed.name = 'renamed';
    if (field === 'unknown-field') changed.extension = { changed: true };
    if (field === 'parts-text') changed.messageParts!.parts[0] = { ...changed.messageParts!.parts[0], type: 'text', text: 'different' };
    if (field === 'parts-added') changed.messageParts!.parts.push({ id: 'extra', type: 'text', text: 'different', status: 'partial', source: 'fact' });
    if (field === 'parts-legacy') changed.messageParts!.legacy.extension = 'different';
    if (field === 'parts-attempt') changed.messageParts!.attempt = 2;
    if (field === 'parts-request') changed.messageParts!.sourceRequestId = 'different';
    if (field === 'parts-terminal') changed.messageParts!.runTerminal = 'failed';
    if (field === 'parts-tool') changed.messageParts!.parts[0].tool = { toolCallId: 'call', name: 'read', phase: 'running', occurredAt: 1 };
    // Insert a new result before the conflict: both it and the checkpoint must roll back.
    await rejectUnchanged([result(), changed]);
  });
  it('promotes only partial to completed, preserving every other fact field and cursor', async () => {
    await append([intent()]); const prior = (await rows())[0];
    await append([intent(), result()], { marker: 'settled' });
    const settled = (await store.getPage(actor, 'owned')).messages.find(m => m.id === 'intent')!;
    expect(settled.messageParts!.status).toBe('completed');
    expect(settled.messageParts!.parts.every(p => p.status === 'completed')).toBe(true);
    expect(settled.metadata).toEqual(intent().metadata);
    expect((await rows())[0]).toMatchObject({ id: prior.id, turn_sequence: prior.turn_sequence, ordinal: prior.ordinal });
    await append([intent(), result()]);
    expect(await rows()).toHaveLength(2);
  });
  it('cannot modify immutable metadata even during an otherwise legal status promotion', async () => {
    await append([intent()]); const changed = intent(); changed.metadata = { changed: true };
    await rejectUnchanged([result(), changed]);
  });
  it('rejects completed to partial instead of reopening a durable fact', async () => {
    await append([intent(), result()]); await rejectUnchanged([intent()]);
  });
  it.each(['failed', 'discarded'] as const)('rejects a supplied %s terminal instead of silently converting it', async status => {
    const entry = intent(); await append([entry]); entry.messageParts!.status = status;
    await rejectUnchanged([entry]);
  });
  it('does not accept a same-ID replay under a different persisted turn', async () => {
    const entry = intent(); await append([entry]); const before = await snapshot();
    await expect(store.appendToolFacts(actor, 'owned', 'turn-2', [entry], 1, { marker: 'after' })).rejects.toThrow('CANONICAL_ID_CONFLICT');
    expect(await snapshot()).toEqual(before);
  });
  it.each(['document-durable', 'part-durable', 'part-terminal'])('rejects %s conflicts before storage normalization can erase them', async field => {
    const entry = intent(); await append([entry]);
    if (field === 'document-durable') entry.messageParts!.durable = { kind: 'mysql', reference: 'other' };
    if (field === 'part-durable') entry.messageParts!.parts[0].durable = { kind: 'checkpoint', reference: 'other' };
    if (field === 'part-terminal') entry.messageParts!.parts[0].status = 'failed';
    await rejectUnchanged([entry]);
  });
  it('persists planned to settled to persisted lifecycle data even with unchanged document status', async () => {
    const entry = intent();
    entry.messageParts!.parts[0].tool = { toolCallId: 'call', name: 'read', phase: 'planned', occurredAt: 1, args: {} };
    await append([entry]);
    const settled = structuredClone(entry);
    Object.assign(settled.messageParts!.parts[0].tool!, { phase: 'settled', occurredAt: 3, startedAt: 2, settledAt: 3, outcome: 'ok',
      preview: { kind: 'text', text: 'durable result', truncated: false } });
    // The result is not yet in this batch, so lifecycle changes must persist
    // without relying on a document-status UPDATE trigger.
    await append([settled]);
    expect((await store.getPage(actor, 'owned')).messages.find(m => m.id === 'intent')?.messageParts?.parts[0].tool).toEqual(settled.messageParts!.parts[0].tool);
    await append([settled, result()]);
    const persisted = structuredClone(settled);
    Object.assign(persisted.messageParts!.parts[0].tool!, { phase: 'persisted', occurredAt: 4, persistedAt: 4 });
    await append([persisted, result()]);
    expect((await store.getPage(actor, 'owned')).messages.find(m => m.id === 'intent')?.messageParts?.parts[0].tool).toEqual(persisted.messageParts!.parts[0].tool);
    await append([persisted, result()]);
    expect(await rows()).toHaveLength(2);
    const wrong = structuredClone(persisted); wrong.messageParts!.parts[0].tool!.preview!.text = 'replacement';
    await rejectUnchanged([wrong, result()]);
    await rejectUnchanged([settled, result()]);
  });
  it('serializes the legacy checkpoint result turn before its first commit, then accepts its equivalent projection', async () => {
    const fallback = checkpointFacts({ canonical_run_id: 'run', completedToolResults: [result()] }, 'run')[0];
    // Reproduce the actual DirectAdapter binding after checkpointFacts migration.
    fallback.messageParts!.turnId = 'run'; fallback.messageParts!.legacy.turnId = 'run'; fallback.turnId = 'turn';
    await append([intent(), fallback]);
    const persisted = (await store.getPage(actor, 'owned')).messages.find(m => m.id === 'result')!;
    expect(persisted.messageParts).toMatchObject({ turnId: 'turn', projectionMessageId: 'result', legacy: { turnId: 'turn' },
      parts: [{ sourceMessageId: 'result', generation: 'ended' }] });
    await append([intent(), persisted]);
    const conflict = structuredClone(persisted); conflict.messageParts!.legacy.metadata = { different: true };
    await rejectUnchanged([intent(), conflict]);
    const wrong = structuredClone(persisted); wrong.messageParts!.turnId = 'wrong';
    await rejectUnchanged([intent(), wrong]);
  });
  it('accepts pre-upgrade checkpoint defaults without rewriting committed legacy JSON', async () => {
    const fallback = migrateMessageParts(result(), { status: 'partial' });
    fallback.messageParts.turnId = 'run'; fallback.messageParts.legacy.turnId = 'run';
    const legacy = acknowledgeMessageParts(fallback, { status: 'completed', durable: { kind: 'checkpoint', reference: 'result' } });
    const [turns] = await pool.query<RowDataPacket[]>("SELECT id FROM chat_messages WHERE message_id = 'turn'");
    await pool.query('INSERT INTO agent_canonical_facts (session_id, message_id, turn_sequence, ordinal, entry_json) VALUES (?, ?, ?, ?, ?)',
      ['owned', 'result', turns[0].id, 10002, JSON.stringify(legacy)]);
    const before = await rows(); await append([fallback]); expect(await rows()).toEqual(before);
    const page = await store.getPage(actor, 'owned');
    expect(page.messages.find(m => m.id === 'result')?.messageParts?.legacy.turnId).toBe('turn');
    const changed = structuredClone(fallback); changed.metadata = { changed: true }; await rejectUnchanged([changed]);
  });
  it('never normalizes an arbitrary legacy turn mismatch away', async () => {
    const fallback = migrateMessageParts(result(), { status: 'partial' }); await append([fallback]);
    fallback.messageParts.legacy.turnId = 'wrong'; await rejectUnchanged([fallback]);
  });
  it('retains generating boundary identity when the projection reconstructs the document from its parts', async () => {
    const entry = migrateMessageParts({ ...intent(), messageParts: undefined }, { status: 'partial', attempt: 1, sourceRequestId: 'provider-request' });
    await append([entry, result()]);
    const reconstructed = (await store.getPage(actor, 'owned')).messages.find(m => m.id === 'intent')!;
    delete reconstructed.messageParts!.attempt; delete reconstructed.messageParts!.sourceRequestId;
    const before = await rows(); await append([reconstructed, result()]); expect(await rows()).toEqual(before);
    const wrong = structuredClone(reconstructed); wrong.messageParts!.parts[0].sourceRequestId = 'wrong';
    await rejectUnchanged([wrong, result()]);
  });
  it('rejects wrong actor, session and ordinary read share append while preserving read access', async () => {
    await append([intent()]); const before = await snapshot();
    await expect(store.appendToolFacts(other, 'owned', 'turn', [result()], 1)).rejects.toThrow('Chat session not found');
    await expect(store.appendToolFacts(actor, 'other', 'turn', [result()], 1)).rejects.toThrow('Chat session not found');
    await chatDatabaseService.grantSessionShare(actor, 'owned', other.userId, 'read');
    expect((await store.getPage(other, 'owned')).messages.some(m => m.id === 'intent')).toBe(true);
    await expect(store.appendToolFacts(other, 'owned', 'turn', [result()], 1)).rejects.toThrow('Chat session not found');
    expect(await snapshot()).toEqual(before);
  });
  it('replays after actual COMMIT acknowledgement loss and rebuilds identical history/projection from SQL', async () => {
    const lostAck = new CanonicalStore(() => ({ query: pool.query.bind(pool), getConnection: async () => {
      const connection = await pool.getConnection();
      return { query: connection.query.bind(connection), beginTransaction: () => connection.beginTransaction(),
        commit: async () => { await connection.commit(); throw new Error('COMMIT_ACK_LOST'); },
        rollback: () => connection.rollback(), release: () => connection.release() };
    } }) as never);
    const entries = [intent(), result()];
    await expect(lostAck.appendToolFacts(actor, 'owned', 'turn', entries, 1, { marker: 'committed' })).rejects.toThrow('COMMIT_ACK_LOST');
    const before = await snapshot(); await append(entries, { marker: 'committed' }); expect(await snapshot()).toEqual(before);
    const page = await store.getPage(actor, 'owned'); const cold = await new CanonicalStore(() => pool as never).getPage(actor, 'owned');
    const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
    expect(hash(cold)).toBe(hash(page));
    const session = new Session('owned'); session.appendFacts(cold.messages); session.appendFacts(cold.messages);
    expect(session.messages).toHaveLength(cold.messages.length);
    expect(hash(hydrateMessageProjection('run', cold.messages.map(m => m.messageParts!)))).toBe(hash(hydrateMessageProjection('run', page.messages.map(m => m.messageParts!))));
  });

  it('real JWT/WS tool checkpoints settle and a cold adapter resumes SQL facts without duplicate execution', async () => {
    vi.stubEnv('AGENT_WS_HOST', '127.0.0.1'); vi.stubEnv('AGENT_WS_PORT', '0'); vi.stubEnv('SLIDE_MEMORY_PIPELINE_ENABLED', 'false');
    const secret = randomUUID(); vi.stubEnv('JWT_SECRET_KEY', secret);
    const contexts = new ActorContextService(() => pool as never);
    const workspace = await mkdtemp(join(tmpdir(), 't05-a-runtime-'));
    let toolCalls = 0, requests = 0; const observed: unknown[][] = [];
    const tools = new ToolRegistry();
    tools.register({ name: 'read', description: 'Read fixture', parameters: { type: 'object', properties: {} }, readOnly: true, concurrencySafe: true, exclusive: false, execute: async () => { toolCalls++; return 'durable result'; } });
    const provider: LLMProvider = { getDefaultModel: () => 'controlled-fixture',
      getModelCapabilities: () => ({ model: 'controlled-fixture', contextWindowTokens: 200_000, preferredOutputTokens: 4096, source: 'configuration', version: 't05-a/v1' }),
      chat: async () => { throw new Error('NON_STREAMING_NOT_EXPECTED'); },
      chatStream: async (messages, _tools, callbacks) => {
        observed.push(messages); requests++;
        if (requests === 1) return { content: null, finishReason: 'tool_calls', toolCalls: ['runtime-call-1', 'runtime-call-2'].map(id => ({ id, name: 'read', arguments: {} })), hasToolCalls: true, shouldExecuteTools: true, usage: {} };
        await callbacks.onContentDelta?.('answer');
        return { content: 'answer', finishReason: 'stop', toolCalls: [], hasToolCalls: false, shouldExecuteTools: false, usage: {} };
      } };
    const adapters: DirectAdapter[] = []; const clients: WebSocket[] = [];
    const pending = new Set<Promise<void>>();
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const adapter = new DirectAdapter({ llmProvider: provider, tools, toolsForActor: () => tools, actorContextService: contexts, workspace });
        adapters.push(adapter); await adapter.start();
        const server = (adapter as unknown as { wsServer: WebSocketServer }).wsServer;
        if (!server.address()) await new Promise<void>(resolve => server.once('listening', resolve));
        const address = server.address(); if (typeof address === 'string') throw new Error('TCP_EXPECTED');
        const client = new WebSocket(`ws://127.0.0.1:${address.port}`); clients.push(client);
        const events: any[] = []; client.on('message', data => events.push(JSON.parse(data.toString())));
        await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
        const socket = [...server.clients][0]; const original = socket.listeners('message')[0] as (raw: unknown) => Promise<void>;
        socket.removeListener('message', original); socket.on('message', raw => {
          const handler = original.call(socket, raw); pending.add(handler); void handler.finally(() => pending.delete(handler));
        });
        client.send(JSON.stringify({ type: 'auth', token: signAccessToken(actor, secret) }));
        await vi.waitFor(() => expect(events.some(e => e.type === 'auth_ok')).toBe(true));
        client.send(JSON.stringify({ type: 'chat.send', sessionKey: 'owned', idempotencyKey: `runtime-${attempt}`, messageId: `request-${attempt}`, message: 'inspect' }));
        await vi.waitFor(() => expect(events.some(e => e.type === 'complete' || e.type === 'error')).toBe(true), { timeout: 10_000 });
        await Promise.all(pending);
        expect(events.find(e => e.type === 'error')).toBeUndefined();
        expect(events.find(e => e.type === 'complete')).toMatchObject({ finalContent: 'answer' });
        client.close(); await adapter.dispose(); adapters.pop();
      }
      expect(toolCalls).toBe(2); expect(await rows()).toHaveLength(3);
      expect(observed.at(-1)?.some((m: any) => m.role === 'tool' && m.content === 'durable result')).toBe(true);
      const page = await store.getPage(actor, 'owned');
      expect(page.messages.filter(m => m.role === 'tool')).toHaveLength(2);
      expect(page.messages.find(m => m.role === 'tool')?.messageParts?.status).toBe('completed');
    } finally {
      clients.forEach(client => client.terminate()); await Promise.all(pending);
      await Promise.all(adapters.map(adapter => adapter.dispose())); await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);
});
