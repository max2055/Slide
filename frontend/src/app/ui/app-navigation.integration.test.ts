import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'lit';

const loaded = vi.hoisted(() => ({ dashboard: vi.fn(), agents: vi.fn(), sessions: vi.fn() }));
vi.mock('./views/dashboard.ts', () => { loaded.dashboard(); return {}; });
vi.mock('./views/agents.ts', () => { loaded.agents(); return {}; });
vi.mock('./views/sessions.ts', () => { loaded.sessions(); return {}; });
import { renderApp } from './app-render.ts';

const container = document.createElement('div');
afterEach(() => render(null, container));
it('keeps heavy views deferred and filters visible navigation by permissions', async () => {
  const host = {
    connected: true, tab: 'feedback', sessionKey: '', basePath: '',
    settings: { navGroupsCollapsed: {}, theme: 'claw', themeMode: 'system' },
    userPermissions: new Set(['servers:view']), paletteOpen: false,
    agentsList: null, chatQueue: [], requestUpdate: vi.fn(),
  } as any;
  render(renderApp(host), container);
  expect(container.querySelector('a[href="/dashboard"]')).not.toBeNull();
  expect(container.querySelector('a[href="/audit"]')).toBeNull();
  expect(loaded.dashboard).not.toHaveBeenCalled();
  expect(loaded.agents).not.toHaveBeenCalled();
  expect(loaded.sessions).not.toHaveBeenCalled();
  host.userPermissions = new Set(['audit:view']);
  render(renderApp(host), container);
  expect(container.querySelector('a[href="/audit"]')).not.toBeNull();
  expect(container.querySelector('a[href="/dashboard"]')).toBeNull();
  host.tab = 'dashboard';
  renderApp(host);
  await vi.waitFor(() => expect(loaded.dashboard).toHaveBeenCalledOnce());
  renderApp(host);
  expect(loaded.dashboard).toHaveBeenCalledOnce();
  expect(loaded.agents).not.toHaveBeenCalled();
  expect(loaded.sessions).not.toHaveBeenCalled();
});
