import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { actorContextService, ActorAuthenticationError, type ActorContext } from '../../auth/actor-context.js';
import { dbConnection } from '../../db-connection.js';
import { policyService } from '../policy/service.js';
import { PolicyError, rule } from '../policy/model.js';
import { createConfigurationRegistry } from '../config/registry.js';
import { MetricStudyService } from './study.js';

export const createMetricStudyService = (registry=createConfigurationRegistry()) => new MetricStudyService(()=>{const p=dbConnection.getPool();rule(p,'METRIC_STORE_UNAVAILABLE',503);return p;},policyService,registry,
  a=>actorContextService.revalidateActor(a,a.requestId),async(a,ref,revision)=>{
    const {templateBindingService}=await import('../templates/routes.js');return templateBindingService.readConfigurationAt(a,ref,revision);
  });
export const metricStudyService=createMetricStudyService();
export async function registerMetricStudyRoutes(app:FastifyInstance,verify:preHandlerHookHandler,service=metricStudyService) {
  for(const op of ['catalog','dimensions','trend','replay','capacity'] as const) app.post(`/api/metrics/study/${op}`,{preHandler:[verify],bodyLimit:65536},async(req,reply)=>{
    reply.header('Cache-Control','private, no-store');const actor=(req as unknown as {user:ActorContext}).user;
    if(!actor)return reply.code(401).send({error:'AUTH_REQUIRED'});
    try{return await service[op](actor,req.body);}catch(e){
      if(e instanceof ActorAuthenticationError)return reply.code(401).send({error:'AUTH_REQUIRED'});
      if(e instanceof z.ZodError)return reply.code(400).send({error:'STUDY_INPUT_INVALID'});
      if(e instanceof PolicyError)return reply.code(e.status).send({error:e.code});
      if(e instanceof Error && ['QUERY_WINDOW','QUERY_LIMIT_EXCEEDED','QUERY_SERIES_LIMIT','ROLLOUT_QUERY_RANGE'].includes(e.message))return reply.code(400).send({error:e.message});
      return reply.code(503).send({error:'HISTORY_STUDY_UNAVAILABLE'});
    }
  });
}
