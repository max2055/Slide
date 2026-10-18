/** Exclusive local schema + synthetic SSH; original production SQL, policy,
 * scheduler, adapters, formalization, alert evaluator and event admission.
 * No source/result/evidence rows are inserted as test enrichment. */
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import { dbConnection } from '../../db-connection.js';
import { createConfigurationRegistry } from '../../metrics/config/registry.js';
import { PolicyService } from '../../metrics/policy/service.js';
import { MysqlPolicyStore } from '../../metrics/policy/store.js';
import { admin } from '../../metrics/policy/test-support.js';
import type { Resource } from '../../contracts/metrics/index.js';
import type { CollectorAccess } from '../../metrics/scheduler/service.js';
import { sourceTestConfig } from './config.fixture.js';
import { SourceControl } from './control.js';
import { collectSource, evaluateSource, assertSourceInventory, sourceHostClock } from './runtime.js';

const port = Number(process.env.V23_SOURCE_TEST_MYSQL_PORT ?? 0);
describe.skipIf(!port)('source package production orchestration (synthetic SSH/local SQL)', () => {
  const database = `slide_v23_source_${randomBytes(8).toString('hex')}`;
  let root: Pool, pool: Pool;
  const config = () => ({ ...sourceTestConfig(), database, maxMetricJobs: 8 });
  const rows = async (sql: string, values: any[] = []) => (await pool.execute<RowDataPacket[]>(sql, values))[0];
  const inventory = (type: 'server' | 'instance', id: number): Resource => ({ type, id: String(id), attributes:
    Object.fromEntries(Object.entries(type === 'server' ? { 'os.family': 'linux' } : { 'db.engine': 'mysql', 'db.version': '9.6.0' })
      .map(([key, value]) => [key, { value, observed_at: new Date().toISOString(), source: 'synthetic_transport' }])) });
  const sample = JSON.parse(readFileSync(new URL('../../../../../docs/slide/metrics-v2/host/fixtures.json', import.meta.url), 'utf8')).samples[0];
  const access: CollectorAccess = { resolve: async ref => ({ resource: inventory(ref.type as 'server' | 'instance', ref.id),
    credential_ref: 'credential:synthetic-local-only', evidence: {}, resolve: async () => ref.type === 'server'
      ? { method: 'ssh', client: {} as never, pool: { execCommands: async (_client, commands) => commands.map(command => {
        let stdout: string;
        if (command === 'date -u +%s%3N') stdout = String(Date.now());
        else if (command.includes('df -P -B1')) stdout = sample.filesystem.bytes;
        else if (command.includes('df -Pi')) stdout = sample.filesystem.inodes;
        else if (command.includes('findmnt')) stdout = sample.filesystem.mounts;
        else throw new Error('unexpected synthetic SSH command');
        return { stdout, stderr: '', exitCode: 0, signal: null, truncated: false };
      }) } }
      : { method: 'sql', pool: { query: options => root.query(options) } } }) };
  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', timezone: 'Z' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, timezone: 'Z', connectionLimit: 16 });
    pool.on('connection', c => c.query("SET time_zone='+00:00'"));
    await new MigrationRunner(pool).run(); await new MigrationRunner(pool).run();
    vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    vi.spyOn(dbConnection, 'isConnected').mockReturnValue(true);
    await rows("INSERT INTO users(id,username,password_hash) VALUES(101,'source-synthetic-operator','no-login'),(102,'slide-investigation-source','!slide-investigation-no-login!')");
    await rows("INSERT INTO roles(id,name) VALUES(101,'source-synthetic-admin'),(102,'source-synthetic-service')");
    await rows('INSERT INTO role_permissions(role_id,permission_id) SELECT 101,id FROM permissions');
    await rows("INSERT INTO role_permissions(role_id,permission_id) SELECT 102,id FROM permissions WHERE code IN ('chat:view','instance:view','servers:view','metric:view','alert:view','config:view')");
    await rows('INSERT INTO user_roles(user_id,role_id) VALUES(101,101),(102,102)');
    await rows("INSERT INTO servers(id,host,port,label,credential_type,credential_encrypted,host_key_fingerprint,os_type,collection_enabled) VALUES(3,'192.168.49.130',22,'synthetic only','password','unused',?,'rhel',1)", [config().target.hostFingerprint]);
    await rows("INSERT INTO database_instances(id,name,host,port,username,password_encrypted,db_type,status) VALUES(101,'local only','127.0.0.1',3308,'unused','unused','mysql','active')");
    await rows("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(101,101,'read-write'),(102,101,'read-only')");
    const packages = createConfigurationRegistry();
    const policies = new PolicyService(new MysqlPolicyStore(() => pool), packages,
      { exists: async () => true, inventory: async ref => inventory(ref.type as 'server' | 'instance', ref.id) });
    for (const [type, id, packageId, version] of [['server', 3, 'linux-host', '1.0.0'], ['instance', 101, 'mysql-basic', '2.0.0']] as const) {
      const release = packages.list().find(p => p.package.id === packageId && p.package.version === version)!;
      const pin = release.package;
      const metrics = type === 'server' ? Object.fromEntries(pin.collectors.flatMap(c => c.mappings)
        .filter(m => !['host.filesystem.used_bytes', 'host.filesystem.size_bytes', 'linux.filesystem.used_ratio'].includes(m.metric.id))
        .map(m => [`${m.metric.id}@${m.metric.semantic_version}`, 'disable'])) : {};
      await policies.changeBinding(admin, { type, id }, { expected_revision: 0,
        package: { id: pin.id, version: pin.version, digest: pin.digest }, overrides: { metrics,
          interval_ms: { mode: 'set', value: 1000 }, timeout_ms: { mode: 'set', value: 1000 } } }, true);
    }
    await rows('DELETE FROM alert_rules'); // Migration defaults are configuration, never source facts.
    await rows("INSERT INTO alert_rules(id,name,metric_name,operator,threshold,duration_seconds,severity,target_type,server_id,enabled,notification_channels) VALUES(1,'synthetic filesystem','filesystem_used_bytes','>',1,0,'warning','server',3,1,'[]')");
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks(); await pool?.end();
    if (root) { await root.query(`DROP DATABASE ${database}`); await root.end(); }
  });
  it('collects both targets through the production path, then admits one formal alert/event/request without dispatch', async () => {
    const c = new SourceControl(pool, config());
    try {
      await c.open(); await assertSourceInventory(pool, c); await sourceHostClock(access);
      const result = await collectSource(c, { access });
      expect(result.executed).toBe(8);
      expect(result.server.ready).toBe(true); expect(result.instance.ready).toBe(true);
      await c.close(true);
    } finally { await c.close(); }
    const e = new SourceControl(pool, { ...config(), phase: 'evaluate' });
    try {
      await e.open();
      const { serverAlertEvaluator } = await import('../../server-alert-evaluator.js');
      // An equally firing metric on a different mount cannot admit an event.
      await serverAlertEvaluator.evaluateServerRules(new Map([[1, { ...config().alertRules[0].dimensions, mount: '/not-the-pilot' }]]));
      expect(await rows('SELECT id FROM alerts')).toHaveLength(0);
      const result = await evaluateSource(e);
      expect(result.alertId).toBeGreaterThan(0);
      expect(result.eventId).toBeTruthy(); expect(result.investigationId).toBeTruthy(); expect(result.requestId).toBeTruthy();
      expect(await rows('SELECT id FROM action_executions')).toHaveLength(0);
      expect(await rows('SELECT id FROM agent_tool_approvals')).toHaveLength(0);
      expect(await rows("SELECT id FROM workflow_jobs WHERE job_type LIKE 'action.%'")).toHaveLength(0);
      const jobs = await rows("SELECT attempts,state FROM workflow_jobs WHERE job_type='investigation.execute'");
      expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ attempts: 0, state: 'queued' });
      await e.close(true);
      const directory = await mkdtemp(resolve('.qualification/source-bootstrap-'));
      const childConfig = { ...config(), phase: 'investigate', operationId: crypto.randomUUID(),
        investigationId: result.investigationId, requestId: result.requestId };
      const file = resolve(directory, 'config.json');
      await writeFile(file, JSON.stringify(childConfig), { mode: 0o600 });
      const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'src/operations/source-package/investigate.mysql.test.ts'], {
        cwd: process.cwd(), env: { ...process.env, V23_SOURCE_CHILD_CONFIG: file, V23_SOURCE_CHILD_DIRECTORY: directory,
          DB_HOST: '127.0.0.1', DB_PORT: String(port), DB_USER: 'root', DB_PASSWORD: '', DB_NAME: database,
          ENCRYPTION_KEY: randomBytes(32).toString('hex'), JWT_SECRET_KEY: randomBytes(32).toString('hex') }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = ''; child.stdout!.on('data', b => { output += b; }); child.stderr!.on('data', b => { output += b; });
      const timer = setTimeout(() => child.kill('SIGTERM'), 90_000);
      const [exit] = await once(child, 'exit'); clearTimeout(timer);
      await writeFile(resolve(directory, 'child.log'), output);
      expect(exit, output).toBe(0);
    } finally { await e.close(); }
  }, 120000);
});
