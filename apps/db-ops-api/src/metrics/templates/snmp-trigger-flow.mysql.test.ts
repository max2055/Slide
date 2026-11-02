import * as snmp from 'net-snmp';
import { createSocket, type Socket } from 'node:dgram';
import { once } from 'node:events';
import { SnmpClient } from '../../network-devices/snmp-client.js';
/** Opt-in controlled SNMP UDP endpoint. Real resource credentials, template routes,
 * collector and formal writer; only owned protocol values are controlled. No hardware claim. */
import { writeFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { chromium, expect as browserExpect } from '@playwright/test';
import { createVerifyToken } from '../../auth-middleware.js';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbConnection, encryptData } from '../../db-connection.js';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { actorContextService } from '../../auth/actor-context.js';
import type { ActorContext } from '../../auth/actor-context.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { createAssetCollectorAccess } from '../config/access.js';
import { runPackage } from '../packages/runner.js';
import { MySqlTemplateRepository } from './mysql-repository.js';
import { MetricTemplateService } from './service.js';
import { TemplateBindingService } from './binding-service.js';
import { CollectNowService, createCollectNowAuthorizer } from './collect-now.js';
import { registerMetricTemplateRoutes } from './routes.js';
import { evaluateTemplateClock } from '../triggers/runtime.js';
import { registerTemplateTriggerRoutes } from '../triggers/routes.js';
import { registerEventReadRoutes } from '../../alert-event-access.js';
import { MysqlScheduleStore } from '../scheduler/store.js';
import { MetricScheduler } from '../scheduler/service.js';
import { JobRegistry } from '../../workflows/job-registry.js';
import { MysqlWorkflowStore, WorkerRuntime } from '../../workflows/worker-runtime.js';
import { createOwnedDatabase, dropOwnedDatabase, generateRunNonce, type OwnedDatabase } from '../../testing/owned-fixture.js';

const enabled = process.env.MAX239_SNMP_FLOW === '1';
const port = Number(process.env.MAX238_TEST_MYSQL_PORT);
const output = process.env.MAX239_EVIDENCE_DIR!;
const nonce = process.env.MAX239_RUN_NONCE ?? generateRunNonce();
const json = (v: any) => typeof v === 'string' ? JSON.parse(v) : v;
const host = process.env.MAX239_SNMP_HOST!;
const community = randomBytes(24).toString('hex');
const authKey = randomBytes(24).toString('hex'), privKey = randomBytes(24).toString('hex');
const targets = [2,3].map(version => ({ type: 'network_device' as const, id: version, metric: 'snmp.agent.uptime_seconds', package: 'snmp-standard', version: '1.0.0', protocol: version }));


describe.skipIf(!enabled)('authorized real collectors to existing events', () => {
  let root: Pool, pool: Pool, platform: OwnedDatabase;
  const agents = new Map<number, ReturnType<typeof snmp.createAgent>>();
  const endpoints = new Map<number, number>();
  let packets = 0;
  let app: ReturnType<typeof Fastify>;
  let apiBase: string | undefined;
  let spy: ReturnType<typeof vi.spyOn>;
  let jobs: JobRegistry, worker: WorkerRuntime;
  const secret = randomBytes(32).toString('hex');
  const token = jwt.sign({ userId: 1, sessionVersion: 1 }, secret, { expiresIn: '1h' });
  const actor = { userId: 1, username: 'max239-real', roles: ['admin'], permissions: ['*'], sessionVersion: 1,
    instanceScopes: { 1: 'admin' }, requestId: 'max239-real' } as ActorContext;
  const registry = createConfigurationRegistry();
  const evidence: any = { nonce, targets: [], notification: { sent: false }, cleanup: {} };
  const rows = async (sql: string, values: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, values as never))[0];
  const call = async (method: 'GET'|'POST', url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload }) });
    expect(r.statusCode, `${url}: ${r.body}`).toBe(200);
    return r.json() as any;
  };
  const save = () => writeFileSync(join(output, 'snmp-flow-evidence.json'), JSON.stringify(evidence, null, 2));
  beforeAll(async () => {
    if (!port || port === 3306 || !output) throw Error('exclusive non3306 and output required');
    mkdirSync(output, { recursive: true });
    vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('hex'));
    if (!host || host.startsWith('127.')) throw Error('bind an owned nonloopback interface; target policy is unchanged');
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: process.env.MAX238_TEST_MYSQL_PASSWORD ?? '' });
    platform = await createOwnedDatabase(root, { nonce, purpose: 'realflow', handleDir: join(output, 'handles') });
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: process.env.MAX238_TEST_MYSQL_PASSWORD ?? '', database: platform.database, timezone: 'Z', connectionLimit: 12 });
    pool.on('connection', c => c.query("SET time_zone='+00:00'"));
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    spy = vi.spyOn(dbConnection, 'getPool').mockReturnValue(pool);
    for (const t of targets) {
      const probe = createSocket('udp4'); probe.bind(0, host); await once(probe, 'listening'); const endpoint = probe.address().port;
      await new Promise<void>(r => probe.close(() => r()));
      const agent = snmp.createAgent({ address: host, port: endpoint }, () => { packets++; });
      agents.set(t.id, agent); endpoints.set(t.id, endpoint);
      agent.getAuthorizer().addCommunity(community);
      agent.getAuthorizer().addUser({ name: 'max239-fixture', level: snmp.SecurityLevel.authPriv,
        authProtocol: snmp.AuthProtocols.sha, authKey, privProtocol: snmp.PrivProtocols.aes, privKey });
      await Promise.all(Object.values(agent.listener.sockets).map(s => once(s as Socket, 'listening')));
      agent.getMib().registerProvider({ name:'uptime', type:snmp.MibProviderType.Scalar, oid:'1.3.6.1.2.1.1.3', scalarType:snmp.ObjectType.TimeTicks, maxAccess:snmp.MaxAccess['read-only'] });
      agent.getMib().setScalarValue('uptime', 9500);
      await pool.execute("INSERT INTO network_devices(id,name,host,snmp_port,vendor,collection_enabled) VALUES(?,?,?,?, 'huawei',1)", [t.id, `MAX239 controlled SNMPv${t.protocol}`,host,endpoint]);
      if (t.protocol === 2) await pool.execute("INSERT INTO network_device_credentials(device_id,protocol,username,community_encrypted) VALUES(?,'snmpv2c','',?)",[t.id,encryptData(community)]);
      else await pool.execute("INSERT INTO network_device_credentials(device_id,protocol,username,security_level,auth_protocol,privacy_protocol,auth_secret_encrypted,privacy_secret_encrypted) VALUES(?,'snmpv3','max239-fixture','authPriv','SHA','AES',?,?)",[t.id,encryptData(authKey),encryptData(privKey)]);
    }
    evidence.endpoint = { host, endpoints: Object.fromEntries(endpoints), protocols: ['v2c','v3 authPriv SHA/AES'], hardware: false };
    await pool.execute('UPDATE users SET session_version=1 WHERE id=1');
    await pool.execute("INSERT IGNORE INTO roles(id,name) VALUES(1,'admin')");
    await pool.execute("INSERT IGNORE INTO permissions(id,code) VALUES(1,'*')");
    await pool.execute('INSERT IGNORE INTO role_permissions(role_id,permission_id) VALUES(1,1)');
    await pool.execute('INSERT IGNORE INTO user_roles(user_id,role_id) VALUES(1,1)');
    await pool.execute("INSERT IGNORE INTO instance_permissions(user_id,instance_id,access_level) VALUES(1,1,'admin')");
    const reload = (a: ActorContext) => actorContextService.revalidateActor(a, a.requestId);
    const reloadOn = (a: ActorContext, c: any) => actorContextService.revalidateActorOn(c, a, a.requestId, true);
    app = Fastify();
    const verify = createVerifyToken(secret, actorContextService);
    const auth = async (request: any, reply: any) => {
      await verify(request,reply);
      // Restriction-only fixture seam; the real service must preserve this boundary on live revalidation.
      if (request.user && request.headers['x-fixture-boundary']) request.user = {...request.user,resourceBoundary:{instanceIds:[],serverIds:[],networkDeviceIds:[]}};
    };
    await registerMetricTemplateRoutes(app, auth,
      new TemplateBindingService({ pool: () => pool, registry, access: createAssetCollectorAccess(), reload, reloadOn }),
      new CollectNowService({ pool: () => pool, registry, reload, reloadOn }));
    await registerTemplateTriggerRoutes(app, auth, () => pool);
    await registerEventReadRoutes(app, auth);
    jobs = new JobRegistry();
    new MetricScheduler(new MysqlScheduleStore(pool, registry, 'production'), registry, createAssetCollectorAccess(true),
      Date.now, undefined, undefined, createCollectNowAuthorizer({
        loadActor: (id, v) => actorContextService.loadActiveActor(id, v),
        loadActorOn: (c, id, v) => actorContextService.loadActiveActorOn(c as never, id, v, undefined, true),
      })).register(jobs);
    worker = new WorkerRuntime(new MysqlWorkflowStore(() => pool as never), `max239-real-${nonce}`, 30);
    await app.ready();
    evidence.platform = { database: platform.database, port, api: 'real Fastify handlers; foreground runOnce only' };
    save();
  }, 60000);

  afterAll(async () => {
    await app?.close();
    for (const agent of agents.values()) await new Promise<void>(r => agent.close(() => r()));
    evidence.packets = packets;

    spy?.mockRestore();
    await pool?.end();
    if (platform) { await dropOwnedDatabase(root, { nonce, purpose: 'realflow', handleDir: join(output, 'handles') }); evidence.cleanup.schema = 'verified and dropped'; }
    await root?.end();
    vi.unstubAllEnvs(); save();
  }, 30000);

  it.each(targets)('SNMPv$protocol actual collector, immutable threshold, normal writer, event and recovery', async target => {
    const result: any = { resource: { type: target.type, id: target.id }, metric: target.metric, protocol_endpoint: true, hardware: false, controlled_values: true };
    evidence.targets.push(result);
    try {
      const ref = { type: target.type, id: target.id };
      const access = await createAssetCollectorAccess().resolve(ref);
      const pkg = registry.list().map(r => r.package).find(p => p.id === target.package && p.version === target.version)!;
      expect(pkg).toBeTruthy();
      const pin = { id: pkg.id, version: pkg.version, digest: pkg.digest };
      const baseline = await runPackage(registry, { package: pin, credential_ref: access.credential_ref, overrides: { enabled: true } }, {
        ...access, binding_id: `baseline-${nonce}-${target.type}`, attempt_id: `baseline-${nonce}-${target.type}`, config_revision: 1,
        observed_at: new Date().toISOString(), metric_keys: [`${target.metric}@1.0.0`],
      });
      result.baseline = { decision: baseline.decision, attempts: baseline.attempts, observations: baseline.observations };
      const initial = baseline.observations.find((o: any) => o.observation.metric.id === target.metric)?.observation;
      expect(initial, JSON.stringify(result.baseline)).toBeTruthy();
      expect(initial!.quality.status).toBe('good');
      const scalar = initial!.value;
      if (!scalar || !('value' in scalar)) throw Error('uptime must be a scalar');
      const threshold = 90;
      expect(Number.isFinite(threshold)).toBe(true);
      result.threshold = { value: threshold, unit: 's', source: 'isolated controlled protocol rule', problem: '>', recovery: '<' };
      const repository = new MySqlTemplateRepository(pool as never);
      const templates = new MetricTemplateService(repository, registry);
      const template = await templates.create(actor as never, { name: `MAX239 actual ${target.type} ${nonce}` });
      const selected = await templates.selectMetric(actor as never, template.template_id, { package: pin, metric: { id: target.metric, semantic_version: '1.0.0' } });
      const draft = await repository.getDraft(template.template_id);
      const aggregate = structuredClone(draft!.aggregate);
      aggregate.items = [{ item_id: selected.item.item_id, version: selected.item.version }];
      await repository.updateDraft(template.template_id, draft!.revision, { aggregate, updated_by: 1, updated_at: new Date().toISOString() });
      const latest = await repository.getDraft(template.template_id);
      const published = await templates.publish(actor as never, template.template_id, { expected_draft_revision: latest!.revision, expected_revision: template.revision });
      const record = await repository.getTemplate(template.template_id);
      await repository.updateTemplate(template.template_id, record!.revision, { status: 'active', updated_at: new Date().toISOString() });
      const version = await repository.getVersion(template.template_id, published.version);
      const trigger = await call('POST', `/api/metrics/templates/${template.template_id}/triggers`, {
        expected_version: published.version, expected_content_hash: version!.content_hash, item_id: selected.item.item_id,
        parameters: { schema: { boundary: { type: 'number' }, low: { type: 'number' } }, defaults: { boundary: threshold, low: 70 } },
        problem: { node: 'compare', select: { aggregation: 'last' }, operator: '>', threshold: { kind: 'parameter', name: 'boundary' } },
        recovery: { node: 'compare', select: { aggregation: 'last' }, operator: '<', threshold: { kind: 'parameter', name: 'low' } },
        quality: { accepted_quality: ['good'], min_coverage: 1, allow_estimated: false },
        clock: { stale_after_ms: 1000, nodata: { enabled: false } },
      });
      result.publication = trigger;
      const base = `/api/metrics/template-bindings/${target.type}/${target.id}`;
      const body = { expected_revision: 0, template_pins: [{ template_id: template.template_id, version: trigger.version, content_hash: trigger.content_hash }],
        overrides: { enabled: 'enable', interval_ms: { mode: 'set', value: 30000 }, max_rows: { mode: 'set', value: 50 } } };
      result.probe = await call('POST', `${base}/probe`, body);
      result.trial = await call('POST', `${base}/trial`, { ...body, receipt_id: `real-${nonce}-${target.id}` });
      result.apply = await call('POST', `${base}/apply`, { ...body, receipt_id: `real-${nonce}-${target.id}`, caller_key: `real-${nonce}-${target.id}` });
      result.samples = [];
      const collect = async (step: string, required = true) => {
        const key = `real-${nonce}-${target.id}-${step}`;
        await call('POST', `${base}/collect`, { caller_key: key, expected_revision: 1 });
        let completed: any;
        // The existing queue compares availability against database wall time.
        // Wait for that real boundary; do not rewrite available_at or the clock.
        for (let n = 0; n < 25; n++) {
          await worker.runOnce((j,c) => jobs.execute(j,c), Date.now());
          completed = await call('GET', `${base}/collect/${key}`);
          if (completed.state === 'completed' || completed.state === 'failed') break;
          await new Promise(r => setTimeout(r, 100));
        }
        if (required) expect(completed.state, JSON.stringify(completed)).toBe('completed');
        result.samples.push(completed);
        return (await rows('SELECT event_id,payload,snapshot FROM metric_trigger_episodes WHERE resource_key=?', [`${target.type}:${target.id}`])).map(r => ({ event_id: Number(r.event_id), payload: json(r.payload), snapshot: json(r.snapshot) }));
      };
      const opened = await collect('open');
      expect(opened).toHaveLength(1);
      expect(opened[0].payload).toMatchObject({ state: 'open', recovery_count: 0 });
      expect(opened[0].payload.opened.value).toBeGreaterThan(threshold);
      result.opened = await call('GET', `/api/metrics/template-events/${opened[0].event_id}`);
      agents.get(target.id)!.getMib().setScalarValue('uptime',8500);
      const held = await collect('hold'); expect(held[0].payload.state).toBe('open');
      agents.get(target.id)!.getMib().unregisterProvider('uptime');
      const missing = await collect('missing', false); expect(missing[0].payload.state).toBe('open');
      await new Promise(r => setTimeout(r, 1100)); await evaluateTemplateClock(pool, Date.now());
      result.unknown = await call('GET', `/api/metrics/template-events/${opened[0].event_id}`);
      expect(result.unknown.episode.state).toBe('open');
      expect(result.unknown.episode.last.quality).toBe('unknown');
      agents.get(target.id)!.getMib().registerProvider({ name:'uptime', type:snmp.MibProviderType.Scalar, oid:'1.3.6.1.2.1.1.3', scalarType:snmp.ObjectType.TimeTicks, maxAccess:snmp.MaxAccess['read-only'] });
      agents.get(target.id)!.getMib().setScalarValue('uptime',6000);
      const recovered = await collect('recover');
      expect(recovered).toHaveLength(1);
      expect(recovered[0].payload).toMatchObject({ state: 'closed', recovery_count: 1 });
      result.history = await call('GET', `/api/metrics/template-events/${opened[0].event_id}`);
      result.event = await call('GET', `/api/alerts/events/${opened[0].event_id}`);
      result.logs = await call('GET', `/api/alerts/events/${opened[0].event_id}/logs`);
      result.observations = (await rows("SELECT id,payload FROM metric_observations WHERE stage='normalized' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.resource_id'))=? AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.resource_type'))=?", [String(target.id), target.type])).map(r => ({ id: r.id, payload: json(r.payload) }));
      if (process.env.MAX239_REAL_BROWSER === '1' && target.protocol === 2) {
        const base = apiBase ??= await app.listen({ host: '127.0.0.1', port: 0 });
        const frontend = resolve(process.cwd(), '../../frontend');
        const fd = openSync(join(output, `vite-${target.type}.log`), 'a');
        const vite = spawn(process.execPath, [join(frontend, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '0'], {
          cwd: frontend, env: { ...process.env, VITE_API_PROXY_TARGET: base }, stdio: ['ignore', 'pipe', fd],
        });
        let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
        result.browser = { pid: vite.pid, cwd: frontend, nonce, api: base };
        try {
          const url = await new Promise<string>((resolveUrl, reject) => {
            const timeout = setTimeout(() => reject(Error('owned Vite readiness timeout')), 15000);
            vite.stdout!.on('data', data => { const m = String(data).match(/http:\/\/127\.0\.0\.1:\d+/); if (m) { clearTimeout(timeout); resolveUrl(m[0]); } });
            vite.once('exit', code => { clearTimeout(timeout); reject(Error(`owned Vite exited ${code}`)); });
          });
          browser = await chromium.launch({ headless: true });
          const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
          const errors: string[] = [];
          page.on('pageerror', e => errors.push(e.message));
          await page.addInitScript(t => { (globalThis as any).localStorage.setItem('token', t); (globalThis as any).localStorage.setItem('permissions', JSON.stringify(['*'])); }, token);
          await page.goto(`${url}/e2e/fixtures/max239-snmp-flow.html?view=aggregate`);
          const events = page.locator('event-management-page');
          await events.getByRole('button', { name: /^已解决/ }).click();
          await events.getByText(`模板事件：${target.metric}`, { exact: true }).first().click();
          const facts = events.locator('template-event-evidence');
          await browserExpect(facts.getByText(result.history.episode.episode_id, { exact: true })).toBeVisible();
          await browserExpect(facts.getByText('已恢复', { exact: false }).first()).toBeVisible();
          for (const size of [{ width:1440,height:900 },{ width:1366,height:768 },{ width:1920,height:1080 }]) {
            await page.setViewportSize(size); await facts.scrollIntoViewIfNeeded();
            await page.screenshot({ path: join(output, `snmp-v${target.protocol}-${size.width}x${size.height}.png`), fullPage: true });
            expect(await page.evaluate(() => (globalThis as any).document.documentElement.scrollWidth <= (globalThis as any).innerWidth)).toBe(true);
          }
          await facts.getByRole('button', { name: '刷新', exact: true }).focus();
          expect(await facts.getByRole('button', { name: '刷新', exact: true }).evaluate(e => e === (e.getRootNode() as any).activeElement)).toBe(true);
          expect(errors).toEqual([]); result.browser.passed = true;
        } finally {
          await browser?.close();
          if (vite.exitCode === null) {
            const exited = new Promise<void>((r,j) => { vite.once('exit', () => r()); setTimeout(() => j(Error('owned Vite stop timeout')), 10000).unref(); });
            vite.kill('SIGTERM'); await exited;
          }
          closeSync(fd); result.browser.cleaned = true;
        }
      }
      expect(JSON.stringify(result)).not.toContain(community);
      expect(JSON.stringify(result)).not.toContain(authKey);
      expect(JSON.stringify(result)).not.toContain(privKey);
      for (const url of [`/api/alerts/events/${opened[0].event_id}`,`/api/metrics/template-events/${opened[0].event_id}`]) {
        const denied = await app.inject({method:'GET',url,headers:{authorization:`Bearer ${token}`,'x-fixture-boundary':'deny'}});
        expect(denied.statusCode).toBe(url.includes('/template-events/') ? 403 : 404);
      }
      await pool.execute('UPDATE users SET session_version=2 WHERE id=1');
      const revoked = await app.inject({method:'GET',url:`/api/metrics/template-events/${opened[0].event_id}`,headers:{authorization:`Bearer ${token}`}});
      expect(revoked.statusCode).toBe(401);
      await pool.execute('UPDATE users SET session_version=1 WHERE id=1');
      result.permissions={resource_boundary:'legacy detail 404; template evidence 403',revoked_session:'401'};
      result.status = 'passed';
    } catch (e) { result.status = 'failed'; result.error = e instanceof Error ? e.message : 'unknown'; throw e; }
    finally { save(); }
  }, 60000);
  it('checks actual UDP timeout/auth failure and rejects weak v3 security', async () => {
    const client = new SnmpClient();
    const drop = createSocket('udp4'); drop.bind(0,host); await once(drop,'listening');
    try {
      const config = { version: 2 as const, host, port: drop.address().port, community, timeoutMs:300, retries:0 };
      await expect(client.get(config,['1.3.6.1.2.1.1.3.0'])).rejects.toMatchObject({code:'SNMP_TIMEOUT'});
      const bad = { version:3 as const,host,port:endpoints.get(3)!,username:'max239-fixture',securityLevel:'authPriv' as const,authProtocol:'SHA' as const,authSecret:randomBytes(24).toString('hex'),privacyProtocol:'AES' as const,privacySecret:privKey,timeoutMs:300,retries:0 };
      let code = ''; try { await client.get(bad,['1.3.6.1.2.1.1.3.0']); } catch(e) { code=(e as any).code; }
      expect(['SNMP_TIMEOUT','SNMP_AUTH_FAILED']).toContain(code);
      await expect(client.get({...bad,securityLevel:'noAuthNoPriv'},['1.3.6.1.2.1.1.3.0'])).rejects.toMatchObject({code:'SNMP_UNSUPPORTED_SECURITY'});
      evidence.negatives={timeout:'SNMP_TIMEOUT',wrong_v3_auth:code,weak_v3:'SNMP_UNSUPPORTED_SECURITY'};
    } finally { await new Promise<void>(r => drop.close(() => r())); save(); }
  });

});
