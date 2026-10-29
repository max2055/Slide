/**
 * MAX-238 / NATIVE-CONFIGURATION-FLOW-R2 — the bootstrap probe's wiring.
 *
 * The resource has no binding row. What is proven here is the *order and shape*
 * of the real seam: the exact pinned collectors are read once per release through
 * the accepted runner, the live grant is re-read before/after the reads, and only
 * then is one evidence row written. A refusal, a failed read or a bound resource
 * writes nothing. The real database/read-only target chain is proven separately.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../../auth/actor-context.js';
import type { Pool } from 'mysql2/promise';
import type { ResourceBindingCandidate } from '../../contracts/metrics/templates.js';
import { TemplateBindingService } from './binding-service.js';
import { PolicyError } from '../policy/model.js';

const AT = '2026-10-30T02:00:00.000Z';
const hash = (character: string) => `sha256:${character.repeat(64)}`;
const PIN = { template_id: 'tpl-max238', version: 1, content_hash: hash('b') };

const state = vi.hoisted(() => ({
  runs: [] as Array<{ selection: Record<string, unknown>; execution: Record<string, unknown> }>,
  runResult: null as null | (() => Record<string, unknown>),
  bound: false,
  evidenceWrites: [] as Array<{ sql: string; params: unknown[] }>,
  evidenceRows: new Map<string, unknown>(),
  liveCalls: 0,
  liveRevokedAfter: Number.POSITIVE_INFINITY,
  resolved: null as unknown,
}));

vi.mock('../packages/runner.js', () => ({
  runPackage: async (registry: unknown, selection: Record<string, unknown>, execution: Record<string, unknown>) => {
    state.runs.push({ selection, execution });
    return state.runResult!();
  },
}));
vi.mock('../bindings/resolve.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../bindings/resolve.js')>();
  return { ...actual, resolveTemplateBinding: async () => state.resolved };
});
vi.mock('../bindings/plan.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../bindings/plan.js')>();
  return { ...actual, buildTemplateCollectionPlan: () => ({}) };
});
vi.mock('../scheduler/store.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../scheduler/store.js')>();
  return { ...actual, MysqlScheduleStore: class { async reserve() { return { release: async () => undefined }; } } };
});
vi.mock('../../resources/resource-service.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../resources/resource-service.js')>();
  return { ...actual, MysqlResourceRelationStore: class { async exists() { return true; } } };
});

const admin: ActorContext = {
  userId: 7, username: 'operator', roles: ['admin'], permissions: ['*'], sessionVersion: 3,
  instanceScopes: { 11: 'admin' }, requestId: 'req-max238-probe',
};
const resource = { type: 'instance' as const, id: '11', attributes: {} };
const capability = () => ({
  resource_id: '11', metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' }, status: 'supported' as const, method: 'sql' as const,
  basis: [{ kind: 'method' as const, evidence: 'fixed_read_succeeded' }], evaluated_at: AT,
  valid_until: new Date(Date.parse(AT) + 120_000).toISOString(),
});
const resolution = () => ({
  kind: 'template_resolution', internal: true, persisted: false, applied: false,
  binding: {} as ResourceBindingCandidate, resource: { type: 'instance', id: '11' }, revision: 0, group: null,
  templates: [], triggers: [],
  settings: { enabled: true, interval_ms: 60000, timeout_ms: 5000, stale_after_ms: 120000,
    max_counter_gap_ms: 300000, max_rows: 100, max_concurrency: 1, max_series_per_resource: 100 },
  sources: {}, metric_sources: {}, platform_limits: {},
  releases: [{
    release: { id: 'pkg', version: '1.0.0', digest: hash('c') }, release_ref: `pkg@1.0.0#${hash('c')}`,
    applicability: [{ attribute: 'db.version', value: '8.4', supported_values: ['8.4'], status: 'supported' }],
    collectors: [{
      release: { id: 'pkg', version: '1.0.0', digest: hash('c') }, release_ref: `pkg@1.0.0#${hash('c')}`,
      collector_id: 'mysql-status', implementation_id: 'builtin:mysql.status.v2', method: 'sql',
      estimated_cost: 'low', collector_timeout_ms: 5000, timeout_ms: 5000,
      timeout_source: { layer: 'package', releases: [] },
      items: [
        { pin: PIN, template_id: 'tpl-max238', item_id: 'uptime', item_version: 1,
          canonical_metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' }, unit: 'count', dimensions: {},
          release: { id: 'pkg', version: '1.0.0', digest: hash('c') }, release_ref: `pkg@1.0.0#${hash('c')}`,
          collector_id: 'mysql-status', implementation_id: 'builtin:mysql.status.v2', method: 'sql',
          mapping: { metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' }, raw_field: 'x', input_unit: 'count',
            output_unit: 'count', transform_version: '1.0.0', steps: [] },
          enabled: true, decision: 'capability_unknown', capability: capability() },
        { pin: PIN, template_id: 'tpl-max238', item_id: 'off', item_version: 1,
          canonical_metric: { id: 'db.off_metric', semantic_version: '1.0.0' }, unit: 'count', dimensions: {},
          release: { id: 'pkg', version: '1.0.0', digest: hash('c') }, release_ref: `pkg@1.0.0#${hash('c')}`,
          collector_id: 'mysql-status', implementation_id: 'builtin:mysql.status.v2', method: 'sql',
          mapping: { metric: { id: 'db.off_metric', semantic_version: '1.0.0' }, raw_field: 'y', input_unit: 'count',
            output_unit: 'count', transform_version: '1.0.0', steps: [] },
          enabled: false, decision: 'disabled', capability: capability() },
      ],
    }],
  }],
  excluded: [], executable: false,
});

function fakePool() {
  const connection = {
    async beginTransaction() { return undefined; },
    async commit() { return undefined; },
    async rollback() { return undefined; },
    release() { return undefined; },
    destroy() { return undefined; },
    async execute(sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
      const key = sql.replace(/\s+/g, ' ').trim();
      if (/^SET TRANSACTION ISOLATION LEVEL READ COMMITTED$/i.test(key)) return [{}, []];
      if (/^INSERT INTO metric_capability_evidence/.test(key)) {
        state.evidenceWrites.push({ sql: key, params });
        state.evidenceRows.set(String(params[0]), JSON.parse(String(params[1])) as unknown);
        return [{ affectedRows: 1 }, []];
      }
      if (/^SELECT payload FROM metric_capability_evidence/.test(key)) {
        return [state.evidenceRows.has(String(params[0])) ? [{ payload: JSON.stringify(state.evidenceRows.get(String(params[0]))) }] : [], []];
      }
      if (/^SELECT 1 FROM metric_policy_bindings/.test(key)) return [state.bound ? [{ 1: 1 }] : [], []];
      throw new Error(`unexpected ${key}`);
    },
  };
  return {
    async execute(sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
      const key = sql.replace(/\s+/g, ' ').trim();
      if (/^SELECT 1 FROM metric_policy_bindings/.test(key)) return [state.bound ? [{ 1: 1 }] : [], []];
      if (/^SELECT capabilities FROM metric_policy_bindings/.test(key)) return [[], []];
      if (/^SELECT payload FROM metric_capability_evidence/.test(key)) {
        return [state.evidenceRows.has(String(params[0])) ? [{ payload: JSON.stringify(state.evidenceRows.get(String(params[0]))) }] : [], []];
      }
      throw new Error(`unexpected ${key}`);
    },
    getConnection: async () => connection,
  } as unknown as Pool;
}

function service(overrides: { access?: () => Promise<unknown>; live?: () => Promise<ActorContext> } = {}) {
  const pool = fakePool();
  return new TemplateBindingService({
    pool: () => pool,
    registry: {} as never,
    access: { resolve: overrides.access ?? (async () => ({ resource, credential_ref: 'credential:asset-instance-11',
      evidence: {}, resolve: async () => { throw new Error('not used'); } })) } as never,
    clock: () => new Date(AT),
    inventory: async () => ({ ...resource, attributes: {} }) as never,
    reload: overrides.live ?? (async () => {
      state.liveCalls++;
      if (state.liveCalls > state.liveRevokedAfter) throw new PolicyError('TEMPLATE_BINDING_FORBIDDEN', 403);
      return admin;
    }),
    relations: { exists: async () => true } as never,
  });
}

const body = () => ({ expected_revision: 0, template_pins: [PIN], overrides: {}, group_id: null });

describe('bootstrap probe wiring', () => {
  const reset = () => {
    state.runs = []; state.bound = false; state.evidenceWrites = []; state.evidenceRows.clear();
    state.liveCalls = 0; state.liveRevokedAfter = Number.POSITIVE_INFINITY;
    state.resolved = resolution();
    state.runResult = () => ({ decision: 'attempted', observations: [], attempts: [], capabilities: [capability()] });
  };

  it('runs exactly the pinned enabled collectors read-only, then writes one evidence row', async () => {
    reset();
    const result = await service().probe(admin, { type: 'instance', id: 11 }, body());
    expect(state.runs).toHaveLength(1);
    // The disabled item is not probed; the selected metric is.
    expect(state.runs[0].execution.collector_ids).toEqual(['mysql-status']);
    expect(state.runs[0].execution.metric_keys).toEqual(['db.uptime_seconds@1.0.0']);
    expect((state.runs[0].selection.overrides as { enabled: boolean }).enabled).toBe(true);
    expect(state.evidenceWrites).toHaveLength(1);
    expect(result.capabilities).toHaveLength(1);
    expect(result.revision).toBe(0);
  });

  it('a bound resource never gets bootstrap evidence', async () => {
    reset(); state.bound = true;
    await expect(service().probe(admin, { type: 'instance', id: 11 }, body()))
      .rejects.toMatchObject({ code: 'TEMPLATE_BINDING_ALREADY_BOUND' });
    expect(state.runs).toHaveLength(0);
    expect(state.evidenceWrites).toHaveLength(0);
  });

  it('a failed credential/target read stores nothing', async () => {
    reset();
    const failing = service({ access: async () => { throw new Error('permission_denied'); } });
    await expect(failing.probe(admin, { type: 'instance', id: 11 }, body())).rejects.toThrow('permission_denied');
    expect(state.evidenceWrites).toHaveLength(0);
  });

  it('a revoked grant after the real reads stores nothing', async () => {
    reset();
    // The first live reads succeed (request start and before each request); the
    // one after the IO is revoked, so no evidence may be persisted.
    state.liveRevokedAfter = 3;
    await expect(service().probe(admin, { type: 'instance', id: 11 }, body()))
      .rejects.toBeInstanceOf(PolicyError);
    expect(state.runs).toHaveLength(1);
    expect(state.evidenceWrites).toHaveLength(0);
  });

  it('an all-unknown read is a probe refusal that stores nothing', async () => {
    reset();
    state.runResult = () => ({ decision: 'capability_unknown', observations: [], attempts: [],
      capabilities: [{ ...capability(), status: 'unknown' }] });
    // Unknown is not support: a connection/parse failure must not leave a
    // capability record that a later preview could mistake for probed facts.
    await expect(service().probe(admin, { type: 'instance', id: 11 }, body()))
      .rejects.toMatchObject({ code: 'TEMPLATE_BINDING_PROBE_FAILED' });
    expect(state.evidenceWrites).toHaveLength(0);
  });

  it('an empty capability set is never stored as evidence', async () => {
    reset();
    state.runResult = () => ({ decision: 'capability_unknown', observations: [], attempts: [], capabilities: [] });
    await expect(service().probe(admin, { type: 'instance', id: 11 }, body()))
      .rejects.toMatchObject({ code: 'TEMPLATE_BINDING_PROBE_FAILED' });
    expect(state.evidenceWrites).toHaveLength(0);
  });
});
