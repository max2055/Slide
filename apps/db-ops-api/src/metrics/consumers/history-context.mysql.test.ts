import mysql, { type Pool } from 'mysql2/promise';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { baseline, portOf } from '../triggers/test-support.js';
import { resolveTriggerRules } from '../triggers/resolve.js';
import { compileTriggerSnapshot } from '../triggers/compile.js';
import { stageTriggerSnapshot } from '../triggers/persistence.js';
import { readHistoryContext } from './history-context.js';

const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
describe.skipIf(!port || port === 3306)('immutable history context over isolated MySQL', () => {
  let root: Pool, pool: Pool;
  const database = `max240_context_${process.pid}`;
  const ref = { type: 'instance' as const, id: 7 };
  const from = '2026-10-29T11:00:00.000Z', to = '2026-10-29T13:00:00.000Z';
  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    const b = await baseline();
    const candidate = await resolveTriggerRules(b.resolution, b.catalog, portOf([b.version]).port);
    const snapshot = compileTriggerSnapshot(candidate);
    const c = await pool.getConnection();
    try { await stageTriggerSnapshot(c, snapshot); } finally { c.release(); }
    // Minimal persisted episode projection for the read side; writer acceptance is MAX239.
    for (const [id, opened, closed, resource] of [
      [1, '2026-10-29T10:00:00.000Z', null, 7],
      [2, '2026-10-29T09:00:00.000Z', from, 7],
      [3, to, null, 7], [4, from, null, 8],
    ] as const) {
      const episode = { resource: { type: 'instance', id: String(resource) }, rule_id: 'alpha-threshold', version: 1,
        opened_at: opened, closed_at: closed, unknown_segments: [{ from: '2026-10-29T12:00:00.000Z', to: null, reason: 'nodata' }] };
      await pool.execute(`INSERT INTO metric_trigger_episodes(episode_id,identity_hash,resource_key,config_revision,event_id,alert_id,payload,snapshot)
        VALUES(?,?,?,4,?,?,?,?)`, [`sha256:${String(id).repeat(64)}`, `sha256:${String(id).repeat(64)}`, `instance:${resource}`, id, id, JSON.stringify(episode), JSON.stringify({ configuration: snapshot })]);
    }
  }, 120000);
  afterAll(async () => { await pool?.end(); if (root) { await root.query(`DROP DATABASE IF EXISTS ${database}`); await root.end(); } });
  it('selects exact sample revisions without current-configuration backfill and intersects episodes half-open', async () => {
    const result = await readHistoryContext(pool, ref, from, to, [4,4,5], true);
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0].config_revision).toBe(4);
    expect(result.missing_revisions).toEqual([5]);
    expect(result.events.map(e => e.event_id)).toEqual([1]);
    expect(result.events[0].unknown_segments).toHaveLength(1);
    const before = JSON.stringify(result.snapshots);
    await pool.execute("INSERT INTO metric_policy_audit(target,payload) VALUES('instance:7',?)", [JSON.stringify({ current_threshold: 999 })]);
    expect(JSON.stringify((await readHistoryContext(pool, ref, from, to, [4], true)).snapshots)).toBe(before);
    const hidden = await readHistoryContext(pool, ref, from, to, [4], false);
    expect(hidden.events_readable).toBe(false); expect(hidden.events).toEqual([]);
    expect(hidden.retention.historyMs).toBeGreaterThan(0);
  });
  it('fails closed on altered immutable snapshot bodies', async () => {
    await pool.execute("UPDATE metric_trigger_snapshots SET payload=JSON_SET(payload,'$.rules[0].problem.threshold.value',999) WHERE resource_key='instance:7'");
    await expect(readHistoryContext(pool, ref, from, to, [4], false)).rejects.toThrow('TRIGGER_SNAPSHOT_HASH_MISMATCH');
  });
});
