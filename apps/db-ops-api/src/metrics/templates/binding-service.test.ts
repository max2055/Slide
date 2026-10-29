/**
 * MAX-238 / COLLECTION-DISPLAY-E2E-R2 — the live authorization of the public
 * template entry points.
 *
 * These are the real Fastify routes and the real service; only the world outside
 * the boundary is controlled: the actor source (a grant that can be revoked while
 * a request waits), the resource relation store, the resolution, and one SQL
 * connection. What is asserted is the ordering (the grant is re-read after the
 * lock, never the actor the request arrived with) and the absence of any write or
 * remote request after a refusal.
 *
 * The real collection path is proven separately (the R1 chain over MySQL, HTTP
 * and the page); nothing here claims to be that evidence.
 */
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../../auth/actor-context.js';
import { ActorAuthenticationError } from '../../auth/actor-context.js';
import type { Pool } from 'mysql2/promise';
import { createBuiltinRegistry } from '../packages/builtins.js';
import { InMemoryTemplateRepository, type TemplateRepository } from './repository.js';
import { MetricTemplateService } from './service.js';
import { maintenanceActor, repinTemplateVersion } from './repin.js';
import { TemplateBindingService, type TemplateBindingDeps } from './binding-service.js';
import { registerMetricTemplateRoutes } from './routes.js';
import { MysqlScheduleStore } from '../scheduler/store.js';
import { MYSQL_BINDING_HOST_SQL } from '../bindings/mysql-host.js';
import { TRIAL_RECEIPT_INSERT_SQL } from '../bindings/trial-receipt-writer.js';

const AT = '2026-10-29T12:00:00.000Z';
const HASH = `sha256:${'a'.repeat(64)}`;
const PIN = { template_id: 'tpl-238', version: 1, content_hash: `sha256:${'b'.repeat(64)}` };
const BODY = { expected_revision: 4, template_pins: [PIN] };

/** One actor with full authority; a revocation returns a reduction of it. */
const admin: ActorContext = {
  userId: 7, username: 'operator', roles: ['admin'], permissions: ['*'], sessionVersion: 3,
  instanceScopes: { 1: 'admin' }, requestId: 'req-238',
};
const revoked: ActorContext = { ...admin, permissions: [] };
const outOfScope: ActorContext = {
  ...admin, permissions: ['metric:manage'], resourceBoundary: { instanceIds: [2], serverIds: [], networkDeviceIds: [] },
};

/**
 * Everything the mocked modules and the tests share. `vi.mock` factories are
 * hoisted above this file's imports, so their state has to live here.
 */
const state = vi.hoisted(() => {
  const plan = {
    kind: 'template_collection_plan', internal: true, persisted: false, applied: false, executable: true,
    identity: `sha256:${'a'.repeat(64)}`, resource: { type: 'instance', id: '1' }, revision: 4,
    settings: { enabled: true, interval_ms: 60000, timeout_ms: 5000, stale_after_ms: 120000,
      max_counter_gap_ms: 300000, max_rows: 100, max_concurrency: 1, max_series_per_resource: 100 },
    parameters: [], triggers: [], releases: [], excluded: [],
    budget: { estimate: true, request_unit: 'logical_reads', estimated_series_upper_bound: 1,
      max_series_per_resource: 100, requests_per_hour_estimate: 60 },
  };
  /** The controlled issuer output: a complete v2 body for the requested id. */
  const issueDefault = async (request: { receipt_id: string }) => ({
    receipt_id: request.receipt_id,
    payload: {
      receipt_version: 2, receipt_id: request.receipt_id, resource: { type: 'instance', id: '1' },
      base_revision: 4, target_revision: 5,
      candidate_digest: `sha256:${'a'.repeat(64)}`,
      resolution_identity: `sha256:${'a'.repeat(64)}`,
      dependency_digest: `sha256:${'a'.repeat(64)}`,
      issued_at: '2026-10-29T12:00:00.000Z', expires_at: '2026-10-29T12:10:00.000Z',
      items: [], optional_exclusions: [],
    } as Record<string, unknown>,
  });
  return {
    relationExists: true,
    statements: [] as string[],
    order: [] as string[],
    plan,
    /** Committed receipt rows; the fixture applies a write only on commit. */
    receipts: new Map<string, string>(),
    /** Called before the writer's pool hands out its connection (a pool wait). */
    beforeGetConnection: null as null | (() => Promise<void>),
    /** Called inside the writer's INSERT, before the row is written (a row-lock wait). */
    beforeInsert: null as null | (() => Promise<void>),
    /** Replaced per test: what the live actor source answers. */
    liveActor: (async (_actor?: unknown) => undefined) as (actor?: unknown) => Promise<unknown>,
    /** Replaced per test: the controlled issuer output (this file is not the issuer suite). */
    issueDefault,
    issue: issueDefault as (request: { receipt_id: string }) => Promise<{
      receipt_id: string; payload: Record<string, unknown>;
    }>,
  };
});

vi.mock('../../resources/resource-service.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../resources/resource-service.js')>();
  return {
    ...actual,
    MysqlResourceRelationStore: class { async exists(): Promise<boolean> { return state.relationExists; } },
  };
});
vi.mock('../bindings/resolve.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../bindings/resolve.js')>();
  // The wiring under test starts after a successful resolution; the resolution
  // itself is covered by its own accepted suite.
  return {
    ...actual,
    resolveTemplateBinding: async () => ({ kind: 'template_resolution', binding: {}, resource: { type: 'instance', id: 1 },
      releases: [], excluded: [], templates: [], settings: {} }),
  };
});
vi.mock('../bindings/plan.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../bindings/plan.js')>();
  return { ...actual, buildTemplateCollectionPlan: () => state.plan };
});
// R4: the issuer is not under test here (its own suite covers it); it is the
// controlled async boundary between the trial reads and the receipt writer.
vi.mock('../bindings/trial-receipt-issuer.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../bindings/trial-receipt-issuer.js')>();
  return { ...actual, issueTrialReceipt: (request: { receipt_id: string }) => state.issue(request) };
});

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const isWrite = (sql: string) => /^(INSERT|UPDATE|DELETE|REPLACE)/i.test(normalize(sql));

function fakeConnection() {
  /** Rows this transaction inserted; applied by COMMIT, discarded by ROLLBACK. */
  const pending = new Map<string, string>();
  let open = false;
  return {
    async beginTransaction() { open = true; state.order.push('begin'); },
    async execute(sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
      const key = normalize(sql);
      // Transaction settings are setup, not an observable persistence step.
      if (/^SET TRANSACTION ISOLATION LEVEL READ COMMITTED$/i.test(key)) return [{}, []];
      state.order.push(key);
      state.statements.push(key);
      if (key === normalize(MYSQL_BINDING_HOST_SQL.lock)) return [[{ id: 1 }], []];
      if (key.startsWith('SELECT capabilities FROM metric_policy_bindings')) return [[], []];
      if (key === normalize(TRIAL_RECEIPT_INSERT_SQL)) {
        await state.beforeInsert?.();
        const [receiptId, payload] = params as [string, string];
        if (state.receipts.has(receiptId) || pending.has(receiptId)) {
          throw Object.assign(new Error('fixture duplicate entry'), { code: 'ER_DUP_ENTRY' });
        }
        if (!open) {
          // Autocommit (the pre-R4 writer): visible without a COMMIT.
          state.receipts.set(receiptId, payload);
          return [{ affectedRows: 1 }, []];
        }
        pending.set(receiptId, payload);
        return [{ affectedRows: 1 }, []];
      }
      if (key === normalize(MYSQL_BINDING_HOST_SQL.receiptRead)) {
        const receiptId = params[0] as string;
        const stored = state.receipts.get(receiptId) ?? pending.get(receiptId);
        return stored === undefined ? [[], []] : [[{ payload: stored }], []];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    async commit() {
      for (const [receiptId, payload] of pending) state.receipts.set(receiptId, payload);
      pending.clear(); open = false; state.order.push('commit');
    },
    async rollback() { pending.clear(); open = false; state.order.push('rollback'); },
    release() { state.order.push('release'); },
    destroy() { state.order.push('destroy'); },
  };
}
type FakePool = ReturnType<typeof fakeConnection> & { getConnection(): Promise<ReturnType<typeof fakeConnection>> };
const newPool = (): FakePool => {
  const connection = fakeConnection();
  return {
    ...connection,
    getConnection: async () => { await state.beforeGetConnection?.(); return connection; },
  };
};
let pool: FakePool = newPool();

function service(overrides: Partial<TemplateBindingDeps> = {}) {
  const access = { resolve: vi.fn(async () => { throw new Error('remote IO must not start'); }) };
  const instance = new TemplateBindingService({
    pool: () => pool as unknown as Pool, registry: createBuiltinRegistry(), access: access as never,
    inventory: async () => ({ type: 'instance', id: '1', attributes: {} }) as never,
    clock: () => new Date(AT), reload: ((actor: ActorContext) => state.liveActor(actor)) as never, ...overrides,
  });
  return { instance, access };
}

/** One server whose request actor is fixed, so a scoped operator can be exercised. */
async function appWith(requestActor: ActorContext, overrides: Partial<TemplateBindingDeps> = {}) {
  const { instance, access } = service(overrides);
  const server = Fastify();
  await registerMetricTemplateRoutes(server, async request => {
    (request as unknown as { user?: ActorContext }).user = requestActor;
  }, instance);
  return { server, access };
}

/** Every request begins with a clean, fully-authorized world. */
const reset = () => {
  state.statements = []; state.order = []; state.relationExists = true;
  state.receipts.clear(); state.beforeGetConnection = null; state.beforeInsert = null;
  state.issue = state.issueDefault;
  pool = newPool();
  state.liveActor = (async () => admin) as never;
};

describe('template binding public entry — live authorization', () => {
  it('refuses a trial whose grant was revoked while it waited for the resource lock', async () => {
    reset();
    const reserved = vi.spyOn(MysqlScheduleStore.prototype, 'reserve').mockImplementation(async () => {
      state.order.push('reserve');
      return { connection: { ping: async () => undefined }, release: async () => { state.order.push('reserve-release'); } } as never;
    });
    let calls = 0;
    state.liveActor = (async () => { state.order.push('reload'); calls += 1; return revoked; }) as never;
    const { server, access } = await appWith(admin);
    try {
      const response = await server.inject({ method: 'POST', url: '/api/metrics/template-bindings/instance/1/trial',
        payload: { ...BODY, receipt_id: 'trial-238' } });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'TEMPLATE_BINDING_FORBIDDEN' });
      // The grant is read after the lock, and a refusal starts no remote request.
      expect(calls).toBe(1);
      expect(state.order.indexOf('reserve')).toBeLessThan(state.order.indexOf('reload'));
      expect(state.order).toContain('reserve-release');
      expect(access.resolve).not.toHaveBeenCalled();
    } finally { reserved.mockRestore(); await server.close(); }
  });

  it('treats a session revoked during the trial lock wait as re-authentication', async () => {
    reset();
    const reserved = vi.spyOn(MysqlScheduleStore.prototype, 'reserve').mockResolvedValue(
      { connection: { ping: async () => undefined }, release: async () => undefined } as never);
    state.liveActor = (async () => { throw new ActorAuthenticationError(); }) as never;
    const { server, access } = await appWith(admin);
    try {
      const response = await server.inject({ method: 'POST', url: '/api/metrics/template-bindings/instance/1/trial',
        payload: { ...BODY, receipt_id: 'trial-238' } });
      expect(response.statusCode).toBe(401);
      expect(access.resolve).not.toHaveBeenCalled();
    } finally { reserved.mockRestore(); await server.close(); }
  });

  it('refuses a management grant that does not cover this resource', async () => {
    reset();
    // The body names instance 1, but this operator is scoped to instance 2.
    const { server } = await appWith(outOfScope);
    try {
      for (const [suffix, body] of [['/preview', BODY], ['/trial', { ...BODY, receipt_id: 'trial-238' }],
        ['/apply', { ...BODY, receipt_id: 'trial-238', caller_key: 'caller-238' }]] as const) {
        const response = await server.inject({ method: 'POST',
          url: `/api/metrics/template-bindings/instance/1${suffix}`, payload: body });
        expect(response.statusCode, suffix).toBe(403);
      }
      // Nothing reached the storage boundary at all.
      expect(state.order).toEqual([]);
    } finally { await server.close(); }
  });

  it('re-reads the grant after the policy lock on apply and writes nothing when it was revoked', async () => {
    reset();
    let calls = 0;
    state.liveActor = (async () => { state.order.push('reload'); calls += 1; return revoked; }) as never;
    const { server } = await appWith(admin);
    try {
      const response = await server.inject({ method: 'POST', url: '/api/metrics/template-bindings/instance/1/apply',
        payload: { ...BODY, receipt_id: 'receipt-238', caller_key: 'caller-238' } });
      expect(response.statusCode).toBe(403);
      // The lock is held before the fresh read, and the connection is withdrawn.
      expect(state.order.indexOf(normalize(MYSQL_BINDING_HOST_SQL.lock))).toBeLessThan(state.order.indexOf('reload'));
      expect(state.order).toContain('rollback');
      expect(state.order).not.toContain('commit');
      expect(state.statements.filter(isWrite)).toEqual([]);
      expect(calls).toBeGreaterThan(0);
    } finally { await server.close(); }
  });

  it('answers a revoked session on apply with re-authentication, not a generic failure', async () => {
    reset();
    state.liveActor = (async () => { throw new ActorAuthenticationError(); }) as never;
    const { server } = await appWith(admin);
    try {
      const response = await server.inject({ method: 'POST', url: '/api/metrics/template-bindings/instance/1/apply',
        payload: { ...BODY, receipt_id: 'receipt-238', caller_key: 'caller-238' } });
      expect(response.statusCode).toBe(401);
      expect(state.statements.filter(isWrite)).toEqual([]);
      expect(state.order).not.toContain('commit');
    } finally { await server.close(); }
  });

  it('fails closed when no live actor source is wired', async () => {
    reset();
    const { server } = await appWith(admin, { reload: undefined });
    try {
      const response = await server.inject({ method: 'POST', url: '/api/metrics/template-bindings/instance/1/apply',
        payload: { ...BODY, receipt_id: 'receipt-238', caller_key: 'caller-238' } });
      // Without a live source the trusted answer is "unavailable", never "allowed".
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: 'TEMPLATE_BINDING_STORE_UNAVAILABLE' });
      expect(state.statements.filter(isWrite)).toEqual([]);
      expect(state.order).not.toContain('commit');
    } finally { await server.close(); }
  });
});

/**
 * Re-pinning is a template publication chosen by one resource's applicability, so
 * its audit must name the operator who asked for it — not the offline maintenance
 * identity, which stays reserved for a migration run without a caller.
 */
describe('re-pin attribution', () => {
  const TEMPLATE_ID = 'e19c120027e04da69b130e0f6cea29fc';
  const ITEM_ID = '8fbad224ebdf46e7b25a0be015f21972';
  const registry = createBuiltinRegistry();
  const digest = (version: string) => registry.list().find(entry =>
    entry.package.id === 'mysql-basic' && entry.package.version === version)!.package.digest;
  const resource = { type: 'instance' as const, id: '1', attributes: {
    'db.engine': { value: 'mysql', observed_at: AT, source: 'resource_configuration' },
    'db.version': { value: '9.6.0', observed_at: AT, source: 'resource_configuration' },
  } };

  async function imported() {
    const repository = new InMemoryTemplateRepository();
    const service = new MetricTemplateService(repository, registry,
      { now: () => AT, newTemplateId: () => TEMPLATE_ID, newItemId: () => ITEM_ID });
    const actor = maintenanceActor('max238-repin-fixture');
    await service.create(actor, { name: 'MySQL by ODBC' });
    const component = await service.selectMetric(actor, TEMPLATE_ID, {
      item_id: ITEM_ID, display_name: 'Uptime',
      package: { id: 'mysql-basic', version: '1.0.0', digest: digest('1.0.0') },
      metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' },
    });
    const draft = await repository.getDraft(TEMPLATE_ID);
    const updated = await service.updateDraft(actor, TEMPLATE_ID, {
      expected_draft_revision: draft!.revision,
      aggregate: { ...draft!.aggregate, items: [{ item_id: ITEM_ID, version: component.item.version }] },
    });
    const template = await repository.getTemplate(TEMPLATE_ID);
    const published = await service.publish(actor, TEMPLATE_ID, {
      expected_draft_revision: updated.revision, expected_revision: template!.revision,
    });
    const current = await repository.getTemplate(TEMPLATE_ID);
    await service.setCurrent(actor, TEMPLATE_ID, { version: published.version, expected_revision: current!.revision });
    return repository;
  }

  it('records the operator who asked, with their request id', async () => {
    const repository = await imported();
    const result = await repinTemplateVersion({ repository, registry, templateId: TEMPLATE_ID,
      resource: resource as never, at: AT, actor: admin });
    if ('unchanged' in result) throw new Error('expected a new template version');
    expect(result.to_version).toBe(2);
    expect(result.version.source_chain.actor_id).toBe(admin.userId);
    expect(result.version.source_chain.request_id).toBe(admin.requestId);
  });

  it('keeps the maintenance identity only for a call that names no operator', async () => {
    const repository = await imported();
    const result = await repinTemplateVersion({ repository, registry, templateId: TEMPLATE_ID,
      resource: resource as never, at: AT, requestId: 'offline-migration' });
    if ('unchanged' in result) throw new Error('expected a new template version');
    expect(result.version.source_chain.actor_id).toBe(0);
    expect(result.version.source_chain.request_id).toBe('offline-migration');
  });
});

/**
 * R3: a trial's read grant and a re-pin's publish grant are re-read at every
 * boundary that can wait, not once after the resource lock.
 */
const R3_TEMPLATE = 'e19c120027e04da69b130e0f6cea29fc';
const R3_ITEM = '8fbad224ebdf46e7b25a0be015f21972';
const r3Registry = createBuiltinRegistry();
const r3Digest = (version: string) => r3Registry.list()
  .find(entry => entry.package.id === 'mysql-basic' && entry.package.version === version)!.package.digest;
const r3Resource = {
  type: 'instance' as const, id: '1', attributes: {
    'db.engine': { value: 'mysql', observed_at: AT, source: 'resource_configuration' },
    'db.version': { value: '9.6.0', observed_at: AT, source: 'resource_configuration' },
  },
};
const r3Release = (suffix: string) => ({
  release: { id: 'mysql-basic', version: '1.0.0', digest: r3Digest('1.0.0') },
  release_ref: `mysql-basic@1.0.0#${r3Digest('1.0.0')}${suffix}`,
  interval_ms: 60000, timeout_ms: 5000,
  collector_ids: ['mysql-status'], metric_keys: ['db.uptime_seconds@1.0.0'],
  steps: [{ collector_id: 'mysql-status', items: [] }],
});

/** Seeded exactly like the import: version 1 pins a release incompatible with 9.6. */
async function r3Seed() {
  const repository = new InMemoryTemplateRepository();
  const templates = new MetricTemplateService(repository, r3Registry,
    { now: () => AT, newTemplateId: () => R3_TEMPLATE, newItemId: () => R3_ITEM });
  const maintenance = maintenanceActor('max238-r3-fixture');
  await templates.create(maintenance, { name: 'MySQL by ODBC' });
  const component = await templates.selectMetric(maintenance, R3_TEMPLATE, {
    item_id: R3_ITEM, display_name: 'Uptime',
    package: { id: 'mysql-basic', version: '1.0.0', digest: r3Digest('1.0.0') },
    metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' },
  });
  const draft = (await repository.getDraft(R3_TEMPLATE))!;
  const updated = await templates.updateDraft(maintenance, R3_TEMPLATE, {
    expected_draft_revision: draft.revision,
    aggregate: { ...draft.aggregate, items: [{ item_id: R3_ITEM, version: component.item.version }] },
  });
  const template = (await repository.getTemplate(R3_TEMPLATE))!;
  const published = await templates.publish(maintenance, R3_TEMPLATE, {
    expected_draft_revision: updated.revision, expected_revision: template.revision,
  });
  const current = (await repository.getTemplate(R3_TEMPLATE))!;
  await templates.setCurrent(maintenance, R3_TEMPLATE, { version: published.version, expected_revision: current.revision });
  return repository;
}

/** Writes are labelled so a test can see exactly what the live grant preceded. */
function recordingRepository(repository: TemplateRepository, order: string[]): TemplateRepository {
  return new Proxy(repository, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        if (/^(create|updateTemplate|updateDraft|putItemVersion|publish)$/.test(String(key))) order.push(`write:${String(key)}`);
        return value.apply(target, args);
      };
    },
  });
}

function r3App(repository: TemplateRepository, order: string[], live: () => Promise<ActorContext>) {
  const instance = new TemplateBindingService({
    pool: () => null as unknown as Pool, registry: r3Registry,
    access: { resolve: async () => { throw new Error('no remote IO in a re-pin'); } } as never,
    inventory: async () => r3Resource as never, clock: () => new Date(AT),
    reload: (async () => { order.push('authorize'); return live(); }) as never,
    relations: { exists: async () => true, insertRelation: async () => undefined, listRelations: async () => [] },
    templatePublication: {
      async transaction<T>(run: (repo: TemplateRepository) => Promise<T>): Promise<T> {
        order.push('transaction');
        return run(recordingRepository(repository, order));
      },
    },
  });
  const server = Fastify();
  return (async () => {
    await registerMetricTemplateRoutes(server, async request => {
      (request as unknown as { user?: ActorContext }).user = admin;
    }, instance);
    return server;
  })();
}

const repinRequest = (server: ReturnType<typeof Fastify>) => server.inject({
  method: 'POST', url: `/api/metrics/templates/${R3_TEMPLATE}/repin`, payload: { resource: { type: 'instance', id: 1 } },
});
const r3Versions = async (repository: TemplateRepository) => (await repository.listVersions(R3_TEMPLATE)).map(v => v.version);

describe('template re-pin — the live grant at every publication boundary', () => {
  it('refuses a revoked grant after the read-only analysis without writing anything', async () => {
    const repository = await r3Seed();
    const order: string[] = [];
    const server = await r3App(repository, order, async () => revoked);
    try {
      const response = await repinRequest(server);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'TEMPLATE_BINDING_FORBIDDEN' });
      expect(order).toContain('authorize');
      expect(order.filter(entry => entry.startsWith('write:'))).toEqual([]);
      expect(await r3Versions(repository)).toEqual([1]);
      expect((await repository.getTemplate(R3_TEMPLATE))!.current_published_version).toBe(1);
    } finally { await server.close(); }
  });

  it('refuses a session revoked after the read-only analysis', async () => {
    const repository = await r3Seed();
    const order: string[] = [];
    const server = await r3App(repository, order, async () => { throw new ActorAuthenticationError(); });
    try {
      const response = await repinRequest(server);
      expect(response.statusCode).toBe(401);
      expect(order.filter(entry => entry.startsWith('write:'))).toEqual([]);
      expect(await r3Versions(repository)).toEqual([1]);
    } finally { await server.close(); }
  });

  it('refuses a grant narrowed away from this resource', async () => {
    const repository = await r3Seed();
    const order: string[] = [];
    const server = await r3App(repository, order, async () => outOfScope);
    try {
      const response = await repinRequest(server);
      expect(response.statusCode).toBe(403);
      expect(order.filter(entry => entry.startsWith('write:'))).toEqual([]);
    } finally { await server.close(); }
  });

  it('fails closed without a live grant source', async () => {
    const repository = await r3Seed();
    const order: string[] = [];
    const instance = new TemplateBindingService({
      pool: () => null as unknown as Pool, registry: r3Registry,
      access: { resolve: async () => { throw new Error('no remote IO in a re-pin'); } } as never,
      inventory: async () => r3Resource as never, clock: () => new Date(AT),
      relations: { exists: async () => true, insertRelation: async () => undefined, listRelations: async () => [] },
      templatePublication: { async transaction<T>(run: (repo: TemplateRepository) => Promise<T>) { return run(repository); } },
    });
    const server = Fastify();
    await registerMetricTemplateRoutes(server, async request => {
      (request as unknown as { user?: ActorContext }).user = admin;
    }, instance);
    try {
      const response = await repinRequest(server);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: 'TEMPLATE_BINDING_STORE_UNAVAILABLE' });
      expect(await r3Versions(repository)).toEqual([1]);
    } finally { await server.close(); }
  });

  it('publishes under the re-read operator and re-checks the grant before every write', async () => {
    const repository = await r3Seed();
    const order: string[] = [];
    const server = await r3App(repository, order, async () => admin);
    try {
      const response = await repinRequest(server);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ unchanged: false, from_version: 1, to_version: 2 });
      expect((await repository.getTemplate(R3_TEMPLATE))!.current_published_version).toBe(2);
      // The audit names the re-read operator, never the maintenance identity (0).
      const version = await repository.getVersion(R3_TEMPLATE, 2);
      expect(version!.source_chain.actor_id).toBe(admin.userId);
      expect(version!.source_chain.request_id).toBe(admin.requestId);
      // Every write is immediately preceded by a fresh live-grant read.
      const writes = order.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.startsWith('write:'));
      expect(writes.length).toBeGreaterThan(0);
      for (const { index } of writes) expect(order[index - 1], order.join(',')).toBe('authorize');
    } finally { await server.close(); }
  });
});

describe('template trial — the live grant before every actual read', () => {
  function trialService(transport: { reads: number; onRead?: () => void }) {
    return {
      resolve: vi.fn(async () => ({
        resource: { type: 'instance', id: '1', attributes: {
          'db.engine': { value: 'mysql', observed_at: AT, source: 'resource_configuration' },
          'db.version': { value: '8.4', observed_at: AT, source: 'resource_configuration' },
        } },
        credential_ref: 'credential:asset-instance-1', evidence: { counter: { bits: '64' } },
        resolve: async () => ({
          method: 'sql' as const,
          pool: { query: async () => { transport.reads += 1; transport.onRead?.(); return [[{ Variable_name: 'Uptime', Value: '100' }], []]; } },
        }),
      })),
    };
  }

  it('refuses before the first request when the grant is revoked after resolution', async () => {
    reset();
    let calls = 0;
    const transport = { reads: 0 };
    state.liveActor = (async () => { calls += 1; return calls === 1 ? admin : revoked; }) as never;
    const reserved = vi.spyOn(MysqlScheduleStore.prototype, 'reserve').mockResolvedValue(
      { connection: { ping: async () => undefined }, release: async () => undefined } as never);
    state.plan.releases = [r3Release('a')];
    const { server } = await appWith(admin, { access: trialService(transport) as never });
    try {
      const response = await server.inject({ method: 'POST', url: '/api/metrics/template-bindings/instance/1/trial',
        payload: { ...BODY, receipt_id: 'trial-r3-a' } });
      expect(response.statusCode).toBe(403);
      expect(transport.reads).toBe(0);
      expect(state.statements.filter(isWrite)).toEqual([]);
    } finally { state.plan.releases = []; reserved.mockRestore(); await server.close(); }
  });

  it('stops the next release when the grant is revoked during the first read', async () => {
    reset();
    const transport = { reads: 0, onRead: () => { state.liveActor = (async () => revoked) as never; } };
    const reserved = vi.spyOn(MysqlScheduleStore.prototype, 'reserve').mockResolvedValue(
      { connection: { ping: async () => undefined }, release: async () => undefined } as never);
    state.plan.releases = [r3Release('a'), r3Release('b')];
    const { server } = await appWith(admin, { access: trialService(transport) as never });
    try {
      const response = await server.inject({ method: 'POST', url: '/api/metrics/template-bindings/instance/1/trial',
        payload: { ...BODY, receipt_id: 'trial-r3-b' } });
      expect(response.statusCode).toBe(403);
      // Exactly the read that was already in flight; no receipt was persisted.
      expect(transport.reads).toBe(1);
      expect(state.statements.filter(isWrite)).toEqual([]);
    } finally { state.plan.releases = []; reserved.mockRestore(); await server.close(); }
  });
});

/**
 * R4: the public trial's receipt persistence is itself an authorization
 * boundary. The real Fastify handler, the real service and the real receipt
 * writer run together; only the issuer output, the actor source and the pool
 * waits are controlled. The issuer is not re-proven here (its own suite covers
 * it) and the fixture transaction is not a claim of real MySQL rollback — the
 * one-off MySQL suite proves that.
 */
describe('template trial — the receipt persistence boundary', () => {
  const trialAccess = (transport: { reads: number }) => ({
    resolve: vi.fn(async () => ({
      resource: { type: 'instance', id: '1', attributes: {
        'db.engine': { value: 'mysql', observed_at: AT, source: 'resource_configuration' },
        'db.version': { value: '8.4', observed_at: AT, source: 'resource_configuration' },
      } },
      credential_ref: 'credential:asset-instance-1', evidence: { counter: { bits: '64' } },
      resolve: async () => ({
        method: 'sql' as const,
        pool: { query: async () => { transport.reads += 1; return [[{ Variable_name: 'Uptime', Value: '100' }], []]; } },
      }),
    })),
  });

  async function trialApp(overrides: Partial<TemplateBindingDeps> = {}) {
    const transport = { reads: 0 };
    const reserved = vi.spyOn(MysqlScheduleStore.prototype, 'reserve').mockResolvedValue(
      { connection: { ping: async () => undefined }, release: async () => undefined } as never);
    state.plan.releases = [r3Release('a')];
    const { server } = await appWith(admin, { access: trialAccess(transport) as never, ...overrides });
    return { server, transport, reserved };
  }

  const send = (server: Awaited<ReturnType<typeof trialApp>>['server'], receiptId: string) =>
    server.inject({ method: 'POST', url: '/api/metrics/template-bindings/instance/1/trial',
      payload: { ...BODY, receipt_id: receiptId } });

  it('fails closed when the grant is revoked while the receipt issuer reads', async () => {
    reset();
    state.issue = async request => {
      // The issuer's own asynchronous template reads can outlive the grant that
      // preceded them; nothing is written until the writer re-reads it.
      state.liveActor = (async () => revoked) as never;
      return state.issueDefault(request);
    };
    const { server, reserved } = await trialApp();
    try {
      const response = await send(server, 'trial-r4-issuer');
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'TEMPLATE_BINDING_FORBIDDEN' });
      expect(state.statements.filter(isWrite)).toEqual([]);
      expect(state.receipts.size).toBe(0);
    } finally { state.plan.releases = []; reserved.mockRestore(); await server.close(); }
  });

  it('fails closed when the grant is revoked while the writer waits for a connection', async () => {
    reset();
    state.beforeGetConnection = async () => { state.liveActor = (async () => revoked) as never; };
    const { server, reserved } = await trialApp();
    try {
      const response = await send(server, 'trial-r4-connect');
      expect(response.statusCode).toBe(403);
      expect(state.statements.filter(isWrite)).toEqual([]);
      expect(state.receipts.size).toBe(0);
      expect(state.order).toContain('rollback');
      expect(state.order).not.toContain('commit');
    } finally { state.plan.releases = []; reserved.mockRestore(); await server.close(); }
  });

  it('rolls the INSERT back when the grant is revoked while its row lock waits', async () => {
    reset();
    state.beforeInsert = async () => {
      // The row-lock wait ends after the revocation; the row is not visible yet.
      state.liveActor = (async () => revoked) as never;
    };
    const { server, reserved } = await trialApp();
    try {
      const response = await send(server, 'trial-r4-lock');
      expect(response.statusCode).toBe(403);
      expect(state.statements.some(statement => statement.startsWith('INSERT'))).toBe(true);
      expect(state.receipts.size).toBe(0);
      const insertAt = state.order.findIndex(event => event.startsWith('INSERT'));
      expect(insertAt).toBeGreaterThanOrEqual(0);
      expect(state.order.slice(insertAt)).toContain('rollback');
      expect(state.order).not.toContain('commit');
    } finally { state.plan.releases = []; reserved.mockRestore(); await server.close(); }
  });

  it('re-reads the grant on the writer’s own connection, not through a second one', async () => {
    reset();
    const seen: unknown[] = [];
    const { server, reserved } = await trialApp({
      // The writer passes the connection it holds; no pool read is needed here.
      reloadOn: (async (_actor: ActorContext, executor: unknown) => { seen.push(executor); return admin; }) as never,
    });
    try {
      const response = await send(server, 'trial-r4-held');
      expect(response.statusCode).toBe(200);
      // Two in-transaction checks (after acquisition and after the INSERT) got the
      // held connection; the earlier post-admission check did not.
      expect(seen).toHaveLength(2);
      expect(seen.every(executor => executor !== undefined)).toBe(true);
      expect(state.receipts.size).toBe(1);
    } finally { state.plan.releases = []; reserved.mockRestore(); await server.close(); }
  });

  it('answers a session revoked at the persistence boundary with re-authentication', async () => {
    reset();
    state.beforeInsert = async () => { state.liveActor = (async () => { throw new ActorAuthenticationError(); }) as never; };
    const { server, reserved } = await trialApp();
    try {
      const response = await send(server, 'trial-r4-session');
      expect(response.statusCode).toBe(401);
      expect(state.receipts.size).toBe(0);
      expect(state.order).not.toContain('commit');
    } finally { state.plan.releases = []; reserved.mockRestore(); await server.close(); }
  });

  it('writes one receipt, replays an identical request and refuses a payload collision', async () => {
    reset();
    const { server, reserved } = await trialApp();
    try {
      const first = await send(server, 'trial-r4-ok');
      expect(first.statusCode).toBe(200);
      expect(state.receipts.size).toBe(1);
      expect(state.order.filter(event => event === 'commit')).toHaveLength(1);

      const replay = await send(server, 'trial-r4-ok');
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ receipt_id: 'trial-r4-ok' });
      expect(state.receipts.size).toBe(1);

      state.issue = async request => {
        const issued = await state.issueDefault(request);
        return { ...issued, payload: { ...issued.payload, expires_at: '2026-10-29T12:20:00.000Z' } };
      };
      const collision = await send(server, 'trial-r4-ok');
      expect(collision.statusCode).toBe(409);
      expect(collision.json()).toEqual({ error: 'TEMPLATE_BINDING_RECEIPT_INVALID' });
      expect(state.receipts.size).toBe(1);
    } finally { state.plan.releases = []; reserved.mockRestore(); await server.close(); }
  });
});
