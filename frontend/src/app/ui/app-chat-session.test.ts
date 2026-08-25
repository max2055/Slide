import { describe, expect, it, vi } from 'vitest';
import { handleSendChat } from './app-chat.ts';
import { resolveSidebarChatSessionKey, switchChatSession } from './app-render.helpers.ts';

describe('server-owned chat session workflow', () => {
  it('/new switches to an empty pending session instead of generating a client key', async () => {
    const onSlashAction = vi.fn();
    const host = {
      client: null,
      connected: true,
      chatMessage: '',
      chatAttachments: [],
      chatMessages: [],
      chatQueue: [],
      chatRunId: null,
      chatSending: false,
      chatStream: null,
      sessionKey: 'old-session',
      refreshSessionsAfterChat: new Set<string>(),
      onSlashAction,
    };

    await handleSendChat(host as any, '/new');

    expect(onSlashAction).toHaveBeenCalledWith('switch-session:');
    expect(onSlashAction.mock.calls[0][0]).not.toMatch(/chat_|ui_|diagnosis-analysis/);
  });

  it('does not request history or watch while the new session key is pending', () => {
    const watchSession = vi.fn();
    const request = vi.fn();
    const state = {
      client: { watchSession, request },
      connected: false,
      sessionKey: 'old-session',
      chatMessage: '',
      chatAttachments: [],
      chatMessages: [],
      chatToolMessages: [],
      chatStreamSegments: [],
      chatThinkingLevel: null,
      chatStream: null,
      chatSideResult: null,
      lastError: null,
      compactionStatus: null,
      fallbackStatus: null,
      chatAvatarUrl: null,
      chatQueue: [],
      chatRunId: null,
      settings: { sessionKey: 'old-session', lastActiveSessionKey: 'old-session' },
      applySettings: vi.fn(),
      resetToolStream: vi.fn(),
      resetChatScroll: vi.fn(),
      chatSideResultTerminalRuns: new Set<string>(),
      basePath: '',
      hello: null,
    };

    switchChatSession(state as any, '');

    expect(state.sessionKey).toBe('');
    expect(watchSession).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps the chat session empty when no server-owned session is available', () => {
    const state = {
      hello: { snapshot: { sessionDefaults: { mainKey: 'main' } } },
      sessionsResult: { sessions: [], defaults: {} },
    };

    expect(resolveSidebarChatSessionKey(state as any)).toBe('');
  });
});
