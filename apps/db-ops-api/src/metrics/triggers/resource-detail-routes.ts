import { metricJsonSchemas } from '../../contracts/metrics/public-api.js';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { dbConnection } from '../../db-connection.js';
import { actorContextService, ActorAuthenticationError } from '../../auth/actor-context.js';
import { hasPermission } from '../../auth/require-permission.js';
import { RefSchema, PolicyError, rule } from '../policy/model.js';
import { templateBindingService } from '../templates/routes.js';
import { templateBindingErrorStatus } from '../templates/binding-service.js';
import { verifyTriggerSnapshot } from './compile.js';
/** Reads the actually applied immutable snapshot; current drafts and a failed application's target are never effective. */
export async function registerResourceTriggerRead(app:FastifyInstance,verify:preHandlerHookHandler){
 const snapshotSchema=structuredClone(metricJsonSchemas.ResourceEffectiveTriggers) as Record<string,unknown>;
 // Fastify's serializer mutates schema nodes; use a private clone. Validation
 // of map keys remains in verifyTriggerSnapshot, not in the response encoder.
 const clean=(node:any):void=>{if(!node||typeof node!=='object')return;delete node.propertyNames;for(const v of Object.values(node))if(v&&typeof v==='object')clean(v);};clean(snapshotSchema);
 const responses:Record<number,Record<string,unknown>>={200:snapshotSchema};
 app.get('/api/metrics/template-bindings/:type/:id/effective-triggers',{preHandler:[verify],schema:{response:responses}},async(req:any,reply)=>{
  reply.header('Cache-Control','private, no-store');
  try{
   const ref=RefSchema.parse({type:req.params.type,id:Number(req.params.id)});
   const actor=await actorContextService.revalidateActor(req.user,req.id);
   rule(hasPermission(new Set(actor.permissions),'metric:view'),'TRIGGER_FORBIDDEN',403);
   const status=await templateBindingService.status(actor,ref);
   let snapshot=null;
   if(status.effective){const pool=dbConnection.getPool();rule(pool,'TRIGGER_STORE_UNAVAILABLE',503);
    const [rows]=await pool.execute<RowDataPacket[]>('SELECT payload FROM metric_trigger_snapshots WHERE resource_key=? AND config_revision=?',[`${ref.type}:${ref.id}`,status.effective.revision]);
    // A legacy binding has no template snapshot; absence is explicit, not zero effective rules.
    if(rows.length){const raw=rows[0].payload;snapshot=verifyTriggerSnapshot(typeof raw==='string'?JSON.parse(raw):raw);
     rule(snapshot.resource.type===ref.type&&Number(snapshot.resource.id)===ref.id&&snapshot.config_revision===status.effective.revision,'TRIGGER_SNAPSHOT_IDENTITY',503);}
   }
   const final=await actorContextService.revalidateActor(actor,req.id);
   await templateBindingService.assertAccess(final,ref,false);
   rule(hasPermission(new Set(final.permissions),'metric:view'),'TRIGGER_FORBIDDEN',403);
   return {resource:ref,revision:status.effective?.revision??null,state:snapshot?'available':'unavailable',snapshot};
  }catch(e){if(e instanceof ActorAuthenticationError)return reply.code(401).send({error:'AUTH_REQUIRED'});
   const mapped=templateBindingErrorStatus(e);if(mapped)return reply.code(mapped.status).send({error:mapped.code});
   if(e instanceof PolicyError)return reply.code(e.status).send({error:e.code});
   if((e as any)?.name==='ZodError')return reply.code(400).send({error:'TRIGGER_INPUT_INVALID'});
   return reply.code(503).send({error:'TRIGGER_READ_UNAVAILABLE'});
  }
 });
}
