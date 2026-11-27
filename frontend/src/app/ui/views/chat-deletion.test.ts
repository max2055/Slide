import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from 'lit';
import { renderChat, clearChatViewCaches } from './chat.ts';
import * as api from '../../../api/index.ts';
import { DeletedMessages } from '../chat/deleted-messages.ts';

const noop = () => {};
let root: HTMLDivElement;
let props: any;
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    get length() { return data.size; }, key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  vi.spyOn(api, 'authFetch').mockResolvedValue(new Response('{}', { status: 200 }));
  clearChatViewCaches();
  root = document.createElement('div'); document.body.append(root);
  props = { sessionKey: 'one', thinkingLevel: null, messages: [{ id: 'a', role: 'user', content: '原始消息' }],
    toolMessages: [], streamSegments: [], stream: null, draft: '', queue: [], connected: true, canSend: true,
    sessions: null, assistantName: 'Slide', assistantAvatar: null, onSessionKeyChange: noop, onRefresh: noop,
    onToggleFocusMode: noop, onDraftChange: noop, onSend: noop, onQueueRemove: noop, onNewSession: noop,
    onAgentChange: noop, currentAgentId: 'main', onRequestUpdate: vi.fn(() => render(renderChat(props), root)) };
  render(renderChat(props), root);
});
afterEach(() => { clearChatViewCaches(); root.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const storage = (key: string | null) => window.dispatchEvent(new StorageEvent('storage', { key }));

it('MAX-638 storage events immediately refresh the real message list including restores', () => {
  const button = root.querySelector<HTMLButtonElement>('.chat-group-delete')!;
  button.click(); root.querySelector<HTMLButtonElement>('.chat-delete-confirm__yes')!.click();
  expect(root.querySelectorAll('.chat-group')).toHaveLength(0);
  new DeletedMessages('one').clear(); storage('slide:deleted:one');
  expect(root.querySelectorAll('.chat-group')).toHaveLength(1);
  // Delayed old payload must not resurrect a deletion after the current restore.
  window.dispatchEvent(new StorageEvent('storage', { key: 'slide:deleted:one', newValue: '["stale"]' }));
  expect(root.querySelectorAll('.chat-group')).toHaveLength(1);
});
it('C04 can undo the local hide after another tab hides a different message', () => {
  props.messages.push({ id: 'answer', role: 'assistant', content: '另一条消息' });
  render(renderChat(props), root);
  const buttons = root.querySelectorAll<HTMLButtonElement>('.chat-group-delete');
  buttons[1].click();
  root.querySelector<HTMLButtonElement>('.chat-delete-confirm__yes')!.click();

  // Another tab hides the user message while the local Undo is still displayed.
  const otherTab = new DeletedMessages('one');
  otherTab.delete('group:user:msg:a');
  storage('slide:deleted-message:one:group:user:msg:a');
  expect(root.querySelectorAll('.chat-group')).toHaveLength(0);

  const undo = [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === '撤销');
  expect(undo).toBeDefined();
  undo!.click();
  expect(root.querySelector('.chat-group')?.textContent).toContain('另一条消息');
  expect(root.querySelectorAll('.chat-group')).toHaveLength(1);
  expect(new DeletedMessages('one').has('group:user:msg:a')).toBe(true);
});
it('MAX-638 filters sessions, updates the active callback once, and detaches on cache clear', () => {
  const previous = props.onRequestUpdate;
  props.sessionKey = 'two'; props.onRequestUpdate = vi.fn();
  render(renderChat(props), root); render(renderChat(props), root);
  storage('slide:deleted-message:one:a');
  expect(previous).not.toHaveBeenCalled(); expect(props.onRequestUpdate).not.toHaveBeenCalled();
  storage('slide:deleted-message:two:a');
  expect(props.onRequestUpdate).toHaveBeenCalledTimes(1);
  storage(null); expect(props.onRequestUpdate).toHaveBeenCalledTimes(2);
  clearChatViewCaches(); storage(null);
  expect(props.onRequestUpdate).toHaveBeenCalledTimes(2);
});
