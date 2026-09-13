import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { ActorContext } from './auth/actor-context.js';
import {
  ChatSessionNotFoundError,
  type ChatDatabaseService,
} from './chat-database-service.js';
import type { ChatResult } from './adapter/types.js';
import { strictBody } from './utils/strict-body.js';

type ChatRouteService = Pick<
  ChatDatabaseService,
  | 'getMessages'
  | 'getMessagePage'
  | 'getSessions'
  | 'updateSessionSettings'
  | 'deleteSession'
  | 'enforceMessageCap'
  | 'getSessionMetadata'
>;

type ChatSendHandler = (
  actor: ActorContext,
  params: { sessionKey?: string; message: string },
) => Promise<ChatResult & { sessionKey: string }>;

export interface ChatRouteDependencies {
  verifyToken: preHandlerHookHandler;
  service: ChatRouteService;
  handleChatSend: ChatSendHandler;
}

function authenticatedActor(request: { user?: ActorContext }): ActorContext {
  if (!request.user) throw new Error('Authenticated actor is unavailable');
  return request.user;
}

function isNotFound(error: unknown): error is ChatSessionNotFoundError {
  return error instanceof ChatSessionNotFoundError;
}

const MAX_HISTORY_LIMIT = 500;
const MAX_SESSION_MESSAGES = 10_000;

function parseBoundedPositiveInteger(value: unknown, maximum: number): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!/^[1-9]\d*$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}

export async function registerChatRoutes(
  fastify: FastifyInstance,
  deps: ChatRouteDependencies,
): Promise<void> {
  const preHandler = [deps.verifyToken];

  fastify.post('/api/chat/send', { preHandler }, async (request, reply) => {
    try {
      const check = strictBody(
        request.body as Record<string, unknown>,
        ['message', 'sessionKey'],
        'POST /api/chat/send',
      );
      if (check.error) return reply.code(400).send(check.error);
      const { message, sessionKey } = check.body;
      if (!message) return reply.code(400).send({ error: 'message is required' });
      const result = await deps.handleChatSend(authenticatedActor(request as any), {
        message: String(message),
        sessionKey: typeof sessionKey === 'string' ? sessionKey : undefined,
      });
      return reply.send({
        reply: result.finalContent,
        usage: result.usage,
        sessionKey: result.sessionKey,
      });
    } catch (error) {
      if (isNotFound(error)) return reply.code(404).send({ error: 'Session not found' });
      return reply.code(500).send({ error: `Chat send failed: ${String((error as Error).message)}` });
    }
  });

  fastify.get('/api/chat/history', { preHandler }, async (request, reply) => {
    try {
      const { sessionKey, limit: limitText, paged, before: beforeText } = request.query as { sessionKey?: string; limit?: string; paged?: string; before?: string };
      if (!sessionKey) return reply.code(400).send({ error: 'sessionKey parameter is required' });
      const limit = limitText === undefined ? 200 : parseBoundedPositiveInteger(limitText, MAX_HISTORY_LIMIT);
      if (limit === null) return reply.code(400).send({ error: `limit must be a positive integer up to ${MAX_HISTORY_LIMIT}` });
      const before = beforeText === undefined ? undefined : parseBoundedPositiveInteger(beforeText, Number.MAX_SAFE_INTEGER);
      if (before === null || (beforeText !== undefined && paged !== 'true')) {
        return reply.code(400).send({ error: 'before requires paged=true and a positive integer cursor' });
      }
      const page = paged === 'true'
        ? await deps.service.getMessagePage(authenticatedActor(request as any), sessionKey, limit, before)
        : null;
      const messages = page?.messages ?? await deps.service.getMessages(
        authenticatedActor(request as any), sessionKey, limit,
      );
      const metadata = typeof deps.service.getSessionMetadata === 'function'
        ? await deps.service.getSessionMetadata(authenticatedActor(request as any), sessionKey)
        : null;
      const formatted = messages.map((message) => ({
        id: message.message_id,
        sequence: message.sequence,
        role: message.role,
        ...formatMessageContent(message.content || ''),
        timestamp: message.created_at ? new Date(message.created_at).getTime() : Date.now(),
      }));
      return reply.send({
        messages: formatted,
        ...(page ? { nextBefore: page.nextBefore } : {}),
        model: typeof metadata?.model === 'string' ? metadata.model : null,
        thinkingLevel: typeof metadata?.thinkingLevel === 'string' ? metadata.thinkingLevel : null,
      });
    } catch (error) {
      if (isNotFound(error)) return reply.code(404).send({ error: 'Session not found' });
      return reply.code(500).send({ error: `获取聊天历史失败：${String((error as Error).message)}` });
    }
  });

  fastify.get('/api/sessions', { preHandler }, async (request, reply) => {
    try {
      const { activeMinutes } = request.query as { activeMinutes?: string };
      const sessions = await deps.service.getSessions(authenticatedActor(request as any));
      const now = Date.now();
      const filtered = activeMinutes
        ? sessions.filter((session) => {
            const lastMessage = session.last_message_at
              ? new Date(session.last_message_at).getTime()
              : 0;
            return now - lastMessage < Number.parseInt(activeMinutes, 10) * 60 * 1000;
          })
        : sessions;
      return reply.send({
        ok: true,
        sessions: filtered.map((session) => {
          const metadata = session.metadata
            ? typeof session.metadata === 'string'
              ? JSON.parse(session.metadata)
              : session.metadata
            : null;
          return {
            key: session.session_id,
            kind: 'direct',
            label: session.title || session.session_id,
            updatedAt: session.last_message_at
              ? new Date(session.last_message_at).getTime()
              : null,
            message_count: session.message_count ?? 0,
            status: metadata?.status || 'active',
            instance_id: session.instance_id ?? null,
            model: typeof metadata?.model === 'string' ? metadata.model : null,
            thinkingLevel: typeof metadata?.thinkingLevel === 'string' ? metadata.thinkingLevel : null,
            thinkingDefault: typeof metadata?.thinkingDefault === 'string' ? metadata.thinkingDefault : null,
            thinkingLevels: Array.isArray(metadata?.thinkingLevels) ? metadata.thinkingLevels : undefined,
          };
        }),
        defaults: {},
      });
    } catch (error) {
      return reply.code(500).send({ error: `获取会话列表失败：${String((error as Error).message)}` });
    }
  });

  fastify.patch('/api/sessions/:key', { preHandler }, async (request, reply) => {
    try {
      const { key } = request.params as { key: string };
      const body = request.body as { model?: string | null; thinkingLevel?: string | null };
      await deps.service.updateSessionSettings(authenticatedActor(request as any), key, {
        model: body.model,
        thinkingLevel: body.thinkingLevel,
      });
      return reply.send({ ok: true });
    } catch (error) {
      if (isNotFound(error)) {
        return reply.code(404).send({ ok: false, error: 'Session not found' });
      }
      return reply.code(500).send({ error: `更新会话设置失败：${String((error as Error).message)}` });
    }
  });

  fastify.delete('/api/sessions/:key', { preHandler }, async (request, reply) => {
    try {
      const { key } = request.params as { key: string };
      const deleted = await deps.service.deleteSession(authenticatedActor(request as any), key);
      return reply.send({ ok: deleted });
    } catch (error) {
      if (isNotFound(error)) {
        return reply.code(404).send({ ok: false, error: 'Session not found' });
      }
      return reply.code(500).send({ error: `删除会话失败：${String((error as Error).message)}` });
    }
  });

  fastify.post('/api/sessions/:key/cap', { preHandler }, async (request, reply) => {
    try {
      const { key } = request.params as { key: string };
      const { maxMessages } = request.body as { maxMessages?: unknown };
      const parsedMaxMessages = parseBoundedPositiveInteger(maxMessages, MAX_SESSION_MESSAGES);
      if (parsedMaxMessages === null) {
        return reply.code(400).send({ ok: false, error: `maxMessages must be a positive integer up to ${MAX_SESSION_MESSAGES}` });
      }
      const deleted = await deps.service.enforceMessageCap(
        authenticatedActor(request as any),
        key,
        parsedMaxMessages,
      );
      return reply.send({ ok: true, deleted });
    } catch (error) {
      if (isNotFound(error)) {
        return reply.code(404).send({ ok: false, error: 'Session not found' });
      }
      return reply.code(500).send({ error: `限制消息数量失败：${String((error as Error).message)}` });
    }
  });
}

function formatMessageContent(rawContent: string): { content: unknown } {
  const match = /<think>([\s\S]*?)<\/think>/.exec(rawContent);
  if (!match) return { content: rawContent };
  const thinking = match[1].trim();
  const text = rawContent.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
  return { content: [{ type: 'thinking', thinking }, { type: 'text', text }] };
}
