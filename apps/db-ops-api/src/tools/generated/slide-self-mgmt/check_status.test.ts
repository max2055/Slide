import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => {
  const state = {
    getAllInstances: vi.fn(async () => [] as Array<Record<string, unknown>>),
    getAllConnections: vi.fn(() => [] as Array<{ id: number }>),
    checkConnectionAlive: vi.fn(async (_id?: number) => true),
    platformConnected: true,
    platformPing: vi.fn(async () => {}),
    platformRelease: vi.fn(),
    platformDestroy: vi.fn(),
    platformGetConnection: vi.fn(),
  };
  state.platformGetConnection.mockImplementation(async () => ({
    ping: () => state.platformPing(),
    release: () => state.platformRelease(),
    destroy: () => state.platformDestroy(),
  }));
  return state;
});

vi.mock('../../catalog.js', () => ({ toolCatalog: { register: vi.fn() } }));
vi.mock('../../../db-connection.js', () => ({
  dbConnection: {
    isConnected: () => db.platformConnected,
    getPool: () => (db.platformConnected ? {
      getConnection: () => db.platformGetConnection(),
    } : null),
  },
}));
vi.mock('../../../database-service.js', () => ({
  databaseService: {
    getAllConnections: () => db.getAllConnections(),
    checkConnectionAlive: (id: number) => db.checkConnectionAlive(id),
  },
}));
vi.mock('../../../instance-database-service.js', () => ({
  instanceDatabaseService: { getAllInstances: () => db.getAllInstances() },
}));
vi.mock('../../../llm/provider-catalog.js', () => ({ getAllProviders: () => [] }));

import { resetRecordedApiBind } from '../../../config/api-listen.js';
import { checkStatusTool } from './check_status.js';

describe('slide_check_status frontend health', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    resetRecordedApiBind();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FRONTEND_URL', '');
    vi.stubEnv('SLIDE_PUBLIC_ORIGIN', '');
    vi.stubEnv('PORT', '');
    vi.stubEnv('BACKEND_PORT', '');
    vi.stubEnv('API_PORT', '');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 });
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('uses the configured container address before the public origin', async () => {
    vi.stubEnv('FRONTEND_URL', 'http://frontend:8080');
    vi.stubEnv('SLIDE_PUBLIC_ORIGIN', 'https://slide.example.com');
    const result = await checkStatusTool.handler({});
    expect(fetchMock).toHaveBeenLastCalledWith('http://frontend:8080', expect.objectContaining({ method: 'HEAD' }));
    expect(result).toMatchObject({ status: 'success', data: { overall: 'healthy', services: [{ status: 'running' }, { status: 'running', port: 8080 }] } });
  });

  it('falls back to the public origin and derives the HTTPS port', async () => {
    vi.stubEnv('SLIDE_PUBLIC_ORIGIN', 'https://slide.example.com');
    const result = await checkStatusTool.handler({});
    expect(fetchMock).toHaveBeenLastCalledWith('https://slide.example.com', expect.anything());
    expect(result.data).toMatchObject({ services: [{}, { port: 443 }] });
  });

  it('skips unconfigured production probes without downgrading a healthy result', async () => {
    const result = await checkStatusTool.handler({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 'success',
      data: {
        overall: 'healthy',
        services: [
          { status: 'running' },
          { status: 'unknown', error: expect.stringContaining('未配置 FRONTEND_URL') },
        ],
      },
    });
  });

  it('keeps a production backend failure as warning when the frontend address is absent', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await checkStatusTool.handler({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 'warning',
      data: {
        overall: 'unhealthy',
        services: [
          { status: 'stopped', error: '服务未启动或端口不可达' },
          { status: 'unknown', error: expect.stringContaining('未配置 FRONTEND_URL') },
        ],
      },
    });
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

  it('returns success in development when backend and frontend are running', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const result = await checkStatusTool.handler({});
    expect(fetchMock).toHaveBeenLastCalledWith('http://localhost:5173', expect.anything());
    expect(result).toMatchObject({
      status: 'success',
      data: { overall: 'healthy', services: [{ status: 'running', port: 3000 }, { status: 'running', port: 5173 }] },
    });
  });

  it('retains the local development default and degradation behavior', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 }).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await checkStatusTool.handler({});
    expect(fetchMock).toHaveBeenLastCalledWith('http://localhost:5173', expect.anything());
    expect(result).toMatchObject({
      status: 'warning',
      data: {
        overall: 'degraded',
        services: [{ status: 'running' }, { status: 'unknown', port: 5173, error: expect.stringContaining('无法确认') }],
      },
    });
  });

  it('returns warning in development when the backend is down', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValueOnce({ ok: true, status: 200 });
    const result = await checkStatusTool.handler({});
    expect(result).toMatchObject({
      status: 'warning',
      data: { overall: 'unhealthy', services: [{ status: 'stopped' }, { status: 'running', port: 5173 }] },
    });
  });

  it('rejects invalid configuration without leaking its value or probing localhost', async () => {
    vi.stubEnv('FRONTEND_URL', 'ftp://user:secret@frontend/file');
    const result = await checkStatusTool.handler({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'success', data: { overall: 'healthy', services: [{ status: 'running' }, { status: 'unknown', error: expect.stringContaining('配置无效') }] } });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('does not advertise the development port as the frontend topology', () => {
    expect(checkStatusTool.description).not.toContain(':5173');
  });
});

describe('slide_check_status core database failures', () => {
  const fetchMock = vi.fn();

  function instance(overrides: Record<string, unknown> = {}) {
    return {
      id: 7,
      name: '生产库',
      status: 'active',
      db_type: 'mysql',
      host: '10.9.9.9',
      port: 3306,
      database_name: 'orders',
      tags: [],
      ...overrides,
    };
  }

  beforeEach(() => {
    resetRecordedApiBind();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FRONTEND_URL', '');
    vi.stubEnv('SLIDE_PUBLIC_ORIGIN', '');
    vi.stubEnv('PORT', '');
    vi.stubEnv('BACKEND_PORT', '');
    vi.stubEnv('API_PORT', '');
    vi.stubEnv('DB_HOST', '10.1.2.3');
    vi.stubEnv('DB_PORT', '3306');
    vi.stubEnv('DB_NAME', 'slide_platform');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 });
    db.platformConnected = true;
    db.platformPing.mockReset().mockResolvedValue(undefined);
    db.platformRelease.mockReset();
    db.platformDestroy.mockReset();
    db.platformGetConnection.mockReset().mockImplementation(async () => ({
      ping: () => db.platformPing(),
      release: () => db.platformRelease(),
      destroy: () => db.platformDestroy(),
    }));
    db.getAllInstances.mockReset().mockResolvedValue([]);
    db.getAllConnections.mockReset().mockReturnValue([]);
    db.checkConnectionAlive.mockReset().mockResolvedValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function statusOf(args: Record<string, unknown> = { test_db_connections: true }) {
    const result = await checkStatusTool.handler(args);
    return result;
  }

  it('does not keep a hardcoded database display name as the core-failure key', () => {
    const source = readFileSync(new URL('./check_status.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('系统数据库 (MySQL)');
    expect(source).not.toContain('http://localhost:3000/api/health');
    expect(source).toContain('readApiProbe');
  });

  it('treats a disconnected platform database as a core failure under any display name', async () => {
    db.platformConnected = false;
    const result = await statusOf();
    expect(result).toMatchObject({
      status: 'warning',
      data: {
        overall: 'unhealthy',
        services: expect.arrayContaining([
          { name: '平台数据库', critical: true, status: 'error', error: '平台数据库未连接' },
        ]),
      },
    });
    expect(JSON.stringify(result)).not.toContain('系统数据库 (MySQL)');
  });

  it.each([
    ['展示名甲', '10.1.2.3'],
    ['归档库', '127.0.0.1'],
  ])('treats platform-endpoint instance %s failure as core', async (name, host) => {
    if (host === '127.0.0.1') vi.stubEnv('DB_HOST', 'localhost');
    db.getAllInstances.mockResolvedValue([instance({
      name,
      host,
      database_name: 'slide_platform',
    })]);
    db.getAllConnections.mockReturnValue([{ id: 7 }]);
    db.checkConnectionAlive.mockResolvedValue(false);
    const result = await statusOf();
    expect(result.data).toMatchObject({
      overall: 'unhealthy',
      services: expect.arrayContaining([
        expect.objectContaining({ name: `${name} (MYSQL)`, critical: true, status: 'error', error: '连接已断开' }),
      ]),
    });
  });

  it.each([
    ['归档库', ['核心']],
    ['系统数据库 (MySQL)', '{"role":"core"}'],
  ])('treats core-tagged instance %s failure as core', async (name, tags) => {
    db.getAllInstances.mockResolvedValue([instance({ name, tags })]);
    db.getAllConnections.mockReturnValue([{ id: 7 }]);
    db.checkConnectionAlive.mockResolvedValue(false);
    const result = await statusOf();
    expect(result.data).toMatchObject({
      overall: 'unhealthy',
      services: expect.arrayContaining([
        expect.objectContaining({ name: `${name} (MYSQL)`, critical: true, status: 'error' }),
      ]),
    });
  });

  it('keeps a non-core database failure degraded even when its display name looks core', async () => {
    db.getAllInstances.mockResolvedValue([instance({ name: '系统数据库 (MySQL)', tags: ['reporting'] })]);
    db.getAllConnections.mockReturnValue([]);
    const result = await statusOf();
    expect(result).toMatchObject({
      status: 'warning',
      data: {
        overall: 'degraded',
        services: expect.arrayContaining([
          expect.objectContaining({ name: '平台数据库', critical: true, status: 'running' }),
          expect.objectContaining({ name: '系统数据库 (MySQL) (MYSQL)', critical: false, status: 'error', error: '未建立连接' }),
        ]),
      },
    });
  });

  it('stays healthy when the platform database and a non-core database are running', async () => {
    db.getAllInstances.mockResolvedValue([
      instance({ name: '订单库' }),
      instance({ id: 8, name: '展示名乙', host: '10.1.2.3', database_name: 'slide_platform', tags: ['core'] }),
    ]);
    db.getAllConnections.mockReturnValue([{ id: 7 }, { id: 8 }]);
    const result = await statusOf();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 'success',
      data: {
        overall: 'healthy',
        services: expect.arrayContaining([
          expect.objectContaining({ name: '平台数据库', critical: true, status: 'running' }),
          expect.objectContaining({ name: '订单库 (MYSQL)', critical: false, status: 'running' }),
          expect.objectContaining({ name: '展示名乙 (MYSQL)', critical: true, status: 'running' }),
        ]),
      },
    });
  });

  it('does not treat an inactive core database or a listing error as a platform failure', async () => {
    db.getAllInstances.mockResolvedValue([instance({ status: 'inactive', tags: ['core'] })]);
    expect((await statusOf()).data).toMatchObject({ overall: 'healthy' });

    db.getAllInstances.mockRejectedValue(new Error('query failed'));
    const failed = await statusOf();
    expect(failed.data).toMatchObject({
      overall: 'degraded',
      services: expect.arrayContaining([
        { name: '平台数据库', critical: true, status: 'running' },
        { name: '数据库连接检查', status: 'error', error: 'query failed' },
      ]),
    });
  });

  it('releases the platform connection after a successful ping', async () => {
    const result = await statusOf();
    expect(result.data).toMatchObject({
      overall: 'healthy',
      services: expect.arrayContaining([
        { name: '平台数据库', critical: true, status: 'running' },
      ]),
    });
    expect(db.platformRelease).toHaveBeenCalledTimes(1);
    expect(db.platformDestroy).not.toHaveBeenCalled();
  });

  it('releases the platform connection when ping rejects', async () => {
    db.platformPing.mockRejectedValueOnce(new Error('ping refused'));
    const result = await statusOf();
    expect(result.data).toMatchObject({
      overall: 'unhealthy',
      services: expect.arrayContaining([
        { name: '平台数据库', critical: true, status: 'error', error: 'ping refused' },
      ]),
    });
    expect(db.platformRelease).toHaveBeenCalledTimes(1);
    expect(db.platformDestroy).not.toHaveBeenCalled();
  });

  it('does not keep a connection when borrowing is refused', async () => {
    db.platformGetConnection.mockRejectedValueOnce(new Error('pool refused'));
    const result = await statusOf();
    expect(result.data).toMatchObject({
      overall: 'unhealthy',
      services: expect.arrayContaining([
        { name: '平台数据库', critical: true, status: 'error', error: 'pool refused' },
      ]),
    });
    expect(db.platformRelease).not.toHaveBeenCalled();
    expect(db.platformDestroy).not.toHaveBeenCalled();
  });

  it('destroys a stuck platform ping instead of returning it to the pool', async () => {
    vi.useFakeTimers();
    let outstanding = 0;
    let released = 0;
    let destroyed = 0;
    db.platformGetConnection.mockImplementation(async () => {
      outstanding += 1;
      return {
        ping: () => new Promise(() => {}),
        release: () => { outstanding -= 1; released += 1; },
        destroy: () => { outstanding -= 1; destroyed += 1; },
      };
    });

    for (let i = 0; i < 10; i += 1) {
      const pending = statusOf();
      await vi.advanceTimersByTimeAsync(5000);
      const result = await pending;
      expect(result.data).toMatchObject({
        overall: 'unhealthy',
        services: expect.arrayContaining([
          expect.objectContaining({ name: '平台数据库', critical: true, status: 'error', error: '平台数据库连接已断开' }),
        ]),
      });
    }

    expect({ outstanding, released, destroyed }).toEqual({ outstanding: 0, released: 0, destroyed: 10 });
  });

  it('destroys a platform connection that arrives after the ping timeout', async () => {
    vi.useFakeTimers();
    let grant: (connection: { ping: () => Promise<void>; release: () => void; destroy: () => void }) => void = () => {};
    const connection = {
      ping: vi.fn(async () => {}),
      release: vi.fn(),
      destroy: vi.fn(),
    };
    db.platformGetConnection.mockImplementation(() => new Promise((resolve) => {
      grant = resolve;
    }));

    const pending = statusOf();
    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;
    expect(result.data).toMatchObject({
      overall: 'unhealthy',
      services: expect.arrayContaining([
        expect.objectContaining({ name: '平台数据库', critical: true, status: 'error', error: '平台数据库连接已断开' }),
      ]),
    });
    expect(connection.destroy).not.toHaveBeenCalled();

    grant(connection);
    await Promise.resolve();
    await Promise.resolve();

    expect(connection.ping).not.toHaveBeenCalled();
    expect(connection.release).not.toHaveBeenCalled();
    expect(connection.destroy).toHaveBeenCalledTimes(1);
  });
});
