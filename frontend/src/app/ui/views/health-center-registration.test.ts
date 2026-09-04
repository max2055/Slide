import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('health center registration', () => {
  it('loads the custom element from the application entrypoint', () => {
    const appRender = readFileSync(resolve(import.meta.dirname, '../app-render.ts'), 'utf8');
    expect(appRender).toContain('import "./views/health-center.ts";');
  });

  it('renders health as a top-level page and removes it from settings', () => {
    const appRender = readFileSync(resolve(import.meta.dirname, '../app-render.ts'), 'utf8');
    const settingsShell = readFileSync(resolve(import.meta.dirname, 'settings-shell.ts'), 'utf8');
    expect(appRender).toContain('state.tab === "health-center"');
    expect(appRender).toContain('<platform-status-page></platform-status-page>');
    const platformStatus = readFileSync(resolve(import.meta.dirname, 'platform-status.ts'), 'utf8');
    expect(platformStatus).toContain('<health-center-page></health-center-page>');
    expect(platformStatus).toContain('<agent-sandbox-status-page></agent-sandbox-status-page>');
    expect(settingsShell).not.toContain('"health-center"');
    expect(settingsShell).not.toContain('闭环健康');
  });
});
