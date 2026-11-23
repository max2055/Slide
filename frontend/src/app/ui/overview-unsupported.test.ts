import { render } from 'lit';
import { expect, it, vi } from 'vitest';
import { apiClient } from '../../api/index.ts';
import { SlideApp } from './app.ts';
import { renderApp } from './app-render.ts';
import { tabFromPath } from './navigation.ts';
import type { LegacyRuntimeLogs } from './views/legacy-runtime-logs.ts';

it.each([
  { permissions: ['config:*'], href: '/slide/health?view=observations' },
  { permissions: ['audit:view'], href: null },
])('preserves the legacy /overview URL and respects platform observation access ($href)', async ({ permissions, href }) => {
  let release!: (permissions: string[]) => void;
  const get = vi.spyOn(apiClient, 'get').mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const app = new SlideApp();
  app.connected = true;
  app.basePath = '/slide';
  app.tab = tabFromPath('/slide/overview', app.basePath)!;
  app.userPermissions = new Set(['config:view']);
  app.onboarding = false;
  const container = document.createElement('div');
  document.body.append(container);
  try {
    render(renderApp(app as any), container);
    const legacy = container.querySelector<LegacyRuntimeLogs>('legacy-runtime-logs')!;
    await legacy.updateComplete;
    const section = container.querySelector('[aria-label="旧运行日志入口"]')!;
    expect(section.querySelector('a')).toBeNull();
    expect(section.textContent).toContain('正在确认平台观测权限');
    expect(get).toHaveBeenCalledExactlyOnceWith('/auth/permissions');
    release(permissions);
    await vi.waitFor(() => expect(section.textContent).not.toContain('正在确认平台观测权限'));
    const emptyState = container.querySelector('app-empty-state') as any;
    expect(emptyState).not.toBeNull();
    await emptyState.updateComplete;
    expect(emptyState.textContent).toContain('暂不支持运行日志');
    expect(emptyState.textContent).toContain('当前未提供原始运行日志流');
    expect(section.querySelector('a')?.getAttribute('href') ?? null).toBe(href);
    if (!href) expect(section.textContent).toContain('查看平台观测需要相应权限');
  } finally {
    render(null, container);
    container.remove();
    get.mockRestore();
  }
});
