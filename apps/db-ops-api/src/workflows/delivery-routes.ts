import { PolicyError } from '../metrics/policy/model.js';
import { ActorAuthenticationError } from '../auth/actor-context.js';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { deliveryStore, type MysqlDeliveryStore } from './delivery-store.js';

export function registerDeliveryRoutes(app: FastifyInstance, auth: {
  verifyToken: preHandlerHookHandler;
  requirePermission: (permission: string) => preHandlerHookHandler;
}, store: MysqlDeliveryStore = deliveryStore) {
  app.get('/api/notification/deliveries',{preHandler:[auth.verifyToken,auth.requirePermission('notification:view')]},async(req,reply)=>{
    reply.header('Cache-Control','private, no-store');try{return await store.list((req as any).user);}catch(e){return reply.code(e instanceof PolicyError?e.status:e instanceof ActorAuthenticationError?401:503).send({error:e instanceof PolicyError?e.code:'DELIVERY_QUERY_UNAVAILABLE'});}
  });
  app.post('/api/notification/jobs/:id/replay',{preHandler:[auth.verifyToken,auth.requirePermission('notification:manage')]},async(req:any,reply)=>{
    const body=req.body;
    if(!body||Object.keys(body).some(k=>k!=='reason'))return reply.code(400).send({error:'DELIVERY_RECOVERY_INVALID'});
    try{return await store.replay(req.params.id,req.user,body.reason);}catch(e){return reply.code(e instanceof PolicyError?e.status:e instanceof ActorAuthenticationError?401:503).send({error:e instanceof PolicyError?e.code:'DELIVERY_REPLAY_UNAVAILABLE'});}
  });
  app.get('/api/notification/jobs/:id/delivery', {
    preHandler: [auth.verifyToken, auth.requirePermission('notification:view')],
  }, async (request, reply) => {
    reply.header('Cache-Control','private, no-store');
    try {
      const result = await store.inspect((request.params as { id: string }).id,(request as any).user);
      return result ?? reply.code(404).send({ error: 'DELIVERY_NOT_FOUND' });
    } catch(e) { return reply.code(e instanceof PolicyError?e.status:e instanceof ActorAuthenticationError?401:503).send({ error: e instanceof PolicyError?e.code:'DELIVERY_QUERY_UNAVAILABLE' }); }
  });
  app.post('/api/notification/jobs/:id/recover', {
    preHandler: [auth.verifyToken, auth.requirePermission('admin:*')],
  }, async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['version', 'decision', 'reason', 'reconciliation', 'acceptDuplicateRisk'].includes(key))) {
      return reply.code(400).send({ error: 'DELIVERY_RECOVERY_INVALID' });
    }
    try {
      return await store.recover((request.params as { id: string }).id, (request as any).user.userId, body as any,(request as any).user);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if(error instanceof PolicyError)return reply.code(error.status).send({error:error.code});
      if(error instanceof ActorAuthenticationError)return reply.code(401).send({error:'DELIVERY_AUTH'});
      const status = code === 'DELIVERY_RECOVERY_INVALID' ? 400 : code === 'DELIVERY_RECOVERY_CONFLICT' ? 409 : code === 'DELIVERY_NOT_FOUND' ? 404 : 503;
      return reply.code(status).send({ error: status === 503 ? 'DELIVERY_RECOVERY_UNAVAILABLE' : code });
    }
  });
}
