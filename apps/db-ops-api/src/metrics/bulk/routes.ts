import { z } from 'zod';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { ActorContext } from '../../auth/actor-context.js';
import { actorContextService } from '../../auth/actor-context.js';
import { dbConnection } from '../../db-connection.js';
import { expensiveOperationRateLimitConfig } from '../../security/http-security.js';
import { metricConfigurationService } from '../config/routes.js';
import { policyService } from '../policy/service.js';
import { PolicyError, rule } from '../policy/model.js';
import { BulkConfirmSchema } from './model.js';
import { BulkConfigurationService } from './service.js';
import { MysqlBulkStore } from './store.js';

export function createBulkConfigurationService() {
  const store=new MysqlBulkStore(()=>{const pool=dbConnection.getPool();rule(pool,'POLICY_STORE_UNAVAILABLE',503);return pool;});
  return new BulkConfigurationService(policyService,metricConfigurationService,store,async (seed,requestId)=>{
    // JWT entrypoints only accept users; preserve the original server-owned resource ceiling on every reload.
    rule(seed.principalKind!=='service','POLICY_FORBIDDEN',403);
    const actor=await actorContextService.loadActiveActor(seed.userId,seed.sessionVersion,requestId);
    return seed.resourceBoundary?{...actor,resourceBoundary:seed.resourceBoundary}:actor;
  });
}
export async function registerMetricBulkRoutes(app:FastifyInstance,verifyToken:preHandlerHookHandler,
  implementation=createBulkConfigurationService(),worker=true) {
  const base='/api/metrics/config/bulk';
  const routes=[['GET',base,'list'],['POST',`${base}/preview`,'preview'],['GET',`${base}/:id`,'get'],
    ['POST',`${base}/:id/confirm`,'confirm'],['POST',`${base}/:id/cancel`,'cancel'],['POST',`${base}/:id/retry`,'retry']] as const;
  for(const [method,url,operation]of routes)app.route({method,url,preHandler:[verifyToken],bodyLimit:131072,
    config:{rateLimit:method==='POST'?expensiveOperationRateLimitConfig:{max:120,timeWindow:'1 minute'}},
    handler:async(request,reply)=>{
      reply.header('Cache-Control','private, no-store');
      const actor=(request as unknown as {user?:ActorContext}).user;
      if(!actor)return reply.code(401).send({error:'POLICY_AUTH_REQUIRED'});
      try {
        if(operation==='preview')return await implementation.preview(actor,request.body);
        if(operation==='list')return await implementation.list(actor);
        const id=z.uuid().parse((request.params as {id:string}).id);
        if(operation==='get')return await implementation.get(actor,id);
        if(operation==='confirm')return await implementation.confirm(actor,id,BulkConfirmSchema.parse(request.body).digest);
        if(operation==='cancel'){z.strictObject({}).parse(request.body??{});return await implementation.cancel(actor,id);}
        return await implementation.retry(actor,id,request.body);
      }catch(e){
        if(e instanceof PolicyError)return reply.code(e.status).send({error:e.code});
        if(e instanceof z.ZodError)return reply.code(400).send({error:'POLICY_INPUT_INVALID'});
        return reply.code(503).send({error:'BULK_UNAVAILABLE'});
      }
    }});
  if(worker){
    let active:Promise<unknown>|null=null,timer:ReturnType<typeof setInterval>|undefined;
    const tick=()=>{if(!active)active=implementation.run().catch(()=>{
      app.log.warn({code:'METRIC_BULK_WORKER_UNAVAILABLE'},'Bulk configuration queue paused until next tick');
    }).finally(()=>{active=null;});};
    app.addHook('onReady',async()=>{timer=setInterval(tick,1000);timer.unref();tick();});
    app.addHook('onClose',async()=>{clearInterval(timer);implementation.stop();await active;});
  }
}
