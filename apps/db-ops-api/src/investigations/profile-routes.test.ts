import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import mysql, { type Pool, type ResultSetHeader } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { MigrationRunner } from '../migrations/runner.js';
import { ActorContextService, signAccessToken } from '../auth/actor-context.js';
import { createVerifyToken } from '../auth-middleware.js';
import { provisionInvestigationServiceIdentity, type AuthorityExecutor } from './authorization.js';
import { INVESTIGATION_PROFILES, INVESTIGATION_PROMPTS, investigationProfileHash, resolveInvestigationProfile } from './profiles.js';
import { InvestigationProfilesResponseSchema } from './profile-contracts.js';
import { registerInvestigationProfileRoutes } from './profile-routes.js';
import { buildClientTypes, buildOpenApiDocument } from '../contracts/generate-public-api.js';

const port = Number(process.env.AUTH_TEST_MYSQL_PORT ?? process.env.REPORT_TEST_MYSQL_PORT);
describe.skipIf(!port)('T03-D Profile facts: real MySQL migration/JWT/TCP HTTP', () => {
  const database = `t03d_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const secret = randomUUID();
  let admin: Pool;
  let pool: Pool;
  let contexts: ActorContextService;
  let app: FastifyInstance;
  let address: string;
  let token: string;
  let roleId: number;
  let serviceId: number;
  const read = (jwt = token) => fetch(`${address}/api/investigation-profiles`, {
    headers: jwt ? { authorization: `Bearer ${jwt}` } : {},
  });
  const denied = async (status: number, jwt = token) => {
    const response = await read(jwt);
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json();
    expect(body).toEqual({ error: expect.any(String) });
    expect(JSON.stringify(body)).not.toMatch(/toolAllowlist|prompt|password|SELECT|t03d-reader/);
  };

  beforeAll(async () => {
    const options = { host: '127.0.0.1', port, user: 'root', timezone: 'Z',
      password: process.env.AUTH_TEST_MYSQL_PASSWORD ?? process.env.REPORT_TEST_MYSQL_PASSWORD ?? '' };
    admin = mysql.createPool(options);
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...options, database, connectionLimit: 4 });
    await new MigrationRunner(pool).run();
    // The permission catalog is extensible; ai:view is used by existing AI
    // settings routes but is not seeded by the historical SQL baseline.
    await pool.execute("INSERT IGNORE INTO permissions (code, name, resource, action) VALUES ('ai:view', 'AI settings read', 'ai', 'view')");
    await pool.execute("INSERT INTO users (id, username, password_hash) VALUES (101, 't03d-reader', 'not-a-login-hash')");
    const [role] = await pool.execute<ResultSetHeader>("INSERT INTO roles (name) VALUES ('t03d-profile-reader')");
    roleId = Number(role.insertId);
    serviceId = await provisionInvestigationServiceIdentity(pool as unknown as AuthorityExecutor, 't03d');
    contexts = new ActorContextService(() => pool as never);
    app = Fastify();
    await registerInvestigationProfileRoutes(app, createVerifyToken(secret, contexts));
    address = await app.listen({ host: '127.0.0.1', port: 0 });
  }, 120_000);
  beforeEach(async () => {
    await pool.execute("UPDATE users SET status = 'active', session_version = 1 WHERE id = 101");
    await pool.execute('DELETE FROM user_roles WHERE user_id = 101');
    await pool.execute('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
    await pool.execute("INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE code = 'ai:view'", [roleId]);
    await pool.execute('INSERT INTO user_roles (user_id, role_id) VALUES (101, ?)', [roleId]);
    token = signAccessToken(await contexts.loadActiveActor(101), secret);
  });
  afterAll(async () => {
    await app?.close(); await pool?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); }
  });

  it('returns authoritative versioned presets and bounded facts without prompt or principal secrets', async () => {
    const response = await read();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json() as any;
    expect(Value.Check(InvestigationProfilesResponseSchema, body)).toBe(true);
    expect(body).toMatchObject({ schemaVersion: 1, source: 'repository', allowlistSemantics: 'authority_ceiling' });
    expect(body.items).toHaveLength(3);
    for (const item of body.items) {
      const profile = resolveInvestigationProfile(item.profile.id, item.profile.version);
      expect(item).toEqual({ profile, profileHash: investigationProfileHash(profile),
        configurationStatus: 'preset', toolAvailability: 'not_evaluated', outputSchemaId: 'InvestigationResult' });
      expect(item.profile.prompt.hash).toMatch(/^[a-f0-9]{64}$/);
    }
    const text = JSON.stringify(body);
    for (const prompt of Object.values(INVESTIGATION_PROMPTS)) expect(text).not.toContain(prompt);
    expect(text).not.toMatch(/password|apiKey|username|userId|sessionVersion|not-a-login-hash|t03d-reader/);
    const contaminated = { ...body, items: body.items.map((item: any, index: number) => index === 0
      ? { ...item, profile: { ...item.profile, rawPrompt: 'secret' } } : item) };
    expect(Value.Check(InvestigationProfilesResponseSchema, contaminated)).toBe(false);
    expect((await read()).headers.get('etag')).toBeNull();
  });
  it('rejects unauthenticated and malformed tokens without caching facts', async () => {
    await denied(401, ''); await denied(401, 'invalid-jwt');
  });
  it('requires the AI settings read permission, not ordinary Chat permission', async () => {
    await pool.execute('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
    await pool.execute("INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE code = 'chat:view'", [roleId]);
    await denied(403);
  });
  it('observes permission revocation and restoration with the same JWT', async () => {
    expect((await read()).status).toBe(200);
    await pool.execute('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
    await denied(403);
    await pool.execute("INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE code = 'ai:view'", [roleId]);
    expect((await read()).status).toBe(200);
  });
  it('rejects disabled users even with a previously valid token', async () => {
    await pool.execute("UPDATE users SET status = 'inactive' WHERE id = 101"); await denied(401);
  });
  it('rejects a revoked login session with the same JWT', async () => {
    await pool.execute('UPDATE users SET session_version = 2 WHERE id = 101'); await denied(401);
  });
  it('observes role removal', async () => {
    await pool.execute('DELETE FROM user_roles WHERE user_id = 101'); await denied(403);
  });
  it('observes live role expiry', async () => {
    await pool.execute('UPDATE user_roles SET grant_expiry = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE user_id = 101'); await denied(403);
  });
  it('retains existing admin settings access', async () => {
    await pool.execute('DELETE FROM user_roles WHERE user_id = 101');
    await pool.execute("INSERT INTO user_roles (user_id, role_id) SELECT 101, id FROM roles WHERE name = 'admin'");
    expect((await read()).status).toBe(200);
  });
  it('does not accept numeric service identities as interactive users or inherit their admin role', async () => {
    await pool.execute("INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE name = 'admin'", [serviceId]);
    const serviceToken = signAccessToken({ userId: serviceId, username: 'admin', roles: ['admin'], permissions: ['*'],
      sessionVersion: 1, instanceScopes: {}, requestId: randomUUID() }, secret);
    await denied(401, serviceToken);
  });
  it('has no write methods and rejects caller-selected facts', async () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      const response = await fetch(`${address}/api/investigation-profiles`, { method, headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(404);
    }
    const response = await fetch(`${address}/api/investigation-profiles?profileId=custom`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ error: 'INVESTIGATION_INPUT_INVALID' });
  });
});

describe('T03-D public consumer contract', () => {
  it('documents the actual read endpoint, schema and authorization', () => {
    const document = buildOpenApiDocument() as any;
    const operation = document.paths['/api/investigation-profiles'].get;
    expect(operation.security).toEqual([{ bearerAuth: [] }]);
    expect(operation.description).toContain('ai:view');
    expect(operation.responses['200'].content['application/json'].schema.$ref).toBe('#/components/schemas/InvestigationProfilesResponse');
    expect(operation.responses['401']).toBeDefined(); expect(operation.responses['403']).toBeDefined();
    expect(buildClientTypes()).toContain('export type InvestigationProfilesResponse');
  });
});
