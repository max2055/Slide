/**
 * MAX-238 / COLLECTION-DISPLAY-E2E-R3 — the re-pin publication is atomic.
 *
 * The review's counterexample revoked the caller after the route had checked the
 * grant once and still received 200 with a new current version. Here the real
 * Fastify handler, the real service, the real MySQL repository and the real
 * publication transaction run together: the grant is revoked at a chosen write
 * boundary, and every row the refused publication had already written must be
 * rolled back.
 *
 * The live actor source, the resource inventory and the relation store are
 * controlled boundaries (the grant itself cannot be revoked in this database);
 * everything that persists is real MySQL.
 */
import mysql, { type Pool } from 'mysql2/promise';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ActorContext } from '../../auth/actor-context.js';
import { ActorAuthenticationError } from '../../auth/actor-context.js';
import { MigrationRunner } from '../../migrations/runner.js';
import type { MigrationPool } from '../../migrations/types.js';
import { createBuiltinRegistry } from '../packages/builtins.js';
import { MySqlTemplateRepository, type TemplateSqlPool } from './mysql-repository.js';
import { MetricTemplateService } from './service.js';
import { maintenanceActor } from './repin.js';
import { TemplateBindingService } from './binding-service.js';
import { registerMetricTemplateRoutes } from './routes.js';

const port = Number(process.env.METRICS_TEST_MYSQL_PORT);
const AT = '2026-10-29T16:00:00.000Z';
const TEMPLATE_ID = 'e19c120027e04da69b130e0f6cea29fc';
const ITEM_ID = '8fbad224ebdf46e7b25a0be015f21972';

const admin: ActorContext = {
  userId: 7, username: 'operator', roles: ['admin'], permissions: ['*'], sessionVersion: 3,
  instanceScopes: { 1: 'admin' }, requestId: 'req-238-r3',
};
const revoked: ActorContext = { ...admin, permissions: [] };
const resource = {
  type: 'instance' as const, id: '1', attributes: {
    'db.engine': { value: 'mysql', observed_at: AT, source: 'resource_configuration' },
    'db.version': { value: '9.6.0', observed_at: AT, source: 'resource_configuration' },
  },
};
const registry = createBuiltinRegistry();
const digest = (version: string) => registry.list()
  .find(entry => entry.package.id === 'mysql-basic' && entry.package.version === version)!.package.digest;

const TABLES = ['metric_template_item_versions', 'metric_template_items', 'metric_template_versions',
  'metric_template_drafts', 'metric_templates_v2', 'metric_policy_operations', 'metric_policy_trial_receipts'] as const;

describe.skipIf(!port)('re-pin publication authorization on isolated MySQL', () => {
  let root: Pool, pool: Pool;
  const database = `max238repin_${process.pid}`;

  const repository = () => new MySqlTemplateRepository(pool as unknown as TemplateSqlPool);

  /** Version 1 pins mysql-basic@1.0.0, which does not apply to 9.6. */
  async function seed() {
    for (const table of TABLES) await pool.query(`DELETE FROM ${table}`);
    const templates = new MetricTemplateService(repository(), registry,
      { now: () => AT, newTemplateId: () => TEMPLATE_ID, newItemId: () => ITEM_ID });
    const maintenance = maintenanceActor('max238-r3-fixture');
    await templates.create(maintenance, { name: 'MySQL by ODBC' });
    const component = await templates.selectMetric(maintenance, TEMPLATE_ID, {
      item_id: ITEM_ID, display_name: 'Uptime',
      package: { id: 'mysql-basic', version: '1.0.0', digest: digest('1.0.0') },
      metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' },
    });
    const draft = (await repository().getDraft(TEMPLATE_ID))!;
    const updated = await templates.updateDraft(maintenance, TEMPLATE_ID, {
      expected_draft_revision: draft.revision,
      aggregate: { ...draft.aggregate, items: [{ item_id: ITEM_ID, version: component.item.version }] },
    });
    const template = (await repository().getTemplate(TEMPLATE_ID))!;
    const published = await templates.publish(maintenance, TEMPLATE_ID, {
      expected_draft_revision: updated.revision, expected_revision: template.revision,
    });
    const current = (await repository().getTemplate(TEMPLATE_ID))!;
    await templates.setCurrent(maintenance, TEMPLATE_ID, { version: published.version, expected_revision: current.revision });
  }

  async function app(live: () => Promise<ActorContext>) {
    const instance = new TemplateBindingService({
      pool: () => pool, registry,
      access: { resolve: async () => { throw new Error('no remote IO in a re-pin'); } } as never,
      inventory: async () => resource as never, clock: () => new Date(AT), reload: (async () => live()) as never,
      relations: { exists: async () => true, insertRelation: async () => undefined, listRelations: async () => [] },
    });
    const server = Fastify();
    await registerMetricTemplateRoutes(server, async request => {
      (request as unknown as { user?: ActorContext }).user = admin;
    }, instance);
    return server;
  }

  const repin = (server: ReturnType<typeof Fastify>) => server.inject({
    method: 'POST', url: `/api/metrics/templates/${TEMPLATE_ID}/repin`,
    payload: { resource: { type: 'instance', id: 1 } },
  });

  const state = async () => {
    const repo = repository();
    return {
      versions: (await repo.listVersions(TEMPLATE_ID)).map(version => version.version),
      template: (await repo.getTemplate(TEMPLATE_ID))!,
      draft: (await repo.getDraft(TEMPLATE_ID))!,
      items: await repo.latestItemVersions(TEMPLATE_ID),
    };
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
  beforeEach(async () => { await seed(); });

  it('rolls back every item, draft, version and pointer write when the grant is revoked at setCurrent', async () => {
    const before = await state();
    let calls = 0;
    const server = await app(async () => {
      calls += 1;
      // Reads (#1), the item write (#2), the draft write (#3) and the version
      // write (#4) all proceed; the current-pointer write is refused.
      return calls >= 5 ? revoked : admin;
    });
    try {
      const response = await repin(server);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'TEMPLATE_BINDING_FORBIDDEN' });
      expect(calls).toBeGreaterThanOrEqual(5);
      const after = await state();
      expect(after.versions).toEqual([1]);
      expect(after.template.current_published_version).toBe(1);
      expect(after.template.revision).toBe(before.template.revision);
      expect(after.draft.revision).toBe(before.draft.revision);
      expect(after.draft.aggregate).toEqual(before.draft.aggregate);
      expect(after.items.map(item => ({ item_id: item.item_id, version: item.version })))
        .toEqual(before.items.map(item => ({ item_id: item.item_id, version: item.version })));
    } finally { await server.close(); }
  });

  it('answers a revoked session with re-authentication and writes nothing', async () => {
    const before = await state();
    const server = await app(async () => { throw new ActorAuthenticationError(); });
    try {
      const response = await repin(server);
      expect(response.statusCode).toBe(401);
      const after = await state();
      expect(after.versions).toEqual([1]);
      expect(after.template.revision).toBe(before.template.revision);
      expect(after.draft.revision).toBe(before.draft.revision);
    } finally { await server.close(); }
  });

  it('publishes version 2 under the live operator when every boundary holds', async () => {
    const server = await app(async () => admin);
    try {
      const response = await repin(server);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ unchanged: false, from_version: 1, to_version: 2 });
      const after = await state();
      expect(after.versions).toEqual([1, 2]);
      expect(after.template.current_published_version).toBe(2);
      const version = await repository().getVersion(TEMPLATE_ID, 2);
      expect(version!.source_chain.actor_id).toBe(admin.userId);
      expect(version!.source_chain.request_id).toBe(admin.requestId);
    } finally { await server.close(); }
  });
});
