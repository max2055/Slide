import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportLifecycleSteps } from './deep-smoke.js';
import { workflow } from './test-kit.js';

// GitHub #397 / OCR-0302 / OCR-0307. Mock only; do not read or write business reports.

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function callsOf(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((call) => {
    const init = call[1] as RequestInit | undefined;
    return `${init?.method ?? 'GET'} ${new URL(String(call[0])).pathname}`;
  });
}

describe('deep smoke report detail id', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('requests the created id when it is not 1, even if historical id 1 would succeed', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const pathname = new URL(url).pathname;
      const method = init?.method ?? 'GET';
      if (method === 'POST' && pathname === '/api/reports/generate') return json({ id: 42, status: 'completed' });
      if (method === 'GET' && pathname === '/api/reports') return json([{ id: 1 }, { id: 42 }]);
      if (method === 'GET' && pathname === '/api/reports/42') return json({ id: 42, name: 'created' });
      if (method === 'GET' && pathname === '/api/reports/1') return json({ id: 1, name: 'historical' });
      return new Response('missing', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflow('report-lifecycle', reportLifecycleSteps());

    expect(reportLifecycleSteps()[3]?.path).toBe('/api/reports/${{id}}');
    expect(result.passed).toBe(true);
    expect(result.stepResults.map((step) => step.passed)).toEqual([true, true, true, true]);
    expect(callsOf(fetchMock)).toContain('GET /api/reports/42');
    expect(callsOf(fetchMock).some((call) => call.endsWith('/api/reports/1'))).toBe(false);
  });

  it('passes when the created id is not 1 and no historical id 1 exists', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const pathname = new URL(url).pathname;
      const method = init?.method ?? 'GET';
      if (method === 'POST' && pathname === '/api/reports/generate') return json({ id: 77, status: 'completed' });
      if (method === 'GET' && pathname === '/api/reports') return json([{ id: 77 }]);
      if (method === 'GET' && pathname === '/api/reports/77') return json({ id: 77 });
      if (method === 'GET' && pathname === '/api/reports/1') return new Response('missing', { status: 404 });
      return new Response('missing', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflow('report-lifecycle', reportLifecycleSteps());

    expect(result.passed).toBe(true);
    expect(callsOf(fetchMock)).toContain('GET /api/reports/77');
    expect(callsOf(fetchMock).some((call) => call.endsWith('/api/reports/1'))).toBe(false);
  });

  it('fails when the detail response id is not the created id', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const pathname = new URL(url).pathname;
      const method = init?.method ?? 'GET';
      if (method === 'POST' && pathname === '/api/reports/generate') return json({ id: 42, status: 'completed' });
      if (method === 'GET' && pathname === '/api/reports') return json([{ id: 42 }]);
      if (method === 'GET' && pathname === '/api/reports/42') return json({ id: 1, name: 'historical' });
      return new Response('missing', { status: 404 });
    }));

    const result = await workflow('report-lifecycle', reportLifecycleSteps());

    expect(result.passed).toBe(false);
    expect(result.stepResults[3]).toMatchObject({ name: '4. GET report detail', passed: false, status: 200 });
  });
});

describe('workflow path template contract', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('substitutes path tokens and exact top-level body values for the extracted id', async () => {
    const fetchMock = vi.fn(async () => json({ id: 42 }))
      .mockResolvedValueOnce(json({ id: 42 }))
      .mockResolvedValueOnce(json({ id: 42, ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflow('probe', [
      { name: 'extract', method: 'POST', path: '/create', extract: 'id' },
      {
        name: 'use',
        method: 'POST',
        path: '/fixtures/${{id}}',
        body: { id: '${{id}}', nested: { label: 'kept' } },
        assert: (_res, body, vars) => {
          const payload = body as { id?: unknown; ok?: unknown };
          return payload.id === 42 && payload.ok === true && vars.id === 42;
        },
      },
    ]);

    expect(result.passed).toBe(true);
    expect(callsOf(fetchMock)[1]).toBe('POST /fixtures/42');
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toEqual({
      id: 42,
      nested: { label: 'kept' },
    });
  });

  it('rejects a nested template before that step is sent', async () => {
    const fetchMock = vi.fn(async () => json({ id: 42 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflow('nested', [
      { name: 'extract', method: 'POST', path: '/create', extract: 'id' },
      { name: 'bad', method: 'POST', path: '/fixtures/${{id}}', body: { nested: { id: '${{id}}' }, items: ['${{id}}'] } },
    ]);

    expect(result.passed).toBe(false);
    expect(result.stepResults[1]).toMatchObject({
      passed: false,
      status: 0,
      error: 'nested template is outside the supported contract at nested.id',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(callsOf(fetchMock)).toEqual(['POST /create']);
  });

  it('does not send a request when the path id is missing or not a scalar', async () => {
    const missingFetch = vi.fn();
    vi.stubGlobal('fetch', missingFetch);
    const missing = await workflow('missing', [
      { name: 'detail', method: 'GET', path: '/api/reports/${{id}}' },
    ]);
    expect(missingFetch).not.toHaveBeenCalled();
    expect(missing.stepResults[0]?.error).toBe('unresolved path template ${{id}}');

    const scalarFetch = vi.fn(async () => json({ id: { raw: 42 } }));
    vi.stubGlobal('fetch', scalarFetch);
    const scalar = await workflow('scalar', [
      { name: 'create', method: 'POST', path: '/create', extract: 'id' },
      { name: 'detail', method: 'GET', path: '/api/reports/${{id}}' },
    ]);
    expect(scalarFetch).toHaveBeenCalledOnce();
    expect(scalar.stepResults[1]?.error).toBe('path template ${{id}} is not a scalar');
  });

  it('does not send a request when a top-level body template is missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await workflow('body', [
      { name: 'use', method: 'POST', path: '/fixtures', body: { id: '${{id}}' } },
    ]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.stepResults[0]?.error).toBe('unresolved body template ${{id}}');
  });
});
