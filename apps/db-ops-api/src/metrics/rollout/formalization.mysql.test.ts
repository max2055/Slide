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
