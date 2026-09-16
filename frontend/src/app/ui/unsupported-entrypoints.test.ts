import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleSendChat } from './app-chat.ts';
import { loadOverview } from './app-settings.ts';
import { DirectGatewayClient } from './direct-gateway.ts';
import { parseSlashCommand, refreshSlashCommands, resetSlashCommandsForTest, SLASH_COMMANDS } from './chat/slash-commands.ts';

vi.mock('./app-scroll.ts', () => ({ scheduleChatScroll: vi.fn(), resetChatScroll: vi.fn() }));

afterEach(() => {
  resetSlashCommandsForTest();
  vi.restoreAllMocks();
});

describe('DirectAdapter unsupported entrypoints', () => {
  it.each([null, 'active-run'])('/clear preserves history and session, including during run %s', async (runId) => {
    const request = vi.fn().mockResolvedValue({ messages: [] });
    const messages = [{ role: 'user', content: 'keep this history' }];
    const onSlashAction = vi.fn();
    const host = {
      client: { request }, connected: true, sessionKey: 'existing-session',
      chatMessage: '/clear', chatAttachments: [], chatMessages: messages,
      chatQueue: [], chatRunId: runId, chatSending: false, chatStream: 'keep stream',
      chatSideResult: { content: 'keep result' }, lastError: null,
      refreshSessionsAfterChat: new Set<string>(), onSlashAction,
    };

    await handleSendChat(host as any);

    expect(host.lastError).toContain('不支持清空历史');
    expect(request).not.toHaveBeenCalled();
    expect(onSlashAction).not.toHaveBeenCalled();
    expect(host.sessionKey).toBe('existing-session');
    expect(host.chatMessages).toBe(messages);
    expect(host.chatRunId).toBe(runId);
    expect(host.chatStream).toBe('keep stream');
    expect(host.chatSideResult).toEqual({ content: 'keep result' });
    expect(host.chatQueue).toEqual([]);
  });

  it('marks /clear unavailable in the command menu', () => {
    expect(parseSlashCommand('/clear')?.command.description).toContain('不支持');
  });

  it('does not request an unavailable log stream or retain stale log lines', async () => {
    const request = vi.fn().mockResolvedValue({ sessions: [] });
    const host = {
      client: { request }, connected: true, sessionsLoading: false,
      overviewLogLines: ['old gateway log'], overviewLogCursor: 42,
      lastError: null, hello: null, attentionItems: [],
    };
    await loadOverview(host as any);
    expect(request.mock.calls.some(([method]) => method === 'logs.tail')).toBe(false);
    expect(host.overviewLogLines).toEqual([]);
    expect(host.overviewLogCursor).toBe(0);
  });

  it.each(['not supported', '403 Forbidden', 'network failure'])('retains local commands after remote catalog failure: %s', async (reason) => {
    const request = vi.fn().mockRejectedValue(new Error(reason));
    await refreshSlashCommands({ client: { request } as any });
    expect(SLASH_COMMANDS.some(command => command.name === 'new')).toBe(true);
    expect(SLASH_COMMANDS.some(command => command.name === 'clear')).toBe(true);
  });

  it.each(['sessions.reset', 'plugin.approval.resolve', 'exec.approval.resolve', 'commands.list', 'logs.tail'])('rejects unsupported %s without network side effects', async (method) => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const client = new DirectGatewayClient({ onEvent: vi.fn(), onStateChange: vi.fn() });
    await expect(client.request(method, { id: 'test', decision: 'allow-always' })).rejects.toThrow('not supported');
    expect(fetch).not.toHaveBeenCalled();
  });
});
