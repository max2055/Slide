import { render } from 'lit';
import '../../src/app/styles.css';
import { renderLoginGate } from '../../src/app/ui/views/login-gate.ts';

// The product login view and API client run unchanged. Only the reactive host
// and post-login navigation are supplied by this streaming test shell.
const root = document.querySelector('#fixture')!;
const state: any = {
  settings: { username: '' }, password: '', basePath: '', lastError: null,
  applySettings(settings: unknown) { state.settings = settings; update(); },
  setPassword(password: string) { state.password = password; update(); },
  requestUpdate: () => update(),
  connect() { root.setAttribute('data-authenticated', 'true'); },
};
function update() { render(renderLoginGate(state), root); }
update();
