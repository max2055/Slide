import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql, { type Pool, type PoolOptions, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, loadMigrations } from '../migrations/runner.js';
import { ActorContextService, signAccessToken, type ActorContext } from '../auth/actor-context.js';
import { InvestigationAuthorization, provisionInvestigationServiceIdentity } from './authorization.js';
import { MysqlInvestigationBudgetLedger, type BudgetPolicy, type BudgetAdmission } from './budget-ledger.js';
import { INVESTIGATION_PROFILES } from './profiles.js';
import { InvestigationSessionBridge } from './session-bridge.js';
import { MysqlOperationalEventIngest } from './event-ingest.js';
import type { EventInput, TriggerBinding } from './trigger-policy.js';
import { OutboxService, type TransactionPool } from '../workflows/outbox-service.js';

// Real MySQL, complete formal migrations, no skip and no Provider or producer hook.
describe('T07-B durable event/admission concurrency, real MySQL', () => {
  let admin: Pool; let pool: Pool; let options: PoolOptions; let container: string | undefined;
  let actor: ActorContext; let contexts: ActorContextService; let authorization: InvestigationAuthorization;
  let bridge: InvestigationSessionBridge; let serviceId: number; let roleId: number;
  const database = `t07b_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const quota: BudgetPolicy = { currency: 'USD', maxConcurrent: 100, manualReserved: 1, maxPerResourceConcurrent: 100,
    maxAutomaticRequestsPerHour: 100, maxAutomaticTokensPerDay: 1_000_000, maxTotalTokensPerDay: 2_000_000, maxCostMicrosPerDay: 1_000_000 };
  const ledger = (change: Partial<BudgetPolicy> = {}) => new MysqlInvestigationBudgetLedger(() => pool, { ...quota, ...change });
  const binding = (change: Partial<TriggerBinding['policy']> = {}, sourceChange: Partial<Omit<TriggerBinding, 'policy'>> = {}): TriggerBinding => ({
    source: 't07b-collector', verified: true, allowedOrigins: ['collector', 'investigation_engine', 'workflow', 'user_operation'], ...sourceChange,
    policy: { id: 'latency', version: 1, domain: 'isolated-t07b-domain', actor, profileId: 'ops', profileVersion: 1,
      resources: [{ type: 'instance', id: 101, role: 'primary' }], kinds: ['failure'], threshold: 3, windowMs: 300_000,
      cooldownMs: 600_000, criticalSingle: true, reserveTokens: 100, reserveCostMicros: 100,
      prices: { input: 1_000_000, cachedInput: 1_000_000, output: 1_000_000 }, ...change } });
  const ingest = (change: Partial<TriggerBinding['policy']> = {}, service = ledger(), sourceChange: Partial<Omit<TriggerBinding, 'policy'>> = {}) =>
    new MysqlOperationalEventIngest(() => pool, binding(change, sourceChange), service, authorization, bridge);
  const event = (change: Partial<EventInput> = {}): EventInput => ({ schemaVersion: 1, sourceEventId: randomUUID(), kind: 'failure',
    subject: { kind: 'resource', resource: { type: 'instance', id: 101 } }, occurredAt: '2026-10-12T12:00:00Z', severity: 'critical',
    summary: 'Isolated read-only latency', origin: 'collector', stableErrorCode: 'TIMEOUT', callsite: 'collector.ts:read', ...change });
  const all = async (table: string) => (await pool.query<RowDataPacket[]>(`SELECT * FROM ${table}`))[0];
  const count = async (table: string) => Number((await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table}`))[0][0].n);
  const accepted = (result: BudgetAdmission) => { if (result.accepted === false) throw new Error(result.reason); return result.reservation; };
  const subject = (id: number): EventInput['subject'] => ({ kind: 'resource', resource: { type: 'instance', id } });
  const allocations = ['investigations', 'chat_sessions', 'investigation_requests', 'workflow_jobs', 'outbox_events',
    'chat_messages', 'investigation_budget_ledger', 'investigation_event_links'];
  const expireCooldown = () => pool.query("UPDATE investigation_trigger_cooldowns SET cooldown_until = '1970-01-01'");

  beforeAll(async () => {
    let port = Number(process.env.TRIGGER_TEST_MYSQL_PORT);
    if (!port) {
      container = `slide-trigger-${process.pid}-${randomUUID()}`;
      execFileSync('docker', ['run', '--detach', '--rm', '--name', container, '--env', 'MYSQL_ALLOW_EMPTY_PASSWORD=yes',
        '--publish', '127.0.0.1::3306', 'mysql:8.4'], { stdio: 'pipe' });
      port = Number(execFileSync('docker', ['port', container, '3306/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1));
    }
    options = { host: '127.0.0.1', port, user: 'root', password: container ? '' : process.env.TRIGGER_TEST_MYSQL_PASSWORD ?? '',
      timezone: 'Z', connectionLimit: 16, supportBigNumbers: true, bigNumberStrings: true };
    admin = mysql.createPool(options);
    const deadline = Date.now() + 45_000;
    for (;;) { try { await admin.query('SELECT 1'); break; } catch (error) {
      if (Date.now() > deadline) throw error; await new Promise(resolve => setTimeout(resolve, 500));
    } }
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...options, database });
    await new MigrationRunner(pool).run();
    serviceId = await new OutboxService(pool as unknown as TransactionPool).transaction(c => provisionInvestigationServiceIdentity(c, 't07b-test'));
    const [role] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO roles (name) VALUES ('t07b-readonly')"); roleId = Number(role.insertId);
    await pool.execute(`INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions
      WHERE code IN ('chat:view','instance:view','metric:view','alert:view','servers:view','network_devices:view','config:view')`, [roleId]);
    await pool.execute('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [serviceId, roleId]);
    await pool.execute("INSERT INTO database_instances (id, name, host, port, username, password_encrypted) VALUES (101, 'fixture-1', 'fixture.invalid', 3306, 'fixture', 'unused'), (102, 'fixture-2', 'fixture.invalid', 3306, 'fixture', 'unused')");
    await pool.execute("INSERT INTO servers (id, label, host, os_type, credential_type, credential_encrypted) VALUES (201, 'fixture-server', 'fixture.invalid', 'Other', 'password', 'unused')");
    await pool.execute("INSERT INTO network_devices (id, name, host) VALUES (301, 'fixture-network', 'fixture.invalid')");
    contexts = new ActorContextService(() => pool as unknown as ReturnType<NonNullable<ConstructorParameters<typeof ActorContextService>[0]>>);
    authorization = new InvestigationAuthorization(contexts); bridge = new InvestigationSessionBridge(() => pool, authorization);
  }, 120_000);
  beforeEach(async () => {
    await pool.query('DROP TRIGGER IF EXISTS event_injected_failure');
    for (const table of ['investigation_event_links', 'operational_events', 'investigation_trigger_keys', 'investigation_trigger_cooldowns',
      'investigation_budget_resources', 'investigation_budget_ledger', 'investigation_budget_domains', 'investigation_create_keys',
      'investigation_admission_keys', 'investigation_requests', 'investigation_members', 'investigation_resources', 'investigations',
      'chat_messages', 'chat_sessions', 'workflow_jobs', 'outbox_events']) await pool.query(`DELETE FROM ${table}`);
    await pool.execute("UPDATE users SET status = 'active', session_version = 1 WHERE id = ?", [serviceId]);
    await pool.execute('DELETE FROM instance_permissions WHERE user_id = ?', [serviceId]);
    await pool.execute("INSERT INTO instance_permissions (user_id, instance_id, access_level) VALUES (?, 101, 'read-only'), (?, 102, 'read-only')", [serviceId, serviceId]);
    actor = await new OutboxService(pool as unknown as TransactionPool).transaction(async c => ({
      ...await contexts.loadInvestigationActorFrom(c, serviceId, 'service', 1),
      resourceBoundary: { instanceIds: [101, 102], serverIds: [201], networkDeviceIds: [301] } }));
  });
  afterAll(async () => {
    try { await pool?.end(); if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); } }
    finally { if (container) execFileSync('docker', ['stop', '--time', '10', container], { stdio: 'pipe' }); }
  }, 30_000);

  it('10,000 unique same-fingerprint events create one open investigation and initial request/job/message/receipt', async () => {
    const port = ingest();
    let acceptedCount = 0;
    // Bounded producer concurrency; all 10,000 facts traverse the actual service.
    for (let start = 0; start < 10_000; start += 100) {
      const results = await Promise.all(Array.from({ length: 100 }, () => port.ingest(event())));
      acceptedCount += results.filter(result => result.disposition === 'accepted').length;
    }
    expect(acceptedCount).toBe(1); expect(await count('operational_events')).toBe(10_000);
    expect(await count('investigation_event_links')).toBe(10_000);
    for (const table of allocations.filter(table => table !== 'investigation_event_links')) expect(await count(table)).toBe(1);
    expect(Number((await all('investigation_trigger_keys'))[0].event_count)).toBe(10_000);
    expect((await all('agent_runs'))).toHaveLength(0);
  }, 300_000);

  it('100 exact-source retries are byte-sensitive and immutable payload conflicts never increment facts', async () => {
    const port = ingest(); const input = event({ sourceEventId: 'delivery-A' });
    const results = await Promise.all(Array.from({ length: 100 }, () => port.ingest(input)));
    expect(new Set(results.map(value => value.eventId)).size).toBe(1);
    expect(results.filter(value => !value.duplicate)).toHaveLength(1);
    await expect(port.ingest({ ...input, summary: 'changed' })).rejects.toMatchObject({ code: 'EVENT_DELIVERY_CONFLICT' });
    expect(await count('operational_events')).toBe(1);
    expect(Number((await all('investigation_trigger_keys'))[0].event_count)).toBe(1);
    const another = await port.ingest({ ...input, sourceEventId: 'delivery-a' });
    expect(another.disposition).toBe('linked'); expect(another.eventId).not.toBe(results[0].eventId);
  }, 30_000);

  it('open aggregation survives window boundaries; closed creates a new linked predecessor after cooldown', async () => {
    const port = ingest(); const first = await port.ingest(event());
    await pool.query("UPDATE investigation_trigger_keys SET window_started_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 10 MINUTE)");
    const linked = await port.ingest(event()); expect(linked.investigationId).toBe(first.investigationId);
    expect(linked.disposition).toBe('linked'); expect(await count('investigations')).toBe(1);
    // Fixture terminal owner: no mock Provider/executor acceptance claim.
    await pool.execute("UPDATE investigations SET active_request_id = NULL, lifecycle = 'closed' WHERE id = ?", [first.investigationId]);
    const held = await port.ingest(event()); expect(held.suppressionReason).toBe('COOLDOWN');
    await expireCooldown(); const next = await port.ingest(event());
    expect(next.disposition).toBe('accepted'); expect(next.investigationId).not.toBe(first.investigationId);
    expect(next.previousInvestigationId).toBe(first.investigationId);
    expect(await count('investigations')).toBe(2);
  });

  it('resources, policy versions, releases, callsites and all-required scopes never merge', async () => {
    const first = await ingest().ingest(event()); await expireCooldown();
    const v2 = await ingest({ version: 2 }).ingest(event()); await expireCooldown();
    const release = await ingest().ingest(event({ releaseId: 'release-2' })); await expireCooldown();
    const other = await ingest({ resources: [{ type: 'instance', id: 102, role: 'primary' }] }).ingest(event({ subject: subject(102) }));
    await expireCooldown(); const callsite = await ingest().ingest(event({ callsite: 'other:callsite' }));
    await expireCooldown(); const scope = await ingest({ resources: [{ type: 'instance', id: 101, role: 'primary' }, { type: 'instance', id: 102, role: 'related' }] }).ingest(event());
    expect(new Set([first, v2, release, other, callsite, scope].map(value => value.investigationId)).size).toBe(6);
    expect(await count('investigation_trigger_keys')).toBe(6);
  });

  it('threshold uses database receipt time; retries do not reach threshold and expired windows restart', async () => {
    const port = ingest(); const input = event({ severity: 'error', occurredAt: '2020-01-01T00:00:00Z' });
    expect((await port.ingest(input)).suppressionReason).toBe('BELOW_THRESHOLD');
    await port.ingest(input); expect((await port.ingest(event({ severity: 'error' }))).suppressionReason).toBe('BELOW_THRESHOLD');
    await pool.query("UPDATE investigation_trigger_keys SET window_started_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 10 MINUTE)");
    expect((await port.ingest(event({ severity: 'error' }))).suppressionReason).toBe('BELOW_THRESHOLD');
    await port.ingest(event({ severity: 'error' }));
    expect((await port.ingest(event({ severity: 'error' }))).disposition).toBe('accepted');
    expect(await count('investigation_requests')).toBe(1);
  });

  it('resource cooldown also suppresses distinct fingerprints and concurrent policy versions', async () => {
    const results = await Promise.all(Array.from({ length: 30 }, (_, index) => ingest({ version: index + 1 }).ingest(event())));
    expect(results.filter(value => value.disposition === 'accepted')).toHaveLength(1);
    expect(results.filter(value => value.suppressionReason === 'COOLDOWN')).toHaveLength(29);
    expect(await count('operational_events')).toBe(30); expect(await count('investigation_requests')).toBe(1);
  }, 30_000);

  it.each([['manual capacity', { maxConcurrent: 1, manualReserved: 1 }, 'MANUAL_CAPACITY_RESERVED'],
    ['daily tokens', { maxAutomaticTokensPerDay: 50 }, 'AUTOMATIC_DAILY_TOKENS'],
    ['daily cost', { maxCostMicrosPerDay: 50 }, 'DAILY_COST']] as const)('%s refusal persists queryable event without orphan allocations', async (_name, limits, reason) => {
    const port = ingest({}, ledger(limits)); const result = await port.ingest(event());
    expect(result.suppressionReason).toBe(reason);
    expect((await port.get(result.eventId))?.suppressionReason).toBe(reason);
    expect(await count('operational_events')).toBe(1);
    for (const table of allocations) expect(await count(table)).toBe(0);
    expect(await count('investigation_create_keys')).toBe(0); expect(await count('investigation_admission_keys')).toBe(0);
  });

  it('automatic and manual whole-execution receipts share global/resource quota without repeated reserve or active rejection', async () => {
    const service = ledger({ maxConcurrent: 2, manualReserved: 1 });
    const first = await ingest({}, service).ingest(event());
    const input = { requestId: first.requestId!, domain: binding().policy.domain, mode: 'automatic' as const, profile: INVESTIGATION_PROFILES.ops,
      reserveTokens: 100, reserveCostMicros: 100, prices: binding().policy.prices };
    const copies = await Promise.all(Array.from({ length: 100 }, () => service.reserveExecution(input)));
    expect(copies.every(result => result.accepted && result.reused)).toBe(true);
    expect(new Set(copies.map(value => accepted(value).id)).size).toBe(1); expect(await count('investigation_budget_ledger')).toBe(1);
    const reused = await new OutboxService(pool as unknown as TransactionPool).transaction(c => service.reuseExecutionInTransaction(c, input.requestId,
      { domain: input.domain, mode: input.mode, profile: input.profile }));
    expect(reused.id).toBe(accepted(copies[0]).id);
    await expect(new OutboxService(pool as unknown as TransactionPool).transaction(c => service.reuseExecutionInTransaction(c, input.requestId,
      { domain: input.domain, mode: 'manual', profile: input.profile }))).rejects.toMatchObject({ code: 'BUDGET_CONFLICT' });
    for (const change of [{ mode: 'manual' }, { reserveTokens: 99 }, { domain: 'another-domain' }])
      await expect(service.reserveExecution({ ...input, ...change } as typeof input)).rejects.toMatchObject({ code: 'BUDGET_CONFLICT' });
    await expireCooldown();
    const blocked = await ingest({ version: 2, resources: [{ type: 'instance', id: 102, role: 'primary' }] }, service).ingest(event({ subject: subject(102) }));
    expect(blocked.suppressionReason).toBe('MANUAL_CAPACITY_RESERVED');
    const manual = await bridge.create(actor, { idempotencyKey: 'manual', title: 'Manual fixture', goal: 'read only', profileId: 'ops', profileVersion: 1,
      resources: [{ type: 'instance', id: 102, role: 'primary' }] }, { idempotencyKey: 'manual', message: 'read only' });
    expect((await service.reserveExecution({ ...input, requestId: manual.acceptance!.requestId, mode: 'manual' })).accepted).toBe(true);
    const third = await ingest({ version: 3 }, service).ingest(event({ callsite: 'new-problem' }));
    expect(third.suppressionReason).toBe('GLOBAL_CONCURRENCY'); expect(await count('investigation_budget_ledger')).toBe(2);
  }, 30_000);

  it('concurrent distinct-resource admissions cannot oversell the shared global slot; refusal has no orphan', async () => {
    const service = ledger({ maxConcurrent: 1, manualReserved: 0 });
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => {
      const id = index % 2 ? 101 : 102;
      return ingest({ version: index + 1, resources: [{ type: 'instance', id, role: 'primary' }] }, service).ingest(event({ subject: subject(id) }));
    }));
    expect(results.filter(value => value.disposition === 'accepted')).toHaveLength(1);
    expect(results.filter(value => value.suppressionReason === 'GLOBAL_CONCURRENCY')).toHaveLength(10);
    expect(await count('operational_events')).toBe(20);
    for (const table of allocations) expect(await count(table)).toBe(1);
  }, 30_000);

  it('resource quota rejection after cooldown retains event and original allocation only', async () => {
    const service = ledger({ maxPerResourceConcurrent: 1 });
    await ingest({}, service).ingest(event()); await expireCooldown();
    const port = ingest({ version: 2 }, service); const result = await port.ingest(event());
    expect(result.suppressionReason).toBe('RESOURCE_CONCURRENCY');
    expect((await port.get(result.eventId))?.disposition).toBe('suppressed');
    for (const table of allocations) expect(await count(table)).toBe(1);
  });

  it('tampered receipt or allocation cannot be reused, and missing receipt never allocates', async () => {
    const first = await ingest().ingest(event());
    const consumer = () => new OutboxService(pool as unknown as TransactionPool).transaction(c => ledger().reuseExecutionInTransaction(c, first.requestId!,
      { domain: binding().policy.domain, mode: 'automatic', profile: INVESTIGATION_PROFILES.ops }));
    await pool.execute("UPDATE investigation_requests SET request_snapshot = JSON_SET(request_snapshot, '$.budgetReceipt.commandHash', ?) WHERE id = ?", ['0'.repeat(64), first.requestId]);
    await expect(consumer()).rejects.toMatchObject({ code: 'BUDGET_CONFLICT' });
    await pool.execute("UPDATE investigation_requests SET request_snapshot = JSON_REMOVE(request_snapshot, '$.budgetReceipt') WHERE id = ?", [first.requestId]);
    await expect(consumer()).rejects.toMatchObject({ code: 'BUDGET_REQUEST_INVALID' });
    expect(await count('investigation_budget_ledger')).toBe(1);
  });

  it('same policy version mutation fails closed; another source shares the same problem without choosing an actor', async () => {
    const first = await ingest().ingest(event());
    await expect(ingest({ reserveTokens: 90 }).ingest(event())).rejects.toMatchObject({ code: 'TRIGGER_POLICY_CONFLICT' });
    expect(await count('operational_events')).toBe(1);
    const linked = await ingest({}, ledger(), { source: 't07b-workflow' }).ingest(event({ origin: 'workflow' }));
    expect(linked.disposition).toBe('linked'); expect(linked.investigationId).toBe(first.investigationId);
    expect(await ingest().get(linked.eventId)).toBeNull();
  });

  it('platform components use a bounded system Profile and release-specific aggregation', async () => {
    const policy = { profileId: 'system' as const, profileVersion: 1, resources: [], component: 'isolated-api' };
    const port = ingest(policy); const subject: EventInput['subject'] = { kind: 'platform', component: 'isolated-api', releaseId: 'r1' };
    const result = await port.ingest(event({ subject, releaseId: 'r1' }));
    expect(result.disposition).toBe('accepted'); expect((await port.get(result.eventId))?.envelope.subject).toEqual(subject);
    expect((await all('investigation_budget_resources'))[0].resource_key.toString()).toMatch(/^platform:/);
    expect((await all('investigation_requests'))[0].request_snapshot.authority.resourceBoundary.instanceIds).toEqual([]);
  });

  it('hourly frequency survives known settlement and cooldown expiry', async () => {
    const service = ledger({ maxAutomaticRequestsPerHour: 1 });
    const first = await ingest({}, service).ingest(event()); const reservation = (await all('investigation_budget_ledger'))[0];
    await service.markSent(reservation.id); await service.settle(reservation.id, { inputTokens: 40, cachedInputTokens: 20, outputTokens: 10 });
    await expireCooldown();
    const second = await ingest({ version: 2 }, service).ingest(event());
    expect(first.disposition).toBe('accepted'); expect(second.suppressionReason).toBe('AUTOMATIC_FREQUENCY');
    expect(await count('investigation_requests')).toBe(1); expect((await service.read(reservation.id)).chargedTokens).toBe(50);
  });

  it('unknown usage holds nonzero allowance and receipt after service/process restart; repeated settlement is idempotent', async () => {
    const first = await ingest().ingest(event()); const reservation = (await all('investigation_budget_ledger'))[0];
    await ledger().markSent(reservation.id); await ledger().settle(reservation.id, null);
    const restored = new MysqlOperationalEventIngest(() => pool, binding(), ledger(), authorization);
    expect((await restored.get(first.eventId))?.requestId).toBe(first.requestId);
    const code = `import mysql from 'mysql2/promise';
import { MysqlInvestigationBudgetLedger } from './src/investigations/budget-ledger.ts';
import { MysqlOperationalEventIngest } from './src/investigations/event-ingest.ts';
const config = JSON.parse(process.env.T07_CHILD);
const pool = mysql.createPool(config.options);
try { const ledger = new MysqlInvestigationBudgetLedger(() => pool, config.quota); const events = new MysqlOperationalEventIngest(() => pool, config.binding, ledger); console.log(JSON.stringify({ event: await events.get(config.eventId), reservation: await ledger.read(config.reservationId) })); } finally { await pool.end(); }`;
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { encoding: 'utf8',
      env: { ...process.env, T07_CHILD: JSON.stringify({ options: { ...options, database }, quota, binding: binding(), eventId: first.eventId, reservationId: reservation.id }) } });
    const child = JSON.parse(output.trim().split('\n').at(-1)!);
    expect(child.event.requestId).toBe(first.requestId); expect(child.reservation).toMatchObject({ state: 'unknown', chargedTokens: 100, chargedCostMicros: 100, costStatus: 'unknown' });
    const attempts = await Promise.all(Array.from({ length: 20 }, () => ledger().markSent(reservation.id)));
    expect(attempts.every(value => !value.dispatchAllowed)).toBe(true);
    await Promise.all(Array.from({ length: 20 }, () => ledger().settle(reservation.id, { inputTokens: 40, cachedInputTokens: 20, outputTokens: 10 })));
    expect((await ledger().read(reservation.id)).chargedTokens).toBe(50);
  }, 30_000);

  it.each(['investigation_requests', 'chat_messages', 'workflow_jobs', 'outbox_events', 'investigation_budget_ledger', 'investigation_event_links'])('transaction fault at %s rolls back event and all allocations; same delivery recovers', async table => {
    await pool.query(`CREATE TRIGGER event_injected_failure BEFORE INSERT ON ${table} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'T07B_INJECTED'`);
    const input = event(); await expect(ingest().ingest(input)).rejects.toBeDefined();
    expect(await count('operational_events')).toBe(0); expect(await count('investigation_trigger_keys')).toBe(0);
    for (const name of allocations) expect(await count(name)).toBe(0);
    await pool.query('DROP TRIGGER event_injected_failure');
    expect((await ingest().ingest(input)).disposition).toBe('accepted');
  });

  it('all required resource scopes, live revocation and service disabled-login are enforced before admission and queries', async () => {
    const resources = [{ type: 'instance' as const, id: 101, role: 'primary' as const }, { type: 'instance' as const, id: 102, role: 'related' as const },
      { type: 'server' as const, id: 201, role: 'related' as const }, { type: 'network_device' as const, id: 301, role: 'related' as const }];
    const port = ingest({ resources });
    const original = event(); const first = await port.ingest(original); expect(first.disposition).toBe('accepted');
    expect(() => signAccessToken(actor, 'test-only-secret')).toThrow();
    await expect(contexts.loadActiveActor(serviceId)).rejects.toBeDefined();
    await pool.execute('DELETE FROM instance_permissions WHERE user_id = ? AND instance_id = 102', [serviceId]);
    expect((await port.ingest(event())).suppressionReason).toBe('AUTHORITY_DENIED');
    await expect(port.get(first.eventId)).rejects.toMatchObject({ code: 'INVESTIGATION_NOT_FOUND' });
    await expect(port.ingest(original)).rejects.toMatchObject({ code: 'INVESTIGATION_NOT_FOUND' });
    expect(await count('investigation_event_links')).toBe(1);
    await pool.execute("UPDATE users SET status = 'inactive' WHERE id = ?", [serviceId]);
    expect((await ingest({ version: 2 }).ingest(event())).suppressionReason).toBe('AUTHORITY_DENIED');
    expect(await count('investigation_requests')).toBe(1);
    const snapshot = (await all('investigation_requests'))[0].request_snapshot;
    expect(snapshot.authority.actor).toEqual({ id: serviceId, kind: 'service' });
    expect(snapshot.authority.permissions).not.toContain('*'); expect(snapshot.authority.resourceBoundary.instanceIds).toEqual([101, 102]);
  });

  it('unverified, recursive, HTTP 403 and unsupported scope facts persist without model/admission', async () => {
    for (const [port, input, reason] of [[ingest(), event({ origin: 'investigation_engine' }), 'ORIGIN_LOOP'],
      [ingest({}, ledger(), { verified: false }), event(), 'UNVERIFIED_SOURCE'],
      [ingest(), event({ httpStatus: 403 }), 'STATUS_EXCLUDED'],
      [ingest(), event({ subject: subject(102) }), 'SCOPE_UNSUPPORTED']] as const) {
      const result = await port.ingest(input); expect(result.suppressionReason).toBe(reason);
    }
    expect(await count('operational_events')).toBe(4); for (const name of allocations) expect(await count(name)).toBe(0);
  });

  it('formal fresh/repeat/pre116 upgrade and retained application rollback preserve events and unknown receipts', async () => {
    const result = await ingest().ingest(event()); const reservation = (await all('investigation_budget_ledger'))[0];
    await ledger().markSent(reservation.id); await ledger().settle(reservation.id, null);
    const before = await new MigrationRunner(pool).inspect();
    expect(before.filter(row => row.migration_id === '116_operational_events.sql')).toHaveLength(1);
    await new MigrationRunner(pool).run(); expect(await new MigrationRunner(pool).inspect()).toEqual(before);
    const directory = await mkdtemp(join(tmpdir(), 't07b-migrations-'));
    const oldDb = `${database}_upgrade`; let upgrade: Pool | undefined;
    try {
      for (const migration of (await loadMigrations()).filter(row => row.id < '116_')) await writeFile(join(directory, migration.id), migration.sql);
      // Old application reads retained schema and cannot drop/replay unknowns.
      await new MigrationRunner(pool, directory).run(); expect((await ingest().get(result.eventId))?.disposition).toBe('accepted');
      expect((await ledger().read(reservation.id)).state).toBe('unknown');
      await admin.query(`CREATE DATABASE ${oldDb}`); upgrade = mysql.createPool({ ...options, database: oldDb });
      await new MigrationRunner(upgrade, directory).run(); await new MigrationRunner(upgrade).run(); await new MigrationRunner(upgrade).run();
      expect((await new MigrationRunner(upgrade).inspect()).find(row => row.migration_id === '116_operational_events.sql')?.status).toBe('completed');
      const [columns] = await pool.query<RowDataPacket[]>(`SELECT COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME IN ('operational_events','investigation_trigger_keys','investigation_trigger_cooldowns','investigation_event_links')`, [database]);
      expect(columns.every(row => row.COLUMN_COMMENT)).toBe(true);
    } finally { await upgrade?.end(); await admin.query(`DROP DATABASE IF EXISTS ${oldDb}`); await rm(directory, { recursive: true, force: true }); }
  }, 120_000);
});
