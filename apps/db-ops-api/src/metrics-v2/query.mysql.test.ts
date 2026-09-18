import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../migrations/runner.js';
import type { MigrationPool } from '../migrations/types.js';
import { definitions, identify, sample } from '../contracts/metrics-v2/fixtures.js';
import type { MetricDefinition, NormalizedObservation } from '../contracts/metrics-v2/index.js';
import { aggregate, SemanticQueryService, type SemanticQuery } from './query.js';
import { MysqlMetricStorage, seriesHash } from './storage.js';

// Opt-in disposable localhost MySQL. Does not open the application database or .env.
const port = Number(process.env.METRICS_V2_TEST_MYSQL_PORT);
describe.skipIf(!port)('semantic query isolated MySQL', () => {
  const database = `max68_${process.pid}`;
  let admin: Pool, pool: Pool, storage: MysqlMetricStorage;
  const definition: MetricDefinition = { ...definitions[0], aggregation: { ...definitions[0].aggregation, min_coverage: 0.5 } };
  const template = sample(definition.id);
  const series = { resource_type: template.resource_type, resource_id: template.resource_id,
    metric: template.metric, dimensions: template.dimensions };
  const origin = Date.parse('2026-09-01T00:00:00Z');
  const at = (s: number) => new Date(origin + s * 1000).toISOString();
  const point = (seconds: number, value: number): NormalizedObservation => identify({ ...template,
    observed_at: at(seconds), collected_at: at(seconds), stored_at: null,
    value: { encoding: 'float64', value }, source: { ...template.source, attempt_id: `mysql-${seconds}` } });
  const query: SemanticQuery = { definition, series: [series], from: at(0), to: at(40), now: at(45), mode: 'mean',
    weighting: 'time', space: 'none', interval_ms: 10000, bucket_ms: 20000, max_gap_ms: 30000, stale_after_ms: 30000 };

  beforeAll(async () => {
    admin = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '' });
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root', password: '', database, timezone: 'Z' });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
    storage = new MysqlMetricStorage(pool, () => new Date(at(60)));
  }, 120000);
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); }
  });

  it('reads an indexed half-open range with predecessor/successor; SQL and pure downsampling agree', async () => {
    const rows = [point(0, 2), point(10, 4), point(30, 8), point(40, 100)];
    for (const row of rows) await storage.write(row, definition);
    const fromSql = await storage.queryWindow(series, at(10), at(40));
    expect(fromSql.map(r => r.id)).toEqual(rows.map(r => r.id));
    await expect(storage.queryWindow(series, at(0), at(40), 2)).rejects.toThrow('QUERY_LIMIT_EXCEEDED');
    const [plan] = await pool.query<RowDataPacket[]>(`EXPLAIN FORMAT=TRADITIONAL SELECT payload FROM metric_v2_observations FORCE INDEX (idx_metric_v2_range)
      WHERE series_hash = ? AND stage = 'normalized' AND observed_at >= ? AND observed_at < ? ORDER BY observed_at ASC, id ASC LIMIT 1001`,
    [seriesHash(series), '2026-09-01 00:00:00', '2026-09-01 00:00:40']);
    expect(plan[0].key).toBe('idx_metric_v2_range');
    const service = new SemanticQueryService(storage, async () => true);
    const buckets = await service.query(query);
    expect(buckets).toEqual(aggregate(query, [rows]));
    expect(buckets.map(b => b.value && 'value' in b.value ? b.value.value : null)).toEqual([3, 6]);
    expect(buckets.map(b => b.coverage)).toEqual([1, 1]);
  });

  it('denies a series before SQL and keeps inventory outside metric observations', async () => {
    await expect(new SemanticQueryService(storage, async () => false).query(query)).rejects.toThrow('QUERY_FORBIDDEN');
    expect(await storage.inventory('instance', 'db-1')).toBeNull();
    expect((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS total FROM metric_v2_inventory'))[0][0].total).toBe(0);
  });

  it('keeps reset-aware counter buckets equal to the pure reducer across SQL window edges', async () => {
    const counter: MetricDefinition = { ...definitions[3], aggregation: { ...definitions[3].aggregation, min_coverage: 0.5 } };
    const reference = sample(counter.id);
    const counterSeries = { resource_type: reference.resource_type, resource_id: reference.resource_id,
      metric: reference.metric, dimensions: reference.dimensions };
    const points = [100, 140, 5, 35, 75].map((value, i) => identify({ ...reference,
      observed_at: at(i * 10), collected_at: at(i * 10), stored_at: null,
      value: { encoding: 'uint64' as const, value: String(value) },
      counter: { bits: '64' as const, start_at: at(i >= 2 ? 20 : 0) },
      source: { ...reference.source, attempt_id: `counter-${i}` } }));
    for (const row of points) await storage.write(row, counter);
    const request: SemanticQuery = { ...query, definition: counter, series: [counterSeries], from: at(5), to: at(35),
      mode: 'rate', weighting: undefined, bucket_ms: 10000 };
    const actual = await new SemanticQueryService(storage, async () => true).query(request);
    expect(actual).toEqual(aggregate(request, [points]));
    expect(actual.map(b => b.value && 'value' in b.value ? b.value.value : null)).toEqual([4, 3, 3.5]);
  });
});
