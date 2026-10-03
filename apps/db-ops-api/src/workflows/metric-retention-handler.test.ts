import { expect, it, vi } from 'vitest';
import { JobRegistry } from './job-registry.js';
import { createMetricRetentionJob, readMetricRetentionConfig, registerMetricRetentionHandler } from './metric-retention-handler.js';

const env = { METRICS_V2_RETENTION_ENABLED: 'true', METRICS_V2_RETENTION_RAW_MS: '1000',
  METRICS_V2_RETENTION_HISTORY_MS: '10000', METRICS_V2_RETENTION_ATTEMPT_MS: '5000' };
it('requires explicit validated durations and defaults to dry-run with bounded work', () => {
  expect(readMetricRetentionConfig({})).toBeNull();
  expect(() => readMetricRetentionConfig({ METRICS_V2_RETENTION_ENABLED: 'true' })).toThrow('RETENTION_CONFIG');
  expect(() => readMetricRetentionConfig({ ...env, METRICS_V2_RETENTION_RAW_MS: '10001' })).toThrow('RETENTION');
  expect(() => readMetricRetentionConfig({ ...env, METRICS_V2_RETENTION_MODE: 'delete' })).toThrow('RETENTION');
  expect(readMetricRetentionConfig(env)).toMatchObject({ mode: 'dry-run', limit: 1000, maxBatches: 5, maxRunMs: 10000 });
});
it('fixed jobs cannot supply policy or arbitrary cleanup capability', () => {
  expect(createMetricRetentionJob(new Date(1000))).toMatchObject({ type: 'metrics.retention', payload: {} });
});
it('registers a fixed handler, cooperates with cancellation and leaves recovery to durable workflow', async () => {
  const registry = new JobRegistry(); const run = vi.fn(async () => ({ reason: 'retention', batches: 0 }));
  registerMetricRetentionHandler(registry, run);
  const job = { ...createMetricRetentionJob(new Date(1000)), attempts: 1, maxAttempts: 5, fencingToken: 1 };
  const controller = new AbortController(); const context = { signal: controller.signal, workerId: 'test', fencingToken: 1 };
  await registry.execute(job, context); expect(run).toHaveBeenCalledWith(job, context);
  controller.abort(new Error('stopped'));
  await expect(registry.execute(job, context)).rejects.toThrow('stopped'); expect(run).toHaveBeenCalledTimes(1);
});
