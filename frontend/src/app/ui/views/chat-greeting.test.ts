import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'lit';
import { renderChat, clearChatViewCaches } from './chat.ts';
import * as api from '../../../api/index.ts';

const noop = () => {};
const props: any = { sessionKey: 'one', thinkingLevel: null, messages: [], toolMessages: [], streamSegments: [], stream: null,
  draft: '', queue: [], connected: true, canSend: true, sessions: null, assistantName: 'Slide', assistantAvatar: null,
  onSessionKeyChange: noop, onRefresh: noop, onToggleFocusMode: noop, onDraftChange: noop, onSend: noop,
  onQueueRemove: noop, onNewSession: noop, onAgentChange: noop, currentAgentId: 'main', onRequestUpdate: noop };
afterEach(() => { clearChatViewCaches(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('a late greeting from the prior identity cannot become the current greeting', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  clearChatViewCaches();
  let token = 'one';
  vi.spyOn(api.apiClient, 'getToken').mockImplementation(() => token);
  const releases: Array<(value: Response) => void> = [];
  vi.spyOn(api, 'authFetch').mockImplementation(() => new Promise(resolve => releases.push(resolve)));
  const root = document.createElement('div');
  render(renderChat(props), root);
  token = 'two'; render(renderChat(props), root);
  expect(releases).toHaveLength(2);
  releases[1](new Response(JSON.stringify({ greeting: 'current greeting' }), { status: 200 }));
  await vi.waitFor(() => { render(renderChat(props), root); expect(root.textContent).toContain('current greeting'); });
  releases[0](new Response(JSON.stringify({ greeting: 'private previous greeting' }), { status: 200 }));
  await Promise.resolve(); await Promise.resolve(); render(renderChat(props), root);
  expect(root.textContent).toContain('current greeting'); expect(root.textContent).not.toContain('private previous greeting');
  clearChatViewCaches(); token = 'three'; render(renderChat(props), root);
  expect(root.textContent).not.toContain('current greeting');
  releases[2](new Response('{}', { status: 200 }));
});
