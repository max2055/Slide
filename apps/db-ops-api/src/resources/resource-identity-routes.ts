import type {FastifyInstance, preHandlerHookHandler} from 'fastify';
import {requirePermission} from '../auth/require-permission.js';
import {requireInstanceAccess} from '../auth/require-instance-access.js';
import {instanceDatabaseService} from '../instance-database-service.js';
import {serverDatabaseService} from '../server-database-service.js';
import {publicInstanceDto,publicServerDto} from '../security/public-dto.js';
import {canReadResource} from './resource-service.js';
import {canReadIdentity, revalidateIdentityRead} from './identity-read-access.js';
export async function registerResourceIdentityRoutes(fastify:FastifyInstance,verifyToken:preHandlerHookHandler){
  fastify.get('/api/database/instances/:id', { preHandler: [verifyToken, requirePermission('instance:view'), requireInstanceAccess('read-only')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      const instance = await instanceDatabaseService.getInstanceById(Number(id));
      if (!await revalidateIdentityRead(request, reply, 'instance', Number(id))) return;
      if (!instance) {
        return reply.code(404).send({ error: '实例不存在' });
      }
      reply.send(publicInstanceDto(instance as unknown as Record<string, unknown>));
    } catch (error: any) {
      reply.code(500).send({ error: '获取实例详情失败：' + error.message });
    }
  });
  fastify.get('/api/servers', { preHandler: [verifyToken, requirePermission('servers:view')] }, async (request, reply) => {
    try {
      const servers = await serverDatabaseService.getAllServers();
      const current = await revalidateIdentityRead(request, reply, 'server');
      if (!current) return;
      reply.send(servers.filter(server=>canReadIdentity(current,{type:'server',id:server.id})).map((server) => publicServerDto(server as unknown as Record<string, unknown>)));
    } catch (error: any) {
      reply.code(500).send({ error: '获取服务器列表失败：' + error.message });
    }
  });

  // 获取服务器详情
  fastify.get('/api/servers/:id', { preHandler: [verifyToken, requirePermission('servers:view')] }, async (request, reply) => {
    try {
      const { id } = request.params as any;
      if(!canReadResource((request as any).user,{type:'server',id:Number(id)}))return reply.code(403).send({error:'无权读取服务器详情'});
      const server = await serverDatabaseService.getServerById(Number(id));
      if (!await revalidateIdentityRead(request, reply, 'server', Number(id))) return;
      if (!server) {
        return reply.code(404).send({ error: '服务器不存在' });
      }
      // Strip credential_encrypted from response — never send encrypted blob to frontend
      const { credential_encrypted, ...safeServer } = server;
      // Decrypt and include username for edit-form pre-fill (but NOT password/key)
      try {
        const creds = serverDatabaseService.decryptCredentials(credential_encrypted);
        (safeServer as any).credential_username = creds.username;
      } catch {
        // If decryption fails, skip — frontend will show empty username field
      }
      reply.send(publicServerDto({ ...safeServer, credential_encrypted }));
    } catch (error: any) {
      reply.code(500).send({ error: '获取服务器详情失败：' + error.message });
    }
  });

}
