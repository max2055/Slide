import { LitElement } from 'lit';
import '../../src/app/styles.css';
import { SlideApp } from '../../src/app/ui/app.ts';
import { apiClient } from '../../src/api/index.ts';
import { DirectGatewayClient, handleDirectAdapterEvent } from '../../src/app/ui/direct-gateway.ts';

// Production UI and controllers; the spec owns startup, actor, provider and endpoints.
class ChatInputFixture extends SlideApp {
  connectedCallback() { LitElement.prototype.connectedCallback.call(this); }
}
customElements.define('chat-input-fixture', ChatInputFixture);
const query = new URLSearchParams(location.search);
apiClient.setToken('max627-fixture');
const app = new ChatInputFixture();
app.sessionKey = query.get('session')!;
app.settings = { ...app.settings, navCollapsed: true, locale: 'zh-CN', username: 'MAX627' };
app.userPermissions = new Set(['chat:read', 'chat:write']);
app.style.cssText = 'display:block;height:100vh;';
const client = new DirectGatewayClient({
  url: query.get('ws')!, chatAcceptTimeoutMs: 1500,
  onEvent: event => handleDirectAdapterEvent(app as any, event),
  onStateChange: state => { app.connected = state === 'connected'; },
});
app.client = client;
document.body.style.margin = '0'; document.body.append(app); client.connect();
(window as any).chatInputFixture = { app, client };
