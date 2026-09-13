import { render, LitElement } from 'lit';
import '../../src/app/styles.css';
import { renderChat, type ChatProps } from '../../src/app/ui/views/chat.ts';
import { handleChatScroll, resetChatScroll, scheduleChatScroll } from '../../src/app/ui/app-scroll.ts';

const root = document.querySelector<HTMLElement>('#fixture')!;
root.style.cssText = 'height:100vh; max-width:1100px; margin:auto; padding:var(--space-lg); box-sizing:border-box;';
document.body.style.margin = '0';
const messages = Array.from({ length: 520 }, (_, index) => ({
  id: String(index), role: index % 2 ? 'assistant' : 'user', timestamp: 1_700_000_000_000 + index * 1000,
  content: index % 2 ? `第 ${Math.floor(index / 2) + 1} 轮分析结果。\n\n建议检查数据库索引和执行计划，确认查询性能与资源使用情况。\n\nSELECT * FROM instances;` : `第 ${index / 2 + 1} 轮：检查数据库运行状态`,
}));
const noop = () => {};
let queued = false;
function update() { if (!queued) { queued = true; queueMicrotask(() => { queued = false; render(renderChat(props), root); }); } }
const scrollHost = {
  updateComplete: Promise.resolve(), querySelector: (selector: string) => root.querySelector(selector), style: root.style,
  chatScrollFrame: null, chatScrollTimeout: null, chatHasAutoScrolled: true, chatUserNearBottom: true,
  chatNewMessagesBelow: false, logsScrollFrame: null, logsAtBottom: true, topbarObserver: null,
};
const props: ChatProps = {
  sessionKey: 'fixture-one', onSessionKeyChange: noop, thinkingLevel: null, showThinking: false, showToolCalls: true,
  loading: false, sending: false, messages, toolMessages: [], streamSegments: [], stream: null, streamStartedAt: null,
  draft: '', queue: [], connected: true, canSend: true, disabledReason: null, error: null, lastError: null,
  sessions: null, focusMode: false, assistantName: 'Slide Agent', assistantAvatar: null,
  onRefresh: noop, onToggleFocusMode: noop, onDraftChange: noop, onRequestUpdate: update, onSend: noop,
  onQueueRemove: noop, onNewSession: noop, agentsList: null, currentAgentId: 'main', onAgentChange: noop,
  onChatScroll: (event) => { handleChatScroll(scrollHost, event); props.showNewMessages = scrollHost.chatNewMessagesBelow; update(); },
  onScrollToBottom: () => { scrollHost.chatUserNearBottom = true; props.showNewMessages = false; update(); },
};
render(renderChat(props), root);
(window as any).historyFixture = {
  props, update,
  mountShell: async () => {
    const { SlideApp } = await import('../../src/app/ui/app.ts');
    class FixtureShell extends SlideApp {
      connectedCallback() { LitElement.prototype.connectedCallback.call(this); }
      protected updated() {}
    }
    customElements.define('history-fixture-shell', FixtureShell);
    const app = new FixtureShell();
    app.connected = true;
    app.tab = 'chat';
    app.sessionKey = 'shell-session';
    app.chatMessages = props.messages;
    app.style.cssText = 'display:block;height:100%;';
    root.replaceChildren(app);
    await app.updateComplete;
  },
  switchSession: () => { props.sessionKey = 'fixture-two'; props.messages = [{ id: 'new-user', role: 'user', content: '全新会话问题' }]; props.stream = null; update(); },
  send: () => { resetChatScroll(scrollHost); props.messages = [...props.messages, { id: 'sent', role: 'user', content: '新提问' }]; update(); scheduleChatScroll(scrollHost, true); },
  stream: () => { props.stream = '新增流式回复'; update(); scheduleChatScroll(scrollHost, true); },
};
