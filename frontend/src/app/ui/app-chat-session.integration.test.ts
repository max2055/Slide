import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'lit';
import { renderChatSessionSelect, resolveSessionOptionGroups } from './app-render.helpers.ts';
import { renderChatAgentSelect, renderChatSessionSelect as renderControllerSelect } from './chat/session-controls.ts';
import { resolveSessionOptionGroups as pureGroups } from './session-presentation.ts';

vi.mock('./app-chat.ts', () => ({ refreshChat: vi.fn(), refreshChatAvatar: vi.fn() }));
vi.mock('./chat/slash-commands.ts', () => ({ refreshSlashCommands: vi.fn() }));
vi.mock('./controllers/chat.ts', () => ({ loadChatHistory: vi.fn() }));
vi.mock('./controllers/sessions.ts', () => ({ loadSessions: vi.fn() }));
import { loadChatHistory } from './controllers/chat.ts';

const containers: HTMLElement[] = [];
function mount(template: unknown) {
  const container = document.createElement('div');
  containers.push(container);
  document.body.append(container);
  render(template, container);
  return container;
}
function state() {
  return {
    connected: true, sessionKey: 'agent:a:x', basePath: '', tab: 'chat',
    client: { watchSession: vi.fn() },
    sessionsResult: { sessions: [
      { key: 'agent:a:x', label: '第一会话' }, { key: 'agent:a:y', label: '第二会话' },
      { key: 'agent:b:z', label: 'Other' }, { key: 'cron:hidden' },
    ], defaults: {} },
    agentsList: { defaultId: 'a', agents: [{ id: 'a' }, { id: 'b' }] },
    settings: {}, chatModelOverrides: {}, chatModelCatalog: [], chatStream: null,
    chatMessages: ['old'], chatAttachments: ['old'], chatQueue: ['old'],
    chatSideResultTerminalRuns: new Set(['old']), resetToolStream: vi.fn(),
    resetChatScroll: vi.fn(), applySettings: vi.fn(),
  } as any;
}
afterEach(() => {
  containers.splice(0).forEach(container => { render(null, container); container.remove(); });
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('session presentation integration', () => {
  it('preserves the original helper export identity', () => expect(resolveSessionOptionGroups).toBe(pureGroups));

  it('renders grouped labels and switches through the actual helper change handler', () => {
    const host = state();
    const container = mount(renderChatSessionSelect(host));
    const select = container.querySelector('.chat-controls__session-row > .chat-controls__session:not(.chat-controls__agent) select') as HTMLSelectElement;
    expect(Array.from(select.options).map(o => o.textContent?.trim())).toEqual(['第一会话', '第二会话', 'Other']);
    expect(select.value).toBe('agent:a:x');
    select.dispatchEvent(new Event('change'));
    expect(host.client.watchSession).not.toHaveBeenCalled();
    select.value = 'agent:a:y';
    select.dispatchEvent(new Event('change'));
    expect(host.sessionKey).toBe('agent:a:y');
    expect(host.client.watchSession).toHaveBeenCalledWith('agent:a:y');
    expect(loadChatHistory).toHaveBeenCalledWith(host);
    expect(new URL(window.location.href).searchParams.get('session')).toBe('agent:a:y');
    expect(host.chatMessages).toEqual([]);
    expect(host.chatAttachments).toEqual([]);
    expect(host.chatQueue).toEqual([]);
    expect(host.chatSideResultTerminalRuns.size).toBe(0);
    expect(host.resetChatScroll).toHaveBeenCalledOnce();
  });

  it('retains the controller selector agent filtering and callback behavior', () => {
    const host = state();
    const onSwitch = vi.fn();
    const container = mount(renderControllerSelect(host, onSwitch));
    const select = container.querySelector('[data-chat-session-select]') as HTMLSelectElement;
    expect(Array.from(select.options).map(o => o.value)).toEqual(['agent:a:x', 'agent:a:y']);
    expect(select.getAttribute('aria-label')).toBeTruthy();
    select.value = 'agent:a:y';
    select.dispatchEvent(new Event('change'));
    expect(onSwitch).toHaveBeenCalledWith(host, 'agent:a:y');
  });

  it('switches agents to their existing preferred session and disables disconnected selectors', () => {
    const host = state();
    const onSwitch = vi.fn();
    const container = mount(renderChatAgentSelect(host, onSwitch));
    const select = container.querySelector('select')!;
    select.value = 'b';
    select.dispatchEvent(new Event('change'));
    expect(onSwitch).toHaveBeenCalledWith(host, 'agent:b:z');
    host.connected = false;
    render(renderChatSessionSelect(host), container);
    expect(Array.from(container.querySelectorAll('select')).every(s => s.disabled)).toBe(true);
  });
});
