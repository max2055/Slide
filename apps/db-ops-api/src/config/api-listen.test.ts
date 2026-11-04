import { createServer } from 'node:net';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  API_BIND_HOST,
  apiHealthProbeUrl,
  bindApiListener,
  readApiProbe,
  resetRecordedApiBind,
  resolveApiListenPort,
} from './api-listen.js';

const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  resetRecordedApiBind();
  await Promise.all(servers.splice(0).map(server => server.close()));
});

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

describe('API listen target', () => {
  it('uses port 3000 and localhost when no listen env is set', () => {
    expect(resolveApiListenPort({})).toBe(3000);
    expect(readApiProbe({})).toEqual({
      bindHost: API_BIND_HOST,
      port: 3000,
      probeUrl: 'http://localhost:3000/api/health',
    });
  });

  it.each([
    ['PORT', { PORT: '4010', BACKEND_PORT: '4011', API_PORT: '4012' }, 4010],
    ['BACKEND_PORT', { PORT: '', BACKEND_PORT: '4011', API_PORT: '4012' }, 4011],
    ['API_PORT', { PORT: '', BACKEND_PORT: '', API_PORT: '4012' }, 4012],
  ])('selects %s before the lower-priority variables', (_name, env, port) => {
    expect(resolveApiListenPort(env)).toBe(port);
    expect(readApiProbe(env).probeUrl).toBe(`http://localhost:${port}/api/health`);
  });

  it('ignores HOST and keeps the fixed wildcard bind', () => {
    const target = readApiProbe({ HOST: '10.9.9.9', PORT: '4010' });
    expect(target).toEqual({
      bindHost: '0.0.0.0',
      port: 4010,
      probeUrl: 'http://localhost:4010/api/health',
    });
  });

  it('rejects a non-numeric port instead of falling through to 3000', () => {
    expect(() => resolveApiListenPort({ PORT: 'abc', BACKEND_PORT: '4011' })).toThrow('无效的 API 监听端口：abc');
    expect(readApiProbe({ PORT: 'abc' })).toEqual({
      bindHost: '0.0.0.0',
      error: '无效的 API 监听端口：abc',
    });
  });

  it('probes localhost for wildcard binds and the address itself otherwise', () => {
    expect(apiHealthProbeUrl('0.0.0.0', 3000)).toBe('http://localhost:3000/api/health');
    expect(apiHealthProbeUrl('::', 4010)).toBe('http://localhost:4010/api/health');
    expect(apiHealthProbeUrl('127.0.0.1', 4010)).toBe('http://127.0.0.1:4010/api/health');
    expect(apiHealthProbeUrl('::1', 4010)).toBe('http://[::1]:4010/api/health');
  });

  it('records the port the operating system actually bound', async () => {
    const app = Fastify();
    servers.push(app);
    app.get('/api/health', async () => ({ status: 'ok' }));
    const actual = await bindApiListener(app, { PORT: '0', BACKEND_PORT: '3000' });
    expect(actual).toBeGreaterThan(0);
    expect(actual).not.toBe(3000);
    const response = await fetch(readApiProbe({ PORT: '3000' }).probeUrl!);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(readApiProbe({ PORT: '3000' }).port).toBe(actual);
  });

  it('binds the first non-empty listen variable on a real socket', async () => {
    const backend = await freePort();
    const app = Fastify();
    servers.push(app);
    app.get('/api/health', async () => ({ status: 'ok' }));
    const actual = await bindApiListener(app, { PORT: '', BACKEND_PORT: String(backend), API_PORT: '3000', HOST: '10.9.9.9' });
    expect(actual).toBe(backend);
    const address = app.server.address();
    expect(address).toMatchObject({ address: '0.0.0.0', port: backend });
    expect((await fetch(`http://127.0.0.1:${backend}/api/health`)).status).toBe(200);
  });
});
