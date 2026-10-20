import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { ActorContext } from '../../auth/actor-context.js';
import { OperationsError } from '../contracts.js';
import { KnowledgeService, KnowledgeWatchService } from './service.js';
import type { CaseSearchInput } from './search.js';

/** Internal composition export. P10 owns server registration/public generated
 * contracts. verifyToken must bind the trusted ActorContext on request.user. */
export async function registerKnowledgeRoutes(app: FastifyInstance, verifyToken: preHandlerHookHandler,
  service: KnowledgeService): Promise<void> {
  const actorOf = (r: FastifyRequest) => (r as FastifyRequest & { user: ActorContext }).user;
  const idOf = (r: FastifyRequest) => (r.params as { id: string }).id;
  function route(method: 'GET' | 'POST' | 'PUT', url: string,
    handler: (r: FastifyRequest, reply: FastifyReply, actor: ActorContext) => Promise<unknown>) {
    app.route({ method, url, preHandler: verifyToken, bodyLimit: 64 * 1024,
      onRequest: async (_r, reply) => { reply.header('Cache-Control', 'private, no-store'); },
      handler: async (r, reply) => {
        try {
          const actor = actorOf(r);
          if (!actor) return reply.code(401).send({ error: 'UNAUTHORIZED' });
          return await handler(r, reply, actor);
        } catch (error) {
          if (reply.sent) return reply;
          if (error instanceof OperationsError) return reply.code(error.statusCode).send({ error: error.code });
          r.log.error({ code: 'OPERATIONS_DEPENDENCY_UNAVAILABLE', requestId: r.id }, 'Knowledge HTTP failed');
          return reply.code(503).send({ error: 'OPERATIONS_DEPENDENCY_UNAVAILABLE' });
        }
      } });
  }
  route('GET', '/api/operations/knowledge', async (r, reply, actor) => {
    const query = { ...(r.query as Record<string, unknown>) };
    if (query.limit !== undefined) {
      if (typeof query.limit !== 'string' || !/^[1-9]\d?$/.test(query.limit)) throw new OperationsError('OPERATIONS_INPUT_INVALID');
      query.limit = Number(query.limit);
    }
    await service.search(actor, query as CaseSearchInput, page => { reply.send(page); });
    return reply;
  });
  route('GET', '/api/operations/knowledge/:id', async (r, reply, actor) => {
    await service.detail(actor, idOf(r), view => { reply.send(view); });
    return reply;
  });
  // Authenticated, read-only stream for B15. Uses the existing live Watch
  // service; never broadcasts audit payloads or replays a command. Bounded
  // server refresh also covers expiry/ACL changes without an outbox event.
  route('GET', '/api/operations/knowledge/:id/watch', async (r, reply, actor) => {
    const watch = new KnowledgeWatchService(service);
    let closed = false, timer: ReturnType<typeof setTimeout> | undefined, previous = '';
    const close = () => { closed=true; if(timer)clearTimeout(timer);watch.unwatch(peer); };
    const peer = { send(value:Record<string,unknown>) {
      if(closed)return;
      const encoded=JSON.stringify(value);
      if(encoded!==previous){previous=encoded;reply.raw.write(encoded+'\n');}
      if(value.type==='operations.case.invalidated'){reply.raw.end();close();}
    } };
    reply.hijack();
    reply.raw.writeHead(200,{'Content-Type':'application/x-ndjson','Cache-Control':'private, no-store','X-Accel-Buffering':'no'});
    reply.raw.on('close',close);
    const refresh = async () => {
      if(closed)return;
      try { await watch.refresh(); } catch { peer.send({type:'operations.case.invalidated'}); }
      if(!closed)timer=setTimeout(()=>void refresh(),1000);
    };
    try { await watch.watch(peer,actor,idOf(r)); if(!closed)timer=setTimeout(()=>void refresh(),1000); }
    catch {peer.send({type:'operations.case.invalidated'});reply.raw.end();close();}
    return reply;
  });
  route('POST', '/api/operations/knowledge', async (r, reply, actor) => reply.code(201).send(await service.create(actor, r.body)));
  route('PUT', '/api/operations/knowledge/:id', async (r, _reply, actor) => service.revise(actor, idOf(r), r.body));
  route('POST', '/api/operations/knowledge/:id/submit', async (r, _reply, actor) => service.submit(actor, idOf(r), r.body));
  route('POST', '/api/operations/knowledge/:id/review', async (r, _reply, actor) => service.review(actor, idOf(r), r.body));
  route('POST', '/api/operations/knowledge/:id/withdraw', async (r, _reply, actor) => service.withdraw(actor, idOf(r), r.body));
}
