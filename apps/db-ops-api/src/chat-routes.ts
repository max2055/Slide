import { chatAuthorization, ChatForbiddenError, assertChatCredential } from './auth/chat-authorization.js';
import { ActorAuthenticationError } from './auth/actor-context.js';
import { PlatformUnavailableError, platformUnavailableResponse } from './lifecycle/platform-unavailable.js';
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

type ChatModelDefaults = { model?: string; modelProvider?: string };

export interface ChatRouteDependencies {
  verifyToken: preHandlerHookHandler;
  service: ChatRouteService;
  handleChatSend: ChatSendHandler;
  authorizeChat?: typeof chatAuthorization.require;
  getGreeting?: () => string;
  getModelDefaults?: () => Promise<ChatModelDefaults>;
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
const MAX_ACTIVE_MINUTES = 365 * 24 * 60;

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
  const requireChat = deps.authorizeChat ?? (async (actor: ActorContext) => {
    assertChatCredential(actor, true);
    return chatAuthorization.require(actor);
  });
  const reject = (error: unknown, reply: any): boolean => {
    if (error instanceof ChatForbiddenError) reply.code(403).send({ error: '权限不足', code: 'CHAT_FORBIDDEN' });
    else if (error instanceof ActorAuthenticationError) reply.code(401).send({ error: '无效的认证令牌' });
    else if (error instanceof PlatformUnavailableError) reply.code(503).send(platformUnavailableResponse);
    else if (isNotFound(error)) reply.code(404).send({ error: 'Session not found', code: 'CHAT_SESSION_NOT_FOUND' });
    else return false;
    return true;
  };
  const preHandler = [deps.verifyToken, async (request: any, reply: any) => {
    try { await requireChat(authenticatedActor(request)); }
    catch (error) { if (!reject(error, reply)) throw error; await reply; }
  }];
  // Fastify awaits preSerialization before it writes the response body. This
  // includes slow history queries and HTTP sends crossing exp or revocation.
  fastify.addHook('preSerialization', async (request, reply, payload) => {
    if (!['/api/chat/send', '/api/chat/history', '/api/chat/greeting', '/api/sessions', '/api/sessions/:key', '/api/sessions/:key/cap'].includes(request.routeOptions.url ?? '') || reply.statusCode >= 400) return payload;
    try {
      await requireChat(authenticatedActor(request as any));
      const key = (request.query as any)?.sessionKey;
      if (key && typeof deps.service.getSessionMetadata === 'function') await deps.service.getSessionMetadata(authenticatedActor(request as any), key);
      const sessions = (payload as { sessions?: Array<{ key: string }> })?.sessions;
      if (sessions && typeof deps.service.getSessionMetadata === 'function') {
        const visible = [];
        for (const session of sessions) {
          try { await deps.service.getSessionMetadata(authenticatedActor(request as any), session.key); visible.push(session); }
          catch (error) { if (!isNotFound(error)) throw error; }
        }
        return { ...(payload as object), sessions: visible };
      }
      return payload;
    } catch (error) {
      if (error instanceof ChatForbiddenError) { reply.code(403); return { error: '权限不足', code: 'CHAT_FORBIDDEN' }; }
      if (error instanceof ActorAuthenticationError) { reply.code(401); return { error: '无效的认证令牌' }; }
      if (error instanceof PlatformUnavailableError) { reply.code(503); return platformUnavailableResponse; }
      if (isNotFound(error)) { reply.code(404); return { error: 'Session not found', code: 'CHAT_SESSION_NOT_FOUND' }; }
      throw error;
    }
  });

  if (deps.getGreeting) fastify.get('/api/chat/greeting', { preHandler }, async () => ({ greeting: deps.getGreeting!() }));

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
      if (reject(error, reply)) return reply;
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
        ...(message.messageParts ? { messageParts: message.messageParts } : {}),
        timestamp: message.created_at ? new Date(message.created_at).getTime() : Date.now(),
      }));
      return reply.send({
        messages: formatted,
        ...(page ? { nextBefore: page.nextBefore } : {}),
        model: typeof metadata?.model === 'string' ? metadata.model : null,
        thinkingLevel: typeof metadata?.thinkingLevel === 'string' ? metadata.thinkingLevel : null,
      });
    } catch (error) {
      if (reject(error, reply)) return reply;
      return reply.code(500).send({ error: `获取聊天历史失败：${String((error as Error).message)}` });
    }
  });

  fastify.get('/api/sessions', { preHandler }, async (request, reply) => {
    try {
      const { activeMinutes: activeMinutesText } = request.query as { activeMinutes?: string };
      const activeMinutes = activeMinutesText === undefined
        ? undefined
        : parseBoundedPositiveInteger(activeMinutesText, MAX_ACTIVE_MINUTES);
      if (activeMinutes === null) {
        return reply.code(400).send({ error: `activeMinutes must be a positive integer up to ${MAX_ACTIVE_MINUTES}` });
      }
      const sessions = await deps.service.getSessions(authenticatedActor(request as any));
      const now = Date.now();
      const filtered = activeMinutes !== undefined
        ? sessions.filter((session) => {
            const lastMessage = session.last_message_at
              ? new Date(session.last_message_at).getTime()
              : 0;
            return now - lastMessage < activeMinutes * 60 * 1000;
          })
        : sessions;
      let defaults: ChatModelDefaults = {};
      try {
        defaults = await deps.getModelDefaults?.() ?? {};
      } catch {
        request.log.warn({ code: 'CHAT_MODEL_DEFAULTS_UNAVAILABLE' }, 'Chat model defaults unavailable');
      }
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
        defaults,
      });
    } catch (error) {
      if (reject(error, reply)) return reply;
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
      if (reject(error, reply)) return reply;
      return reply.code(500).send({ error: `更新会话设置失败：${String((error as Error).message)}` });
    }
  });

  fastify.delete('/api/sessions/:key', { preHandler }, async (request, reply) => {
    try {
      const { key } = request.params as { key: string };
      const deleted = await deps.service.deleteSession(authenticatedActor(request as any), key);
      return reply.send({ ok: deleted });
    } catch (error) {
      if (reject(error, reply)) return reply;
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
      if (reject(error, reply)) return reply;
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
