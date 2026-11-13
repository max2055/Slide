import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from 'lit';
import { renderChat, clearChatViewCaches } from './chat.ts';
import * as api from '../../../api/index.ts';

const noop = () => {};
const props: any = { sessionKey: 'one', thinkingLevel: null, messages: [], toolMessages: [], streamSegments: [], stream: null,
  draft: '', queue: [], connected: true, canSend: true, sessions: null, assistantName: 'Slide', assistantAvatar: null,
  onSessionKeyChange: noop, onRefresh: noop, onToggleFocusMode: noop, onDraftChange: noop, onSend: noop,
  onQueueRemove: noop, onNewSession: noop, onAgentChange: noop, currentAgentId: 'main', onRequestUpdate: noop };
afterEach(() => { clearChatViewCaches(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
beforeEach(() => {
  clearChatViewCaches();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  vi.spyOn(api.apiClient, 'getToken').mockReturnValue('one');
});

// GitHub #652: completion-triggered renders must not restart cosmetic requests.
it.each([
  ['HTTP failure', () => Promise.resolve(new Response('{}', { status: 503 }))],
  ['network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
  ['empty greeting', () => Promise.resolve(new Response('{"greeting":""}'))],
  ['missing greeting', () => Promise.resolve(new Response('{}'))],
  ['empty body', () => Promise.resolve(new Response(null, { status: 204 }))],
  ['invalid JSON', () => Promise.resolve(new Response('{'))],
])('stops after %s and keeps welcome actions usable', async (_label, respond) => {
  const fetch = vi.spyOn(api, 'authFetch').mockImplementation(respond);
  const updated = vi.fn();
  const onDraftChange = vi.fn();
  const onSend = vi.fn();
  const root = document.createElement('div');
  const currentProps = { ...props, onRequestUpdate: updated, onDraftChange, onSend };
  const update = () => render(renderChat(currentProps), root);
  update();
  await vi.waitFor(() => expect(updated).toHaveBeenCalledOnce());
  for (let index = 0; index < 5; index++) update();
  expect(fetch).toHaveBeenCalledOnce();
  expect(root.textContent).toContain('Ready to chat');
  root.querySelector<HTMLButtonElement>('.agent-chat__suggestion')!.click();
  expect(onDraftChange).toHaveBeenCalledWith('查看实例运行状态');
  expect(onSend).toHaveBeenCalledOnce();
  const input = root.querySelector<HTMLTextAreaElement>('textarea')!;
  input.value = '继续提问';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  expect(onDraftChange).toHaveBeenLastCalledWith('继续提问');
  // A new identity gets its own attempt even after the previous identity failed.
  vi.mocked(api.apiClient.getToken).mockReturnValue('two');
  update();
  await vi.waitFor(() => expect(updated).toHaveBeenCalledTimes(2));
  update();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('deduplicates pending and successful requests across renders and sessions', async () => {
  let release!: (value: Response) => void;
  const fetch = vi.spyOn(api, 'authFetch').mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const updated = vi.fn();
  const root = document.createElement('div');
  const update = (sessionKey = 'one') => render(renderChat({ ...props, sessionKey, onRequestUpdate: updated }), root);
  update(); update(); update('another');
  expect(fetch).toHaveBeenCalledOnce();
  release(new Response('{"greeting":"欢迎回来"}'));
  await vi.waitFor(() => expect(updated).toHaveBeenCalledOnce());
  update(); update('another');
  expect(root.textContent).toContain('欢迎回来');
  expect(fetch).toHaveBeenCalledOnce();
  clearChatViewCaches();
  update();
  expect(fetch).toHaveBeenCalledTimes(2);
  release(new Response('{}'));
  await vi.waitFor(() => expect(updated).toHaveBeenCalledTimes(2));
});

it('an old completion cannot unlock a pending request for the next identity', async () => {
  const releases: Array<(value: Response) => void> = [];
  const fetch = vi.spyOn(api, 'authFetch').mockImplementation(() => new Promise(resolve => releases.push(resolve)));
  const updated = vi.fn();
  const root = document.createElement('div');
  const update = () => render(renderChat({ ...props, onRequestUpdate: updated }), root);
  update();
  vi.mocked(api.apiClient.getToken).mockReturnValue('two');
  update();
  releases[0](new Response('{"greeting":"private previous greeting"}'));
  await vi.waitFor(() => expect(updated).toHaveBeenCalledOnce());
  update(); update();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(root.textContent).not.toContain('private previous greeting');
  releases[1](new Response('{}', { status: 503 }));
  await vi.waitFor(() => expect(updated).toHaveBeenCalledTimes(2));
  update(); update();
  expect(fetch).toHaveBeenCalledTimes(2);
});

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
