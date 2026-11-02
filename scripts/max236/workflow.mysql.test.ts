/** Runs only in prepare.py's pinned, private source assembly. No remote device IO. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { describe, it, expect, vi } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import { dbConnection } from '../../db-connection.js';
import { actorContextService } from '../../auth/actor-context.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { configurationInventory } from '../config/inventory.js';
import { MySqlTemplateRepository } from '../templates/mysql-repository.js';
import { MetricTemplateService } from '../templates/service.js';
import { TemplateBindingService } from '../templates/binding-service.js';
import { CollectNowService, createCollectNowAuthorizer } from '../templates/collect-now.js';
import { MysqlScheduleStore } from '../scheduler/store.js';
import { MetricScheduler } from '../scheduler/service.js';
import { JobRegistry } from '../../workflows/job-registry.js';
import { MysqlWorkflowStore, WorkerRuntime } from '../../workflows/worker-runtime.js';
import { SnmpDiscovery } from '../snmp/collector.js';
import { alertEventService } from '../../alert-event-service.js';
import { parseRealBinding, parseHandle, inspectOwnedTarget, assertOwnedEndpoint } from './real-migration.js';

const enabled = process.env.MAX236_WORKFLOW === '1';
const output = resolve(process.env.MAX236_OUTPUT ?? '.max236-results');
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const percentile = (xs: number[], p: number) => [...xs].sort((a,b) => a-b)[Math.min(xs.length-1, Math.floor(xs.length*p))];
const points = (process.env.MAX236_CONCURRENCY ?? '1,2,4').split(',').map(Number);
const cycles = Number(process.env.MAX236_CYCLES ?? 2);
const jobTimeout=Number(process.env.MAX236_JOB_TIMEOUT_MS ?? 30000);
const baselineOverrides={enabled:'enable',timeout_ms:{mode:'set',value:jobTimeout}};

describe.skipIf(!enabled)('MAX236 owned 650-resource workflow', () => {
  it('measures existing formal write/read/event transactions and rehearses an isolated native copy', async () => {
    const handle = parseHandle(JSON.parse(readFileSync(process.env.MAX236_REALA_HANDLE!, 'utf8')));
    const dsn = `mysql://root@127.0.0.1:${handle.port}/${handle.database}`;
    const guard = async () => assertOwnedEndpoint(dsn, handle, await inspectOwnedTarget(handle), { require_running: true });
    await guard();
    expect(points.every(n => Number.isInteger(n) && n > 0 && n <= 4)).toBe(true);
    expect(Number.isInteger(cycles) && cycles >= 2 && cycles <= 10 && cycles%2 === 0).toBe(true);
    expect(Number.isInteger(jobTimeout) && jobTimeout>=5000 && jobTimeout<=60000).toBe(true);
    mkdirSync(output, { recursive: true });
    const base = { host: '127.0.0.1', port: handle.port, user: 'root', password: '', timezone: 'Z', connectTimeout: 5000 };
    const root = await mysql.createConnection(base);
    let pool: Pool | undefined;
    let copyPool: Pool | undefined, originalPool: Pool | undefined;
    const evidence: any = { status: 'running', nonce: (JSON.parse(readFileSync(process.env.MAX236_REALA_HANDLE!, 'utf8'))).nonce,
      endpoint: { port: handle.port, container: handle.container_id, database: handle.database },
      assumptions: { resources: { server: 500, instance: 100, network_device: 50 }, metrics_per_resource: 1,
        target_profiles: {server:'RHEL',instance:'MySQL 9.6 uptime-only v2',network_device:'SNMPv2c system uptime'},
        dimensions_per_metric: 1, interval_ms: 60000, job_timeout_ms:jobTimeout, retention: 'no expiry during short run; retention not benchmarked',
        cycles_per_point: cycles, concurrency: points, collector: 'controlled transport responses; real adapters, compiler, queue, writer, readConfigurationAt and event transaction',
        notification: 'no channels, no external sends; durable event dedup measured', production_slo: 'not established' },
      points: [], migration: {}, source_manifest: createHash('sha256').update(readFileSync(new URL('../../../../../max236-sources.json', import.meta.url))).digest('hex') };
    const save = () => writeFileSync(join(output, 'workflow.json'), JSON.stringify(evidence, null, 2) + '\n');
    const schema = handle.database, copy = `${schema}_copy`;
    // The prewritten fixture whitelist is authoritative for every schema created here.
    const journal = JSON.parse(readFileSync(process.env.MAX236_REALA_HANDLE!, 'utf8'));
    expect(journal.schemas).toContain(copy);
    let value = 95;
    try {
      await root.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      pool = mysql.createPool({ ...base, database: schema, connectionLimit: 24 });
      originalPool = pool;
      pool.on('connection', c => c.query("SET time_zone='+00:00'"));
      await new MigrationRunner(pool as never).run();
      vi.spyOn(dbConnection, 'getPool').mockImplementation(() => pool!);
      const rows = async (sql: string, args: any[] = []) => (await pool!.query<RowDataPacket[]>(sql, args))[0];
      const count = async (table: string) => Number((await rows(`SELECT COUNT(*) n FROM \`${table}\``))[0].n);
      await pool.execute('UPDATE users SET session_version=1 WHERE id=1');
      await pool.execute("INSERT IGNORE INTO permissions(code,name,resource,action) VALUES('*','fixture admin','*','*')");
      await pool.execute("INSERT IGNORE INTO user_roles(user_id,role_id) SELECT 1,id FROM roles WHERE name='admin'");
      await pool.execute("INSERT IGNORE INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r,permissions p WHERE r.name='admin' AND p.code='*'");
      const actor = await actorContextService.loadActiveActor(1, 1);
      if (!actor) throw Error('fixture actor unavailable');
      const registry = createConfigurationRegistry();
      const reload = (a: any) => actorContextService.revalidateActor(a);
      const reloadOn = (a: any,c: any) => actorContextService.revalidateActorOn(c,a,a.requestId,true);
      const inventory = async (ref: any) => {
        const r = await configurationInventory(ref);
        if (ref.type === 'network_device') r.attributes['snmp.version'] = { value: 2, source: 'resource_configuration', observed_at: new Date().toISOString() };
        return r;
      };
      const access = { resolve: async (ref: any) => ({ resource: await inventory(ref), credential_ref: `credential:asset-${ref.type}-${ref.id}`,
        evidence: { snmp: new SnmpDiscovery() },
        resolve: async (_credential: any,_target: any,method: string) => {
          if (method === 'sql') return { method, pool: { query: async () => [[{ Variable_name: 'Uptime', Value: String(value) }, { Variable_name: 'Queries', Value: '100' }], []] } };
          if (method === 'ssh') return { method, client: {}, pool: { execCommands: async (_client: any,commands: string[]) => commands.map(command =>
            ({ stdout: command.includes('/proc/uptime') ? String(value) : '0.1', stderr: '', exitCode: 0 })) } };
          if (method === 'snmp') return { method, get: async (oids: string[]) => oids.map(oid => ({ oid, value: value*100, type: 67 })), table: async () => { throw Error('unexpected table'); } };
          throw Error('unexpected remote access');
        } }) };
      const bindings = () => new TemplateBindingService({ pool: () => pool!, registry, access: access as never, inventory, reload, reloadOn, reloadOnLocked: reloadOn });
      const service = bindings();
      // Observe the actual probe boundary so a rejected class retains its attempts.
      const originalProbe = (service as any).probeExecute.bind(service);
      vi.spyOn(service as any, 'probeExecute').mockImplementation(async (...args: any[]) => {
        const result = await originalProbe(...args);
        writeFileSync(join(output,'last-probe.json'),JSON.stringify({resource:args[0],result},null,2));
        return result;
      });
      const collect = new CollectNowService({ pool: () => pool!, registry, reload, reloadOn });
      const repository = new MySqlTemplateRepository(pool as never);
      const templates = new MetricTemplateService(repository, registry);
      const classes = [
        { type: 'server', n: 500, pkg: 'linux-basic', version: '1.0.0', metric: 'linux.uptime.seconds' },
        { type: 'instance', n: 100, pkg: 'mysql-basic', version: '2.0.0', metric: 'db.uptime_seconds' },
        { type: 'network_device', n: 50, pkg: 'snmp-standard', version: '1.0.0', metric: 'snmp.agent.uptime_seconds' },
      ];
      const refs: any[] = [];
      const pins: any = {};
      const setupStarted = performance.now();
      for (const klass of classes) {
        const t = await templates.create(actor as never, { name: `MAX236 ${klass.type}` });
        const pkg = registry.list().map(e => e.package).find(p => p.id === klass.pkg && p.version === klass.version)!;
        const selected = await templates.selectMetric(actor as never, t.template_id, { package: { id: pkg.id, version: pkg.version, digest: pkg.digest }, metric: { id: klass.metric, semantic_version: '1.0.0' } });
        const draft = (await repository.getDraft(t.template_id))!;
        const aggregate = structuredClone(draft.aggregate);
        (aggregate as any).items = [{ item_id: selected.item.item_id, version: selected.item.version }];
        await repository.updateDraft(t.template_id,draft.revision,{ aggregate, updated_by:1,updated_at:new Date().toISOString() });
        const published = await templates.publish(actor as never,t.template_id,{ expected_draft_revision: (await repository.getDraft(t.template_id))!.revision,expected_revision:t.revision });
        const record = (await repository.getTemplate(t.template_id))!;
        await repository.updateTemplate(t.template_id,record.revision,{ status:'active',updated_at:new Date().toISOString() });
        const version = (await repository.getVersion(t.template_id,published.version))!;
        // Publish through the one existing trigger catalog service, via its real handler.
        const { registerTemplateTriggerRoutes } = await import('../triggers/routes.js');
        const { default: Fastify } = await import('fastify');
        const app = Fastify();
        await registerTemplateTriggerRoutes(app,async req => { (req as any).user = actor; },() => pool!);
        const r = await app.inject({ method:'POST', url:`/api/metrics/templates/${t.template_id}/triggers`, payload: {
          expected_version:published.version,expected_content_hash:version.content_hash,item_id:version.items[0].item_id,
          parameters:{ schema:{},defaults:{} },
          problem:{ node:'compare',select:{ aggregation:'last' },operator:'>',threshold:{ kind:'constant',value:90 } },
          recovery:{ node:'compare',select:{ aggregation:'last' },operator:'<',threshold:{ kind:'constant',value:70 } },
          quality:{ accepted_quality:['good'],min_coverage:1,allow_estimated:false },clock:{ stale_after_ms:120000,nodata:{ enabled:false } } } });
        await app.close();
        expect(r.statusCode,r.body).toBe(200);
        pins[klass.type] = [{ template_id:t.template_id,version:r.json().version,content_hash:r.json().content_hash }];
        for (let id=1;id<=klass.n;id++) {
          const host = `fixture-${klass.type}-${id}.invalid`;
          if (klass.type === 'instance') {
            await pool.execute("INSERT INTO database_instances(id,name,environment,db_type,db_version,host,port,username,password_encrypted,status,lifecycle_state) VALUES(?,?,'testing','mysql','9.6',?,1,'fixture','fixture','active','available')",[id,host,host]);
            await pool.execute("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(1,?,'admin')",[id]);
          } else if (klass.type === 'server') await pool.execute("INSERT INTO servers(id,host,os_type,credential_type,credential_encrypted,status) VALUES(?,?,'rhel','password','fixture','online')",[id,host]);
          else {
            await pool.execute('INSERT INTO network_devices(id,name,host) VALUES(?,?,?)',[id,host,host]);
            await pool.execute("INSERT INTO network_device_credentials(device_id,protocol,username,auth_secret_encrypted) VALUES(?,'snmpv2c','fixture','fixture')",[id]);
          }
          const ref = { type:klass.type,id }; refs.push(ref);
          const body = { expected_revision:0,template_pins:pins[klass.type],overrides:baselineOverrides };
          await service.probe(actor,ref as never,body);
          await service.trial(actor,ref as never,{ ...body,receipt_id:`trial-${klass.type}-${id}` });
          const applied = await service.apply(actor,ref as never,{ ...body,receipt_id:`trial-${klass.type}-${id}`,caller_key:`apply-${klass.type}-${id}` });
          expect(applied).toMatchObject({ kind:'committed',revision:1 });
        }
        evidence.setup = { resources_bound:refs.length,elapsed_ms:performance.now()-setupStarted }; save();
      }
      const jobs = new JobRegistry();
      const store = new MysqlScheduleStore(pool,registry,'production');
      new MetricScheduler(store,registry,access as never,Date.now,undefined,undefined,createCollectNowAuthorizer({
        loadActor:(id,v) => actorContextService.loadActiveActor(id,v),loadActorOn:(c,id,v) => actorContextService.loadActiveActorOn(c as never,id,v,undefined,true) })).register(jobs);
      const workers = Array.from({length:Math.max(...points)},(_,i) => new WorkerRuntime(new MysqlWorkflowStore(() => pool as never),`max236-${i}`,30));
      for (const concurrency of points) {
        const point: any = { concurrency,cycles:[],start_samples:await count('metric_observations'),start_events:await count('alert_events') };
        const latencies: number[] = [], readLatencies: number[] = [];
        let rssPeak = process.memoryUsage().rss;
        const started = performance.now(), cpu = process.cpuUsage();
        for (let cycle=0;cycle<cycles;cycle++) {
          value = cycle%2 === 0 ? 95 : 20;
          const admitted = performance.now();
          for (const ref of refs) await collect.collect(actor,ref,{caller_key:`point-${concurrency}-${cycle}`,expected_revision:1});
          const backlog = Number((await rows("SELECT COUNT(*) n FROM workflow_jobs WHERE state='queued'"))[0].n);
          const drainStart = performance.now();
          const completions: number[] = [];
          const deadline=performance.now()+600000;
          while (performance.now()<deadline) {
            let active=0;
            await Promise.all(workers.slice(0,concurrency).map(async worker => {
              const start = performance.now();
              const result = await worker.runOnce((job,ctx) => jobs.execute(job,ctx),Date.now());
              if (result !== 'idle') { active++;latencies.push(performance.now()-start); completions.push(performance.now()-admitted); }
            }));
            rssPeak = Math.max(rssPeak,process.memoryUsage().rss);
            if (!Number((await rows("SELECT COUNT(*) n FROM workflow_jobs WHERE state IN ('queued','retry','running')"))[0].n)) break;
            if (!active) await new Promise(resolve => setTimeout(resolve,50));
          }
          const drainEnd = performance.now();
          const remaining = await rows("SELECT state,COUNT(*) n FROM metric_collect_requests WHERE caller_key=? GROUP BY state",[`point-${concurrency}-${cycle}`]);
          expect(remaining).toEqual([expect.objectContaining({state:'completed',n:650})]);
          for (let i=0;i<refs.length;i+=concurrency) await Promise.all(refs.slice(i,i+concurrency).map(async ref => {
            const start=performance.now();
            const task=await collect.task(actor,ref,`point-${concurrency}-${cycle}`);
            expect(task.samples).toHaveLength(1); expect((task.samples[0].quality as any).status).toBe('good');
            const historical=await service.readConfigurationAt(actor,ref,1);
            expect(historical.state).toBe('effective');
            readLatencies.push(performance.now()-start);
          }));
          const replay=await collect.collect(actor,refs[0],{caller_key:`point-${concurrency}-${cycle}`,expected_revision:1});
          expect(replay.state).toBe('completed');
          point.cycles.push({cycle,backlog_peak:backlog,admission_ms:drainStart-admitted,drain_ms:drainEnd-drainStart,
            read_phase_ms:performance.now()-drainEnd,drain_jobs_per_second:650/((drainEnd-drainStart)/1000),
            end_backlog:Number((await rows("SELECT COUNT(*) n FROM workflow_jobs WHERE state IN ('queued','retry','running')"))[0].n),completion_p95_ms:percentile(completions,0.95)});
        }
        point.elapsed_ms=performance.now()-started;
        point.samples=await count('metric_observations')-point.start_samples;
        point.events=await count('alert_events')-point.start_events;
        point.normalized_samples=Number((await rows("SELECT COUNT(*) n FROM metric_observations WHERE stage='normalized'"))[0].n);
        point.jobs_per_second=650*cycles/(point.elapsed_ms/1000);
        point.worker_ms={p50:percentile(latencies,0.5),p95:percentile(latencies,0.95),max:Math.max(...latencies)};
        point.read_ms={p50:percentile(readLatencies,0.5),p95:percentile(readLatencies,0.95),max:Math.max(...readLatencies)};
        point.node={rss:process.memoryUsage().rss,rss_peak:rssPeak,cpu_us:process.cpuUsage(cpu)};
        point.docker_snapshot=JSON.parse(execFileSync('docker',['stats','--no-stream','--format','{{json .}}',handle.container_id],{encoding:'utf8',timeout:15000}).trim());
        point.mysql=(await rows("SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Threads_running','Innodb_buffer_pool_bytes_data','Bytes_received','Bytes_sent')"));
        expect(point.events).toBe(650*cycles/2);
        evidence.points.push(point); save();
      }
      const samples=await rows("SELECT id,payload FROM metric_observations WHERE stage='normalized' ORDER BY id");
      expect(samples).toHaveLength(650*cycles*points.length);
      expect(new Set(samples.map(r=>r.id)).size).toBe(samples.length);
      expect(await count('metric_trigger_heads')).toBe(650);
      expect(await count('metric_trigger_episodes')).toBe(650*cycles/2*points.length);
      expect(Number((await rows("SELECT COUNT(*) n FROM alert_events WHERE status='resolved'"))[0].n)).toBe(650*cycles/2*points.length);
      expect(Number((await rows("SELECT COUNT(*) n FROM alert_event_logs WHERE action='resolved'"))[0].n)).toBe(650*cycles/2*points.length);
      expect(Number((await rows("SELECT COUNT(*) n FROM workflow_jobs WHERE job_type='notification.deliver'"))[0].n)).toBe(0);
      evidence.consistency={normalized:samples.length,digest:hash(samples),heads:650,duplicate_sample_ids:0,duplicate_collect_replay_jobs:0,notification_jobs:0};
      // Copy this run's real formal rows, schema and ledgers. No shared source, stop-write or production switch.
      await guard();
      await root.query(`CREATE DATABASE \`${copy}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      await root.query('SET FOREIGN_KEY_CHECKS=0');
      const tables=(await rows('SHOW TABLES')).map(r=>String(Object.values(r)[0]));
      for (const table of tables) {
        if (!/^[a-zA-Z0-9_]+$/.test(table)) throw Error('unsafe table');
        await root.query(`CREATE TABLE \`${copy}\`.\`${table}\` LIKE \`${schema}\`.\`${table}\``);
        await root.query(`INSERT INTO \`${copy}\`.\`${table}\` SELECT * FROM \`${schema}\`.\`${table}\``);
      }
      await root.query('SET FOREIGN_KEY_CHECKS=1');
      copyPool=mysql.createPool({...base,database:copy,connectionLimit:24});
      pool=copyPool;
      const ref=refs.find(r=>r.type==='instance');
      const copyBindings=bindings();
      // Fresh capability evidence still comes from the formal writer. A copied
      // timestamp is never extended by hand to make a migration executable.
      const copyCollect=new CollectNowService({pool:()=>pool!,registry,reload,reloadOn});
      await copyCollect.collect(actor,ref,{caller_key:'copy-refresh',expected_revision:1});
      const copyJobs=new JobRegistry();
      const copyStore=new MysqlScheduleStore(pool,registry,'production');
      const originalCommit=copyStore.commitCollectNow.bind(copyStore);
      vi.spyOn(copyStore,'commitCollectNow').mockImplementation(async (...args: Parameters<typeof originalCommit>) => {
        try { return await originalCommit(...args); }
        catch (error) { writeFileSync(join(output,'copy-commit-error.json'),JSON.stringify({message:String(error),code:(error as any).code}));throw error; }
      });
      new MetricScheduler(copyStore,registry,access as never,Date.now,undefined,undefined,
        createCollectNowAuthorizer({loadActor:(id,v)=>actorContextService.loadActiveActor(id,v),
          loadActorOn:(c,id,v)=>actorContextService.loadActiveActorOn(c as never,id,v,undefined,true)})).register(copyJobs);
      const copyWorker=new WorkerRuntime(new MysqlWorkflowStore(()=>pool as never),'max236-copy',30);
      let copyState: string='idle';
      const copyDeadline=performance.now()+15000;
      while(copyState==='idle' && performance.now()<copyDeadline) {
        copyState=await copyWorker.runOnce((job,ctx)=>copyJobs.execute(job,ctx));
        if(copyState==='idle') await new Promise(resolve=>setTimeout(resolve,50));
      }
      expect(copyState).toBe('completed');
      expect((await copyCollect.task(actor,ref,'copy-refresh')).samples).toHaveLength(1);
      const nativePayload=(await rows('SELECT payload FROM metric_policy_bindings WHERE resource_key=?',[`instance:${ref.id}`]))[0].payload;
      expect(() => parseRealBinding(nativePayload)).toThrow('REAL_NATIVE_BINDING_UNSUPPORTED');
      const historical=await copyBindings.readConfigurationAt(actor,ref,1);
      const preservedTables=['metric_observations','metric_publications','metric_trigger_heads','metric_trigger_episodes','alert_events','alerts','instance_permissions','database_instances','servers','network_device_credentials','network_device_observations','metrics_history','server_metrics'];
      const digests=async () => Object.fromEntries(await Promise.all(preservedTables.map(async t=>[t,hash(await rows(`SELECT * FROM \`${t}\` ORDER BY 1`))])));
      const before=await digests();
      const body={expected_revision:1,template_pins:pins.instance,overrides:{...baselineOverrides,interval_ms:{mode:'set',value:120000}}};
      const previewA=await copyBindings.preview(actor,ref,body),previewB=await copyBindings.preview(actor,ref,body);
      expect(previewB).toEqual(previewA); expect(await digests()).toEqual(before);
      await copyBindings.trial(actor,ref,{...body,receipt_id:'copy-migration'});
      const auditBefore=await count('metric_policy_audit');
      const bindingBefore=await rows('SELECT * FROM metric_policy_bindings ORDER BY resource_key');
      await root.query(`CREATE TRIGGER \`${copy}\`.max236_fail_audit BEFORE INSERT ON \`${copy}\`.metric_policy_audit FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='max236 injected audit failure'`);
      expect(await copyBindings.apply(actor,ref,{...body,receipt_id:'copy-migration',caller_key:'copy-failure'}))
        .toMatchObject({kind:'rejected',committed:false});
      await root.query(`DROP TRIGGER \`${copy}\`.max236_fail_audit`);
      expect(await rows('SELECT * FROM metric_policy_bindings ORDER BY resource_key')).toEqual(bindingBefore);
      expect(await count('metric_policy_audit')).toBe(auditBefore);
      expect(await digests()).toEqual(before);
      const apply=await copyBindings.apply(actor,ref,{...body,receipt_id:'copy-migration',caller_key:'copy-apply'});
      expect(apply).toMatchObject({kind:'committed',revision:2});
      const audits=await count('metric_policy_audit');
      const replay=await copyBindings.apply(actor,ref,{...body,receipt_id:'copy-migration',caller_key:'copy-apply'});
      expect(await count('metric_policy_audit')).toBe(audits);
      await expect(copyBindings.apply(actor,ref,{...body,caller_key:'stale',receipt_id:'copy-migration'}))
        .rejects.toThrow('TRANSACTION_REVISION_CONFLICT');
      const rollbackBody={expected_revision:2,template_pins:pins.instance,overrides:baselineOverrides};
      await copyBindings.trial(actor,ref,{...rollbackBody,receipt_id:'copy-rollback'});
      const rollback=await copyBindings.apply(actor,ref,{...rollbackBody,receipt_id:'copy-rollback',caller_key:'copy-rollback'});
      expect(rollback).toMatchObject({kind:'committed',revision:3});
      const restored=(await rows('SELECT payload FROM metric_policy_bindings WHERE resource_key=?',[`instance:${ref.id}`]))[0].payload.binding;
      const original=bindingBefore.find(r=>r.resource_key===`instance:${ref.id}`)!.payload.binding;
      expect(restored).toEqual({...original,revision:3});
      expect(await copyBindings.readConfigurationAt(actor,ref,1)).toEqual(historical);
      expect(await digests()).toEqual(before);
      evidence.migration={database:copy,tables:tables.length,preview_repeat_identical:true,post_audit_failure_zero_writes:true,
        apply,replay,rollback,historical_revision_1:historical,preserved_digests:before,legacy_executor_native_refused:true,
        method:'native compiled bindings use the existing TemplateBindingService CAS/receipt transaction; R3 legacy executor remains strict and is tested separately',
        rollback_policy:'new revision restores original pins/overrides; immutable original revision retained; no lossy downgrade'};
      evidence.status='passed';save();
    } catch (error) {
      evidence.status='failed';evidence.error=String(error);save();throw error;
    } finally {
      vi.restoreAllMocks();
      await copyPool?.end();
      await originalPool?.end();
      await root.end();
    }
  }, 1_800_000);
});
