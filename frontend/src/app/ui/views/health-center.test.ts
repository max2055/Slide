import { afterEach, describe, expect, it, vi } from 'vitest';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));

import './health-center.js';

const overview = {
  timestamp: '2026-08-06T00:00:00.000Z',
  summary: { pass: 1, warn: 0, fail: 0, deferred: 0, total: 1 },
  checks: [{ id: 'ok', label: '正常检查', category: 'instance', status: 'pass', severity: 'info', summary: '正常' }],
  readiness: { db_connected: true, db_reachable: true, llm_provider: true, cron_running: true, agent_engine: true },
  truth: {
    controlPlane: { status: 'healthy', numerator: 1, denominator: 1, failedRefs: [] },
    managedAvailability: { status: 'critical', numerator: 0, denominator: 2, failedRefs: [{ type: 'instance', id: 7 }, { type: 'server', id: 9 }] },
    dataFreshness: { status: 'healthy', numerator: 2, denominator: 2, failedRefs: [] },
    workflow: { status: 'healthy', numerator: 1, denominator: 1, failedRefs: [] },
    overall: 'critical',
  },
};

describe('system health and consistency page', () => {
  afterEach(() => {
    authFetch.mockReset();
    document.body.replaceChildren();
  });

  async function renderPage() {
    authFetch.mockResolvedValue({ ok: true, json: async () => overview });
    const element = document.createElement('health-center-page') as HTMLElement & { updateComplete: Promise<unknown> };
    document.body.append(element);
    await element.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await element.updateComplete;
    return element;
  }

  it('loads one merged overview and collapses normal checks by default', async () => {
    const element = await renderPage();
    expect(authFetch).toHaveBeenCalledWith('/api/health/overview');
    expect(element.shadowRoot?.textContent).toContain('系统健康与一致性');
    expect(element.shadowRoot?.textContent).toContain('显示正常检查（1）');
    expect(element.shadowRoot?.querySelector('.check-table')).toBeNull();
  });

  it('navigates severe instance and server references to their detail pages', async () => {
    const element = await renderPage();
    const events: Array<Record<string, unknown>> = [];
    const listener = (event: Event) => events.push((event as CustomEvent).detail);
    window.addEventListener('slide-navigate', listener);

    const links = Array.from(element.shadowRoot?.querySelectorAll<HTMLButtonElement>('.resource-link') ?? []);
    links[0]?.click();
    links[1]?.click();

    window.removeEventListener('slide-navigate', listener);
    expect(events).toEqual([
      { tab: 'instance-detail', id: 7 },
      { tab: 'server-detail', serverId: 9 },
    ]);
  });
});
