import { describe, expect, it } from 'vitest';
import { bridgeTestFixture } from './bridge-test-fixture.js';

// Make the reviewed cycle deterministic. Bound failed acquisition only in the
// test, and release late grants so RED evidence cannot orphan a pool waiter.
function acquisitionBarrier(pool: Awaited<ReturnType<typeof bridgeTestFixture>>['pool'], limit: number) {
  const original = pool.getConnection.bind(pool);
  let acquired = 0;
  let open!: () => void;
  const barrier = new Promise<void>(resolve => open = resolve);
  pool.getConnection = async () => {
    let expired = false;
    let timer!: ReturnType<typeof setTimeout>;
    const pending = original().then(c => {
      if (expired) { c.release(); throw new Error('LATE_CONNECTION'); }
      return c;
    });
    const c = await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error('NESTED_POOL_ACQUISITION_TIMEOUT')); }, 2_500);
    })]).finally(() => clearTimeout(timer));
    if (++acquired <= limit) {
      if (acquired === limit) open();
      await barrier;
    }
    return c;
  };
  return () => { pool.getConnection = original; };
}

describe('T08-POOL-01 different sources with a fixed MySQL pool', () => {
  for (const limit of [1, 2, 10]) {
    for (const lane of ['auto', 'manual', 'legacy'] as const) {
      it(`${lane}: 10 different alert IDs complete with connectionLimit=${limit}`, async () => {
        const f = await bridgeTestFixture(limit);
        const restore = acquisitionBarrier(f.pool, limit);
        try {
          if (lane === 'legacy') { f.flags.manual = false; f.flags.opsAuto = false; }
          const beforeJobs = await f.count('workflow_jobs');
          const sources = Array.from({ length: 10 }, (_, i) => f.source(801 + i));
          const outcomes = await Promise.allSettled(sources.map(alert => f.alertBridge.dispatch(alert,
            lane === 'auto' ? 'auto' : 'manual', lane === 'auto' ? undefined : f.owner, f.oldFor(alert))));
          expect(outcomes.filter(outcome => outcome.status === 'rejected')).toEqual([]);
          const results = outcomes.map(outcome => {
            if (outcome.status !== 'fulfilled') throw outcome.reason;
            return outcome.value;
          });
          expect(results.every(result => result.success)).toBe(true);
          const [owners] = await f.pool.query<any[]>('SELECT * FROM investigation_alert_owners ORDER BY alert_id');
          expect(owners).toHaveLength(10);
          if (lane === 'legacy') {
            expect(owners.every(owner => owner.lane === 'legacy' && owner.analysis_id && !owner.investigation_id)).toBe(true);
            expect(await f.count('analysis_dispatches')).toBe(10);
            expect(await f.count('investigations')).toBe(0);
          } else {
            expect(owners.every(owner => owner.lane === 'investigation' && owner.investigation_id && !owner.analysis_id)).toBe(true);
            expect(await f.count('analysis_dispatches')).toBe(0);
            // Automatic sources aggregate deterministically; manual sources
            // each retain their own immutable admission key.
            expect(await f.count('investigations')).toBe(lane === 'auto' ? 1 : 10);
          }
          expect(await f.count('workflow_jobs')).toBe(beforeJobs + (lane === 'auto' ? 1 : 10));
          // Re-enter all sources after rollback of the flags: no second owner.
          f.flags.manual = false; f.flags.opsAuto = false;
          const again = await Promise.all(sources.map(alert => f.alertBridge.dispatch(alert, 'manual', f.owner, f.oldFor(alert))));
          expect(again.map(result => result.investigationId ?? result.analysisId)).toEqual(results.map(result => result.investigationId ?? result.analysisId));
          expect(await f.count('workflow_jobs')).toBe(beforeJobs + (lane === 'auto' ? 1 : 10));
        } finally { restore(); await f.close(); }
      }, 120_000);
    }
  }
});
