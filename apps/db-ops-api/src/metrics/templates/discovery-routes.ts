import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { actorContextService, ActorAuthenticationError, type ActorContext } from '../../auth/actor-context.js';
import { hasPermission } from '../../auth/require-permission.js';
import { canReadResource, canManageResource, MysqlResourceRelationStore } from '../../resources/resource-service.js';
import { dbConnection } from '../../db-connection.js';
import { RefSchema, type Ref, PolicyError, rule as requireRule } from '../policy/model.js';
import { DiscoveryPreviewRequestSchema, DiscoveryStopSchema, DiscoveryPreviewSchema, discoverySchemas } from '../../contracts/metrics/discovery.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { createAssetCollectorAccess } from '../config/access.js';
import type { CollectorAccess } from '../scheduler/service.js';
import { collectFixed } from '../packages/adapters.js';
import { stable } from '../packages/model.js';
import { hashOf } from '../triggers/model.js';
import { parsePackageReleaseRef } from './model.js';
import { MySqlTemplateRepository } from './mysql-repository.js';
import { discoveryRows, decodeDiscovery } from './discovery-store.js';
import { MysqlScheduleStore } from '../scheduler/store.js';
import { checkApplicability } from '../packages/applicability.js';

/** Explicit bounded read-only preview. A persisted unknown intent is never automatically re-executed. */
export async function registerDiscoveryRoutes(app: FastifyInstance, verify: preHandlerHookHandler,
  poolOf: () => Pool | null = () => dbConnection.getPool(), access: CollectorAccess = createAssetCollectorAccess()) {
  const registry = createConfigurationRegistry();
  const json = (schema: z.ZodType) => { const { $schema: _dialect, ...body } = z.toJSONSchema(schema); return body; };
  const refusals = Object.fromEntries([400,401,403,404,409,422,503].map(n => [n,{ type:'object',properties:{error:{type:'string'}},required:['error'] }]));
  const pool = () => { const p=poolOf(); requireRule(p,'DISCOVERY_STORE_UNAVAILABLE',503); return p; };
  const authorize = async (request: any, ref: Ref, write: boolean, c?: PoolConnection) => {
    requireRule(request.user,'POLICY_AUTH_REQUIRED',401);
    const actor = c ? await actorContextService.revalidateActorOn({execute:(sql,values)=>c.execute(sql,values as any)},request.user,request.id,true)
      : await actorContextService.revalidateActor(request.user,request.id);
    requireRule(hasPermission(new Set(actor.permissions),write?'metric:manage':'metric:view')
      && (write?canManageResource(actor,ref):canReadResource(actor,ref)),'DISCOVERY_FORBIDDEN',403);
    const store=new MysqlResourceRelationStore();
    requireRule(c?await store.existsOn({execute:(sql,values)=>c.execute(sql,values as any)},ref):await store.exists(ref),'DISCOVERY_RESOURCE_NOT_FOUND',404);
    return actor;
  };
  const failure = (error: unknown, reply: any) => reply.code(error instanceof ActorAuthenticationError?401:error instanceof PolicyError?error.status:error instanceof z.ZodError?400:503)
    .send({error:error instanceof ActorAuthenticationError?'POLICY_AUTH_REQUIRED':error instanceof PolicyError?error.code:error instanceof z.ZodError?'DISCOVERY_INPUT':'DISCOVERY_RESULT_UNKNOWN'});
  app.post('/api/metrics/templates/:templateId/discovery-preview',{preHandler:[verify],bodyLimit:32768,
    preValidation:async(request,reply)=>{if(!DiscoveryPreviewRequestSchema.safeParse(request.body).success)return (reply as any).code(400).send({error:'DISCOVERY_INPUT'});},
    schema:{body:json(DiscoveryPreviewRequestSchema),response:{200:json(DiscoveryPreviewSchema),...refusals}}},async(request,reply)=>{
    reply.header('Cache-Control','private, no-store');
    let c: PoolConnection|undefined;
    let reservation: Awaited<ReturnType<MysqlScheduleStore['reserve']>>;
    const input=DiscoveryPreviewRequestSchema.parse(request.body);
    let actor: ActorContext|undefined;
    try {
      actor=await authorize(request,input.resource,true);
      const templateId=(request.params as {templateId:string}).templateId;
      const version=await new MySqlTemplateRepository(pool()).getVersion(templateId,input.version);
      requireRule(version && version.status==='published' && version.aggregate.discovery_rules?.length,'DISCOVERY_VERSION_UNAVAILABLE',422);
      const intent=hashOf({templateId,version:input.version,resource:input.resource}).slice(7);
      c=await pool().getConnection();await c.beginTransaction();
      const [insert]=await c.execute<any>('INSERT IGNORE INTO metric_template_authoring_operations(actor_id,operation_key,intent_hash) VALUES(?,?,?)',[actor.userId,input.operation_key,intent]);
      const [previous]=await c.execute<RowDataPacket[]>('SELECT intent_hash,result FROM metric_template_authoring_operations WHERE actor_id=? AND operation_key=? FOR UPDATE',[actor.userId,input.operation_key]);
      requireRule(previous[0].intent_hash===intent,'DISCOVERY_OPERATION_CONFLICT',409);
      await authorize(request,input.resource,true,c);
      if (!insert.affectedRows) {
        requireRule(previous[0].result,'DISCOVERY_PRIOR_RESULT_UNKNOWN',409);
        const cached=typeof previous[0].result==='string'?JSON.parse(previous[0].result):previous[0].result;
        requireRule(DiscoveryPreviewSchema.safeParse(cached).success,'DISCOVERY_OPERATION_CONFLICT',409);
        await c.commit();return cached;
      }
      await c.commit();c.release();c=undefined;
      reservation=await new MysqlScheduleStore(pool(),registry).reserve(input.resource);
      requireRule(reservation,'DISCOVERY_RESOURCE_BUSY',409);
      await authorize(request,input.resource,true);
      const target=await access.resolve(input.resource);
      const rules=[];
      for(const rule of version.aggregate.discovery_rules!) {
        const members=[];let error:string|null=null;
        try {
          const item=version.items.find(i=>i.item_id===rule.item_ids[0]);requireRule(item,'DISCOVERY_PROTOTYPE_MISSING',422);
          const release=registry.get(parsePackageReleaseRef(item.collector_ref.package_release));
          requireRule(release.package.resource_type===input.resource.type,'DISCOVERY_RESOURCE_TYPE',422);
          requireRule(checkApplicability(release.package,target.resource,new Date().toISOString()).every(v=>v.status==='supported'),'DISCOVERY_APPLICABILITY_UNKNOWN',422);
          const collector=release.package.collectors.find(v=>v.implementation_ref===item.collector_ref.implementation_id);
          requireRule(collector,'DISCOVERY_COLLECTOR_UNAVAILABLE',422);
          const started=Date.now();
          const check=async()=>{await target.assertCurrent?.();await authorize(request,input.resource,true);requireRule(Date.now()-started<rule.timeout_ms,'DISCOVERY_TIMEOUT',503);};
          await check();const transport=await target.resolve(target.credential_ref,target.resource,collector.method);
          // Existing adapters own protocol limits; reauthorize each request and use the remaining total budget.
          const remaining=()=>Math.max(1,rule.timeout_ms-(Date.now()-started));
          const guarded=transport.method==='snmp'?{...transport,get:transport.get?async(oids:string[])=>{await check();return transport.get!(oids,remaining());}:undefined,
            table:async(root:string)=>{await check();return transport.table(root,remaining());}}:transport.method==='sql'?{...transport,pool:{query:async(options:any)=>{await check();return transport.pool.query({...options,timeout:remaining()});}}}
            :{...transport,pool:{execCommands:async(client:any,commands:string[],options:any)=>{await check();return transport.pool.execCommands(client,commands,{...options,timeoutMs:remaining()});}}};
          const rows=await collectFixed(collector.implementation_ref,guarded,target.evidence,rule.timeout_ms,rule.max_instances);
          await check();requireRule(rows.length<=rule.max_instances,'DISCOVERY_BUDGET',422);
          const identities=new Set<string>();
          for(const row of rows){requireRule(rule.identity_dimensions.every(d=>!!row.dimensions[d]),'DISCOVERY_IDENTITY_UNKNOWN',422);
            const identity=stable(Object.fromEntries(rule.identity_dimensions.map(d=>[d,row.dimensions[d]])));
            requireRule(!identities.has(identity),'DISCOVERY_DUPLICATE',422);identities.add(identity);
            members.push({identity,name:(row.display_name??Object.values(row.dimensions).join(' / ')).slice(0,512),dimensions:row.dimensions});}
        }catch(e){error=e instanceof PolicyError?e.code:'DISCOVERY_ENUMERATION_UNKNOWN';}
        rules.push({rule,status:error?'unknown' as const:'complete' as const,count:error?0:members.length,members:error?[]:members,error,
          budget:{timeout_ms:rule.timeout_ms,max_instances:rule.max_instances,item_upper_bound:rule.max_instances*rule.item_ids.length,
            trigger_upper_bound:rule.max_instances*version.aggregate.triggers.filter(t=>rule.item_ids.some(id=>t.scope===`item:${id}`)).length}});
      }
      await authorize(request,input.resource,true);
      const result={state:rules.some(v=>v.error)?'unknown':'completed',version:version.version,content_hash:version.content_hash,rules};
      c=await pool().getConnection();await c.beginTransaction();await authorize(request,input.resource,true,c);
      await c.execute('UPDATE metric_template_authoring_operations SET result=? WHERE actor_id=? AND operation_key=?',[JSON.stringify(result),actor.userId,input.operation_key]);
      await c.execute('INSERT INTO metric_discovery_audit(resource_key,template_id,rule_id,payload,recorded_at) VALUES(?,?,?,?,?)',
        [`${input.resource.type}:${input.resource.id}`,templateId,'preview',JSON.stringify({actor_id:actor.userId,operation_key:input.operation_key,result}),new Date()]);
      await authorize(request,input.resource,true,c);await c.commit();return result;
    }catch(e){if(c)await c.rollback();return failure(e,reply);}
    finally{c?.release();await reservation?.release();}
  });
  for(const write of [false,true])app.route({method:write?'POST':'GET',url:'/api/metrics/discovery/:type/:id'+(write?'/stop':''),preHandler:[verify],
    ...(write?{preValidation:async(request:any,reply:any)=>{if(!DiscoveryStopSchema.safeParse(request.body).success)return (reply as any).code(400).send({error:'DISCOVERY_INPUT'});}}:{}),
    schema:{...(write?{body:json(DiscoveryStopSchema)}:{}),response:{200:json(discoverySchemas.DiscoveryState),...refusals}},
    handler:async(request,reply)=>{
      reply.header('Cache-Control','private, no-store');let c:PoolConnection|undefined;
      try{const params=request.params as {type:string;id:string};const ref=RefSchema.parse({type:params.type,id:Number(params.id)});
        const actor=await authorize(request,ref,write);const key=`${ref.type}:${ref.id}`;
        if(write){const input=DiscoveryStopSchema.parse(request.body);c=await pool().getConnection();await c.beginTransaction();
          // Same lock ordering as the formal writer; neither stale enumeration nor stop can overwrite the other.
          await c.execute('SELECT payload FROM metric_policy_bindings WHERE resource_key=? FOR UPDATE',[key]);
          const [rows]=await c.execute<RowDataPacket[]>('SELECT revision,payload FROM metric_discovery_states WHERE resource_key=? AND template_id=? AND rule_id=? FOR UPDATE',[key,input.template_id,input.rule_id]);
          await authorize(request,ref,true,c);requireRule(rows.length===1,'DISCOVERY_INSTANCE_NOT_FOUND',404);
          const state=decodeDiscovery(rows[0].payload);const member=state.members.find(m=>m.id===input.instance_id);requireRule(member,'DISCOVERY_INSTANCE_NOT_FOUND',404);
          // Same terminal action is a safe idempotent retry; stale conflicting requests fail CAS.
          if(!(member.manual && member.state===input.action)){
            requireRule(Number(rows[0].revision)===input.expected_revision,'DISCOVERY_REVISION_CONFLICT',409);
            member.manual=true;member.state=input.action;member.transitions.push({state:input.action,at:Date.now()});
            await c.execute('UPDATE metric_discovery_states SET revision=revision+1,payload=? WHERE resource_key=? AND template_id=? AND rule_id=?',[JSON.stringify(state),key,input.template_id,input.rule_id]);
            await c.execute('INSERT INTO metric_discovery_audit(resource_key,template_id,rule_id,payload,recorded_at) VALUES(?,?,?,?,?)',
              [key,input.template_id,input.rule_id,JSON.stringify({actor_id:actor.userId,input,instance:member}),new Date()]);
          }
          const result={rows:await discoveryRows(c,key)};await authorize(request,ref,true,c);await c.commit();return result;
        }
        const result={rows:await discoveryRows(pool(),key)};await authorize(request,ref,false);return result;
      }catch(e){if(c)await c.rollback();return failure(e,reply);}finally{c?.release();}
    }});
}
