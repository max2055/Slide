import { render } from 'lit';
import { expect, it } from 'vitest';
import { SlideApp } from './app.ts';
import { renderApp } from './app-render.ts';
import { tabFromPath } from './navigation.ts';

it.each([
  { permissions: new Set(['config:*']), href: '/slide/health?view=observations' },
  { permissions: new Set(['audit:view']), href: null },
])('preserves the legacy /overview URL and respects platform observation access ($href)', async ({ permissions, href }) => {
  const app = new SlideApp();
  app.connected = true;
  app.basePath = '/slide';
  app.tab = tabFromPath('/slide/overview', app.basePath)!;
  app.userPermissions = permissions;
  app.onboarding = false;
  const container = document.createElement('div');
  document.body.append(container);
  try {
    render(renderApp(app as any), container);
    const emptyState = container.querySelector('app-empty-state') as any;
    expect(emptyState).not.toBeNull();
    await emptyState.updateComplete;
    expect(emptyState.textContent).toContain('暂不支持运行日志');
    expect(emptyState.textContent).toContain('当前未提供原始运行日志流');
    const section = container.querySelector('[aria-label="旧运行日志入口"]')!;
    expect(section.querySelector('a')?.getAttribute('href') ?? null).toBe(href);
    if (!href) expect(section.textContent).toContain('查看平台观测需要相应权限');
  } finally {
    render(null, container);
    container.remove();
  }
});
