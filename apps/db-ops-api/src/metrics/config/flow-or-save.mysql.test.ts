import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { dbConnection, decryptData, encryptData } from '../../db-connection.js';
import { databaseService } from '../../database-service.js';
import { configurationInventory } from './inventory.js';
import { createConfigurationRegistry } from './registry.js';
import { createTrialStore } from './routes.js';
import { MetricConfigurationService } from './service.js';
import { createAssetCollectorAccess } from './access.js';
import { configurationReader } from './status-store.js';
import { PolicyService } from '../policy/service.js';
import { MysqlPolicyStore } from '../policy/store.js';
import { admin } from '../policy/test-support.js';

/**
 * MAX-238 flow-or-save package. On a disposable schema (METRICS_TEST_MYSQL_PORT) this exercises the
 * existing recommendations reader, PolicyService.changeBinding, MetricConfigurationService.status,
 * trialCurrent/trial and activate against two different resource rows, proving the acceptance
 * sentence "the flow is bind→check→test→apply-and-enable, and a save without enabling is also
 * possible".
 *
 * Instance 1 (id 1) is saved with overrides.enabled='disable' and never trialled, activated or
 * connected. Instance 2 (id 2) copies the existing managed target's row (name mysql3306, port 3306)
 * into the disposable schema and runs the existing read-only trial + activate through
 * createAssetCollectorAccess, which issues only read-only statements to the target.
 *
 * The product still pins one package per resource; this package neither stores several templates
 * nor changes the activation predicate, the status blocker enum or the required-metric list.
 */
const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
const envFile = process.env.SLIDE_DEBUG_ENV_FILE;
const database = `max238_flow_or_save_${process.pid}`;
const savedRef = { type: 'instance' as const, id: 1 };
const flowRef = { type: 'instance' as const, id: 2 };
const evidencePath = fileURLToPath(new URL('../../../../../docs/slide/development/MAX-238/flow-or-save-20261028.json', import.meta.url));
const formalTables = ['alerts', 'alert_events', 'notification_records', 'metric_publications'] as const;

describe.skipIf(!port || !envFile)('MAX-238 a resource can be saved without enabling, or bound→checked→tested→applied', () => {
  let root: Pool, pool: Pool, source: Pool;
  let packages: ReturnType<typeof createConfigurationRegistry>;
  let policies: PolicyService;
  let service: MetricConfigurationService;
  let configured: Record<string, string>;
  let poolSpy: ReturnType<typeof vi.spyOn>;
  let target: { id: number; name: string; host: string; port: number; username: string; database_name: string | null };
  let targetPassword = '';
  let targetVersion = '';
  const evidence: Record<string, unknown> = {};
  const query = async (target: Pool, sql: string, values: unknown[] = []) =>
    (await target.query<RowDataPacket[]>(sql, values as never))[0];
  const rows = (sql: string, values: unknown[] = []) => query(pool, sql, values);
  const one = async (sql: string, values: unknown[] = []) => (await rows(sql, values))[0];
  const bindingRows = async (key: string) =>
    Number((await one('SELECT COUNT(*) AS n FROM metric_policy_bindings WHERE resource_key = ?', [key]))!.n);
  const count = async (sql: string) => Number((await one(sql))!.n);
  /** Formal history, publications and alert rows that neither clause may create. */
  const formalRows = async () => {
    const counts: Record<string, number> = { metric_observations: await count('SELECT COUNT(*) AS n FROM metric_observations') };
    for (const table of formalTables) counts[table] = await count(`SELECT COUNT(*) AS n FROM ${table}`);
    return counts;
  };
  const zeroRows = () => ({ metric_observations: 0, alerts: 0, alert_events: 0, notification_records: 0, metric_publications: 0 });
  /** Read-only snapshot of the facts this package must not change on the source database. */
  const liveSnapshot = async () => {
    const instances = await query(source, 'SELECT COUNT(*) AS n FROM database_instances');
    const servers = await query(source, 'SELECT COUNT(*) AS n FROM servers');
    const binding = await query(source,
      "SELECT resource_key, JSON_EXTRACT(payload,'$.binding.revision') AS revision FROM metric_policy_bindings WHERE resource_key = 'instance:1'");
    const tempSchemas = await query(source, "SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'max238%'");
    return {
      database_instances: Number(instances[0].n), servers: Number(servers[0].n),
      instance1_binding: binding.map(row => ({ resource_key: String(row.resource_key), revision: Number(row.revision) })),
      max238_schemas: Number(tempSchemas[0].n),
    };
  };
  const pinOf = (release: { package: { id: string; version: string; digest: string } }) =>
    ({ id: release.package.id, version: release.package.version, digest: release.package.digest });

  beforeAll(async () => {
    configured = parse(readFileSync(envFile!));
    vi.stubEnv('ENCRYPTION_KEY', configured.ENCRYPTION_KEY);
    // Global collection is enabled so a policy-disabled state cannot hide behind a global switch.
    vi.stubEnv('METRICS_COLLECTION_ENABLED', 'true');
    // READ-ONLY source connection: every statement issued through it below is a SELECT.
    source = mysql.createPool({ host: configured.DB_HOST || '127.0.0.1', port: Number(configured.DB_PORT || 3306),
      user: configured.DB_USER || 'root', password: configured.DB_PASSWORD || '', database: configured.DB_NAME, connectionLimit: 4 });
    const [row] = await query(source,
      'SELECT id,name,environment,db_type,host,port,username,password_encrypted,database_name,db_version,status,lifecycle_state FROM database_instances WHERE id = 1');
    target = row as typeof target;
    // The authorized managed target, pinned before any copy or connection.
    expect(target).toMatchObject({ id: 1, name: 'mysql3306', port: 3306, status: 'active', lifecycle_state: 'available' });
    const [version] = await query(source, 'SELECT VERSION() AS version');
    targetVersion = String(version.version);
    // Copy the credential into this package's disposable instance 2 only; never print or store it.
    targetPassword = decryptData(String(row.password_encrypted), configured.ENCRYPTION_KEY);
    expect(typeof targetPassword === 'string' && targetPassword.length > 0).toBe(true);

    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, connectionLimit: 20, timezone: 'Z' });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    poolSpy = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);

    // Instance 1 only ever holds a saved binding: blank credential, no target connection.
    await pool.execute(`INSERT INTO database_instances
      (id,name,environment,db_type,host,port,username,password_encrypted,database_name,db_version,status,lifecycle_state)
      VALUES (1,'flow-save-only','production','mysql','127.0.0.1',3306,'fixture','','fixture','8.0.46','active','available')`);
    // Instance 2 is the managed mysql3306 target copied into the disposable schema.
    await pool.execute(`INSERT INTO database_instances
      (id,name,environment,db_type,host,port,username,password_encrypted,database_name,db_version,status,lifecycle_state)
      VALUES (2,'mysql3306','production','mysql',?,3306,?,?,?,?, 'active','available')`,
      [target.host, target.username, encryptData(targetPassword, configured.ENCRYPTION_KEY), target.database_name || 'mysql', '8.0.46']);

    packages = createConfigurationRegistry();
    policies = new PolicyService(new MysqlPolicyStore(() => pool), packages,
      { exists: async () => true, inventory: configurationInventory });
    service = new MetricConfigurationService(policies, packages, createTrialStore(() => pool, packages),
      createAssetCollectorAccess(), configurationReader(() => pool));
  }, 180000);

  afterAll(async () => {
    poolSpy?.mockRestore();
    await databaseService.removeConnection(2);
    await source?.end();
    await pool?.end();
    if (root) {
      await root.query(`DROP DATABASE IF EXISTS ${database}`);
      await root.end();
    }
    vi.unstubAllEnvs();
  }, 60000);

  it('saves without enabling, then binds, checks, trials, applies and enables the other resource', async () => {
    const sourceBefore = await liveSnapshot();
    try {
      // 1. Save without enabling: publish a real pin from recommendations with an explicit disable
      // override, then only read status. No trial, activate or target connection for instance 1.
      const initial = await service.status(admin, savedRef);
      expect(initial.binding.state).toBe('unbound');
      expect(initial.binding.published_revision).toBeNull();
      expect(await bindingRows('instance:1')).toBe(0);
      const savedRec = await service.recommendations(admin, savedRef);
      const savedCompatible = savedRec.packages.filter(entry => entry.compatibility === 'compatible');
      expect(savedCompatible.length).toBeGreaterThan(0);
      const savedPin = pinOf(savedCompatible[0].release);
      expect(packages.list().some(release => release.package.id === savedPin.id
        && release.package.version === savedPin.version && release.package.digest === savedPin.digest)).toBe(true);

      const saved = await policies.changeBinding(admin, savedRef,
        { expected_revision: 0, package: savedPin, overrides: { enabled: 'disable' } }, true);
      expect(saved.published).toBe(true);
      expect(saved.resources[0].binding.revision).toBe(1);
      const savedReadBack = await policies.binding(admin, savedRef);
      expect(savedReadBack.binding.package).toEqual(savedPin);
      expect(savedReadBack.binding.revision).toBe(1);
      expect(await bindingRows('instance:1')).toBe(1);
      const savedStatus = await service.status(admin, savedRef);
      expect(savedStatus.binding.state).toBe('bound');
      expect(savedStatus.binding.package).toMatchObject(savedPin);
      expect(savedStatus.binding.published_revision).toBe(1);
      expect(savedStatus.binding.applied_revision).toBeNull();
      expect(savedStatus.binding.application).toBe('pending');
      expect(savedStatus.effective_enabled.policy_enabled).toBe(false);
      expect(savedStatus.effective_enabled.enabled).toBe(false);
      expect(savedStatus.effective_enabled.source).toBe('resource');
      expect(savedStatus.collection.state).toBe('disabled');
      const savedFormalRows = await formalRows();
      expect(savedFormalRows).toEqual(zeroRows());
      evidence.save_only = {
        resource: 'instance:1',
        before: { state: initial.binding.state, published_revision: initial.binding.published_revision, rows: 0 },
        pin: savedPin,
        overrides: { enabled: 'disable' },
        read_back: { revision: savedReadBack.binding.revision, pin: savedReadBack.binding.package, rows: 1 },
        status: { binding_state: savedStatus.binding.state, published_revision: savedStatus.binding.published_revision,
          applied_revision: savedStatus.binding.applied_revision, application: savedStatus.binding.application,
          policy_enabled: savedStatus.effective_enabled.policy_enabled, effective_enabled: savedStatus.effective_enabled.enabled,
          source: savedStatus.effective_enabled.source, collection_state: savedStatus.collection.state },
        formal_rows: savedFormalRows,
        target_contacted: false,
      };

      // 2. Bind→check→test→apply-and-enable on instance 2, whose protected credential is copied into
      // the disposable schema. The target receives the existing collector's read-only statements.
      const flowRec = await service.recommendations(admin, flowRef);
      const flowCompatible = flowRec.packages.filter(entry => entry.compatibility === 'compatible'
        && entry.release.package.id !== savedPin.id);
      expect(flowCompatible.length).toBeGreaterThan(0);
      const flowPin = pinOf(flowCompatible[0].release);
      expect(await databaseService.addConnection(2, 'MAX238 flow target', { host: target.host, port: target.port,
        user: target.username, password: targetPassword, database: target.database_name || 'mysql', db_type: 'mysql' })).toBe(true);

      const published = await policies.changeBinding(admin, flowRef, { expected_revision: 0, package: flowPin }, true);
      expect(published.published).toBe(true);
      expect(published.resources[0].binding.revision).toBe(1);
      expect(await bindingRows('instance:2')).toBe(1);
      const check = await service.status(admin, flowRef);
      expect(check.binding.state).toBe('bound');
      expect(check.binding.package).toMatchObject(flowPin);
      expect(check.binding.published_revision).toBe(1);
      expect(check.binding.applied_revision).toBeNull();
      expect(check.binding.application).toBe('pending');
      expect(check.effective_enabled.policy_enabled).toBe(true);
      expect(check.effective_enabled.enabled).toBe(true);
      expect(check.collection.state).toBe('pending');
      const checkFormalRows = await formalRows();
      expect(checkFormalRows).toEqual(zeroRows());

      const trialRevision = check.binding.published_revision!;
      const trial = await service.trial(admin, flowRef, { expected_revision: trialRevision, package: flowPin });
      expect(trial.persisted).toBe(false);
      expect(trial.samples.length + trial.attempts.length).toBeGreaterThan(0);
      const goodSamples = trial.samples.filter(sample => sample.value !== null && sample.quality.status === 'good');
      const trialFormalRows = await formalRows();
      expect(trialFormalRows).toEqual(zeroRows());

      let activated: Awaited<ReturnType<MetricConfigurationService['activate']>> | null = null;
      let activationError: { code: string | null; message: string } | null = null;
      try {
        activated = await service.activate(admin, flowRef, { expected_revision: trialRevision, package: flowPin });
      } catch (error) {
        const caught = error as { code?: string; message?: string };
        activationError = { code: caught.code ?? null, message: String(caught.message ?? error) };
      }
      let finalBinding: Awaited<ReturnType<PolicyService['binding']>> | null = null;
      if (activated) {
        expect(activated.published).toBe(true);
        finalBinding = await policies.binding(admin, flowRef);
        expect(finalBinding.binding.package).toEqual(flowPin);
        expect(finalBinding.binding.revision).toBeGreaterThan(trialRevision);
        expect(await bindingRows('instance:2')).toBe(1);
      }
      // The saved-without-enabling binding is untouched by the other resource's flow.
      const savedStill = await policies.binding(admin, savedRef);
      const savedRowsStill = await bindingRows('instance:1');
      expect(savedStill.binding.package).toEqual(savedPin);
      expect(savedStill.binding.revision).toBe(1);
      expect(savedStill.binding.overrides.enabled).toBe('disable');
      expect(savedRowsStill).toBe(1);
      const finalFormalRows = await formalRows();
      expect(finalFormalRows).toEqual(zeroRows());
      evidence.flow = {
        resource: 'instance:2',
        target: { name: 'mysql3306', host: target.host, port: target.port, server_version: targetVersion,
          disposable_row_db_version: '8.0.46' },
        pin: flowPin,
        check: { binding_state: check.binding.state, published_revision: check.binding.published_revision,
          applied_revision: check.binding.applied_revision, application: check.binding.application,
          policy_enabled: check.effective_enabled.policy_enabled, effective_enabled: check.effective_enabled.enabled,
          collection_state: check.collection.state, formal_rows: checkFormalRows },
        trial: { persisted: trial.persisted, decision: trial.decision, error: 'error' in trial ? trial.error ?? null : null,
          good_samples: goodSamples.length, sample_count: trial.samples.length,
          attempt_statuses: trial.attempts.map(attempt => attempt.status), formal_rows: trialFormalRows },
        activation: activated && finalBinding
          ? { published: activated.published, revision: finalBinding.binding.revision, pin: finalBinding.binding.package,
            rows: await bindingRows('instance:2') }
          : { published: null, error_code: activationError?.code ?? null, error_message: activationError?.message ?? null },
        saved_instance: { pin: savedStill.binding.package, revision: savedStill.binding.revision,
          overrides: savedStill.binding.overrides, rows: savedRowsStill },
        formal_rows_after: finalFormalRows,
      };

      // The source database was read with SELECT only and the live configuration is unchanged.
      const sourceAfter = await liveSnapshot();
      expect(sourceAfter).toEqual(sourceBefore);
      evidence.readonly = { pre: sourceBefore, post: sourceAfter, unchanged: true };
      // A missing good sample must stop the flow here instead of being turned into a pass.
      expect(activationError, `activation failed: ${activationError?.code}`).toBeNull();
    } catch (error) {
      const caught = error as { name?: string; message?: string };
      evidence.error = { name: caught.name ?? 'Error', message: String(caught.message ?? error) };
      throw error;
    } finally {
      evidence.run = {
        branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(),
        head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        test: 'flow-or-save.mysql.test.ts',
        disposable_schema: `${database} on 127.0.0.1:${port}, dropped by afterAll`,
        source_selected: 'SELECT only; no INSERT/UPDATE/DELETE on the application database',
        formal_tables: ['metric_observations', ...formalTables],
      };
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
    }
  }, 180000);
});
