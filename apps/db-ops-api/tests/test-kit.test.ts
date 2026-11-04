import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { multiTest, smoke, workflow } from './test-kit.js';

// GitHub #400 / OCR-0306: exercise the real helper through its public callers.
describe('test-kit response diagnostics', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const cases = [
    { name: 'JSON object', text: '{"id":7,"ok":true}', status: 201, raw: { id: 7, ok: true } },
    { name: 'JSON array', text: '[1,"two",null]', status: 200, raw: [1, 'two', null] },
    { name: 'JSON null', text: 'null', status: 200, raw: null },
    { name: 'JSON boolean', text: 'false', status: 200, raw: false },
    { name: 'JSON number', text: '0', status: 200, raw: 0 },
    { name: 'JSON string', text: '"message"', status: 200, raw: 'message' },
    { name: 'plain text', text: 'upstream unavailable', status: 502, raw: 'upstream unavailable' },
    { name: 'HTML', text: '<html>Bad gateway</html>', status: 502, raw: '<html>Bad gateway</html>' },
    { name: 'malformed JSON', text: '{"error":', status: 500, raw: '{"error":' },
    { name: 'empty error', text: '', status: 503, raw: '' },
    { name: 'no content', text: null, status: 204, raw: '' },
    { name: 'whitespace', text: ' \n\t', status: 200, raw: ' \n\t' },
  ];

  it.each(cases)('preserves $name and HTTP status with one body read', async ({ text, status, raw }) => {
    // Deliberately omit content-type: gateways may mislabel their response.
    const res = new Response(text, { status });
    const textRead = vi.spyOn(res, 'text');
    const jsonRead = vi.spyOn(res, 'json');
    const fetchMock = vi.fn().mockResolvedValue(res);
    vi.stubGlobal('fetch', fetchMock);
    const assertion = vi.fn((response: Response, body: unknown) => {
      expect(response).toBe(res);
      expect(response.status).toBe(status);
      expect(body).toEqual(raw);
      return { passed: true, details: [] };
    });

    const result = await multiTest('response', 'GET', '/isolated', [{ name: 'body', assert: assertion }]);

    expect(result).toEqual({ passed: 1, failed: 0, errors: [] });
    expect(assertion).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(textRead.mock.calls.length + jsonRead.mock.calls.length).toBe(1);
  });

  it('reports text errors as HTTP failures with the original diagnostic', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('upstream unavailable', { status: 502 })));

    const result = await multiTest('gateway', 'GET', '/isolated', [{ name: 'default' }]);

    expect(result).toEqual({ passed: 0, failed: 1, errors: ['[gateway] default: HTTP 502'] });
    expect(console.log).toHaveBeenCalledWith('  ❌ default — HTTP 502: upstream unavailable');
  });

  it.each(cases)('passes $name and its real status to workflow assertions', async ({ text, status, raw }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(text, { status })));
    const assertion = vi.fn((res: Response, body: unknown) => {
      expect(res.status).toBe(status);
      expect(body).toEqual(raw);
      return 'diagnostic retained';
    });

    const result = await workflow('response', [{ name: 'body', method: 'GET', path: '/isolated', assert: assertion }]);

    expect(assertion).toHaveBeenCalledOnce();
    expect(result.stepResults).toEqual([{ name: 'body', passed: false, status, error: 'diagnostic retained' }]);
    expect(result.errors).toEqual(['[response] body: diagnostic retained']);
  });

  it('retains HTTP status for a workflow without a custom assertion', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 })));

    const result = await workflow('gateway', [{ name: 'default', method: 'GET', path: '/isolated' }]);

    expect(result.stepResults).toEqual([{ name: 'default', passed: false, status: 502, error: undefined }]);
    expect(result.errors).toEqual(['[gateway] default: HTTP 502']);
  });

  it('keeps JSON extraction available to later workflow steps', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('{"id":7}'))
      .mockResolvedValueOnce(new Response('done')));

    const result = await workflow('extract', [
      { name: 'create', method: 'POST', path: '/isolated', extract: 'id' },
      { name: 'use', method: 'POST', path: '/isolated', body: { id: '${{id}}' },
        assert: (_res, body, vars) => body === 'done' && vars.id === 7 },
    ]);

    expect(result.passed).toBe(true);
    expect(fetch).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ body: '{"id":7}' }));
  });

  it('lets smoke report unexpected non-JSON statuses without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('upstream unavailable', { status: 502 })));

    await expect(smoke([{ name: 'gateway', method: 'GET', path: '/isolated' }])).resolves.toEqual({ passed: 0, failed: 1 });
    expect(console.log).toHaveBeenCalledWith('  ❌ gateway — HTTP 502: upstream unavailable');
  });

  it('preserves the original stream read failure in all callers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error('connection lost during body read')); },
    }))));

    const multi = await multiTest('read', 'GET', '/isolated', [{ name: 'broken' }]);
    expect(multi.errors).toEqual(['[read] broken: connection lost during body read']);
    const flow = await workflow('read', [{ name: 'broken', method: 'GET', path: '/isolated' }]);
    expect(flow.stepResults).toEqual([{ name: 'broken', passed: false, status: 0, error: 'connection lost during body read' }]);
    await expect(smoke([{ name: 'broken', method: 'GET', path: '/isolated' }])).rejects.toThrow('connection lost during body read');
  });

  it('preserves fetch failures as request errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unavailable')));

    const result = await multiTest('network', 'GET', '/isolated', [{ name: 'offline' }]);

    expect(result.errors).toEqual(['[network] offline: network unavailable']);
  });
});
