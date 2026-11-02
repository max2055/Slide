/** Isolated logical inventory over controlled real protocol endpoints. This is
 * an explicit workload measurement, never 650 physical devices or a production SLO. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkerRuntime,MysqlWorkflowStore } from '../src/workflows/worker-runtime.js';
import { databaseService } from '../src/database-service.js';
import { MysqlMetricStorage } from '../src/metrics/storage.js';
import { RetainedTrendStore } from '../src/metrics/consumers/retained-trends.js';
import { identify } from '../src/contracts/metrics/fixtures.js';
import { createConfigurationRegistry } from '../src/metrics/config/registry.js';
import { canonicalDefinitions } from '../src/metrics/packages/builtins.js';
import { seriesHash } from '../src/metrics/storage.js';
import { createServer,connect } from 'node:net';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';

export async function integratedCapacity(ctx:any,sqlPort:number,targetDatabase:string) {
  const {pool,api,jobs,directory,passed,nonce}=ctx;
  const report:any={source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),boundary:'650 logical authorized resources, shared controlled SSH/MySQL/SNMP endpoints; real native protocol + JWT/Fastify + original jobs/writer; not 650 physical hosts or production SLO',
    assumptions:{servers:500,databases:100,network_devices:50,server_package:'linux-filesystem-discovery',database_package:'mysql-innodb-discovery',network_package:'snmp-standard',expected_series_per_resource:1,interval_ms:60000,rounds:2,admission:'two manual bursts at least 60s apart; next burst waits for previous drain, not a sustained periodic-load test',worker_concurrency:8,query_clients:4,raw_days:7,numeric_days:30,non_numeric_days:7,trend_days:365,unknown_cardinality:'actual discovered cardinality recorded below; deployment cardinality and physical endpoint latency not inferred'},rounds:[],queries:[]};
  const decode=(v:any)=>typeof v==='string'?JSON.parse(v):v;
  const listeners:any[]=[],sockets=new Set<any>();
  const refs:any[]=[];
  const batches=async<T>(values:T[],n:number,work:(v:T)=>Promise<void>)=>{for(let i=0;i<values.length;i+=n)await Promise.all(values.slice(i,i+n).map(work));};
  const quantile=(v:number[])=>{const s=[...v].sort((a,b)=>a-b);return{count:s.length,p50:s[Math.ceil(s.length*.5)-1],p95:s[Math.ceil(s.length*.95)-1],p99:s[Math.ceil(s.length*.99)-1],max:s.at(-1)};};
  try {
    const seed=performance.now();
    for(const [type,table,source,count] of [['server','servers',712,500],['instance','database_instances',711,100],['network_device','network_devices',701,50]] as const){
      const [[asset]]=await pool.query(`SELECT * FROM ${table} WHERE id=?`,[source]);assert(asset);
      const [[published]]=await pool.query('SELECT payload FROM metric_policy_bindings WHERE resource_key=?',[`${type}:${source}`]);
      const binding=decode(published.payload).binding;assert(binding.template_pins.length);
      const columns=Object.keys(asset).filter(k=>!['id','created_at','updated_at'].includes(k));
      for(let n=0;n<count;n++){
        const id=40000+n;
        const values={...asset,name:`owned-capacity-${type}-${id}`,label:`owned-capacity-${type}-${id}`};
        if(type==='server'){
          const server=createServer(c=>{const u=connect({host:asset.host,port:asset.port});sockets.add(c);sockets.add(u);c.on('error',()=>u.destroy());u.on('error',()=>c.destroy());c.pipe(u).pipe(c);});
          server.listen(0,asset.host);await once(server,'listening');listeners.push(server);values.port=(server.address() as any).port;
        }
        if(type==='network_device'){
          const udp=createSocket('udp4');let client:any;
          udp.on('message',(message,remote)=>{if(remote.port===asset.snmp_port){if(client)udp.send(message,client.port,client.address);}else{client=remote;udp.send(message,asset.snmp_port,asset.host);}});
          udp.bind(0,asset.host);await once(udp,'listening');listeners.push(udp);values.snmp_port=udp.address().port;
        }
        await pool.query(`INSERT INTO ${table}(id,${columns.map(c=>'`'+c+'`').join(',')}) VALUES(${Array(columns.length+1).fill('?').join(',')})`,[id,...columns.map(k=>values[k])]);
        if(type==='instance')assert(await databaseService.addConnection(id,'owned-capacity',{host:'127.0.0.1',port:sqlPort,user:'root',password:'',database:targetDatabase,db_type:'mysql'}));
        if(type==='network_device')await pool.query('INSERT INTO network_device_credentials(device_id,protocol,username,community_encrypted) SELECT ?,protocol,username,community_encrypted FROM network_device_credentials WHERE device_id=?',[id,source]);
        refs.push({type,id,pins:binding.template_pins});
      }
    }
    let configured=0;
    await batches(refs,4,async r=>{
      const base=`/api/metrics/template-bindings/${r.type}/${r.id}`,body={expected_revision:0,template_pins:r.pins,group_id:null,overrides:{enabled:'enable',interval_ms:{mode:'set',value:60000},max_rows:{mode:'set',value:30}}};
      await api('POST',base+'/probe',body);
      await api('POST',base+'/trial',{...body,receipt_id:`cap-trial-${r.type}-${r.id}`});
      await api('POST',base+'/apply',{...body,receipt_id:`cap-trial-${r.type}-${r.id}`,caller_key:`cap-apply-${r.type}-${r.id}`});
      configured++;if(configured%50===0)console.log('CAPACITY_CONFIGURED',configured);
    });
    report.setup_ms=performance.now()-seed;
    const workers=Array.from({length:8},(_,i)=>new WorkerRuntime(new MysqlWorkflowStore(()=>pool),`max245-cap-${nonce}-${i}`,30));
    let firstRoundAt=0;
    for(let round=0;round<2;round++){
      if(round && Date.now()<firstRoundAt+60000)await new Promise(r=>setTimeout(r,firstRoundAt+60000-Date.now()));
      const start=Date.now();if(!round)firstRoundAt=start;
      await batches(refs,8,async r=>{await api('POST',`/api/metrics/template-bindings/${r.type}/${r.id}/collect`,{caller_key:`capacity-${round}`,expected_revision:1});});
      const pending=new Set(refs.map(r=>`${r.type}:${r.id}`)),delays:number[]=[],tasks:any[]=[];
      while(pending.size){
        assert(Date.now()-start<180000,'bounded capacity run exceeded 180s hard test deadline');
        await Promise.all(workers.map(w=>w.runOnce((j,c)=>jobs.execute(j,c),Date.now())));
        const [finished]=await pool.query("SELECT resource_key,state,JSON_LENGTH(samples) samples,finished_at FROM metric_collect_requests WHERE caller_key=? AND state IN ('completed','failed','unknown')",[`capacity-${round}`]);
        for(const t of finished){if(!pending.delete(t.resource_key))continue;const [type,id]=t.resource_key.split(':');tasks.push({resource:{type,id:Number(id)},state:t.state,samples:Number(t.samples),finished_at:new Date(t.finished_at).toISOString()});delays.push(new Date(t.finished_at).getTime()-start);}
      }
      // Read each public receipt once, keeping monitoring chatter out of the
      // measured worker path instead of issuing O(resources squared) HTTP polls.
      await batches(refs,8,async r=>{const t=await api('GET',`/api/metrics/template-bindings/${r.type}/${r.id}/collect/capacity-${round}`);assert.equal(t.state,tasks.find(v=>v.resource.type===r.type&&v.resource.id===r.id)!.state);});
      const missingTasks=tasks.filter(t=>t.state!=='completed'||t.samples!==1).length;
      const bounds=[new Date(start).toISOString().slice(0,23).replace('T',' '),new Date().toISOString().slice(0,23).replace('T',' ')];
      // A first dynamic sample is committed by the formal writer before its
      // newly discovered dimensions obtain a rollout ticket. Measure that real
      // normalized commit; disclose publication readiness separately.
      const [written]=await pool.query("SELECT TIMESTAMPDIFF(MICROSECOND,o.observed_at,o.stored_at)/1000 delay_ms FROM metric_observations o WHERE o.stage='normalized' AND CAST(JSON_UNQUOTE(JSON_EXTRACT(o.payload,'$.resource_id')) AS UNSIGNED)>=40000 AND o.stored_at>=? AND o.stored_at<=?",bounds);
      const [[publicationCount]]=await pool.query("SELECT COUNT(*) n FROM metric_observations o JOIN metric_publications p ON p.observation_id=o.id WHERE o.stage='normalized' AND CAST(JSON_UNQUOTE(JSON_EXTRACT(o.payload,'$.resource_id')) AS UNSIGNED)>=40000 AND o.stored_at>=? AND o.stored_at<=?",bounds);
      assert(written.length<=650,'one expected series per resource: duplicate formal observations');
      const missing=Math.max(missingTasks,650-written.length),sampleDelay=quantile(written.map((r:any)=>Number(r.delay_ms)));
      const [duplicates]=await pool.query('SELECT resource_key,identity_hash,COUNT(*) n FROM metric_trigger_episodes WHERE CAST(SUBSTRING_INDEX(resource_key,\':\',-1) AS UNSIGNED)>=40000 GROUP BY resource_key,identity_hash HAVING n>1');
      const delay=quantile(delays),p0={sampling_delay_p95_ms:sampleDelay.p95,sampling_delay_definition:'formal stored_at minus observed_at, MAX236 baseline',sampling_delay_limit_ms:120000,missing_rate:missing/650,missing_definition:'expected 650 admitted resource-series slots in this burst, not a 24h periodic missing rate',missing_limit:.05,duplicate_events:duplicates.length,duplicate_limit:0};
      const stop=delay.p95>120000||sampleDelay.p95>120000||missing/650>.05||duplicates.length>0;
      report.rounds.push({round,started_at:new Date(start).toISOString(),elapsed_ms:Date.now()-start,delay_ms:delay,delay_definition:'burst admission start to durable collection receipt; conservative extra queue stop at 2 intervals',sample_storage_delay_ms:sampleDelay,written_samples:written.length,rollout_published_samples:Number(publicationCount.n),missing,tasks,p0,stop});
      // A measured stop is recorded, never concealed by retry or a larger period.
      if(stop)break;
    }
    const [series]=await pool.query('SELECT resource_type,resource_id,COUNT(*) series FROM metric_rollout WHERE CAST(resource_id AS UNSIGNED)>=40000 GROUP BY resource_type,resource_id');
    report.actual_series={resources:series.length,total:series.reduce((n:any,r:any)=>n+Number(r.series),0),by_class:['server','instance','network_device'].map(type=>({type,resources:series.filter((r:any)=>r.resource_type===type).length,series:series.filter((r:any)=>r.resource_type===type).reduce((n:any,r:any)=>n+Number(r.series),0)}))};
    assert.equal(series.length,650);
    const [observations]=await pool.query("SELECT o.payload FROM metric_observations o JOIN metric_publications p ON p.observation_id=o.id WHERE o.stage='normalized' AND CAST(JSON_UNQUOTE(JSON_EXTRACT(o.payload,'$.resource_id')) AS UNSIGNED)>=40000 ORDER BY o.observed_at");
    const samples=observations.map((r:any)=>decode(r.payload));assert(samples.length>=650);
    const selections=new Map<string,any>();for(const p of samples){const key=`${p.resource_type}:${p.resource_id}`;if(!selections.has(key))selections.set(key,p);}
    const from=new Date(Math.floor(Date.now()/300000)*300000-14*86400000).toISOString(),to=new Date().toISOString();
    // Explicit sparse historical workload, not a claim of fourteen days of live sampling.
    // Values use the real accepted source/definition; a marked peak and long gap
    // exercise preservation after all original numeric observations expire.
    const definitions=[...canonicalDefinitions,...createConfigurationRegistry().list().flatMap(r=>r.extensions)],storage=new MysqlMetricStorage(pool);
    let historicalPoints=0;
    await batches([...selections.values()],4,async p=>{
      const d=definitions.find(d=>d.id===p.metric.id&&d.semantic_version===p.metric.semantic_version)!;assert(d);
      const [[publication]]=await pool.query('SELECT generation FROM metric_publications WHERE observation_id=?',[p.id]);
      for(const hour of [0,1,2,100,101,335]){
        const at=new Date(Date.parse(from)+hour*3600000).toISOString();
        const o=identify({...p,id:undefined,observed_at:at,collected_at:at,stored_at:at,source:{...p.source,attempt_id:`capacity-history-${p.resource_type}-${p.resource_id}-${hour}`},
          value:p.value?.encoding==='uint64'?{encoding:'uint64',value:hour===100?'9999999':'1'}:p.value});
        await storage.write(o,d);await pool.execute('INSERT INTO metric_publications(observation_id,series_hash,generation,observed_at) VALUES(?,?,?,?)',[o.id,seriesHash(o),publication.generation,at.slice(0,23).replace('T',' ')]);historicalPoints++;
      }
    });
    report.synthetic_history={resources:selections.size,points:historicalPoints,days:14,occupied_hour_offsets:[0,1,2,100,101,335],peak_uint64:'9999999',boundary:'explicit historical fixtures through storage, existing real formal source acceptance; not live historical protocol observations'};
    const selected=[...selections.values()].filter((_r,i)=>i%20===0);
    await batches(selected,4,async p=>{const started=performance.now();const result=await api('POST','/api/metrics/study/trend',{resource:{type:p.resource_type,id:Number(p.resource_id)},metric:p.metric,dimensions:p.dimensions,from,to,tier:'1h'});assert(result.buckets.some((b:any)=>b.count>0));if(p.value?.encoding==='uint64')assert(result.buckets.some((b:any)=>b.max?.numerator==='9999999'));report.queries.push({resource:`${p.resource_type}:${p.resource_id}`,ms:performance.now()-started,buckets:result.buckets.length});});
    report.query_latency_ms=quantile(report.queries.map((r:any)=>r.ms));
    const [[bytes]]=await pool.query("SELECT COUNT(*) points,SUM(OCTET_LENGTH(payload)) payload_bytes FROM metric_observations WHERE stage='normalized' AND CAST(JSON_UNQUOTE(JSON_EXTRACT(payload,'$.resource_id')) AS UNSIGNED)>=40000");report.observation_bytes=bytes;
    // Accelerated expiry only on this run-owned schema, retaining independent trends.
    const pruneAt=new Date(Date.now()+2000),pruner=new MysqlMetricStorage(pool,()=>pruneAt,{rawMs:1,historyMs:1,attemptMs:1,trendMs:365*86400000});
    const begun=performance.now();let removed=0;for(let i=0;i<100;i++){const r=await pruner.prune(1000);removed+=r.normalized??0;if(!(r.normalized??0)&&!(r.rawPayload??0))break;}
    report.preservation_ms=performance.now()-begun;report.removed_normalized=removed;
    const store=new RetainedTrendStore(pool);const retained=[];
    for(const p of selected){const result=await store.read({resource_type:p.resource_type,resource_id:p.resource_id,metric:p.metric,dimensions:p.dimensions},from,to);assert(result.some(r=>r.bucket.count>0));retained.push({resource:`${p.resource_type}:${p.resource_id}`,buckets:result.length});}
    report.retained_reads=retained;
    const post:any[]=[];
    await batches(selected,4,async p=>{const started=performance.now();const r=await api('POST','/api/metrics/study/trend',{resource:{type:p.resource_type,id:Number(p.resource_id)},metric:p.metric,dimensions:p.dimensions,from,to,tier:'1h'});assert(r.buckets.some((b:any)=>b.retained_count>0 && ['expired','partial_expired'].includes(b.raw_status)));if(p.value?.encoding==='uint64')assert(r.buckets.some((b:any)=>b.max?.numerator==='9999999'));assert(r.buckets.some((b:any)=>b.quality!=='good'));post.push(performance.now()-started);});
    report.post_preservation_query_ms=quantile(post);
    const [[retainedBytes]]=await pool.query("SELECT COUNT(*) buckets,SUM(OCTET_LENGTH(statistics)+OCTET_LENGTH(metadata)) bytes FROM metric_retained_trends WHERE CAST(SUBSTRING_INDEX(resource_key,':',-1) AS UNSIGNED)>=40000");report.retained_bytes=retainedBytes;
    const pointsPerDay=report.actual_series.total*1440,meanBytes=Number(bytes.payload_bytes)/Number(bytes.points);
    report.projection={measured_series:report.actual_series.total,points_per_day:pointsPerDay,normalized_payload_bytes_30_days:pointsPerDay*30*meanBytes,trend_buckets_365_days:report.actual_series.total*288*365,excludes:'raw payload, attempts/events, indexes, row overhead, fragmentation and backups must be measured separately; not disk allocation/SLO'};
    report.p0_source='MAX-236/05-capacity-baseline-slo.md §5: p95 > 2 intervals, missing > 5%, duplicate events > 0';
    report.production_slo=false;report.complete=true;
    passed('650 logical resources real controlled dynamic jobs/writer, explicit cardinality/period/concurrency and P0 stop measurements; trend reads and owned accelerated preservation cleanup');
  }finally{
    for(const r of refs.filter(r=>r.type==='instance'))await databaseService.removeConnection(r.id);
    for(const s of sockets)s.destroy();
    for(const l of listeners)await new Promise<void>(resolve=>l.close(()=>resolve()));
    writeFileSync(join(directory,'integrated-capacity.json'),JSON.stringify(report,null,2));
  }
}
