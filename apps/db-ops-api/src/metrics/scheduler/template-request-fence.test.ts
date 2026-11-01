/**
 * MAX-238 / COLLECTION-DISPLAY-E2E-R3 — a template job's request boundary.
 *
 * The commit fence alone cannot take back a request that was already sent. This
 * suite drives the real registered handler with a controlled store, access and
 * collector, and asserts the ordering the review demanded: once the lease or
 * revision is gone, no further target read is issued — even though the final
 * commit would also have refused the result.
 *
 * The real store's fence is proven separately on real MySQL
 * (`template-fence.mysql.test.ts`); this one proves the wiring calls it before
 * every request and after the IO.
 */
import { describe, expect, it } from 'vitest';
import { createBuiltinRegistry } from '../packages/builtins.js';
import { JobRegistry } from '../../workflows/job-registry.js';
import type { ClaimedJob, JobExecutionContext } from '../../workflows/worker-runtime.js';
import type { PackageRegistry } from '../packages/model.js';
import type { DecodedTemplateBindingPayload } from '../bindings/persistence-codec.js';
import { JOB_TYPE, MysqlScheduleStore, type TemplateExecutionSnapshot } from './store.js';
import { MetricScheduler } from './service.js';

const AT = '2026-10-29T16:00:00.000Z';
const REF = { type: 'instance' as const, id: 1 };
const REVISION = 4;
const registry = createBuiltinRegistry();
const digest = (version: string) => registry.list()
  .find(entry => entry.package.id === 'mysql-basic' && entry.package.version === version)!.package.digest;

const settings = { enabled: true, interval_ms: 60000, timeout_ms: 5000, stale_after_ms: 120000,
  max_counter_gap_ms: 300000, max_rows: 100, max_concurrency: 1, max_series_per_resource: 100 };

const releasePlan = (suffix: string, version = '1.0.0') => ({
  release: { id: 'mysql-basic', version, digest: digest(version) },
  release_ref: `mysql-basic@${version}#${digest(version)}${suffix}`,
  interval_ms: 60000, timeout_ms: 5000, jitter_ms: 0, applicability: [],
  collector_ids: ['mysql-status'], metric_keys: ['db.uptime_seconds@1.0.0'],
  queries: [], requests_per_hour_estimate: 60,
  steps: [{ collector_id: 'mysql-status', items: [] }],
});

const plan = (releases: unknown[]) => ({
  kind: 'template_collection_plan' as const, internal: true as const, persisted: false as const, applied: false as const,
  executable: true, identity: `sha256:${'a'.repeat(64)}`, resource: { type: 'instance' as const, id: String(REF.id) },
  revision: REVISION - 1, settings, parameters: [], triggers: [], releases: releases as never[], excluded: [],
  budget: { estimate: true as const, request_unit: 'logical_reads' as const, estimated_series_upper_bound: 1,
    max_series_per_resource: 100, requests_per_hour_estimate: 60 },
});

const claimed = (): ClaimedJob => ({
  id: 'job-238-request', type: JOB_TYPE, payload: { resource: REF, revision: REVISION },
  attempts: 1, maxAttempts: 3, fencingToken: 9,
});
const context = (): JobExecutionContext => ({ signal: new AbortController().signal, workerId: 'worker-238', fencingToken: 9 });

interface Records {
  liveLease: boolean;
  fenceReads: number;
  remoteReads: number;
  commits: number;
  events: string[];
}

/** A store whose lease can be revoked at any point the execution asks about it. */
function controlledStore(decoded: DecodedTemplateBindingPayload, records: Records, revokeAfterBegin = false) {
  const snapshot: TemplateExecutionSnapshot = {
    decoded, plan: decoded.pending.plan as never, states: new Map(), tickets: new Map(),
  };
  return {
    pool: {},
    async currentTemplate() { return decoded; },
    async reserve() { return { connection: { ping: async () => undefined }, release: async () => undefined }; },
    async assertCurrentTemplate() {
      records.fenceReads += 1;
      if (!records.liveLease) throw new Error('SCHEDULE_STALE_EXECUTION');
    },
    async beginTemplate() {
      // The lease can be lost between the begin transaction and the first request.
      if (revokeAfterBegin) records.liveLease = false;
      return snapshot;
    },
    async commitTemplate() { records.commits += 1; return true; },
    async recordTemplateFailure() { return undefined; },
    async event(_ref: unknown, _revision: number, _jobId: string, code: string) { records.events.push(code); },
  } as unknown as MysqlScheduleStore;
}

const collectorAccess = () => ({
  async resolve() {
    return {
      // Applicability must be `supported`, otherwise the runner never reaches the
      // collector and this suite would prove nothing about the request boundary.
      resource: { type: 'instance', id: String(REF.id), attributes: {
        'db.engine': { value: 'mysql', observed_at: AT, source: 'resource_configuration' },
        'db.version': { value: '8.4', observed_at: AT, source: 'resource_configuration' },
      } },
      credential_ref: 'credential:asset-instance-1', evidence: {},
      resolve: async () => ({ method: 'sql', pool: { query: async () => [[], []] } }) as never,
    };
  },
});

async function run(releases: unknown[], options: { revokeAfterBegin?: boolean; revokeOnFirstRead?: boolean } = {}) {
  const records: Records = { liveLease: true, fenceReads: 0, remoteReads: 0, commits: 0, events: [] };
  const decoded = {
    kind: 'template_pending',
    binding: { resource: REF, revision: REVISION },
    pending: { plan: plan(releases) },
  } as unknown as DecodedTemplateBindingPayload;
  const scheduler = new MetricScheduler(
    controlledStore(decoded, records, options.revokeAfterBegin), registry as PackageRegistry, collectorAccess() as never,
    () => Date.parse(AT),
    async () => {
      records.remoteReads += 1;
      if (options.revokeOnFirstRead) records.liveLease = false;
      return [];
    },
  );
  const jobs = new JobRegistry();
  scheduler.register(jobs);
  return { records, execute: () => jobs.execute(claimed(), context()) };
}

describe('template execution fence before each target read', () => {
  it('never issues a read once the lease is gone after begin', async () => {
    const { records, execute } = await run([releasePlan('a')], { revokeAfterBegin: true });
    await expect(execute()).rejects.toThrow();
    expect(records.remoteReads).toBe(0);
    expect(records.fenceReads).toBeGreaterThan(0);
    expect(records.commits).toBe(0);
    expect(records.events).not.toContain('committed');
  });

  it('stops the second release when the lease is lost during the first read', async () => {
    const { records, execute } = await run([releasePlan('a'), releasePlan('b')], { revokeOnFirstRead: true });
    await expect(execute()).rejects.toThrow();
    // Exactly the read that was already in flight; the next one never starts.
    expect(records.remoteReads).toBe(1);
    expect(records.fenceReads).toBeGreaterThan(1);
    expect(records.commits).toBe(0);
  });
});
