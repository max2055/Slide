import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../catalog.js', () => ({ toolCatalog: { register: vi.fn() } }));
vi.mock('../../../database-service.js', () => ({ databaseService: {} }));
vi.mock('../../../instance-database-service.js', () => ({ instanceDatabaseService: {} }));
vi.mock('../../../llm/provider-catalog.js', () => ({ getAllProviders: () => [] }));

import { checkStatusTool } from './check_status.js';

describe('slide_check_status frontend health', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FRONTEND_URL', '');
    vi.stubEnv('SLIDE_PUBLIC_ORIGIN', '');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 });
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('uses the configured container address before the public origin', async () => {
    vi.stubEnv('FRONTEND_URL', 'http://frontend:8080');
    vi.stubEnv('SLIDE_PUBLIC_ORIGIN', 'https://slide.example.com');
    const result = await checkStatusTool.handler({});
    expect(fetchMock).toHaveBeenLastCalledWith('http://frontend:8080', expect.objectContaining({ method: 'HEAD' }));
    expect(result.data).toMatchObject({ overall: 'healthy', services: [{}, { status: 'running', port: 8080 }] });
  });

  it('falls back to the public origin and derives the HTTPS port', async () => {
    vi.stubEnv('SLIDE_PUBLIC_ORIGIN', 'https://slide.example.com');
    const result = await checkStatusTool.handler({});
    expect(fetchMock).toHaveBeenLastCalledWith('https://slide.example.com', expect.anything());
    expect(result.data).toMatchObject({ services: [{}, { port: 443 }] });
  });

  it('skips unconfigured production probes without claiming the frontend stopped', async () => {
    const result = await checkStatusTool.handler({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'warning', data: { overall: 'healthy', services: [{}, { status: 'unknown' }] } });
  });

  it.each(['network', 'timeout', 'http'])('keeps production frontend %s failures advisory', async (failure) => {
    vi.stubEnv('FRONTEND_URL', 'http://frontend:8080');
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    if (failure === 'http') fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    else fetchMock.mockRejectedValueOnce(new Error(failure === 'timeout' ? 'TimeoutError' : 'ECONNREFUSED'));
    const result = await checkStatusTool.handler({});
    expect(result).toMatchObject({ status: 'warning', data: { overall: 'healthy', services: [{}, { status: 'unknown', error: expect.stringContaining('无法确认') }] } });
  });

  it('does not hide a backend failure behind the frontend advisory', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect((await checkStatusTool.handler({})).data).toMatchObject({ overall: 'unhealthy' });
  });

  it('does not hide other optional component failures', async () => {
    expect((await checkStatusTool.handler({ test_llm: true })).data).toMatchObject({ overall: 'degraded' });
  });

  it('retains the local development default and degradation behavior', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 }).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await checkStatusTool.handler({});
    expect(fetchMock).toHaveBeenLastCalledWith('http://localhost:5173', expect.anything());
    expect(result.data).toMatchObject({ overall: 'degraded', services: [{}, { port: 5173 }] });
  });

  it('rejects invalid configuration without leaking its value or probing localhost', async () => {
    vi.stubEnv('FRONTEND_URL', 'ftp://user:secret@frontend/file');
    const result = await checkStatusTool.handler({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.data).toMatchObject({ overall: 'healthy', services: [{}, { status: 'unknown' }] });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('does not advertise the development port as the frontend topology', () => {
    expect(checkStatusTool.description).not.toContain(':5173');
  });
});
