/** Owned MySQL real counters and authorized VM read-only memory; no shared DB writes. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import mysql from 'mysql2/promise';
import { parse } from 'dotenv';
import { decryptData } from '../src/db-connection.js';
import { Client as SshClient } from 'ssh2';
import sshSessionPool from '../src/ssh-session-pool.js';
import serverMetricProvider, { parseMemoryUsage } from '../src/server-metric-provider.js';
import { createOptionalSshHostVerifier } from '../src/security/ssh-host-key.js';
import { createConfigurationRegistry } from '../src/metrics/config/registry.js';
import { mysqlCounterTransport } from '../src/metrics/config/mysql-counter.js';
import { runPackage, type PackageExecution } from '../src/metrics/packages/runner.js';
import { diagnosticReads } from '../src/metrics/database/diagnostics.js';

const port = Number(process.env.MAX237_OWNED_MYSQL_PORT);
assert(port > 0 && port !== 3306, 'explicit owned non3306 port required');
const container = process.env.MAX237_OWNED_MYSQL_CONTAINER!;
const owned = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0];
assert.equal(owned.Config.Labels['slide.task'], 'MAX-237-52329');
assert.equal(Number(owned.NetworkSettings.Ports['3306/tcp'][0].HostPort), port);
const nonce = randomBytes(8).toString('hex');
const directory = resolve('../../outputs/max237-semantics-' + nonce);
mkdirSync(directory, { recursive: true });
const evidence: any = { source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), nonce,
  mysql: { port, container: owned.Id, image: owned.Image }, vm: {}, cleanup: {}, product_model_calls: 0 };
const save = () => writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
const root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', supportBigNumbers: true, bigNumberStrings: true });
const username = 'max237_' + nonce;
let reader: mysql.Connection | undefined, ssh: SshClient | undefined;
let sshClosed = true;
try {
  assert.match(String((await root.query<any[]>('SELECT VERSION() AS v'))[0][0].v), /^8\.4\./);
  await root.query(`CREATE USER '${username}'@'%'`);
  await root.query(`GRANT SELECT ON performance_schema.* TO '${username}'@'%'`);
  reader = await mysql.createConnection({ host: '127.0.0.1', port, user: username, supportBigNumbers: true, bigNumberStrings: true });
  const responses: any[] = [];
  const transport = mysqlCounterTransport(async (sql, timeout) => {
    if (!reader) reader = await mysql.createConnection({ host: '127.0.0.1', port, user: username, supportBigNumbers: true, bigNumberStrings: true });
    const [rows] = await reader.query({ sql, timeout });
    responses.push({ sql, rows }); return { rows };
  });
  const registry = createConfigurationRegistry();
  const release = registry.list().find(r => r.package.id === 'mysql-diagnostics' && r.package.version === '1.2.0')!;
  const pin = { id: release.package.id, version: release.package.version, digest: release.package.digest };
  const ids = ['mysql.connections.current', 'mysql.connections.used_percent', 'mysql.transaction_commands.commit_total',
    'mysql.transaction_commands.rollback_total', 'mysql.transaction_commands.commit_rate', 'mysql.transaction_commands.rollback_rate', 'mysql.transaction_commands.completed_rate'];
  const selection = { package: pin, credential_ref: 'credential:owned-mysql', overrides: {} };
  const execution = (): PackageExecution => ({ resource: { type: 'instance', id: 'owned-mysql', attributes: {
    'db.engine': { value: 'mysql', source: 'driver', observed_at: new Date().toISOString() },
    'db.version': { value: '8.4', source: 'driver', observed_at: new Date().toISOString() },
  } }, evidence: {}, binding_id: 'owned-mysql', config_revision: 1, attempt_id: randomBytes(8).toString('hex'),
    observed_at: new Date().toISOString(), collector_ids: release.package.collectors.filter(c => c.mappings.some(m => ids.includes(m.metric.id))).map(c => c.id), metric_keys: ids.map(id => id + '@1.0.0'), resolve: async () => transport });
  const first = await runPackage(registry, selection, execution());
  const metric = (result: typeof first, id: string) => result.observations.find(o => o.observation.metric.id === id)!.observation;
  evidence.mysql.first = first; save();
  assert(first.attempts.every(a => a.status === 'succeeded'), JSON.stringify(first.attempts));
  assert.equal(metric(first, ids[4]).value, null);
  assert.equal(metric(first, ids[4]).quality.reason, 'counter_baseline');
  const ratioRead = diagnosticReads.find(r => r.name === 'connection_utilization')!;
  const snapshot = responses.find(r => r.sql === ratioRead.sql).rows[0];
  const expected = Number(snapshot.current_connections) / Number(snapshot.connection_limit) * 100;
  assert(Math.abs(Number((metric(first, ids[1]).value as any).value) - expected) < 1e-6);
  evidence.mysql.first = first; evidence.mysql.ratio = { snapshot, expected, pin };
  for (let n = 0; n < 20; n++) { await root.query('BEGIN'); await root.query('COMMIT'); await root.query('ROLLBACK'); }
  await new Promise(r => setTimeout(r, 1200));
  const second = await runPackage(registry, selection, { ...execution(), states: first.states });
  for (const id of ids.slice(4)) assert(Number((metric(second, id).value as any)?.value) > 0, JSON.stringify(metric(second, id)));
  for (const [counter, rate] of [[ids[2], ids[4]], [ids[3], ids[5]]]) {
    const before = metric(first, counter), after = metric(second, counter);
    const delta = BigInt((after.value as any).value) - BigInt((before.value as any).value);
    const expected = Number(delta) / ((Date.parse(after.observed_at) - Date.parse(before.observed_at)) / 1000);
    assert(Math.abs(Number((metric(second, rate).value as any).value) - expected) < 1e-9);
  }
  assert.equal(Number((metric(second, ids[6]).value as any).value), Number((metric(second, ids[4]).value as any).value) + Number((metric(second, ids[5]).value as any).value));
  evidence.mysql.second = second;
  await root.query('FLUSH STATUS');
  const reset = await runPackage(registry, selection, { ...execution(), states: second.states });
  assert.equal(metric(reset, ids[4]).value, null);
  assert.equal(metric(reset, ids[4]).quality.reason, 'counter_reset');
  evidence.mysql.reset = reset;
  // Revoke the owned fixture credential. Some performance_schema status tables
  // remain publicly readable, so removing SELECT alone is not a denial proof.
  await root.query(`ALTER USER '${username}'@'%' IDENTIFIED BY ?`, [randomBytes(24).toString('hex')]);
  await reader.end(); reader = undefined;
  const denied = await runPackage(registry, selection, execution());
  assert(denied.attempts.every(a => a.error === 'permission_denied'));
  assert.equal(denied.observations.length, 0);
  assert(denied.capabilities.filter(c => c.metric.id === ids[1]).every(c => c.status === 'unknown'));
  evidence.mysql.denial_semantics = 'permission_denied attempt + unknown capability + no fabricated sample/zero';
  evidence.mysql.denied = denied;
  console.log('PASS MySQL8.4 real current/limit*100; explicit COMMIT/ROLLBACK rates; baseline/reset and permission unknown');
  // Existing authorized VM only; no new host, target write, or guessed credential.
  evidence.vm = { host: '192.168.49.130', port: 22, owner: 'Chief/Max', operation: 'read-only fixed /proc/meminfo and top commands' };
  let vmConnected = false;
  try {
    let password: string, username = 'root';
    if (process.env.SLIDE_DEBUG_ENV_FILE) {
      const env = parse(readFileSync(process.env.SLIDE_DEBUG_ENV_FILE));
      const source = await mysql.createConnection({ host: env.DB_HOST, port: Number(env.DB_PORT || 3306), user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME, connectTimeout: 5000 });
      try {
        await source.query('START TRANSACTION READ ONLY');
        const [rows] = await source.query<any[]>('SELECT host,port,credential_type,credential_encrypted,host_key_fingerprint FROM servers WHERE id=3');
        assert.equal(rows.length, 1); assert.equal(rows[0].host, evidence.vm.host); assert.equal(Number(rows[0].port), 22);
        assert.equal(rows[0].credential_type, 'password');
        const credentials = JSON.parse(decryptData(rows[0].credential_encrypted, env.ENCRYPTION_KEY));
        password = credentials.password; username = credentials.username; assert.equal(username, 'root');
        evidence.vm.credential_ref = 'existing servers:3 encrypted reference, source read-only transaction';
      } finally { await source.rollback(); await source.end(); }
    } else password = execFileSync('security', ['find-generic-password', '-s', 'com.slide.debug.vmware-fusion.192.168.49.130', '-a', 'root', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).trim();
    ssh = new SshClient(); sshClosed = false; ssh.once('close', () => { sshClosed = true; });
    await new Promise<void>((ok, fail) => ssh!.once('ready', ok).once('error', fail).connect({ host: evidence.vm.host, port: 22,
      username, password, readyTimeout: 5000,
      hostVerifier: createOptionalSshHostVerifier('SHA256:Fm+RarQJbqLeHkhPWPEcvPSL9HxN5gXMv6+9Q6n3OPA'),
    }));
    vmConnected = true;
    const calls: any[] = [];
    const hostRelease = registry.list().find(r => r.package.id === 'linux-host')!;
    const hostSelection = { package: { id: hostRelease.package.id, version: hostRelease.package.version, digest: hostRelease.package.digest }, credential_ref: 'credential:authorized-vm', overrides: {} };
    const hostExecution: PackageExecution = {
      resource: { type: 'server', id: '3', attributes: { 'os.family': { value: 'linux', source: 'inventory', observed_at: new Date().toISOString() } } },
      evidence: {}, binding_id: 'vm-memory', attempt_id: nonce, config_revision: 1, observed_at: new Date().toISOString(),
      collector_ids: ['linux-host-gauges'], metric_keys: ['linux.memory.used_percent@1.0.0'], resolve: async () => ({ method: 'ssh', client: ssh!, pool: { execCommands: async (client, commands, options) => {
        const results = await sshSessionPool.execCommands(client, commands, options);
        calls.push(...results.map((r, i) => ({ command: commands[i], stdout: r.stdout, exitCode: r.exitCode }))); return results;
      } } }),
    };
    const result = await runPackage(registry, hostSelection, hostExecution);
    const meminfo = calls.find(c => c.command === serverMetricProvider.getDefinitions('rhel').find(d => d.name === 'memory_usage')!.command).stdout;
    const sample = result.observations[0].observation;
    assert.equal(sample.quality.status, 'good'); assert.equal((sample.value as any).value, parseMemoryUsage(meminfo));
    evidence.vm.normal = { calls, result, sha256: createHash('sha256').update(meminfo).digest('hex') };
    const faults: any[] = [];
    const unavailable = await runPackage(registry, hostSelection, { ...hostExecution, attempt_id: nonce + '-unavailable',
      resolve: async () => ({ method: 'ssh', client: ssh!, pool: { execCommands: async (client, commands, options) => {
        // Read-only process-local fault: no files, permissions or services change.
        const actual = commands.map(command => 'PATH=/__max237_unavailable__ ' + command);
        const results = await sshSessionPool.execCommands(client, actual, options);
        faults.push(...results.map((r, i) => ({ command: actual[i], stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode })));
        return results;
      } } }),
    });
    assert(unavailable.attempts.every(a => a.status === 'failed' && a.error === 'parse_error'));
    assert.equal(unavailable.observations.length, 0);
    assert(unavailable.capabilities.every(c => c.status === 'unknown'));
    evidence.vm.unavailable = { boundary: 'controlled command-unavailable fault, actual SSH on authorized VM; process-local PATH only', faults, result: unavailable };
    // This is a parser boundary derived from the real read, explicitly not a claim
    // that the authorized VM actually lacks MemAvailable.
    assert.equal(parseMemoryUsage(meminfo.split('\n').filter((line: string) => !line.startsWith('MemAvailable:')).join('\n')), null);
    evidence.vm.missing_field = { state: 'controlled parser check passed', actual_missing_field_host: false,
      remaining: 'Actual missing-MemAvailable target requires Chief/Max-authorized Linux target/window; current VM exposes the field.' };
    console.log('PASS authorized VM real MemAvailable normal and actual read-only command-unavailable unknown; missing-field check controlled');
  } catch (error) {
    evidence.vm.failure_code = String((error as any)?.code ?? 'REFERENCE_OR_CONNECTION_UNAVAILABLE');
    if (vmConnected) throw error;
    evidence.vm.state = 'unavailable'; evidence.vm.attempted = 'existing keychain reference + pinned SSH connection (5s timeout)';
    evidence.vm.restore = 'Chief/Max restore existing authorized VM/keychain or supply an authorized target reference and read-only window';
    console.log('VM partial hold: authorized target/reference unavailable; no fallback target attempted');
  }
} catch (error) { evidence.failed = error instanceof Error ? error.message : String(error); console.error(error); process.exitCode = 1; }
finally {
  if (ssh && !sshClosed) await new Promise<void>(done => {
    const timer = setTimeout(() => { ssh!.destroy(); done(); }, 5000);
    ssh!.once('close', () => { clearTimeout(timer); done(); }); ssh!.end();
  });
  sshSessionPool.closeAll(); await reader?.end();
  await root.query(`DROP USER IF EXISTS '${username}'@'%'`); const [users] = await root.query<any[]>('SELECT COUNT(*) AS n FROM mysql.user WHERE User=?', [username]);
  assert.equal(Number(users[0].n), 0); await root.end();
  if (!sshClosed) process.exitCode = 1;
  evidence.cleanup = { reader_closed: true, owned_user_dropped: true, ssh_closed: sshClosed, target_writes: 'owned MySQL only; VM zero' };
  save(); console.log('Evidence: ' + directory);
}
