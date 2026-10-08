import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'lit';
import { renderChat, type ChatProps } from './chat.ts';
import { renderLoginGate } from './login-gate.ts';
import { apiClient } from '../../../api/index.ts';
import * as toast from '../components/app-toast-container.ts';

vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
const noop = () => {};
function props(error: string): ChatProps {
  return { sessionKey: 'one', onSessionKeyChange: noop, thinkingLevel: null, showThinking: false, showToolCalls: true,
    loading: false, sending: false, messages: [], toolMessages: [], streamSegments: [], stream: null, streamStartedAt: null,
    draft: '', queue: [], connected: true, canSend: true, disabledReason: error, error, lastError: error,
    sessions: null, focusMode: false, assistantName: 'Slide', assistantAvatar: null,
    onRefresh: noop, onToggleFocusMode: noop, onDraftChange: noop, onSend: noop, onQueueRemove: noop,
    onNewSession: noop, agentsList: null, currentAgentId: 'main', onAgentChange: noop };
}
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
describe('single actionable notice', () => {
  it.each(['余额不足，请充值后重试', '模型 API 认证失败，请检查 API Key 和提供商配置',
    '请求被限流，请稍后重试', '模型响应 timeout，请重试', '网络中断，请检查网络', '服务重启，请稍后重试'])
  ('preserves exactly one copy of %s', error => {
    const root = document.createElement('div'); document.body.append(root);
    render(renderChat(props(error)), root);
    expect(root.textContent?.split(error).length).toBe(2);
    expect(root.textContent).not.toContain('AI 服务暂时不可用');
  });
  it('shows recovery as warning without hiding an independent run error', () => {
    const root = document.createElement('div'); document.body.append(root);
    render(renderChat({ ...props('余额不足'), disabledReason: null,
      recoveryNotice: '恢复快照仅保留本轮尾部' } as ChatProps), root);
    expect(root.querySelector('app-notice[severity="warning"]')?.textContent).toBe('恢复快照仅保留本轮尾部');
    expect(root.textContent?.split('余额不足').length).toBe(2);
  });
  it('login network failure uses the form only', async () => {
    vi.spyOn(apiClient, 'directLogin').mockRejectedValue(new Error('offline'));
    const notify = vi.spyOn(toast, 'showToast');
    const state = { settings: { username: 'fixture' }, password: 'fixture', lastError: null, connect: vi.fn() };
    const root = document.createElement('div'); document.body.append(root);
    render(renderLoginGate(state as any), root);
    root.querySelector<HTMLButtonElement>('.login-gate__connect')!.click();
    await vi.waitFor(() => expect(state.lastError).toContain('无法连接服务器'));
    render(renderLoginGate(state as any), root);
    expect(root.textContent?.split(state.lastError!).length).toBe(2);
    expect(notify).not.toHaveBeenCalled();
    expect(state.connect).not.toHaveBeenCalled();
  });
});
