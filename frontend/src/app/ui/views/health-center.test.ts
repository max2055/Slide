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
    authFetch.mockImplementation(async (url: string) => url === '/api/platform/observations'
      ? { ok: false, status: 503 }
      : { ok: true, json: async () => overview });
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
    expect(element.shadowRoot?.querySelector('h1')?.textContent).toBe('平台自检');
    expect(element.shadowRoot?.textContent).toContain('显示正常检查（1）');
    expect(element.shadowRoot?.querySelector('.check-table')).toBeNull();
  });

  it('keeps the last server check timestamp through a failed refresh and retries the same check', async () => {
    const element = await renderPage();
    const root = element.shadowRoot!;
    const readTimes = () => Array.from(root.querySelectorAll('time'), (time) => time.dateTime);
    const refresh = root.querySelector<HTMLButtonElement>('.refresh-btn')!;
    expect(readTimes()[0]).not.toBe(overview.timestamp);
    expect(readTimes()[1]).toBe(overview.timestamp);

    authFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    refresh.click();
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toContain('HTTP 503'));
    expect(readTimes()).toHaveLength(2);
    expect(readTimes()[1]).toBe(overview.timestamp);
    expect(root.querySelector('.health-bar')).toBeNull();
    expect(refresh.textContent?.trim()).toBe('重试读取');

    const timestamp = '2026-08-06T00:02:00.000Z';
    authFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ...overview, timestamp }) });
    refresh.click();
    await vi.waitFor(() => expect(readTimes()[1]).toBe(timestamp));
    expect(authFetch.mock.calls.slice(1).map(([path]) => path)).toEqual([
      '/api/health/overview?refresh=true', '/api/health/overview?refresh=true',
    ]);
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  it('clears check evidence on authorization loss', async () => {
    const element = await renderPage();
    window.dispatchEvent(new CustomEvent('slide-permissions-loaded', { detail: { permissions: [] } }));
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector('time')).toBeNull();
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

describe('MAX-530 / #718 capacity difference signs', () => {
  it('renders negative, positive, zero and rounded zero without +- or +0', async () => {
    const { render } = await import('lit');
    const el = document.createElement('health-center-page') as any;
    const root = document.createElement('div');
    render(el._renderCapacityDetailTable([95, 105, 100, 99.9, 100.1].map(inst_size => ({ name: 'fixture', inst_size, cap_size: 100 }))), root);
    expect([...root.querySelectorAll('tbody tr td:last-child')].map(td => td.textContent?.trim())).toEqual(['-5%', '+5%', '0%', '0%', '0%']);
    render(el._renderCapacityDetailTable([{ name: 'missing', inst_size: 5, cap_size: 0 }]), root);
    expect(root.querySelector('tbody tr td:last-child')?.textContent?.trim()).toBe('—');
  });
});
