import { afterEach, describe, expect, it, vi } from 'vitest';
import { databaseService } from './database-service.js';
import { withInstanceExecutionLock } from './instance-execution-lock.js';

describe('instance execution lock', () => {
  it('keeps a second owner outside until the first leaves', async () => {
    const events: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = withInstanceExecutionLock(36701, async () => {
      events.push('first-enter');
      await gate;
      events.push('first-leave');
    });
    await vi.waitUntil(() => events.includes('first-enter'));
    let secondEntered = false;
    const second = withInstanceExecutionLock(36701, async () => {
      secondEntered = true;
      events.push('second');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondEntered).toBe(false);
    release();
    await first;
    await second;
    expect(events).toEqual(['first-enter', 'first-leave', 'second']);
  });

  it('runs a nested owner inline', async () => {
    const events: string[] = [];
    await withInstanceExecutionLock(36702, async () => {
      events.push('outer');
      await withInstanceExecutionLock(36702, async () => { events.push('inner'); });
      events.push('after');
    });
    expect(events).toEqual(['outer', 'inner', 'after']);
  });
});

describe('Dameng production probe ownership', () => {
  const id = 367003;
  const service = databaseService as unknown as { connections: Map<number, unknown> };
  const dm = { execute: vi.fn(async () => ({ rows: [[1]] })) };

  afterEach(() => {
    service.connections.delete(id);
    dm.execute.mockClear();
  });

  it('waits for the instance owner before SELECT 1 FROM DUAL', async () => {
    service.connections.set(id, {
      id, name: 'dameng', connected: true, db_type: 'dameng', dmConnection: dm,
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const owner = withInstanceExecutionLock(id, async () => { await gate; });
    const probe = databaseService.ensureConnectionAlive(id);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(dm.execute).not.toHaveBeenCalled();
    release();
    await owner;
    expect(await probe).toBe(true);
    expect(dm.execute.mock.calls).toEqual([['SELECT 1 FROM DUAL']]);
  });

  it('lets the owner probe without waiting for itself', async () => {
    service.connections.set(id, {
      id, name: 'dameng', connected: true, db_type: 'dameng', dmConnection: dm,
    });
    const alive = await withInstanceExecutionLock(id, () => databaseService.ensureConnectionAlive(id));
    expect(alive).toBe(true);
    expect(dm.execute.mock.calls).toEqual([['SELECT 1 FROM DUAL']]);
  });
});

describe('Dameng session rebuild ownership', () => {
  const id = 367004;
  const service = databaseService as unknown as { connections: Map<number, Record<string, unknown>> };
  const config = { host: '127.0.0.1', port: 1, user: 'slide', password: 'unused', db_type: 'dameng' };

  function install(events: string[], connected: boolean, probe: () => Promise<unknown>) {
    const dm = { execute: vi.fn(probe), close: vi.fn(async () => undefined) };
    service.connections.set(id, {
      id, name: 'dameng', connected, db_type: 'dameng', config, dmConnection: dm,
      pool: null, pgClient: null, oracleConnection: null, oraclePool: null,
    });
    vi.spyOn(databaseService, 'removeConnection').mockImplementation(async () => {
      events.push('close');
    });
    vi.spyOn(databaseService, 'addConnection').mockImplementation(async () => {
      events.push('replace');
      service.connections.set(id, {
        id, name: 'dameng', connected: true, db_type: 'dameng', config,
        dmConnection: { execute: vi.fn(async () => ({ rows: [[1]] })), close: vi.fn(async () => undefined) },
        pool: null, pgClient: null, oracleConnection: null, oraclePool: null,
      });
      return true;
    });
    return dm;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    service.connections.delete(id);
    service.connections.delete(367005);
  });

  async function holdOwner(events: string[]): Promise<() => void> {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const owner = withInstanceExecutionLock(id, async () => {
      events.push('owner-enter');
      await gate;
      events.push('owner-leave');
    });
    await vi.waitUntil(() => events.includes('owner-enter'));
    return () => {
      release();
      return owner;
    };
  }

  it('waits to close when reconnect is called by someone else', async () => {
    const events: string[] = [];
    install(events, true, async () => ({ rows: [[1]] }));
    const finish = await holdOwner(events);
    const pending = databaseService.reconnect(id);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events).toEqual(['owner-enter']);
    await finish();
    expect(await pending).toBe(true);
    expect(events).toEqual(['owner-enter', 'owner-leave', 'close', 'replace']);
  });

  it('waits to close when ensure sees connected=false', async () => {
    const events: string[] = [];
    install(events, false, async () => ({ rows: [[1]] }));
    const finish = await holdOwner(events);
    const pending = databaseService.ensureConnectionAlive(id);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events).toEqual(['owner-enter']);
    await finish();
    expect(await pending).toBe(true);
    expect(events).toEqual(['owner-enter', 'owner-leave', 'close', 'replace']);
  });

  it('keeps a failed probe and its reconnect ahead of the next owner', async () => {
    const events: string[] = [];
    install(events, true, async () => {
      events.push('probe');
      throw new Error('down');
    });
    const finish = await holdOwner(events);
    const pending = databaseService.ensureConnectionAlive(id);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events).toEqual(['owner-enter']);
    const second = withInstanceExecutionLock(id, async () => { events.push('second'); });
    await finish();
    expect(await pending).toBe(true);
    await second;
    expect(events).toEqual(['owner-enter', 'owner-leave', 'probe', 'close', 'replace', 'second']);
  });

  it('reconnects from the owner without deadlocking', async () => {
    const events: string[] = [];
    const dm = install(events, true, async () => {
      events.push('probe');
      throw new Error('down');
    });
    const alive = await withInstanceExecutionLock(id, async () => {
      events.push('owner-enter');
      const ensured = await databaseService.ensureConnectionAlive(id);
      events.push('after-ensure');
      const replaced = await databaseService.reconnect(id);
      events.push('after-reconnect');
      return ensured && replaced;
    });
    expect(alive).toBe(true);
    expect(events).toEqual(['owner-enter', 'probe', 'close', 'replace', 'after-ensure', 'close', 'replace', 'after-reconnect']);
    expect(dm.execute).toHaveBeenCalledTimes(1);
  });

  it('still closes a non-dameng reconnect without the instance lock', async () => {
    const mysqlId = 367005;
    const events: string[] = [];
    service.connections.set(mysqlId, {
      id: mysqlId, name: 'mysql', connected: false, db_type: 'mysql',
      config: { ...config, db_type: 'mysql' },
      pool: {}, pgClient: null, oracleConnection: null, oraclePool: null, dmConnection: null,
    });
    vi.spyOn(databaseService, 'removeConnection').mockImplementation(async () => { events.push('close'); });
    vi.spyOn(databaseService, 'addConnection').mockImplementation(async () => {
      events.push('replace');
      return true;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const owner = withInstanceExecutionLock(mysqlId, async () => {
      events.push('owner-enter');
      await gate;
      events.push('owner-leave');
    });
    await vi.waitUntil(() => events.includes('owner-enter'));
    const pending = databaseService.reconnect(mysqlId);
    await vi.waitUntil(() => events.includes('replace'));
    expect(events).toEqual(['owner-enter', 'close', 'replace']);
    release();
    await owner;
    expect(await pending).toBe(true);
  });
});
