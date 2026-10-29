/**
 * MAX-238 / COLLECTION-DISPLAY-E2E-R2 — the template execution fence, proven on
 * real MySQL.
 *
 * The accepted legacy scheduler never commits an observation, attempt, source
 * check or cadence for an execution whose lease, revision, signal or collection
 * switch has changed. The template path reuses that fence; this suite is the
 * disclosure converted into a failing-first regression: an aborted signal, a
 * foreign owner, a stale fencing token, an expired lease, a switched-off asset
 * or a superseded revision must write nothing at all — and the row set is read
 * back from MySQL, not inferred from a mock.
 */
import mysql, { type Pool } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { createBuiltinRegistry } from '../packages/builtins.js';
import { decodeBindingPayload, encodeTemplatePendingPayload } from '../bindings/persistence-codec.js';
import type { ResourceBindingCandidate } from '../../contracts/metrics/templates.js';
import type { ClaimedJob, JobExecutionContext } from '../../workflows/worker-runtime.js';
import { MysqlScheduleStore, type TemplateExecutionSnapshot } from './store.js';

const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
const RESOURCE = { type: 'instance' as const, id: 1 };
const RESOURCE_KEY = 'instance:1';
/** The pending binding revision this execution belongs to. */
const REVISION = 4;
/** The plan is the base revision's resolution (the codec's own invariant). */
const PLAN_REVISION = REVISION - 1;
const JOB_ID = 'job-238-fence';
const WORKER = 'worker-238';
const AT = '2026-10-29T12:00:00.000Z';
const HASH = `sha256:${'a'.repeat(64)}` as const;
const PIN = { template_id: 'tpl-238', version: 1, content_hash: `sha256:${'b'.repeat(64)}` };

const plan = (revision: number) => ({
  kind: 'template_collection_plan' as const, internal: true as const,
  persisted: false as const, applied: false as const, executable: true,
  identity: HASH, resource: { type: 'instance' as const, id: String(RESOURCE.id) },
  revision,
  settings: { enabled: true, interval_ms: 60000, timeout_ms: 5000, stale_after_ms: 120000,
    max_counter_gap_ms: 300000, max_rows: 1000, max_concurrency: 1, max_series_per_resource: 100 },
  parameters: [], triggers: [], releases: [], excluded: [],
  budget: { estimate: true as const, request_unit: 'logical_reads' as const,
    estimated_series_upper_bound: 1, max_series_per_resource: 100, requests_per_hour_estimate: 60 },
});

/** A stored `templates-v1` row the real codec accepts; nothing about it is mocked. */
function templatePayload(): string {
  const binding: ResourceBindingCandidate = {
    resource: { ...RESOURCE }, package: null, group_id: null, overrides: {},
    revision: REVISION, template_pins: [PIN],
  } as ResourceBindingCandidate;
  return encodeTemplatePendingPayload({
    binding, base_revision: PLAN_REVISION, target_revision: REVISION, resolution_identity: HASH,
    plan: plan(PLAN_REVISION) as never, decided_at: AT, operation_key: 'op-238-fence',
    applied_revision: null, previous_resolution_identity: null, previous_effective: null, published_at: AT,
  });
}

const claimed = (fencingToken = 7): ClaimedJob => ({
  id: JOB_ID, type: 'metrics.collect', payload: { resource: RESOURCE, revision: REVISION },
  attempts: 1, maxAttempts: 3, fencingToken,
});
const context = (signal: AbortSignal = new AbortController().signal, workerId = WORKER, fencingToken = 7): JobExecutionContext =>
  ({ signal, workerId, fencingToken });

/** No observations are needed to prove the fence: an empty result still moves cadence. */
const noResults: Array<{ release: { id: string; version: string; digest: string }; result: never }> = [];
const failureResults = [{ release: { id: 'mysql-basic', version: '1.0.0', digest: `sha256:${'c'.repeat(64)}` },
  result: { observations: [], raw: [], attempts: [{ id: 'attempt-238', status: 'failed' }], capabilities: [],
    states: new Map(), decision: 'attempted' } as never }];

const ROWS = ['metric_observations', 'metric_attempts', 'metric_source_checks', 'metric_schedule_events',
  'metric_policy_audit', 'metric_publications'] as const;

describe.skipIf(!port)('template execution fence on isolated MySQL', () => {
  let root: Pool, pool: Pool, store: MysqlScheduleStore, snapshot: TemplateExecutionSnapshot;
  const database = `max238fence_${process.pid}`;

  const counts = async () => {
    const entries = await Promise.all(ROWS.map(async table => {
      const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM ${table}`) as unknown as [Array<{ n: number }>, unknown];
      return [table, Number(rows[0].n)] as const;
    }));
    const [schedule] = await pool.query('SELECT job_id, last_end_ms, next_due_ms, states FROM metric_schedule WHERE resource_key = ?',
      [RESOURCE_KEY]) as unknown as [Array<{ job_id: string | null; last_end_ms: number | null; next_due_ms: number; states: string }>, unknown];
    return { tables: Object.fromEntries(entries), schedule: schedule[0] };
  };

  const base = async () => {
    for (const table of [...ROWS, 'metric_schedule', 'metric_policy_bindings', 'workflow_jobs', 'database_instances']) {
      await pool.query(`DELETE FROM ${table}`);
    }
    await pool.query("INSERT INTO database_instances (id,name,host,port,username,password_encrypted,db_type,status) VALUES (1,'fence','127.0.0.1',3306,'root','fixture','mysql','active')");
    await pool.query('INSERT INTO metric_policy_bindings (resource_key, group_id, payload, capabilities) VALUES (?, NULL, ?, ?)',
      [RESOURCE_KEY, templatePayload(), '[]']);
    await pool.query('INSERT INTO metric_schedule (resource_key, revision, next_due_ms, states, job_id) VALUES (?, ?, ?, ?, ?)',
      [RESOURCE_KEY, REVISION, Date.now() + 60000, '{}', JOB_ID]);
    await pool.query(`INSERT INTO workflow_jobs (id, job_type, schema_version, payload, idempotency_key, state, attempts,
      lease_owner, lease_expires_at, fencing_token) VALUES (?, 'metrics.collect', 1, ?, 'fence-238', 'running', 1, ?, DATE_ADD(NOW(), INTERVAL 60 SECOND), 7)`,
    [JOB_ID, JSON.stringify({ resource: RESOURCE, revision: REVISION }), WORKER]);
  };

  beforeAll(async () => {
    root = mysql.createPool({ host: '127.0.0.1', timezone: 'Z', port, user: 'root', password: '' });
    await root.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ host: '127.0.0.1', timezone: 'Z', port, user: 'root', password: '', database, connectionLimit: 8 });
    await new MigrationRunner(pool as unknown as MigrationPool).run();
  }, 120000);
  afterAll(async () => {
    await pool?.end();
    if (root) { await root.query(`DROP DATABASE IF EXISTS ${database}`); await root.end(); }
  });
  beforeEach(async () => {
    await base();
    store = new MysqlScheduleStore(pool, createBuiltinRegistry());
    const decoded = decodeBindingPayload(String(templatePayload()));
    if (decoded.kind !== 'template_pending') throw new Error('fixture payload must decode as a pending template binding');
    snapshot = { decoded, plan: decoded.pending.plan, states: new Map(), tickets: new Map() };
  });

  it('commits cadence only while the lease, revision and switch still hold', async () => {
    const before = await counts();
    expect(await store.commitTemplate(snapshot, noResults, claimed(), context(), Date.now())).toBe(true);
    const after = await counts();
    expect(after.schedule.job_id).toBeNull();
    expect(Number(after.schedule.last_end_ms)).toBeGreaterThan(0);
    expect(after.schedule.next_due_ms).toBeGreaterThan(0);
    expect(after.tables.metric_observations).toBe(before.tables.metric_observations);
    expect(after.tables.metric_attempts).toBe(before.tables.metric_attempts);
  });

  describe('refuses to write anything for', () => {
    const nothingChanged = async (before: Awaited<ReturnType<typeof counts>>) => {
      const after = await counts();
      expect(after).toEqual(before);
    };

    it('a cancelled signal', async () => {
      const before = await counts();
      const controller = new AbortController();
      controller.abort(new Error('SCHEDULE_TIMEOUT'));
      await expect(store.commitTemplate(snapshot, noResults, claimed(), context(controller.signal), Date.now()))
        .rejects.toThrow();
      await nothingChanged(before);
    });

    it('an expired lease', async () => {
      await pool.query('UPDATE workflow_jobs SET lease_expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE id = ?', [JOB_ID]);
      const before = await counts();
      expect(await store.commitTemplate(snapshot, noResults, claimed(), context(), Date.now())).toBe(false);
      await nothingChanged(before);
    });

    it('a foreign lease owner', async () => {
      const before = await counts();
      expect(await store.commitTemplate(snapshot, noResults, claimed(), context(undefined, 'other-worker'), Date.now())).toBe(false);
      await nothingChanged(before);
    });

    it('a stale fencing token', async () => {
      const before = await counts();
      // The claimed lease carries token 7; an execution still holding 6 lost it.
      expect(await store.commitTemplate(snapshot, noResults, claimed(), context(undefined, WORKER, 6), Date.now())).toBe(false);
      await nothingChanged(before);
    });

    it('a job that is no longer running', async () => {
      await pool.query("UPDATE workflow_jobs SET state = 'cancelled' WHERE id = ?", [JOB_ID]);
      const before = await counts();
      expect(await store.commitTemplate(snapshot, noResults, claimed(), context(), Date.now())).toBe(false);
      await nothingChanged(before);
    });

    it('a collection switch that was turned off', async () => {
      await pool.query("UPDATE database_instances SET status = 'inactive' WHERE id = 1");
      const before = await counts();
      expect(await store.commitTemplate(snapshot, noResults, claimed(), context(), Date.now())).toBe(false);
      await nothingChanged(before);
    });

    it('a resource that is being deleted', async () => {
      await pool.query("UPDATE database_instances SET lifecycle_state = 'deleting' WHERE id = 1");
      const before = await counts();
      expect(await store.commitTemplate(snapshot, noResults, claimed(), context(), Date.now())).toBe(false);
      await nothingChanged(before);
    });

    it('a schedule row that was re-pointed at another job', async () => {
      await pool.query('UPDATE metric_schedule SET job_id = ? WHERE resource_key = ?', ['other-job', RESOURCE_KEY]);
      const before = await counts();
      expect(await store.commitTemplate(snapshot, noResults, claimed(), context(), Date.now())).toBe(false);
      await nothingChanged(before);
    });

    it('a superseded binding revision', async () => {
      // A newer pending revision replaced this row; the old execution must not
      // write cadence for it.
      const moved = encodeTemplatePendingPayload({
        binding: { ...snapshot.decoded.binding, revision: REVISION + 1 } as ResourceBindingCandidate,
        base_revision: REVISION, target_revision: REVISION + 1, resolution_identity: HASH,
        plan: plan(REVISION) as never, decided_at: AT, operation_key: 'op-238-fence-2',
        applied_revision: null, previous_resolution_identity: null, previous_effective: null, published_at: AT,
      });
      await pool.query('UPDATE metric_policy_bindings SET payload = ? WHERE resource_key = ?', [moved, RESOURCE_KEY]);
      const before = await counts();
      expect(await store.commitTemplate(snapshot, noResults, claimed(), context(), Date.now())).toBe(false);
      await nothingChanged(before);
    });

    it('a failure record under a stale lease', async () => {
      const before = await counts();
      await expect(store.recordTemplateFailure(snapshot, failureResults, claimed(), context(undefined, 'other-worker'), Date.now()))
        .rejects.toMatchObject({ code: 'SCHEDULE_STALE_EXECUTION' });
      await nothingChanged(before);
      expect((await counts()).tables.metric_attempts).toBe(0);
    });
  });

  it('records failed attempts only under a live lease', async () => {
    await store.recordTemplateFailure(snapshot, failureResults, claimed(), context(), Date.now());
    const after = await counts();
    expect(after.tables.metric_attempts).toBe(1);
    // A failure record never advances cadence: the job still owns it.
    expect(after.schedule.job_id).toBe(JOB_ID);
  });
});
