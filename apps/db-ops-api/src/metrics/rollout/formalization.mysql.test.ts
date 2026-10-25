import mysql, {type Pool} from 'mysql2/promise';
import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {MigrationRunner} from '../../migrations/runner.js';
import type {MigrationPool} from '../../migrations/types.js';
import {createConfigurationRegistry} from '../config/registry.js';
import {PolicyService} from '../policy/service.js';
import {MysqlPolicyStore} from '../policy/store.js';
import {MysqlScheduleStore} from '../scheduler/store.js';
import {MetricScheduler} from '../scheduler/service.js';
import {JobRegistry} from '../../workflows/job-registry.js';
import {MysqlWorkflowStore,WorkerRuntime} from '../../workflows/worker-runtime.js';
import {SourceSnapshotCapture} from './source-shadow.js';
import {MetricFormalization} from './formalization.js';
import {MetricConsumerService} from '../consumers/service.js';
import {MysqlFormalMetricStore} from './formal-store.js';
import {admin} from '../policy/test-support.js';
import {MYSQL_STATUS_SQL} from '../packages/adapters.js';
import {sealRelease} from '../packages/model.js';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {evaluateMetric} from '../consumers/evaluation.js';

const port=Number(process.env.METRICS_TEST_MYSQL_PORT);
describe.skipIf(!port)('real MySQL measurement → source acceptance → formal API',()=>{
  const database=`max189_formal_${process.pid}`,ref={type:'instance' as const,id:1},registry=createConfigurationRegistry();
  let root:Pool,pool:Pool,policy:PolicyService,store:MysqlScheduleStore,scheduler:MetricScheduler,worker:WorkerRuntime,jobs:JobRegistry;
  let now:number,reads:number;
  const inventory=()=>({type:'instance' as const,id:'1',attributes:{
    'db.engine':{value:'mysql',observed_at:new Date(now).toISOString(),source:'actual_driver'},
    'db.version':{value:'9.6.0',observed_at:new Date(now).toISOString(),source:'fixture_applicability'},
  }});
  beforeAll(async()=>{
    root=mysql.createPool({host:'127.0.0.1',port,user:'root',password:'',timezone:'Z'});
    await root.query(`CREATE DATABASE ${database}`);pool=mysql.createPool({host:'127.0.0.1',port,user:'root',password:'',database,timezone:'Z',connectionLimit:16});
    await new MigrationRunner(pool as unknown as MigrationPool).run();
  },120000);
  afterAll(async()=>{await pool?.end();if(root){await root.query(`DROP DATABASE ${database}`);await root.end();}});
  beforeEach(async()=>{
    for(const table of ['metric_source_checks','metric_source_acceptance','metric_rollout_events','metric_rollout_resources','metric_rollout','metric_publications','metric_schedule','metric_schedule_events','metric_policy_bindings','metric_policy_audit','metric_observations','metric_attempts','workflow_jobs','database_instances']) await pool.query(`DELETE FROM ${table}`);
    now=Date.now();reads=0;
    await pool.query("INSERT INTO database_instances (id,name,host,port,username,password_encrypted,db_type,db_version,status) VALUES (1,'real-sql','127.0.0.1',?,'root','fixture','mysql','9.6.0','active')",[port]);
    policy=new PolicyService(new MysqlPolicyStore(()=>pool),registry,{exists:async()=>true,inventory:async()=>inventory()},()=>new Date(now).toISOString());
    const p=registry.list().find(r=>r.package.id==='mysql-basic'&&r.package.version==='2.0.0')!.package;
    await policy.changeBinding(admin,ref,{expected_revision:0,package:{id:p.id,version:p.version,digest:p.digest},overrides:{interval_ms:{mode:'set',value:1000},timeout_ms:{mode:'set',value:1000}}},true);
    store=new MysqlScheduleStore(pool,registry,'production');
    scheduler=new MetricScheduler(store,registry,{resolve:async()=>({resource:inventory(),credential_ref:'credential:local-test',evidence:{},resolve:async()=>({method:'sql',pool:{query:async options=>{reads++;expect(options.sql).toBe(MYSQL_STATUS_SQL);return root.query(options);}}})})},()=>now,undefined,new MetricFormalization(pool,registry,()=>new Date(now)));
    jobs=new JobRegistry();scheduler.register(jobs);worker=new WorkerRuntime(new MysqlWorkflowStore(()=>pool as never),'max189-formal-worker',30);
  });
  const cycle=async()=>{now+=1001;await scheduler.tick();await pool.query("UPDATE workflow_jobs SET available_at=DATE_SUB(NOW(),INTERVAL 1 SECOND) WHERE state='queued'");return worker.runOnce((j,ctx)=>jobs.execute(j,ctx),now);};
  const rows=async(sql:string)=>(await pool.query<any[]>(sql))[0];
  it.skipIf(!process.env.METRICS_LOAD_EVIDENCE)('records a reproducible three-resource 60s collection load window',async()=>{
    const started=Date.now(); now=started-120000;
    policy=new PolicyService(new MysqlPolicyStore(()=>pool),registry,{exists:async()=>true,inventory:async r=>({...inventory(),id:String(r.id)})},()=>new Date(now).toISOString());
    for(let id=1;id<=3;id++){
      if(id>1)await pool.query("INSERT INTO database_instances (id,name,host,port,username,password_encrypted,db_type,db_version,status) VALUES (?,?,'127.0.0.1',?,'root','fixture','mysql','9.6.0','active')",[id,`load-${id}`,port]);
      await policy.changeBinding(admin,{...ref,id},{expected_revision:id===1?1:0,...(id===1?{}:{package:(await policy.binding(admin,ref)).binding.package}),overrides:{interval_ms:{mode:'set',value:60000},timeout_ms:{mode:'set',value:1000}}},true);
    }
    scheduler=new MetricScheduler(store,registry,{resolve:async r=>({resource:{...inventory(),id:String(r.id)},credential_ref:'credential:load',evidence:{},resolve:async()=>({method:'sql',pool:{query:async options=>{reads++;return root.query(options);}}})})},()=>now,undefined,new MetricFormalization(pool,registry,()=>new Date(now)));
    jobs=new JobRegistry();scheduler.register(jobs);
    const run=async()=>{
      const t=Date.now();await scheduler.tick();
      await pool.query("UPDATE workflow_jobs SET available_at=DATE_SUB(NOW(),INTERVAL 1 SECOND) WHERE state='queued'");
      for(let i=0;i<3;i++)await worker.runOnce((j,ctx)=>jobs.execute(j,ctx),now);
      return Date.now()-t;
    };
    await run();now+=60000;await run();now+=60000;
    // Old normalized evidence has identical shape and cardinality in both runs.
    await pool.query('CREATE TEMPORARY TABLE load_digits(n INT PRIMARY KEY)');
    await pool.query('INSERT INTO load_digits VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)');
    await pool.query(`INSERT INTO metric_observations(id,series_hash,stage,observed_at,stored_at,valid_value,payload,payload_hash,evidence_expires_at)
      SELECT CONCAT('load-history-',a.n,b.n,c.n,d.n,e.n),o.series_hash,o.stage,DATE_SUB(?,INTERVAL 1 DAY),o.stored_at,o.valid_value,
        JSON_SET(o.payload,'$.id',CONCAT('load-history-',a.n,b.n,c.n,d.n,e.n)),o.payload_hash,NULL
      FROM (SELECT * FROM metric_observations WHERE stage='normalized' LIMIT 1) o
      CROSS JOIN load_digits a CROSS JOIN load_digits b CROSS JOIN load_digits c CROSS JOIN load_digits d CROSS JOIN load_digits e`,[new Date(now)]);
    await run();
    const cpu=()=>Number(execFileSync('docker',['exec',process.env.METRICS_TEST_MYSQL_CONTAINER!,'cat','/sys/fs/cgroup/cpu.stat'],{encoding:'utf8'}).match(/usage_usec (\d+)/)![1]);
    const counters=async()=>{
      const [status]=await root.query<any[]>("SHOW GLOBAL STATUS WHERE Variable_name IN ('Queries','Innodb_rows_read','Innodb_row_lock_waits','Innodb_row_lock_time')");
      const [digest]=await root.query<any[]>("SELECT COALESCE(SUM(COUNT_STAR),0) statements,COALESCE(SUM(SUM_ROWS_EXAMINED),0) rows_examined,COALESCE(SUM(SUM_LOCK_TIME),0) lock_time_ps FROM performance_schema.events_statements_summary_by_digest WHERE SCHEMA_NAME=?",[database]);
      return {...Object.fromEntries(status.map(r=>[r.Variable_name,Number(r.Value)])),...Object.fromEntries(Object.entries(digest[0]).map(([k,v])=>[k,Number(v)]))};
    };
    const countBefore=await rows('SELECT COUNT(*) n FROM metric_observations');
    const before=await counters(),cpuBefore=cpu(),begin=Date.now(),readBefore=reads,latencies:number[]=[],alerts:number[]=[];
    let ticks=0;
    const formal=new MysqlFormalMetricStore(pool);
    while(Date.now()-begin<65000){
      now=Date.now();const readCount=reads;latencies.push(await run());ticks++;
      if(reads>readCount){
        const consumer=new MetricConsumerService(policy,registry,{queryWindow:(...a)=>formal.queryWindow(...a),dimensions:(...a)=>formal.dimensions(...a),inventory:async()=>inventory(),attempts:async()=>[]},()=>new Date(Date.now()).toISOString());
        const response=await consumer.query(admin,{resource:ref,metric_ids:['db.uptime_seconds']});
        const result=evaluateMetric(response.metrics[0],{metric_id:'db.uptime_seconds',unit:'s',threshold:0,operator:'>',duration_seconds:0,recovery_seconds:0,missing:'unknown',accepted_quality:['good','partial']});
        expect(result.state).toBe('firing');alerts.push(Date.now()-now);
      }
      await new Promise(resolve=>setTimeout(resolve,Math.max(0,1000-(Date.now()-now))));
    }
    const elapsedMs=Date.now()-begin,cpuAfter=cpu(),after=await counters();
    const delta=Object.fromEntries(Object.entries(after).map(([k,v])=>[k,v-(before[k]??0)]));
    const [capture]=await rows("SELECT payload FROM metric_source_checks WHERE resource_key='instance:1' ORDER BY revision DESC LIMIT 1");
    const ids=(typeof capture.payload==='string'?JSON.parse(capture.payload):capture.payload).sample_ids;
    const [plan]=await pool.query(`EXPLAIN SELECT payload FROM metric_observations WHERE id IN (${ids.map(()=>'?').join(',')}) AND stage='normalized' AND payload IS NOT NULL AND observed_at>=? ORDER BY observed_at DESC,id DESC`,[...ids,new Date(now-120000)]);
    const evidence={version:process.env.METRICS_LOAD_LABEL,resources:3,interval_ms:60000,observations_before:Number(countBefore[0].n),elapsed_ms:elapsedMs,ticks,collection_reads:reads-readBefore,cpu_percent_one_core:(cpuAfter-cpuBefore)/elapsedMs/10,qps:delta.Queries/(elapsedMs/1000),...delta,tick_ms:latencies,collection_to_alert_ms:alerts,plan};
    writeFileSync(process.env.METRICS_LOAD_EVIDENCE!,JSON.stringify(evidence,null,2));
    console.log(JSON.stringify(evidence));expect(reads-readBefore).toBe(3);expect(alerts).toHaveLength(1);
  },180000);
  it('accepts real raw lineage, publishes three subsequent cycles, and reports values only through the formal store',async()=>{
    await scheduler.tick();expect(await cycle()).toBe('completed');
    expect(await rows('SELECT * FROM metric_publications')).toHaveLength(0);
    for(let i=0;i<3;i++)expect(await cycle()).toBe('completed');
    const publications=await rows('SELECT * FROM metric_publications');expect(publications).toHaveLength(3);expect(reads).toBe(4);
    const acceptance=await rows('SELECT evidence FROM metric_source_acceptance');expect(acceptance).toHaveLength(1);
    const evidence=typeof acceptance[0].evidence==='string'?JSON.parse(acceptance[0].evidence):acceptance[0].evidence;
    expect(evidence).toMatchObject({kind:'new_source_initialization',validation:'direct_measurement',legacy_comparison:{state:'not_applicable'},history_preserved:true});
    expect(evidence.sample_ids.length).toBeGreaterThan(0);expect(evidence).not.toHaveProperty('source_conflicts');
    const formal=new MysqlFormalMetricStore(pool);
    const consumer=new MetricConsumerService(policy,registry,{queryWindow:(...a)=>formal.queryWindow(...a),dimensions:(...a)=>formal.dimensions(...a),inventory:async()=>inventory(),attempts:async()=>[]},()=>new Date(now+1).toISOString());
    const response=await consumer.query(admin,{resource:ref});
    expect(response.metrics[0].series[0].buckets.some(b=>b.value!==null&&b.quality.status==='good')).toBe(true);
    expect(await formal.sourceState(ref)).toBe('semantic');
  });
  it('does not revalidate an unchanged batch on idle ticks, but reconciles new samples and migration changes',async()=>{
    await scheduler.tick(); expect(await cycle()).toBe('completed');
    const statements:string[]=[];
    const observedPool=new Proxy(pool,{get(target,key){
      if(key==='getConnection')return async()=>{
        const c=await target.getConnection();
        return new Proxy(c,{get(connection,method){
          if(method==='execute')return (sql:string,args:unknown[])=>{statements.push(sql);return connection.execute(sql,args);};
          const value=Reflect.get(connection,method);return typeof value==='function'?value.bind(connection):value;
        }});
      };
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    const formalization=new MetricFormalization(observedPool,registry,()=>new Date(now));
    await formalization.reconcile(ref,1);
    statements.length=0;
    for(let i=0;i<10;i++)await formalization.reconcile(ref,1);
    expect(statements.filter(s=>s.includes('metric_observations')||s.includes('GET_LOCK'))).toEqual([]);
    expect(await cycle()).toBe('completed');
    await formalization.reconcile(ref,1);
    expect(statements.some(s=>s.includes('metric_observations'))).toBe(true);
    statements.length=0;
    await pool.query("UPDATE metric_rollout_resources SET phase='legacy',generation=generation+1 WHERE resource_key='instance:1'");
    await formalization.reconcile(ref,1);
    expect(statements.some(s=>s.includes('metric_observations'))).toBe(true);
    expect((await rows('SELECT phase FROM metric_rollout_resources'))[0].phase).toBe('legacy');
  });
  it('hides the old package immediately, requires a fresh source gate and rolls back only as a newer generation',async()=>{
    await scheduler.tick();expect(await cycle()).toBe('completed');expect(await cycle()).toBe('completed');
    const formal=new MysqlFormalMetricStore(pool);
    const series={resource_type:ref.type,resource_id:'1',metric:{id:'db.uptime_seconds',semantic_version:'1.0.0'},dimensions:{}};
    const read=()=>formal.queryWindow(series,new Date(now-60000).toISOString(),new Date(now+1).toISOString());
    expect((await read()).length).toBeGreaterThan(0);
    const before=await policy.binding(admin,ref),old=before.binding.package;
    const replacement=registry.install(sealRelease({...registry.get(old),package:{...registry.get(old).package,id:'mysql-switch-source-fixture'}})).package;
    const next={id:replacement.id,version:replacement.version,digest:replacement.digest};
    await policy.changeBinding(admin,ref,{expected_revision:1,package:next},true);
    expect(await read()).toEqual([]);expect(await formal.sourceState(ref)).toBe('pending');
    await scheduler.tick();
    expect(await cycle()).toBe('completed');
    // The real first sample provides evidence; it cannot publish under an old ticket.
    expect(await read()).toEqual([]);
    for(let i=0;i<3;i++)expect(await cycle()).toBe('completed');
    const current=await read();expect(current.length).toBeGreaterThanOrEqual(3);
    expect(current.every(o=>o.versions.config_revision===2&&o.versions.package_id===next.id)).toBe(true);
    await policy.changeBinding(admin,ref,{expected_revision:2,package:old},true);
    expect(await read()).toEqual([]);
    await scheduler.tick();expect(await cycle()).toBe('completed');expect(await cycle()).toBe('completed');
    expect((await read()).every(o=>o.versions.config_revision===3&&o.versions.package_id===old.id)).toBe(true);
    const accepted=await rows('SELECT revision,generation FROM metric_source_acceptance ORDER BY revision');
    expect(accepted.map(r=>Number(r.revision))).toEqual([1,2,3]);
    expect(accepted.map(r=>Number(r.generation))).toEqual([1,2,3]);
    expect(await rows('SELECT * FROM metric_publications')).not.toHaveLength(0);
  });
  it('retains raw failure evidence but never publishes a failed source comparison under an already accepted revision',async()=>{
    await scheduler.tick();expect(await cycle()).toBe('completed');expect(await cycle()).toBe('completed');
    const before=(await rows('SELECT * FROM metric_publications')).length;
    const original=SourceSnapshotCapture.prototype.compare;
    const spy=vi.spyOn(SourceSnapshotCapture.prototype,'compare').mockImplementation(function(...args){
      const evidence=original.apply(this,args),o=args[2][0];
      return {...evidence,checks:[{metric_id:o.metric.id,sample_id:o.id,legacy_reference:'fixture-drift',legacy_value:1,value:2,dimensions:o.dimensions,state:'failed' as const,unit:o.unit}]};
    });
    try{expect(await cycle()).toBe('completed');await scheduler.tick();
      expect((await rows('SELECT * FROM metric_publications')).length).toBe(before);
      const [validation]=await rows('SELECT payload FROM metric_source_checks');
      expect((typeof validation.payload==='string'?JSON.parse(validation.payload):validation.payload).checks[0].state).toBe('failed');
    }finally{spy.mockRestore();}
  });
  it('honors the asset switch at queue, execution and commit boundaries; enabling resumes with real SQL',async()=>{
    await pool.query("UPDATE database_instances SET status='inactive' WHERE id=1");
    await scheduler.tick();expect(await cycle()).toBe('idle');expect(reads).toBe(0);
    await pool.query("UPDATE database_instances SET status='active' WHERE id=1");
    await scheduler.tick();expect(await cycle()).toBe('completed');expect(reads).toBe(1);
    await pool.query("UPDATE database_instances SET status='inactive' WHERE id=1");
    const before=await rows('SELECT * FROM metric_attempts');
    for(let i=0;i<3;i++)expect(await cycle()).toBe('idle');
    expect(await rows('SELECT * FROM metric_attempts')).toEqual(before);expect(reads).toBe(1);
  });
  it.each(['missing','wrong_revision','wrong_sample'] as const)('refuses %s source snapshots after an accepted revision',async fault=>{
    await scheduler.tick(); expect(await cycle()).toBe('completed'); expect(await cycle()).toBe('completed');
    const before=(await rows('SELECT * FROM metric_publications')).length;
    const original=SourceSnapshotCapture.prototype.compare;
    const spy=vi.spyOn(SourceSnapshotCapture.prototype,'compare').mockImplementation(function(...args){
      const snapshot=original.apply(this,args);
      return fault==='missing' ? undefined as any : fault==='wrong_revision' ? {...snapshot,revision:99} : {...snapshot,sample_ids:['not-current']};
    });
    try {
      expect(await cycle()).toBe('completed'); await scheduler.tick();
      expect((await rows('SELECT * FROM metric_publications')).length).toBe(before);
    } finally { spy.mockRestore(); }
  });
});
