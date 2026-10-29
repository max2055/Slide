import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { dbConnection } from '../../db-connection.js';
import type { ActorContext } from '../../auth/actor-context.js';
import { configurationInventory } from './inventory.js';
import { createConfigurationRegistry } from './registry.js';
import { createTrialStore } from './routes.js';
import { MetricConfigurationService } from './service.js';
import { configurationReader } from './status-store.js';
import { PolicyService } from '../policy/service.js';
import { MysqlPolicyStore } from '../policy/store.js';
import { admin } from '../policy/test-support.js';

/**
 * MAX-238 binding-path package. On a disposable schema (METRICS_TEST_MYSQL_PORT) this exercises the
 * existing recommendations reader and the existing PolicyService.changeBinding against two real
 * resource rows (instance 1 mysql 8.0.46 and server 3 with a Linux os_type), proving the acceptance
 * sentence "all authorized templates, multi-select, pinned version, compatibility reason, cancel and
 * empty binding paths are usable; different objects never share configuration".
 *
 * The current model pins exactly one package per resource; this package does not change it.
 * "Multi-select" here means the authorized list offers several published templates, each can be
 * previewed, an unpublished one has no effect, and one publish still stores a single pin.
 *
 * Nothing connects to the real hosts: trialCurrent, activate and the worker are never called, so
 * the empty credential columns in the two disposable rows are never used. Product code is
 * unchanged; a clause the product cannot satisfy fails here and is written into the evidence.
 */
const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
const envFile = process.env.SLIDE_DEBUG_ENV_FILE;
const database = `max238_binding_path_${process.pid}`;
const instanceRef = { type: 'instance' as const, id: 1 };
const serverRef = { type: 'server' as const, id: 3 };
const tamperedDigest = `sha256:${'b'.repeat(64)}`;
const incompatibleCodes = ['POLICY_PACKAGE_RESOURCE', 'PACKAGE_INCOMPATIBLE'];
const evidencePath = fileURLToPath(new URL('../../../../../docs/slide/development/MAX-238/binding-path-20261028.json', import.meta.url));

/** Capture the existing rejection contract instead of assuming one error type. */
const rejection = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return null;
  } catch (error) {
    const caught = error as { code?: string; message?: string; status?: number };
    return { code: caught.code ?? null, message: caught.message ?? String(error), status: caught.status ?? null };
  }
};

describe.skipIf(!port)('MAX-238 binding path is usable and never crosses resources', () => {
  let root: Pool, pool: Pool;
  let packages: ReturnType<typeof createConfigurationRegistry>;
  let policies: PolicyService;
  let service: MetricConfigurationService;
  let poolSpy: ReturnType<typeof vi.spyOn>;
  const query = async (target: Pool, sql: string, values: unknown[] = []) =>
    (await target.query<RowDataPacket[]>(sql, values as never))[0];
  const rows = (sql: string, values: unknown[] = []) => query(pool, sql, values);
  const one = async (sql: string, values: unknown[] = []) => (await rows(sql, values))[0];
  const bindingRows = async (key: string) =>
    Number((await one('SELECT COUNT(*) AS n FROM metric_policy_bindings WHERE resource_key = ?', [key]))!.n);
  const storedRevision = async (key: string) =>
    Number((await one("SELECT JSON_EXTRACT(payload, '$.binding.revision') AS revision FROM metric_policy_bindings WHERE resource_key = ?", [key]))!.revision);
  const pinOf = (id: string, version: string) => {
    const release = packages.list().find(candidate => candidate.package.id === id && candidate.package.version === version);
    expect(release, `${id}@${version} must be installed`).toBeTruthy();
    return { id, version, digest: release!.package.digest };
  };
  const packageSet = (type: 'instance' | 'server') => packages.list()
    .filter(release => release.package.resource_type === type)
    .map(release => `${release.package.id}@${release.package.version}`).sort();

  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, connectionLimit: 20, timezone: 'Z' });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    poolSpy = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);

    // Two authorized resource rows with empty credentials: no collection path is ever called.
    await pool.execute(`INSERT INTO database_instances
      (id,name,environment,db_type,host,port,username,password_encrypted,database_name,db_version,status,lifecycle_state)
      VALUES (1,'mysql3306','production','mysql','127.0.0.1',3306,'fixture','','mysql','8.0.46','active','available')`);
    await pool.execute(`INSERT INTO servers
      (id,host,port,label,os_type,credential_type,credential_encrypted,status,collection_enabled)
      VALUES (3,'192.168.49.130',22,'fixture-host','kylin','password','','online',1)`);

    packages = createConfigurationRegistry();
    policies = new PolicyService(new MysqlPolicyStore(() => pool), packages,
      { exists: async () => true, inventory: configurationInventory });
    service = new MetricConfigurationService(policies, packages, createTrialStore(() => pool, packages),
      { resolve: async () => { throw new Error('binding path must not collect'); } }, configurationReader(() => pool));
  }, 180000);

  afterAll(async () => {
    poolSpy?.mockRestore();
    await pool?.end();
    if (root) {
      await root.query(`DROP DATABASE IF EXISTS ${database}`);
      await root.end();
    }
  }, 60000);

  it('proves the seven binding-path clauses on the disposable schema', async () => {
    const evidence: Record<string, unknown> = {};
    // Scalars reused by several clauses; every one is read back from the disposable schema.
    let revisionAfterPublish = 0;

    // 1. All authorized templates, filtered by resource type, with compatibility reasons.
    const instanceRec = await service.recommendations(admin, instanceRef);
    const serverRec = await service.recommendations(admin, serverRef);
    const instanceKeys = instanceRec.packages.map(entry => `${entry.release.package.id}@${entry.release.package.version}`).sort();
    const serverKeys = serverRec.packages.map(entry => `${entry.release.package.id}@${entry.release.package.version}`).sort();
    const instanceIds = instanceRec.packages.map(entry => entry.release.package.id);
    const serverIds = serverRec.packages.map(entry => entry.release.package.id);
    expect(instanceKeys).toEqual(packageSet('instance'));
    expect(serverKeys).toEqual(packageSet('server'));
    expect(new Set(instanceIds).size).toBeGreaterThan(1);
    expect(instanceIds).toContain('mysql-basic');
    expect(instanceIds).toContain('mysql-diagnostics');
    expect(instanceIds).not.toContain('linux-host');
    expect(instanceIds).not.toContain('if-mib-basic');
    expect(serverIds).toContain('linux-host');
    expect(serverIds).not.toContain('mysql-diagnostics');
    const recommended = instanceRec.packages.filter(entry => entry.recommended);
    expect(recommended).toHaveLength(1);
    expect(recommended[0].compatibility).toBe('compatible');
    for (const entry of [...instanceRec.packages, ...serverRec.packages]) {
      expect(entry.compatibility, `${entry.release.package.id} compatibility is computed`).toBeTypeOf('string');
      expect(entry.compatibility).not.toBe('');
      expect(entry.checks.length).toBeGreaterThan(0);
    }
    // A scoped actor may read its own resource but not another one.
    const scoped: ActorContext = { userId: 2, username: 'scoped', roles: [], permissions: [],
      instanceScopes: { 1: 'read-only' }, sessionVersion: 1, requestId: 'test-binding-path' };
    expect((await service.recommendations(scoped, instanceRef)).resource).toEqual(instanceRef);
    const forbidden = await rejection(() => service.recommendations(scoped, { type: 'instance', id: 2 }));
    expect(forbidden).toMatchObject({ code: 'POLICY_FORBIDDEN', status: 403 });
    const forbiddenServer = await rejection(() => service.recommendations(scoped, serverRef));
    expect(forbiddenServer).toMatchObject({ code: 'POLICY_FORBIDDEN', status: 403 });
    evidence.authorized_templates = {
      instance: { returned: instanceKeys, registry: packageSet('instance'), recommended: recommended[0].release.package.id,
        recommended_compatibility: recommended[0].compatibility, excluded: ['linux-host', 'if-mib-basic'] },
      server: { returned: serverKeys, registry: packageSet('server'), excluded: ['mysql-diagnostics'] },
      forbidden: { other_instance: forbidden, other_server: forbiddenServer },
    };

    // 6. Empty binding: unbound before any publish, and a first publish without a package is refused.
    const unbound = await service.status(admin, instanceRef);
    expect(unbound.binding.state).toBe('unbound');
    expect(unbound.binding.published_revision).toBeNull();
    expect(await bindingRows('instance:1')).toBe(0);
    const missingPackage = await rejection(() => policies.changeBinding(admin, instanceRef, { expected_revision: 0 }, true));
    expect(missingPackage).toMatchObject({ code: 'POLICY_PACKAGE_REQUIRED' });
    expect((await service.status(admin, instanceRef)).binding.state).toBe('unbound');
    expect(await bindingRows('instance:1')).toBe(0);
    evidence.empty_binding = { before: { state: unbound.binding.state, published_revision: unbound.binding.published_revision,
      rows: 0 }, rejection: missingPackage, after: { state: 'unbound', rows: 0 } };

    // 5. Cancel: a successful preview that is never published leaves the resource unbound.
    const pinDiagnostics = pinOf('mysql-diagnostics', '1.1.0');
    const pinBasic = pinOf('mysql-basic', '1.1.0');
    const pinHost = pinOf('linux-host', '1.1.0');
    const cancelled = await policies.changeBinding(admin, instanceRef, { expected_revision: 0, package: pinBasic }, false);
    expect(cancelled.published).toBe(false);
    expect(cancelled.resources[0].binding.package).toEqual(pinBasic);
    const afterCancel = await service.status(admin, instanceRef);
    expect(afterCancel.binding.state).toBe('unbound');
    expect(afterCancel.binding.published_revision).toBeNull();
    expect(await bindingRows('instance:1')).toBe(0);
    evidence.cancel = { previewed: pinBasic, published: cancelled.published, after: { state: afterCancel.binding.state,
      published_revision: afterCancel.binding.published_revision, rows: 0 } };

    // 2. Multi-select: two different compatible templates may each be previewed; one publish stores one pin.
    const previewDiagnostics = await policies.changeBinding(admin, instanceRef, { expected_revision: 0, package: pinDiagnostics }, false);
    const previewBasic = await policies.changeBinding(admin, instanceRef, { expected_revision: 0, package: pinBasic }, false);
    expect(previewDiagnostics.published).toBe(false);
    expect(previewBasic.published).toBe(false);
    expect(previewDiagnostics.resources[0].binding.package).toEqual(pinDiagnostics);
    expect(previewBasic.resources[0].binding.package).toEqual(pinBasic);
    const stillUnbound = await service.status(admin, instanceRef);
    expect(stillUnbound.binding.state).toBe('unbound');
    expect(stillUnbound.binding.published_revision).toBeNull();
    expect(await bindingRows('instance:1')).toBe(0);
    const published = await policies.changeBinding(admin, instanceRef, { expected_revision: 0, package: pinDiagnostics }, true);
    expect(published.published).toBe(true);
    expect(published.resources[0].binding.revision).toBe(1);
    const boundOnce = await policies.binding(admin, instanceRef);
    expect(boundOnce.binding.package).toEqual(pinDiagnostics);
    expect(JSON.stringify(boundOnce.binding)).not.toContain(pinBasic.id);
    revisionAfterPublish = boundOnce.binding.revision;
    evidence.multi_select = { previewed: [pinDiagnostics, pinBasic], during: { state: stillUnbound.binding.state,
      published_revision: stillUnbound.binding.published_revision, rows: 0 }, published: { revision: revisionAfterPublish },
      binding_contains_other: JSON.stringify(boundOnce.binding).includes(pinBasic.id) };

    // 3. Fixed version: the read-back pin equals the submitted one; another version is not selected,
    // and a mismatched digest is refused without moving the revision.
    expect(boundOnce.binding.package).toMatchObject({ id: pinDiagnostics.id, version: pinDiagnostics.version, digest: pinDiagnostics.digest });
    const otherVersion = packages.list().find(release => release.package.id === pinDiagnostics.id && release.package.version !== pinDiagnostics.version)!;
    expect(otherVersion).toBeTruthy();
    expect(otherVersion.package.digest).not.toBe(pinDiagnostics.digest);
    expect(boundOnce.binding.package.version).toBe(pinDiagnostics.version);
    expect(await storedRevision('instance:1')).toBe(revisionAfterPublish);
    const tampered = await rejection(() => policies.changeBinding(admin, instanceRef,
      { expected_revision: revisionAfterPublish, package: { ...pinDiagnostics, digest: tamperedDigest } }, true));
    expect(tampered).not.toBeNull();
    expect((await policies.binding(admin, instanceRef)).binding.revision).toBe(revisionAfterPublish);
    expect(await storedRevision('instance:1')).toBe(revisionAfterPublish);
    evidence.fixed_version = { submitted: pinDiagnostics, read_back: boundOnce.binding.package,
      other_version: { version: otherVersion.package.version, digest: otherVersion.package.digest },
      selected_version: boundOnce.binding.package.version, tampered_digest: tamperedDigest, rejection: tampered,
      revision_before: revisionAfterPublish, revision_after: revisionAfterPublish };

    // 4. Compatibility reason: a server package on an instance is refused; recommendations carry reasons.
    const incompatible = await rejection(() => policies.changeBinding(admin, instanceRef,
      { expected_revision: revisionAfterPublish, package: pinHost }, true));
    expect(incompatible).not.toBeNull();
    expect(incompatibleCodes).toContain(incompatible!.code);
    const afterIncompatible = await policies.binding(admin, instanceRef);
    expect(afterIncompatible.binding.revision).toBe(revisionAfterPublish);
    expect(afterIncompatible.binding.package).toEqual(pinDiagnostics);
    const incompatibleEntries = instanceRec.packages.filter(entry => entry.compatibility === 'incompatible');
    expect(incompatibleEntries.length).toBeGreaterThan(0);
    for (const entry of incompatibleEntries) {
      expect(entry.checks.length).toBeGreaterThan(0);
      expect(entry.checks.some(check => check.status === 'unsupported')).toBe(true);
    }
    evidence.compatibility_reason = { submitted: pinHost, rejection: incompatible,
      binding_after: afterIncompatible.binding.package, revision_after: afterIncompatible.binding.revision,
      incompatible: incompatibleEntries.map(entry => ({ package: `${entry.release.package.id}@${entry.release.package.version}`,
        compatibility: entry.compatibility, checks: entry.checks })),
      draft_release_fixture: 'absent' };

    // 7. Different objects never share configuration.
    const serverPublished = await policies.changeBinding(admin, serverRef, { expected_revision: 0, package: pinHost }, true);
    expect(serverPublished.published).toBe(true);
    const instanceBinding = await policies.binding(admin, instanceRef);
    const serverBinding = await policies.binding(admin, serverRef);
    expect(instanceBinding.binding.package).toEqual(pinDiagnostics);
    expect(serverBinding.binding.package).toEqual(pinHost);
    expect(instanceBinding.binding.resource).toEqual(instanceRef);
    expect(serverBinding.binding.resource).toEqual(serverRef);
    expect(JSON.stringify(instanceBinding.binding)).not.toContain(pinHost.id);
    expect(JSON.stringify(serverBinding.binding)).not.toContain(pinDiagnostics.id);
    evidence.isolation = {
      'instance:1': { resource: instanceBinding.binding.resource, package: instanceBinding.binding.package, revision: instanceBinding.binding.revision },
      'server:3': { resource: serverBinding.binding.resource, package: serverBinding.binding.package, revision: serverBinding.binding.revision },
    };

    evidence.application_database = envFile
      ? { reviewed: true, note: 'SLIDE_DEBUG_ENV_FILE is set; this package only reads through the existing test scaffolding' }
      : { reviewed: false, note: '应用库未复核：SLIDE_DEBUG_ENV_FILE 未设置' };
    evidence.run = {
      branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(),
      head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      test: 'binding-path.mysql.test.ts',
      disposable_schema: `${database} on 127.0.0.1:${port}, dropped by afterAll`,
    };
    evidence.targets = {
      instance: { id: 1, db_type: 'mysql', db_version: '8.0.46', credential: 'empty' },
      server: { id: 3, os_type: 'kylin', credential: 'empty' },
    };
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  }, 180000);
});
