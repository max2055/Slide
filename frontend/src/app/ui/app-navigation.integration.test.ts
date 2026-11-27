import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'lit';

const loaded = vi.hoisted(() => ({ dashboard: vi.fn(), agents: vi.fn(), sessions: vi.fn() }));
vi.mock('./views/dashboard.ts', () => { loaded.dashboard(); return {}; });
vi.mock('./views/agents.ts', () => { loaded.agents(); return {}; });
vi.mock('./views/sessions.ts', () => { loaded.sessions(); return {}; });
import { renderApp } from './app-render.ts';

const container = document.createElement('div');
afterEach(() => { render(null, container); vi.unstubAllGlobals(); });
it('keeps heavy views deferred and filters visible navigation by permissions', async () => {
  const host = {
    connected: true, tab: 'feedback', sessionKey: '', basePath: '',
    settings: { navGroupsCollapsed: {}, theme: 'claw', themeMode: 'system' },
    userPermissions: new Set(['servers:view']), paletteOpen: false,
    agentsList: null, chatQueue: [], requestUpdate: vi.fn(),
  } as any;
  render(renderApp(host), container);
  expect(container.querySelector('a[href="/attention"]')).toBeNull();
  expect(container.querySelector('a[href="/audit"]')).toBeNull();
  expect(loaded.dashboard).not.toHaveBeenCalled();
  expect(loaded.agents).not.toHaveBeenCalled();
  expect(loaded.sessions).not.toHaveBeenCalled();
  host.userPermissions = new Set(['audit:view']);
  render(renderApp(host), container);
  expect(container.querySelector('a[href="/audit"]')).not.toBeNull();
  expect(container.querySelector('a[href="/workbench"]')).toBeNull();
  host.userPermissions = new Set(['view_dashboard']);
  host.tab = 'dashboard';
  render(renderApp(host), container);
  expect(container.querySelector('a[href="/dashboard"].nav-item--active')).not.toBeNull();
  await vi.waitFor(() => expect(loaded.dashboard).toHaveBeenCalledOnce());
  renderApp(host);
  expect(loaded.dashboard).toHaveBeenCalledOnce();
  expect(loaded.agents).not.toHaveBeenCalled();
  expect(loaded.sessions).not.toHaveBeenCalled();
});

it('preserves the business view and its draft when the navigation crosses a breakpoint', () => {
  let mobile = false;
  vi.stubGlobal('matchMedia', () => ({ matches: mobile }));
  const host = {
    connected: true, tab: 'feedback', sessionKey: '', basePath: '',
    settings: { navGroupsCollapsed: {}, theme: 'claw', themeMode: 'system' },
    userPermissions: new Set(['servers:view']), paletteOpen: false,
    agentsList: null, chatQueue: [], requestUpdate: vi.fn(),
  } as any;
  render(renderApp(host), container);
  const content = container.querySelector('main.content');
  const view = container.querySelector('feedback-page');
  expect(view).not.toBeNull();
  const draft = document.createElement('textarea');
  draft.value = '尚未提交的内容';
  view!.append(draft);
  for (const matches of [true, false, true]) {
    mobile = matches;
    render(renderApp(host), container);
    expect(container.querySelector('main.content')).toBe(content);
    expect(container.querySelector('feedback-page')).toBe(view);
    expect(view!.querySelector('textarea')?.value).toBe('尚未提交的内容');
  }
});

it('applies the menu permission to direct bookmarks and unmounts an open page when access is withdrawn', () => {
  const host = {
    connected: true, tab: 'reports', sessionKey: '', basePath: '',
    settings: { navGroupsCollapsed: {}, theme: 'claw', themeMode: 'system' },
    userPermissions: new Set<string>(), paletteOpen: false, agentsList: null, chatQueue: [],
  } as any;
  render(renderApp(host), container);
  expect(container.querySelector('reports-page')).toBeNull();
  expect(container.querySelector('app-empty-state')?.getAttribute('title')).toBe('当前账号无权访问此页面');

  host.userPermissions = new Set(['report:view']);
  host.settings.visibleTabs = ['feedback'];
  render(renderApp(host), container);
  expect(container.querySelector('a[href="/reports"]')).toBeNull();
  expect(container.querySelector('reports-page')).not.toBeNull();

  host.userPermissions = new Set<string>();
  render(renderApp(host), container);
  expect(container.querySelector('reports-page')).toBeNull();
});
