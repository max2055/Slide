import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { dbConnection, encryptData } from '../../db-connection.js';
import { instanceDatabaseService } from '../../instance-database-service.js';
import { configurationInventory } from './inventory.js';
import { createConfigurationRegistry } from './registry.js';
import { createTrialStore } from './routes.js';
import { MetricConfigurationService } from './service.js';
import { configurationReader } from './status-store.js';
import { PolicyService } from '../policy/service.js';
import { MysqlPolicyStore } from '../policy/store.js';
import { admin } from '../policy/test-support.js';

/**
 * MAX-238 recovery-path package. On a disposable schema (METRICS_TEST_MYSQL_PORT) this exercises the
 * existing recommendations reader, the existing PolicyService.changeBinding and the existing
 * getInstancePassword against one real resource row (instance 1, mysql 8.0.46, active + available),
 * proving the acceptance sentence "a missing template or credential has a recoverable path".
 *
 * The product pins exactly one package per resource; this package neither stores several templates
 * nor changes the activation predicate. No real host is contacted: activate, trial,
 * databaseService.getConnection and every socket transport are never called, so the row's host and
 * port stay inert metadata and 3306 is never a connection target.
 */
const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
const database = `max238_recovery_path_${process.pid}`;
const instanceRef = { type: 'instance' as const, id: 1 };
const evidencePath = fileURLToPath(new URL('../../../../../docs/slide/development/MAX-238/recovery-path-20261028.json', import.meta.url));

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

describe.skipIf(!port)('MAX-238 a missing template or credential has a recoverable path', () => {
  let root: Pool, pool: Pool;
  let packages: ReturnType<typeof createConfigurationRegistry>;
  let policies: PolicyService;
  let service: MetricConfigurationService;
  let poolSpy: ReturnType<typeof vi.spyOn>;
  // Synthetic fixture only: generated per run, never printed, never written to any file or evidence.
  const fixtureSecret = randomBytes(16).toString('hex');
  const query = async (target: Pool, sql: string, values: unknown[] = []) =>
    (await target.query<RowDataPacket[]>(sql, values as never))[0];
  const rows = (sql: string, values: unknown[] = []) => query(pool, sql, values);
  const one = async (sql: string, values: unknown[] = []) => (await rows(sql, values))[0];
  const bindingRows = async (key: string) =>
    Number((await one('SELECT COUNT(*) AS n FROM metric_policy_bindings WHERE resource_key = ?', [key]))!.n);
  const auditCount = async (key: string) =>
    Number((await one('SELECT COUNT(*) AS n FROM metric_policy_audit WHERE target = ?', [key]))!.n);
  const storedCredential = async () =>
    String((await one('SELECT password_encrypted FROM database_instances WHERE id = 1'))!.password_encrypted ?? '');

  beforeAll(async () => {
    // The credential clause decrypts with the same process key. Only set a throwaway key when the
    // process has none; it stays in memory for this run and is never persisted.
    if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, connectionLimit: 20, timezone: 'Z' });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    poolSpy = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);

    // One authorized resource row with a blank credential column. Nothing dials its host or port.
    await pool.execute(`INSERT INTO database_instances
      (id,name,environment,db_type,host,port,username,password_encrypted,database_name,db_version,status,lifecycle_state)
      VALUES (1,'recovery-fixture','production','mysql','127.0.0.1',3306,'fixture','','fixture','8.0.46','active','available')`);

    packages = createConfigurationRegistry();
    policies = new PolicyService(new MysqlPolicyStore(() => pool), packages,
      { exists: async () => true, inventory: configurationInventory });
    service = new MetricConfigurationService(policies, packages, createTrialStore(() => pool, packages),
      { resolve: async () => { throw new Error('recovery path must not collect'); } }, configurationReader(() => pool));
  }, 180000);

  afterAll(async () => {
    poolSpy?.mockRestore();
    await pool?.end();
    if (root) {
      await root.query(`DROP DATABASE IF EXISTS ${database}`);
      await root.end();
    }
  }, 60000);

  it('proves both recovery clauses on the disposable schema', async () => {
    const evidence: Record<string, unknown> = {};
    try {
      // 1. Missing template: the resource is unbound, a publish without a package is refused, the
      // recommendations list still offers the real published release, and that pin then publishes.
      const initial = await service.status(admin, instanceRef);
      expect(initial.binding.state).toBe('unbound');
      expect(initial.binding.published_revision).toBeNull();
      expect(await bindingRows('instance:1')).toBe(0);

      const firstRec = await service.recommendations(admin, instanceRef);
      const compatible = firstRec.packages.filter(entry => entry.compatibility === 'compatible');
      expect(compatible.length).toBeGreaterThan(0);
      const chosen = compatible[0].release.package;
      const realPin = { id: chosen.id, version: chosen.version, digest: chosen.digest };
      // The pin comes from the returned list, and it is the registry's own release, not a fixture.
      const registryRelease = packages.list().find(release =>
        release.package.id === realPin.id && release.package.version === realPin.version);
      expect(registryRelease?.package.digest).toBe(realPin.digest);

      const auditBefore = await auditCount('instance:1');
      const missingPackage = await rejection(() => policies.changeBinding(admin, instanceRef, { expected_revision: 0 }, true));
      expect(missingPackage).toMatchObject({ code: 'POLICY_PACKAGE_REQUIRED' });
      expect(await bindingRows('instance:1')).toBe(0);
      expect(await auditCount('instance:1')).toBe(auditBefore);
      expect((await service.status(admin, instanceRef)).binding.state).toBe('unbound');

      const secondRec = await service.recommendations(admin, instanceRef);
      const stillOffered = secondRec.packages.some(entry => entry.release.package.id === realPin.id
        && entry.release.package.version === realPin.version && entry.release.package.digest === realPin.digest);
      expect(stillOffered).toBe(true);

      const published = await policies.changeBinding(admin, instanceRef, { expected_revision: 0, package: realPin }, true);
      expect(published.published).toBe(true);
      const bound = await policies.binding(admin, instanceRef);
      expect(bound.binding.package).toEqual(realPin);
      expect(bound.binding.revision).toBe(1);
      expect(await bindingRows('instance:1')).toBe(1);
      evidence.missing_template = {
        before: { state: initial.binding.state, published_revision: initial.binding.published_revision, rows: 0 },
        chosen: realPin,
        compatible_offered: compatible.map(entry => `${entry.release.package.id}@${entry.release.package.version}`),
        rejection: missingPackage,
        after_rejection: { rows: 0, audit_unchanged: true, state: 'unbound', still_offered: stillOffered },
        published: { revision: bound.binding.revision, read_back: bound.binding.package, rows: 1 },
      };

      // 2. Missing credential: a blank stored credential reads as the empty string (not a decrypt
      // failure), the pin and revision survive, and filling the credential in this disposable row
      // makes the same binding continue with no republish.
      const beforeRevision = bound.binding.revision;
      const blank = await instanceDatabaseService.getInstancePassword(1);
      expect(blank).toBe('');
      const beforeCredential = await policies.binding(admin, instanceRef);
      expect(beforeCredential.binding.package).toEqual(realPin);
      expect(beforeCredential.binding.revision).toBe(beforeRevision);
      const credentialWasBlank = (await storedCredential()) === '';

      // Write the encrypted fixture onto this disposable row only; encryptData and getInstancePassword
      // share the same in-process key. Nothing secret is printed or written to evidence.
      await pool.execute('UPDATE database_instances SET password_encrypted = ? WHERE id = 1', [encryptData(fixtureSecret)]);
      const filled = await instanceDatabaseService.getInstancePassword(1);
      const recovered = typeof filled === 'string' && filled.length > 0 && filled === fixtureSecret;
      expect(recovered).toBe(true);
      const afterCredential = await policies.binding(admin, instanceRef);
      expect(afterCredential.binding.package).toEqual(realPin);
      expect(afterCredential.binding.revision).toBe(beforeRevision);
      expect(await bindingRows('instance:1')).toBe(1);
      evidence.missing_credential = {
        credential_before: credentialWasBlank ? 'blank' : 'present',
        reading_before: blank === '' ? 'empty_string' : 'unexpected',
        binding_before: { package: beforeCredential.binding.package, revision: beforeCredential.binding.revision },
        credential_after: 'present',
        reading_after: recovered ? 'non_empty_and_matches_fixture' : 'mismatch',
        binding_after: { package: afterCredential.binding.package, revision: afterCredential.binding.revision, rows: 1 },
        republish_required: false,
      };
    } catch (error) {
      const caught = error as { name?: string; message?: string };
      evidence.error = {
        name: caught.name ?? 'Error',
        message: String(caught.message ?? error).split(fixtureSecret).join('[redacted]'),
      };
      throw error;
    } finally {
      evidence.run = {
        branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(),
        head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        test: 'recovery-path.mysql.test.ts',
        disposable_schema: `${database} on 127.0.0.1:${port}, dropped by afterAll`,
        resource: { id: 1, db_type: 'mysql', db_version: '8.0.46', status: 'active', lifecycle_state: 'available', credential: 'blank at start' },
      };
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
    }
  }, 180000);
});
