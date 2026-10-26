import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import mysql, { type Pool, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { MigrationRunner } from '../migrations/runner.js';
import { ActorContextService, signAccessToken, type ActorContext } from '../auth/actor-context.js';
import { createVerifyToken } from '../auth-middleware.js';
import { provisionInvestigationServiceIdentity, type AuthorityExecutor } from './authorization.js';
import { investigationBudgetConfiguration } from './session-bridge.js';
import { INVESTIGATION_PROFILES, INVESTIGATION_PROMPTS, investigationProfileHash } from './profiles.js';
import { MysqlInvestigationBudgetLedger } from './budget-ledger.js';
import { InvestigationGovernanceStore } from './governance-store.js';
import { registerInvestigationGovernanceRoutes } from './governance-routes.js';
import { INVESTIGATION_EFFECTIVE_BUDGET_KEY, InvestigationEffectiveBudgetService } from './effective-budget.js';
import { InvestigationGovernanceSchemas, type InvestigationPoliciesResponse, type InvestigationUsageResponse } from './governance-contracts.js';
import { buildClientTypes, buildOpenApiDocument } from '../contracts/generate-public-api.js';

const port = Number(process.env.AUTH_TEST_MYSQL_PORT);
// CI's real authorization qualification supplies its own isolated MySQL.
// The ordinary unit suite does not substitute for this required real gate.
describe.skipIf(!port)('T07-C real migration/ledger/JWT/TCP governance facts', () => {
  const database = `t07c_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const secret = randomUUID();
  let admin: Pool;
  let pool: Pool;
  let contexts: ActorContextService;
  let store: InvestigationGovernanceStore;
  let app: FastifyInstance;
  let address: string;
  let token: string;
  let roleId: number;
  let serviceId: number;
  let currentConfig = investigationBudgetConfiguration();
  const read = (kind = 'usage', query = '', jwt = token) => fetch(`${address}/api/investigation-${kind}${query}`, {
    headers: jwt ? { authorization: `Bearer ${jwt}` } : {},
  });
  const denied = async (status: number, kind = 'usage', jwt = token, query = '') => {
    const response = await read(kind, query, jwt);
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ error: expect.any(String) });
  };
  const grant = async (...codes: string[]) => {
    await pool.execute('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
    for (const code of codes) await pool.execute('INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE code = ?', [roleId, code]);
  };
  beforeAll(async () => {
    const options = { host: '127.0.0.1', port, user: 'root', password: process.env.AUTH_TEST_MYSQL_PASSWORD ?? '',
      timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true };
    admin = mysql.createPool(options);
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...options, database, connectionLimit: 6 });
    await new MigrationRunner(pool).run();
    await new MigrationRunner(pool).run();
    await pool.execute("INSERT IGNORE INTO permissions (code, name, resource, action) VALUES ('ai:view', 'AI settings read', 'ai', 'view')");
    await pool.execute("INSERT INTO users (id, username, password_hash) VALUES (101, 'governance-manager', 'not-a-login-hash'), (102, 'private-owner', 'not-a-login-hash')");
    const [role] = await pool.execute<ResultSetHeader>("INSERT INTO roles (name) VALUES ('t07c-reader')");
    roleId = Number(role.insertId);
    serviceId = await provisionInvestigationServiceIdentity(pool as unknown as AuthorityExecutor, 't07c');
    contexts = new ActorContextService(() => pool as never);
    store = new InvestigationGovernanceStore(() => pool, () => currentConfig, contexts,
      new InvestigationEffectiveBudgetService(() => pool, async () => ({ model: 'fixture-model', contextWindowTokens: 1_000_000,
        maxOutputTokens: 393_216, preferredOutputTokens: 393_216, source: 'configuration' }), () => '2026-10-25T00:00:00.000Z',
        () => currentConfig));
    app = Fastify();
    await registerInvestigationGovernanceRoutes(app, createVerifyToken(secret, contexts), store);
    address = await app.listen({ host: '127.0.0.1', port: 0 });
  }, 120_000);
  beforeEach(async () => {
    currentConfig = investigationBudgetConfiguration();
    await pool.execute("UPDATE users SET status = 'active', session_version = 1 WHERE id = 101");
    await pool.execute('DELETE FROM user_roles WHERE user_id = 101');
    await grant('ai:view', 'config:manage');
    await pool.execute('INSERT INTO user_roles (user_id, role_id) VALUES (101, ?)', [roleId]);
    token = signAccessToken(await contexts.loadActiveActor(101), secret);
    // Dependent facts are cleaned only inside this run-owned database.
    for (const table of ['investigation_budget_resources', 'investigation_budget_ledger', 'investigation_budget_domains',
      'investigation_requests', 'investigation_resources', 'investigations', 'chat_sessions']) await pool.execute(`DELETE FROM ${table}`);
    await pool.execute('DELETE FROM system_config WHERE config_key = ?', [INVESTIGATION_EFFECTIVE_BUDGET_KEY]);
    await pool.execute("DELETE FROM system_config WHERE config_key = 'auto_analysis_config'");
    await pool.execute('DELETE FROM audit_log_entries WHERE action = \'investigation.effective_budget.update\'');
    // Operator switches must not leak between scenarios in this process.
    for (const key of ['INVESTIGATION_OPS_AUTO_ENABLED', 'INVESTIGATION_OPS_SERVICE_USER_ID', 'INVESTIGATION_OPS_INSTANCE_IDS',
      'INVESTIGATION_OPS_SERVER_IDS', 'INVESTIGATION_OPS_NETWORK_DEVICE_IDS']) delete process.env[key];
  });
  afterAll(async () => {
    await app?.close(); await pool?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); }
  });

  async function reserve(state: 'reserved' | 'sent' | 'unknown' | 'settled' | 'cancelled', prices = true, currency = 'USD') {
    const investigation = randomUUID();
    const request = randomUUID();
    const config = investigationBudgetConfiguration();
    const domain = currency === 'USD' ? config.domain : `fixture-${currency}`;
    const ledger = new MysqlInvestigationBudgetLedger(() => pool, { ...config.policy, currency });
    await pool.execute("INSERT INTO chat_sessions (session_id, user_id, title) VALUES (?, 102, 'private-prompt-secret')", [investigation]);
    await pool.execute(`INSERT INTO investigations (id, title, goal, profile_id, profile_version, session_id, owner_kind, owner_id, scope_version)
      VALUES (?, 'private-resource-secret', 'event-request-secret', 'ops', 1, ?, 'user', 102, ?)`, [investigation, investigation, 'a'.repeat(64)]);
    // No resource rights or membership for the reader: global management is
    // explicitly distinct from resource-scoped investigation access.
    await pool.execute("INSERT INTO investigation_resources VALUES (?, 'instance', 9181, 'primary'), (?, 'server', 9182, 'related')", [investigation, investigation]);
    await pool.execute(`INSERT INTO investigation_requests (id, investigation_id, actor_kind, actor_id, idempotency_key,
      request_hash, request_snapshot, job_id, accepted_version) VALUES (?, ?, 'user', 102, ?, ?, ?, ?, 1)`,
    [request, investigation, request, 'b'.repeat(64), JSON.stringify({ profileId: 'ops', profileVersion: 1, authority: { profileHash: investigationProfileHash(INVESTIGATION_PROFILES.ops) }, secret: 'request-snapshot-secret' }), randomUUID()]);
    const allocation = await ledger.reserve({ requestId: request, operationId: 'fixture', domain, mode: 'manual',
      profile: INVESTIGATION_PROFILES.ops, reserveTokens: 1000, reserveCostMicros: 2000,
      ...(prices ? { prices: { input: 1_000_000, cachedInput: 100_000, output: 2_000_000 } } : {}) });
    // Worst-case reserve must cover all-output prices.
    expect(allocation.accepted).toBe(true);
    if (allocation.accepted === false) throw new Error(allocation.reason);
    if (state === 'cancelled') await ledger.cancelUnsent(allocation.reservation.id);
    if (['sent', 'unknown', 'settled'].includes(state)) await ledger.markSent(allocation.reservation.id);
    if (state === 'unknown') await ledger.settle(allocation.reservation.id, null);
    if (state === 'settled') await ledger.settle(allocation.reservation.id, { inputTokens: 100, cachedInputTokens: 40, outputTokens: 50 });
    return allocation.reservation.id;
  }
  async function snapshot() {
    const result: Record<string, unknown> = {};
    for (const table of ['investigation_budget_domains', 'investigation_budget_ledger', 'investigation_budget_resources',
      'investigation_requests', 'investigations', 'investigation_resources', 'chat_sessions', 'chat_messages', 'workflow_jobs', 'outbox_events', 'operational_events']) {
      result[table] = (await pool.query(`SELECT * FROM ${table}`))[0];
    }
    return result;
  }

  it('reports no production policy registration rather than fake presets; reading initializes nothing', async () => {
    const before = await snapshot();
    await grant('ai:view');
    const response = await read('policies');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('etag')).toBeNull();
    const body = await response.json() as InvestigationPoliciesResponse;
    expect(Value.Check(InvestigationGovernanceSchemas.InvestigationPoliciesResponse, body)).toBe(true);
    expect(body).toMatchObject({
      schemaVersion: 2, configurationStatus: 'not_configured', automaticAnalysisStatus: 'blocked',
      policy: { id: 'database-alert-pilot', version: 1, profileId: 'ops', source: 'database-alert-engine', readonly: true },
      masterSwitch: { source: 'defaults', status: 'defaulted', enabled: true, instanceWhitelistCount: 0 },
      investigationSwitch: { enabled: false, manualEnabled: false, legacyEnabled: false, source: 'environment' },
      serviceIdentity: { status: 'not_configured', permissionsSufficient: false, missingPermissions: [], instanceScopeSufficient: true },
      entry: { status: 'not_connected', observedReceiptCount: 0, lastObservedAt: null },
      budget: { status: 'uninitialized', quotaReached: false },
      latestOutcome: { total: 0, accepted: 0, suppressed: 0, pending: 0, unknown: 0, lastStatus: null, lastReason: null, lastAttemptAt: null },
      resourceCoverage: [
        { type: 'database', status: 'not_configured', configuredCount: 0, existingCount: 0, permittedCount: 0, typePermission: false },
        { type: 'server', status: 'not_configured', configuredCount: 0, existingCount: 0, permittedCount: 0, typePermission: false },
        { type: 'network_device', status: 'not_configured', configuredCount: 0, existingCount: 0, permittedCount: 0, typePermission: false }],
    });
    expect(body.blockers.map((blocker: { code: string }) => blocker.code)).toEqual(expect.arrayContaining([
      'SERVICE_IDENTITY_NOT_CONFIGURED', 'RESOURCE_SCOPE_NOT_CONFIGURED', 'INVESTIGATION_SWITCH_DISABLED', 'BUDGET_UNINITIALIZED']));
    expect(body.blockers.map((blocker: { code: string }) => blocker.code)).not.toContain('ENTRY_NOT_OBSERVED');
    expect(await snapshot()).toEqual(before);
  });
  it('separates configuration, switches, entry receipts, identity permissions and per-type coverage without writes', async () => {
    const serviceRole = Number((await pool.execute<ResultSetHeader>("INSERT INTO roles (name) VALUES ('t07c-pilot-service')"))[0].insertId);
    await pool.execute('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [serviceId, serviceRole]);
    const grantService = async (...codes: string[]) => {
      await pool.execute('DELETE FROM role_permissions WHERE role_id = ?', [serviceRole]);
      for (const code of codes)
        await pool.execute('INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE code = ?', [serviceRole, code]);
    };
    const servicePermissions = ['chat:view', 'instance:view', 'servers:view', 'network_devices:view'];
    await grantService(...servicePermissions);
    await pool.execute("INSERT INTO database_instances (id, name, host, port, username, password_encrypted) VALUES (9181, 'pilot-db', 'pilot.invalid', 3306, 'fixture', 'unused')");
    await pool.execute("INSERT INTO instance_permissions (user_id, instance_id, access_level) VALUES (?, 9181, 'read-only')", [serviceId]);
    await pool.execute(`INSERT INTO servers (id, host, label, port, os_type, credential_type, credential_encrypted, status)
      VALUES (9182, 'pilot-server.invalid', 'pilot server', 22, 'linux', 'password', 'unused', 'online')`);
    await pool.execute("INSERT INTO network_devices (id, name, host, vendor, status) VALUES (9183, 'pilot-net', 'pilot-net.invalid', 'huawei', 'online')");
    for (const [key, value] of [['INVESTIGATION_OPS_AUTO_ENABLED', 'true'], ['INVESTIGATION_OPS_SERVICE_USER_ID', String(serviceId)],
      ['INVESTIGATION_OPS_INSTANCE_IDS', '9181'], ['INVESTIGATION_OPS_SERVER_IDS', '9182'],
      ['INVESTIGATION_OPS_NETWORK_DEVICE_IDS', '9183']] as const) process.env[key] = value;
    try {
      // The master switch is the persisted total switch, not a second config.
      await pool.execute("REPLACE INTO system_config (config_key, config_value) VALUES ('auto_analysis_config', ?)", [JSON.stringify({
        enabled: true, cronExpression: '*/30 * * * *', severityLevels: ['warning', 'error', 'critical'],
        instanceWhitelist: [], timeWindowStart: '00:00', timeWindowEnd: '23:59' })]);
      await reserve('settled');
      // A real entry receipt is represented by the durable alert observation.
      await pool.execute(`INSERT INTO alerts (id, instance_id, alert_type, level, title, message, source, tags)
        VALUES (9501, 9181, 'performance', 'warning', 'pilot alert', 'fixture', 'alert-engine', ?)`,
        [JSON.stringify({ auto_analysis: { status: 'accepted', reason: null, attemptedAt: '2026-10-25T00:00:00.000Z' } })]);
      const before = await snapshot();
      const alertsBefore = (await pool.query<RowDataPacket[]>('SELECT * FROM alerts ORDER BY id'))[0];
      const response = await read('policies');
      expect(response.status).toBe(200);
      const body = await response.json() as InvestigationPoliciesResponse;
      expect(Value.Check(InvestigationGovernanceSchemas.InvestigationPoliciesResponse, body)).toBe(true);
      expect(body).toMatchObject({ configurationStatus: 'configured', automaticAnalysisStatus: 'available',
        blockers: [],
        serviceIdentity: { status: 'ready', permissionsSufficient: true, missingPermissions: [], instanceScopeSufficient: true },
        entry: { status: 'connected', observedReceiptCount: 1, lastObservedAt: '2026-10-25T00:00:00.000Z' },
        budget: { status: 'matching', quotaReached: false },
        latestOutcome: { total: 1, accepted: 1, suppressed: 0, pending: 0, unknown: 0, lastStatus: 'accepted',
          lastReason: null, lastAttemptAt: '2026-10-25T00:00:00.000Z' },
        resourceCoverage: [
          { type: 'database', status: 'covered', configuredCount: 1, existingCount: 1, permittedCount: 1, typePermission: true },
          { type: 'server', status: 'covered', configuredCount: 1, existingCount: 1, permittedCount: 1, typePermission: true },
          { type: 'network_device', status: 'covered', configuredCount: 1, existingCount: 1, permittedCount: 1, typePermission: true }] });
      expect(JSON.stringify(body)).not.toMatch(/9181|9182|9183|pilot-db|pilot-server|pilot-net|serviceUserId/);
      // The budget page shares the same entry fact rather than claiming a
      // connected trigger from configuration alone.
      expect(await (await read('budget')).json()).toMatchObject({ automaticTriggerStatus: 'connected', admissionStatus: 'matching' });
      expect(await snapshot()).toEqual(before);
      expect((await pool.query<RowDataPacket[]>('SELECT * FROM alerts ORDER BY id'))[0]).toEqual(alertsBefore);

      // Revoking live service permissions removes coverage instead of stale status.
      await grantService('chat:view', 'instance:view');
      const revoked = await (await read('policies')).json() as InvestigationPoliciesResponse;
      expect(revoked).toMatchObject({ automaticAnalysisStatus: 'blocked',
        serviceIdentity: { status: 'ready', permissionsSufficient: false },
        resourceCoverage: [{ permittedCount: 1 }, { status: 'partial', permittedCount: 0 }, { status: 'partial', permittedCount: 0 }] });
      expect(revoked.blockers.map((blocker: { code: string }) => blocker.code)).toEqual(expect.arrayContaining([
        'SERVICE_PERMISSIONS_MISSING', 'RESOURCE_PERMISSION_MISSING']));

      // The instance grant is required even when the type permission exists.
      await grantService(...servicePermissions);
      await pool.execute('DELETE FROM instance_permissions WHERE user_id = ?', [serviceId]);
      const unscoped = await (await read('policies')).json() as InvestigationPoliciesResponse;
      expect(unscoped).toMatchObject({ serviceIdentity: { instanceScopeSufficient: false },
        resourceCoverage: [{ status: 'partial', permittedCount: 0 }, { status: 'covered' }, { status: 'covered' }] });
      expect(unscoped.blockers.map((blocker: { code: string }) => blocker.code)).toContain('RESOURCE_INSTANCE_SCOPE_MISSING');

      // A configured but unwired/missing resource is not covered.
      await pool.execute('DELETE FROM network_devices WHERE id = 9183');
      const missing = await (await read('policies')).json() as InvestigationPoliciesResponse;
      expect(missing.resourceCoverage[2]).toMatchObject({ status: 'unavailable', configuredCount: 1, existingCount: 0 });
      expect(missing.blockers.map((blocker: { code: string }) => blocker.code)).toContain('RESOURCE_UNAVAILABLE');

      // Suppressed-only receipts prove the entry fired, but never a success.
      await pool.execute('UPDATE alerts SET tags = ? WHERE id = 9501', [JSON.stringify({
        auto_analysis: { status: 'suppressed', reason: 'BUDGET_QUOTA', attemptedAt: '2026-10-25T01:00:00.000Z' } })]);
      const suppressed = await (await read('policies')).json() as InvestigationPoliciesResponse;
      expect(suppressed).toMatchObject({ entry: { status: 'connected' },
        latestOutcome: { total: 1, suppressed: 1, lastStatus: 'suppressed', lastReason: 'BUDGET_QUOTA' } });
      expect(suppressed.automaticAnalysisStatus).not.toBe('available');
    } finally {
      await pool.execute("DELETE FROM system_config WHERE config_key = 'auto_analysis_config'");
      await pool.execute('DELETE FROM alerts WHERE id = 9501');
      await pool.execute('DELETE FROM instance_permissions WHERE user_id = ?', [serviceId]);
      await pool.execute('DELETE FROM network_devices WHERE id = 9183');
      await pool.execute('DELETE FROM servers WHERE id = 9182');
      await pool.execute('DELETE FROM database_instances WHERE id = 9181');
      await pool.execute('DELETE FROM user_roles WHERE user_id = ?', [serviceId]);
      await pool.execute('DELETE FROM roles WHERE id = ?', [serviceRole]);
    }
  });
  it('reads the existing effective loader and marks uninitialized/matching/conflict without writes', async () => {
    let response = await read('budget');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ policy: currentConfig.policy, reserveCostMicros: currentConfig.reserveCostMicros,
      persistedPolicy: null, admissionStatus: 'uninitialized', automaticTriggerStatus: 'not_connected' });
    expect(Number((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM investigation_budget_domains'))[0][0].n)).toBe(0);
    await reserve('settled');
    const before = await snapshot();
    response = await read('budget');
    const body = await response.json();
    expect(Value.Check(InvestigationGovernanceSchemas.InvestigationBudgetResponse, body)).toBe(true);
    expect(body).toMatchObject({ policy: currentConfig.policy, persistedPolicy: currentConfig.policy, admissionStatus: 'matching' });
    currentConfig = { ...currentConfig, policy: { ...currentConfig.policy, maxConcurrent: 5 } };
    expect(await (await read('budget')).json()).toMatchObject({ policy: currentConfig.policy, admissionStatus: 'conflict', persistedPolicy: { maxConcurrent: 4 } });
    expect(await snapshot()).toEqual(before);
  });
  it('returns durable five-state facts, unknown allowances, inclusive cached tokens and estimated costs, with no read-side writes', async () => {
    // Settle/release first to respect the REAL shared resource concurrency=2.
    await reserve('settled'); await reserve('cancelled'); await reserve('settled', false);
    await reserve('unknown'); await reserve('sent');
    // The third active row needs its own resource footprint; use a second domain
    // but quotas are per domain as designed.
    await reserve('reserved', true, 'EUR');
    const before = await snapshot();
    const response = await read();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json() as InvestigationUsageResponse;
    expect([...Value.Errors(InvestigationGovernanceSchemas.InvestigationUsageResponse, body)]).toEqual([]);
    expect(body).toMatchObject({ total: 6, counts: { reserved: 1, sent: 1, settled: 2, unknown: 1, cancelled: 1 },
      knownUsageCount: 2, unknownUsageCount: 1, pendingUsageCount: 1, reservedTokens: 6000, outstandingTokens: 3000, settledTokens: 300 });
    expect(body.costs).toEqual([{ currency: 'EUR', reservedCostMicros: 2000, outstandingCostMicros: 2000, estimatedSettledCostMicros: 0 },
      { currency: 'USD', reservedCostMicros: 10000, outstandingCostMicros: 6000, estimatedSettledCostMicros: 164 }]);
    expect(body.items.find(row => row.state === 'unknown')).toMatchObject({ knownUsageCount: 0, unknownUsageCount: 1,
      outstandingTokens: 1000, outstandingCostMicros: 2000, estimatedSettledCostMicros: 0, unknownCostCount: 1 });
    expect(body.items.find(row => row.state === 'settled')).toMatchObject({ knownUsageCount: 2, unknownCostCount: 1,
      knownInputTokens: 200, knownCachedInputTokens: 80, knownOutputTokens: 100, settledTokens: 300,
      outstandingCostMicros: 2000, estimatedSettledCostMicros: 164 });
    expect(body.items.find(row => row.state === 'cancelled')).toMatchObject({ knownUsageCount: 0, unknownUsageCount: 0,
      outstandingTokens: 0, outstandingCostMicros: 0, estimatedSettledCostMicros: 0 });
    expect(body.items.find(row => row.state === 'sent')).toMatchObject({ pendingUsageCount: 1, knownUsageCount: 0 });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/private-owner|private-prompt-secret|private-resource-secret|event-request-secret|request-snapshot-secret|9181|9182|actor|password|operationId|domain_key|investigationId|requestId|reservationId/);
    for (const prompt of Object.values(INVESTIGATION_PROMPTS)) expect(serialized).not.toContain(prompt);
    await read('policies'); await read('budget'); await read('usage', '?limit=1&offset=1');
    expect(await snapshot()).toEqual(before);
    // A new read service instance recovers exclusively from durable facts.
    const actor = await contexts.loadActiveActor(101);
    expect(await new InvestigationGovernanceStore(() => pool, () => currentConfig, contexts).usage(actor)).toEqual(body);
  });
  it('paginates only after management authorization; totals are not page counts', async () => {
    await reserve('settled'); await reserve('cancelled'); await reserve('settled');
    const first = await (await read('usage', '?limit=1')).json() as InvestigationUsageResponse;
    const second = await (await read('usage', '?limit=1&offset=1')).json() as InvestigationUsageResponse;
    expect(first.total).toBe(3); expect(second.total).toBe(3);
    expect(first.items).toHaveLength(1); expect(second.items).toHaveLength(1);
    expect(first.items[0].state).not.toBe(second.items[0].state);
    expect(first.groupCount).toBe(2);
    expect(first.nextOffset).toBe(1); expect(second.nextOffset).toBeNull();
    expect(await (await read('usage', '?offset=3')).json()).toMatchObject({ total: 3, items: [], nextOffset: null });
    await grant('ai:view', 'config:view');
    await denied(403, 'usage', token, '?limit=1&offset=1'); await denied(403, 'budget');
    await grant('config:manage'); await denied(403); await denied(403, 'policies');
    await grant('ai:view'); await denied(403); await denied(403, 'budget');
  });
  it('revalidates live grants and the caller ceiling in the read store before any aggregation', async () => {
    await reserve('settled');
    const privileged = await contexts.loadActiveActor(101);
    await grant('ai:view');
    await expect(store.usage(privileged)).rejects.toMatchObject({ code: 'GOVERNANCE_FORBIDDEN' });
    const unprivileged = await contexts.loadActiveActor(101);
    await grant('ai:view', 'config:manage');
    await expect(store.usage(unprivileged)).rejects.toMatchObject({ code: 'GOVERNANCE_FORBIDDEN' });
    await expect(store.usage({ ...privileged, resourceBoundary: { instanceIds: [9181], serverIds: [], networkDeviceIds: [] } })).rejects.toMatchObject({ code: 'GOVERNANCE_FORBIDDEN' });
    await expect(store.usage({ ...privileged, principalKind: 'service' })).rejects.toMatchObject({ code: 'GOVERNANCE_FORBIDDEN' });
    await expect(new InvestigationGovernanceStore(() => null).usage(privileged)).rejects.toMatchObject({ code: 'GOVERNANCE_UNAVAILABLE' });
    await pool.execute("UPDATE users SET status = 'inactive' WHERE id = 101");
    await expect(store.usage(privileged)).rejects.toMatchObject({ name: 'ActorAuthenticationError' });
  });
  it('observes same-JWT revoke/restore and denies counts on permission/role removal or expiry', async () => {
    await reserve('settled'); expect((await read()).status).toBe(200);
    await grant('ai:view'); await denied(403);
    await grant('ai:view', 'config:manage'); expect((await read()).status).toBe(200);
    await pool.execute('UPDATE user_roles SET grant_expiry = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE user_id = 101'); await denied(403);
    await pool.execute('UPDATE user_roles SET grant_expiry = NULL WHERE user_id = 101');
    await pool.execute('DELETE FROM user_roles WHERE user_id = 101'); await denied(403);
  });
  it('denies invalid JWT, user disable and session version revocation with no-store', async () => {
    for (const kind of ['policies', 'budget', 'usage']) { await denied(401, kind, ''); await denied(401, kind, 'invalid-jwt'); }
    await pool.execute("UPDATE users SET status = 'inactive' WHERE id = 101"); await denied(401);
    await pool.execute("UPDATE users SET status = 'active', session_version = 2 WHERE id = 101"); await denied(401);
  });
  it('retains admin management semantics but rejects password-disabled service interactive login', async () => {
    await pool.execute('DELETE FROM user_roles WHERE user_id = 101');
    await pool.execute("INSERT INTO user_roles (user_id, role_id) SELECT 101, id FROM roles WHERE name = 'admin'");
    expect((await read()).status).toBe(200);
    await pool.execute("INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE name = 'admin'", [serviceId]);
    const serviceToken = signAccessToken({ userId: serviceId, username: 'admin', roles: ['admin'], permissions: ['*'],
      sessionVersion: 1, instanceScopes: {}, requestId: randomUUID() } as ActorContext, secret);
    for (const kind of ['policies', 'budget', 'usage']) await denied(401, kind, serviceToken);
  });
  it('rejects unsupported filters, injection and invalid/duplicate pagination without writes', async () => {
    const before = await snapshot();
    for (const query of ['?actor=102', '?domain=x', '?state=unknown', '?limit=0', '?limit=51', '?limit=1.1', '?offset=-1', '?offset=200001', '?limit=1&limit=2', '?offset=1%20OR%201=1'])
      await denied(400, 'usage', token, query);
    await denied(400, 'budget', token, '?domain=x'); await denied(400, 'policies', token, '?enabled=true');
    for (const kind of ['policies', 'budget', 'usage']) for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect((await fetch(`${address}/api/investigation-${kind}`, { method, headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
    }
    expect(await snapshot()).toEqual(before);
  });
  it('returns unavailable rather than fabricated zero if a required ledger table cannot be read', async () => {
    await pool.execute('RENAME TABLE investigation_budget_resources TO retained_resources');
    await pool.execute('RENAME TABLE investigation_budget_ledger TO retained_ledger');
    try {
      // Authorization rejection must happen before a broken ledger query.
      await grant('ai:view'); await denied(403);
      await grant('ai:view', 'config:manage'); await denied(503);
    } finally {
      await pool.execute('RENAME TABLE retained_ledger TO investigation_budget_ledger');
      await pool.execute('RENAME TABLE retained_resources TO investigation_budget_resources');
    }
  });
  it('reports invalid effective configuration as unavailable and detects frozen hash conflicts', async () => {
    currentConfig = { ...currentConfig, reserveCostMicros: 0 };
    await denied(503, 'budget');
    currentConfig = investigationBudgetConfiguration();
    await reserve('settled');
    await pool.execute('UPDATE investigation_budget_domains SET policy_hash = ?', ['f'.repeat(64)]);
    const before = await snapshot();
    expect(await (await read('budget')).json()).toMatchObject({ admissionStatus: 'conflict', policy: currentConfig.policy });
    expect(await snapshot()).toEqual(before);
  });
  // Derived from the same loader as `currentConfig`, so an operator env does
  // not make the first save look like a policy change.
  const loaderPolicy = investigationBudgetConfiguration().policy;
  const admissionPolicy = { maxConcurrent: loaderPolicy.maxConcurrent, manualReserved: loaderPolicy.manualReserved,
    maxPerResourceConcurrent: loaderPolicy.maxPerResourceConcurrent, maxAutomaticRequestsPerHour: loaderPolicy.maxAutomaticRequestsPerHour,
    maxAutomaticTokensPerDay: loaderPolicy.maxAutomaticTokensPerDay, maxTotalTokensPerDay: loaderPolicy.maxTotalTokensPerDay,
    maxCostMicrosPerDay: loaderPolicy.maxCostMicrosPerDay };
  const effectiveBody = { expectedVersion: 0,
    runtime: { contextWindowTokens: 1_000_000, outputTokens: 393_216, summaryOutputTokens: 393_216, maxExecutionTokens: 1_000_000 },
    profileLimits: { deadlineMs: 600_000, maxToolCalls: 36, maxProviderAttempts: 8, maxRows: 200, maxBytes: 128_000, maxWindowMs: 3_600_000 },
    admissionPolicy };
  const effective = (body: unknown, jwt = token) => fetch(`${address}/api/investigation-budget/effective`, {
    method: 'PUT', headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const readEffective = (jwt = token) => fetch(`${address}/api/investigation-budget/effective`, {
    headers: { authorization: `Bearer ${jwt}` } });
  it('saves the effective budget with versioned audit details and re-reads it', async () => {
    const response = await effective(effectiveBody);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const view = await response.json();
    expect(view).toMatchObject({ source: 'settings', effective: { version: 1, runtime: effectiveBody.runtime, profileLimits: effectiveBody.profileLimits,
      admission: { revision: 1, policy: admissionPolicy } },
    admission: { domain: 'investigation-v1', revision: 1, source: 'settings' } });
    const [rows] = await pool.execute<RowDataPacket[]>('SELECT config_value, updated_by FROM system_config WHERE config_key = ?', [INVESTIGATION_EFFECTIVE_BUDGET_KEY]);
    expect(rows).toHaveLength(1); expect(Number(rows[0].updated_by)).toBe(101);
    const [audit] = await pool.execute<RowDataPacket[]>("SELECT user_id, details_json FROM audit_log_entries WHERE action = 'investigation.effective_budget.update'");
    expect(audit).toHaveLength(1); expect(audit[0].user_id).toBe('101');
    const details = typeof audit[0].details_json === 'string' ? JSON.parse(audit[0].details_json) : audit[0].details_json;
    expect(details).toMatchObject({ previousVersion: 0, version: 1, next: { runtime: effectiveBody.runtime } });
    expect(await (await readEffective()).json()).toMatchObject({ source: 'settings', effective: { version: 1 } });
  });
  it('rotates the ledger domain on a policy change and leaves the old domain/ledger byte-identical', async () => {
    await reserve('settled');
    const [oldDomain] = await pool.query<RowDataPacket[]>('SELECT * FROM investigation_budget_domains WHERE domain_key = ?', ['investigation-v1']);
    const [oldLedger] = await pool.query<RowDataPacket[]>('SELECT * FROM investigation_budget_ledger ORDER BY id');
    expect(oldDomain).toHaveLength(1);
    const rotated = { ...effectiveBody,
      admissionPolicy: { ...admissionPolicy, maxTotalTokensPerDay: 8_000_000, maxAutomaticTokensPerDay: 8_000_000 } };
    const response = await effective(rotated);
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(view).toMatchObject({ source: 'settings',
      effective: { version: 1, admission: { revision: 2, policy: rotated.admissionPolicy } },
      admission: { domain: 'investigation-v1:v2', revision: 2, source: 'settings' } });
    const facts = await (await read('budget')).json();
    expect(Value.Check(InvestigationGovernanceSchemas.InvestigationBudgetResponse, facts)).toBe(true);
    expect(facts).toMatchObject({ policy: { ...rotated.admissionPolicy, currency: 'USD' }, domain: 'investigation-v1:v2',
      admissionRevision: 2, policySource: 'settings', admissionStatus: 'uninitialized', persistedPolicy: null });
    // Runtime/Profile-only edits never rotate.
    const runtimeOnly = await effective({ ...effectiveBody, expectedVersion: 1,
      runtime: { ...effectiveBody.runtime, contextWindowTokens: 500_000, outputTokens: 100_000, summaryOutputTokens: 100_000 },
      admissionPolicy: rotated.admissionPolicy });
    expect(runtimeOnly.status).toBe(200);
    expect(await runtimeOnly.json()).toMatchObject({ effective: { version: 2, admission: { revision: 2 } },
      admission: { domain: 'investigation-v1:v2', revision: 2 } });
    // The old domain snapshot and its historical ledger are untouched.
    expect((await pool.query<RowDataPacket[]>('SELECT * FROM investigation_budget_domains WHERE domain_key = ?', ['investigation-v1']))[0]).toEqual(oldDomain);
    expect((await pool.query<RowDataPacket[]>('SELECT * FROM investigation_budget_ledger ORDER BY id'))[0]).toEqual(oldLedger);
    const [audit] = await pool.execute<RowDataPacket[]>(`SELECT details_json FROM audit_log_entries
      WHERE action = 'investigation.effective_budget.update' AND JSON_EXTRACT(details_json, '$.rotation') IS NOT NULL`);
    expect((typeof audit[0].details_json === 'string' ? JSON.parse(audit[0].details_json) : audit[0].details_json))
      .toMatchObject({ rotation: { previousRevision: 1, revision: 2, previousDomain: 'investigation-v1', domain: 'investigation-v1:v2' } });
  });
  it('fails a conflicting admission policy explicitly without writing settings or rotating', async () => {
    expect((await effective({ ...effectiveBody, admissionPolicy: { ...admissionPolicy, manualReserved: 9 } })).status).toBe(400);
    expect((await effective({ ...effectiveBody, admissionPolicy: { ...admissionPolicy, maxAutomaticTokensPerDay: 6_000_000 } })).status).toBe(400);
    expect((await pool.query<RowDataPacket[]>('SELECT * FROM system_config WHERE config_key = ?', [INVESTIGATION_EFFECTIVE_BUDGET_KEY]))[0]).toHaveLength(0);
  });
  it('rejects stale versions, over-capability values and missing management permission', async () => {
    expect((await effective(effectiveBody)).status).toBe(200);
    const conflict = await effective(effectiveBody);
    expect(conflict.status).toBe(409); expect((await conflict.json() as { error: string }).error).toBe('INVESTIGATION_BUDGET_CONFLICT');
    const over = await effective({ ...effectiveBody, expectedVersion: 1,
      runtime: { ...effectiveBody.runtime, outputTokens: 393_217, summaryOutputTokens: 393_217 } });
    expect(over.status).toBe(422); expect((await over.json() as { error: string }).error).toBe('INVESTIGATION_BUDGET_CAPABILITY_EXCEEDED');
    await grant('ai:view');
    expect((await readEffective()).status).toBe(403);
    expect((await effective(effectiveBody)).status).toBe(403);
  });
});

describe('T07-C public governance contracts', () => {
  it('registers readonly endpoints, explicit management authorization and schema-generated consumer types', () => {
    const document = buildOpenApiDocument() as any;
    for (const [kind, name] of [['policies', 'InvestigationPoliciesResponse'], ['budget', 'InvestigationBudgetResponse'], ['usage', 'InvestigationUsageResponse']]) {
      const path = document.paths[`/api/investigation-${kind}`];
      expect(Object.keys(path)).toEqual(['get']);
      expect(path.get.description).toContain('ai:view');
      if (kind !== 'policies') expect(path.get.description).toContain('config:manage');
      expect(path.get.responses['200'].content['application/json'].schema.$ref).toBe(`#/components/schemas/${name}`);
      expect(buildClientTypes()).toContain(`export type ${name}`);
    }
  });
});
