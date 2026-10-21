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
  last_health_check_at: new Date().toISOString(),
};

const healthyChecks = {
  checks: [{ name: '连接状态', status: 'ok', score: 100 }],
  status: 'healthy',
  created_at: healthyInstance.last_health_check_at,
};

function successfulLoadResponses() {
  return {
    '/health-history?days=7': response([{ health_score: 100, created_at: '2026-08-30T00:00:00.000Z' }]),
    '/health-checks': response(healthyChecks),
    '/collection-capabilities': response([]),
    '/status': response({ effective_enabled: { enabled: true } }),
    '/api/resources/overview': response({ items: [{ resource: {type: 'instance', id: 7}, status: 'healthy', quality: 'good', freshness: 'fresh', observedAt: healthyInstance.last_health_check_at, gaps: [], unresolvedAlerts: 0 }] }),
    '/api/database/instances/7': response(healthyInstance),
  };
}

function mockResponses(responses: Record<string, ReturnType<typeof response> | (() => unknown)>) {
  authFetch.mockImplementation(async (url: string | undefined) => {
    const requestUrl = String(url ?? '');
    const key = requestUrl.endsWith('/status') ? '/status' : requestUrl === '/api/resources/overview' ? requestUrl : requestUrl.includes('/health-history')
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

  it('shows fresh incomplete checks without presenting them as zero or healthy', async () => {
    const at = new Date().toISOString();
    mockResponses({
      '/health-history?days=7': response([]),
      '/health-checks': response({ status: 'unknown', created_at: at, checks: [{ name: '表空间使用率', status: 'unknown', score: 0, message: '权限不足' }] }),
      '/collection-capabilities': response([]),
      '/api/database/instances/7': response({ ...healthyInstance, health_status: 'unknown', last_health_check_at: at }),
    });
    const element = document.createElement('health-score-tab') as any;
    element.instanceId = 7;
    document.body.append(element);
    await settle(element);
    element.expandedChecks = true;
    await settle(element);
    expect(element.shadowRoot?.textContent).toContain('权限不足');
    expect(element.shadowRoot?.querySelector('.check-score')?.textContent).toBe('未知');
    expect(element.shadowRoot?.querySelector('.score-number')?.textContent).toBe('未知');
  });

  it.each(['stale', 'partial', 'paused', 'empty', 'mismatched', 'checks-error'])('keeps history while withholding a current score for %s evidence', async scenario => {
    const responses = successfulLoadResponses();
    if (scenario === 'paused') responses['/status'] = response({ effective_enabled: { enabled: false } });
    else if (scenario === 'empty') responses['/health-checks'] = response({ ...healthyChecks, checks: [] });
    else if (scenario === 'mismatched') responses['/health-checks'] = response({ ...healthyChecks, created_at: '2020-01-01T00:00:00Z' });
    else if (scenario === 'checks-error') responses['/health-checks'] = response({}, false);
    else responses['/api/resources/overview'] = response({ items: [{ resource: {type: 'instance', id: 7}, status: 'healthy', quality: scenario === 'partial' ? 'partial' : 'good', freshness: scenario === 'stale' ? 'stale' : 'fresh', observedAt: healthyInstance.last_health_check_at, gaps: [], unresolvedAlerts: 0 }] });
    mockResponses(responses);
    const element = document.createElement('health-score-tab') as any;
    element.instanceId = 7; document.body.append(element); await settle(element);
    expect(element.shadowRoot.querySelector('.score-number').textContent).toBe('未知');
    expect(element.shadowRoot.querySelector('metric-chart').getAttribute('title')).toContain('历史');
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

  it('does not show stale check scores when the current instance is unknown', async () => {
    mockResponses({
      '/health-history?days=7': response([{ health_score: 100, created_at: '2026-08-30T00:00:00.000Z' }]),
      '/health-checks': response(healthyChecks),
      '/collection-capabilities': response([]),
      '/api/database/instances/7': response({
        ...healthyInstance,
        health_status: 'unknown',
        health_score: 100,
        hasCredential: false,
      }),
    });

    const element = document.createElement('health-score-tab') as HTMLElement & {
      instanceId: number;
      updateComplete: Promise<unknown>;
    };
    element.instanceId = 7;
    document.body.append(element);
    await settle(element);

    (element as any).expandedChecks = true;
    await settle(element);
    expect(element.shadowRoot?.querySelector('.score-number')?.textContent).toBe('未知');
    expect(element.shadowRoot?.querySelector('metric-chart')?.getAttribute('title')).toContain('历史');
    expect(element.shadowRoot?.querySelector('.check-score')).toBeNull();
  });
});
