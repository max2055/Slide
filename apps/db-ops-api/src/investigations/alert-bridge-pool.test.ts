import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { bridgeTestFixture } from './bridge-test-fixture.js';
import { DatabaseAlertBridge } from './alert-bridge.js';
import { dispatchOrReuse } from '../ai-agent-bridge.js';

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
  it('legacy production prompt/model configuration and enqueue share one reserved connection', async () => {
    const f = await bridgeTestFixture(1);
    try {
      f.flags.manual = false;
      await f.pool.query('UPDATE llm_providers SET enabled=0,is_default=0');
      await f.pool.query('DELETE FROM llm_scene_bindings');
      await f.pool.query(`INSERT INTO llm_providers
        (name,display_name,deployment_type,default_model,supports_function_call,enabled,is_default)
        VALUES ('t08-pool-local','Controlled no-network config','api','controlled-local',1,1,1)`);
      const restore = acquisitionBarrier(f.pool, 1);
      try {
        const results = await Promise.all(Array.from({length:10}, (_, i) => f.source(901+i)).map(alert =>
          f.alertBridge.dispatch(alert, 'manual', f.owner, async connection => {
            const result = await dispatchOrReuse({type:'alert_rca',cacheKey:`alert:${alert.id}:instance:101`,
              instanceId:101,sessionKey:`rca-${alert.id}`,triggerType:'manual',actor:f.owner,
              relatedId:alert.id,userMessage:alert.message}, connection);
            // Enqueue commits but must not release the source's session lock.
            const [database] = await connection.query<any[]>('SELECT DATABASE() AS name');
            const lock = `slide-alert:${createHash('sha256').update(`${database[0].name}:${alert.id}`).digest('hex').slice(0,48)}`;
            const [locks] = await connection.query<any[]>('SELECT IS_USED_LOCK(?) AS owner, CONNECTION_ID() AS current',
              [lock]);
            expect(locks[0].owner).toBe(locks[0].current);
            return {success:result.success !== false,analysisId:result.analysisId,status:result.status};
          })));
        expect(results.every(result => result.success && result.analysisId)).toBe(true);
        expect(await f.count('analysis_dispatches')).toBe(10);
        expect(await f.count('workflow_jobs')).toBe(10);
        expect(await f.count('agent_runs')).toBe(0);
        expect(await f.count('llm_usage_records')).toBe(0);
      } finally { restore(); }
    } finally { await f.close(); }
  }, 120_000);

  it('independent pools (independent local queues) still serialize 50 same-source entrants', async () => {
    const f = await bridgeTestFixture(2), peer = f.openPeerPool();
    try {
      const other = new DatabaseAlertBridge(() => peer, f.contexts, f.authorization, f.bridge, () => f.flags,
        () => ({configured:true,serviceUserId:f.serviceId,instanceIds:[101,102],policyId:'database-alert-pilot',policyVersion:1}));
      const source = f.source(999);
      const results = await Promise.all(Array.from({length:50}, (_, i) =>
        (i % 2 ? other : f.alertBridge).dispatch(source, 'manual', f.owner, f.oldFor(source))));
      expect(new Set(results.map(result => result.investigationId)).size).toBe(1);
      expect(results.every(result => result.success && result.investigationId)).toBe(true);
      for (const table of ['investigation_alert_owners','investigations','investigation_requests','workflow_jobs'])
        expect(await f.count(table)).toBe(1);
      expect(f.oldCalls()).toBe(0);
    } finally { await peer.end(); await f.close(); }
  }, 120_000);

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
