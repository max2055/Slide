import { createHash } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { MysqlMetricStorage } from '../metrics-v2/storage.js';
import { RolloutControl } from '../metrics-v2/rollout/control.js';
import { configuredRetention, type RetentionPolicy } from '../metrics-v2/retention.js';
import type { JobRegistry } from './job-registry.js';
import type { ClaimedJob, JobExecutionContext, WorkflowJobInput } from './worker-runtime.js';

export type MetricRetentionConfig = RetentionPolicy & {
  mode: 'dry-run' | 'apply'; limit: number; maxBatches: number; maxRunMs: number; intervalMs: number;
};
export function readMetricRetentionConfig(env: NodeJS.ProcessEnv = process.env): MetricRetentionConfig | null {
  if (env.METRICS_V2_RETENTION_ENABLED == null || env.METRICS_V2_RETENTION_ENABLED === 'false') return null;
  if (env.METRICS_V2_RETENTION_ENABLED !== 'true') throw new Error('RETENTION_CONFIG');
  if (['RAW', 'HISTORY', 'ATTEMPT'].some(name => !env[`METRICS_V2_RETENTION_${name}_MS`])) throw new Error('RETENTION_CONFIG');
  const policy = configuredRetention(env);
  const mode = env.METRICS_V2_RETENTION_MODE ?? 'dry-run';
  if (mode !== 'dry-run' && mode !== 'apply') throw new Error('RETENTION_CONFIG');
  const integer = (name: string, fallback: number, maximum: number) => {
    const value = Number(env[`METRICS_V2_RETENTION_${name}`] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('RETENTION_CONFIG');
    return value;
  };
  return { ...policy, mode, limit: integer('BATCH_LIMIT', 1000, 1000), maxBatches: integer('MAX_BATCHES', 5, 100),
    maxRunMs: integer('MAX_RUN_MS', 10000, 60000), intervalMs: integer('INTERVAL_MS', 3600000, 86400000) };
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function createMetricRetentionJob(availableAt = new Date(), predecessor?: string): WorkflowJobInput {
  const key = predecessor ? digest(predecessor) : `startup-${Math.floor(availableAt.getTime() / 1000)}`;
  return { id: `mrt-${digest(key).slice(0, 32)}`, type: 'metrics.retention', schemaVersion: 1, payload: {},
    idempotencyKey: `metric-retention:${key}`, availableAt, maxAttempts: 5 };
}
export function registerMetricRetentionHandler(registry: JobRegistry,
  run: (job: ClaimedJob, context: JobExecutionContext) => Promise<unknown>): void {
  registry.register('metrics.retention', async (_payload, job, context) => run(job, context));
}

/** Server and integration qualification share this exact production assembly entry. */
export async function startMetricRetention(pool: Pool, registry: JobRegistry,
  enqueue: (input: WorkflowJobInput) => Promise<void>, options: {
    env?: NodeJS.ProcessEnv; clock?: () => Date; report?: (data: Record<string, unknown>) => void;
  } = {}): Promise<void> {
  const env = options.env ?? process.env;
  // Validate before registering or enqueuing. Disabled jobs are acknowledged without side effects.
  readMetricRetentionConfig(env);
  const clock = options.clock ?? (() => new Date());
  const report = options.report ?? (data => console.info('[MetricRetention]', JSON.stringify(data)));
  registerMetricRetentionHandler(registry, async (job, context) => {
    const config = readMetricRetentionConfig(env);
    if (!config) return;
    context.signal.throwIfAborted();
    const started = Date.now();
    const policyHash = digest(JSON.stringify([config.rawMs, config.historyMs, config.attemptMs]));
    const storage = new MysqlMetricStorage(pool, clock, config);
    const rollout = new RolloutControl(pool, undefined, clock);
    const guard = async (c: PoolConnection) => {
      context.signal.throwIfAborted();
      if (!readMetricRetentionConfig(env)) throw new Error('RETENTION_DISABLED');
      const [rows] = await c.execute<RowDataPacket[]>(`SELECT id FROM workflow_jobs WHERE id = ? AND job_type = 'metrics.retention'
        AND state = 'running' AND lease_owner = ? AND fencing_token = ? AND lease_expires_at > NOW() FOR UPDATE`,
      [job.id, context.workerId, context.fencingToken]);
      if (rows.length !== 1) throw new Error('WORKFLOW_LEASE_LOST');
      context.signal.throwIfAborted();
    };
    // One maintenance owner across bootstrap, periodic successors and recovered leases.
    const owner = await pool.getConnection(); let locked = false;
    try {
      const [locks] = await owner.query<RowDataPacket[]>("SELECT GET_LOCK('slide:metric-retention', 0) AS acquired");
      locked = Number(locks[0].acquired) === 1;
      if (!locked) throw new Error('RETENTION_BUSY');
      await guard(owner);
      // Commit the periodic successor before any work. Failure/shutdown leaves durable recovery.
      const nextTick = Math.floor(clock().getTime() / config.intervalMs) + 1;
      await enqueue(createMetricRetentionJob(new Date(nextTick * config.intervalMs), `periodic:${config.intervalMs}:${nextTick}`));
      const [states] = await owner.query<RowDataPacket[]>('SELECT preview_policy_hash, preview_at FROM metric_v2_retention_state WHERE id = 1');
      if (states.length !== 1) throw new Error('RETENTION_STATE_REQUIRED');
      if (config.mode === 'apply' && states[0].preview_policy_hash !== policyHash) throw new Error('RETENTION_DRY_RUN_REQUIRED');
      const counts: Record<string, number> = {}; let batches = 0; let pending = false;
      const preview = { ...await storage.preview(), ...await rollout.previewRetention(config.historyMs) };
      pending = config.mode === 'apply' && Object.values(preview).some(v => v.count > 0);
      if (config.mode === 'apply') {
        for (; batches < config.maxBatches && Date.now() - started < config.maxRunMs;) {
          context.signal.throwIfAborted();
          const mutationGuard = async (c: PoolConnection) => {
            await guard(c);
            if (Date.now() - started >= config.maxRunMs) throw new Error('RETENTION_RUN_BUDGET');
          };
          const addCounts = (batch: Record<string, number>) => {
            for (const [name, count] of Object.entries(batch)) counts[name] = (counts[name] ?? 0) + count;
          };
          try {
            const observations = await storage.prune(config.limit, mutationGuard);
            addCounts(observations); batches++;
            // Drain expiry fully before touching publication/transition links.
            const links = observations.rawPayload === config.limit ? {} : await rollout.prune(config.limit, config.historyMs, mutationGuard);
            addCounts(links);
            pending = Object.values({ ...observations, ...links }).some(n => n > 0);
          } catch (error) {
            if ((error as Error).message !== 'RETENTION_RUN_BUDGET') throw error;
            pending = true; break;
          }
          if (!pending) break;
        }
      }
      context.signal.throwIfAborted();
      const data = { reason: 'configured_metric_retention', mode: config.mode, policyHash,
        policy: { rawMs: config.rawMs, historyMs: config.historyMs, attemptMs: config.attemptMs },
        batches, counts, preview, elapsedMs: Date.now() - started, pending, jobId: job.id, at: clock().toISOString() };
      await owner.beginTransaction();
      try {
        await guard(owner);
        await owner.execute(`UPDATE metric_v2_retention_state SET last_report = ?,
          preview_policy_hash = IF(? = 'dry-run', ?, preview_policy_hash),
          preview_at = IF(? = 'dry-run', UTC_TIMESTAMP(3), preview_at) WHERE id = 1`,
        [JSON.stringify(data), config.mode, policyHash, config.mode]);
        await guard(owner); await owner.commit();
      } catch (error) { await owner.rollback(); throw error; }
      if (pending) await enqueue(createMetricRetentionJob(new Date(clock().getTime() + 1000), `${job.id}:continuation`));
      report(data); return data;
    } finally {
      if (locked) {
        try {
          const [released] = await owner.query<RowDataPacket[]>("SELECT RELEASE_LOCK('slide:metric-retention') AS released");
          if (Number(released[0].released) !== 1) { owner.destroy(); locked = false; }
        } catch { owner.destroy(); locked = false; }
        if (locked) owner.release();
      } else owner.destroy();
    }
  });
  if (readMetricRetentionConfig(env)) {
    await pool.query('SELECT tombstone FROM metric_v2_observations LIMIT 0');
    await pool.query('SELECT preview_policy_hash, last_report FROM metric_v2_retention_state LIMIT 0');
    await enqueue(createMetricRetentionJob(clock()));
  }
}
