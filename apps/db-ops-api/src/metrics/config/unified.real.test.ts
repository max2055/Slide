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
import { dbConnection, encryptData } from '../../db-connection.js';
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
  const database=`max189_real_${process.pid}`, packages=createConfigurationRegistry();
  const refs=([{type:'instance' as const,id:18901},{type:'server' as const,id:18902}]).slice(0,process.env.UNIFIED_METRICS_VM==='false'?1:2);
  let root:Pool,pool:Pool,target:Pool,app:ReturnType<typeof Fastify>,base:string,service:MetricConfigurationService,scheduler:MetricScheduler,worker:WorkerRuntime,jobs:JobRegistry;
  const evidence:Record<string,unknown>={},artifacts=process.env.UNIFIED_METRICS_EVIDENCE;
  let poolSpy: ReturnType<typeof vi.spyOn>;
  const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
  const request=async(path:string,body?:unknown)=>{
    const res=await fetch(`${base}/api/metrics/${path}`,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
    const result=await res.json() as any;expect(res.status,JSON.stringify(result)).toBe(200);return result;
  };
  const status=(i:number)=>request(`config/resources/${refs[i].type}/${refs[i].id}/status`);
  const query=(i:number)=>request('query',{resource:refs[i],view:'all',from:new Date(Date.now()-60000).toISOString(),to:new Date().toISOString(),bucket_ms:5000});
  beforeAll(async()=>{
    vi.stubEnv('METRICS_COLLECTION_ENABLED','true');
    const configured=parse(readFileSync(process.env.SLIDE_DEBUG_ENV_FILE!));
    vi.stubEnv('ENCRYPTION_KEY',configured.ENCRYPTION_KEY);
    const config={host:configured.DB_HOST||'127.0.0.1',port:Number(configured.DB_PORT||3306),user:configured.DB_USER||'root',password:configured.DB_PASSWORD||''};
    target=mysql.createPool(config);
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
    if(refs.length>1){
    const password=process.env.SLIDE_DEBUG_VM_PASSWORD??execFileSync('security',['find-generic-password','-s','com.slide.debug.vmware-fusion.192.168.49.130','-a','root','-w'],{encoding:'utf8'}).trim();
    const fingerprint=await new Promise<string>((resolve,reject)=>{
      const client=new Client();let pin='';client.once('error',()=>reject(new Error('VM_SSH_CONNECT_FAILED'))).once('ready',()=>{client.end();resolve(pin);});
      client.connect({host:'192.168.49.130',port:22,username:'root',password,readyTimeout:10000,hostVerifier:key=>{pin=fingerprintSshHostKey(key);return true;}});
    });
    await pool.execute("INSERT INTO servers(id,host,port,label,os_type,credential_type,credential_encrypted,host_key_fingerprint,status,collection_enabled) VALUES(?,'192.168.49.130',22,'MAX189 isolated VM','linux','password',?,?,'online',1)",
      [refs[1].id,encryptData(JSON.stringify({username:'root',password})),fingerprint]);
    evidence.vm={host:'192.168.49.130',port:22,fingerprint};
    }
    const policy=new PolicyService(new MysqlPolicyStore(()=>pool),packages,{exists:async()=>true,inventory:configurationInventory});
    const attempts=createTrialStore(()=>pool,packages);
    service=new MetricConfigurationService(policy,packages,attempts,createAssetCollectorAccess(),configurationReader(()=>pool));
    const formal=new MysqlFormalMetricStore(pool);
    const store:ConsumerStore={queryWindow:(...a)=>formal.queryWindow(...a),dimensions:(...a)=>formal.dimensions(...a),latestCapacity:(...a)=>formal.latestCapacity(...a),inventory:async(type,id)=>configurationInventory({type,id:Number(id)}),attempts:ref=>attempts.attempts(ref)};
    const consumer=new MetricConsumerService(policy,packages,store);
    app=Fastify();const auth=async(req:any)=>{req.user=admin;};
    await registerMetricConfigurationRoutes(app,auth,service);await registerMetricConsumerRoutes(app,auth,consumer);
    base=await app.listen({host:'127.0.0.1',port:0});
    scheduler=new MetricScheduler(new MysqlScheduleStore(pool,packages,'production'),packages,createAssetCollectorAccess(true),Date.now,undefined,new MetricFormalization(pool,packages));
    jobs=new JobRegistry();scheduler.register(jobs);worker=new WorkerRuntime(new MysqlWorkflowStore(()=>pool as never),'max189-real',30);
  },120000);
  afterAll(async()=>{
    await app?.close();await databaseService.removeConnection(refs[0].id);sshSessionPool.closeAll();poolSpy?.mockRestore();
    await target?.end();await pool?.end();if(root){await root.query(`DROP DATABASE IF EXISTS ${database}`);await root.end();}
    vi.unstubAllEnvs();
    if(artifacts){await mkdir(artifacts,{recursive:true});await writeFile(`${artifacts}/real-flow-${refs.length===1?'mysql':'mysql-vm'}.json`,JSON.stringify(evidence,null,2));}
  },30000);
  it('normal activation, at least three real formal cycles, asset pause, restart and resume',async()=>{
    const pins=[packages.list().find(r=>r.package.id==='mysql-diagnostics'&&r.package.version==='1.0.0')!.package,packages.list().find(r=>r.package.id==='linux-host'&&r.package.version==='1.1.0')!.package];
    for(let i=0;i<refs.length;i++){
      expect((await status(i)).binding.state).toBe('unbound');
      const p=pins[i],ref=refs[i];
      evidence[`activate_${ref.type}`]=await request(`config/resources/${ref.type}/${ref.id}/activate`,{expected_revision:0,package:{id:p.id,version:p.version,digest:p.digest},overrides:{interval_ms:{mode:'set',value:5000},timeout_ms:{mode:'set',value:5000},max_rows:{mode:'set',value:100}}});
      expect((await status(i)).binding.application).toBe('pending');
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
    for(const id of ['db.uptime_seconds','mysql.processlist.count','mysql.connections.limit','mysql.threads.connected','mysql.files.open'])expect(mysqlMetrics.find((m:any)=>m.definition.id===id)?.series.some((s:any)=>s.buckets.some((b:any)=>b.value!==null))).toBe(true);
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
