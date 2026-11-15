import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformLogs } from '../../platform/structured-log-evidence-adapter.js';
import { createBuiltinRegistry } from '../packages/builtins.js';
import { PolicyError, type Published } from '../policy/model.js';
import { MetricScheduler } from './service.js';
import type { MysqlScheduleStore, TemplateScheduleItem } from './store.js';

const packages = createBuiltinRegistry();
const access = { resolve: vi.fn() };
afterEach(() => vi.restoreAllMocks());

function setup(kind: 'published' | 'templates', failAt: number, phase: 'formalization' | 'enqueue', error: unknown) {
  // Only the per-resource orchestration is under test here; MySQL tests exercise
  // actual compiled policies, transactions and queue rows.
  const bindings = [1, 2, 3].map(id => ({ resource: { type: 'server' as const, id }, revision: 7 }));
  const reconcile = vi.fn(async (ref: { id: number }) => {
    if (ref.id === failAt && phase === 'formalization') throw error;
  });
  const enqueue = vi.fn(async (item: { binding?: typeof bindings[number]; decoded?: { binding: typeof bindings[number] } }) => {
    const id = (item.binding ?? item.decoded!.binding).resource.id;
    if (id === failAt && phase === 'enqueue') throw error;
    return id !== 2; // resource 2 may already have a pending job
  });
  const scan = vi.fn(async () => ({
    published: kind === 'published' ? bindings.map(binding => ({ binding })) as Published[] : [],
    templates: kind === 'templates' ? bindings.map(binding => ({ resource_key: `server:${binding.resource.id}`, decoded: { binding } })) as TemplateScheduleItem[] : [],
    rejected: [],
  }));
  const store = { scan, enqueue, enqueueTemplate: enqueue } as unknown as MysqlScheduleStore;
  const scheduler = new MetricScheduler(store, packages, access, () => 1000, undefined, { reconcile });
  return { scheduler, scan, reconcile, enqueue };
}

describe('MAX-522 resource scheduling isolation', () => {
  for (const kind of ['published', 'templates'] as const) {
    for (const phase of ['formalization', 'enqueue'] as const) {
      for (const failed of [1, 2, 3]) {
        it(`${kind}: ${phase} failure at ${failed} cannot starve later resources across ticks`, async () => {
          const record = vi.spyOn(platformLogs, 'record').mockImplementation(() => {});
          const { scheduler, reconcile, enqueue } = setup(kind, failed, phase, new PolicyError('PLAN_IDENTITY'));
          for (let tick = 0; tick < 2; tick++) expect(await scheduler.tick()).toBe(failed === 2 ? 2 : 1);
          expect(reconcile.mock.calls.map(([ref]) => ref.id)).toEqual([1, 2, 3, 1, 2, 3]);
          expect(enqueue).toHaveBeenCalledTimes(phase === 'enqueue' ? 6 : 4);
          expect(record).toHaveBeenCalledTimes(2);
          expect(record).toHaveBeenCalledWith({ component: 'metrics', eventType: `collection.${phase}_failed`,
            status: 'failed', errorCode: 'PLAN_IDENTITY', correlationId: `server:${failed}` });
        });
      }
      for (const error of [
        Object.assign(new Error('private driver detail'), { code: 'ECONNREFUSED' }),
        Object.assign(new Error('private SQL'), { code: 'ER_NO_SUCH_TABLE', errno: 1146, sqlState: '42S02' }),
        new Error('Pool is closed.'), new Error('Queue limit reached.'),
        new PolicyError('SCHEDULE_STORE_UNAVAILABLE'), new PolicyError('SOURCE_POLICY_LOCK_UNAVAILABLE'),
      ]) {
        it(`${kind}: ${phase} propagates shared failure ${'code' in error ? error.code : error.message}`, async () => {
          const { scheduler, reconcile, enqueue } = setup(kind, 1, phase, error);
          await expect(scheduler.tick()).rejects.toBe(error);
          expect(reconcile).toHaveBeenCalledTimes(1);
          expect(enqueue).toHaveBeenCalledTimes(phase === 'enqueue' ? 1 : 0);
        });
      }
    }
  }
  it('isolates a row-specific MySQL data error while keeping its stable diagnostic', async () => {
    const record = vi.spyOn(platformLogs, 'record').mockImplementation(() => {});
    const error = Object.assign(new Error('private SQL/value'), { code: 'ER_DATA_TOO_LONG', errno: 1406, sqlState: '22001' });
    const { scheduler } = setup('published', 1, 'enqueue', error);
    expect(await scheduler.tick()).toBe(1);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'ER_DATA_TOO_LONG', correlationId: 'server:1' }));
    expect(JSON.stringify(record.mock.calls)).not.toContain('private');
  });
  it('reports unknown resource exceptions without leaking exception text', async () => {
    const record = vi.spyOn(platformLogs, 'record').mockImplementation(() => {});
    const { scheduler } = setup('published', 1, 'formalization', new Error('password=private'));
    expect(await scheduler.tick()).toBe(1);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'METRIC_RESOURCE_SCHEDULE_FAILED' }));
    expect(JSON.stringify(record.mock.calls)).not.toContain('private');
  });
  it('propagates a global scan failure without trying any resource', async () => {
    const { scheduler, scan, reconcile } = setup('published', 0, 'enqueue', null);
    scan.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(scheduler.tick()).rejects.toThrow('database unavailable');
    expect(reconcile).not.toHaveBeenCalled();
  });
});
