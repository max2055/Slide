import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql, { type Pool } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, loadMigrations } from '../migrations/runner.js';
import { ChatDatabaseService } from '../chat-database-service.js';
import { MysqlInvestigationStore, InvestigationStoreError, type InvestigationAdmission } from './store.js';

const port = Number(process.env.INVESTIGATION_TEST_MYSQL_PORT ?? process.env.REPORT_TEST_MYSQL_PORT);
// Real production migrations and numeric Chat Session records; authorization
// is a trusted SQL fixture port, not the future T03 JWT/Profile implementation.
describe.skipIf(!port)('formal investigation persistence transactions', () => {
  let admin: Pool;
  let pool: Pool;
  let store: MysqlInvestigationStore;
  const database = `investigation_test_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const investigationId = randomUUID();
  const secondId = randomUUID();
  const input = (): InvestigationAdmission => ({ investigationId, actor: { kind: 'user', id: 1 },
    idempotencyKey: 'request:1', message: 'Investigate the latency', expectedVersion: 1 });

  beforeAll(async () => {
    const options = { host: '127.0.0.1', port, user: 'root',
      password: process.env.INVESTIGATION_TEST_MYSQL_PASSWORD ?? process.env.REPORT_TEST_MYSQL_PASSWORD ?? '', timezone: 'Z' };
    admin = mysql.createPool(options);
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...options, database, connectionLimit: 10 });
    await new MigrationRunner(pool).run();
    await new MigrationRunner(pool).run();
    await pool.execute("INSERT IGNORE INTO users (id, username, password_hash, email) VALUES (1, 'store-user', 'not-a-login-hash', 'store@example.invalid')");
    // SQL-backed fixture authorizer exercises the mandatory transaction hook,
    // not the still-pending T03 live actor/resource/Profile authorizer.
    await pool.query(`CREATE TABLE test_operator_grants (
      investigation_id CHAR(36) COMMENT 'Investigation', actor_kind VARCHAR(16) COMMENT 'Actor kind', actor_id BIGINT COMMENT 'Actor ID',
      PRIMARY KEY(investigation_id, actor_kind, actor_id)
    ) ENGINE=InnoDB COMMENT='Trusted test authority grants'`);
    await pool.query(`CREATE TABLE test_scope_grants (actor_id INT COMMENT 'Actor', resource_type VARCHAR(30) COMMENT 'Resource type', resource_id INT COMMENT 'Resource ID', PRIMARY KEY(actor_id, resource_type, resource_id)) ENGINE=InnoDB COMMENT='Test live resource authority'`);
    store = new MysqlInvestigationStore(() => pool, async (connection, actor, investigation, operation) => {
      for (const resource of investigation.resources) {
        const [scopes] = await connection.execute('SELECT actor_id FROM test_scope_grants WHERE actor_id = ? AND resource_type = ? AND resource_id = ? FOR SHARE',
          [actor.id, resource.type, resource.id]) as [mysql.RowDataPacket[]];
        if (!scopes.length) throw new InvestigationStoreError(operation === 'read' ? 'INVESTIGATION_NOT_FOUND' : 'INVESTIGATION_OPERATION_FORBIDDEN');
      }
      if (operation === 'create') return;
      const [grants] = await connection.execute(
        'SELECT actor_id FROM test_operator_grants WHERE investigation_id = ? AND actor_kind = ? AND actor_id = ? FOR SHARE',
        [investigation.id, actor.kind, actor.id]) as [mysql.RowDataPacket[]];
      if (!grants.length) throw new InvestigationStoreError(operation === 'read' ? 'INVESTIGATION_NOT_FOUND' : 'INVESTIGATION_OPERATION_FORBIDDEN');
    });
  });
  beforeEach(async () => {
    await pool.query('DROP TRIGGER IF EXISTS inject_admission_failure');
    for (const table of ['test_scope_grants', 'test_operator_grants', 'investigation_admission_keys', 'investigation_requests', 'investigation_resources', 'investigation_members', 'investigations', 'chat_messages', 'chat_sessions', 'outbox_events', 'workflow_jobs', 'agent_runs']) await pool.query(`DELETE FROM ${table}`);
    await pool.query("INSERT INTO test_scope_grants VALUES (1, 'instance', 1)");
    for (const id of [investigationId, secondId]) {
      await pool.execute("INSERT INTO chat_sessions (session_id, user_id, title) VALUES (?, 1, 'Existing Session')", [`session-${id}`]);
      await pool.execute("INSERT INTO investigations (id, title, goal, profile_id, profile_version, session_id, owner_kind, owner_id, scope_version) VALUES (?, 'Latency', 'Investigate latency', 'ops', 1, ?, 'user', 1, ?)", [id, `session-${id}`, 'a'.repeat(64)]);
      await pool.execute("INSERT INTO test_operator_grants VALUES (?, 'user', 1)", [id]);
    }
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); }
  });
  const all = async (table: string) => (await pool.query<mysql.RowDataPacket[]>(`SELECT * FROM ${table}`))[0];


  const createInput = () => ({ actor: { kind: 'user' as const, id: 1 }, title: 'New investigation', goal: 'Investigate latency',
    profileId: 'ops' as const, profileVersion: 1, resources: [{ type: 'instance' as const, id: 1, role: 'primary' as const }] });


  it.each([
    { actor: { kind: 'user', id: 0 } }, { title: ' ' }, { goal: 'x'.repeat(2_001) },
    { profileVersion: 0 }, { resources: [{ type: 'server', id: -1, role: 'primary' }] },
    { resources: Array.from({ length: 21 }, (_, index) => ({ type: 'instance', id: index + 1, role: 'related' })) },
  ])('rejects invalid creation before allocating a Session: %j', async change => {
    await expect(store.create({ ...createInput(), ...change } as never)).rejects.toMatchObject({ statusCode: 400 });
    expect(await all('chat_sessions')).toHaveLength(2);
  });

  it('zero-resource system investigations keep a real numeric Session owner', async () => {
    const created = await store.create({ ...createInput(), profileId: 'system', resources: [] });
    expect(created.resources).toHaveLength(0);
    expect((await all('chat_sessions')).find(row => row.session_id === created.sessionId)?.user_id).toBe(1);
    await expect(store.create({ ...createInput(), resources: [] })).rejects.toMatchObject({ statusCode: 422 });
  });

  it('all store entrances fail closed when the trusted authority port is absent', async () => {
    const missing = new MysqlInvestigationStore(() => pool, undefined as never);
    for (const action of [() => missing.create(createInput()), () => missing.detail({ kind: 'user', id: 1 }, investigationId),
      () => missing.list({ kind: 'user', id: 1 }), () => missing.patch({ kind: 'user', id: 1 }, investigationId, { expectedVersion: 1, title: 'changed' })]) {
      await expect(action()).rejects.toMatchObject({ statusCode: 403 });
    }
    expect(await all('chat_sessions')).toHaveLength(2);
  });

  it('runs the registered migration twice without changing the ledger', async () => {
    const ledger = (await pool.query<mysql.RowDataPacket[]>("SELECT * FROM app_schema_migrations WHERE migration_id = '112_investigations.sql'"))[0];
    expect(ledger).toHaveLength(1);
    expect(ledger[0].status).toBe('completed');
    await new MigrationRunner(pool).run();
    expect((await pool.query<mysql.RowDataPacket[]>("SELECT * FROM app_schema_migrations WHERE migration_id = '112_investigations.sql'"))[0]).toEqual(ledger);
  });

  it('creates an investigation and numeric-owner Session atomically', async () => {
    const created = await store.create(createInput());
    expect(created).toMatchObject({ title: 'New investigation', owner: { kind: 'user', id: 1 }, version: 1,
      resources: [{ type: 'instance', id: 1, role: 'primary' }] });
    const sessions = await all('chat_sessions');
    expect(sessions.find(row => row.session_id === created.sessionId)?.user_id).toBe(1);
  });

  it.each(['investigations', 'investigation_resources'])('creation SQL failure at %s leaves no orphan Session', async table => {
    await pool.query(`CREATE TRIGGER inject_admission_failure BEFORE INSERT ON ${table}
      FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'INJECTED_CREATION_FAILURE'`);
    await expect(store.create(createInput())).rejects.toMatchObject({ code: 'INVESTIGATION_QUEUE_UNAVAILABLE' });
    expect(await all('chat_sessions')).toHaveLength(2);
    expect(await all('investigations')).toHaveLength(2);
    expect(await all('investigation_resources')).toHaveLength(0);
  });

  it('creation authorization failure rolls back a newly allocated Session', async () => {
    const denied = new MysqlInvestigationStore(() => pool, async () => { throw new InvestigationStoreError('INVESTIGATION_OPERATION_FORBIDDEN'); });
    await expect(denied.create(createInput())).rejects.toMatchObject({ statusCode: 403 });
    expect(await all('chat_sessions')).toHaveLength(2);
  });

  it('conversion reuses original messages, rejects read-share ownership and running Runs', async () => {
    const sessionId = randomUUID();
    await pool.execute("INSERT INTO chat_sessions (session_id, user_id, title) VALUES (?, 1, 'Original')", [sessionId]);
    await pool.execute("INSERT INTO chat_messages (session_id, message_id, role, content) VALUES (?, 'original-message', 'user', 'original')", [sessionId]);
    await pool.execute("INSERT INTO agent_runs (id, actor_id, session_id, message_id, idempotency_key, state, expires_at) VALUES (?, 1, ?, 'm', 'k', 'running', DATE_ADD(NOW(), INTERVAL 1 DAY))", [randomUUID(), sessionId]);
    await expect(store.create({ ...createInput(), sessionId })).rejects.toMatchObject({ statusCode: 409 });
    await pool.query("UPDATE agent_runs SET state = 'completed'");
    await pool.execute("INSERT IGNORE INTO users (id, username, password_hash, email) VALUES (2, 'viewer', 'no-login', 'viewer@example.invalid')");
    await pool.execute('INSERT INTO chat_session_shares (session_id, granted_by, recipient_user_id) VALUES (?, 1, 2)', [sessionId]);
    await expect(store.create({ ...createInput(), actor: { kind: 'user', id: 2 }, sessionId })).rejects.toMatchObject({ statusCode: 404 });
    const created = await store.create({ ...createInput(), sessionId });
    expect(created.sessionId).toBe(sessionId);
    expect(await all('chat_messages')).toHaveLength(1);
    expect((await all('chat_messages'))[0].message_id).toBe('original-message');
    await expect(store.create({ ...createInput(), sessionId })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('FK protects referenced Sessions and transactional Chat deletion restores messages', async () => {
    const sessionId = `session-${investigationId}`;
    await pool.execute("INSERT INTO chat_messages (session_id, message_id, role, content) VALUES (?, 'retained', 'user', 'retained')", [sessionId]);
    await expect(pool.execute('DELETE FROM chat_sessions WHERE session_id = ?', [sessionId])).rejects.toThrow();
    const chat = new ChatDatabaseService(() => pool);
    await expect(chat.deleteSession({ userId: 1 } as never, sessionId)).rejects.toThrow();
    expect((await all('chat_messages'))[0].message_id).toBe('retained');
    await pool.query('UPDATE chat_sessions SET last_message_at = DATE_SUB(NOW(), INTERVAL 90 DAY)');
    await chat.deleteOldSessionsForMaintenance(30);
    expect(await all('chat_sessions')).toHaveLength(2);
  });

  it('list authorizes before total and pagination, and detail hides missing scope', async () => {
    await pool.execute("INSERT INTO investigation_resources VALUES (?, 'server', 7, 'primary')", [secondId]);
    await pool.execute('UPDATE investigations SET updated_at = DATE_ADD(NOW(), INTERVAL 1 DAY) WHERE id = ?', [secondId]);
    const scoped = store;
    const page = await scoped.list({ kind: 'user', id: 1 }, { limit: 1 });
    expect(page.total).toBe(1);
    expect(page.items.map(row => row.id)).toEqual([investigationId]);
    await expect(scoped.detail({ kind: 'user', id: 1 }, secondId)).rejects.toMatchObject({ statusCode: 404 });
    expect((await scoped.list({ kind: 'user', id: 1 }, { limit: 1, offset: 1 })).items).toHaveLength(0);
    const broken = new MysqlInvestigationStore(() => pool, async () => { throw new Error('authority unavailable'); });
    await expect(broken.list({ kind: 'user', id: 1 })).rejects.toMatchObject({ statusCode: 503 });
  });


  it('requires every persisted scope and rejects admission replay after one scope is revoked', async () => {
    await pool.execute("INSERT INTO investigation_resources VALUES (?, 'instance', 1, 'primary'), (?, 'server', 7, 'related')", [investigationId, investigationId]);
    await expect(store.detail({ kind: 'user', id: 1 }, investigationId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(store.admit(input())).rejects.toMatchObject({ statusCode: 403 });
    expect(await all('investigation_admission_keys')).toHaveLength(0);
    await pool.query("INSERT INTO test_scope_grants VALUES (1, 'server', 7)");
    const accepted = await store.admit(input());
    await pool.query("DELETE FROM test_scope_grants WHERE resource_type = 'server'");
    await expect(store.admit(input())).rejects.toMatchObject({ statusCode: 403 });
    expect((await all('investigation_requests'))[0].id).toBe(accepted.requestId);
    expect(await all('workflow_jobs')).toHaveLength(1);
  });

  it('authorizes patch before disclosing a version and preserves archive history', async () => {
    await pool.query('DELETE FROM test_operator_grants');
    await expect(store.patch({ kind: 'user', id: 1 }, investigationId, { expectedVersion: 99, title: 'unauthorized' }))
      .rejects.toMatchObject({ statusCode: 403 });
    await pool.execute("INSERT INTO test_operator_grants VALUES (?, 'user', 1)", [investigationId]);
    const archived = await store.patch({ kind: 'user', id: 1 }, investigationId, { expectedVersion: 1, lifecycle: 'archived' });
    expect(archived.problemStatus).toBe('unconfirmed');
    expect((await store.list({ kind: 'user', id: 1 }, { lifecycle: 'archived', query: 'latency', profileId: 'ops' })).total).toBe(1);
  });

  it('patch version race yields one successful update and one 409', async () => {
    const results = await Promise.allSettled(['first', 'second'].map(title => store.patch({ kind: 'user', id: 1 }, investigationId, { expectedVersion: 1, title })));
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(row => row.status === 'rejected')).toMatchObject({ reason: { statusCode: 409, code: 'VERSION_CONFLICT' } });
    expect((await store.detail({ kind: 'user', id: 1 }, investigationId)).version).toBe(2);
  });

  it('patch never closes active work or permits unverified resolved declarations', async () => {
    await store.admit(input());
    await expect(store.patch({ kind: 'user', id: 1 }, investigationId, { expectedVersion: 2, lifecycle: 'archived' }))
      .rejects.toMatchObject({ code: 'INVESTIGATION_ACTIVE_REQUEST' });
    await expect(store.patch({ kind: 'user', id: 1 }, investigationId, { expectedVersion: 2, problemStatus: 'resolved' } as never))
      .rejects.toMatchObject({ code: 'INVESTIGATION_INPUT_INVALID' });
  });


  it('composes Session creation and admission with no orphan on queue failure', async () => {
    const atomic = new MysqlInvestigationStore(() => pool, async () => {});
    const command = () => atomic.transaction(async (connection, append) => {
      const created = await atomic.createInTransaction(connection, createInput());
      return atomic.admitInTransaction(connection, append, { ...input(), investigationId: created.id });
    });
    await pool.query(`CREATE TRIGGER inject_admission_failure BEFORE INSERT ON workflow_jobs
      FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'QUEUE_FAILURE'`);
    await expect(command()).rejects.toMatchObject({ statusCode: 503 });
    expect(await all('chat_sessions')).toHaveLength(2);
    expect(await all('investigations')).toHaveLength(2);
    for (const table of ['investigation_resources', 'investigation_requests', 'investigation_admission_keys', 'workflow_jobs', 'outbox_events'])
      expect(await all(table)).toHaveLength(0);
    await pool.query('DROP TRIGGER inject_admission_failure');
    const accepted = await command();
    expect(accepted.isNew).toBe(true);
    expect(await all('chat_sessions')).toHaveLength(3);
    const retry = await atomic.transaction((connection, append) => atomic.admitInTransaction(connection, append,
      { ...input(), investigationId: accepted.acceptance.investigationId }));
    expect(retry.isNew).toBe(false);
    expect(retry.acceptance).toEqual(accepted.acceptance);
  });

  it('upgrades a pre-112 schema, reruns, and supports application rollback without deleting history', async () => {
    const prior = await mkdtemp(join(tmpdir(), 'slide-investigation-migrations-'));
    const upgradeDatabase = `inv_upgrade_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${upgradeDatabase}`);
    const upgraded = mysql.createPool({ host: '127.0.0.1', port, user: 'root',
      password: process.env.INVESTIGATION_TEST_MYSQL_PASSWORD ?? process.env.REPORT_TEST_MYSQL_PASSWORD ?? '', database: upgradeDatabase });
    try {
      for (const migration of (await loadMigrations()).filter(migration => migration.id !== '112_investigations.sql'))
        await writeFile(join(prior, migration.id), migration.sql);
      await new MigrationRunner(upgraded, prior).run();
      await upgraded.query("INSERT INTO chat_sessions (session_id, user_id, title) VALUES ('legacy-session', 1, 'legacy')");
      await upgraded.query("INSERT INTO chat_messages (session_id, message_id, role, content) VALUES ('legacy-session', 'legacy-message', 'user', 'legacy')");
      await new MigrationRunner(upgraded).run();
      await new MigrationRunner(upgraded).run();
      const upgradedStore = new MysqlInvestigationStore(() => upgraded, async () => {});
      const created = await upgradedStore.create({ ...createInput(), sessionId: 'legacy-session' });
      await upgradedStore.patch({ kind: 'user', id: 1 }, created.id, { expectedVersion: 1, lifecycle: 'archived' });
      // Application rollback retains new additive tables/constraints. Legacy
      // Chat reads remain valid; never down-drop a populated investigation.
      const legacyChat = new ChatDatabaseService(() => upgraded);
      expect((await legacyChat.authorizeSession({ userId: 1 } as never, 'legacy-session', 'read')).session_id).toBe('legacy-session');
      await expect(legacyChat.deleteSession({ userId: 1 } as never, 'legacy-session')).rejects.toThrow();
      const [messages] = await upgraded.query<mysql.RowDataPacket[]>('SELECT message_id FROM chat_messages');
      expect(messages.map(message => message.message_id)).toEqual(['legacy-message']);
      expect((await upgradedStore.detail({ kind: 'user', id: 1 }, created.id)).lifecycle).toBe('archived');
    } finally {
      await upgraded.end();
      await admin.query(`DROP DATABASE ${upgradeDatabase}`);
      await rm(prior, { recursive: true, force: true });
    }
  });

  it('100 concurrent same-key admissions produce one request, job, outbox and stable response', async () => {
    const acceptances = await Promise.all(Array.from({ length: 100 }, () => store.admit(input())));
    expect(acceptances.every(value => JSON.stringify(value) === JSON.stringify(acceptances[0]))).toBe(true);
    const accepted = acceptances[0];
    expect(accepted).toMatchObject({ investigationId, sessionId: `session-${investigationId}`, version: 2 });
    expect(await all('investigation_requests')).toHaveLength(1);
    expect(await all('workflow_jobs')).toHaveLength(1);
    expect(await all('outbox_events')).toHaveLength(1);
    expect((await all('investigation_requests'))[0]).toMatchObject({ id: accepted.requestId, job_id: accepted.jobId });
    expect((await all('workflow_jobs'))[0]).toMatchObject({ id: accepted.jobId, job_type: 'investigation.execute', state: 'queued' });
    expect((await all('workflow_jobs'))[0].payload).toEqual({ investigationId, requestId: accepted.requestId });
    expect((await all('investigation_requests'))[0].request_snapshot).toMatchObject({ sessionId: accepted.sessionId,
      profileId: 'ops', profileVersion: 1, scopeVersion: 'a'.repeat(64), actor: { kind: 'user', id: 1 } });
  });

  it.each([
    { message: 'changed payload' }, { expectedVersion: 2 }, { investigationId: secondId },
  ])('rejects same key with a different payload: %j', async change => {
    await store.admit(input());
    await expect(store.admit({ ...input(), ...change })).rejects.toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH', statusCode: 409 });
    expect(await all('workflow_jobs')).toHaveLength(1);
  });

  it('different keys racing for one Session admit only one active request', async () => {
    const results = await Promise.allSettled(Array.from({ length: 100 }, (_, index) => store.admit({ ...input(), idempotencyKey: `request:${index}` })));
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) if (result.status === 'rejected') expect(result.reason.code).toBe('INVESTIGATION_ACTIVE_REQUEST');
    expect(await all('investigation_requests')).toHaveLength(1);
    expect(await all('workflow_jobs')).toHaveLength(1);
    expect(await all('investigation_admission_keys')).toHaveLength(1);
  });

  it('rejects stale versions before accepting new work', async () => {
    await expect(store.admit({ ...input(), expectedVersion: 2 })).rejects.toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });
    expect(await all('investigation_requests')).toHaveLength(0);
    expect(await all('investigation_admission_keys')).toHaveLength(0);
  });

  it.each(['investigation_requests', 'workflow_jobs', 'outbox_events'])('rolls back every admission row when %s insertion fails', async table => {
    await pool.query(`CREATE TRIGGER inject_admission_failure BEFORE INSERT ON ${table}
      FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'INJECTED_ADMISSION_FAILURE'`);
    await expect(store.admit(input())).rejects.toMatchObject({ code: 'INVESTIGATION_QUEUE_UNAVAILABLE', statusCode: 503 });
    for (const name of ['investigation_requests', 'workflow_jobs', 'outbox_events', 'investigation_admission_keys']) expect(await all(name)).toHaveLength(0);
    expect((await all('investigations')).find(row => row.id === investigationId)).toMatchObject({ version: 1, active_request_id: null });
    await pool.query('DROP TRIGGER inject_admission_failure');
    const accepted = await store.admit(input());
    expect((await all('investigation_requests'))[0].id).toBe(accepted.requestId);
  });

  it('rechecks the authorizer on idempotent retries after a fixture grant is revoked', async () => {
    await store.admit(input());
    await pool.query('DELETE FROM test_operator_grants');
    await expect(store.admit(input())).rejects.toMatchObject({ code: 'INVESTIGATION_OPERATION_FORBIDDEN' });
    expect(await all('workflow_jobs')).toHaveLength(1);
  });

  it('preserves session uniqueness in the isolated schema', async () => {
    await expect(pool.execute('UPDATE investigations SET session_id = ? WHERE id = ?', [`session-${investigationId}`, secondId])).rejects.toThrow('Duplicate entry');
  });

  it('keeps exact key bytes and actor namespaces separate', async () => {
    const first = await store.admit(input());
    const spaced = await store.admit({ ...input(), investigationId: secondId, idempotencyKey: 'request:1 ' });
    expect(spaced.requestId).not.toBe(first.requestId);
    await pool.execute("INSERT INTO test_operator_grants VALUES (?, 'service', 1)", [secondId]);
    // A same-key request in another actor namespace gets past dedupe, but is
    // still rejected by this Session's active-request invariant.
    await expect(store.admit({ ...input(), investigationId: secondId, actor: { kind: 'service', id: 1 } }))
      .rejects.toMatchObject({ code: 'INVESTIGATION_ACTIVE_REQUEST' });
    expect(await all('investigation_requests')).toHaveLength(2);
  });

  it('fails closed if the server authorizer or pool is missing', async () => {
    await expect(new MysqlInvestigationStore(() => pool, undefined as never).admit(input()))
      .rejects.toMatchObject({ code: 'INVESTIGATION_OPERATION_FORBIDDEN' });
    await expect(new MysqlInvestigationStore(() => null, async () => {}).admit(input()))
      .rejects.toMatchObject({ code: 'INVESTIGATION_QUEUE_UNAVAILABLE' });
    expect(await all('investigation_admission_keys')).toHaveLength(0);
  });

  it('rolls back the key reservation when the investigation is missing', async () => {
    await expect(store.admit({ ...input(), investigationId: randomUUID() }))
      .rejects.toMatchObject({ code: 'INVESTIGATION_NOT_FOUND', statusCode: 404 });
    expect(await all('investigation_admission_keys')).toHaveLength(0);
  });

  it.each(['closed', 'archived'])('does not accept new work for %s investigations', async lifecycle => {
    await pool.execute('UPDATE investigations SET lifecycle = ? WHERE id = ?', [lifecycle, investigationId]);
    await expect(store.admit(input())).rejects.toMatchObject({ code: 'INVESTIGATION_OPERATION_FORBIDDEN' });
    expect(await all('workflow_jobs')).toHaveLength(0);
  });

  it.each([
    { message: '' }, { message: 'x'.repeat(2_001) }, { idempotencyKey: '' },
    { idempotencyKey: '字'.repeat(86) }, { expectedVersion: 0 }, { actor: { kind: 'user' as const, id: 0 } },
  ])('rejects invalid admission input: %j', async change => {
    await expect(store.admit({ ...input(), ...change })).rejects.toMatchObject({ code: 'INVESTIGATION_INPUT_INVALID', statusCode: 400 });
    expect(await all('investigation_admission_keys')).toHaveLength(0);
  });
});
