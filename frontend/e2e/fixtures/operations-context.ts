/** Synthetic resource/observation adapters; real SQL/JWT/ACL and operations domains. */
import { provisionInvestigationServiceIdentity } from '../../../apps/db-ops-api/src/investigations/authorization.ts';
import { randomUUID } from 'node:crypto';
import { BaselineStore } from '../../../apps/db-ops-api/src/operations/baselines/store.ts';
import { syntheticWindow } from '../../../apps/db-ops-api/src/operations/baselines/test-support.ts';
import { HOUR } from '../../../apps/db-ops-api/src/operations/baselines/source-adapter.ts';
import { registerBaselineRoutes } from '../../../apps/db-ops-api/src/operations/baselines/routes.ts';
import { AttentionStore } from '../../../apps/db-ops-api/src/operations/attention/store.ts';
import { registerAttentionRoutes } from '../../../apps/db-ops-api/src/operations/attention/routes.ts';
import { operationsFlags } from '../../../apps/db-ops-api/src/operations/feature-flags.ts';
import { OperationsAuthorization } from '../../../apps/db-ops-api/src/operations/authorization.ts';
import { MysqlOperationalEventIngest } from '../../../apps/db-ops-api/src/investigations/event-ingest.ts';
import { MysqlInvestigationBudgetLedger } from '../../../apps/db-ops-api/src/investigations/budget-ledger.ts';
import { investigationBudgetConfiguration } from '../../../apps/db-ops-api/src/investigations/session-bridge.ts';

export async function registerContextFixture(f:any, verify:any, actor:any) {
  await f.rows("INSERT INTO network_devices(id,name,host,status) VALUES(601,'SYNTHETIC switch','synthetic.invalid','unknown')");
  const refs=[{type:'instance',id:101},{type:'server',id:501},{type:'network_device',id:601}];
  const authorization=new OperationsAuthorization(f.contexts),flags=()=>({...operationsFlags({}),context:true,baselines:true,attention:true});
  const baseline=new BaselineStore(()=>f.pool,()=>({load:async(_a:any,input:any,fence:string,targetVersion:string)=>{
    const now=Date.now(),value=syntheticWindow(input.mode),shift=Math.floor(now/HOUR)*HOUR-Date.parse(value.until);
    const shifted=(at:string)=>new Date(Date.parse(at)+shift).toISOString();
    value.from=shifted(value.from);value.until=shifted(value.until);for(const b of value.buckets)b.window={from:shifted(b.window.from),to:shifted(b.window.to)};
    value.latest.observedAt=shifted(value.latest.observedAt!);value.identity={...value.identity!,resource:input.resource,metric:`${input.metric}@1.0.0`,dimensions:input.dimensions,source:{...value.identity!.source,version:targetVersion}};
    value.evaluatedAt=new Date(now).toISOString();value.validUntil=new Date(now+120000).toISOString();value.fence=fence;return value;
  }}),authorization,flags);
  await registerBaselineRoutes(f.app,verify,baseline);
  await registerAttentionRoutes(f.app,verify,new AttentionStore(()=>f.pool,f.contexts,undefined,{},flags));
  const read=async(req:any,ref:any)=>{const c=await f.pool.getConnection();try{await c.beginTransaction();await authorization.authorize(c,req.user,[ref],'context:read');await c.commit();}catch(e){await c.rollback();throw e;}finally{c.release();}};
  f.app.get('/api/database/instances/:id',{preHandler:verify},async(req:any)=>{const id=Number(req.params.id);await read(req,{type:'instance',id});const [row]=await f.rows('SELECT id,name,db_type,host,port,username,database_name,environment,description,status,created_at,updated_at FROM database_instances WHERE id=?',[id]);return row;});
  f.app.get('/api/servers/:id',{preHandler:verify},async(req:any)=>{const id=Number(req.params.id);await read(req,{type:'server',id});const [row]=await f.rows('SELECT id,host,label,os_type,status,port,created_at,updated_at FROM servers WHERE id=?',[id]);return row;});
  f.app.get('/api/servers/:id/instances',{preHandler:verify},async(req:any)=>{await read(req,{type:'server',id:Number(req.params.id)});return {items:[],instances:[],authorizedCounts:{total:0}};});
  f.app.get('/api/network-devices/:id',{preHandler:verify},async(req:any)=>{const id=Number(req.params.id);await read(req,{type:'network_device',id});return (await f.rows('SELECT * FROM network_devices WHERE id=?',[id]))[0];});
  for(const path of ['relations','config-backups','interfaces'])f.app.get(`/api/network-devices/:id/${path}`,{preHandler:verify},async(req:any)=>{await read(req,{type:'network_device',id:Number(req.params.id)});return {[path==='config-backups'?'backups':path]:[]};});
  f.app.get('/api/network-devices/:id/backup-schedule',{preHandler:verify},async(req:any)=>{await read(req,{type:'network_device',id:Number(req.params.id)});return {schedule:null};});
  f.app.get('/api/resources/overview',{preHandler:verify},async(req:any)=>{for(const ref of refs)await read(req,ref);return {items:refs.map(resource=>({resource,status:'unknown',quality:'partial',gaps:['OBSERVATIONS_EMPTY'],unresolvedAlerts:0,observedAt:null})),partial:true};});
  f.app.post('/api/metrics/query',{preHandler:verify},async(req:any)=>{
    const ref=req.body.resource;await read(req,ref);
    const now=new Date().toISOString();return {profile:{columns:[]},window:{from:new Date(Date.now()-3600000).toISOString(),to:now},metrics:[{definition:{id:'host.cpu.used_ratio',category:'SYNTHETIC',meaning:'Synthetic bounded observation',unit:'%'},state:'known',capability:{status:'supported'},series:[{dimensions:{},buckets:[{value:{encoding:'float64',value:40},unit:'%',coverage:1,quality:{status:'good',reason:'none'},freshness:'fresh',accuracy:'exact',sources:[],window:{from:now,to:now}}]}]}]};
  });
  await f.rows("INSERT INTO resource_relations(source_type,source_id,target_type,target_id,relation_type,provenance,valid_from) VALUES('instance',101,'server',501,'runs_on','manual',UTC_TIMESTAMP(3)),('server',501,'network_device',601,'connected_to','manual',UTC_TIMESTAMP(3))");
  const budget=investigationBudgetConfiguration();
  const ledger=new MysqlInvestigationBudgetLedger(()=>f.pool,budget.policy);
  const connection=await f.pool.getConnection();
  let serviceActor;
  try {
    await connection.beginTransaction();
    const serviceId=await provisionInvestigationServiceIdentity(connection,'max202-synthetic-collector');
    await connection.execute("INSERT INTO roles(id,name) VALUES(301,'max202-readonly-collector')");
    await connection.execute("INSERT INTO role_permissions(role_id,permission_id) SELECT 301,id FROM permissions WHERE code IN ('chat:view','instance:view','servers:view','network_devices:view')");
    await connection.execute('INSERT INTO user_roles(user_id,role_id) VALUES(?,301)',[serviceId]);
    await connection.execute("INSERT INTO instance_permissions(user_id,instance_id,access_level) VALUES(?,101,'read-only')",[serviceId]);
    serviceActor={...await f.contexts.loadInvestigationActorFrom(connection,serviceId,'service',1),resourceBoundary:{instanceIds:[101],serverIds:[501],networkDeviceIds:[601]}};
    await connection.commit();
  } catch(error){await connection.rollback();throw error;}finally{connection.release();}
  const binding={source:'max202-synthetic-collector',verified:true,allowedOrigins:['collector'],policy:{id:'max202-no-admission',version:1,domain:'max202-ui',actor:serviceActor,profileId:'ops',profileVersion:1,resources:refs.map(r=>({...r,role:'primary'})),kinds:['failure'],threshold:10000,windowMs:300000,cooldownMs:600000,criticalSingle:false,reserveTokens:100,reserveCostMicros:100}};
  const ingester=new MysqlOperationalEventIngest(()=>f.pool,binding as never,ledger,f.authorization,f.bridge);
  for(let i=0;i<2;i++)await ingester.ingest({schemaVersion:1,sourceEventId:randomUUID(),kind:'failure',subject:{kind:'resource',resource:refs[0]},occurredAt:new Date(Date.now()-1000-i*1000).toISOString(),severity:'error',summary:'SYNTHETIC browser correlation only',origin:'collector',stableErrorCode:'UI_SYNTHETIC',callsite:'max202.fixture'});
  return {baseline};
}
