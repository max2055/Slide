import { createServer } from 'node:net';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../catalog.js', () => ({ toolCatalog: { register: vi.fn() } }));
vi.mock('../../../database-service.js', () => ({ databaseService: {} }));
vi.mock('../../../db-connection.js', () => ({ dbConnection: { isConnected: () => false, getPool: () => null } }));
vi.mock('../../../instance-database-service.js', () => ({ instanceDatabaseService: {} }));
vi.mock('../../../llm/provider-catalog.js', () => ({ getAllProviders: () => [] }));

import { bindApiListener, noteApiBoundAddress, resetRecordedApiBind } from '../../../config/api-listen.js';
import { checkStatusTool } from './check_status.js';

const servers: Array<{ close: () => Promise<void> }> = [];

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolve());
  });
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

describe('slide_check_status actual listen probe', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    resetRecordedApiBind();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FRONTEND_URL', '');
    vi.stubEnv('SLIDE_PUBLIC_ORIGIN', '');
    vi.stubEnv('PORT', '');
    vi.stubEnv('BACKEND_PORT', '');
    vi.stubEnv('API_PORT', '');
    vi.stubEnv('HOST', '10.9.9.9');
  });

  afterEach(async () => {
    resetRecordedApiBind();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await Promise.all(servers.splice(0).map(server => server.close()));
  });

  function backend(result: { data?: { services?: Array<{ port?: number; status?: string }> } }) {
    return result.data?.services?.[0];
  }

  it('keeps the default successful probe on localhost:3000', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const result = await checkStatusTool.handler({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3000/api/health', expect.objectContaining({ method: 'GET' }));
    expect(backend(result)).toMatchObject({ status: 'running', port: 3000, critical: true });
    expect(result.data).toMatchObject({ overall: 'healthy' });
  });

  it('probes API_PORT when the higher-priority variables are empty', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    vi.stubEnv('API_PORT', '41207');
    const result = await checkStatusTool.handler({});
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:41207/api/health', expect.anything());
    expect(backend(result)).toMatchObject({ status: 'error', port: 41207, error: 'HTTP 503' });
    expect(result.data).toMatchObject({ overall: 'unhealthy' });
  });

  it('reports the selected port when that listener is closed', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:41208'));
    vi.stubEnv('PORT', '41208');
    vi.stubEnv('BACKEND_PORT', '3000');
    const result = await checkStatusTool.handler({});
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:41208/api/health', expect.anything());
    expect(backend(result)).toMatchObject({ status: 'stopped', port: 41208, error: '服务未启动或端口不可达' });
    expect(result.data).toMatchObject({ overall: 'unhealthy' });
  });

  it('does not fetch when the selected port is invalid', async () => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockClear();
    vi.stubEnv('PORT', 'nope');
    const result = await checkStatusTool.handler({});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(backend(result)).toMatchObject({ status: 'error', critical: true });
    expect(result.data).toMatchObject({ overall: 'unhealthy' });
  });

  it('probes the recorded bind port instead of a decoy PORT or the open default', async () => {
    const port = await freePort();
    const app = Fastify();
    servers.push(app);
    app.get('/api/health', async () => ({ status: 'ok' }));
    await app.listen({ port, host: '0.0.0.0' });
    noteApiBoundAddress('0.0.0.0', port);
    vi.stubEnv('PORT', '3000');
    const result = await checkStatusTool.handler({});
    expect(backend(result)).toMatchObject({ status: 'running', port, critical: true });
    expect(result.data).toMatchObject({ overall: 'healthy' });
  });

  it('follows bindApiListener for a non-default BACKEND_PORT', async () => {
    const port = await freePort();
    const app = Fastify();
    servers.push(app);
    app.get('/api/health', async () => ({ status: 'ok' }));
    const bound = await bindApiListener(app, { PORT: '', BACKEND_PORT: String(port), API_PORT: '3000' });
    expect(bound).toBe(port);
    vi.stubEnv('PORT', '3000');
    const result = await checkStatusTool.handler({});
    expect(backend(result)).toMatchObject({ status: 'running', port });
  });

  it('does not fall back to a live port 3000 after the selected listener closes', async () => {
    const port = await freePort();
    const app = Fastify();
    servers.push(app);
    app.get('/api/health', async () => ({ status: 'ok' }));
    await bindApiListener(app, { PORT: String(port) });
    await app.close();
    servers.splice(0, servers.length);
    resetRecordedApiBind();
    vi.stubEnv('PORT', String(port));
    const result = await checkStatusTool.handler({});
    expect(backend(result)).toMatchObject({ status: 'stopped', port, error: '服务未启动或端口不可达' });
    expect(result.data).toMatchObject({ overall: 'unhealthy' });
  });
});
