/** Called only inside the owned discovery harness; no standalone database or production configuration. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import type { Pool } from 'mysql2/promise';
import { MysqlMetricStorage, seriesHash } from '../src/metrics/storage.js';
import { identify } from '../src/contracts/metrics/fixtures.js';
import { createConfigurationRegistry } from '../src/metrics/config/registry.js';
import { canonicalDefinitions } from '../src/metrics/packages/builtins.js';
import { sealRelease } from '../src/metrics/packages/model.js';
import { expireRetainedTrends } from '../src/metrics/consumers/retained-trends.js';
import { StudyTrendResultSchema,StudyCatalogResultSchema,StudyReplayResultSchema,StudyCapacityResultSchema } from '../src/contracts/metrics/study.js';

export function historyFixtureRegistry(){
  const registry=createConfigurationRegistry(),release=registry.list().find(r=>r.package.id==='snmp-standard')!;
  const base=canonicalDefinitions.find(d=>d.id==='network.interface.oper_up')!;
  const types=['histogram','summary'] as const;
  const definitions=types.map(kind=>({...base,category:'extension' as const,namespace:'history_fixture',id:`history_fixture.${kind}`,meaning:`受控历史 ${kind} 验收数据`,kind,value_type:kind,temporality:'delta' as const,
    aggregation:{...base.aggregation,time:['last'] as ['last'],space:['none'] as ['none'],quantiles:kind==='histogram'?'from_merged_histogram' as const:'non_mergeable' as const}}));
  registry.install(sealRelease({...release,package:{...release.package,id:'history-fixture'},extensions:[...release.extensions,...definitions]}));
  return {registry,definitions};
}

export async function verifyHistoryStudy({pool,page,api,request,directory,passed,evidence,expect,readerToken,restartDatabase}:{pool:Pool;page:any;api:any;request:any;directory:string;passed:(s:string)=>void;evidence:any;expect:any;readerToken:string;restartDatabase:()=>Promise<void>}) {
  const ref={type:'network_device',id:701},sql=(iso:string)=>iso.slice(0,23).replace('T',' ');
  const decode=(v:any)=>typeof v==='string'?JSON.parse(v):v;
  const [source]=await pool.query<any[]>("SELECT o.payload,p.generation FROM metric_observations o JOIN metric_publications p ON p.observation_id=o.id WHERE o.stage='normalized' ORDER BY o.observed_at LIMIT 1");
  assert(source.length);const base=decode(source[0].payload),hash=seriesHash(base);
  const definition=[...canonicalDefinitions,...createConfigurationRegistry().list().flatMap(r=>r.extensions)].find(d=>d.id===base.metric.id&&d.semantic_version===base.metric.semantic_version)!;assert(definition);
  // Explicit synthetic historical data, schema-validated by the existing storage writer;
  // publication/acceptance are fixture provenance, not a claim of a 90-day live device run.
  const start='2026-08-01T00:02:00.000Z',end='2026-08-01T01:02:00.000Z';
  const fixture=[{at:'2026-08-01T00:02:00.000Z',v:0},{at:'2026-08-01T00:04:00.000Z',v:1},{at:'2026-08-01T00:05:00.000Z',v:1},{at:end,v:0}];
  const storage=new MysqlMetricStorage(pool);
  for(const f of fixture){const o=identify({...base,id:undefined,observed_at:f.at,collected_at:f.at,stored_at:f.at,
    value:{encoding:definition.value_type,value:definition.value_type==='float64'?f.v:String(f.v)},source:{...base.source,attempt_id:`history-fixture-${f.at}`}});
    await storage.write(o,definition);await pool.execute('INSERT INTO metric_publications(observation_id,series_hash,generation,observed_at) VALUES(?,?,?,?)',[o.id,hash,source[0].generation,sql(f.at)]);
  }
  const tables=['metric_observations','metric_publications','metric_rollout','metric_trigger_heads','metric_trigger_episodes','alerts','alert_events','notification_records','workflow_jobs'];
  const formal=async()=>Object.fromEntries(await Promise.all(tables.map(async t=>{const [rows]=await pool.query<any[]>(`SELECT * FROM ${t}`);const content=rows.map(r=>JSON.stringify(r)).sort().join('\n');return[t,{count:rows.length,hash:createHash('sha256').update(content).digest('hex')}];})));
  const before=await formal();
  const query={resource:ref,from:start,to:end,metric:base.metric,dimensions:base.dimensions,interval_ms:60000};
  const trend=await api('POST','/api/metrics/study/trend',{...query,tier:'1h'});
  StudyTrendResultSchema.parse(trend);
  assert.equal(trend.buckets.reduce((n:number,b:any)=>n+b.count,0),3);
  const first=trend.buckets[0];assert.equal(first.min.numerator,'0');assert.equal(first.max.numerator,'1');assert.deepEqual(first.avg,{numerator:'2',denominator:'3'});assert.equal(first.quality,'partial');
  const offset=await api('POST','/api/metrics/study/trend',{...query,from:'2026-08-01T08:02:00+08:00',to:'2026-08-01T09:02:00+08:00',tier:'1h'});assert.deepEqual(offset,trend);
  const daily=await api('POST','/api/metrics/study/trend',{...query,tier:'1d'});assert.equal(daily.buckets[0].count,3);assert.equal(daily.buckets[0].max.numerator,'1');
  const raw=await api('POST','/api/metrics/observations',{...query,interval_ms:undefined,limit:2});assert.equal(raw.total,3);assert(raw.has_more);
  const raw2=await api('POST','/api/metrics/observations',{...query,interval_ms:undefined,limit:2,cursor:raw.next_cursor});assert.equal(raw2.observations.length,1);assert.equal(raw2.has_more,false);
  assert.equal((await request('POST','/api/metrics/study/catalog',{resource:ref,from:start,to:end},readerToken)).status,403);
  passed('real MySQL tier hierarchy: clipped UTC/offset half-open boundaries; exact count/min/max/weighted avg and peak; gaps stay partial; raw keyset pages agree');
  const long=await api('POST','/api/metrics/study/trend',{...query,from:'2026-08-01T00:00:00Z',to:new Date().toISOString(),tier:'1d'});assert(long.buckets.length>90);assert(long.buckets.some((b:any)=>b.count===0&&b.quality==='unknown'&&b.avg===null));
  const catalog=await api('POST','/api/metrics/study/catalog',{resource:ref,from:new Date(evidence.started-60000).toISOString(),to:new Date().toISOString()});
  const snapshot=catalog.snapshots.find((s:any)=>s.rules.length);assert(snapshot);
  StudyCatalogResultSchema.parse(catalog);
  const r= snapshot.rules[0];const replayRequest={resource:ref,from:new Date(evidence.started-60000).toISOString(),to:new Date().toISOString(),revision:snapshot.config_revision,snapshot_hash:snapshot.snapshot_hash,rule_id:r.rule_id,scope:r.scope};
  const replay=await api('POST','/api/metrics/study/replay',replayRequest);assert.equal(replay.isolated,true);assert.equal(replay.rule.version,r.version);assert(replay.evidence_count>0);assert(replay.runs.length);assert(replay.runs.some((r:any)=>r.timeline.some((t:any)=>t.reason!=='not_applied')));
  StudyReplayResultSchema.parse(replay);
  const foreign=await request('POST','/api/metrics/study/replay',{...replayRequest,resource:{type:'network_device',id:702}});assert.equal(foreign.status,404);
  passed('real long-window formal history and fixed historical rule replay; original applied proof, snapshot hash and raw evidence window recorded; foreign resource cannot reuse rule');
  const capacity=await api('POST','/api/metrics/study/capacity',{resource:ref,assumptions:{numeric_days:45,non_numeric_days:8,interval_ms:60000,series_per_resource:2}});
  StudyCapacityResultSchema.parse(capacity);
  assert.equal(capacity.preview_only,true);assert(capacity.measured.length);assert.equal(capacity.measured[0].projected_rows_650,650*2*1440*45);
  const blocked=await pool.getConnection();await blocked.beginTransaction();await blocked.query('SELECT id FROM metric_policy_lock WHERE id=1 FOR UPDATE');
  const waiting=request('POST','/api/metrics/study/capacity',{resource:ref});await new Promise(r=>setTimeout(r,80));
  await pool.query("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=701 AND p.code='metric:manage'");
  await blocked.commit();blocked.release();assert.equal((await waiting).status,403);
  await pool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT 701,id FROM permissions WHERE code='metric:manage'");
  const [audit]=await pool.query<any[]>("SELECT action,COUNT(*) n FROM metric_history_study_audit GROUP BY action");assert.equal(audit.find(r=>r.action==='history.cleanup_preview').n,1);
  passed('real capacity preview measured JSON bytes and explicit type retention assumptions; lock-wait revocation rejects preview and creates no second audit');
  const web=new URL(page.url()).origin;await page.goto(`${web}/e2e/fixtures/max245-history-study.html`);await page.getByRole('combobox',{name:'授权历史资源'}).selectOption('network_device:701');
  await expect.poll(()=>page.evaluate(()=>Boolean((document.querySelector('semantic-metrics') as any)?.result))).toBe(true);
  assert.equal(await page.getByText('资源不存在或不可读；受保护结果已清除。',{exact:true}).count(),0);
  const study=page.locator('metric-study');await expect(study.getByRole('combobox',{name:'历史研究指标'})).toBeVisible();
  await study.getByRole('combobox',{name:'历史研究窗口'}).selectOption('366');
  await study.getByRole('combobox',{name:'历史研究维度'}).selectOption(JSON.stringify(base.dimensions));
  await study.getByRole('combobox',{name:'历史聚合层级'}).selectOption('5m');await study.getByRole('button',{name:'对照原始与趋势',exact:true}).click();await expect(study.getByRole('alert')).toContainText('400');
  await study.getByRole('combobox',{name:'历史聚合层级'}).selectOption('1d');
  await page.route('**/api/metrics/study/trend',async(route:any)=>{await new Promise(r=>setTimeout(r,300));await route.continue();});
  await study.getByRole('button',{name:'对照原始与趋势',exact:true}).click();await expect(study.getByRole('status').filter({hasText:'正在读取历史研究'})).toBeVisible();await expect(study.getByRole('status').filter({hasText:'趋势已完成'})).toBeVisible();await page.unroute('**/api/metrics/study/trend');
  await study.getByRole('button',{name:'查看原始观测'}).first().click();await expect(study.getByText(/同桶原始观测/)).toBeVisible();
  // Use a short real evidence window for replay, not the aggregated trend.
  await study.getByRole('combobox',{name:'历史研究窗口'}).selectOption('1');await study.getByRole('button',{name:'隔离回放此窗口'}).click();await expect(study.getByRole('heading',{name:'隔离回放已完成'})).toBeVisible();
  await study.getByText('按值类型的保留、容量与清理预览',{exact:true}).click();await study.getByRole('button',{name:'预览容量与清理'}).click();await expect(study.getByRole('status').filter({hasText:'预览已审计'})).toBeVisible();
  for(const [width,height]of [[1440,900],[1366,768],[1920,1080]]){await page.setViewportSize({width,height});await study.scrollIntoViewIfNeeded();await page.screenshot({path:join(directory,`history-study-${width}.png`),fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
  await study.getByRole('button',{name:'对照原始与趋势',exact:true}).focus();await page.keyboard.press('Tab');const focus=await page.evaluate(()=>{let el:any=document.activeElement;while(el?.shadowRoot?.activeElement)el=el.shadowRoot.activeElement;return{tag:el?.tagName,name:el?.getAttribute('aria-label')||el?.textContent};});assert(focus.name);assert(['SELECT','BUTTON','INPUT','SUMMARY'].includes(focus.tag),JSON.stringify(focus));
  const after=await formal();assert.deepEqual(after,before);
  evidence.history_study={trend,daily,long:{buckets:long.buckets.length,evidence_hash:long.evidence_hash},replay,capacity,formal_before:before,formal_after:after,focus,audit};
  writeFileSync(join(directory,'history-study.json'),JSON.stringify(evidence.history_study,null,2));
  passed('real Lit authorized resource selection, trend/raw comparison, historical rule choice and isolated replay, capacity/audit preview; three desktop sizes and keyboard; formal state/events/notifications/jobs byte-identical');
  await page.getByRole('combobox',{name:'授权历史资源'}).selectOption('network_device:702');await expect(study.getByText('该窗口没有可读取的正式历史。',{exact:true})).toBeVisible();
  await page.getByRole('combobox',{name:'授权历史资源'}).selectOption('');await expect(study.getByText('请先选择授权资源。',{exact:true})).toBeVisible();
  passed('real Lit empty second resource and cleared selection discard protected study data');
  await page.getByRole('combobox',{name:'授权历史资源'}).selectOption('network_device:701');await expect(study.getByRole('combobox',{name:'历史研究指标'})).toBeVisible();
  await pool.query("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=701 AND p.code='metric:view'");
  await study.getByRole('button',{name:'刷新历史研究'}).click();await expect(study.getByRole('alert')).toContainText('无权限');
  assert.equal(await study.getByRole('combobox',{name:'历史研究指标'}).count(),0);
  await pool.query("INSERT INTO role_permissions(role_id,permission_id) SELECT 701,id FROM permissions WHERE code='metric:view'");
  passed('real Lit query-budget error and delayed loading recover; live permission revocation clears historical study choices and evidence');
  // Only this owned schema: verify actual type-specific pruning and real structured values.
  const old='2026-05-01T00:00:00.000Z',numeric=identify({...base,id:undefined,observed_at:old,collected_at:old,stored_at:old,source:{...base.source,attempt_id:'owned-retention-numeric'}});
  await new MysqlMetricStorage(pool,()=>new Date(old)).write(numeric,definition);
  const structured=[];
  for(const d of historyFixtureRegistry().definitions){const value=d.kind==='histogram'?{encoding:'histogram',count:'2',sum:3,buckets:[{upper_bound:'+Inf',count:'2'}]}:{encoding:'summary',count:'2',sum:3,quantiles:[{quantile:0.5,value:1.5}]};
    const o=identify({...base,id:undefined,metric:{id:d.id,semantic_version:d.semantic_version},value,observed_at:old,collected_at:old,stored_at:old,source:{...base.source,attempt_id:'owned-retention-'+d.kind}});
    await new MysqlMetricStorage(pool,()=>new Date(old)).write(o,d);const sh=seriesHash(o);
    await pool.execute(`INSERT INTO metric_rollout(series_hash,source,generation,read_mode,package_pin,published_revision,applied_revision,resource_type,resource_id) VALUES(?,'retired',?, 'pending',?,1,NULL,?,?)`,[sh,source[0].generation,JSON.stringify({id:'history-fixture',version:'1.0.0',digest:`sha256:${'a'.repeat(64)}`}),ref.type,String(ref.id)]);
    await pool.execute('INSERT INTO metric_publications(observation_id,series_hash,generation,observed_at) VALUES(?,?,?,?)',[o.id,sh,source[0].generation,sql(old)]);
    // Uses the accepted revision/generation marker from the live writer, not shadow fallback.
    const tr=await api('POST','/api/metrics/study/trend',{resource:ref,from:old,to:'2026-05-01T00:05:00.000Z',metric:o.metric,dimensions:o.dimensions,tier:'5m'});
    assert.equal(tr.buckets[0].non_numeric_count,1);assert.equal(tr.buckets[0].avg,null);assert.equal(tr.buckets[0].max,null);structured.push({id:o.id,trend:tr});
  }
  const typedCapacity=await api('POST','/api/metrics/study/capacity',{resource:ref});
  assert(typedCapacity.measured.some((r:any)=>r.value_class==='histogram'&&r.projected_payload_bytes_650>0));assert(typedCapacity.measured.some((r:any)=>r.value_class==='summary'&&r.projected_payload_bytes_650>0));
  const policy={rawMs:7*86400000,historyMs:365*86400000,attemptMs:365*86400000,valueTypeMs:{[definition.value_type]:30*86400000,histogram:365*86400000,summary:365*86400000}};
  const pruner=new MysqlMetricStorage(pool,()=>new Date(),policy);const preview=await pruner.preview();assert(preview.normalized.count>=1);
  const receipt=await pruner.prune(1000);const [retained]=await pool.query<any[]>('SELECT id FROM metric_observations WHERE id IN (?,?,?)',[numeric.id,...structured.map(s=>s.id)]);
  assert(!retained.some(r=>r.id===numeric.id));assert.equal(retained.length,2);
  const [protectedRows]=await pool.query<any[]>('SELECT o.id FROM metric_observations o JOIN metric_trigger_inputs i ON CAST(i.sample_id AS BINARY)=CAST(o.id AS BINARY)');assert(protectedRows.length);
  evidence.history_study.structured_and_retention={structured,typedCapacity,policy,preview,receipt,protected_count:protectedRows.length};
  writeFileSync(join(directory,'history-study.json'),JSON.stringify(evidence.history_study,null,2));
  passed('owned MySQL only: registered histogram/summary history remains non-scalar; actual type-specific prune removes old numeric fixture, retains structured fixtures and referenced formal trigger evidence');
  // Chief R4/R5: formal fixtures use the existing writer and accepted generation,
  // then the production pruning path; the dates/load are explicit test assumptions.
  const oldPoints:any[]=[];
  const seed=async(at:string,v:number,tag:string)=>{
    const bad=tag==='retained-load-100';
    const o=identify({...base,id:undefined,observed_at:at,collected_at:at,stored_at:at,value:{encoding:'float64',value:v},
      ...(bad?{quality:{status:'partial',reason:'partial_input'},accuracy:'unknown'}:{}),source:{...base.source,attempt_id:tag}});
    await new MysqlMetricStorage(pool,()=>new Date(at)).write(o,definition);
    await pool.execute('INSERT INTO metric_publications(observation_id,series_hash,generation,observed_at) VALUES(?,?,?,?)',[o.id,hash,source[0].generation,sql(at)]);oldPoints.push(o);return o;
  };
  await seed('2026-07-20T23:58:00.000Z',1,'r4-before-gap');await seed('2026-07-21T00:04:00.000Z',1,'r4-after-gap');
  const clockRequest={...replayRequest,from:'2026-07-20T23:58:00.000Z',to:'2026-07-21T00:05:00.000Z'};
  const clockBefore=await formal(),clockReplay=await api('POST','/api/metrics/study/replay',clockRequest);
  const clockTimeline=clockReplay.runs.find((x:any)=>JSON.stringify(x.dimensions)===JSON.stringify(base.dimensions)).timeline;
  assert(clockTimeline.some((t:any)=>t.event_type==='clock'&&t.sample_id===null&&t.nodata&&t.evaluated_at==='2026-07-21T00:03:00.000Z'));
  assert(clockTimeline.some((t:any)=>t.event_type==='sample'&&t.recovery));assert.deepEqual(await formal(),clockBefore);
  passed('Chief R4 real formal evidence: clock nodata inside a six-minute gap, recovery after fresh sample, no fabricated samples; nine formal tables unchanged');
  const writerStarted=performance.now();
  for(let i=0;i<650;i++)await seed(new Date(Date.parse('2026-07-01T00:00:00Z')+i*300000).toISOString(),i===321?999:i%3,`retained-load-${i}`);
  const writerMs=performance.now()-writerStarted;
  const allQuery={resource:ref,metric:base.metric,dimensions:base.dimensions,from:'2026-07-01T00:00:00.000Z',to:'2026-08-01T01:00:00.000Z',tier:'1d',interval_ms:300000};
  const beforePrune=await api('POST','/api/metrics/study/trend',allQuery);
  // Fail a real aggregate write. The enclosing pruning transaction must retain
  // all source evidence and roll back every unique receipt.
  await pool.query("CREATE TRIGGER max245_trend_fail BEFORE INSERT ON metric_retained_trends FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='owned aggregate failure'");
  try{await assert.rejects(()=>pruner.prune(1000));}finally{await pool.query('DROP TRIGGER max245_trend_fail');}
  const [stillRaw]=await pool.query<any[]>("SELECT COUNT(*) n FROM metric_observations WHERE stored_at>='2026-07-01' AND stored_at<'2026-08-02'");assert.equal(Number(stillRaw[0].n),652);
  const [failedReceipts]=await pool.query<any[]>('SELECT COUNT(*) n FROM metric_trend_receipts');assert.equal(Number(failedReceipts[0].n),0);
  const started=performance.now();const preserved=await pruner.prune(1000);const preservationMs=performance.now()-started;
  assert(preserved.normalized>=652);
  const summarize=async()=>{const [b]=await pool.query<any[]>('SELECT COUNT(*) buckets,SUM(OCTET_LENGTH(metadata)+OCTET_LENGTH(statistics)) bytes FROM metric_retained_trends');const [r]=await pool.query<any[]>('SELECT COUNT(*) receipts FROM metric_trend_receipts');return{...b[0],...r[0]};};
  const preservedSummary=await summarize();assert(Number(preservedSummary.buckets)>=652);assert.equal(Number(preservedSummary.receipts),652);
  await pruner.prune(1000);assert.deepEqual(await summarize(),preservedSummary);
  // Reinsert identical source evidence to exercise receipt idempotency, including live/retained handover.
  const duplicate=oldPoints[0];await new MysqlMetricStorage(pool,()=>new Date(duplicate.observed_at)).write(duplicate,definition);
  const handover=await api('POST','/api/metrics/study/trend',allQuery);assert.equal(handover.buckets.reduce((n:number,b:any)=>n+b.count,0),beforePrune.buckets.reduce((n:number,b:any)=>n+b.count,0));
  await pruner.prune(1000);assert.deepEqual(await summarize(),preservedSummary);
  const structuredPruner=new MysqlMetricStorage(pool,()=>new Date(),{...policy,valueTypeMs:{...policy.valueTypeMs,histogram:30*86400000,summary:30*86400000}});
  await structuredPruner.prune(1000);const structuredSummary=await summarize();assert.equal(Number(structuredSummary.receipts),654);
  await restartDatabase();
  const times:number[]=[];let afterRestart:any;
  for(let i=0;i<30;i++){const at=performance.now();afterRestart=await api('POST','/api/metrics/study/trend',allQuery);times.push(performance.now()-at);}
  for(let i=0;i<beforePrune.buckets.length;i++)for(const key of ['count','numeric_count','invalid_count','non_numeric_count','estimated_count','sum','min','max','avg'])assert.deepEqual(afterRestart.buckets[i][key],beforePrune.buckets[i][key]);
  assert(afterRestart.buckets.some((b:any)=>b.raw_status==='expired'&&b.max?.numerator==='999'));
  assert.equal(afterRestart.buckets.reduce((n:number,b:any)=>n+b.invalid_count,0),1);
  const structuredAfterRestart=[];
  for(const fixture of structured){const tr=await api('POST','/api/metrics/study/trend',{resource:ref,metric:fixture.trend.metric,dimensions:base.dimensions,from:old,to:'2026-05-01T00:05:00.000Z',tier:'5m'});assert.equal(tr.buckets[0].non_numeric_count,1);assert.equal(tr.buckets[0].raw_status,'expired');assert.equal(tr.buckets[0].avg,null);structuredAfterRestart.push(tr);}
  const rawExpired=await api('POST','/api/metrics/observations',{resource:ref,metric:base.metric,dimensions:base.dimensions,from:'2026-07-01T00:00:00Z',to:'2026-07-02T00:00:00Z'});assert.equal(rawExpired.total,0);
  const unchanged=await formal();const rejected=await request('POST','/api/metrics/study/replay',clockRequest);assert.equal(rejected.status,409);assert.equal(rejected.body.error,'HISTORY_RAW_EXPIRED');assert.deepEqual(await formal(),unchanged);
  const capacityAfter=await api('POST','/api/metrics/study/capacity',{resource:ref});assert.equal(capacityAfter.retained_trends.receipts,654);
  StudyCapacityResultSchema.parse(capacityAfter);assert(capacityAfter.retained_trends.projected_statistics_bytes_650>0);assert.equal(capacityAfter.retained_trends.projected_buckets_650,650*288*365);
  await page.getByRole('combobox',{name:'授权历史资源'}).selectOption('');await page.getByRole('combobox',{name:'授权历史资源'}).selectOption('network_device:701');
  await expect(study.getByRole('combobox',{name:'历史研究指标'})).toBeVisible();
  await study.getByLabel('研究开始时间').fill('2026-07-01T00:00');await study.getByLabel('研究开始时间').press('Tab');
  await expect(study.getByRole('button',{name:'刷新历史研究'})).toBeEnabled();
  await study.getByLabel('研究结束时间').fill('2026-08-01T01:00');await study.getByLabel('研究结束时间').press('Tab');
  await expect(study.getByRole('button',{name:'刷新历史研究'})).toBeEnabled();
  await study.getByRole('combobox',{name:'历史研究维度'}).selectOption(JSON.stringify(base.dimensions));await study.getByRole('combobox',{name:'历史聚合层级'}).selectOption('1d');
  await study.getByRole('button',{name:'对照原始与趋势',exact:true}).click();await expect(study.getByRole('status').filter({hasText:'趋势已完成'})).toBeVisible();
  await expect(study.getByText(/原始已过期/).first()).toBeVisible();
  await study.getByRole('button',{name:'隔离回放此窗口'}).click();await expect(study.getByRole('alert')).toContainText('原始证据已过期');
  for(const [width,height]of [[1440,900],[1366,768],[1920,1080]]){await page.setViewportSize({width,height});await study.scrollIntoViewIfNeeded();await page.screenshot({path:join(directory,`retained-trends-${width}.png`),fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
  // Explicit clock advance on the owned trend tables only: independent expiry
  // removes statistics/receipts without touching the nine formal tables.
  const formalAfterReadOnly=await formal();assert.deepEqual(formalAfterReadOnly,unchanged);
  const expiryConnection=await pool.getConnection();let trendExpiry;
  let typedTrendExpiry;
  try{await expiryConnection.beginTransaction();await expiryConnection.query('SELECT id FROM metric_policy_lock WHERE id=1 FOR UPDATE');
    typedTrendExpiry=await expireRetainedTrends(expiryConnection,new Date(),{...policy,trendValueTypeMs:{float64:90*86400000}},1000);
    await expiryConnection.commit();assert.equal(Number((await summarize()).buckets),2);
    await expiryConnection.beginTransaction();await expiryConnection.query('SELECT id FROM metric_policy_lock WHERE id=1 FOR UPDATE');trendExpiry=await expireRetainedTrends(expiryConnection,new Date('2028-01-01T00:00:00Z'),policy,1000);await expiryConnection.commit();}catch(e){await expiryConnection.rollback();throw e;}finally{expiryConnection.release();}
  assert.equal(Number((await summarize()).buckets),0);assert.deepEqual(await formal(),unchanged);
  times.sort((a,b)=>a-b);
  evidence.history_study.preservation={clockReplay,preserved,preservedSummary,structuredSummary,structuredAfterRestart,typedTrendExpiry,trendExpiry,preservationMs,writerMs,afterRestart,capacityAfter,query_latency_ms:{samples:times.length,p50:times[14],p95:times[28],max:times[29]},load:{resources:1,series:1,formal_fixture_samples:652,occupied_5m_buckets:652,additional_structured_samples:2,production_slo:false},restart:'owned MySQL container restarted; every request constructs fresh store',p0_reference:capacityAfter.baseline.stop_thresholds,formal_before_rejected:unchanged,formal_after_rejected:formalAfterReadOnly};
  writeFileSync(join(directory,'history-study.json'),JSON.stringify(evidence.history_study,null,2));
  passed('Chief R5 real writer to durable statistics: aggregate failure rejects pruning; retries and identical reinsertion never double count; owned MySQL restart retains peaks/count/weighted averages and gaps; Lit marks raw expired and rejects replay; measured new-chain bytes and latency');
}
