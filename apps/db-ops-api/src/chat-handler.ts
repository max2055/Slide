/**
 * chat-handler.ts — Platform-level Chat RPC handler.
 *
 * Wraps IAgentEngine.chat() with message persistence via chatDatabaseService.
 * Used by platform code that needs to send chat messages and stream responses
 * through the active adapter (DirectAdapter).
 *
 * Architecture:
 *   handleChatSend() → getAgentEngine('chat').chat() → onEvent callbacks
 *   handleChatHistory() → chatDatabaseService.getMessages()
 *
 * The caller is responsible for forwarding ChatEvents to the WebSocket client.
 * DirectAdapter's WS transport manages client connections.
 */

import { chatDatabaseService } from './chat-database-service.js';
import { getAgentEngine } from './adapter/get-agent-engine.js';
import type { ChatEvent, ChatResult } from './adapter/types.js';
import type { ActorContext } from './auth/actor-context.js';

// ── Helpers ──

function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Validate chat.send parameters.
 */
function validateChatParams(params: {
  sessionKey?: string;
  message: string;
}): string | null {
  if (!params.message || params.message.trim().length === 0) {
    return 'message is required';
  }
  if (params.message.length > 50000) {
    return 'message too large (max 50KB)';
  }
  return null;
}

// ── Public API ──

/**
 * Handle chat.send — send a message to a chat session via IAgentEngine.
 *
 * @param params - Session key and message
 * @param onEvent - Optional callback to receive streaming ChatEvents
 * @returns ChatResult with final content and usage
 */
export async function handleChatSend(
  actor: ActorContext,
  params: { sessionKey?: string; message: string },
  onEvent?: (event: ChatEvent) => void,
): Promise<ChatResult & { sessionKey: string }> {
  const validationError = validateChatParams(params);
  if (validationError) {
    throw new Error(validationError);
  }

  const { message } = params;
  const requestedSessionKey = params.sessionKey?.trim();
  const sessionKey = requestedSessionKey
    || (await chatDatabaseService.createSession(actor, { title: '新会话' })).session_id;
  if (requestedSessionKey) {
    await chatDatabaseService.authorizeSession(actor, sessionKey, 'append');
  }
  const userMessageId = generateMessageId();
  const assistantMessageId = generateMessageId();

  // Save user message
  await chatDatabaseService.addMessage(
    actor,
    sessionKey,
    {
      messageId: userMessageId,
      role: 'user',
      content: message,
    },
  );

  // Get agent engine and send message
  const engine = await getAgentEngine();

  const result = await (engine.chat as any)(sessionKey, message, (event: ChatEvent) => {
    // Forward event to caller if provided
    if (onEvent) {
      onEvent(event);
    }
  }, actor) as ChatResult;

  // Save assistant response
  if (result.finalContent) {
    await chatDatabaseService.addMessage(
      actor,
      sessionKey,
      {
        messageId: assistantMessageId,
        role: 'assistant',
        content: result.finalContent,
        metadata: { usage: result.usage },
        parentId: userMessageId,
      },
    );
  }

  return { ...result, sessionKey };
}

/**
 * Handle chat.history — retrieve message history for a session.
 *
 * @param params - Session key and optional limit
 * @returns Array of message records
 */
export async function handleChatHistory(actor: ActorContext, params: {
  sessionKey: string;
  limit?: number;
}): Promise<{ messages: unknown[] }> {
  const { sessionKey, limit = 100 } = params;

  if (!sessionKey || sessionKey.trim().length === 0) {
    throw new Error('sessionKey is required');
  }

  const messages = await chatDatabaseService.getMessages(actor, sessionKey, limit);

  const formattedMessages = messages.map((msg) => ({
    id: msg.message_id,
    role: msg.role,
    content: msg.content,
    timestamp: msg.created_at.toISOString(),
  }));

  return { messages: formattedMessages };
}
