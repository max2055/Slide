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
import { InvestigationGovernanceSchemas, type InvestigationUsageResponse } from './governance-contracts.js';
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
    store = new InvestigationGovernanceStore(() => pool, () => currentConfig, contexts);
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
    const body = await response.json();
    expect(Value.Check(InvestigationGovernanceSchemas.InvestigationPoliciesResponse, body)).toBe(true);
    expect(body).toMatchObject({ configurationStatus: 'not_configured', integrationStatus: 'not_connected', items: [] });
    expect(await snapshot()).toEqual(before);
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
