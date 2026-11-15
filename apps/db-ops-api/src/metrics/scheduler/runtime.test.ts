import type { Pool } from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { JobRegistry } from '../../workflows/job-registry.js';
import { MetricSchedulerLifecycle } from './lifecycle.js';
import { assertMetricSchedulerSchema } from './runtime.js';
import { schedulerSchemaProbes } from './runtime-test-support.js';

describe('MAX-521 scheduler startup schema gate', () => {
  it('checks the runtime tables and their key columns, including previously omitted dependencies', async () => {
    const sql = (await schedulerSchemaProbes()).join('\n');
    for (const table of ['metric_schedule_events', 'metric_attempts', 'metric_rollout_resources', 'metric_policy_lock',
      'metric_policy_groups', 'metric_source_checks', 'metric_source_acceptance', 'workflow_jobs']) {
      expect(sql).toContain(`FROM ${table} LIMIT 0`);
    }
    for (const column of ['next_due_ms', 'job_id', 'capabilities', 'generation', 'package_pin', 'fencing_token', 'logical_reads']) {
      expect(sql).toContain(column);
    }
  });
  it('blocks registration and the first tick on every missing dependency', async () => {
    for (const probe of await schedulerSchemaProbes()) {
      const scheduler = { tick: vi.fn(), register: vi.fn() };
      const pool = { query: async (sql: string) => {
        if (sql === probe) throw new Error('private SQL/credentials');
        return [[{ id: 1 }], []];
      } } as unknown as Pool;
      const lifecycle = new MetricSchedulerLifecycle(scheduler, { enabled: true });
      await expect(lifecycle.start(new JobRegistry(), () => assertMetricSchedulerSchema(pool))).rejects.toThrow(/^METRIC_SCHEMA_NOT_READY$/);
      expect(scheduler.register).not.toHaveBeenCalled(); expect(scheduler.tick).not.toHaveBeenCalled();
      await lifecycle.stop();
    }
  });
  it('requires the policy lock singleton even when all columns exist', async () => {
    const pool = { query: async (sql: string) => [sql.endsWith('LIMIT 0') ? [] : [], []] } as unknown as Pool;
    await expect(assertMetricSchedulerSchema(pool)).rejects.toThrow(/^METRIC_SCHEMA_NOT_READY$/);
  });
});
