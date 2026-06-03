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

// ── Helpers ──

function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Validate chat.send parameters.
 */
function validateChatParams(params: {
  sessionKey: string;
  message: string;
}): string | null {
  if (!params.sessionKey || params.sessionKey.trim().length === 0) {
    return 'sessionKey is required';
  }
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
  params: { sessionKey: string; message: string },
  onEvent?: (event: ChatEvent) => void,
): Promise<ChatResult> {
  const validationError = validateChatParams(params);
  if (validationError) {
    throw new Error(validationError);
  }

  const { sessionKey, message } = params;
  const userMessageId = generateMessageId();
  const assistantMessageId = generateMessageId();

  // Save user message
  await chatDatabaseService.addMessage(
    sessionKey,
    userMessageId,
    'user',
    message,
    null,
    null,
    null,
    null,
  );

  // Get agent engine and send message
  const engine = await getAgentEngine('chat');

  const result = await engine.chat(sessionKey, message, (event) => {
    // Forward event to caller if provided
    if (onEvent) {
      onEvent(event);
    }
  });

  // Save assistant response
  if (result.finalContent) {
    await chatDatabaseService.addMessage(
      sessionKey,
      assistantMessageId,
      'assistant',
      result.finalContent,
      null,
      null,
      { usage: result.usage },
      userMessageId,
    );
  }

  return result;
}

/**
 * Handle chat.history — retrieve message history for a session.
 *
 * @param params - Session key and optional limit
 * @returns Array of message records
 */
export async function handleChatHistory(params: {
  sessionKey: string;
  limit?: number;
}): Promise<{ messages: unknown[] }> {
  const { sessionKey, limit = 100 } = params;

  if (!sessionKey || sessionKey.trim().length === 0) {
    throw new Error('sessionKey is required');
  }

  const messages = await chatDatabaseService.getMessages(sessionKey, limit);

  const formattedMessages = messages.map((msg) => ({
    id: msg.message_id,
    role: msg.role,
    content: msg.content,
    timestamp: msg.created_at.toISOString(),
  }));

  return { messages: formattedMessages };
}
