import { markChatRecoveryInterruption } from '../../src/app/ui/chat/recovery-notice.ts';
import { LitElement } from 'lit';
import '../../src/app/styles.css';
import { SlideApp } from '../../src/app/ui/app.ts';
import { apiClient, notifySessionExpired, SESSION_EXPIRED_EVENT } from '../../src/api/index.ts';
import { ChatAcceptanceTimeoutError, handleDirectAdapterEvent } from '../../src/app/ui/direct-gateway.ts';
import { loadChatHistory } from '../../src/app/ui/controllers/chat.ts';
import { switchChatSession } from '../../src/app/ui/app-render.helpers.ts';
import '../../src/app/ui/components/app-toast-container.ts';

// Mount the real render/controller surface, with lifecycle startup and transport
// replaced by deterministic fixtures. No provider or development backend is used.
class NoticeFixture extends SlideApp {
  connectedCallback() {
    LitElement.prototype.connectedCallback.call(this);
    window.addEventListener(SESSION_EXPIRED_EVENT, (this as any).sessionExpiredHandler);
  }
}
customElements.define('notice-fixture', NoticeFixture);
apiClient.setToken('fixture-token');
const app = new NoticeFixture();
app.onSlashAction = action => {
  if (action.startsWith('switch-session:')) switchChatSession(app as any, action.slice('switch-session:'.length));
};
app.connected = true;
app.sessionKey = 'one';
app.settings = { ...app.settings, navCollapsed: true, chatFocusMode: false, username: 'fixture' };
app.userPermissions = new Set(['chat:read', 'chat:write']);
app.style.cssText = 'display:block;height:100vh;';
document.body.style.margin = '0';
document.body.append(app, document.createElement('app-toast-container'));
const client = {
  request: async (method: string) => method === 'chat.history'
    ? { messages: app.chatMessages } : {},
  watchSession() {}, disconnect() {}, reconnect() { app.connected = true; app.connectionError = null; },
};
app.client = client as any;
const stream = { version: 1 as const, streamEpoch: 'epoch', runId: 'run', turnId: 'turn', subscriptionId: 'sub', fromSeq: 1, toSeq: 1 };
const snapshot = { version: 1 as const, runId: 'run', attempt: 1, sequence: 1, phase: 'generating' as const, parts: [] };
(window as any).noticeFixture = {
  app,
  async error(message: string, source = 'run') {
    app.lastError = null; app.connectionError = null; app.chatRecoveryNotice = null;
    if (source === 'connection') { app.connected = false; app.connectionError = message; }
    else if (source === 'cold' || source === 'truncated') {
      if (source === 'cold') { app.chatRunId = 'run'; markChatRecoveryInterruption(app); }
      handleDirectAdapterEvent(app as any, { type: 'stream.snapshot', sessionKey: 'one', stream, snapshot,
        recovery: { truncated: source === 'truncated', cold: source === 'cold' } } as any);
    } else {
      app.chatRunId = 'run';
      handleDirectAdapterEvent(app as any, { type: 'error', runId: 'run', sessionKey: 'one', error: message });
    }
    await app.updateComplete;
  },
  async rejectSend(timeout = false) {
    let calls = 0; let retries = 0;
    (window as any).noticeFixture.sendStats = () => ({ calls, retries });
    const error = timeout ? new ChatAcceptanceTimeoutError('message-1', async () => { retries++; throw error; }, () => 'one')
      : new Error('模型 API 认证失败，请检查 API Key 和提供商配置');
    app.client = { ...client, request: async (method: string) => {
      if (method === 'chat.send') { calls++; throw error; }
      return { messages: app.chatMessages };
    } } as any;
    app.chatMessage = '检查数据库状态';
    await app.handleSendChat();
    await app.updateComplete;
    return { calls, retries };
  },
  async hydrate() {
    handleDirectAdapterEvent(app as any, { type: 'stream.snapshot', sessionKey: app.sessionKey, stream, snapshot,
      recovery: { cold: true, truncated: true } } as any);
    await app.updateComplete;
  },
  async repeatSnapshot() {
    handleDirectAdapterEvent(app as any, { type: 'stream.snapshot', sessionKey: 'one',
      stream: { ...stream, subscriptionId: 'repeat' }, snapshot, recovery: { truncated: true } } as any);
    await app.updateComplete;
  },
  history: (clearNotices = false) => loadChatHistory(app, { clearNotices }),
  switch: () => { switchChatSession(app as any, 'two'); },
  expire: () => { localStorage.setItem('refreshToken', 'fixture-refresh'); notifySessionExpired(); },
  stream: async () => {
    app.chatRunId = 'run'; app.chatSending = true;
    handleDirectAdapterEvent(app as any, { type: 'text_delta', runId: 'run', sessionKey: app.sessionKey, delta: '正常流式回答' });
    handleDirectAdapterEvent(app as any, { type: 'tool_start', runId: 'run', sessionKey: app.sessionKey, toolCallId: 'tool', toolName: 'query', occurredAt: Date.now(), args: {} } as any);
    handleDirectAdapterEvent(app as any, { type: 'tool_result', runId: 'run', sessionKey: app.sessionKey, toolCallId: 'tool', toolName: 'query', occurredAt: Date.now(), result: { rows: 1 } } as any);
    await app.updateComplete;
  },
};
