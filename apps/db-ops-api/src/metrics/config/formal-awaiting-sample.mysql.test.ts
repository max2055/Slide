import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parse } from 'dotenv';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { dbConnection, decryptData, encryptData } from '../../db-connection.js';
import { configurationInventory } from './inventory.js';
import { createConfigurationRegistry } from './registry.js';
import { createTrialStore } from './routes.js';
import { MetricConfigurationService } from './service.js';
import { configurationReader } from './status-store.js';
import { PolicyService } from '../policy/service.js';
import { MysqlPolicyStore } from '../policy/store.js';
import { admin } from '../policy/test-support.js';

/**
 * MAX-238 formal-awaiting-sample package. The disposable schema (METRICS_TEST_MYSQL_PORT) is
 * published through the existing PolicyService.changeBinding for two real targets (instance 1
 * mysql3306 and server 3 192.168.49.130:22), then the existing MetricConfigurationReader.status
 * (reached through MetricConfigurationService.status and configurationReader) is called exactly
 * once per resource. No worker runs and no collection is requested, proving:
 *
 *   1. formal_visibility.last_observed_at is null, freshness is 'unknown' and blockers contain
 *      AWAITING_SAMPLE;
 *   2. collection.state is not 'succeeded' (an additional APPLICATION_PENDING/disabled blocker is
 *      existing behaviour, not a failure of this package);
 *   3. the disposable schema still holds no stage='normalized' observation, so no pending state
 *      was rendered as a successful sample;
 *   4. each status names its own resource (instance:1 and server:3), so configurations are not
 *      shared across objects.
 *
 * The source application database is read with SELECT only; credentials are decrypted from the
 * existing rows and re-encrypted into the disposable copy. Live binding and asset rows are never
 * written.
 */
const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
const envFile = process.env.SLIDE_DEBUG_ENV_FILE;
const database = `max238_formal_awaiting_sample_${process.pid}`;
const instanceRef = { type: 'instance' as const, id: 1 };
const serverRef = { type: 'server' as const, id: 3 };

describe.skipIf(!port || !envFile)('MAX-238 awaiting the first sample never reads as healthy', () => {
  let root: Pool, pool: Pool, source: Pool;
  let packages: ReturnType<typeof createConfigurationRegistry>;
  let service: MetricConfigurationService;
  let configured: Record<string, string>;
  let poolSpy: ReturnType<typeof vi.spyOn>;
  const evidence: Record<string, unknown> = {};
  const query = async (target: Pool, sql: string, values: unknown[] = []) =>
    (await target.query<RowDataPacket[]>(sql, values as never))[0];
  const rows = (sql: string, values: unknown[] = []) => query(pool, sql, values);
  const one = async (sql: string, values: unknown[] = []) => (await rows(sql, values))[0];

  /** Read-only snapshot of exactly the facts this package must not change on the source. */
  const liveSnapshot = async () => {
    const instances = await query(source, 'SELECT COUNT(*) AS n FROM database_instances');
    const servers = await query(source, 'SELECT COUNT(*) AS n FROM servers');
    const server3 = await query(source, 'SELECT id, collection_enabled, host, port FROM servers WHERE id = 3');
    const bindings = await query(source,
      "SELECT resource_key, JSON_EXTRACT(payload,'$.binding.revision') AS revision FROM metric_policy_bindings WHERE resource_key IN ('instance:1','server:3') ORDER BY resource_key");
    return {
      database_instances: Number(instances[0].n),
      servers: Number(servers[0].n),
      server3: { id: Number(server3[0]?.id ?? 0), collection_enabled: Number(server3[0]?.collection_enabled ?? -1),
        host: String(server3[0]?.host ?? ''), port: Number(server3[0]?.port ?? 0) },
      bindings: bindings.map(row => ({ resource_key: String(row.resource_key), revision: Number(row.revision) })),
    };
  };
  const normalizedObservations = async () => Number((await one(
    "SELECT COUNT(*) AS n FROM metric_observations WHERE stage = 'normalized'"))!.n);

  beforeAll(async () => {
    configured = parse(readFileSync(envFile!));
    vi.stubEnv('ENCRYPTION_KEY', configured.ENCRYPTION_KEY);
    // Global collection is enabled so a pending state cannot hide behind a global switch.
    vi.stubEnv('METRICS_COLLECTION_ENABLED', 'true');
    // READ-ONLY source connection: every statement issued through it below is a SELECT.
    source = mysql.createPool({ host: configured.DB_HOST || '127.0.0.1', port: Number(configured.DB_PORT || 3306),
      user: configured.DB_USER || 'root', password: configured.DB_PASSWORD || '', database: configured.DB_NAME, connectionLimit: 4 });
    const [instance] = await query(source,
      'SELECT id,name,environment,db_type,host,port,username,password_encrypted,database_name,db_version,status,lifecycle_state FROM database_instances WHERE id = 1');
    const [server] = await query(source,
      'SELECT id,host,port,label,os_type,credential_type,credential_encrypted,host_key_fingerprint,status,collection_enabled FROM servers WHERE id = 3');
    // Pin the authorized targets, including ports, before any copy or status read.
    expect(instance).toMatchObject({ id: 1, name: 'mysql3306', port: 3306 });
    expect(server).toMatchObject({ id: 3, host: '192.168.49.130', port: 22 });
    const instancePassword = decryptData(String(instance.password_encrypted), configured.ENCRYPTION_KEY);
    const serverCredentials = JSON.parse(decryptData(String(server.credential_encrypted), configured.ENCRYPTION_KEY)) as { username: string; password?: string; privateKey?: string };
    expect(serverCredentials.username).toBeTruthy();
    expect(serverCredentials.password || serverCredentials.privateKey).toBeTruthy();

    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, connectionLimit: 20, timezone: 'Z' });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    poolSpy = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);

    await pool.execute(`INSERT INTO database_instances
      (id,name,environment,db_type,host,port,username,password_encrypted,database_name,db_version,status,lifecycle_state)
      VALUES (?,?,?,?,?,?,?,?,?,?,'active','available')`, [1, instance.name, instance.environment, instance.db_type,
      instance.host, instance.port, instance.username, encryptData(instancePassword, configured.ENCRYPTION_KEY),
      instance.database_name, instance.db_version]);
    await pool.execute(`INSERT INTO servers
      (id,host,port,label,os_type,credential_type,credential_encrypted,host_key_fingerprint,status,collection_enabled)
      VALUES (?,?,?,?,?,?,?,?,'online',?)`, [3, server.host, server.port, server.label, server.os_type, server.credential_type,
      encryptData(JSON.stringify(serverCredentials), configured.ENCRYPTION_KEY), server.host_key_fingerprint, server.collection_enabled]);

    packages = createConfigurationRegistry();
    const policies = new PolicyService(new MysqlPolicyStore(() => pool), packages,
      { exists: async () => true, inventory: configurationInventory });
    const pinOf = (id: string) => {
      const release = packages.list().find(r => r.package.id === id && r.package.version === '1.1.0');
      expect(release, `${id}@1.1.0 must be installed`).toBeTruthy();
      return { id: release!.package.id, version: release!.package.version, digest: release!.package.digest };
    };
    // Publish the existing packages through the normal policy path; no collection is requested.
    await policies.changeBinding(admin, instanceRef, { expected_revision: 0, package: pinOf('mysql-diagnostics') }, true);
    await policies.changeBinding(admin, serverRef, { expected_revision: 0, package: pinOf('linux-host') }, true);

    service = new MetricConfigurationService(policies, packages, createTrialStore(() => pool, packages),
      { resolve: async () => { throw new Error('status must not collect'); } }, configurationReader(() => pool));
  }, 180000);

  afterAll(async () => {
    poolSpy?.mockRestore();
    await source?.end();
    await pool?.end();
    if (root) {
      await root.query(`DROP DATABASE IF EXISTS ${database}`);
      await root.end();
    }
    vi.unstubAllEnvs();
  }, 60000);

  it('reports awaiting sample without a healthy state, a sample or a crossed resource', async () => {
    const before = await liveSnapshot();
    // The authorized source baseline this package must leave untouched.
    expect(before).toEqual({ database_instances: 5, servers: 1,
      server3: { id: 3, collection_enabled: 1, host: '192.168.49.130', port: 22 },
      bindings: [{ resource_key: 'instance:1', revision: 4 }, { resource_key: 'server:3', revision: 3 }] });
    const observationsBefore = await normalizedObservations();
    expect(observationsBefore).toBe(0);

    const resources = [
      { ref: instanceRef, package: 'mysql-diagnostics', expected: { type: 'instance', id: 1 } },
      { ref: serverRef, package: 'linux-host', expected: { type: 'server', id: 3 } },
    ] as const;
    const proof: Record<string, Record<string, unknown>> = {};
    for (const { ref, package: packageId, expected } of resources) {
      const key = `${ref.type}:${ref.id}`;
      const status = await service.status(admin, ref);
      // 1. No sample yet: null observation time, unknown freshness, AWAITING_SAMPLE blocker.
      expect(status.formal_visibility.last_observed_at, `${key} must not report an observation time`).toBeNull();
      expect(status.formal_visibility.freshness).toBe('unknown');
      expect(status.formal_visibility.state).not.toBe('available');
      expect(status.blockers).toContain('AWAITING_SAMPLE');
      // 2. A pending configuration is not a succeeded collection. Extra existing blockers are
      // reported, not treated as this package's failure.
      expect(status.effective_enabled.enabled).toBe(true);
      expect(status.binding.state).toBe('bound');
      expect(status.binding.package).toMatchObject({ id: packageId, version: '1.1.0' });
      expect(status.binding.application).toBe('pending');
      expect(status.collection.last_attempt_at).toBeNull();
      expect(status.collection.last_success_at).toBeNull();
      expect(status.collection.state).not.toBe('succeeded');
      expect(status.collection.state).toBe('pending');
      // 4. Each status names its own resource and its own pinned package; nothing is shared.
      expect(status.resource).toEqual(expected);
      proof[key] = { package: packageId, resource: status.resource, binding: status.binding,
        effective_enabled: status.effective_enabled, collection: status.collection,
        formal_visibility: status.formal_visibility, blockers: status.blockers,
        coverage_unknown: status.coverage.filter(metric => metric.state === 'unknown').length };
    }
    // Distinct resources: one status per target, never the same object twice.
    expect(new Set(Object.values(proof).map(entry => JSON.stringify(entry.resource))).size).toBe(2);
    // 3. No successful sample was written by the status read.
    const observationsAfter = await normalizedObservations();
    expect(observationsAfter).toBe(0);
    const publications = Number((await one('SELECT COUNT(*) AS n FROM metric_publications'))!.n);
    const attempts = Number((await one('SELECT COUNT(*) AS n FROM metric_attempts'))!.n);
    const schedules = Number((await one('SELECT COUNT(*) AS n FROM metric_schedule'))!.n);
    expect({ publications, attempts, schedules }).toEqual({ publications: 0, attempts: 0, schedules: 0 });

    // Only the disposable schema held rows; the source stays identical.
    const after = await liveSnapshot();
    expect(after).toEqual(before);
    evidence.readonly = { pre: before, post: after, unchanged: true };
    evidence.statuses = proof;
    evidence.disposable = { normalized_observations_before: observationsBefore,
      normalized_observations_after: observationsAfter, publications, attempts, schedules };
    evidence.run = { branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(),
      head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), test: 'formal-awaiting-sample.mysql.test.ts',
      disposable_schema: `${database} on 127.0.0.1:${port}, dropped by afterAll` };
    evidence.targets = { instance: { id: 1, name: 'mysql3306', host: 'localhost', port: 3306 },
      server: { id: 3, host: '192.168.49.130', port: 22 } };
    writeFileSync(new URL('../../../../../docs/slide/development/MAX-238/formal-awaiting-sample-20261027.json', import.meta.url),
      JSON.stringify(evidence, null, 2) + '\n');
  }, 180000);
});
