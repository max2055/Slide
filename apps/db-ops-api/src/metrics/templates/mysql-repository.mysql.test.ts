/**
 * MAX-237 / T2A — real MySQL transaction verification for the internal adapter.
 *
 * Runs only against the dedicated, disposable schema started by
 * `docs/slide/development/MAX-237/t2a/env-start.sh` (database `max237_t2a`,
 * utf8mb4/utf8mb4_bin, one-time DML-only test user). Skipped when the four
 * `MAX237_T2A_MYSQL_*` variables are absent, so the default suite needs no
 * database. Never points at an application `.env`, the platform pool or a
 * production target.
 *
 * Two independent pools (`A`, `B`) stand in for two connections/processes: the
 * parent-row lock in the adapter, not an in-process lock, is what serialises
 * them. Fault-injecting wrappers around a third pool fail at one exact SQL
 * stage; they never change the product interface.
 */
import mysql, { type Pool, type PoolConnection } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TemplateError } from './errors.js';
import {
  emptyDraftAggregate, templateContentHash, type SourceChain, type TemplateDraft,
  type TemplateItemVersion, type TemplatePublishedAggregate, type TemplateRecord,
} from './model.js';
import {
  MySqlTemplateRepository, TemplateStorageUnknownCommitError, fromSqlDateTime,
  type TemplateSqlConnection, type TemplateSqlPool,
} from './mysql-repository.js';
import type { ItemVersionInput, PublishCommand } from './repository.js';

const port = Number(process.env.MAX237_T2A_MYSQL_PORT);
const user = process.env.MAX237_T2A_MYSQL_USER;
const password = process.env.MAX237_T2A_MYSQL_PASSWORD;
const database = process.env.MAX237_T2A_MYSQL_DATABASE ?? 'max237_t2a';
const enabled = Number.isInteger(port) && port > 0 && Boolean(user) && password !== undefined;

const AT = '2026-10-27T00:00:00.000Z';
const RELEASE = `mysql-basic@1.0.0#sha256:${'a'.repeat(64)}`;

const chain = (): SourceChain => ({
  actor_id: 1, request_id: 'req-1', base: null, created_at: AT, published_at: AT, retired_at: null, migration_ref: null,
});
const template = (templateId = 'tpl-a', overrides: Partial<TemplateRecord> = {}): TemplateRecord => ({
  template_id: templateId, name: 'Template A', status: 'draft', current_published_version: null,
  revision: 0, created_by: 1, created_at: AT, updated_at: AT, ...overrides,
});
const draft = (templateId = 'tpl-a', overrides: Partial<TemplateDraft> = {}): TemplateDraft => ({
  template_id: templateId, revision: 0, aggregate: emptyDraftAggregate(templateId),
  published_version: null, updated_by: 1, updated_at: AT, ...overrides,
});
const itemInput = (overrides: Partial<ItemVersionInput> = {}): ItemVersionInput => ({
  template_id: 'tpl-a', item_id: 'uptime', display_name: 'Uptime',
  canonical_metric: { id: 'db.uptime_seconds', semantic_version: '1.0.0' }, unit: 's', dimensions: {},
  collector_ref: { package_release: RELEASE, implementation_id: 'builtin:mysql.status.v1' },
  params_default: {}, source_chain: chain(), ...overrides,
});
const item = (templateId = 'tpl-a'): TemplateItemVersion => ({ ...itemInput({ template_id: templateId }), version: 1 });
const aggregate = (templateId = 'tpl-a'): TemplatePublishedAggregate => ({
  ...emptyDraftAggregate(templateId),
  items: [{ item_id: 'uptime', version: 1 }],
  package_composition: [{ release: RELEASE, items: ['uptime'] }],
});
const command = (overrides: Partial<PublishCommand> = {}): PublishCommand => ({
  templateId: 'tpl-a',
  expectedTemplateRevision: 0,
  expectedDraftRevision: 0,
  contentHash: templateContentHash(aggregate()),
  aggregate: aggregate(),
  items: [item()],
  packageComposition: [{ release: RELEASE, items: ['uptime'] }],
  sourceChain: chain(),
  publishedAt: AT,
  draftUpdatedAt: AT,
  actorId: 1,
  ...overrides,
});

async function code(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(TemplateError);
    return (error as TemplateError).code;
  }
  throw new Error('expected the call to fail');
}

type FaultHooks = {
  execute?: (sql: string) => 'throw' | undefined;
  commit?: () => 'commit-then-throw' | 'destroy-then-throw' | undefined;
};

/** Wraps one dedicated pool so a single SQL stage (or the commit) can fail. */
class FaultyPool implements TemplateSqlPool {
  constructor(private readonly inner: Pool, private readonly hooks: FaultHooks) {}

  async getConnection(): Promise<TemplateSqlConnection> {
    const connection: PoolConnection = await this.inner.getConnection();
    return {
      execute: async (sql, values) => {
        if (this.hooks.execute?.(sql) === 'throw') {
          throw new Error(`injected failure: ${sql.split('\n')[0]!.trim()}`);
        }
        return connection.execute(sql, values);
      },
      beginTransaction: () => connection.beginTransaction(),
      commit: async () => {
        const mode = this.hooks.commit?.();
        if (mode === 'destroy-then-throw') {
          connection.destroy();
          throw new Error('connection lost before commit');
        }
        await connection.commit();
        if (mode === 'commit-then-throw') throw new Error('commit acknowledgement lost');
      },
      rollback: () => connection.rollback(),
      release: () => connection.release(),
    };
  }
}

describe.skipIf(!enabled)('MAX-237 T2A MySQL template repository', () => {
  let poolA: Pool, poolB: Pool;
  let repositoryA: MySqlTemplateRepository, repositoryB: MySqlTemplateRepository;

  const poolOptions = {
    host: '127.0.0.1', port, user, password, database,
    waitForConnections: true, connectionLimit: 2,
  };
  const newPool = (): Pool => mysql.createPool({ ...poolOptions });

  beforeAll(async () => {
    poolA = mysql.createPool({ ...poolOptions });
    poolB = mysql.createPool({ ...poolOptions });
    repositoryA = new MySqlTemplateRepository(poolA);
    repositoryB = new MySqlTemplateRepository(poolB);
  });

  afterAll(async () => {
    await poolA?.end();
    await poolB?.end();
  });

  beforeEach(async () => {
    for (const table of [
      'metric_template_item_versions', 'metric_template_items', 'metric_template_versions',
      'metric_template_drafts', 'metric_templates_v2',
    ]) {
      await poolA.query(`DELETE FROM ${table}`);
    }
  });

  it('uses utf8mb4_bin tables and a strict UTC session', async () => {
    const [tables] = await poolA.query<any[]>(
      'SELECT TABLE_NAME, TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE ?',
      [database, 'metric_template%'],
    );
    expect(tables).toHaveLength(5);
    for (const table of tables) expect(table.TABLE_COLLATION).toBe('utf8mb4_bin');
    const [columns] = await poolA.query<any[]>(
      `SELECT COLUMN_NAME, COLLATION_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'metric_templates_v2'
          AND COLUMN_NAME IN ('template_id', 'name') ORDER BY COLUMN_NAME`,
      [database],
    );
    expect(columns.map(column => column.COLLATION_NAME)).toEqual(['utf8mb4_bin', 'utf8mb4_bin']);

    await repositoryA.create(template(), draft());
    const connection = await poolA.getConnection();
    try {
      const [session] = await connection.query<any[]>('SELECT @@session.time_zone AS tz, @@session.sql_mode AS mode');
      expect(session[0].tz).toBe('+00:00');
      expect(session[0].mode).toContain('STRICT_ALL_TABLES');
    } finally {
      connection.release();
    }
  });

  it('keeps ASCII identities case-sensitive and pages by ascending id', async () => {
    for (const id of ['tpl-B', 'tpl-A', 'tpl-a', 'tpl-b']) {
      await repositoryA.create(template(id), draft(id));
    }
    const all = await repositoryA.listTemplates({ limit: 100 });
    expect(all.items.map(entry => entry.template_id)).toEqual(['tpl-A', 'tpl-B', 'tpl-a', 'tpl-b']);
    const first = await repositoryA.listTemplates({ limit: 2 });
    expect(first.items.map(entry => entry.template_id)).toEqual(['tpl-A', 'tpl-B']);
    expect(first.next_cursor).toBe('tpl-B');
    const second = await repositoryA.listTemplates({ limit: 2, cursor: first.next_cursor! });
    expect(second.items.map(entry => entry.template_id)).toEqual(['tpl-a', 'tpl-b']);
    expect(second.next_cursor).toBeNull();
    expect(await repositoryA.listTemplates({ status: 'draft', limit: 100 })).toMatchObject({ next_cursor: null });

    await repositoryA.putItemVersion(itemInput({ item_id: 'Item' }));
    await repositoryA.putItemVersion(itemInput({ item_id: 'item' }));
    expect((await repositoryA.latestItemVersions('tpl-a')).map(entry => entry.item_id)).toEqual(['Item', 'item']);
    expect(await repositoryA.getItemVersion('tpl-A', 'uptime', 1)).toBeNull();
  });

  it('creates template, draft and copied items atomically', async () => {
    const copied = await repositoryA.create(template(), draft(), [itemInput()]);
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatchObject({ item_id: 'uptime', version: 1, display_name: 'Uptime' });
    expect(await repositoryA.getTemplate('tpl-a')).toMatchObject({
      revision: 0, current_published_version: null, created_by: 1,
    });
    expect(await repositoryA.getDraft('tpl-a')).toMatchObject({ revision: 0, published_version: null, updated_by: 1 });
    expect((await repositoryA.latestItemVersions('tpl-a')).map(entry => entry.version)).toEqual([1]);
    const [identity] = await poolA.query<any[]>(
      `SELECT status, DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at
         FROM metric_template_items WHERE template_id = ? AND item_id = ?`,
      ['tpl-a', 'uptime'],
    );
    expect(identity[0].status).toBe('active');
    expect(fromSqlDateTime(identity[0].created_at)).toBe(AT);

    expect(await code(repositoryA.create(template(), draft()))).toBe('TEMPLATE_EXISTS');
    expect(await code(repositoryA.create(template('tpl-b'), draft('tpl-b'), [itemInput()])))
      .toBe('TEMPLATE_ITEM_NOT_FOUND');
    expect(await repositoryA.getTemplate('tpl-b')).toBeNull();
    expect(await code(repositoryA.create(template('tpl-c'), draft('tpl-c'), [
      itemInput({ template_id: 'tpl-c' }), itemInput({ template_id: 'tpl-c' }),
    ]))).toBe('TEMPLATE_ITEM_DUPLICATE');
    expect(await repositoryA.getTemplate('tpl-c')).toBeNull();
    expect(await code(repositoryA.create(template('tpl-d'), draft('tpl-d', { revision: 1 }))))
      .toBe('TEMPLATE_EXISTS');
    expect(await repositoryA.getTemplate('tpl-d')).toBeNull();
  });

  it('rolls back a half-written create when a statement fails', async () => {
    const inner = newPool();
    try {
      const faulty = new MySqlTemplateRepository(new FaultyPool(inner, {
        execute: sql => (sql.startsWith('INSERT INTO metric_template_item_versions') ? 'throw' : undefined),
      }));
      await expect(faulty.create(template('tpl-e'), draft('tpl-e'), [itemInput({ template_id: 'tpl-e' })]))
        .rejects.toThrow(/injected failure/);
      expect(await repositoryA.getTemplate('tpl-e')).toBeNull();
      expect(await repositoryA.getDraft('tpl-e')).toBeNull();
      const [rows] = await poolA.query<any[]>(
        'SELECT (SELECT COUNT(*) FROM metric_template_items WHERE template_id = ?) AS items,'
        + ' (SELECT COUNT(*) FROM metric_template_item_versions WHERE template_id = ?) AS versions',
        ['tpl-e', 'tpl-e'],
      );
      expect(rows[0]).toMatchObject({ items: 0, versions: 0 });
    } finally {
      await inner.end();
    }
  });

  it('applies template and draft writes only at the expected revision', async () => {
    await repositoryA.create(template(), draft());
    const renamed = await repositoryA.updateTemplate('tpl-a', 0, { name: 'Template B', updated_at: AT });
    expect(renamed).toMatchObject({ name: 'Template B', revision: 1 });
    expect(await code(repositoryA.updateTemplate('tpl-a', 0, { name: 'C', updated_at: AT })))
      .toBe('TEMPLATE_REVISION_CONFLICT');
    const updated = await repositoryA.updateDraft('tpl-a', 0, {
      aggregate: { ...emptyDraftAggregate('tpl-a'), items: [{ item_id: 'uptime', version: 1 }] },
      updated_by: 2,
      updated_at: AT,
    });
    expect(updated).toMatchObject({ revision: 1, updated_by: 2 });
    expect(await code(repositoryA.updateDraft('tpl-a', 0, {
      aggregate: emptyDraftAggregate('tpl-a'), updated_by: 2, updated_at: AT,
    }))).toBe('TEMPLATE_DRAFT_CONFLICT');
    expect((await repositoryA.getDraft('tpl-a'))!.aggregate.items).toEqual([{ item_id: 'uptime', version: 1 }]);
    expect((await repositoryA.getTemplate('tpl-a'))!.name).toBe('Template B');
    expect(await code(repositoryA.updateTemplate('tpl-missing', 0, { name: 'X', updated_at: AT })))
      .toBe('TEMPLATE_NOT_FOUND');
  });

  it('initializes the first item identity once and appends only on real content change', async () => {
    await repositoryA.create(template(), draft());
    const first = await repositoryA.putItemVersion(itemInput());
    expect(first).toMatchObject({ reused: false, item: { version: 1 } });
    const reused = await repositoryA.putItemVersion(itemInput());
    expect(reused).toMatchObject({ reused: true, item: { version: 1 } });
    const renamed = await repositoryA.putItemVersion(itemInput({ display_name: 'Database uptime' }));
    expect(renamed).toMatchObject({ reused: false, item: { version: 2, display_name: 'Database uptime' } });
    expect((await repositoryA.getItemVersion('tpl-a', 'uptime', 1))!.display_name).toBe('Uptime');
    expect((await repositoryA.latestItemVersions('tpl-a')).map(entry => entry.version)).toEqual([2]);
    const [identity] = await poolA.query<any[]>(
      'SELECT status, DATE_FORMAT(created_at, \'%Y-%m-%dT%H:%i:%s.%fZ\') AS created_at FROM metric_template_items WHERE template_id = ? AND item_id = ?',
      ['tpl-a', 'uptime'],
    );
    expect(identity[0].status).toBe('active');
    expect(fromSqlDateTime(identity[0].created_at)).toBe(AT);

    expect(await code(repositoryA.putItemVersion(itemInput({ canonical_metric: { id: 'mysql.queries.total', semantic_version: '1.0.0' } }))))
      .toBe('TEMPLATE_ITEM_IDENTITY_INCOMPATIBLE');
    expect(await code(repositoryA.putItemVersion(itemInput({ unit: 'ms' }))))
      .toBe('TEMPLATE_ITEM_IDENTITY_INCOMPATIBLE');
    expect((await repositoryA.latestItemVersions('tpl-a')).map(entry => entry.version)).toEqual([2]);
  });

  it('compares dimension key sets without delimiter collisions and round-trips JSON', async () => {
    await repositoryA.create(template(), draft());
    await repositoryA.putItemVersion(itemInput({ item_id: 'empty', dimensions: {} }));
    expect(await code(repositoryA.putItemVersion(itemInput({ item_id: 'empty', dimensions: { '': 'unexpected dimension' } }))))
      .toBe('TEMPLATE_ITEM_IDENTITY_INCOMPATIBLE');
    await repositoryA.putItemVersion(itemInput({ item_id: 'comma', dimensions: { 'db,host': 'one dimension' } }));
    expect(await code(repositoryA.putItemVersion(itemInput({ item_id: 'comma', dimensions: { db: 'database', host: 'host' } }))))
      .toBe('TEMPLATE_ITEM_IDENTITY_INCOMPATIBLE');
    await repositoryA.putItemVersion(itemInput({ item_id: 'ordered', dimensions: { db: 'database', host: 'host' } }));
    const reordered = await repositoryA.putItemVersion(itemInput({ item_id: 'ordered', dimensions: { host: 'host', db: 'database' } }));
    expect(reordered).toMatchObject({ reused: true, item: { version: 1 } });

    const unicode = { '主机': '主机标识', ',': '逗号键', '': '空键' };
    await repositoryA.putItemVersion(itemInput({ item_id: 'json', dimensions: unicode }));
    expect((await repositoryA.getItemVersion('tpl-a', 'json', 1))!.dimensions).toEqual(unicode);
    expect((await repositoryA.latestItemVersions('tpl-a')).map(entry => entry.item_id))
      .toEqual(['comma', 'empty', 'json', 'ordered']);
  });

  it('serialises colliding first-item writes across two independent connections', async () => {
    await repositoryA.create(template(), draft());
    const colliding = await Promise.allSettled([
      repositoryA.putItemVersion(itemInput({ item_id: 'race', dimensions: {} })),
      repositoryB.putItemVersion(itemInput({ item_id: 'race', dimensions: { '': 'unexpected dimension' } })),
    ]);
    expect(colliding.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = colliding.find(outcome => outcome.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as TemplateError).code).toBe('TEMPLATE_ITEM_IDENTITY_INCOMPATIBLE');
    expect((await repositoryA.latestItemVersions('tpl-a')).filter(entry => entry.item_id === 'race').map(entry => entry.version))
      .toEqual([1]);

    const identical = await Promise.allSettled([
      repositoryA.putItemVersion(itemInput({ item_id: 'same' })),
      repositoryB.putItemVersion(itemInput({ item_id: 'same' })),
    ]);
    expect(identical.every(outcome => outcome.status === 'fulfilled')).toBe(true);
    expect((await repositoryA.latestItemVersions('tpl-a')).filter(entry => entry.item_id === 'same').map(entry => entry.version))
      .toEqual([1]);
  }, 30_000);

  it('publishes immutable versions with CAS, idempotency and unchanged snapshots', async () => {
    await repositoryA.create(template(), draft());
    await repositoryA.putItemVersion(itemInput());
    const first = await repositoryA.publish(command());
    expect(first).toMatchObject({ noop: false, version: 1, revision: 1 });
    expect((await repositoryA.getTemplate('tpl-a'))!.current_published_version).toBe(1);

    expect(await code(repositoryA.publish(command({ expectedTemplateRevision: 0 }))))
      .toBe('TEMPLATE_REVISION_CONFLICT');
    expect(await code(repositoryA.publish(command({ expectedTemplateRevision: 1, expectedDraftRevision: 0 }))))
      .toBe('TEMPLATE_DRAFT_CONFLICT');
    expect(await repositoryA.listVersions('tpl-a')).toHaveLength(1);

    const noop = await repositoryA.publish(command({ expectedTemplateRevision: 1, expectedDraftRevision: 1 }));
    expect(noop).toMatchObject({ noop: true, version: 1, revision: 1 });
    expect((await repositoryA.getDraft('tpl-a'))!.published_version).toBe(1);
    expect(await repositoryA.findVersionByContentHash('tpl-a', command().contentHash)).toMatchObject({ version: 1 });

    const changed = aggregate();
    changed.parameters = {
      schema: { interval_ms: { type: 'integer', min: 1000 } },
      defaults: { interval_ms: 60000 },
    };
    const second = await repositoryA.publish(command({
      expectedTemplateRevision: 1,
      expectedDraftRevision: 1,
      aggregate: changed,
      packageComposition: changed.package_composition,
      contentHash: templateContentHash(changed),
    }));
    expect(second).toMatchObject({ noop: false, version: 2, revision: 2 });
    const snapshot = await repositoryA.getVersion('tpl-a', 1);
    expect(snapshot!.content_hash).toBe(templateContentHash(aggregate()));
    expect(snapshot!.aggregate.parameters.defaults).toEqual({});
    expect((await repositoryA.getDraft('tpl-a'))!.published_version).toBe(2);
    expect((await repositoryA.listVersions('tpl-a')).map(entry => entry.version)).toEqual([1, 2]);

    await repositoryA.updateTemplate('tpl-a', 2, { name: 'Renamed', updated_at: AT });
    expect(await repositoryA.getVersion('tpl-a', 1)).toEqual(snapshot);
    // A snapshot that disagrees with its own aggregate is rejected before any write.
    await expect(repositoryA.publish(command({
      expectedTemplateRevision: 3, expectedDraftRevision: 2, items: [],
    }))).rejects.toThrow(/TEMPLATE_ITEM_SNAPSHOT/);
    expect((await repositoryA.listVersions('tpl-a')).map(entry => entry.version)).toEqual([1, 2]);
  });

  it('lets exactly one concurrent publish at the same revision win the CAS', async () => {
    await repositoryA.create(template(), draft());
    await repositoryA.putItemVersion(itemInput());
    const outcomes = await Promise.allSettled([repositoryA.publish(command()), repositoryB.publish(command())]);
    const fulfilled = outcomes.filter(outcome => outcome.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    const rejected = outcomes.filter(outcome => outcome.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0].value).toMatchObject({ noop: false, version: 1, revision: 1 });
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as TemplateError).code).toBe('TEMPLATE_REVISION_CONFLICT');
    expect((await repositoryA.listVersions('tpl-a')).map(entry => entry.version)).toEqual([1]);
    expect((await repositoryA.getTemplate('tpl-a'))!.revision).toBe(1);
  }, 30_000);

  it('rolls back the new snapshot when the pointer update fails', async () => {
    await repositoryA.create(template(), draft());
    await repositoryA.putItemVersion(itemInput());
    const inner = newPool();
    try {
      const faulty = new MySqlTemplateRepository(new FaultyPool(inner, {
        execute: sql => (sql.startsWith('UPDATE metric_templates_v2') ? 'throw' : undefined),
      }));
      await expect(faulty.publish(command())).rejects.toThrow(/injected failure/);
      expect(await repositoryA.listVersions('tpl-a')).toEqual([]);
      expect(await repositoryA.getTemplate('tpl-a')).toMatchObject({ revision: 0, current_published_version: null });
      expect(await repositoryA.getDraft('tpl-a')).toMatchObject({ revision: 0, published_version: null });
    } finally {
      await inner.end();
    }
  });

  it('keeps an unknown outcome when the commit acknowledgement is lost', async () => {
    await repositoryA.create(template(), draft());
    await repositoryA.putItemVersion(itemInput());
    const inner = newPool();
    try {
      const faulty = new MySqlTemplateRepository(new FaultyPool(inner, {
        commit: () => 'commit-then-throw',
      }));
      const error = await faulty.publish(command()).catch(caught => caught);
      expect(error).toBeInstanceOf(TemplateStorageUnknownCommitError);
      expect(error).toMatchObject({
        operation: 'publish',
        identity: { template_id: 'tpl-a', content_hash: command().contentHash },
      });
      // The transaction really committed; the adapter did not claim failure or success.
      expect((await repositoryA.listVersions('tpl-a')).map(entry => entry.version)).toEqual([1]);
      expect((await repositoryA.getTemplate('tpl-a'))!.current_published_version).toBe(1);
      // A re-read then a retry with fresh revisions is an idempotent no-op, not v2.
      const retry = await repositoryA.publish(command({ expectedTemplateRevision: 1, expectedDraftRevision: 1 }));
      expect(retry).toMatchObject({ noop: true, version: 1 });
      expect(await repositoryA.listVersions('tpl-a')).toHaveLength(1);
    } finally {
      await inner.end();
    }
  });

  it('rolls back server-side when the connection drops before commit', async () => {
    await repositoryA.create(template(), draft());
    await repositoryA.putItemVersion(itemInput());
    const inner = newPool();
    try {
      const faulty = new MySqlTemplateRepository(new FaultyPool(inner, {
        commit: () => 'destroy-then-throw',
      }));
      const error = await faulty.publish(command()).catch(caught => caught);
      expect(error).toBeInstanceOf(TemplateStorageUnknownCommitError);
      expect(await repositoryA.listVersions('tpl-a')).toEqual([]);
      expect(await repositoryA.getTemplate('tpl-a')).toMatchObject({ revision: 0, current_published_version: null });
      expect((await repositoryA.getDraft('tpl-a'))!.published_version).toBeNull();
    } finally {
      await inner.end();
    }
  });

  it('reads persisted state through a fresh repository connection', async () => {
    await repositoryA.create(template(), draft());
    await repositoryA.putItemVersion(itemInput());
    await repositoryA.publish(command());
    const inner = newPool();
    try {
      const fresh = new MySqlTemplateRepository(inner);
      expect(await fresh.getTemplate('tpl-a')).toMatchObject({ revision: 1, current_published_version: 1 });
      expect((await fresh.getVersion('tpl-a', 1))!.content_hash).toBe(command().contentHash);
      expect((await fresh.latestItemVersions('tpl-a')).map(entry => entry.version)).toEqual([1]);
      expect(await fresh.getDraft('tpl-a')).toMatchObject({ revision: 1, published_version: 1 });
    } finally {
      await inner.end();
    }
  });

  it('maps SQL NULL and 0–3 digit UTC timestamps without inventing values', async () => {
    await repositoryA.create(
      template('tpl-null', { created_by: null, created_at: '2026-10-27T00:00:00Z', updated_at: '2026-10-27T00:00:00.1Z' }),
      draft('tpl-null', { updated_by: null, updated_at: '2026-10-27T00:00:00.12Z' }),
    );
    const record = await repositoryA.getTemplate('tpl-null');
    expect(record).toMatchObject({ created_by: null, current_published_version: null, revision: 0 });
    expect(record!.created_at).toBe('2026-10-27T00:00:00.000Z');
    expect(record!.updated_at).toBe('2026-10-27T00:00:00.100Z');
    const stored = await repositoryA.getDraft('tpl-null');
    expect(stored).toMatchObject({ published_version: null, updated_by: null });
    expect(stored!.updated_at).toBe('2026-10-27T00:00:00.120Z');
    const [raw] = await poolA.query<any[]>(
      'SELECT created_by, current_published_version, DATE_FORMAT(created_at, \'%Y-%m-%dT%H:%i:%s.%fZ\') AS created_at FROM metric_templates_v2 WHERE template_id = ?',
      ['tpl-null'],
    );
    expect(raw[0].created_by).toBeNull();
    expect(raw[0].current_published_version).toBeNull();
    expect(fromSqlDateTime(raw[0].created_at)).toBe('2026-10-27T00:00:00.000Z');

    // The original source_chain JSON is stored as given (no timestamp rewrite).
    await repositoryA.putItemVersion(itemInput({ template_id: 'tpl-null', source_chain: {
      ...chain(), created_at: '2026-10-27T00:00:00.1Z', published_at: '2026-10-27T00:00:00.1Z',
    } }));
    const [json] = await poolA.query<any[]>(
      'SELECT source_chain FROM metric_template_item_versions WHERE template_id = ? AND item_id = ? AND version = 1',
      ['tpl-null', 'uptime'],
    );
    const sourceChain = typeof json[0].source_chain === 'string' ? JSON.parse(json[0].source_chain) : json[0].source_chain;
    expect(sourceChain.created_at).toBe('2026-10-27T00:00:00.1Z');
  });

  it('rejects values the five tables cannot represent before writing', async () => {
    await expect(repositoryA.create(template('tpl-actor', { created_by: 2147483648 }), draft('tpl-actor')))
      .rejects.toMatchObject({ code: 'TEMPLATE_INVALID_INPUT' });
    expect(await repositoryA.getTemplate('tpl-actor')).toBeNull();

    await repositoryA.create(template('tpl-len'), draft('tpl-len'));
    await expect(repositoryA.putItemVersion(itemInput({
      template_id: 'tpl-len', item_id: 'long', canonical_metric: { id: `a.${'b'.repeat(127)}`, semantic_version: '1.0.0' },
    }))).rejects.toMatchObject({ code: 'TEMPLATE_INVALID_INPUT' });
    await expect(repositoryA.putItemVersion(itemInput({
      template_id: 'tpl-len', item_id: 'semver', canonical_metric: { id: 'db.uptime_seconds', semantic_version: `${'1'.repeat(17)}.0.0` },
    }))).rejects.toMatchObject({ code: 'TEMPLATE_INVALID_INPUT' });
    expect(await repositoryA.latestItemVersions('tpl-len')).toEqual([]);

    await expect(repositoryA.create(
      template('tpl-year', { created_at: '0999-12-31T23:59:59.000Z', updated_at: '2026-10-27T00:00:00.000Z' }),
      draft('tpl-year'),
    )).rejects.toMatchObject({ code: 'TEMPLATE_INVALID_INPUT' });
    expect(await repositoryA.getTemplate('tpl-year')).toBeNull();

    await poolA.query(
      `INSERT INTO metric_templates_v2
        (template_id, name, status, current_published_version, revision, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['tpl-max', 'Max', 'draft', null, 2147483647, 1, '2026-10-27 00:00:00.000', '2026-10-27 00:00:00.000'],
    );
    await expect(repositoryA.updateTemplate('tpl-max', 2147483647, { name: 'X', updated_at: AT }))
      .rejects.toMatchObject({ code: 'TEMPLATE_INVALID_INPUT' });
    expect((await repositoryA.getTemplate('tpl-max'))!.revision).toBe(2147483647);

    await repositoryA.create(template('tpl-item-max'), draft('tpl-item-max'));
    await poolA.query(
      `INSERT INTO metric_template_items (template_id, item_id, status, created_at) VALUES (?, ?, ?, ?)`,
      ['tpl-item-max', 'uptime', 'active', '2026-10-27 00:00:00.000'],
    );
    await poolA.query(
      `INSERT INTO metric_template_item_versions
        (template_id, item_id, version, display_name, canonical_metric_id, canonical_semantic_version,
         unit, dimensions, collector_ref, params_default, source_chain)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['tpl-item-max', 'uptime', 2147483647, 'Uptime', 'db.uptime_seconds', '1.0.0', 's', '{}',
        JSON.stringify({ package_release: RELEASE, implementation_id: 'builtin:mysql.status.v1' }), '{}',
        JSON.stringify(chain())],
    );
    await expect(repositoryA.putItemVersion(itemInput({ template_id: 'tpl-item-max', display_name: 'Changed' })))
      .rejects.toMatchObject({ code: 'TEMPLATE_INVALID_INPUT' });
    expect((await repositoryA.latestItemVersions('tpl-item-max')).map(entry => entry.version)).toEqual([2147483647]);

    await repositoryA.create(template('tpl-vermax'), draft('tpl-vermax'));
    await repositoryA.putItemVersion(itemInput({ template_id: 'tpl-vermax' }));
    await repositoryA.publish(command({
      templateId: 'tpl-vermax',
      aggregate: aggregate('tpl-vermax'),
      items: [item('tpl-vermax')],
    }));
    await poolA.query('UPDATE metric_template_versions SET version = 2147483647 WHERE template_id = ? AND version = 1', ['tpl-vermax']);
    const changed = aggregate('tpl-vermax');
    changed.parameters = { schema: { interval_ms: { type: 'integer', min: 1000 } }, defaults: { interval_ms: 60000 } };
    await expect(repositoryA.publish(command({
      templateId: 'tpl-vermax',
      expectedTemplateRevision: 1,
      expectedDraftRevision: 1,
      aggregate: changed,
      items: [item('tpl-vermax')],
      packageComposition: changed.package_composition,
      contentHash: templateContentHash(changed),
    }))).rejects.toMatchObject({ code: 'TEMPLATE_INVALID_INPUT' });
    expect((await repositoryA.listVersions('tpl-vermax')).map(entry => entry.version)).toEqual([2147483647]);
    expect((await repositoryA.getTemplate('tpl-vermax'))!.current_published_version).toBe(1);
  });
});
