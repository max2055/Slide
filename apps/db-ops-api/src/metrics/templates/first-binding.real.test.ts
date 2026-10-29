/**
 * MAX-238 / NATIVE-CONFIGURATION-FLOW-R2 — the complete first binding on a real
 * platform database and a real read-only target.
 *
 * The resource starts with **no binding row and no capability fact**. The test
 * drives the real routes and the real service: bootstrap probe → preview →
 * trial (real SQL against the target) → host first-binding transaction, then
 * reads the stored configuration back and proves the concurrency/replay shape.
 * Nothing is seeded to pretend the binding already existed.
 *
 * Skipped unless explicitly enabled:
 *   MAX238_FIRST_BINDING=1 MAX238_TEST_MYSQL_PORT=… MAX238_TEST_MYSQL_PASSWORD=… \
 *   MAX238_TARGET_PASSWORD=… pnpm --filter slide-api exec vitest run \
 *   src/metrics/templates/first-binding.real.test.ts
 */
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import Fastify from 'fastify';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../../auth/actor-context.js';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { dbConnection, encryptData } from '../../db-connection.js';
import { databaseService } from '../../database-service.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { createAssetCollectorAccess } from '../config/access.js';
import { MySqlTemplateRepository } from './mysql-repository.js';
import { MetricTemplateService } from './service.js';
import { TemplateBindingService } from './binding-service.js';
import { registerMetricTemplateRoutes } from './routes.js';
import type { ResourceBindingCandidate } from '../../contracts/metrics/templates.js';
import type { Capability } from '../../contracts/metrics/index.js';
import {
  CAPABILITY_EVIDENCE_TTL_MS, capabilityEvidenceKey, probeIntentDigest, writeCapabilityEvidence,
} from '../bindings/capability-evidence.js';
import { trustedTargetIdentity } from '../bindings/target-identity.js';
import { PolicyError } from '../policy/model.js';
import {
  createOwnedDatabase, dropOwnedDatabase, generateRunNonce, type OwnedDatabase,
} from '../../testing/owned-fixture.js';

const enabled = process.env.MAX238_FIRST_BINDING === '1';
const PORT = Number(process.env.MAX238_TEST_MYSQL_PORT);
const PASSWORD = process.env.MAX238_TEST_MYSQL_PASSWORD ?? '';
const TARGET_PASSWORD = process.env.MAX238_TARGET_PASSWORD ?? '';
// A run-random nonce, recorded in a handle before anything is created. Nothing
// here trusts the port, the PID or a `max238_` prefix as proof of ownership.
const NONCE = process.env.MAX238_RUN_NONCE ?? generateRunNonce();
// MySQL caps user names at 32 characters; the nonce is folded into a short digest.
const TARGET_USER = `max238_ro_${createHash('sha256').update(NONCE).digest('hex').slice(0, 16)}`;
const HANDLE_DIR = process.env.MAX238_HANDLE_DIR ?? join(process.cwd(), '.max238-handles');
const AT = () => new Date().toISOString();

const admin = {
  userId: 1, username: 'max238-first-binding', roles: ['admin'], permissions: ['*'],
  sessionVersion: 1, instanceScopes: {} as Record<number, 'admin'>, requestId: 'max238-first-binding',
} as unknown as ActorContext;

describe.skipIf(!enabled)('first binding on a real MySQL platform and read-only target', () => {
  let pool: Pool;
  let app: ReturnType<typeof Fastify>;
  let instanceId = 0;
  let failingInstanceId = 0;
  let secondInstanceId = 0;
  let reProbeInstanceId = 0;
  let rotatedInstanceId = 0;
  let evidenceInstanceId = 0;
  let templateId = '';
  let templateVersion = 0;
  let contentHash = '';
  const registry = createConfigurationRegistry();

  const call = async (method: 'GET' | 'POST', url: string, body?: unknown) => {
    const response = await app.inject({ method, url, ...(body === undefined ? {} : { payload: body }) });
    return { status: response.statusCode, data: response.json() as Record<string, unknown> };
  };
  const body = (revision: number) => ({
    expected_revision: revision,
    template_pins: [{ template_id: templateId, version: templateVersion, content_hash: contentHash }],
    overrides: {
      enabled: 'enable', interval_ms: { mode: 'set', value: 30000 }, max_rows: { mode: 'set', value: 50 },
      metrics: { 'mysql.connections.limit@1.0.0': 'disable' },
      template_parameters: { [templateId]: { sample_batch: 25 } },
    },
    group_id: 'prod-max238',
  });
  const counts = async () => ({
    operations: Number((await pool.query<RowDataPacket[]>('SELECT COUNT(*) c FROM metric_policy_operations'))[0][0].c),
    audits: Number((await pool.query<RowDataPacket[]>('SELECT COUNT(*) c FROM metric_policy_audit'))[0][0].c),
  });
  const bindings = async (id: number) => (await pool.query<RowDataPacket[]>(
    'SELECT payload FROM metric_policy_bindings WHERE resource_key = ?', [`instance:${id}`]))[0];
  const evidenceRows = async (id: number) => Number((await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) c FROM metric_capability_evidence WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, \'$.resource.id\')) = ?',
    [String(id)]))[0][0].c);

  let platform: OwnedDatabase;
  let target: OwnedDatabase;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
    const root = await mysql.createConnection({ host: '127.0.0.1', port: PORT, user: 'root', password: PASSWORD });
    try {
      platform = await createOwnedDatabase(root, { nonce: NONCE, purpose: 'first', handleDir: HANDLE_DIR });
      target = await createOwnedDatabase(root, { nonce: NONCE, purpose: 'target', handleDir: HANDLE_DIR });
    } catch (error) { await root.end(); throw error; }
    try {
      await root.query(`CREATE TABLE \`${target.database}\`.probe (id INT PRIMARY KEY, label VARCHAR(64))`);
      await root.query(`INSERT INTO \`${target.database}\`.probe VALUES (1, 'max238-first-binding')`);
      // A nonce-named user; an existing one is a neighbour, not ours to reuse.
      await root.query(`CREATE USER '${TARGET_USER}'@'%' IDENTIFIED BY ?`, [TARGET_PASSWORD]);
      await root.query(`GRANT SELECT ON \`${target.database}\`.* TO '${TARGET_USER}'@'%'`);
      await root.query(`GRANT PROCESS ON *.* TO '${TARGET_USER}'@'%'`);
    } catch (error) { await root.end(); throw error; }
    await root.end();

    pool = mysql.createPool({ host: '127.0.0.1', port: PORT, user: 'root', password: PASSWORD,
      database: platform.database, timezone: 'Z', connectionLimit: 12 });
    pool.on('connection', connection => connection.query("SET time_zone='+00:00'"));
    const runner = new MigrationRunner(pool as unknown as MigrationPool);
    await runner.run();
    await runner.run();
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);

    const now = AT();
    await pool.execute(`INSERT INTO users (username, password_hash, email, status, session_version)
      VALUES ('max238-first-binding', 'x', 'max238@example.invalid', 'active', 1)`);
    await pool.execute(`INSERT INTO metric_policy_groups (id, payload) VALUES ('prod-max238', ?)
      ON DUPLICATE KEY UPDATE payload = VALUES(payload)`, [JSON.stringify({ id: 'prod-max238', revision: 1, overrides: {} })]);

    const instance = async (name: string, targetUser: string, targetPassword: string): Promise<number> => {
      await pool.execute(`INSERT INTO database_instances
        (name, environment, db_type, db_version, host, port, username, password_encrypted, database_name, status, lifecycle_state,
         max_connections, connection_timeout_ms, created_by, created_at, updated_at)
        VALUES (?, 'testing', 'mysql', '8.4', '127.0.0.1', ?, ?, ?, ?, 'active', 'available', 10, 5000, 1, ?, ?)`,
      [name, PORT, targetUser, encryptData(targetPassword), target.database, now.replace('T', ' ').replace('Z', ''),
        now.replace('T', ' ').replace('Z', '')]);
      return Number((await pool.query<RowDataPacket[]>('SELECT id FROM database_instances WHERE name = ?', [name]))[0][0].id);
    };
    instanceId = await instance('max238-first-unbound', TARGET_USER, TARGET_PASSWORD);
    secondInstanceId = await instance('max238-first-concurrent', TARGET_USER, TARGET_PASSWORD);
    failingInstanceId = await instance('max238-first-bad-credential', TARGET_USER, `${TARGET_PASSWORD}-wrong`);
    reProbeInstanceId = await instance('max238-r3-reprobe', TARGET_USER, TARGET_PASSWORD);
    rotatedInstanceId = await instance('max238-r3-rotated', TARGET_USER, TARGET_PASSWORD);
    evidenceInstanceId = await instance('max238-r3-evidence', TARGET_USER, TARGET_PASSWORD);
    // The accepted collector access reads the live shared connection it built
    // when the connection was saved; a raw fixture row alone is not a target.
    const targetConfig = { host: '127.0.0.1', port: PORT, user: TARGET_USER, password: TARGET_PASSWORD,
      database: target.database, db_type: 'mysql' as const };
    expect(await databaseService.addConnection(instanceId, 'max238-first-unbound', targetConfig)).toBe(true);
    expect(await databaseService.addConnection(secondInstanceId, 'max238-first-concurrent', targetConfig)).toBe(true);
    for (const [id, name] of [[reProbeInstanceId, 'max238-r3-reprobe'], [rotatedInstanceId, 'max238-r3-rotated'],
      [evidenceInstanceId, 'max238-r3-evidence']] as Array<[number, string]>) {
      expect(await databaseService.addConnection(id, name, targetConfig)).toBe(true);
    }
    (admin as unknown as { instanceScopes: Record<number, string> }).instanceScopes = {
      [instanceId]: 'admin', [secondInstanceId]: 'admin', [failingInstanceId]: 'admin',
      [reProbeInstanceId]: 'admin', [rotatedInstanceId]: 'admin', [evidenceInstanceId]: 'admin',
    };

    // One real template version with two registered metrics and one parameter.
    const repository = new MySqlTemplateRepository(pool as never);
    const templates = new MetricTemplateService(repository, registry);
    const template = await templates.create(admin as never, { name: `MAX238 first binding ${process.pid}` });
    const release = registry.list().map(entry => entry.package)
      .find(pkg => pkg.id === 'mysql-representative' && pkg.version === '1.0.0')!;
    const packagePin = { id: release.id, version: release.version, digest: release.digest };
    const uptime = await templates.selectMetric(admin as never, template.template_id,
      { package: packagePin, metric: { id: 'mysql.processlist.count', semantic_version: '1.0.0' } });
    const queries = await templates.selectMetric(admin as never, template.template_id,
      { package: packagePin, metric: { id: 'mysql.connections.limit', semantic_version: '1.0.0' } });
    const draft = await repository.getDraft(template.template_id);
    const aggregate = structuredClone(draft!.aggregate) as Record<string, unknown>;
    aggregate.items = [
      { item_id: uptime.item.item_id, version: uptime.item.version },
      { item_id: queries.item.item_id, version: queries.item.version },
    ].sort((left, right) => left.item_id < right.item_id ? -1 : left.item_id > right.item_id ? 1 : 0);
    aggregate.parameters = { schema: { sample_batch: { type: 'integer', min: 1, max: 1000 } }, defaults: { sample_batch: 10 } };
    await repository.updateDraft(template.template_id, draft!.revision,
      { aggregate: aggregate as never, updated_by: 1, updated_at: now });
    const afterDraft = await repository.getDraft(template.template_id);
    const published = await templates.publish(admin as never, template.template_id,
      { expected_draft_revision: afterDraft!.revision, expected_revision: template.revision });
    const record = await repository.getTemplate(template.template_id);
    await repository.updateTemplate(template.template_id, record!.revision,
      { status: 'active', updated_at: new Date(Date.parse(now) + 1000).toISOString() });
    const version = await repository.getVersion(template.template_id, published.version);
    templateId = template.template_id;
    templateVersion = published.version;
    contentHash = version!.content_hash;

    const service = new TemplateBindingService({
      pool: () => pool, registry, access: createAssetCollectorAccess(),
      reload: async () => admin, inventory: undefined,
    });
    app = Fastify();
    await registerMetricTemplateRoutes(app, async request => {
      (request as unknown as { user?: ActorContext }).user = admin;
    }, service);
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    const root = await mysql.createConnection({ host: '127.0.0.1', port: PORT, user: 'root', password: PASSWORD });
    const errors: unknown[] = [];
    try {
      // Each cleanup is independently verified on the live root connection; one
      // failure never hides the others and leaves its handle behind for a human.
      await root.query(`DROP USER IF EXISTS '${TARGET_USER}'@'%'`).catch(error => errors.push(error));
      await dropOwnedDatabase(root, { nonce: NONCE, purpose: 'target', handleDir: HANDLE_DIR })
        .catch(error => errors.push(error));
      await dropOwnedDatabase(root, { nonce: NONCE, purpose: 'first', handleDir: HANDLE_DIR })
        .catch(error => errors.push(error));
    } finally { await root.end(); }
    if (errors.length) throw errors[0];
  });

  it('bootstraps capabilities from a real read-only probe, then commits revision 1', async () => {
    expect(await bindings(instanceId)).toHaveLength(0);
    const unbound = await call('GET', `/api/metrics/template-bindings/instance/${instanceId}`);
    expect(unbound.data).toMatchObject({ source: 'unbound', revision: null });

    // The old behaviour refused here: no capability producer existed.
    const early = await call('POST', `/api/metrics/template-bindings/instance/${instanceId}/preview`, body(0));
    expect(early.status).toBe(200);
    expect(early.data.executable).toBe(false);

    const probe = await call('POST', `/api/metrics/template-bindings/instance/${instanceId}/probe`, body(0));
    expect(probe.status, JSON.stringify(probe.data)).toBe(200);
    const capabilities = probe.data.capabilities as Array<{ metric: { id: string }; status: string }>;
    expect(capabilities.map(entry => entry.metric.id)).toEqual(['mysql.processlist.count']);
    expect(capabilities[0].status).toBe('supported');
    expect(await evidenceRows(instanceId)).toBe(1);

    const preview = await call('POST', `/api/metrics/template-bindings/instance/${instanceId}/preview`, body(0));
    expect(preview.status, JSON.stringify(preview.data)).toBe(200);
    expect(preview.data.executable).toBe(true);
    const items = preview.data.items as Array<{ canonical_metric: { id: string }; decision: string }>;
    expect(items.find(item => item.canonical_metric.id === 'mysql.processlist.count')?.decision).toBe('collect');
    expect(items.find(item => item.canonical_metric.id === 'mysql.connections.limit')?.decision).toBe('disabled');

    const trial = await call('POST', `/api/metrics/template-bindings/instance/${instanceId}/trial`,
      { ...body(0), receipt_id: `probe-trial-${process.pid}` });
    expect(trial.status, JSON.stringify(trial.data)).toBe(200);
    expect(trial.data.decision).toBe('attempted');

    const before = await counts();
    const applied = await call('POST', `/api/metrics/template-bindings/instance/${instanceId}/apply`,
      { ...body(0), receipt_id: `probe-trial-${process.pid}`, caller_key: `probe-apply-${process.pid}` });
    expect(applied.status, JSON.stringify(applied.data)).toBe(200);
    expect(applied.data).toMatchObject({ kind: 'committed', revision: 1 });
    const after = await counts();
    expect(after.operations - before.operations).toBe(1);
    expect(after.audits - before.audits).toBe(1);
    expect(await bindings(instanceId)).toHaveLength(1);

    // Lossless read-back: pins, group, explicit enable/disable and the parameter
    // override all survive the host transaction unchanged.
    const status = await call('GET', `/api/metrics/template-bindings/instance/${instanceId}`);
    expect(status.data).toMatchObject({
      source: 'template', revision: 1,
      template_pins: [{ template_id: templateId, version: templateVersion, content_hash: contentHash }],
      configuration: { group_id: 'prod-max238' },
    });
    const configuration = status.data.configuration as { overrides: Record<string, unknown> };
    expect(configuration.overrides).toMatchObject({
      enabled: 'enable',
      interval_ms: { mode: 'set', value: 30000 },
      max_rows: { mode: 'set', value: 50 },
      metrics: { 'mysql.connections.limit@1.0.0': 'disable' },
      template_parameters: { [templateId]: { sample_batch: 25 } },
    });
    const payload = (await bindings(instanceId))[0].payload as unknown;
    const stored = (typeof payload === 'string' ? JSON.parse(payload) : payload) as {
      binding: { overrides: unknown; group_id: string };
    };
    expect(stored.binding.group_id).toBe('prod-max238');
    expect(stored.binding.overrides).toMatchObject(configuration.overrides);

    // A replay of the same exact operation reuses that revision and writes nothing.
    const replay = await call('POST', `/api/metrics/template-bindings/instance/${instanceId}/apply`,
      { ...body(0), receipt_id: `probe-trial-${process.pid}`, caller_key: `probe-apply-${process.pid}` });
    expect(replay.status, JSON.stringify(replay.data)).toBe(200);
    expect(replay.data).toMatchObject({ kind: 'replay', target_revision: 1 });
    expect((await counts()).operations).toBe(after.operations);
  }, 60_000);

  it('two concurrent first bindings publish exactly one revision', async () => {
    const probe = await call('POST', `/api/metrics/template-bindings/instance/${secondInstanceId}/probe`, body(0));
    expect(probe.status, JSON.stringify(probe.data)).toBe(200);
    // Two independent trials for the same base-0 intent, then two concurrent
    // applies: the host's INSERT primary key is the CAS, so only one may publish.
    const trialA = await call('POST', `/api/metrics/template-bindings/instance/${secondInstanceId}/trial`,
      { ...body(0), receipt_id: `concurrent-trial-a-${process.pid}` });
    expect(trialA.status, JSON.stringify(trialA.data)).toBe(200);
    const trialB = await call('POST', `/api/metrics/template-bindings/instance/${secondInstanceId}/trial`,
      { ...body(0), receipt_id: `concurrent-trial-b-${process.pid}` });
    expect(trialB.status, JSON.stringify(trialB.data)).toBe(200);
    const before = await counts();
    const first = call('POST', `/api/metrics/template-bindings/instance/${secondInstanceId}/apply`,
      { ...body(0), receipt_id: `concurrent-trial-a-${process.pid}`, caller_key: `concurrent-a-${process.pid}` });
    const second = call('POST', `/api/metrics/template-bindings/instance/${secondInstanceId}/apply`,
      { ...body(0), receipt_id: `concurrent-trial-b-${process.pid}`, caller_key: `concurrent-b-${process.pid}` });
    const [left, right] = await Promise.all([first, second]);
    const committed = [left, right].filter(result => result.status === 200 && result.data.kind === 'committed');
    const conflicts = [left, right].filter(result => result.status === 409);
    expect(committed).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    const finished = await counts();
    expect(finished.operations - before.operations).toBe(1);
    expect(finished.audits - before.audits).toBe(1);
    expect(await bindings(secondInstanceId)).toHaveLength(1);
  }, 60_000);

  it('a failed real probe stores no evidence and creates no binding', async () => {
    const response = await call('POST', `/api/metrics/template-bindings/instance/${failingInstanceId}/probe`, body(0));
    expect([422, 500]).toContain(response.status);
    expect(await evidenceRows(failingInstanceId)).toBe(0);
    expect(await bindings(failingInstanceId)).toHaveLength(0);
  }, 60_000);

  /* --- R3: re-acquisition, credential/target isolation, late revocation ----- */

  it('R3: an expired evidence row is a refusal to consume but is replaced by a real re-probe', async () => {
    const first = await call('POST', `/api/metrics/template-bindings/instance/${reProbeInstanceId}/probe`, body(0));
    expect(first.status, JSON.stringify(first.data)).toBe(200);
    expect(await evidenceRows(reProbeInstanceId)).toBe(1);
    // Expire the stored row in the real table; do not re-date it to pretend support.
    await pool.query(`UPDATE metric_capability_evidence
        SET payload = JSON_SET(payload, '$.expires_at', '2026-10-29T00:00:00.000Z')
        WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.resource.id')) = ?`, [String(reProbeInstanceId)]);
    const refused = await call('POST', `/api/metrics/template-bindings/instance/${reProbeInstanceId}/preview`, body(0));
    expect(refused.status).toBe(503);
    expect(refused.data.error).toBe('CAPABILITY_EVIDENCE_EXPIRED');
    // The explicit probe must re-acquire for real and atomically replace the row.
    const again = await call('POST', `/api/metrics/template-bindings/instance/${reProbeInstanceId}/probe`, body(0));
    expect(again.status, JSON.stringify(again.data)).toBe(200);
    expect(await evidenceRows(reProbeInstanceId)).toBe(1);
    const fresh = await call('POST', `/api/metrics/template-bindings/instance/${reProbeInstanceId}/preview`, body(0));
    expect(fresh.status, JSON.stringify(fresh.data)).toBe(200);
    expect(fresh.data.executable).toBe(true);
  }, 60_000);

  it('R3: a rewritten credential row is a different evidence identity, so the old facts are not consumed', async () => {
    const first = await call('POST', `/api/metrics/template-bindings/instance/${rotatedInstanceId}/probe`, body(0));
    expect(first.status, JSON.stringify(first.data)).toBe(200);
    expect(await evidenceRows(rotatedInstanceId)).toBe(1);
    // Same resource id, same credential value, new ciphertext (as a rotation would
    // store): the evidence was bound to the previous credential version.
    await pool.execute('UPDATE database_instances SET password_encrypted = ? WHERE id = ?',
      [encryptData(TARGET_PASSWORD), rotatedInstanceId]);
    const stale = await call('POST', `/api/metrics/template-bindings/instance/${rotatedInstanceId}/preview`, body(0));
    expect(stale.status, JSON.stringify(stale.data)).toBe(200);
    expect(stale.data.executable).toBe(false);
    const again = await call('POST', `/api/metrics/template-bindings/instance/${rotatedInstanceId}/probe`, body(0));
    expect(again.status, JSON.stringify(again.data)).toBe(200);
    // The old row is never reused and a new exact identity was written.
    expect(await evidenceRows(rotatedInstanceId)).toBe(2);
    const fresh = await call('POST', `/api/metrics/template-bindings/instance/${rotatedInstanceId}/preview`, body(0));
    expect(fresh.data.executable).toBe(true);
  }, 60_000);

  it('R3: a grant revoked after the real read-back leaves zero rows in the real database', async () => {
    const ref = { type: 'instance' as const, id: evidenceInstanceId };
    const intent = body(0);
    const candidate = { resource: ref, package: null, group_id: intent.group_id, overrides: intent.overrides,
      revision: 0, template_pins: intent.template_pins };
    const executor = pool as unknown as Parameters<typeof trustedTargetIdentity>[0];
    const targetIdentity = await trustedTargetIdentity(executor, ref);
    expect(targetIdentity).toMatch(/^sha256:/);
    const identity = {
      resource: ref, revision: 0, template_pins: intent.template_pins,
      credential_ref: `credential:asset-instance-${evidenceInstanceId}`,
      target_identity: targetIdentity!, actor_id: 1, intent_digest: probeIntentDigest(candidate),
    };
    const key = capabilityEvidenceKey(identity);
    const rows = async () => Number((await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) c FROM metric_capability_evidence WHERE evidence_key = ?', [key]))[0][0].c);
    const now = AT();
    const capabilities: Capability[] = [{
      resource_id: String(evidenceInstanceId), metric: { id: 'mysql.processlist.count', semantic_version: '1.0.0' },
      status: 'supported', method: 'sql', basis: [{ kind: 'method', evidence: 'r3_real_write' }],
      evaluated_at: now, valid_until: new Date(Date.parse(now) + 120_000).toISOString(),
    }];
    const input = { ...identity, capabilities, probed_at: now,
      expires_at: new Date(Date.parse(now) + CAPABILITY_EVIDENCE_TTL_MS).toISOString() };

    // Refusal at the boundary after the read-back, immediately before COMMIT.
    let calls = 0;
    const authorize = async () => {
      calls += 1;
      if (calls >= 4) throw new PolicyError('TEMPLATE_BINDING_FORBIDDEN', 403);
    };
    await expect(writeCapabilityEvidence(input, { pool: () => pool, authorize }))
      .rejects.toBeInstanceOf(PolicyError);
    expect(await rows()).toBe(0);

    // The same write with a live grant commits exactly one row.
    const written = await writeCapabilityEvidence(input, { pool: () => pool });
    expect(written.record.capabilities).toHaveLength(1);
    expect(await rows()).toBe(1);
  }, 60_000);
});
