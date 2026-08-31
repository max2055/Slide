import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../api/index.js', () => ({ authFetch }));
vi.mock('../components/metric-chart.js', () => {
  if (!customElements.get('metric-chart')) {
    customElements.define('metric-chart', class extends HTMLElement {});
  }
  return {};
});

import './health-score-tab.js';

const response = (body: unknown, ok = true, status = ok ? 200 : 503) => ({
  ok,
  status,
  json: async () => body,
});

const healthyInstance = {
  id: 7,
  health_status: 'healthy',
  health_score: 100,
  hasCredential: true,
  status: 'active',
};

const healthyChecks = {
  checks: [{ name: '连接状态', status: 'ok', score: 100 }],
  status: 'healthy',
};

function successfulLoadResponses() {
  return {
    '/health-history?days=7': response([{ health_score: 100, created_at: '2026-08-30T00:00:00.000Z' }]),
    '/health-checks': response(healthyChecks),
    '/collection-capabilities': response([]),
    '/api/database/instances/7': response(healthyInstance),
  };
}

function mockResponses(responses: Record<string, ReturnType<typeof response> | (() => unknown)>) {
  authFetch.mockImplementation(async (url: string | undefined) => {
    const requestUrl = String(url ?? '');
    const key = requestUrl.includes('/health-history')
      ? '/health-history?days=7'
      : requestUrl.includes('/health-checks')
        ? '/health-checks'
        : requestUrl.includes('/collection-capabilities')
          ? '/collection-capabilities'
          : '/api/database/instances/7';
    const value = responses[key];
    if (typeof value === 'function') return value();
    return value;
  });
}

async function settle(element: HTMLElement & { updateComplete: Promise<unknown> }) {
  await element.updateComplete;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await element.updateComplete;
}

async function renderHealthyTab() {
  mockResponses(successfulLoadResponses());
  const element = document.createElement('health-score-tab') as HTMLElement & {
    instanceId: number;
    updateComplete: Promise<unknown>;
  };
  element.instanceId = 7;
  document.body.append(element);
  await settle(element);
  expect(element.shadowRoot?.querySelector('.score-number')?.textContent).toBe('100');
  return element;
}

describe('health-score-tab stale score handling', () => {
  beforeEach(() => authFetch.mockReset());

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('clears a previously healthy score when refresh responses are not OK', async () => {
    const element = await renderHealthyTab();
    mockResponses({
      '/health-history?days=7': response({ error: 'unavailable' }, false),
      '/health-checks': response({ error: 'unavailable' }, false),
      '/collection-capabilities': response({ error: 'unavailable' }, false),
      '/api/database/instances/7': response({ error: 'unavailable' }, false),
    });

    const refresh = (element as any)._loadData();
    expect((element as any)._getLatestScore()).toBeNull();
    await refresh;
    await settle(element);

    expect(element.shadowRoot?.querySelector('.score-number')?.textContent).toBe('未知');
    expect(element.shadowRoot?.textContent).not.toContain('100');
  });

  it('does not retain a healthy score when the instance response is malformed', async () => {
    const element = await renderHealthyTab();
    mockResponses({
      '/health-history?days=7': response([{ health_score: 100, created_at: '2026-08-30T00:00:00.000Z' }]),
      '/health-checks': response(healthyChecks),
      '/collection-capabilities': response([]),
      '/api/database/instances/7': {
        ok: true,
        status: 200,
        json: async () => { throw new Error('invalid instance payload'); },
      },
    });

    await (element as any)._loadData();
    await settle(element);

    expect(element.shadowRoot?.textContent).toContain('invalid instance payload');
    expect((element as any)._getLatestScore()).toBeNull();
    expect(element.shadowRoot?.textContent).not.toContain('100');
  });
});
