import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewRoundMutations, compareRoundRows, compareRoundNative, assertNativePendingPlan } from '../../scripts/qualification/max207-round-policy.mjs';

const sql = '2026-10-20 06:45:00', iso = '2026-10-20T06:45:00Z';
const old = '2026-10-19 06:45:00';
const pk = {
  servers:['id'],alert_rules:['id'],investigations:['id'],chat_sessions:['session_id'],chat_messages:['id'],
  investigation_stream_heads:['investigation_id'],investigation_stream_events:['id'],agent_runs:['id'],
  metric_policy_bindings:['resource_key'],metric_rollout:['series_hash'],metric_schedule:['resource_key'],
  metric_source_checks:['resource_key'],metric_schedule_events:['id'],metric_attempts:['id'],metric_observations:['id'],
  metric_publications:['observation_id'],workflow_jobs:['id'],action_plans:['id'],action_plan_versions:['plan_id','version'],
  agent_tool_approvals:['id'],action_jobs:['id'],action_executions:['id'],action_dispatch_locks:['id'],action_approval_bindings:['id'],
};
function nativeCell(value) {
  const cell = {sqlNull:value === null,value:value === null?null:typeof value === 'object'?JSON.stringify(value):String(value),representation:'text'};
  if (value && typeof value === 'object') {
    cell.paths = [];
    const visit = (v,path) => {
      cell.paths.push({path,present:1,type:v === null?'NULL':Array.isArray(v)?'ARRAY':typeof v === 'object'?'OBJECT':typeof v === 'string'?'STRING':typeof v === 'boolean'?'BOOLEAN':Number.isInteger(v)?'INTEGER':'DOUBLE',value:v === null?'null':typeof v === 'object'?JSON.stringify(v):String(v)});
      if (Array.isArray(v)) v.forEach((x,i) => visit(x,`${path}[${i}]`));
      else if (v && typeof v === 'object') Object.entries(v).forEach(([k,x]) => visit(x,`${path}.${JSON.stringify(k)}`));
    };
    visit(value,'$');
  }
  return cell;
}
function project(capture) {
  capture.native = Object.fromEntries(Object.entries(capture.rows).map(([table,rows]) => [table,Object.fromEntries(rows.map(row => [JSON.stringify(capture.keys[table].map(k => row[k])),Object.fromEntries(Object.entries(row).map(([k,v]) => [k,nativeCell(v)]))]))]));
}
function fixture() {
  const keys = structuredClone(pk);
  while (Object.keys(keys).length < 166) keys[`unchanged_${Object.keys(keys).length}`] = ['id'];
  const base = {at:'2026-10-20T06:40:00Z',keys,columns:[],rows:Object.fromEntries(Object.keys(keys).map(k => [k,[]]))};
  Object.assign(base.rows,{
    servers:[{id:'3',name:'protected server',updated_at:old}],alert_rules:[{id:'7',enabled:1,updated_at:old}],
    investigations:[{id:'investigation',session_id:'session',version:'5',updated_at:old}],
    chat_sessions:[{session_id:'session',message_count:'0',last_message_at:old,updated_at:old,title:'protected'}],
    investigation_stream_heads:[{investigation_id:'investigation',sequence:'16'}],
    metric_policy_bindings:[{resource_key:'server:3',payload:{application:{reported_at:'2026-10-19T06:45:00Z',enabled:true}},capabilities:[{id:'cpu',evaluated_at:'2026-10-19T06:45:00Z',valid_until:'2026-10-19T06:47:00Z'}]}],
    metric_rollout:[{series_hash:'series',resource_type:'server',resource_id:'3',generation:'1',read_mode:'semantic',latest_payload:null,updated_at:old}],
    metric_schedule:[{resource_key:'server:3',last_end_ms:String(Date.parse(iso)-86400000),next_due_ms:String(Date.parse(iso)-86400000+60000),interval_ms:'60000',updated_at:old}],
    metric_source_checks:[{resource_key:'server:3',revision:'1',payload:{mode:'same_actual_source_snapshot',remote_requests_added:0,resource:{type:'server',id:3},revision:1,measured_at:'2026-10-19T06:45:00Z',sample_ids:['old-sample'],checks:[{sample_id:'old-sample',metric_id:'cpu',state:'passed',unit:'%',dimensions:{},value:5,legacy_value:5,legacy_reference:'original'}],semantic_differences:[]},checked_at:old}],
  });
  project(base);
  const current = structuredClone(base); current.at = '2026-10-20T06:46:00Z';
  const r = current.rows;
  r.servers[0].updated_at = sql;r.alert_rules[0].updated_at = sql;
  Object.assign(r.investigations[0],{version:'7',updated_at:sql});
  Object.assign(r.chat_sessions[0],{message_count:'2',last_message_at:sql,updated_at:sql});
  r.chat_messages.push({id:'user',session_id:'session',role:'user',metadata:{requestId:'request'},created_at:sql},{id:'assistant',session_id:'session',role:'assistant',metadata:{canonicalRunId:'run'},created_at:sql});
  r.agent_runs.push({id:'run',idempotency_key:'investigation:request',state:'completed'});
  r.investigation_stream_heads[0].sequence = '18';
  r.investigation_stream_events.push({id:'event17',investigation_id:'investigation',sequence:'17'},{id:'event18',investigation_id:'investigation',sequence:'18'});
  r.metric_policy_bindings[0].payload.application.reported_at = iso;
  Object.assign(r.metric_policy_bindings[0].capabilities[0],{evaluated_at:iso,valid_until:'2026-10-20T06:47:00Z'});
  const source = {attempt_id:'job:1:collector',binding_id:'server:3',collector_id:'collector'};
  const raw = {id:'raw',resource_type:'server',resource_id:'3',stage:'raw',source,collected_at:iso,observed_at:iso,stored_at:iso};
  const observation = {...raw,id:'sample',stage:'normalized',metric:{id:'cpu'},unit:'%',dimensions:{},value:{encoding:'float64',value:6},lineage:[{id:'raw',stage:'raw'}]};
  r.metric_attempts.push({id:source.attempt_id,payload:{id:source.attempt_id,binding_id:'server:3',collector_id:'collector',status:'succeeded',observation_ids:['sample'],started_at:iso,ended_at:iso}});
  r.metric_observations.push({id:'raw',series_hash:'raw-series',payload:raw},{id:'sample',series_hash:'series',payload:observation});
  r.metric_schedule_events.push({id:'event',resource_key:'server:3',job_id:'job'});
  r.workflow_jobs.push({id:'job',job_type:'metrics.collect',state:'completed'});
  r.metric_publications.push({observation_id:'sample',series_hash:'series',generation:'1'});
  Object.assign(r.metric_rollout[0],{latest_payload:{...observation,stored_at:null},updated_at:sql});
  Object.assign(r.metric_schedule[0],{last_end_ms:String(Date.parse(iso)),next_due_ms:String(Date.parse(iso)+60000),updated_at:sql});
  const checks = r.metric_source_checks[0];checks.checked_at = sql;checks.payload.measured_at = iso;checks.payload.sample_ids = ['sample'];Object.assign(checks.payload.checks[0],{sample_id:'sample',value:6,legacy_value:6});
  const plan = {id:'plan',version:1,contentHash:'immutable-content-hash',content:{investigationId:'investigation',steps:[]}};
  r.action_plans.push({id:'plan',current_version:'1',investigation_id:'investigation'});
  r.action_plan_versions.push({plan_id:'plan',version:'1',content_hash:plan.contentHash,content:plan.content,state:'pending_approval'});
  r.agent_tool_approvals.push({id:'approval',args_redacted:{planId:'plan'},status:'pending',scope:'once',used_count:'0',consumed_at:null});
  const business = {phases:[{phase:'continue',result:{investigationId:'investigation',requestId:'request',version:6}},{phase:'collect',result:{executed:12}},{phase:'investigate',result:{requestId:'request'}},{phase:'plan'}],source:{investigationId:'investigation',requestId:'request'},plan};
  project(current);
  return {base,current,business};
}
const review = f => reviewRoundMutations(f.base,f.current,f.business,['server:3','instance:8'],'2026-10-20T06:41:00Z');
function audit(f) { const r=review(f);compareRoundRows(f.base,f.current,r.reviewedRows);compareRoundNative(f.base,f.current,r.allowedCells);assertNativePendingPlan(f.current.rows,f.business.plan);return r; }

test('same investigation and collection updates pass with exact native string controls and no mutation',() => {
  const f=fixture(), before=structuredClone(f);const r=audit(f);
  assert.equal(r.reviewedRows.length,9);assert.deepEqual(f,before);
});
for (const [name,change,code] of [
  ['restored config tampered',f=>f.current.rows.servers[0].name='changed',/ROUND_UNEXPECTED_COLUMN/],
  ['unrelated session changed',f=>{f.base.rows.chat_sessions.push({session_id:'other',message_count:'1'});f.current.rows.chat_sessions.push({session_id:'other',message_count:'2'});},/ROUND_UNREVIEWED_OLD_ROW/],
  ['policy changed',f=>f.current.rows.metric_policy_bindings[0].payload.application.enabled=false,/ROUND_BINDING_CONFIG/],
  ['capability identity changed',f=>f.current.rows.metric_policy_bindings[0].capabilities[0].id='other',/ROUND_CAPABILITY_IDENTITY/],
  ['schedule interval widened',f=>f.current.rows.metric_schedule[0].next_due_ms=String(Date.parse(iso)+120000),/ROUND_SCHEDULE_INTERVAL/],
  ['stream gap',f=>f.current.rows.investigation_stream_events[1].sequence='19',/ROUND_STREAM_CONTIGUOUS/],
  ['wrong request',f=>f.business.phases[2].result.requestId='other',/ROUND_RESULT_REQUEST/],
  ['cross resource sample',f=>f.current.rows.metric_observations[1].payload.resource_id='4',/ROUND_SAMPLE_SCOPE/],
  ['unrelated attempt',f=>f.current.rows.metric_observations[1].payload.source.attempt_id='old-attempt',/ROUND_SAMPLE_ATTEMPT/],
  ['wrong publication',f=>f.current.rows.metric_publications[0].series_hash='other',/ROUND_ROLLOUT_PUBLICATION/],
  ['changed rollout value',f=>f.current.rows.metric_rollout[0].latest_payload.value={encoding:'float64',value:100},/ROUND_ROLLOUT_OBSERVATION/],
  ['raw lineage missing',f=>f.current.rows.metric_observations.shift(),/ROUND_SAMPLE_SCOPE/],
  ['legacy mismatch',f=>f.current.rows.metric_source_checks[0].payload.checks[0].legacy_value=7,/ROUND_CHECK_EQUIVALENCE/],
  ['definition changed',f=>f.current.rows.metric_source_checks[0].payload.checks[0].legacy_reference='new',/ROUND_CHECK_DEFINITION/],
  ['old row removed',f=>f.current.rows.servers=[],/ROUND_OLD_ROW_REMOVED/],
  ['product job added',f=>f.current.rows.workflow_jobs.push({id:'action',job_type:'action.execute',state:'completed'}),/PRODUCT_ACTION_JOB_FORBIDDEN/],
  ['product action added',f=>f.current.rows.action_jobs.push({id:'action'}),/PRODUCT_ACTION_FORBIDDEN/],
  ['used approval',f=>f.current.rows.agent_tool_approvals[0].used_count='1',/APPROVAL_CONSUMED/],
  ['nonterminal job',f=>f.current.rows.workflow_jobs[0].state='running',/ROUND_SAMPLE_JOB/],
]) test(`rejects ${name}`,()=>{const f=fixture();change(f);assert.throws(()=>audit(f),code);});

test('rejects changed native scalar even when logical row is correct',()=>{
  const f=fixture();f.current.native.chat_sessions['["session"]'].message_count.value='9';assert.throws(()=>audit(f),/NATIVE_SCALAR_VALUE/);
});
test('protects unchanged native cells even in reviewed rows',()=>{
  const f=fixture();f.current.native.servers['["3"]'].name.value='other';assert.throws(()=>audit(f),/OLD_NATIVE_CELL_CHANGED/);
});
test('protects native JSON leaf representation when logical value is unchanged',()=>{
  const f=fixture();const c=f.current.native.metric_policy_bindings['["server:3"]'].payload;
  c.paths.find(p=>p.path==='$."application"."enabled"').type='STRING';assert.throws(()=>audit(f),/NATIVE_UNCHANGED_LEAF/);
});
test('binds changed JSON leaf and paths to actual SQL value',()=>{
  const f=fixture();const c=f.current.native.metric_rollout['["series"]'].latest_payload;
  c.paths.find(p=>p.path==='$."id"').value='other';assert.throws(()=>audit(f),/NATIVE_JSON_LEAF/);
});
test('does not accept reviewed row digests after another edit',()=>{
  const f=fixture(),r=review(f);f.current.rows.servers[0].name='late-change';
  assert.throws(()=>compareRoundRows(f.base,f.current,r.reviewedRows),/ROUND_UNREVIEWED_ROW_DIGEST/);
});
for(const version of ['01','1.0','1e0',' 1',-1,Number.MAX_SAFE_INTEGER+1]) test(`rejects noncanonical native version ${version}`,()=>{
  const f=fixture();f.current.rows.action_plan_versions[0].version=version;assert.throws(()=>assertNativePendingPlan(f.current.rows,f.business.plan),/ROUND_INTEGER/);
});
for (const [name,change,code] of [
  ['content',f=>f.current.rows.action_plan_versions[0].content={investigationId:'other'},/IMMUTABLE_PLAN_CONTENT/],
  ['hash',f=>f.current.rows.action_plan_versions[0].content_hash='other',/IMMUTABLE_PLAN_HASH/],
  ['state',f=>f.current.rows.action_plan_versions[0].state='approved',/PLAN_MUST_REMAIN_PENDING/],
  ['approval scope',f=>f.current.rows.agent_tool_approvals[0].scope='session',/APPROVAL_CONSUMED/],
  ['approval consumption',f=>f.current.rows.agent_tool_approvals[0].consumed_at=sql,/APPROVAL_CONSUMED/],
]) test(`immutable plan rejects changed ${name}`,()=>{const f=fixture();change(f);assert.throws(()=>assertNativePendingPlan(f.current.rows,f.business.plan),code);});
