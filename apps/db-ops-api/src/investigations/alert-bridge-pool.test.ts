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
  it('MAX-385: ten legacy admissions do not deadlock after simultaneous historical scans', async () => {
    const f = await bridgeTestFixture(10);
    const acquire = f.pool.getConnection.bind(f.pool);
    const restoreConnections: Array<() => void> = [];
    const errors: string[] = [];
    let arrived = 0, timedOut = false;
    let open!: () => void;
    const scanned = new Promise<void>(resolve => { open = resolve; });
    const timeout = setTimeout(() => { timedOut = true; open(); }, 10_000);
    try {
      f.flags.manual = false; f.flags.opsAuto = false;
      const [db] = await f.pool.query<any[]>('SELECT DATABASE() AS name');
      f.pool.getConnection = async () => {
        const c = await acquire(), execute = c.execute.bind(c);
        let firstScan = true;
        restoreConnections.push(() => { c.execute = execute; });
        c.execute = (async (sql: string, values?: any) => {
          let result;
          try { result = await execute(sql, values); }
          catch (error) { errors.push((error as { code: string }).code); throw error; }
          if (firstScan && sql.includes('d.analysis_id IS NULL') && sql.includes('FOR UPDATE')) {
            firstScan = false;
            if (++arrived === 10) {
              try {
                const [locks] = await f.admin.query<any[]>(`SELECT INDEX_NAME, LOCK_TYPE, LOCK_MODE, COUNT(*) AS n,
                  SUM(LOCK_DATA='supremum pseudo-record') AS supremum
                  FROM performance_schema.data_locks WHERE OBJECT_SCHEMA=? AND OBJECT_NAME='ai_analysis'
                  GROUP BY INDEX_NAME, LOCK_TYPE, LOCK_MODE`, [db[0].name]);
                console.info('MAX385 historical scan locks', JSON.stringify(locks));
              } finally { open(); }
            }
            await scanned;
          }
          return result;
        }) as typeof c.execute;
        return c;
      };
      const sources = Array.from({ length: 10 }, (_, i) => f.source(1385 + i));
      const outcomes = await Promise.allSettled(sources.map(source =>
        f.alertBridge.dispatch(source, 'manual', f.owner, f.oldFor(source))));
      if (errors.length) {
        const [status] = await f.admin.query<any[]>('SHOW ENGINE INNODB STATUS');
        const deadlock = String(status[0].Status).split('LATEST DETECTED DEADLOCK')[1]?.split('TRANSACTIONS')[0] ?? '';
        if (deadlock.includes(db[0].name)) console.info('MAX385 deadlock locks', deadlock.split('\n')
          .filter(line => /index .* of table|lock_mode|insert intention|WE ROLL BACK/.test(line)).join('\n'));
      }
      expect(timedOut).toBe(false);
      expect(arrived).toBe(10);
      expect(errors).toEqual([]);
      expect(outcomes.filter(outcome => outcome.status === 'rejected')).toEqual([]);
      const ids = outcomes.map(outcome => outcome.status === 'fulfilled' ? outcome.value.analysisId : undefined);
      expect(new Set(ids).size).toBe(10);
      expect(ids.every(Boolean)).toBe(true);
      for (const table of ['ai_analysis', 'analysis_dispatch_keys', 'analysis_dispatches', 'outbox_events', 'workflow_jobs'])
        expect(await f.count(table)).toBe(10);
      const again = await Promise.all(sources.map(source => f.alertBridge.dispatch(source, 'manual', f.owner, f.oldFor(source))));
      expect(again.map(result => result.analysisId)).toEqual(ids);
      expect(await f.count('workflow_jobs')).toBe(10);
      expect(await f.count('agent_runs')).toBe(0);
      expect(await f.count('llm_usage_records')).toBe(0);
      for (const source of sources) {
        const lock = `slide-alert:${createHash('sha256').update(`${db[0].name}:${source.id}`).digest('hex').slice(0, 48)}`;
        const [locks] = await f.pool.query<any[]>('SELECT IS_USED_LOCK(?) AS owner', [lock]);
        expect(locks[0].owner).toBeNull();
      }
      // Admission isolation must not leak into the next transaction on a pooled connection.
      const c = await acquire();
      try {
        await c.beginTransaction();
        await c.query('SELECT id FROM ai_analysis WHERE instance_id=999999 FOR UPDATE');
        const [locks] = await f.admin.query<any[]>(`SELECT LOCK_MODE FROM performance_schema.data_locks
          WHERE OBJECT_SCHEMA=? AND OBJECT_NAME='ai_analysis' AND LOCK_TYPE='RECORD'`, [db[0].name]);
        expect(locks.length).toBeGreaterThan(0);
        expect(locks.some(lock => lock.LOCK_MODE === 'X' || lock.LOCK_MODE.includes('GAP'))).toBe(true);
        await c.rollback();
      } finally { c.release(); }
    } finally {
      clearTimeout(timeout); open();
      f.pool.getConnection = acquire;
      for (const restore of restoreConnections) restore();
      await f.close();
    }
  }, 120_000);

  it('MAX-385: failed legacy admission rolls back all intents, releases the source lock and keeps the chosen lane', async () => {
    const f = await bridgeTestFixture(1);
    try {
      f.flags.manual = false;
      const source = f.source(2385);
      await f.pool.query(`CREATE TRIGGER max385_fail_intent BEFORE INSERT ON outbox_events
        FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='MAX385_INTENT_FAILURE'`);
      await expect(f.alertBridge.dispatch(source, 'manual', f.owner, f.oldFor(source))).rejects.toThrow('MAX385_INTENT_FAILURE');
      expect(f.oldCalls()).toBe(1);
      for (const table of ['ai_analysis', 'analysis_dispatch_keys', 'analysis_dispatches', 'outbox_events', 'workflow_jobs'])
        expect(await f.count(table)).toBe(0);
      const [owners] = await f.pool.query<any[]>('SELECT lane, analysis_id FROM investigation_alert_owners');
      expect(owners).toEqual([{ lane: 'legacy', analysis_id: null }]);
      const [db] = await f.pool.query<any[]>('SELECT DATABASE() AS name');
      const lock = `slide-alert:${createHash('sha256').update(`${db[0].name}:${source.id}`).digest('hex').slice(0, 48)}`;
      const [locks] = await f.pool.query<any[]>('SELECT IS_USED_LOCK(?) AS owner', [lock]);
      expect(locks[0].owner).toBeNull();
      await f.pool.query('DROP TRIGGER max385_fail_intent');
      // A new caller action after a confirmed rollback recovers the same lane.
      const result = await f.alertBridge.dispatch(source, 'manual', f.owner, f.oldFor(source));
      const again = await f.alertBridge.dispatch(source, 'manual', f.owner, f.oldFor(source));
      expect(result.success).toBe(true);
      expect(again.analysisId).toBe(result.analysisId);
      expect(f.oldCalls()).toBe(2);
      expect(await f.count('workflow_jobs')).toBe(1);
      expect(await f.count('agent_runs')).toBe(0);
      expect(await f.count('llm_usage_records')).toBe(0);
    } finally { await f.close(); }
  }, 120_000);

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
