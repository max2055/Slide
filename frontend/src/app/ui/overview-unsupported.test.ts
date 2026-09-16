import { render } from 'lit';
import { expect, it } from 'vitest';
import { SlideApp } from './app.ts';
import { renderApp } from './app-render.ts';
import { tabFromPath } from './navigation.ts';

it('shows an explicit unsupported state for the legacy /overview URL', async () => {
  const app = new SlideApp();
  app.connected = true;
  app.tab = tabFromPath('/overview', '')!;
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
  } finally {
    render(null, container);
    container.remove();
  }
});
