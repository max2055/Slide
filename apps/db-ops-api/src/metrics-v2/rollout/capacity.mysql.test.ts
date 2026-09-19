import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { definitions, sample, identify } from '../../contracts/metrics-v2/fixtures.js';
import { MysqlMetricStorage } from '../storage.js';
import { RolloutControl } from './control.js';

const port = Number(process.env.METRICS_V2_TEST_MYSQL_PORT);
describe.skipIf(!port)('bounded three-class persistence capacity and rollback', () => {
  const database = `max76_capacity_${process.pid}`;
  let root: Pool, pool: Pool;
  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, connectionLimit: 8 });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
  }, 120000);
  afterAll(async () => { await pool?.end(); if (root) { await root.query(`DROP DATABASE IF EXISTS ${database}`); await root.end(); } });
  it('test resources then expanded isolated inventory; retains raw evidence and formal history on rollback', async () => {
    const control = new RolloutControl(pool), storage = new MysqlMetricStorage(pool);
    const defs = [definitions[0], definitions[1], definitions[4]];
    const inventory = defs.flatMap((d, kind) => Array.from({ length: 4 }, (_, resource) =>
      Array.from({ length: [1, 2, 4][kind] }, (_, dimension) => ({ definition: d, observation: identify({ ...sample(d.id),
        resource_id: String(100 + resource), dimensions: { ...sample(d.id).dimensions,
          ...(kind === 1 ? { mount: `/fixture-${dimension}` } : kind === 2 ? { if_index: String(dimension) } : {}) } }) })))).flat();
    const target = { source: 'v2', read: 'v2' as const, revision: 1,
      package: { id: 'fixture', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` } };
    const ticket = { source: 'v2', generation: 1, revision: 1 };
    const writes: number[] = [], reads: number[] = [], diff: unknown[] = [];
    for (const item of inventory) { await control.initialize(item.observation, target); await control.applied(item.observation, ticket); }
    const start = performance.now();
    let count = 0;
    // Fixed inventory/order, no random data. First one resource per class, then remaining resources.
    for (const group of [inventory.filter(i => i.observation.resource_id === '100'), inventory.filter(i => i.observation.resource_id !== '100')]) {
      for (let round = 0; round < 10; round++) {
        for (let offset = 0; offset < group.length; offset += 4) await Promise.all(group.slice(offset, offset + 4).map(async item => {
          const at = new Date(Date.parse('2026-09-01T00:00:00Z') + round * 60000).toISOString();
          const { lineage: _lineage, ...base } = item.observation;
          const raw = identify({ ...base, stage: 'raw' as const, raw_field: 'fixture', observed_at: at, collected_at: at, stored_at: at });
          const o = identify({ ...item.observation, observed_at: at, collected_at: at, stored_at: at, lineage: [{ id: raw.id, stage: 'raw' as const }] });
          const writeStart = performance.now(); await storage.write(raw, item.definition); await control.publish(o, item.definition, ticket);
          writes.push(performance.now() - writeStart);
          const readStart = performance.now(); const formal = await control.latest(o, async () => null); reads.push(performance.now() - readStart);
          expect(formal?.value).toEqual(o.value); expect(formal?.quality).toEqual(o.quality); count++;
          if (!round && o.resource_id === '100') diff.push({ evidence: 'contract fixture + real MySQL', metric: o.metric, dimensions: o.dimensions,
            legacy_fixture_value: o.value, raw: raw.value, normalized: formal?.value, quality: o.quality, observed_at: at,
            versions: o.versions, lineage: o.lineage, difference: 0 });
        }));
      }
    }
    const elapsed = performance.now() - start;
    const percentiles = (values: number[]) => { const s = [...values].sort((a, b) => a - b);
      return { p50: s[Math.ceil(s.length * .5) - 1], p95: s[Math.ceil(s.length * .95) - 1], p99: s[Math.ceil(s.length * .99) - 1] }; };
    const [bytes] = await pool.query<RowDataPacket[]>('SELECT stage, COUNT(*) AS points, SUM(OCTET_LENGTH(payload)) AS bytes FROM metric_v2_observations GROUP BY stage');
    const [indexes] = await pool.query<RowDataPacket[]>(`SELECT TABLE_NAME, DATA_LENGTH, INDEX_LENGTH FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('metric_v2_observations', 'metric_v2_publications', 'metric_v2_rollout', 'metric_v2_alert_transitions', 'metric_v2_alert_state')`, [database]);
    const perPoint = (stage: string) => Number(bytes.find(b => b.stage === stage)!.bytes) / count;
    const pointsPerDay = inventory.length * 86400 / 60;
    const indexPerPoint = indexes.reduce((sum, r) => sum + Number(r.INDEX_LENGTH), 0) / count;
    const projected = pointsPerDay * (perPoint('raw') * 7 + perPoint('normalized') * 30 + 128 * 23 + 512 * 7 + 1024 * 30 + indexPerPoint * 30) + inventory.length * 2048;
    const throughput = count / (elapsed / 1000), required = inventory.length / 60 * 2;
    expect(throughput).toBeGreaterThan(required); expect(percentiles(writes).p95).toBeLessThan(1000);
    const [before] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM metric_v2_observations');
    for (const i of inventory) await control.switch(i.observation, 1, { ...target, source: 'legacy', read: 'legacy', revision: 2 });
    const [after] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM metric_v2_observations'); expect(after).toEqual(before);
    const report = { evidence: 'synthetic contract values; real isolated MySQL writes/reads; not collector throughput',
      mysql: (await pool.query<RowDataPacket[]>('SELECT VERSION() AS version'))[0][0].version,
      resources: 12, series: inventory.length, dimensions_per_resource: [1, 2, 4], period_seconds: 60, rounds: 10,
      peak_concurrency: 4, points: count, elapsed_ms: elapsed, errors: 0, publish_pairs_per_second: throughput,
      required_2x_pairs_per_second: required, write_ms: percentiles(writes), query_ms: percentiles(reads), bytes, table_allocations: indexes,
      capacity: { points_per_day: pointsPerDay, raw_days: 7, normalized_days: 30, tombstone_days: 23,
        assumed_tombstone_bytes: 128, assumed_attempt_bytes: 512, attempt_days: 7, assumed_transition_bytes: 1024, transition_days: 30, assumed_control_state_bytes_per_series: 2048, measured_index_bytes_per_pair: indexPerPoint,
        projected_bytes: projected, with_30_percent_headroom_and_one_backup_bytes: Math.ceil(projected * 1.3 * 2) },
      differences: diff, data_preserved_on_rollback: true, persistence_gate: 'go', production_gate: 'not authorized' };
    if (process.env.MAX76_CAPACITY_REPORT) await writeFile(process.env.MAX76_CAPACITY_REPORT, JSON.stringify(report, null, 2) + '\n');
  }, 120000);
});
