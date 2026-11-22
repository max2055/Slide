/** Opt-in acceptance against a disposable Linux mount namespace and MySQL. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import ssh2 from 'ssh2';
import { actorContextService, signAccessToken } from '../src/auth/actor-context.js';
import { createVerifyToken } from '../src/auth-middleware.js';
import { dbConnection, encryptData } from '../src/db-connection.js';
import { createAssetCollectorAccess } from '../src/metrics/config/access.js';
import { createConfigurationRegistry } from '../src/metrics/config/registry.js';
import { registerMetricConsumerRoutes } from '../src/metrics/consumers/routes.js';
import { FILESYSTEM_CAPACITY_COMMAND } from '../src/metrics/packages/filesystem-discovery.js';
import { MetricFormalization } from '../src/metrics/rollout/formalization.js';
import { MetricScheduler } from '../src/metrics/scheduler/service.js';
import { MysqlScheduleStore } from '../src/metrics/scheduler/store.js';
import { createCollectNowAuthorizer } from '../src/metrics/templates/collect-now.js';
import { registerDiscoveryRoutes } from '../src/metrics/templates/discovery-routes.js';
import { registerTemplateAuthoringRoutes } from '../src/metrics/templates/authoring-routes.js';
import { MySqlTemplateRepository } from '../src/metrics/templates/mysql-repository.js';
import { registerMetricTemplateRoutes } from '../src/metrics/templates/routes.js';
import { MetricTemplateService } from '../src/metrics/templates/service.js';
import { registerTemplateTriggerRoutes } from '../src/metrics/triggers/routes.js';
import { MigrationRunner } from '../src/migrations/runner.js';
import sshSessionPool from '../src/ssh-session-pool.js';
import { createOwnedDatabase } from '../src/testing/owned-fixture.js';
import { JobRegistry } from '../src/workflows/job-registry.js';
import { MysqlWorkflowStore, WorkerRuntime } from '../src/workflows/worker-runtime.js';

const nonce = randomBytes(8).toString('hex');
const workdir = mkdtempSync(resolve('../../outputs/filesystem-capacity-'));
const label = 'slide.filesystem-capacity';
const containers: string[] = [];
const clients = new Set<ssh2.Connection>();
const app = Fastify();
const run = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 }).trim();
const start = (...args: string[]) => {
  const id = run('run', '--detach', '--rm', '--label', `${label}=${nonce}`, ...args);
  containers.push(id);
  return id;
};
let root: mysql.Pool | undefined, schema: Awaited<ReturnType<typeof createOwnedDatabase>> | undefined;
let ssh: InstanceType<typeof ssh2.Server> | undefined;
let browser: Awaited<ReturnType<typeof import('@playwright/test')['chromium']['launch']>> | undefined;
let vite: Awaited<ReturnType<typeof import('../../../frontend/node_modules/vite/dist/node/index.js')['createServer']>> | undefined;
let failed: unknown;

try {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  const database = start('-e', 'MYSQL_ALLOW_EMPTY_PASSWORD=yes', '-p', '127.0.0.1::3306', 'mysql:8.4');
  const port = Number(run('port', database, '3306/tcp').split(':').at(-1));
  assert(port > 0 && port !== 3306);
  root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
  const deadline = Date.now() + 45_000;
  for (;;) {
    try { await root.query('SELECT 1'); break; }
    catch (error) { if (Date.now() >= deadline) throw error; await delay(300); }
  }
  schema = await createOwnedDatabase(root, { nonce, purpose: 'filesystem', handleDir: workdir });
  assert(await dbConnection.initialize({ host: '127.0.0.1', port, user: 'root', password: '', database: schema.database }));
  const pool = dbConnection.getPool()!;
  await new MigrationRunner(pool).run();

  const linux = start('--network', 'none', '--cap-add', 'SYS_ADMIN',
    'python@sha256:399babc8b49529dabfd9c922f2b5eea81d611e4512e3ed250d75bd2e7683f4b0', 'sleep', '600');
  const inLinux = (command: string) => run('exec', linux, 'sh', '-ec', command);
  const mount = 'mount -t tmpfs -o size=64k,nr_inodes=64 slide-fixture';
  inLinux(`for i in $(seq 1 32); do mkdir -p /mnt/fs$i && ${mount} /mnt/fs$i; done`);
  const host = Object.values(networkInterfaces()).flat().find(n => n?.family === 'IPv4' && !n.internal)?.address;
  assert(host, 'controlled SSH endpoint needs a non-loopback host interface');
  // The same SSH public-key pin representation used by the ordinary asset collector.
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const key = ssh2.utils.parseKey(rsa);
  assert(!(key instanceof Error) && !Array.isArray(key));
  const fingerprint = `SHA256:${createHash('sha256').update(key.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
  const password = randomBytes(24).toString('hex');
  let failRead = false;
  ssh = new ssh2.Server({ hostKeys: [rsa] }, client => {
    clients.add(client);
    client.on('error', () => {}).on('close', () => clients.delete(client));
    client.on('authentication', auth => auth.method === 'password' && auth.username === 'fixture' && auth.password === password ? auth.accept() : auth.reject());
    client.on('ready', () => client.on('session', accept => accept().on('exec', (open, reject, info) => {
      if (info.command !== FILESYSTEM_CAPACITY_COMMAND) return reject();
      const stream = open();
      try {
        if (failRead) throw new Error('controlled command failure');
        stream.write(inLinux(info.command));
        stream.exit(0);
      } catch { stream.stderr.write('controlled command failure'); stream.exit(1); }
      stream.end();
    })));
  });
  ssh.listen(0, host);
  await once(ssh, 'listening');
  const sshAddress = ssh.address();
  assert(typeof sshAddress === 'object' && sshAddress);
  const resource = { type: 'server', id: 701 } as const;
  await pool.execute(`INSERT INTO servers(id,host,port,label,os_type,credential_type,credential_encrypted,host_key_fingerprint)
    VALUES (?,?,?,'文件系统资格验收','CentOS','password',?,?)`,
  [resource.id, host, sshAddress.port, encryptData(JSON.stringify({ username: 'fixture', password })), fingerprint]);
  await pool.query("INSERT INTO users(id,username,password_hash) VALUES(701,'filesystem-author','no-login')");
  await pool.query("INSERT INTO roles(id,name) VALUES(701,'filesystem-author')");
  await pool.query(`INSERT IGNORE INTO permissions(code,name,resource,action) VALUES ('metric:manage','指标管理','metric','manage'),
    ('metric:view','指标查看','metric','view'),('servers:manage','服务器管理','servers','manage'),('servers:view','服务器查看','servers','view')`);
  await pool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT 701,id FROM permissions WHERE code IN ('metric:view','metric:manage','servers:view','servers:manage')");
  await pool.query('INSERT INTO user_roles(user_id,role_id) VALUES(701,701)');
  const actor = await actorContextService.loadActiveActor(701);
  const secret = randomBytes(32).toString('hex');
  const verify = createVerifyToken(secret), token = signAccessToken(actor, secret);
  await registerTemplateAuthoringRoutes(app, verify);
  await registerMetricTemplateRoutes(app, verify);
  await registerDiscoveryRoutes(app, verify);
  await registerTemplateTriggerRoutes(app, verify);
  await registerMetricConsumerRoutes(app, verify);
  const call = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const response = await app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload: payload as object });
    assert.equal(response.statusCode, 200, `${url} ${response.body}`);
    return response.json();
  };

  const registry = createConfigurationRegistry(), repository = new MySqlTemplateRepository(pool);
  const templates = new MetricTemplateService(repository, registry);
  const record = await templates.create(actor, { name: '文件系统容量' });
  const templateId = record.template_id;
  const release = registry.list().find(r => r.package.id === 'linux-filesystem-discovery' && r.package.version === '2.0.0')!;
  const items = [];
  for (const { metric } of release.package.collectors[0].mappings) {
    const { id, version, digest } = release.package;
    items.push((await templates.selectMetric(actor, templateId, { package: { id, version, digest }, metric })).item);
  }
  const draft = (await repository.getDraft(templateId))!;
  const itemIds = items.map(item => item.item_id).sort();
  draft.aggregate.items = itemIds.map(item_id => ({ item_id, version: 1 }));
  draft.aggregate.discovery_rules = [{ rule_id: 'filesystem', name: '文件系统发现', item_ids: itemIds,
    identity_dimensions: ['filesystem_epoch'], timeout_ms: 5000, max_instances: 33, lost_after_ms: 1000, retire_after_ms: 2000 }];
  await templates.updateDraft(actor, templateId, { expected_draft_revision: draft.revision, aggregate: draft.aggregate });
  let published = await templates.publish(actor, templateId, { expected_revision: 0, expected_draft_revision: draft.revision + 1 });
  const item = items.find(entry => entry.canonical_metric.id === 'linux.filesystem.discovered_used_percent')!;
  for (const [severity, threshold] of [['warning', 80], ['critical', 90]] as const) {
    const condition = (operator: '>' | '<=') => ({ node: 'compare', select: { aggregation: 'last' }, operator,
      threshold: { kind: 'constant', value: threshold } });
    published = await call('POST', `/api/metrics/templates/${templateId}/triggers`, {
      expected_version: published.version, expected_content_hash: published.content_hash, item_id: item.item_id, severity,
      parameters: { schema: {}, defaults: {} }, problem: condition('>'), recovery: condition('<='),
      quality: { accepted_quality: ['good'], min_coverage: 1, allow_estimated: false },
      clock: { stale_after_ms: 120000, nodata: { enabled: false } },
    });
  }
  const body = { expected_revision: 0, template_pins: [{ template_id: templateId, version: published.version,
    content_hash: published.content_hash }], overrides: { enabled: 'enable' } };
  const base = `/api/metrics/template-bindings/server/${resource.id}`;
  const preview = await call('POST', `/api/metrics/templates/${templateId}/discovery-preview`, {
    resource, version: published.version, operation_key: 'filesystem-preview',
  });
  assert.equal(preview.state, 'completed');
  assert.equal(preview.rules[0].count, 32);
  await call('POST', `${base}/probe`, body);
  await call('POST', `${base}/trial`, { ...body, receipt_id: 'filesystem-trial' });
  assert.equal((await call('POST', `${base}/apply`, { ...body, receipt_id: 'filesystem-trial', caller_key: 'filesystem-apply' })).kind, 'committed');
  const jobs = new JobRegistry();
  const authorizer = createCollectNowAuthorizer({
    loadActor: (id, version) => actorContextService.loadActiveActor(id, version),
    loadActorOn: (executor, id, version) => actorContextService.loadActiveActorOn(executor as never, id, version, undefined, true),
  });
  new MetricScheduler(new MysqlScheduleStore(pool, registry, 'production'), registry, createAssetCollectorAccess(true),
    Date.now, undefined, new MetricFormalization(pool, registry), authorizer).register(jobs);
  const worker = new WorkerRuntime(new MysqlWorkflowStore(() => pool as never), nonce, 30);
  const collect = async (caller_key: string, expected: string, maxSamples: number) => {
    await call('POST', `${base}/collect`, { caller_key, expected_revision: 1 });
    const deadline = Date.now() + 10_000;
    do {
      await worker.runOnce((job, context) => jobs.execute(job, context), Date.now());
      const task = await call('GET', `${base}/collect/${caller_key}`);
      if (['completed', 'failed', 'unknown'].includes(task.state)) {
        assert.equal(task.state, expected, JSON.stringify(task.task));
        assert.equal(task.samples.length, maxSamples);
        return;
      }
      await delay(50);
    } while (Date.now() < deadline);
    throw new Error(`Collection receipt deadline for ${caller_key}`);
  };
  const events = async () => (await pool.query<RowDataPacket[]>(`SELECT e.id,e.severity,e.status FROM alert_events e
    JOIN metric_trigger_episodes p ON p.event_id=e.id WHERE p.resource_key=? ORDER BY e.id`, [`server:${resource.id}`]))[0];
  const windowStart = new Date(Date.now() - 50).toISOString();
  await collect('baseline', 'completed', 160);
  inLinux(`mkdir /mnt/fs33 && ${mount} /mnt/fs33 && dd if=/dev/zero of=/mnt/fs33/check bs=4096 count=14 2>/dev/null`);
  await collect('member-33', 'completed', 165);
  const stateUrl = `/api/metrics/discovery/server/${resource.id}`;
  const current = await call('GET', stateUrl);
  assert.equal(current.rows[0].state.members.length, 33);
  const member = current.rows[0].state.members.find((entry: {name: string}) => entry.name === '/mnt/fs33');
  assert(member);
  assert.deepEqual((await events()).map(event => [event.severity, event.status]), [['warning', 'open']]);
  inLinux('dd if=/dev/zero of=/mnt/fs33/check bs=4096 count=15 2>/dev/null');
  await collect('critical', 'completed', 165);
  await collect('repeat-critical', 'completed', 165);
  const opened = await events();
  assert.deepEqual(opened.map(event => [event.severity, event.status]), [['warning', 'open'], ['critical', 'open']]);
  failRead = true;
  await collect('failed-read', 'failed', 0);
  assert.deepEqual(await events(), opened);
  failRead = false;
  inLinux('rm /mnt/fs33/check; mkdir /mnt/renamed; mount --move /mnt/fs33 /mnt/renamed');
  await collect('recovery', 'completed', 165);
  assert.deepEqual((await events()).map(event => [event.id, event.status]), opened.map(event => [event.id, 'resolved']));
  assert.equal((await call('GET', stateUrl)).rows[0].state.members.find((entry: {name: string}) => entry.name === '/mnt/renamed').id, member.id);
  const latest = await call('POST', '/api/metrics/latest', resource);
  assert(latest.metrics.some((metric: any) => metric.definition.id === item.canonical_metric.id
    && metric.series.some((series: any) => series.dimensions.mount === '/mnt/fs33' && series.value?.value === 93.75)));
  inLinux('umount /mnt/renamed');
  await collect('disappeared', 'completed', 160);
  await delay(2100);
  await collect('retired', 'completed', 160);
  assert.equal((await call('GET', stateUrl)).rows[0].state.members.find((entry: {id: string}) => entry.id === member.id).state, 'retired');
  const history = await call('POST', '/api/metrics/observations', { resource, metric: item.canonical_metric, dimensions: member.dimensions,
    from: windowStart, to: new Date().toISOString(), limit: 50 });
  assert(history.observations.some((observation: any) => observation.value?.value === 93.75));
  console.log('PASS 32 to 33 mounted filesystems, 165 samples, warning and critical, failed read, same-episode recovery, move, retirement and historical access');

  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const { createServer } = await import('../../../frontend/node_modules/vite/dist/node/index.js');
  vite = await createServer({ configFile: false, root: resolve('../../frontend'), server: {
    host: '127.0.0.1', port: 0, proxy: { '/api': address },
  } });
  await vite.listen();
  const { chromium, expect } = createRequire(resolve('../../frontend/package.json'))('@playwright/test') as typeof import('@playwright/test');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(accessToken => localStorage.setItem('token', accessToken), token);
  const viteAddress = vite.httpServer?.address();
  assert(typeof viteAddress === 'object' && viteAddress);
  await page.goto(`http://127.0.0.1:${viteAddress.port}/e2e/fixtures/max237-template-library.html`);
  await page.locator(`[data-template-id="${templateId}"]`).click();
  await page.getByRole('tab', { name: '触发器' }).click();
  await expect(page.getByRole('cell', { name: '预警', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '严重', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '编辑触发器', exact: true }).click();
  const monitor = page.getByLabel('触发器监控项', { exact: true });
  await monitor.selectOption(item.item_id);
  const severity = page.getByLabel('触发器级别', { exact: true });
  await monitor.focus();
  await monitor.press('Tab');
  await expect(severity).toBeFocused();
  await severity.selectOption('critical');
  await expect(severity).toHaveValue('critical');
  for (const [width, height] of [[1366, 768], [1440, 900], [1920, 1080]]) {
    await page.setViewportSize({ width, height });
    await expect(severity).toBeVisible();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: join(workdir, `trigger-${width}.png`), fullPage: true });
  }
  console.log(`PASS Lit severity editor and keyboard focus at three desktop sizes, evidence ${workdir.split('/').at(-1)}`);
} catch (error) {
  failed = error;
  throw error;
} finally {
  sshSessionPool.closeAll();
  for (const client of clients) client.end();
  const cleanup = [() => browser?.close(), () => vite?.close(), () => app.close(), () => ssh && new Promise<void>(done => ssh!.close(() => done())),
    () => dbConnection.close(), () => schema?.drop(), () => root?.end()];
  for (const action of cleanup) {
    try { await action(); } catch (error) { failed ??= error; console.error('Cleanup failed', error); }
  }
  for (const id of containers.reverse()) {
    try {
      assert.equal(run('inspect', '--format', `{{index .Config.Labels "${label}"}}`, id), nonce);
      run('stop', '--time', '5', id);
    } catch (error) { failed ??= error; console.error('Container cleanup failed', error); }
  }
  if (failed) throw failed;
  console.log('PASS isolated resources cleaned up');
}
