import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { alertResource, alertObservation } from './resource-event-bridge.js';
import { bridgeTestFixture } from './bridge-test-fixture.js';
import { DatabaseAlertBridge, type DatabaseAlertSource } from './alert-bridge.js';
import { AlertRCAService } from '../alert-rca-service.js';
import { dbConnection } from '../db-connection.js';
import { alertDatabaseService } from '../alert-database-service.js';
import { createVerifyToken } from '../auth-middleware.js';
import { registerAnalysisBridgeRoutes } from './bridge-routes.js';
import { registerInvestigationRoutes } from './routes.js';
import { signAccessToken } from '../auth/actor-context.js';

const observationTime = '2026-10-14T05:00:00.000Z';
const source = { id: 1, instance_id: 101, title: '冻结 CPU 观测', message: '告警事实', level: 'critical',
  created_at: '2026-10-14T05:00:01.000Z', metric_name: 'cpu_usage', metric_value: '91', threshold_value: '80',
  tags: { collected_at: observationTime, observed_from: '2026-10-14T04:59:00.000Z', observed_to: observationTime, quality: 'good' } };
describe('resource event subject and observation boundaries', () => {
  it('one resource column, never tags, determines the subject', () => {
    expect(alertResource(source)).toEqual({type:'instance',id:101});
    expect(alertResource({...source,instance_id:null,server_id:101})).toEqual({type:'server',id:101});
    expect(alertResource({...source,instance_id:null,network_device_id:101})).toEqual({type:'network_device',id:101});
    for (const value of [{...source,server_id:101},{...source,instance_id:null},{...source,instance_id:0},{...source,instance_id:-1}])
      expect(()=>alertResource(value)).toThrow('INVESTIGATION_INPUT_INVALID');
  });
  it('preserves real value/window/quality and leaves missing/future observations unknown', () => {
    expect(alertObservation({...source,tags:{observed_from:source.tags.observed_from,observed_to:observationTime,quality:'partial'}})).toMatchObject({observedAt:null,quality:'partial',from:source.tags.observed_from,to:observationTime});
    expect(alertObservation(source)).toMatchObject({value:91,quality:'good',from:'2026-10-14T04:59:00.000Z',to:observationTime});
    for(const alert of [{...source,tags:null},{...source,metric_value:null},{...source,tags:{...source.tags,collected_at:'2027-01-01T00:00:00Z'}},
      {...source,tags:{...source.tags,collected_at:'invalid'}}])
      expect(alertObservation(alert).quality).toBe('unknown');
    expect(alertObservation({...source,metric_name:'network.device.status',metric_value:null,tags:{quality:'unknown'}})).toMatchObject({quality:'unknown',availability:'unknown'});
    expect(alertObservation({...source,metric_name:'device_reachability',metric_value:0})).toMatchObject({value:0,quality:'good',availability:'observed_status'});
    expect(alertObservation({...source,metric_name:'device_reachability',metric_value:null})).toMatchObject({value:null,quality:'unknown',availability:'unknown'});
  });
});

describe('three resource bridges / formal isolated MySQL migrations, JWT and HTTP', () => {
  let f: Awaited<ReturnType<typeof bridgeTestFixture>>, app: ReturnType<typeof Fastify>, bridge: DatabaseAlertBridge;
  const originalPool = dbConnection.getPool;
  let owner: Awaited<ReturnType<typeof f.contexts.loadActiveActor>>, calls=0;
  const flags = {manual:true,opsAuto:true,legacy:true};
  const legacy = async () => { calls++; return {success:true,analysisId:999}; };
  const ids = new Map<string, {alert:number; investigation:string}>();
  beforeAll(async () => {
    f=await bridgeTestFixture();
    (dbConnection as any).getPool=()=>f.pool;
    await f.pool.query("INSERT INTO servers (id,host,port,os_type,credential_type,credential_encrypted) VALUES (101,'server.fixture.invalid',22,'linux','password','unused')");
    await f.pool.query("INSERT INTO network_devices (id,name,host,vendor) VALUES (101,'网络无指标夹具','network.fixture.invalid','huawei')");
    await f.pool.query("INSERT INTO role_permissions (role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.id IN (101,201) AND p.code IN ('servers:view','network_devices:view')");
    owner=await f.contexts.loadActiveActor(101);
    bridge=new DatabaseAlertBridge(()=>f.pool,f.contexts,f.authorization,f.bridge,()=>flags,
      ()=>({configured:true,serviceUserId:f.serviceId,instanceIds:[101],serverIds:[101],networkDeviceIds:[101],policyId:'resource-alert-pilot',policyVersion:1}));
    app=Fastify(); const verify=createVerifyToken('t10-test-secret',f.contexts);
    await registerAnalysisBridgeRoutes(app,verify,f.legacy,()=>flags,new AlertRCAService(bridge));
    await registerInvestigationRoutes(app,verify,f.bridge,f.bridge.observationServices(),f.legacy);
  },120_000);
  afterAll(async()=>{(dbConnection as any).getPool=originalPool;await app?.close();await f?.close();},30_000);
  const headers=()=>({authorization:`Bearer ${signAccessToken(owner,'t10-test-secret')}`});
  for (const type of ['instance','server','network_device'] as const) it(`${type}: auto then concurrent manual use one owner and preserve metrics/window`,async()=>{
    const field=type==='instance'?'instance_id':type==='server'?'server_id':'network_device_id';
    const [result]=await f.pool.execute<any>(`INSERT INTO alerts (${field},target_type,alert_type,level,title,message,metric_name,metric_value,threshold_value,tags,created_at)
      VALUES (101,?,'performance','critical',?,'冻结观测',?,?,?,?,?)`,[type,`${type} CPU 夹具`,'cpu_usage','91','80',JSON.stringify(source.tags),new Date(source.created_at)]);
    const [rows]=await f.pool.query<any[]>('SELECT * FROM alerts WHERE id=?',[result.insertId]);
    const receipt=await bridge.dispatch(rows[0] as DatabaseAlertSource,'auto',undefined,legacy);
    expect(receipt.investigationId).toBeTruthy();
    ids.set(type,{alert:result.insertId,investigation:receipt.investigationId!});
    const responses=await Promise.all(Array.from({length:10},()=>app.inject({method:'POST',url:`/api/alerts/${result.insertId}/investigation`,headers:headers(),payload:{}})));
    expect(responses.map(r=>r.statusCode)).toEqual(Array(10).fill(202));
    expect(new Set(responses.map(r=>r.json().investigationId))).toEqual(new Set([receipt.investigationId]));
    const detail=await app.inject({url:`/api/investigations/${receipt.investigationId}`,headers:headers()});
    expect(detail.statusCode).toBe(200);
    expect(detail.json().resources).toEqual([{type,id:101,role:'primary'}]);
    expect(detail.json().context).toMatchObject({subject:{kind:'resource',resource:{type,id:101}},from:source.tags.observed_from,to:observationTime});
    const [events]=await f.pool.query<any[]>("SELECT JSON_UNQUOTE(JSON_EXTRACT(envelope,'$.summary')) AS summary FROM operational_events WHERE source_event_id=?",[`alert:${result.insertId}`]);
    expect(events[0].summary).toContain('"value":91'); expect(events[0].summary).toContain('"quality":"good"');
    flags.manual=false; flags.opsAuto=false;
    expect((await bridge.dispatch(rows[0],'manual',owner,legacy)).investigationId).toBe(receipt.investigationId);
    flags.manual=true;flags.opsAuto=true; expect(calls).toBe(0);
  });
  it('pre-T10 interrupted database owner preserves the original admission command',async()=>{
    const alert={...source,id:9801};
    await f.pool.query("INSERT INTO investigation_alert_owners (alert_id,lane,command_snapshot) VALUES (9801,'investigation',?)",[JSON.stringify({trigger:'manual',actor:owner,alert})]);
    const original=await f.bridge.create(owner,{title:alert.title,goal:'只读调查数据库告警，引用事实并说明证据缺口。',profileId:'ops',profileVersion:1,
      resources:[{type:'instance',id:101,role:'primary'}],idempotencyKey:'database-alert:9801',context:{subject:{kind:'resource',resource:{type:'instance',id:101}}}},
      {idempotencyKey:'database-alert:9801',message:`${alert.title}\n${alert.message}`});
    const resumed=await bridge.dispatch(alert,'manual',owner,legacy);
    expect(resumed.investigationId).toBe(original.investigation.id);expect(calls).toBe(0);
  });
  it('network legacy running work retains its original owner when new flags are enabled',async()=>{
    const alert={...source,id:9802,instance_id:null,network_device_id:101};
    const [insert]=await f.pool.query<any>("INSERT INTO ai_analysis (analysis_type,target_type,network_device_id,related_id,trigger_type,status,session_key) VALUES ('alert_rca','network_device',101,9802,'auto','running','network-legacy')");
    const receipt=await bridge.dispatch(alert,'manual',owner,legacy);
    expect(receipt).toMatchObject({success:true,analysisId:insert.insertId,status:'running',sessionKey:'network-legacy'});
    expect(receipt.investigationId).toBeUndefined();expect(calls).toBe(0);
  });
  it('active alert touch freezes the new value with its real new window, then keeps that owner snapshot',async()=>{
    const [insert]=await f.pool.query<any>(`INSERT INTO alerts (server_id,target_type,alert_type,level,title,message,metric_name,metric_value,tags,created_at)
      VALUES (101,'server','performance','critical','active CPU','old value','cpu_usage','80',?,'2026-10-13 00:00:00')`,[JSON.stringify({...source.tags,rule_id:123})]);
    const to=new Date(Date.now()-2000).toISOString(),from=new Date(Date.now()-62000).toISOString();
    const tags={collected_at:to,observed_from:from,observed_to:to,quality:'good'};
    await alertDatabaseService.touchAlert(insert.insertId,93,{message:'new CPU93',tags});
    const [rows]=await f.pool.query<any[]>('SELECT * FROM alerts WHERE id=?',[insert.insertId]);
    expect(rows[0].message).toBe('new CPU93');
    expect(alertObservation(rows[0])).toMatchObject({value:93,quality:'good',from,to});
    const persisted=typeof rows[0].tags==='string'?JSON.parse(rows[0].tags):rows[0].tags;
    expect(persisted.rule_id).toBe(123);
    const admitted=await new AlertRCAService(bridge).analyzeAlert(insert.insertId,'manual',owner);
    const detail=await app.inject({url:`/api/investigations/${admitted.investigationId}`,headers:headers()});
    expect(detail.json().context).toMatchObject({from,to});
    await alertDatabaseService.touchAlert(insert.insertId,94,{message:'later CPU94',tags:{collected_at:null,observed_from:null,observed_to:null,quality:'unknown'}});
    const [later]=await f.pool.query<any[]>('SELECT * FROM alerts WHERE id=?',[insert.insertId]);
    expect(alertObservation(later[0])).toMatchObject({value:94,quality:'unknown',from:null,to:null});
    expect((await bridge.dispatch(later[0],'manual',owner,legacy)).investigationId).toBe(admitted.investigationId);
    const [commands]=await f.pool.query<any[]>('SELECT command_snapshot FROM investigation_alert_owners WHERE alert_id=?',[insert.insertId]);
    const command=typeof commands[0].command_snapshot==='string'?JSON.parse(commands[0].command_snapshot):commands[0].command_snapshot;
    expect(command.alert.metric_value).toBe('93');
  });
  it('live permission removal blocks all resource and linked deep entrances, no legacy fallback', async()=>{
    const saved=await f.pool.query<any[]>("SELECT permission_id FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE role_id=101 AND p.code='network_devices:view'");
    await f.pool.query("DELETE rp FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=101 AND p.code='network_devices:view'");
    const network=ids.get('network_device')!;
    expect((await app.inject({method:'POST',url:`/api/alerts/${network.alert}/investigation`,headers:headers(),payload:{}})).statusCode).toBe(404);
    expect((await app.inject({url:`/api/investigations/${network.investigation}`,headers:headers()})).statusCode).toBe(404);
    expect(calls).toBe(0);
    for(const row of saved[0])await f.pool.query('INSERT INTO role_permissions (role_id,permission_id) VALUES (101,?)',[row.permission_id]);
    await f.pool.query('DELETE FROM instance_permissions WHERE user_id=? AND instance_id=101',[f.serviceId]);
    const instance=ids.get('instance')!;
    const [rows]=await f.pool.query<any[]>('SELECT * FROM alerts WHERE id=?',[instance.alert]);
    await expect(bridge.dispatch(rows[0],'auto',undefined,legacy)).rejects.toMatchObject({code:'INVESTIGATION_NOT_FOUND'});
    expect(calls).toBe(0);
  });
});
