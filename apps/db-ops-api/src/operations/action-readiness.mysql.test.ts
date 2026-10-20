/** Actual server + migrated MySQL + JWT/HTTP + pinned SSH, entirely synthetic.
 * Test-only TCP redirection prevents ANY connection to the real pilot host.
 * No model, execute, real human approval, shared DB or target is used. */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Server, utils } from 'ssh2';
import { describe, expect, it } from 'vitest';
import { startFeedbackFixture } from '../investigations/feedback-test-fixture.js';
import { fingerprintSshHostKey } from '../security/ssh-host-key.js';
import { syntheticPilot } from './action-environment.fixture.js';

const port = Number(process.env.OPERATIONS_TEST_MYSQL_PORT ?? process.env.AGENT_RUN_TEST_MYSQL_PORT ?? 0);
describe.skipIf(!port)('P10 action readiness actual server (synthetic)', () => {
  it('creates and submits only exact source-bound plans; refuses stale identities/config/ACL and never dispatches', async () => {
    process.env.T11_TEST_MYSQL_PASSWORD = process.env.OPERATIONS_TEST_MYSQL_PASSWORD ?? process.env.AGENT_RUN_TEST_MYSQL_PASSWORD ?? '';
    const f = await startFeedbackFixture(port), pilot = await syntheticPilot();
    const commands: string[] = [], clients = new Set<any>();
    const host = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const hostPem = host.privateKey.export({ type: 'pkcs1', format: 'pem' });
    const hostKey = utils.parseKey(hostPem);
    if (hostKey instanceof Error || Array.isArray(hostKey)) throw Error('synthetic host key');
    pilot.manifest.target.hostFingerprint = fingerprintSshHostKey(hostKey.getPublicSSH());
    const clientKey = utils.parseKey(await readFile(pilot.env.OPERATIONS_PILOT_SSH_KEY_FILE));
    if (clientKey instanceof Error || Array.isArray(clientKey)) throw Error('synthetic client key');
    let inspection = pilot.inspection();
    const ssh = new Server({ hostKeys: [hostPem] }, client => {
      clients.add(client); client.on('close', () => clients.delete(client)); client.on('error', () => {});
      client.on('authentication', ctx => {
        if (ctx.method === 'publickey' && ctx.username === 'slide-action' && ctx.key.data.equals(clientKey.getPublicSSH())) ctx.accept();
        else ctx.reject();
      });
      client.on('ready', () => client.on('session', accept => {
        const session = accept();
        session.on('exec', (acceptExec, reject, info) => {
          commands.push(info.command);
          if (info.command !== 'sudo -n -- /usr/local/libexec/slide-action-demo-helper inspect') return reject();
          const stream = acceptExec(); stream.write(JSON.stringify(inspection)); stream.exit(0); stream.end();
        });
      }));
    });
    let child: ChildProcess | undefined, output = '', base = '';
    const checks: Array<{ name: string; status: number }> = [];
    const stop = async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit'); child.kill('SIGTERM');
        const timer = setTimeout(() => child?.kill('SIGKILL'), 10_000);
        await exited; clearTimeout(timer);
      }
    };
    const request = async (path: string, body: unknown) => {
      const response = await fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${f.tokens.owner}`,
        'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as any };
    };
    try {
      await new Promise<void>(done => ssh.listen(0, '127.0.0.1', done));
      const sshPort = (ssh.address() as { port: number }).port;
      await pilot.save(); inspection = pilot.inspection();
      // Only the test child loads this module. Production has no host override.
      const preload = resolve(pilot.directory, 'synthetic-ssh-redirect.mjs');
      await writeFile(preload, `import ssh2 from 'ssh2';
const original = ssh2.Client.prototype.connect;
ssh2.Client.prototype.connect = function(config) {
  if (config.host !== '192.168.49.130' || config.port !== 22) throw Error('UNEXPECTED_TEST_SSH_TARGET');
  return original.call(this, {...config, host:'127.0.0.1', port:${sshPort}});
};\n`);
      await f.rows(`INSERT INTO servers(id,host,port,label,os_type,credential_type,credential_encrypted,host_key_fingerprint,collection_enabled)
        VALUES(501,'192.168.49.130',22,'synthetic-pilot','Other','key','unused',?,0)`, [pilot.manifest.target.hostFingerprint]);
      await f.rows(`INSERT INTO role_permissions(role_id,permission_id) SELECT 101,id FROM permissions
        WHERE code IN ('servers:view','servers:manage','instance:manage','operations:actions:view','operations:actions:propose')`);
      await f.rows("UPDATE instance_permissions SET access_level='read-write' WHERE user_id=101");
      await f.rows("INSERT INTO worker_leases(lease_name,owner_id,fencing_token,expires_at) VALUES('slide-singleton-workers','p10-readiness-isolated',1,DATE_ADD(NOW(),INTERVAL 5 MINUTE))");
      const source = await f.seed();
      // Explicit synthetic source enrichment; never a real evidence qualification.
      await f.rows("INSERT INTO investigation_resources(investigation_id,resource_type,resource_id,role) VALUES(?,'server',501,'related')", [source.inv.id]);
      await f.rows("UPDATE investigation_evidence SET metadata_json=JSON_SET(metadata_json,'$.resources',JSON_ARRAY(JSON_OBJECT('type','instance','id',101),JSON_OBJECT('type','instance','id',102),JSON_OBJECT('type','server','id',501))) WHERE id=?", [source.proof.id]);
      const proposal = () => ({ ...pilot.proposal(), investigationId: source.inv.id, resultVersion: source.result.version,
        evidence: [{ id: source.proof.id, version: 1, hash: source.proof.contentHash, validUntil: new Date(Date.now() + 1200_000).toISOString() }] });
      const start = async (configured: boolean) => {
        const listener = createServer(); await new Promise<void>(done => listener.listen(0, '127.0.0.1', done));
        const httpPort = (listener.address() as { port: number }).port; await new Promise<void>(done => listener.close(() => done()));
        output = '';
        child = spawn(process.execPath, ['--import', 'tsx', '--import', preload, 'server.ts'], { cwd: process.cwd(), env: {
          ...process.env, ...pilot.env,
          OPERATIONS_PILOT_MANIFEST_FILE: configured ? resolve(pilot.env.OPERATIONS_PILOT_MANIFEST_FILE) : '',
          OPERATIONS_PILOT_PUBLIC_KEY_FILE: resolve(pilot.env.OPERATIONS_PILOT_PUBLIC_KEY_FILE),
          OPERATIONS_PILOT_SSH_KEY_FILE: resolve(pilot.env.OPERATIONS_PILOT_SSH_KEY_FILE),
          NODE_ENV: 'test', DB_HOST: '127.0.0.1', DB_PORT: String(port), DB_USER: 'root', DB_PASSWORD: process.env.T11_TEST_MYSQL_PASSWORD,
          DB_NAME: f.database, PORT: String(httpPort), JWT_SECRET_KEY: f.secret, ENCRYPTION_KEY: randomBytes(32).toString('hex'),
          INVESTIGATION_SYSTEM_EVENTS_ENABLED: 'false', INVESTIGATION_SYSTEM_AUTO_ENABLED: 'false',
          OPERATIONS_ACTION_PLANS_ENABLED: 'true', OPERATIONS_ACTION_DISPATCH_ENABLED: 'true', OPERATIONS_STOP_NEW_DISPATCH: 'true',
          OPERATIONS_CONTEXT_ENABLED: 'false', OPERATIONS_CASES_ENABLED: 'false', OPERATIONS_BASELINES_ENABLED: 'false', OPERATIONS_ATTENTION_ENABLED: 'false',
        }, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout!.on('data', chunk => { output += chunk; }); child.stderr!.on('data', chunk => { output += chunk; });
        const deadline = Date.now() + 30_000;
        while (!output.includes('服务器已启动') && Date.now() < deadline && child.exitCode === null) await new Promise(done => setTimeout(done, 50));
        expect(output).toContain('WORKER_LEASE_UNAVAILABLE'); expect(output).toContain('服务器已启动');
        base = `http://127.0.0.1:${httpPort}`;
      };
      await start(true);
      const created = await request('/api/operations/actions/plans', { content: proposal() });
      expect(created, JSON.stringify(created)).toMatchObject({ status: 201, body: { plan: { state: 'draft', version: 1 } } });
      checks.push({ name: 'signed plan created', status: created.status });
      const plan = created.body.plan;
      const submitted = await request(`/api/operations/actions/plans/${plan.id}/submit`, { expectedVersion: 1 });
      expect(submitted).toMatchObject({ status: 201, body: { plan: { state: 'pending_approval' } } });
      checks.push({ name: 'pending approval only', status: submitted.status });
      const reject = async (name: string, p = proposal()) => {
        const result = await request('/api/operations/actions/plans', { content: p });
        expect(result.status, `${name}: ${JSON.stringify(result)}`).toBeGreaterThanOrEqual(400);
        checks.push({ name, status: result.status });
      };
      for (const field of ['tool', 'host', 'policy', 'verifier']) {
        const p = proposal();
        if (field === 'tool') p.tool.version = 'unknown';
        if (field === 'host') p.target.id = 502;
        if (field === 'policy') p.policyVersion = 'unknown';
        if (field === 'verifier') p.verifier.version = 'unknown';
        await reject(`unknown ${field}`, p);
      }
      for (const field of ['helperHash', 'unitHash', 'configHash']) {
        inspection = { ...pilot.inspection(), [field]: 'f'.repeat(64) }; await reject(`mismatched ${field}`);
      }
      inspection = pilot.inspection();
      await f.rows("UPDATE servers SET host_key_fingerprint=? WHERE id=501", ['SHA256:' + Buffer.alloc(32, 8).toString('base64').replace(/=+$/, '')]);
      await reject('SQL host-key identity mismatch');
      await f.rows('UPDATE servers SET host_key_fingerprint=? WHERE id=501', [pilot.manifest.target.hostFingerprint]);
      const fingerprint = pilot.manifest.target.hostFingerprint;
      // The SQL row and signed registration agree, but the SSH endpoint key does not.
      pilot.manifest.target.hostFingerprint = 'SHA256:' + Buffer.alloc(32, 9).toString('base64').replace(/=+$/, ''); await pilot.save();
      await f.rows('UPDATE servers SET host_key_fingerprint=? WHERE id=501', [pilot.manifest.target.hostFingerprint]);
      await reject('SSH host-key proof mismatch');
      pilot.manifest.target.hostFingerprint = fingerprint; await pilot.save();
      await f.rows('UPDATE servers SET host_key_fingerprint=? WHERE id=501', [fingerprint]);
      const until = pilot.manifest.validUntil;
      pilot.manifest.validUntil = new Date(Date.now() - 1).toISOString(); await pilot.save(); await reject('expired registration');
      pilot.manifest.validUntil = until; await pilot.save();
      const envelope = JSON.parse(await readFile(pilot.env.OPERATIONS_PILOT_MANIFEST_FILE, 'utf8'));
      envelope.manifest.policyVersion = 'tampered'; await writeFile(pilot.env.OPERATIONS_PILOT_MANIFEST_FILE, JSON.stringify(envelope));
      await reject('untrusted manifest signature'); await pilot.save();
      await f.rows('DELETE FROM instance_permissions WHERE user_id=101 AND instance_id=102');
      await reject('live complete-scope ACL revoked');
      await f.rows("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(101,102,'read-write')");
      await f.rows('UPDATE investigation_evidence SET expired_at=UTC_TIMESTAMP(3) WHERE id=?', [source.proof.id]);
      await reject('source evidence expired');
      await f.rows('UPDATE investigation_evidence SET expired_at=NULL WHERE id=?', [source.proof.id]);
      expect((await request('/api/operations/actions/execute', {})).status).toBe(404);
      expect((await request(`/api/operations/actions/plans/${plan.id}/execute`, {})).status).toBe(404);
      await stop(); await start(false); await reject('missing deployment config');
      const approvals = await f.rows("SELECT status,used_count FROM agent_tool_approvals WHERE tool_name='operations_action_plan'");
      expect(approvals).toEqual([{ status: 'pending', used_count: 0 }]);
      expect((await f.rows('SELECT COUNT(*) n FROM action_executions'))[0].n).toBe(0);
      expect((await f.rows("SELECT COUNT(*) n FROM workflow_jobs WHERE job_type LIKE '%action%'"))[0].n).toBe(0);
      expect((await f.rows('SELECT COUNT(*) n FROM action_plans'))[0].n).toBe(1);
      expect(commands.length).toBeGreaterThanOrEqual(5);
      expect(commands.every(cmd => cmd === 'sudo -n -- /usr/local/libexec/slide-action-demo-helper inspect')).toBe(true);
      await writeFile('.qualification/action-readiness-result.json', JSON.stringify({ synthetic: true, database: f.database,
        checks, commands, approvals, actualServer: true, realTargetConnections: 0, dispatches: 0, productModelCalls: 0 }, null, 2));
    } finally {
      await stop(); for (const client of clients) client.end();
      if (ssh.listening) await new Promise<void>(done => ssh.close(() => done()));
      await writeFile('.qualification/action-readiness-server.log', output);
      await pilot.close(); await f.close();
    }
  }, 120_000);
});
