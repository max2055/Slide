import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { maintenanceWindowService } from './maintenance-window-service.js';
import { RefSchema, PolicyError, rule } from './metrics/policy/model.js';
import { ActorAuthenticationError } from './auth/actor-context.js';
export const maintenanceIntervals = maintenanceWindowService.intervals;
export async function registerMaintenanceRoutes(app:FastifyInstance,verify:preHandlerHookHandler,service=maintenanceIntervals){
 for(const op of ['resources','list','create','update','cancel','operation','history'] as const){
  const url=op==='resources'?'/api/maintenance-windows/resources':op==='operation'?'/api/maintenance-windows/operations/:key':op==='history'?'/api/maintenance-windows/intervals/:type/:id':op==='update'||op==='cancel'?'/api/maintenance-windows/:id':'/api/maintenance-windows';
  app.route({method:op==='create'?'POST':op==='update'?'PUT':op==='cancel'?'DELETE':'GET',url,preHandler:[verify],handler:async(req:any,reply)=>{
   reply.header('Cache-Control','private, no-store');
   try{
    rule(req.user,'MAINTENANCE_AUTH',401);
    if(op==='resources')return await service.resources(req.user);
    if(op==='list')return await service.list(req.user);
    if(op==='operation')return await service.operation(req.user,req.params.key);
    if(op==='history')return await service.history(req.user,RefSchema.parse({type:req.params.type,id:Number(req.params.id)}),req.query.from,req.query.to);
    if(op!=='create')z.string().uuid().parse(req.params.id);
    return await service.change(req.user,op==='create'?null:req.params.id,req.body);
   }catch(e){
    if(e instanceof ActorAuthenticationError)return reply.code(401).send({error:'MAINTENANCE_AUTH'});
    if(e instanceof PolicyError)return reply.code(e.status).send({error:e.code});
    if(e instanceof z.ZodError)return reply.code(400).send({error:'MAINTENANCE_INPUT',details:e.issues.map(i=>i.message)});
    return reply.code(503).send({error:'MAINTENANCE_STATE_UNKNOWN'});
   }
  }});
 }
}
