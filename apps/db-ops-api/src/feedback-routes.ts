import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { ActorContext } from './auth/actor-context.js';
import { feedbackService, type FeedbackItem, type FeedbackService } from './feedback-service.js';

type FeedbackRouteService = Pick<FeedbackService, 'list' | 'create' | 'update' | 'delete'>;

function actorFrom(request: { user?: ActorContext }): ActorContext {
  if (!request.user) throw new Error('AUTHENTICATION_REQUIRED');
  return request.user;
}

function parseId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function parseBody(body: unknown): { title: string; description: string } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'title' && key !== 'description')) return null;
  if (typeof record.title !== 'string' || typeof record.description !== 'string') return null;
  const title = record.title.trim();
  const description = record.description.trim();
  if (!title || title.length > 160 || !description || description.length > 5000) return null;
  return { title, description };
}

function serialize(item: FeedbackItem) {
  return {
    ...item,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

function sendError(reply: any, error: unknown) {
  const reason = error instanceof Error ? error.message : '';
  if (reason === 'FEEDBACK_NOT_FOUND') return reply.code(404).send({ error: reason });
  if (reason === 'FEEDBACK_PAYLOAD_INVALID') return reply.code(400).send({ error: reason });
  return reply.code(500).send({ error: 'FEEDBACK_OPERATION_FAILED' });
}

export async function registerFeedbackRoutes(
  fastify: FastifyInstance,
  verifyToken: preHandlerHookHandler,
  service: FeedbackRouteService = feedbackService,
): Promise<void> {
  fastify.get('/api/feedback', { preHandler: [verifyToken] }, async (request, reply) => {
    try {
      const items = await service.list(actorFrom(request as any));
      return reply.send({ feedback: items.map(serialize) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post('/api/feedback', { preHandler: [verifyToken] }, async (request, reply) => {
    const body = parseBody(request.body);
    if (!body) return reply.code(400).send({ error: 'FEEDBACK_PAYLOAD_INVALID' });
    try {
      const item = await service.create(actorFrom(request as any), { ...body, source: 'manual' });
      return reply.code(201).send({ feedback: serialize(item) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.put('/api/feedback/:id', { preHandler: [verifyToken] }, async (request, reply) => {
    const id = parseId((request.params as { id?: string }).id);
    const body = parseBody(request.body);
    if (id === null || !body) return reply.code(400).send({ error: 'FEEDBACK_PAYLOAD_INVALID' });
    try {
      const item = await service.update(actorFrom(request as any), id, body);
      return reply.send({ feedback: serialize(item) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.delete('/api/feedback/:id', { preHandler: [verifyToken] }, async (request, reply) => {
    const id = parseId((request.params as { id?: string }).id);
    if (id === null) return reply.code(400).send({ error: 'FEEDBACK_PAYLOAD_INVALID' });
    try {
      await service.delete(actorFrom(request as any), id);
      return reply.send({ success: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
