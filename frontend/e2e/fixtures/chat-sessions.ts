import { LitElement } from 'lit';
import '../../src/app/styles.css';
import { SlideApp } from '../../src/app/ui/app.ts';
import { apiClient } from '../../src/api/index.ts';
import { DirectGatewayClient, handleDirectAdapterEvent } from '../../src/app/ui/direct-gateway.ts';
import { switchChatSession } from '../../src/app/ui/app-render.helpers.ts';

// Real rendering, controllers and WS client; only startup/remote services are controlled.
class ChatSessionsFixture extends SlideApp {
  connectedCallback() { LitElement.prototype.connectedCallback.call(this); }
}
customElements.define('chat-sessions-fixture', ChatSessionsFixture);
apiClient.setToken('session-fixture');
const app = new ChatSessionsFixture();
app.sessionKey = '';
app.settings = { ...app.settings, navCollapsed: true, chatFocusMode: false, username: 'fixture' };
app.userPermissions = new Set(['chat:read', 'chat:write']);
app.style.cssText = 'display:block;height:100vh;';
app.onSlashAction = action => {
  if (action.startsWith('switch-session:')) switchChatSession(app as any, action.slice('switch-session:'.length));
};
const client = new DirectGatewayClient({
  url: 'ws://127.0.0.1:5186/session-fixture',
  onEvent: event => handleDirectAdapterEvent(app as any, event),
  onStateChange: state => { app.connected = state === 'connected'; },
});
app.client = client;
document.body.style.margin = '0';
document.body.append(app);
client.connect();
(window as any).sessionsFixture = { app, client, switch: (key: string) => switchChatSession(app as any, key) };
