import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { parse } from 'dotenv';
import { Client } from 'ssh2';
import mysql, { type Pool } from 'mysql2/promise';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { dbConnection, encryptData, decryptData } from '../../db-connection.js';
import { createHash } from 'node:crypto';
import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
import { createServer, type ViteDevServer } from '../../../../../frontend/node_modules/vite/dist/node/index.js';
import { registerMetricPolicyRoutes } from '../policy/routes.js';
import { diagnosticReleases, diagnosticReads } from '../database/diagnostics.js';
import { sourceDigest } from '../database/reviewed-sql.js';
import { reviewedSqlCatalog } from '../database/reviewed-sql-catalog.js';
import { MySQLProvider } from '../../collectors/mysql.provider.js';
import { metricRegistry } from '../../metric-registry.js';
import { databaseService } from '../../database-service.js';
import sshSessionPool from '../../ssh-session-pool.js';
import { fingerprintSshHostKey } from '../../security/ssh-host-key.js';
import { MysqlPolicyStore } from '../policy/store.js';
import { PolicyService } from '../policy/service.js';
import { admin } from '../policy/test-support.js';
import { createConfigurationRegistry } from './registry.js';
import { configurationInventory } from './inventory.js';
import { createAssetCollectorAccess } from './access.js';
import { MetricConfigurationService } from './service.js';
import { configurationReader } from './status-store.js';
import { createTrialStore, registerMetricConfigurationRoutes } from './routes.js';
import { MetricScheduler } from '../scheduler/service.js';
import { MysqlScheduleStore } from '../scheduler/store.js';
import { MetricFormalization } from '../rollout/formalization.js';
import { MetricConsumerService, type ConsumerStore } from '../consumers/service.js';
import { registerMetricConsumerRoutes } from '../consumers/routes.js';
import { MysqlFormalMetricStore } from '../rollout/formal-store.js';
import { MysqlWorkflowStore, WorkerRuntime } from '../../workflows/worker-runtime.js';
import { JobRegistry } from '../../workflows/job-registry.js';

// Explicit opt-in. Writes only to a disposable platform schema; real managed targets receive fixed read-only commands.
describe.skipIf(process.env.UNIFIED_METRICS_REAL !== 'true')('real MySQL 9.6 and authorized VM formal collection', () => {
  const database=`max189_real_${process.pid}`;
  let packages:ReturnType<typeof createConfigurationRegistry>;
  const custom=process.env.UNIFIED_METRICS_CUSTOM==='true';
  const existing=process.env.UNIFIED_METRICS_EXISTING==='true';
  const ui=process.env.UNIFIED_METRICS_UI==='true';
  const customSource={id:'visible_schema_count',target_type:'instance',unit:'count',value_type:'gauge',default_interval:60,collection_sqls:{mysql:'SELECT COUNT(*) FROM information_schema.SCHEMATA'},compute_expr:null};
  const customId=existing?'mysql-custom-existing-scalars':'mysql-custom-visible-schemas';
  const refs=([{type:'instance' as const,id:existing?1:18901},{type:'server' as const,id:existing?3:18902}]).slice(0,process.env.UNIFIED_METRICS_VM==='false'?1:2);
  let browser:Browser|undefined,vite:ViteDevServer|undefined,web:string;
  let sourceSnapshot:()=>Promise<string>;
  let root:Pool,pool:Pool,target:Pool,app:ReturnType<typeof Fastify>,base:string,service:MetricConfigurationService,scheduler:MetricScheduler,worker:WorkerRuntime,jobs:JobRegistry;
  const evidence:Record<string,unknown>={},artifacts=process.env.UNIFIED_METRICS_EVIDENCE;
  let poolSpy: ReturnType<typeof vi.spyOn>;
  const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
  const request=async(path:string,body?:unknown)=>{
    const res=await fetch(`${base}/api/metrics/${path}`,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
    const result=await res.json() as any;if(res.status!==200)evidence.last_http_error={path,status:res.status,result};expect(res.status,JSON.stringify(result)).toBe(200);return result;
  };
  const status=(i:number)=>request(`config/resources/${refs[i].type}/${refs[i].id}/status`);
  const query=(i:number)=>request('query',{resource:refs[i],view:'all',from:new Date(Date.now()-60000).toISOString(),to:new Date().toISOString(),bucket_ms:5000});
  beforeAll(async()=>{
    if(artifacts)await mkdir(artifacts,{recursive:true});
    vi.stubEnv('METRICS_COLLECTION_ENABLED','true');
    if(custom&&!existing){
      const {id,version,digest}=diagnosticReleases().find(r=>r.package.id==='mysql-diagnostics'&&r.package.version==='1.1.0')!.package;
      reviewedSqlCatalog.push({id:customId,version:'1.0.0',base:{id,version,digest},engine:'mysql',source_id:customSource.id,source_digest:sourceDigest(customSource,'mysql'),sql:customSource.collection_sqls.mysql,
        definition:{...diagnosticReads.find(r=>r.name==='active_transactions'&&r.engine==='mysql')!.fields[0].definition,namespace:'custom',id:'custom.visible_schema_count',meaning:'Visible information_schema.SCHEMATA count under the authorized database account.'},
        permissions:['SELECT information_schema.SCHEMATA'],review:{reference:'MAX189 isolated real-service fixture, not deployment approval',reviewed_by:'automated qualification'}});
    }
    packages=createConfigurationRegistry();
    const configured=parse(readFileSync(process.env.SLIDE_DEBUG_ENV_FILE!));
    vi.stubEnv('ENCRYPTION_KEY',configured.ENCRYPTION_KEY);
    const config={host:configured.DB_HOST||'127.0.0.1',port:Number(configured.DB_PORT||3306),user:configured.DB_USER||'root',password:configured.DB_PASSWORD||''};
    target=mysql.createPool({...config,database:configured.DB_NAME});
    const [version]=await target.query<any[]>('SELECT VERSION() AS version');expect(version[0].version).toMatch(/^9\.6\./);
    evidence.mysql={version:version[0].version,host:config.host,port:config.port};
    root=mysql.createPool({host:'127.0.0.1',port:Number(process.env.METRICS_TEST_MYSQL_PORT),user:'root',password:''});
    await root.query(`CREATE DATABASE ${database}`);
    pool=mysql.createPool({host:'127.0.0.1',port:Number(process.env.METRICS_TEST_MYSQL_PORT),user:'root',password:'',database,connectionLimit:16,timezone:'Z'});
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    poolSpy=vi.spyOn(dbConnection,'getPool').mockReturnValue(pool);
    await pool.execute("INSERT INTO database_instances(id,name,host,port,username,password_encrypted,db_type,db_version,database_name,status) VALUES(?,'MAX189 isolated real target',?,?,?,?,'mysql',?,'mysql','active')",
      [refs[0].id,config.host,config.port,config.user,encryptData(config.password),version[0].version]);
    expect(await databaseService.addConnection(refs[0].id,'MAX189 real read-only validation',{...config,database:'mysql',db_type:'mysql'})).toBe(true);
    const original = await new MySQLProvider().collect(databaseService.getConnection(refs[0].id)!,metricRegistry.getById('connections')!);
    expect(original).not.toBeNull();
    await pool.execute('INSERT INTO metrics_history(instance_id,connections,recorded_at) VALUES(?,?,NOW())',[refs[0].id,original]);
    evidence.actual_historical_snapshot={metric:'connections',value:original,producer:'original MySQLProvider',periodic:false};
    if(existing){
      const [definitions]=await target.query<any[]>("SELECT id,target_type,name,unit,value_type,db_types,aggregation,default_interval,is_collected,is_builtin,collection_sqls,compute_expr FROM metric_definitions WHERE is_builtin=0");
      const [templates]=await target.query<any[]>('SELECT t.id,t.name,t.db_type,t.macro_defaults,t.metrics,t.enabled,i.macro_overrides,i.disabled_metrics FROM metric_templates t JOIN instance_templates i ON i.template_id=t.id WHERE i.instance_id=1');
      sourceSnapshot=async()=>{
        const [d]=await target.query('SELECT id,target_type,unit,value_type,default_interval,collection_sqls,compute_expr FROM metric_definitions WHERE is_builtin=0 ORDER BY id');
        const [t]=await target.query('SELECT * FROM instance_templates WHERE instance_id=1 ORDER BY template_id');
        const [s]=await target.query('SELECT id,host,port,os_type,credential_type,credential_encrypted,host_key_fingerprint,collection_enabled FROM servers WHERE id=3');
        return createHash('sha256').update(JSON.stringify([d,t,s])).digest('hex');
      };
      evidence.original_configuration_digest=await sourceSnapshot();
      // The live legacy schema has optional columns absent from fresh baseline installs.
      // Reproduce them only in the disposable copy; never discard retained user data.
      for(const [table,column] of [['metric_templates','metrics'],['instance_templates','disabled_metrics']]){
        const [columns]=await pool.query<any[]>('SHOW COLUMNS FROM ?? LIKE ?',[table,column]);
        if(!columns.length)await pool.query('ALTER TABLE ?? ADD COLUMN ?? JSON NULL',[table,column]);
      }
      for(const row of definitions){
        for(const k of ['collection_sqls','db_types'])if(row[k]&&typeof row[k]!=='string')row[k]=JSON.stringify(row[k]);
        await pool.query('INSERT INTO metric_definitions SET ? ON DUPLICATE KEY UPDATE ?', [row,row]);
      }
      for(const row of templates){
        const {macro_overrides,disabled_metrics,...template}=row;
        for(const k of ['macro_defaults','metrics'])if(template[k]&&typeof template[k]!=='string')template[k]=JSON.stringify(template[k]);
        await pool.query('INSERT INTO metric_templates SET ? ON DUPLICATE KEY UPDATE ?',[template,template]);
        await pool.execute('INSERT INTO instance_templates(instance_id,template_id,macro_overrides,disabled_metrics) VALUES(?,?,?,?)',
          [refs[0].id,row.id,macro_overrides&&JSON.stringify(macro_overrides),disabled_metrics&&JSON.stringify(disabled_metrics)]);
      }
      evidence.existing_sources=definitions.map(s=>({id:s.id,digest:sourceDigest(s,'mysql')}));
      evidence.existing_template_ids=templates.map(t=>t.id);
    }
    if(refs.length>1){
    const [servers]=existing?await target.query<any[]>('SELECT * FROM servers WHERE id=3 AND host=?',['192.168.49.130']):[[]];
    const source=servers[0];
    if(existing)expect(source).toMatchObject({id:3,host:'192.168.49.130',collection_enabled:0});
    const credentials=source?JSON.parse(decryptData(source.credential_encrypted,configured.ENCRYPTION_KEY)):null;
    const password=credentials?.password??process.env.SLIDE_DEBUG_VM_PASSWORD??execFileSync('security',['find-generic-password','-s','com.slide.debug.vmware-fusion.192.168.49.130','-a','root','-w'],{encoding:'utf8'}).trim();
    const fingerprint=await new Promise<string>((resolve,reject)=>{
      const client=new Client();let pin='';client.once('error',()=>reject(new Error('VM_SSH_CONNECT_FAILED'))).once('ready',()=>{client.end();resolve(pin);});
      client.connect({host:'192.168.49.130',port:22,username:credentials?.username??'root',password,readyTimeout:10000,hostVerifier:key=>{pin=fingerprintSshHostKey(key);return pin===(source?.host_key_fingerprint??process.env.UNIFIED_METRICS_VM_FINGERPRINT??pin);}});
    });
    await pool.execute("INSERT INTO servers(id,host,port,label,os_type,credential_type,credential_encrypted,host_key_fingerprint,status,collection_enabled) VALUES(?,'192.168.49.130',22,'MAX189 isolated VM',?,'password',?,?,'online',1)",
      [refs[1].id,source?.os_type??'kylin',encryptData(JSON.stringify({username:credentials?.username??'root',password})),fingerprint]);
    evidence.vm={host:'192.168.49.130',port:22,fingerprint,source_server_id:source?.id,source_collection_enabled:source?.collection_enabled};
    }
    const policy=new PolicyService(new MysqlPolicyStore(()=>pool),packages,{exists:async()=>true,inventory:configurationInventory});
    const attempts=createTrialStore(()=>pool,packages);
    service=new MetricConfigurationService(policy,packages,attempts,createAssetCollectorAccess(),configurationReader(()=>pool));
    const formal=new MysqlFormalMetricStore(pool);
    const store:ConsumerStore={queryWindow:(...a)=>formal.queryWindow(...a),dimensions:(...a)=>formal.dimensions(...a),latestCapacity:(...a)=>formal.latestCapacity(...a),inventory:async(type,id)=>configurationInventory({type,id:Number(id)}),attempts:ref=>attempts.attempts(ref)};
    const consumer=new MetricConsumerService(policy,packages,store);
    const realQuery=consumer.query.bind(consumer);
    vi.spyOn(consumer,'query').mockImplementation(async(...args)=>{
      try{return await realQuery(...args);}catch(error){
        evidence.consumer_error={name:(error as Error).name,reason:/^[A-Z_]+$/.test((error as Error).message)?(error as Error).message:(error as {code?:string}).code,
          stack:(error as Error).stack?.split('\n').slice(1,5)};throw error;
      }
    });
    app=Fastify();const auth=async(req:any)=>{req.user=admin;};
    await registerMetricPolicyRoutes(app,auth,policy);await registerMetricConfigurationRoutes(app,auth,service);await registerMetricConsumerRoutes(app,auth,consumer);
    base=await app.listen({host:'127.0.0.1',port:0});
    if(ui){
      expect(refs[0].id).toBe(1);
      vite=await createServer({configFile:false,root:process.env.UNIFIED_METRICS_FRONTEND_ROOT,server:{host:'127.0.0.1',port:0,proxy:{'/api':base}},logLevel:'error'});
      await vite.listen();web=`http://127.0.0.1:${(vite.httpServer!.address() as {port:number}).port}`;
      browser=await chromium.launch({headless:true});
    }
    scheduler=new MetricScheduler(new MysqlScheduleStore(pool,packages,'production'),packages,createAssetCollectorAccess(true),Date.now,undefined,new MetricFormalization(pool,packages));
    jobs=new JobRegistry();scheduler.register(jobs);worker=new WorkerRuntime(new MysqlWorkflowStore(()=>pool as never),'max189-real',30);
  },120000);
  afterAll(async()=>{
    await browser?.close();await vite?.close();
    if(pool){
      const [checks]=await pool.query<any[]>('SELECT resource_key,payload FROM metric_source_checks');
      evidence.final_source_checks=checks.map(r=>({resource_key:r.resource_key,payload:typeof r.payload==='string'?JSON.parse(r.payload):r.payload}));
    }
    await app?.close();await databaseService.removeConnection(refs[0].id);sshSessionPool.closeAll();poolSpy?.mockRestore();
    if(sourceSnapshot){evidence.original_configuration_unchanged=await sourceSnapshot()===evidence.original_configuration_digest;expect(evidence.original_configuration_unchanged).toBe(true);}
    await target?.end();await pool?.end();if(root){await root.query(`DROP DATABASE IF EXISTS ${database}`);await root.end();}
    if(custom&&!existing){const index=reviewedSqlCatalog.findIndex((m:any)=>m.id===customId);if(index>=0)reviewedSqlCatalog.splice(index,1);}
    vi.unstubAllEnvs();
    if(artifacts){await mkdir(artifacts,{recursive:true});await writeFile(`${artifacts}/real-flow-${refs.length===1?'mysql':'mysql-vm'}.json`,JSON.stringify(evidence,null,2));}
  },30000);
  it('normal activation, at least three real formal cycles, asset pause, restart and resume',async()=>{
    const pins=[packages.list().find(r=>r.package.id===(custom?customId:'mysql-diagnostics')&&r.package.version===(custom?'1.0.0':'1.1.0'))!.package,packages.list().find(r=>r.package.id==='linux-host'&&r.package.version==='1.1.0')!.package];
    for(let i=0;i<refs.length;i++){
      expect((await status(i)).binding.state).toBe('unbound');
      const p=pins[i],ref=refs[i];
      if(existing&&i===0){
        const migration=await request(`config/resources/instance/${ref.id}/migration`);
        expect(migration.items.find((m:any)=>m.source_id==='connections')).toMatchObject({state:'reviewed',package:{id:customId}});
        expect(migration.items.find((m:any)=>m.source_id==='disk_usage')).toMatchObject({state:'blocked',code:'CUSTOM_EXPRESSION_REVIEW_REQUIRED'});
        expect(migration.items.some((m:any)=>m.kind==='deprecated_template')).toBe(true);
        evidence.existing_migration=migration;
      }
      if(ui&&i===0){
        const page=await browser!.newPage({viewport:{width:1440,height:1000}});
        await page.goto(`${web}/e2e/fixtures/metrics-config.html`);
        await page.getByLabel('采集包 / 模板版本',{exact:true}).selectOption(p.digest);
        // Use the normal editor controls; no synthetic trial results or publication rows.
        await page.getByLabel('采集间隔（秒）覆盖方式',{exact:true}).selectOption('set');
        await page.getByLabel('采集间隔（秒）',{exact:true}).fill('5');
        await page.getByRole('button',{name:'检查并启用',exact:true}).click();
        const dialog=page.locator('app-dialog[title="检查并启用采集"]');
        await dialog.getByRole('button',{name:'预检与影响预览'}).click();
        const trialResponse=page.waitForResponse(r=>r.url().endsWith('/trial')&&r.request().method()==='POST');
        await dialog.getByRole('button',{name:'试采',exact:true}).click();
        const trial=await trialResponse;evidence.ui_trial={status:trial.status(),body:await trial.json()};
        if(artifacts)await page.screenshot({path:`${artifacts}/real-mysql-ui-trial.png`,fullPage:true});
        await browserExpect(dialog.getByText('试采成功，可以发布',{exact:true})).toBeVisible();
        const activation=page.waitForResponse(r=>r.url().endsWith('/activate')&&r.request().method()==='POST');
        await dialog.getByRole('button',{name:'发布',exact:true}).click();
        const response=await activation;expect(response.status()).toBe(200);evidence[`activate_${ref.type}`]=await response.json();
        if(artifacts)await page.screenshot({path:`${artifacts}/real-mysql-ui-published.png`,fullPage:true});
        await page.close();
      }else {
        const candidate={expected_revision:0,package:{id:p.id,version:p.version,digest:p.digest},overrides:{interval_ms:{mode:'set',value:5000},timeout_ms:{mode:'set',value:5000},max_rows:{mode:'set',value:100}}};
        evidence[`trial_${ref.type}`]=await request(`config/resources/${ref.type}/${ref.id}/trial`,candidate);
        evidence[`activate_${ref.type}`]=await request(`config/resources/${ref.type}/${ref.id}/activate`,candidate);
      }
      expect((await status(i)).binding.application).toBe('pending');
    }
    if(existing&&refs.length>1){
      await pool.execute('UPDATE servers SET collection_enabled=0 WHERE id=?',[refs[1].id]);
      const count=async()=>Number((await pool.query<any[]>("SELECT COUNT(*) AS n FROM metric_attempts WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.binding_id'))=?",[`server:${refs[1].id}`]))[0][0].n);
      const before=await count();await scheduler.tick();await wait(5500);await scheduler.tick();
      expect(await count()).toBe(before);expect((await status(1)).effective_enabled).toMatchObject({enabled:false,source:'asset'});
      evidence.vm_initially_disabled={attempts_before:before,attempts_after:await count(),status:await status(1)};
      await pool.execute('UPDATE servers SET collection_enabled=1 WHERE id=?',[refs[1].id]);
    }
    const cycles=[];
    for(let cycle=0;cycle<5;cycle++){
      await scheduler.tick();await wait(5200);await scheduler.tick();await wait(1100);
      for(let job=0;job<refs.length;job++) {
        const outcome=await worker.runOnce((j,c)=>jobs.execute(j,c),Date.now());
        const [events]=await pool.query('SELECT code, duration_ms, logical_reads FROM metric_schedule_events ORDER BY id DESC LIMIT 8');
        expect(outcome,JSON.stringify(events)).toBe('completed');
      }
      await scheduler.tick();cycles.push(await Promise.all(refs.map((_,i)=>status(i))));
    }
    evidence.cycles=cycles;
    const [counts]=await pool.query<any[]>("SELECT r.resource_type,COUNT(DISTINCT p.observed_at) AS cycles FROM metric_publications p JOIN metric_rollout r ON r.series_hash=p.series_hash GROUP BY r.resource_type");
    expect(counts.every(r=>Number(r.cycles)>=3)).toBe(true);expect(counts).toHaveLength(refs.length);evidence.formal_cycles=counts;
    const [accepted]=await pool.query<any[]>('SELECT evidence FROM metric_source_acceptance WHERE resource_key=?',[`instance:${refs[0].id}`]);
    const source=typeof accepted[0].evidence==='string'?JSON.parse(accepted[0].evidence):accepted[0].evidence;
    expect(source.kind).toBe('historical_source_migration');expect(source.legacy_comparison.state).toBe('passed');
    evidence.source_acceptance=source;
    evidence.formal_api=await Promise.all(refs.map((_,i)=>query(i)));
    for(const response of evidence.formal_api as any[])expect(response.metrics.some((m:any)=>m.series.some((s:any)=>s.buckets.some((b:any)=>b.value!==null)))).toBe(true);
    const mysqlMetrics=(evidence.formal_api as any[])[0].metrics;
    for(const id of ['db.uptime_seconds','mysql.processlist.count','mysql.connections.limit','mysql.threads.connected','mysql.files.open','mysql.innodb.row_lock_average_ms','mysql.thread_cache.hit_percent','mysql.transactions.active',...(custom?(existing?['custom.mysql.processlist_connections','custom.mysql.slow_queries_snapshot']:['custom.visible_schema_count']):[])])expect(mysqlMetrics.find((m:any)=>m.definition.id===id)?.series.some((s:any)=>s.buckets.some((b:any)=>b.value!==null))).toBe(true);
    evidence.code_head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
    evidence.reviewed_custom_fixture=custom&&!existing;
    evidence.existing_user_configuration=existing;
    evidence.ui_boundary=ui?'Production metric-configuration component in isolated HTML host, real HTTP/SQL/SSH; test admin identity; not full authenticated product navigation':null;
    const last=refs.length-1,ref=refs[last],binding=`${ref.type}:${ref.id}`;
    const pause=ref.type==='server'?'UPDATE servers SET collection_enabled=0 WHERE id=?':"UPDATE database_instances SET status='inactive' WHERE id=?";
    const resume=ref.type==='server'?'UPDATE servers SET collection_enabled=1 WHERE id=?':"UPDATE database_instances SET status='active' WHERE id=?";
    await pool.query(pause,[ref.id]);
    const count=async()=>Number((await pool.query<any[]>("SELECT COUNT(*) AS n FROM metric_attempts WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.binding_id'))=?",[binding]))[0][0].n);
    const before=await count();await wait(5500);await scheduler.tick();const after=await count();
    expect(after).toBe(before);expect((await status(last)).effective_enabled).toMatchObject({enabled:false,source:'asset'});
    evidence.paused={attempts_before:before,attempts_after:after,status:await status(last)};
    const beforeResume = await status(last);
    await pool.query(resume,[ref.id]);
    const restarted=new MetricScheduler(new MysqlScheduleStore(pool,packages,'production'),packages,createAssetCollectorAccess(true));
    await restarted.tick();await wait(1100);for(let n=0;n<refs.length;n++)await worker.runOnce((j,c)=>jobs.execute(j,c),Date.now());
    expect(await count()).toBeGreaterThan(after);
    const resumed = await status(last);
    expect(resumed.effective_enabled.enabled).toBe(true);
    expect(resumed.formal_visibility).toMatchObject({state:'available',freshness:'fresh'});
    expect(Date.parse(resumed.formal_visibility.last_observed_at)).toBeGreaterThan(Date.parse(beforeResume.formal_visibility.last_observed_at));
    expect(Date.parse(resumed.collection.last_success_at)).toBeGreaterThan(Date.parse(beforeResume.collection.last_success_at));
    const resumedApi = await query(last);
    expect(resumedApi.metrics.some((m:any)=>m.series.some((s:any)=>s.buckets.some((b:any)=>b.value!==null
      && Date.parse(b.observed_at)>Date.parse(beforeResume.formal_visibility.last_observed_at))))).toBe(true);
    evidence.resumed=resumed;
    evidence.resumed_formal_api=resumedApi;
  },120000);
});
