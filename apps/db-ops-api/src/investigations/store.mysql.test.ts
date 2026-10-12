import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql, { type Pool } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { splitSqlStatements } from '../migrations/runner.js';
import { MysqlInvestigationStore, InvestigationStoreError, type InvestigationAdmission } from './store.js';

const port = Number(process.env.INVESTIGATION_TEST_MYSQL_PORT ?? process.env.REPORT_TEST_MYSQL_PORT);
// Deliberately isolated schema fixture. No production migration, Session
// creation/append or HTTP route is registered by this bounded store work.
describe.skipIf(!port)('isolated investigation admission transactions', () => {
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
    for (const sql of splitSqlStatements(readFileSync(new URL('../../sql/migrations/032_workflow_outbox_jobs.sql', import.meta.url), 'utf8'))) await pool.query(sql);
    await pool.query(`CREATE TABLE investigations (
      id CHAR(36) PRIMARY KEY, session_id VARCHAR(100) NOT NULL UNIQUE,
      profile_id VARCHAR(128) NOT NULL, profile_version BIGINT UNSIGNED NOT NULL,
      scope_version VARCHAR(128) NOT NULL, lifecycle ENUM('open','waiting','closed','archived') NOT NULL,
      version BIGINT UNSIGNED NOT NULL, active_request_id CHAR(36) NULL
    ) ENGINE=InnoDB`);
    await pool.query(`CREATE TABLE investigation_admission_keys (
      actor_kind ENUM('user','service') NOT NULL, actor_id BIGINT UNSIGNED NOT NULL,
      idempotency_key VARBINARY(255) NOT NULL, request_id CHAR(36) NULL,
      PRIMARY KEY(actor_kind, actor_id, idempotency_key)
    ) ENGINE=InnoDB`);
    await pool.query(`CREATE TABLE investigation_requests (
      id CHAR(36) PRIMARY KEY, investigation_id CHAR(36) NOT NULL,
      actor_kind ENUM('user','service') NOT NULL, actor_id BIGINT UNSIGNED NOT NULL,
      idempotency_key VARBINARY(255) NOT NULL, request_hash CHAR(64) NOT NULL,
      request_snapshot JSON NOT NULL, job_id CHAR(36) NOT NULL UNIQUE,
      accepted_version BIGINT UNSIGNED NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_request_key(actor_kind, actor_id, idempotency_key),
      FOREIGN KEY(investigation_id) REFERENCES investigations(id)
    ) ENGINE=InnoDB`);
    // SQL-backed fixture authorizer exercises the mandatory transaction hook,
    // not the still-pending T03 live actor/resource/Profile authorizer.
    await pool.query(`CREATE TABLE test_operator_grants (
      investigation_id CHAR(36), actor_kind VARCHAR(16), actor_id BIGINT,
      PRIMARY KEY(investigation_id, actor_kind, actor_id)
    ) ENGINE=InnoDB`);
    store = new MysqlInvestigationStore(() => pool, async (connection, actor, investigation) => {
      const [grants] = await connection.execute(
        'SELECT actor_id FROM test_operator_grants WHERE investigation_id = ? AND actor_kind = ? AND actor_id = ? FOR SHARE',
        [investigation.id, actor.kind, actor.id]) as [mysql.RowDataPacket[]];
      if (!grants.length) throw new InvestigationStoreError('INVESTIGATION_OPERATION_FORBIDDEN');
    });
  });
  beforeEach(async () => {
    await pool.query('DROP TRIGGER IF EXISTS inject_admission_failure');
    for (const table of ['test_operator_grants', 'investigation_requests', 'investigation_admission_keys', 'investigations', 'outbox_events', 'workflow_jobs']) await pool.query(`DELETE FROM ${table}`);
    for (const id of [investigationId, secondId]) {
      await pool.execute("INSERT INTO investigations VALUES (?, ?, 'ops', 1, 'scope-v1', 'open', 1, NULL)", [id, `session-${id}`]);
      await pool.execute("INSERT INTO test_operator_grants VALUES (?, 'user', 1)", [id]);
    }
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); }
  });
  const all = async (table: string) => (await pool.query<mysql.RowDataPacket[]>(`SELECT * FROM ${table}`))[0];

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
      profileId: 'ops', profileVersion: 1, scopeVersion: 'scope-v1', actor: { kind: 'user', id: 1 } });
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
