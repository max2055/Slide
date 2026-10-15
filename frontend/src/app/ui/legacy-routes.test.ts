import { render } from 'lit';
import { afterEach, describe, expect, it } from 'vitest';
import { SlideApp } from './app.ts';
import type { AppViewState } from './app-view-state.ts';
import { renderApp } from './app-render.ts';
import { tabFromPath, titleForTab } from './navigation.ts';

const container = document.createElement('div');
document.body.append(container);
afterEach(() => { render(null, container); localStorage.clear(); });

async function open(path: string, permissions: string[] | null = ['*'], basePath = '') {
  const app = new SlideApp() as unknown as AppViewState;
  app.connected = true;
  app.onboarding = false;
  app.basePath = basePath;
  app.userPermissions = permissions === null ? null : new Set(permissions);
  app.tab = tabFromPath(path, basePath)!;
  render(renderApp(app), container);
  const notice = container.querySelector('[data-legacy-route]');
  for (const state of notice?.querySelectorAll('app-empty-state') ?? []) {
    await (state as any).updateComplete;
  }
  expect(notice, 'legacy route must render main content').not.toBeNull();
  return notice!;
}

describe('retired route compatibility', () => {
  it('uses a translated breadcrumb for the retired config route', () => {
    expect(titleForTab('config')).not.toMatch(/^tabs\./);
  });
  it('explains retired config and offers the settings center', async () => {
    const notice = await open('/config');
    expect(notice?.textContent).toContain('旧版配置页面已停用');
    expect(notice?.querySelector('a')?.getAttribute('href')).toBe('/settings');
  });

  it('does not equate investigation usage with all model calls', async () => {
    const notice = await open('/llm-usage');
    expect(notice?.textContent).toContain('旧版 LLM 用量页面已停用');
    expect(notice?.textContent).toContain('不代表全部模型调用');
    expect(notice?.querySelector('a')?.getAttribute('href')).toBe('/settings/ai/usage');
  });

  it.each([[], ['llm:view'], ['ai:view'], ['config:manage']].map(permissions => ({ permissions })))(
    'explains missing usage access without an inaccessible action (%j)', async ({ permissions }) => {
      const notice = await open('/llm-usage', permissions);
      expect(notice?.textContent).toContain('当前账号无权访问调查用量与成本');
      expect(notice?.querySelector('a')).toBeNull();
    },
  );

  it.each([['ai:view', 'config:manage'], ['admin:*']].map(permissions => ({ permissions })))(
    'uses the current usage permission contract (%j)', async ({ permissions }) => {
      expect((await open('/llm-usage', permissions)).querySelector('a')).not.toBeNull();
    },
  );

  it('keeps unknown permissions distinct from denial', async () => {
    const notice = await open('/llm-usage', null);
    expect(notice?.textContent).toContain('正在确认访问权限');
    expect(notice?.querySelector('a')).toBeNull();
  });

  it('retains a deployment base path for keyboard-accessible links', async () => {
    const notice = await open('/slide/llm-usage/', ['*'], '/slide');
    expect(notice?.querySelector('a')?.getAttribute('href')).toBe('/slide/settings/ai/usage');
  });
});
