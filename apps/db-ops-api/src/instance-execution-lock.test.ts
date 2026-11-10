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
