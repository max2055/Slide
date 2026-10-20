import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql, { type Pool, type PoolOptions, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadMigrations, MigrationRunner } from '../migrations/runner.js';
import { OutboxService, type TransactionConnection, type TransactionPool } from '../workflows/outbox-service.js';
import { INVESTIGATION_PROFILES, investigationProfileHash } from './profiles.js';
import { MysqlInvestigationBudgetLedger, type BudgetAdmission, type BudgetPolicy, type BudgetReservationInput } from './budget-ledger.js';

// Never skip a required real-MySQL gate. With no supplied isolated environment,
// provision a run-owned MySQL 8.4 and clean up only that exact container.
describe('durable investigation budget, real MySQL and formal migrations', () => {
  let admin: Pool;
  let pool: Pool;
  let options: PoolOptions;
  let container: string | undefined;
  const database = `budget_test_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const basePolicy: BudgetPolicy = { currency: 'USD', maxConcurrent: 4, manualReserved: 1, maxPerResourceConcurrent: 2,
    maxAutomaticRequestsPerHour: 20, maxAutomaticTokensPerDay: 1_000_000,
    maxTotalTokensPerDay: 2_000_000, maxCostMicrosPerDay: 1_000_000 };
  const ledger = (change: Partial<BudgetPolicy> = {}) => new MysqlInvestigationBudgetLedger(() => pool, { ...basePolicy, ...change });
  const count = async (table: string) => Number((await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table}`))[0][0].n);
  const accepted = (value: BudgetAdmission) => { expect(value.accepted).toBe(true); if (value.accepted === false) throw new Error(value.reason); return value.reservation; };

  beforeAll(async () => {
    let port = Number(process.env.BUDGET_TEST_MYSQL_PORT);
    if (!port) {
      container = `slide-budget-${process.pid}-${randomUUID()}`;
      execFileSync('docker', ['run', '--detach', '--rm', '--name', container, '--env', 'MYSQL_ALLOW_EMPTY_PASSWORD=yes',
        '--publish', '127.0.0.1::3306', 'mysql:8.4'], { stdio: 'pipe' });
      port = Number(execFileSync('docker', ['port', container, '3306/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1));
    }
    options = { host: '127.0.0.1', port, user: 'root', password: container ? '' : process.env.BUDGET_TEST_MYSQL_PASSWORD ?? '', timezone: 'Z',
      connectionLimit: 16, supportBigNumbers: true, bigNumberStrings: true };
    admin = mysql.createPool(options);
    const deadline = Date.now() + 45_000;
    let connected = false;
    while (Date.now() < deadline) {
      try { await admin.query('SELECT 1'); connected = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    if (!connected) throw new Error('Isolated budget MySQL unavailable; gate has NOT passed');
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...options, database });
    await new MigrationRunner(pool).run();
    await new MigrationRunner(pool).run();
    await pool.execute("INSERT IGNORE INTO users (id, username, password_hash, email) VALUES (1, 'budget-fixture', 'not-a-login-hash', 'budget@example.invalid')");
  }, 120_000);
  beforeEach(async () => {
    await pool.query('DROP TRIGGER IF EXISTS budget_injected_failure');
    for (const table of ['investigation_budget_resources', 'investigation_budget_ledger', 'investigation_budget_domains',
      'investigation_requests', 'investigation_resources', 'investigations', 'chat_sessions']) await pool.query(`DELETE FROM ${table}`);
  });
  afterAll(async () => {
    try {
      await pool?.end();
      if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); }
    } finally {
      if (container) execFileSync('docker', ['stop', '--time', '10', container], { stdio: 'pipe' });
    }
  }, 30_000);

  // Trusted persisted request/Profile fixture. No mocked MySQL or live ACL claim:
  // production authorization remains the T03 bridge and future T04 caller's job.
  async function input(resourceIds: number[] = [1], change: Partial<BudgetReservationInput> = {}): Promise<BudgetReservationInput> {
    const investigationId = randomUUID();
    const requestId = randomUUID();
    const profile = change.profile ?? INVESTIGATION_PROFILES.ops;
    const snapshot = { profileId: profile.id, profileVersion: profile.version, authority: { profileHash: investigationProfileHash(profile) } };
    await pool.execute("INSERT INTO chat_sessions (session_id, user_id, title) VALUES (?, 1, 'Budget fixture')", [investigationId]);
    await pool.execute(`INSERT INTO investigations (id, title, goal, profile_id, profile_version, session_id, owner_kind, owner_id, scope_version)
      VALUES (?, 'Budget', 'Read only', ?, ?, ?, 'user', 1, ?)`, [investigationId, profile.id, profile.version, investigationId, 'a'.repeat(64)]);
    for (const id of resourceIds) await pool.execute("INSERT INTO investigation_resources VALUES (?, 'instance', ?, 'primary')", [investigationId, id]);
    await pool.execute(`INSERT INTO investigation_requests (id, investigation_id, actor_kind, actor_id, idempotency_key,
      request_hash, request_snapshot, job_id, accepted_version) VALUES (?, ?, 'user', 1, ?, ?, ?, ?, 1)`,
    [requestId, investigationId, requestId, 'b'.repeat(64), JSON.stringify(snapshot), randomUUID()]);
    return { requestId, operationId: 'initial', domain: 'test-security-domain', mode: 'automatic', profile,
      reserveTokens: 1_000, reserveCostMicros: 1_000, prices: { input: 1_000_000, cachedInput: 1_000_000, output: 1_000_000 }, ...change };
  }
  async function finish(service: MysqlInvestigationBudgetLedger, command: BudgetReservationInput, tokens = 600) {
    const reservation = accepted(await service.reserve(command));
    await service.markSent(reservation.id);
    return service.settle(reservation.id, { inputTokens: tokens, cachedInputTokens: 0, outputTokens: 0 });
  }

  it('persists and restores a million-token allocation without rewriting frozen authority', async () => {
    const command = await input([1], { mode: 'manual', operationId: 'unused', reserveTokens: 1000000, reserveCostMicros:1000000 });
    const before = (await pool.query<RowDataPacket[]>('SELECT request_snapshot FROM investigation_requests WHERE id=?', [command.requestId]))[0][0].request_snapshot;
    const authority = (typeof before === 'string' ? JSON.parse(before) : before).authority;
    const service = new MysqlInvestigationBudgetLedger(() => pool, basePolicy, 1000000);
    const { operationId: _unused, ...execution } = command;
    const allocation = accepted(await service.reserveExecution(execution));
    expect(allocation.reservedTokens).toBe(1000000);
    const fresh = new MysqlInvestigationBudgetLedger(() => pool, basePolicy, 1000000);
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      expect(await fresh.reuseExecutionInTransaction(connection, command.requestId, { domain:command.domain,mode:command.mode,profile:command.profile })).toEqual(allocation);
      await connection.commit();
    } finally { connection.release(); }
    const after = (await pool.query<RowDataPacket[]>('SELECT request_snapshot FROM investigation_requests WHERE id=?', [command.requestId]))[0][0].request_snapshot;
    expect((typeof after === 'string' ? JSON.parse(after) : after).authority).toEqual(authority);
    expect(command.profile.budget.maxTokens).toBe(32000);
    await service.markSent(allocation.id);
    await service.markUnknown(allocation.id);
    expect(await fresh.read(allocation.id)).toMatchObject({ state:'unknown',reservedTokens:1000000,chargedTokens:1000000 });
    await expect(ledger().reserveExecution(execution)).rejects.toThrow('BUDGET_INPUT_INVALID');
  });

  it('formal migration is registered once and repeats with unchanged ledger', async () => {
    const before = await new MigrationRunner(pool).inspect();
    expect(before.filter(row => row.migration_id === '114_investigation_budget_ledger.sql')).toHaveLength(1);
    expect(before.find(row => row.migration_id === '114_investigation_budget_ledger.sql')?.status).toBe('completed');
    const reservation = accepted(await ledger().reserve(await input()));
    await new MigrationRunner(pool).run();
    expect(await new MigrationRunner(pool).inspect()).toEqual(before);
    expect((await ledger().read(reservation.id)).chargedTokens).toBe(1_000);
    const [columns] = await pool.query<RowDataPacket[]>(`SELECT COLUMN_COMMENT FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE 'investigation_budget_%'`, [database]);
    expect(columns.length).toBeGreaterThan(20);
    expect(columns.every(row => row.COLUMN_COMMENT)).toBe(true);
  });

  it('100 concurrent same-key reservations reuse exactly one persisted allocation', async () => {
    const command = await input();
    const values = await Promise.all(Array.from({ length: 100 }, () => ledger().reserve(command)));
    expect(new Set(values.map(value => accepted(value).id)).size).toBe(1);
    expect(values.filter(value => value.accepted && !value.reused)).toHaveLength(1);
    expect(await count('investigation_budget_ledger')).toBe(1);
    expect(await count('investigation_budget_resources')).toBe(1);
  }, 30_000);

  it('100 competing requests cannot oversell automatic slots; manual capacity survives', async () => {
    const commands = await Promise.all(Array.from({ length: 100 }, (_, index) => input([index + 1])));
    const values = await Promise.all(commands.map(command => ledger().reserve(command)));
    expect(values.filter(value => value.accepted)).toHaveLength(3);
    expect(values.filter(value => value.accepted === false && value.reason === 'MANUAL_CAPACITY_RESERVED')).toHaveLength(97);
    const manual = accepted(await ledger().reserve(await input([200], { mode: 'manual' })));
    expect(manual.state).toBe('reserved');
    expect(await ledger().reserve(await input([201], { mode: 'manual' }))).toEqual({ accepted: false, reason: 'GLOBAL_CONCURRENCY' });
    expect(await count('investigation_budget_ledger')).toBe(4);
  }, 30_000);

  it('all required resources enforce concurrency, irrespective of array order', async () => {
    const service = ledger({ maxConcurrent: 20, manualReserved: 0 });
    const commands = await Promise.all(Array.from({ length: 30 }, (_, index) => input(index % 2 ? [1, 2] : [2, 1])));
    const results = await Promise.all(commands.map(command => service.reserve(command)));
    expect(results.filter(value => value.accepted)).toHaveLength(2);
    expect(results.filter(value => value.accepted === false && value.reason === 'RESOURCE_CONCURRENCY')).toHaveLength(28);
    expect(await count('investigation_budget_resources')).toBe(4);
    expect((await service.reserve(await input([3]))).accepted).toBe(true);
  });

  it('simultaneous token allocations never oversell the daily token ceiling', async () => {
    const service = ledger({ maxConcurrent: 100, manualReserved: 0, maxAutomaticRequestsPerHour: 100, maxAutomaticTokensPerDay: 3_000 });
    const commands = await Promise.all(Array.from({ length: 50 }, (_, index) => input([index + 1])));
    const results = await Promise.all(commands.map(command => service.reserve(command)));
    expect(results.filter(value => value.accepted)).toHaveLength(3);
    expect(results.filter(value => value.accepted === false && value.reason === 'AUTOMATIC_DAILY_TOKENS')).toHaveLength(47);
  });

  it('frequency counts accepted requests including pre-dispatch cancellation', async () => {
    const service = ledger({ maxAutomaticRequestsPerHour: 2 });
    for (let index = 0; index < 2; index++) await service.cancelUnsent(accepted(await service.reserve(await input())).id);
    expect(await service.reserve(await input())).toEqual({ accepted: false, reason: 'AUTOMATIC_FREQUENCY' });
    expect((await service.reserve(await input([2], { mode: 'manual' }))).accepted).toBe(true);
  });

  it('distinct sequential execution operations of one request share its hourly frequency quota', async () => {
    const service = ledger({ maxAutomaticRequestsPerHour: 1 });
    const command = await input();
    await finish(service, command, 100);
    expect((await service.reserve({ ...command, operationId: 'next' })).accepted).toBe(true);
    expect(await service.reserve(await input([2]))).toEqual({ accepted: false, reason: 'AUTOMATIC_FREQUENCY' });
  });

  it.each([
    { policy: { maxAutomaticTokensPerDay: 1_000 }, mode: 'automatic', reason: 'AUTOMATIC_DAILY_TOKENS' },
    { policy: { maxAutomaticTokensPerDay: 1_000, maxTotalTokensPerDay: 1_000 }, mode: 'manual', reason: 'TOTAL_DAILY_TOKENS' },
    { policy: { maxCostMicrosPerDay: 1_000 }, mode: 'manual', reason: 'DAILY_COST' },
  ] as const)('known settlement participates in %s limits', async ({ policy, mode, reason }) => {
    const service = ledger(policy);
    await finish(service, await input([1], { mode }), 600);
    expect(await service.reserve(await input([2], { mode }))).toEqual({ accepted: false, reason });
  });

  it('unknown dispatch cannot release tokens, money or slot and survives UTC day changes', async () => {
    const service = ledger({ maxConcurrent: 10, manualReserved: 0, maxAutomaticTokensPerDay: 1_000 });
    const command = await input();
    const reservation = accepted(await service.reserve(command));
    await service.markSent(reservation.id);
    expect(await service.settle(reservation.id, null)).toMatchObject({ state: 'unknown', chargedTokens: 1_000, chargedCostMicros: 1_000, costStatus: 'unknown', usage: null });
    expect(await service.settle(reservation.id, null)).toEqual(await service.read(reservation.id));
    await pool.execute("UPDATE investigation_budget_ledger SET budget_day = DATE_SUB(UTC_DATE(), INTERVAL 1 DAY), budget_hour = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY) WHERE id = ?", [reservation.id]);
    expect(await service.reserve(await input([2]))).toEqual({ accepted: false, reason: 'AUTOMATIC_DAILY_TOKENS' });
    await expect(service.cancelUnsent(reservation.id)).rejects.toMatchObject({ code: 'BUDGET_TRANSITION_INVALID' });
    // A trusted late provider receipt can settle, without automatically replaying.
    expect(await service.settle(reservation.id, { inputTokens: 100, cachedInputTokens: 50, outputTokens: 20 })).toMatchObject({ state: 'settled', chargedTokens: 120, chargedCostMicros: 120, costStatus: 'known' });
    expect((await service.reserve(await input([3]))).accepted).toBe(true);
  });

  it('sent but unsettled intent remains fully reserved after crossing a day', async () => {
    const service = ledger({ maxConcurrent: 1, manualReserved: 0 });
    const reservation = accepted(await service.reserve(await input()));
    await service.markSent(reservation.id);
    await pool.execute("UPDATE investigation_budget_ledger SET budget_day = DATE_SUB(UTC_DATE(), INTERVAL 1 DAY) WHERE id = ?", [reservation.id]);
    expect(await service.reserve(await input([2]))).toEqual({ accepted: false, reason: 'GLOBAL_CONCURRENCY' });
    expect(await service.read(reservation.id)).toMatchObject({ state: 'sent', chargedTokens: 1_000 });
  });

  it('missing price preserves nonzero unknown money even after known usage and a new day', async () => {
    const service = ledger({ maxCostMicrosPerDay: 1_000 });
    const result = await finish(service, await input([1], { prices: undefined }), 100);
    expect(result).toMatchObject({ state: 'settled', chargedTokens: 100, chargedCostMicros: 1_000, costStatus: 'unknown' });
    await pool.execute('UPDATE investigation_budget_ledger SET budget_day = DATE_SUB(UTC_DATE(), INTERVAL 1 DAY)');
    expect(await service.reserve(await input([2]))).toEqual({ accepted: false, reason: 'DAILY_COST' });
  });

  it('known prior-day usage does not charge the new UTC day; exact request retry stays deduped', async () => {
    const service = ledger({ maxAutomaticTokensPerDay: 1_000, maxAutomaticRequestsPerHour: 1 });
    const command = await input();
    const original = await finish(service, command, 600);
    await pool.execute("UPDATE investigation_budget_ledger SET budget_day = DATE_SUB(UTC_DATE(), INTERVAL 1 DAY), budget_hour = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)");
    expect(await service.reserve(command)).toMatchObject({ accepted: true, reused: true, reservation: { id: original.id, state: 'settled' } });
    expect((await service.reserve(await input([2]))).accepted).toBe(true);
  });

  it('100 concurrent settlement receipts deduct once and conflicting receipts fail closed', async () => {
    const service = ledger();
    const reservation = accepted(await service.reserve(await input()));
    await service.markSent(reservation.id);
    const usage = { inputTokens: 400, cachedInputTokens: 100, outputTokens: 200 };
    const results = await Promise.all(Array.from({ length: 100 }, () => ledger().settle(reservation.id, usage)));
    expect(results.every(row => row.chargedTokens === 600 && row.chargedCostMicros === 600 && row.state === 'settled')).toBe(true);
    expect(await count('investigation_budget_ledger')).toBe(1);
    await expect(service.settle(reservation.id, { ...usage, outputTokens: 201 })).rejects.toMatchObject({ code: 'BUDGET_CONFLICT' });
    expect((await service.read(reservation.id)).chargedTokens).toBe(600);
  });

  it('records real usage over the estimate without hiding overspend', async () => {
    const service = ledger({ maxAutomaticTokensPerDay: 1_000, maxCostMicrosPerDay: 1_000 });
    const result = await finish(service, await input(), 1_500);
    expect(result).toMatchObject({ chargedTokens: 1_500, chargedCostMicros: 1_500 });
    expect(await service.reserve(await input([2]))).toEqual({ accepted: false, reason: 'AUTOMATIC_DAILY_TOKENS' });
  });

  it('per-request Profile totals and provider attempts cannot reset with a new operation', async () => {
    const service = ledger();
    const command = await input();
    const first = accepted(await service.reserve(command));
    expect(await service.reserve({ ...command, operationId: 'next' })).toEqual({ accepted: false, reason: 'REQUEST_ACTIVE' });
    await service.markSent(first.id);
    await service.settle(first.id, { inputTokens: 600, cachedInputTokens: 0, outputTokens: 0 });
    expect(await service.reserve({ ...command, operationId: 'oversize', reserveTokens: 32_000, reserveCostMicros: 32_000 })).toEqual({ accepted: false, reason: 'REQUEST_TOKEN_LIMIT' });
    for (let index = 1; index < 8; index++) await finish(service, { ...command, operationId: String(index) }, 100);
    expect(await service.reserve({ ...command, operationId: 'ninth' })).toEqual({ accepted: false, reason: 'REQUEST_ATTEMPT_LIMIT' });
  });

  it('cancelling unsent is idempotent; a cancelled key never dispatches again', async () => {
    const service = ledger();
    const command = await input();
    const reservation = accepted(await service.reserve(command));
    const cancelled = await service.cancelUnsent(reservation.id);
    expect(cancelled).toMatchObject({ state: 'cancelled', chargedTokens: 0, chargedCostMicros: 0 });
    expect(await service.cancelUnsent(reservation.id)).toEqual(cancelled);
    expect(accepted(await service.reserve(command))).toEqual(cancelled);
    await expect(service.markSent(reservation.id)).rejects.toMatchObject({ code: 'BUDGET_TRANSITION_INVALID' });
    await expect(service.settle(reservation.id, null)).rejects.toMatchObject({ code: 'BUDGET_TRANSITION_INVALID' });
  });

  it('only one concurrent committed dispatch intent permits an external send', async () => {
    const reservation = accepted(await ledger().reserve(await input()));
    const intents = await Promise.all(Array.from({ length: 100 }, () => ledger().markSent(reservation.id)));
    expect(intents.filter(row => row.dispatchAllowed)).toHaveLength(1);
    expect(intents.every(row => row.state === 'sent')).toBe(true);
    await ledger().settle(reservation.id, null);
    expect(await ledger().markSent(reservation.id)).toMatchObject({ state: 'unknown', dispatchAllowed: false });
  });

  it('exact operation bytes and different request IDs do not accidentally merge', async () => {
    const service = ledger();
    const firstCommand = await input();
    const first = await finish(service, firstCommand, 100);
    const second = accepted(await service.reserve({ ...firstCommand, operationId: 'initial ' }));
    const other = accepted(await service.reserve(await input([2])));
    expect(new Set([first.id, second.id, other.id]).size).toBe(3);
  });

  it('changed request Profile, lane, domain or reservation payload cannot reuse the key', async () => {
    const service = ledger();
    const command = await input();
    await finish(service, command);
    for (const change of [{ reserveTokens: 999 }, { reserveCostMicros: 1_001 }, { mode: 'manual' as const }, { domain: 'another-domain' },
      { prices: { input: 0, cachedInput: 0, output: 0 } }]) {
      await expect(service.reserve({ ...command, ...change })).rejects.toMatchObject({ code: 'BUDGET_CONFLICT' });
    }
    await expect(service.reserve({ ...command, operationId: 'new-domain-op', domain: 'another-domain' })).rejects.toMatchObject({ code: 'BUDGET_CONFLICT' });
    await expect(service.reserve({ ...command, profile: { ...command.profile, version: 2 } })).rejects.toMatchObject({ code: 'BUDGET_REQUEST_INVALID' });
  });

  it('different frozen Profile versions remain independent while missing authority fails closed', async () => {
    const service = ledger();
    const v1 = await input([1]);
    const v2 = await input([2], { profile: { ...INVESTIGATION_PROFILES.ops, version: 2 } });
    expect(accepted(await service.reserve(v1)).id).not.toBe(accepted(await service.reserve(v2)).id);
    const missing = await input([3]);
    await pool.execute("UPDATE investigation_requests SET request_snapshot = JSON_REMOVE(request_snapshot, '$.authority') WHERE id = ?", [missing.requestId]);
    await expect(service.reserve(missing)).rejects.toMatchObject({ code: 'BUDGET_REQUEST_INVALID' });
    expect(await count('investigation_budget_ledger')).toBe(2);
  });

  it('resource ceilings come from all persisted scopes, never a caller subset', async () => {
    const service = ledger({ maxPerResourceConcurrent: 1 });
    const command = await input([1, 2]);
    await finish(service, command);
    await pool.execute("INSERT INTO investigation_resources SELECT investigation_id, 'instance', 3, 'related' FROM investigation_requests WHERE id = ?", [command.requestId]);
    await expect(service.reserve(command)).rejects.toMatchObject({ code: 'BUDGET_CONFLICT' });
    await expect(service.reserve({ ...command, operationId: 'changed-scope' })).rejects.toMatchObject({ code: 'BUDGET_CONFLICT' });
    const other = await input([2, 4]);
    accepted(await service.reserve(other));
    expect(await service.reserve(await input([4, 5]))).toEqual({ accepted: false, reason: 'RESOURCE_CONCURRENCY' });
  });

  it('zero-resource System requests consume a durable platform component quota', async () => {
    const service = ledger({ maxPerResourceConcurrent: 1 });
    const first = await input([], { profile: INVESTIGATION_PROFILES.system });
    const second = await input([], { profile: INVESTIGATION_PROFILES.system });
    accepted(await service.reserve(first));
    expect(await service.reserve(second)).toEqual({ accepted: false, reason: 'RESOURCE_CONCURRENCY' });
    expect(await count('investigation_budget_resources')).toBe(1);
  });

  it('policy loosening fails closed but original reservations can still settle', async () => {
    const command = await input();
    const reservation = accepted(await ledger().reserve(command));
    const changed = ledger({ maxConcurrent: 100 });
    await expect(changed.reserve(await input([2]))).rejects.toMatchObject({ code: 'BUDGET_POLICY_CONFLICT' });
    await changed.markSent(reservation.id);
    expect(await changed.settle(reservation.id, { inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 })).toMatchObject({ state: 'settled', chargedTokens: 1 });
  });

  it.each(['investigation_budget_ledger', 'investigation_budget_resources'])('SQL failure inserting %s rolls back entire reservation and permits retry', async table => {
    const command = await input();
    await pool.query(`CREATE TRIGGER budget_injected_failure BEFORE INSERT ON ${table} FOR EACH ROW
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BUDGET_TEST_INJECTED_FAILURE'`);
    await expect(ledger().reserve(command)).rejects.toThrow('BUDGET_TEST_INJECTED_FAILURE');
    for (const name of ['investigation_budget_domains', 'investigation_budget_ledger', 'investigation_budget_resources']) expect(await count(name)).toBe(0);
    await pool.query('DROP TRIGGER budget_injected_failure');
    expect((await ledger().reserve(command)).accepted).toBe(true);
  });

  it('settlement SQL failure retains the sent reservation and retry records one charge', async () => {
    const service = ledger();
    const reservation = accepted(await service.reserve(await input()));
    await service.markSent(reservation.id);
    await pool.query(`CREATE TRIGGER budget_injected_failure BEFORE UPDATE ON investigation_budget_ledger FOR EACH ROW
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BUDGET_TEST_INJECTED_FAILURE'`);
    const usage = { inputTokens: 100, cachedInputTokens: 0, outputTokens: 0 };
    await expect(service.settle(reservation.id, usage)).rejects.toThrow('BUDGET_TEST_INJECTED_FAILURE');
    expect(await service.read(reservation.id)).toMatchObject({ state: 'sent', chargedTokens: 1_000, chargedCostMicros: 1_000 });
    await pool.query('DROP TRIGGER budget_injected_failure');
    expect(await service.settle(reservation.id, usage)).toMatchObject({ state: 'settled', chargedTokens: 100 });
  });

  it('same transaction composition rolls back caller writes as well as the budget', async () => {
    const command = await input();
    await expect(new OutboxService(pool as unknown as TransactionPool).transaction(async connection => {
      await connection.execute('UPDATE investigations SET title = ? WHERE id = (SELECT investigation_id FROM investigation_requests WHERE id = ?)', ['changed', command.requestId]);
      accepted(await ledger().reserveInTransaction(connection, command));
      throw new Error('CALLER_ROLLBACK');
    })).rejects.toThrow('CALLER_ROLLBACK');
    expect(await count('investigation_budget_ledger')).toBe(0);
    expect((await pool.query<RowDataPacket[]>('SELECT title FROM investigations'))[0][0].title).toBe('Budget');
  });

  it('quota reads are current even after a caller establishes an older repeatable-read snapshot', async () => {
    const command = await input([1]);
    const competing = await input([2]);
    const service = ledger({ maxConcurrent: 1, manualReserved: 0 });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('SELECT * FROM investigation_budget_ledger');
      accepted(await service.reserve(competing));
      expect(await service.reserveInTransaction(connection as unknown as TransactionConnection, command)).toEqual({ accepted: false, reason: 'GLOBAL_CONCURRENCY' });
      await connection.commit();
    } finally { await connection.rollback(); connection.release(); }
  });

  it('a new process and independent pool recover unknown reservation without spending again', async () => {
    const command = await input();
    const reservation = accepted(await ledger().reserve(command));
    await ledger().markSent(reservation.id);
    await ledger().settle(reservation.id, null);
    await pool.end();
    pool = mysql.createPool({ ...options, database });
    const source = new URL('./budget-ledger.ts', import.meta.url).href;
    const script = `import mysql from 'mysql2/promise';
      const { MysqlInvestigationBudgetLedger } = await import(${JSON.stringify(source)});
      const pool = mysql.createPool(JSON.parse(process.env.BUDGET_CHILD_DB));
      try { const ledger = new MysqlInvestigationBudgetLedger(() => pool, ${JSON.stringify(basePolicy)});
        console.log(JSON.stringify(await ledger.read(${JSON.stringify(reservation.id)}))); }
      finally { await pool.end(); }`;
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      encoding: 'utf8', env: { ...process.env, BUDGET_CHILD_DB: JSON.stringify({ ...options, database }) }, timeout: 20_000,
    });
    expect(JSON.parse(output)).toMatchObject({ id: reservation.id, state: 'unknown', chargedTokens: 1_000, chargedCostMicros: 1_000 });
    expect(await ledger().reserve(command)).toMatchObject({ accepted: true, reused: true, reservation: { id: reservation.id, state: 'unknown' } });
    expect(await count('investigation_budget_ledger')).toBe(1);
  });

  it('pre114 upgrade and application rollback preserve unknown records and block destructive deletion', async () => {
    const prior = await mkdtemp(join(tmpdir(), 'budget-pre114-'));
    const upgradeDatabase = `${database}_upgrade`;
    const migrations = await loadMigrations();
    for (const migration of migrations.filter(row => row.id < '114_')) await writeFile(join(prior, migration.id), migration.sql);
    await admin.query(`CREATE DATABASE ${upgradeDatabase}`);
    const upgraded = mysql.createPool({ ...options, database: upgradeDatabase });
    try {
      await new MigrationRunner(upgraded, prior).run();
      expect((await upgraded.query<RowDataPacket[]>("SHOW TABLES LIKE 'investigation_budget_ledger'"))[0]).toHaveLength(0);
      await new MigrationRunner(upgraded).run();
      await new MigrationRunner(upgraded).run();
      const [rows] = await upgraded.query<RowDataPacket[]>("SELECT status FROM app_schema_migrations WHERE migration_id = '114_investigation_budget_ledger.sql'");
      expect(rows).toMatchObject([{ status: 'completed' }]);
      const command = await input();
      const reservation = accepted(await ledger().reserve(command));
      await ledger().markSent(reservation.id);
      await ledger().settle(reservation.id, null);
      // Application rollback uses the old runner directory on the CURRENT DB.
      await new MigrationRunner(pool, prior).run();
      expect((await ledger().read(reservation.id)).state).toBe('unknown');
      await expect(pool.execute('DELETE FROM investigation_requests WHERE id = ?', [command.requestId])).rejects.toThrow();
      await new MigrationRunner(pool).run();
      expect(accepted(await ledger().reserve(command)).id).toBe(reservation.id);
    } finally { await upgraded.end(); await admin.query(`DROP DATABASE ${upgradeDatabase}`); await rm(prior, { recursive: true, force: true }); }
  }, 120_000);

  it.each([{ reserveTokens: 0 }, { reserveCostMicros: 0 }, { operationId: '' }, { domain: '' },
    { reserveTokens: 32_001 }, { prices: { input: -1, cachedInput: 0, output: 0 } },
    { prices: { input: 2_000_000, cachedInput: 1_000_000, output: 1_000_000 } }])('invalid reservation never writes facts: %j', async change => {
    await expect(ledger().reserve({ ...await input(), ...change })).rejects.toMatchObject({ code: 'BUDGET_INPUT_INVALID' });
    expect(await count('investigation_budget_ledger')).toBe(0);
  });
});
