import { render } from 'lit';
import '../../src/app/styles.css';
import { apiClient } from '../../src/api/index.ts';
import { renderChat, type ChatProps } from '../../src/app/ui/views/chat.ts';

// Production welcome/composer rendering and authFetch; synthetic test identities.
apiClient.setToken(new URLSearchParams(location.search).get('identity'));
const root = document.querySelector<HTMLElement>('#fixture')!;
root.style.cssText = 'height:100vh;max-width:1100px;margin:auto;padding:var(--space-lg);box-sizing:border-box';
document.body.style.margin = '0';
let queued = false;
let updates = 0;
const sent: string[] = [];
function update() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; updates++; render(renderChat(props), root); });
}
const noop = () => {};
const props: ChatProps = {
  sessionKey: 'greeting-fixture', onSessionKeyChange: noop, thinkingLevel: null, showThinking: false, showToolCalls: true,
  loading: false, sending: false, messages: [], toolMessages: [], streamSegments: [], stream: null, streamStartedAt: null,
  draft: '', queue: [], connected: true, canSend: true, disabledReason: null, error: null, lastError: null,
  sessions: null, focusMode: false, assistantName: 'Slide', assistantAvatar: null,
  onRefresh: update, onToggleFocusMode: noop, onDraftChange: draft => { props.draft = draft; update(); },
  onRequestUpdate: update, onSend: () => { sent.push(props.draft); props.draft = ''; update(); },
  onQueueRemove: noop, onNewSession: noop, agentsList: null, currentAgentId: 'main', onAgentChange: noop,
};
(window as any).greetingFixture = {
  update, sent, get updates() { return updates; },
  switchIdentity(identity: string) { apiClient.setToken(identity); update(); },
};
update();
