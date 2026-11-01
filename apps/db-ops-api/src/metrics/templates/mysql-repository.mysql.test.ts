/**
 * MAX-237 / T2B — real MySQL transaction and storage-candidate verification.
 *
 * Runs only against the dedicated, disposable schema started by
 * `docs/slide/development/MAX-237/t2b/env-start.sh` (candidate database
 * `max237_t2b`, tables utf8mb4_bin, one-time DML-only test user). Skipped when
 * the four `MAX237_T2B_MYSQL_*` variables are absent or when the database is not
 * exactly `max237_t2b`, so the default suite needs no database and this file can
 * never point at another schema. Never points at an application `.env`, the
 * platform pool or a production target.
 *
 * Two independent pools (`A`, `B`) stand in for two connections/processes: the
 * parent-row lock in the adapter, not an in-process lock, is what serialises
 * them. Fault-injecting wrappers around a third pool fail at one exact SQL
 * stage; they never change the product interface. The pools enable
 * `supportBigNumbers`/`bigNumberStrings`, and a second number-form pool proves
 * the adapter accepts both BIGINT renderings.
 */
import mysql, { type Pool, type PoolConnection } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TemplateError } from './errors.js';
import {
  emptyDraftAggregate, templateContentHash, type SourceChain, type TemplateDraft,
  type TemplateItemVersion, type TemplatePublishedAggregate, type TemplateRecord,
} from './model.js';
import {
  MySqlTemplateRepository, TemplateStorageUnknownCommitError, fromSqlTimestamp,
  type TemplateSqlConnection, type TemplateSqlPool,
} from './mysql-repository.js';
import type { ItemVersionInput, PublishCommand } from './repository.js';

const FIXED_DATABASE = 'max237_t2b';
const port = Number(process.env.MAX237_T2B_MYSQL_PORT);
const user = process.env.MAX237_T2B_MYSQL_USER;
const password = process.env.MAX237_T2B_MYSQL_PASSWORD;
const database = process.env.MAX237_T2B_MYSQL_DATABASE ?? FIXED_DATABASE;
const enabled = Number.isInteger(port) && port > 0 && Boolean(user) && password !== undefined
  && database === FIXED_DATABASE;

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
  commit?: () => 'throw-before-forward' | 'commit-then-throw' | 'destroy-then-throw' | undefined;
  rollback?: () => 'throw' | undefined;
};

/**
 * Wraps one dedicated pool so a single SQL stage (or the transaction end) can
 * fail. It counts release/destroy so a test can prove which one the adapter chose.
 */
class FaultyPool implements TemplateSqlPool {
  releases = 0;
  destroys = 0;

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
        if (mode === 'throw-before-forward') throw new Error('commit not sent; socket remains live');
        if (mode === 'destroy-then-throw') {
          connection.destroy();
          throw new Error('connection lost before commit');
        }
        await connection.commit();
        if (mode === 'commit-then-throw') throw new Error('commit acknowledgement lost');
      },
      rollback: async () => {
        if (this.hooks.rollback?.() === 'throw') throw new Error('rollback unavailable; socket remains live');
        return connection.rollback();
      },
      release: () => {
        this.releases += 1;
        connection.release();
      },
      destroy: () => {
        this.destroys += 1;
        connection.destroy();
      },
    };
  }
}

describe.skipIf(!enabled)('MAX-237 T2B MySQL template repository', () => {
  let poolA: Pool, poolB: Pool, poolNumbers: Pool;
  let repositoryA: MySqlTemplateRepository, repositoryB: MySqlTemplateRepository;

  const poolOptions = {
    host: '127.0.0.1', port, user, password, database,
    waitForConnections: true, connectionLimit: 2,
    supportBigNumbers: true, bigNumberStrings: true,
  };
  const newPool = (overrides: Partial<typeof poolOptions> = {}): Pool => mysql.createPool({ ...poolOptions, ...overrides });

  beforeAll(async () => {
    poolA = mysql.createPool({ ...poolOptions });
    poolB = mysql.createPool({ ...poolOptions });
    repositoryA = new MySqlTemplateRepository(poolA);
    repositoryB = new MySqlTemplateRepository(poolB);
    // Same fixture, number-form BIGINT rendering (no bigNumberStrings).
    poolNumbers = mysql.createPool({ ...poolOptions, bigNumberStrings: false });
  });

  afterAll(async () => {
    await poolA?.end();
    await poolB?.end();
    await poolNumbers?.end();
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

    // Candidate representations: BIGINT UNSIGNED actors, ascii LONGTEXT
    // identities, and 24-char ascii timestamps.
    const [candidate] = await poolA.query<any[]>(
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, CHARACTER_SET_NAME, COLLATION_NAME
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND (
          (TABLE_NAME = 'metric_templates_v2' AND COLUMN_NAME IN ('created_by', 'created_at', 'updated_at'))
          OR (TABLE_NAME = 'metric_template_drafts' AND COLUMN_NAME IN ('updated_by', 'updated_at'))
          OR (TABLE_NAME = 'metric_template_versions' AND COLUMN_NAME IN ('published_at', 'retired_at'))
          OR (TABLE_NAME = 'metric_template_items' AND COLUMN_NAME = 'created_at')
          OR (TABLE_NAME = 'metric_template_item_versions' AND COLUMN_NAME IN ('canonical_metric_id', 'canonical_semantic_version'))
        )
        ORDER BY TABLE_NAME, COLUMN_NAME`,
      [database],
    );
    const byColumn = new Map(candidate.map(column => [`${column.TABLE_NAME}.${column.COLUMN_NAME}`, column]));
    expect(byColumn.get('metric_templates_v2.created_by')).toMatchObject({ COLUMN_TYPE: 'bigint unsigned', COLLATION_NAME: null });
    expect(byColumn.get('metric_template_drafts.updated_by')).toMatchObject({ COLUMN_TYPE: 'bigint unsigned', COLLATION_NAME: null });
    expect(byColumn.get('metric_template_item_versions.canonical_metric_id')).toMatchObject({
      COLUMN_TYPE: 'longtext', CHARACTER_SET_NAME: 'ascii', COLLATION_NAME: 'ascii_bin',
    });
    expect(byColumn.get('metric_template_item_versions.canonical_semantic_version')).toMatchObject({
      COLUMN_TYPE: 'longtext', CHARACTER_SET_NAME: 'ascii', COLLATION_NAME: 'ascii_bin',
    });
    for (const key of [
      'metric_templates_v2.created_at', 'metric_templates_v2.updated_at', 'metric_template_drafts.updated_at',
      'metric_template_versions.published_at', 'metric_template_versions.retired_at', 'metric_template_items.created_at',
    ]) {
      expect(byColumn.get(key)).toMatchObject({
        COLUMN_TYPE: 'char(24)', CHARACTER_SET_NAME: 'ascii', COLLATION_NAME: 'ascii_bin',
      });
    }
    // The canonical prefix index accelerates lookups only; it is not unique.
    const [indexes] = await poolA.query<any[]>(
      `SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SUB_PART FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'metric_template_item_versions' AND INDEX_NAME = 'idx_canonical'
        ORDER BY SEQ_IN_INDEX`,
      [database],
    );
    expect(indexes.map(index => ({
      name: index.INDEX_NAME, nonUnique: Number(index.NON_UNIQUE),
      column: index.COLUMN_NAME, subPart: Number(index.SUB_PART),
    }))).toEqual([
      { name: 'idx_canonical', nonUnique: 1, column: 'canonical_metric_id', subPart: 128 },
      { name: 'idx_canonical', nonUnique: 1, column: 'canonical_semantic_version', subPart: 16 },
    ]);

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
      'SELECT status, created_at FROM metric_template_items WHERE template_id = ? AND item_id = ?',
      ['tpl-a', 'uptime'],
    );
    expect(identity[0].status).toBe('active');
    expect(identity[0].created_at).toBe(AT);

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
      expect({ items: Number(rows[0].items), versions: Number(rows[0].versions) }).toEqual({ items: 0, versions: 0 });
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
      'SELECT status, created_at FROM metric_template_items WHERE template_id = ? AND item_id = ?',
      ['tpl-a', 'uptime'],
    );
    expect(identity[0].status).toBe('active');
    expect(identity[0].created_at).toBe(AT);

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
    const fresh = newPool();
    try {
      const fault = new FaultyPool(inner, {
        commit: () => 'commit-then-throw',
      });
      const faulty = new MySqlTemplateRepository(fault);
      const error = await faulty.publish(command()).catch(caught => caught);
      expect(error).toBeInstanceOf(TemplateStorageUnknownCommitError);
      expect(error).toMatchObject({
        operation: 'publish',
        identity: { template_id: 'tpl-a', content_hash: command().contentHash },
      });
      // The end state is unknown, so the live connection must not go back to the pool.
      expect(fault.destroys).toBe(1);
      expect(fault.releases).toBe(0);
      // The transaction really committed; a NEW connection reads the exact result
      // and neither the adapter nor the retry appends an extra version.
      const reread = new MySqlTemplateRepository(fresh);
      expect((await reread.listVersions('tpl-a')).map(entry => entry.version)).toEqual([1]);
      expect(await reread.getVersion('tpl-a', 1)).toMatchObject({ content_hash: command().contentHash });
      expect((await reread.getTemplate('tpl-a'))!.current_published_version).toBe(1);
      const retry = await reread.publish(command({ expectedTemplateRevision: 1, expectedDraftRevision: 1 }));
      expect(retry).toMatchObject({ noop: true, version: 1 });
      expect(await reread.listVersions('tpl-a')).toHaveLength(1);
    } finally {
      await inner.end();
      await fresh.end();
    }
  });

  it('discards the connection after an unconfirmed rollback and never reuses its transaction', async () => {
    const inner = newPool({ connectionLimit: 1 });
    const observer = newPool();
    try {
      const fault = new FaultyPool(inner, {
        execute: sql => (sql.startsWith('INSERT INTO metric_template_drafts') ? 'throw' : undefined),
        rollback: () => 'throw',
      });
      const faulty = new MySqlTemplateRepository(fault);
      await expect(faulty.create(template('tpl-tx-rollback'), draft('tpl-tx-rollback')))
        .rejects.toThrow(/injected failure: INSERT INTO metric_template_drafts/);
      expect(fault.destroys).toBe(1);
      expect(fault.releases).toBe(0);

      const counts = async () => {
        const [rows] = await observer.query<any[]>(
          'SELECT (SELECT COUNT(*) FROM metric_templates_v2 WHERE template_id = ?) AS parents,'
          + ' (SELECT COUNT(*) FROM metric_template_drafts WHERE template_id = ?) AS drafts',
          ['tpl-tx-rollback', 'tpl-tx-rollback'],
        );
        return { parents: Number(rows[0].parents), drafts: Number(rows[0].drafts) };
      };
      // Independent observer: the server never received a commit.
      expect(await counts()).toEqual({ parents: 0, drafts: 0 });
      // The single-connection pool must have handed out a NEW connection to this
      // read; the old uncommitted parent is not visible through it.
      const reread = new MySqlTemplateRepository(inner);
      expect(await reread.getTemplate('tpl-tx-rollback')).toBeNull();
      // An unrelated valid write must not implicitly commit the old pending rows.
      await reread.create(template('tpl-tx-rollback-next'), draft('tpl-tx-rollback-next'));
      expect(await counts()).toEqual({ parents: 0, drafts: 0 });
    } finally {
      await inner.end();
      await observer.end();
    }
  }, 30_000);

  it('discards a live connection whose commit was never sent and cannot replay it', async () => {
    const inner = newPool({ connectionLimit: 1 });
    const observer = newPool();
    try {
      const fault = new FaultyPool(inner, { commit: () => 'throw-before-forward' });
      const faulty = new MySqlTemplateRepository(fault);
      const error = await faulty.create(template('tpl-tx-unknown'), draft('tpl-tx-unknown')).catch(caught => caught);
      expect(error).toBeInstanceOf(TemplateStorageUnknownCommitError);
      expect(error).toMatchObject({
        code: 'TEMPLATE_STORAGE_UNKNOWN_COMMIT',
        operation: 'create',
        identity: { template_id: 'tpl-tx-unknown' },
      });
      expect(fault.destroys).toBe(1);
      expect(fault.releases).toBe(0);
      // A fresh connection on the same single-connection pool sees nothing, and a
      // later unrelated create cannot commit the aborted rows.
      const reread = new MySqlTemplateRepository(inner);
      expect(await reread.getTemplate('tpl-tx-unknown')).toBeNull();
      await reread.create(template('tpl-tx-unknown-next'), draft('tpl-tx-unknown-next'));
      expect(await reread.getTemplate('tpl-tx-unknown')).toBeNull();
      const [rows] = await observer.query<any[]>(
        'SELECT (SELECT COUNT(*) FROM metric_templates_v2 WHERE template_id = ?) AS parents,'
        + ' (SELECT COUNT(*) FROM metric_template_drafts WHERE template_id = ?) AS drafts',
        ['tpl-tx-unknown', 'tpl-tx-unknown'],
      );
      expect({ parents: Number(rows[0].parents), drafts: Number(rows[0].drafts) }).toEqual({ parents: 0, drafts: 0 });
    } finally {
      await inner.end();
      await observer.end();
    }
  }, 30_000);

  it('keeps the pool usable after repeated failed transactions', async () => {
    const inner = newPool({ connectionLimit: 1 });
    try {
      const fault = new FaultyPool(inner, {
        execute: sql => (sql.startsWith('INSERT INTO metric_template_drafts') ? 'throw' : undefined),
        rollback: () => 'throw',
      });
      const faulty = new MySqlTemplateRepository(fault);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(faulty.create(template(`tpl-repeat-${attempt}`), draft(`tpl-repeat-${attempt}`)))
          .rejects.toThrow(/injected failure/);
      }
      expect(fault.destroys).toBe(3);
      expect(fault.releases).toBe(0);
      // The single-connection pool still serves a healthy connection; the failed
      // transactions left no rows and no locks behind.
      const healthy = new MySqlTemplateRepository(inner);
      await healthy.create(template('tpl-after-failures'), draft('tpl-after-failures'));
      expect(await healthy.getTemplate('tpl-after-failures')).not.toBeNull();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(await healthy.getTemplate(`tpl-repeat-${attempt}`)).toBeNull();
      }
    } finally {
      await inner.end();
    }
  }, 30_000);

  it('rolls back server-side when the connection drops before commit', async () => {
    await repositoryA.create(template(), draft());
    await repositoryA.putItemVersion(itemInput());
    const inner = newPool();
    try {
      const fault = new FaultyPool(inner, {
        commit: () => 'destroy-then-throw',
      });
      const faulty = new MySqlTemplateRepository(fault);
      const error = await faulty.publish(command()).catch(caught => caught);
      expect(error).toBeInstanceOf(TemplateStorageUnknownCommitError);
      expect(fault.releases).toBe(0);
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

  it('maps SQL NULL and canonical UTC timestamps without inventing values', async () => {
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
      'SELECT created_by, current_published_version, created_at FROM metric_templates_v2 WHERE template_id = ?',
      ['tpl-null'],
    );
    expect(raw[0].created_by).toBeNull();
    expect(raw[0].current_published_version).toBeNull();
    // The column stores the 24-character canonical form verbatim.
    expect(raw[0].created_at).toBe('2026-10-27T00:00:00.000Z');
    expect(raw[0].created_at).toHaveLength(24);
    expect(fromSqlTimestamp(raw[0].created_at)).toBe('2026-10-27T00:00:00.000Z');

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

  it('stores the full BIGINT actor range across both driver renderings', async () => {
    await repositoryA.create(
      template('tpl-actor-big', { created_by: 2147483648 }),
      draft('tpl-actor-big', { updated_by: 9007199254740991 }),
    );
    expect((await repositoryA.getTemplate('tpl-actor-big'))!.created_by).toBe(2147483648);
    expect((await repositoryA.getDraft('tpl-actor-big'))!.updated_by).toBe(9007199254740991);

    // The bigNumberStrings pool renders BIGINT as a string; the adapter maps it.
    const [raw] = await poolA.query<any[]>(
      'SELECT created_by FROM metric_templates_v2 WHERE template_id = ?', ['tpl-actor-big'],
    );
    expect(raw[0].created_by).toBe('2147483648');

    // The number-form pool renders the same row as a number; the adapter maps it too.
    const numbers = new MySqlTemplateRepository(poolNumbers);
    expect((await numbers.getTemplate('tpl-actor-big'))!.created_by).toBe(2147483648);
    expect((await numbers.getDraft('tpl-actor-big'))!.updated_by).toBe(9007199254740991);

    // A row written outside the adapter beyond the safe range is refused on read.
    await poolA.query(
      `INSERT INTO metric_templates_v2
        (template_id, name, status, current_published_version, revision, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['tpl-actor-unsafe', 'Unsafe', 'draft', null, 0, '9007199254740992', AT, AT],
    );
    await expect(repositoryA.getTemplate('tpl-actor-unsafe'))
      .rejects.toMatchObject({ code: 'TEMPLATE_INVALID_INPUT' });

    // The accepted record schema still rejects a non-safe integer input.
    await expect(repositoryA.create(
      template('tpl-actor-schema', { created_by: 9007199254740992 }), draft('tpl-actor-schema'),
    )).rejects.toThrow();
    expect(await repositoryA.getTemplate('tpl-actor-schema')).toBeNull();
  });

  it('stores canonical identities beyond the old widths and never matches on the prefix', async () => {
    await repositoryA.create(template('tpl-len'), draft('tpl-len'));
    const longId = `a.${'b'.repeat(510)}`;
    const longVersion = `${'1'.repeat(96)}.0.0`;
    expect(longId).toHaveLength(512);
    expect(longVersion).toHaveLength(100);
    const long = await repositoryA.putItemVersion(itemInput({
      template_id: 'tpl-len', item_id: 'long',
      canonical_metric: { id: longId, semantic_version: longVersion },
    }));
    expect(long.item.canonical_metric).toEqual({ id: longId, semantic_version: longVersion });
    expect((await repositoryA.getItemVersion('tpl-len', 'long', 1))!.canonical_metric.id).toBe(longId);
    expect((await repositoryA.getItemVersion('tpl-len', 'long', 1))!.canonical_metric.semantic_version).toBe(longVersion);

    // Same 128/16 prefix, different suffix: complete values stay distinct.
    const prefix = `a.${'c'.repeat(126)}`;
    const suffixA = `${prefix}${'d'.repeat(10)}`;
    const suffixB = `${prefix}${'e'.repeat(10)}`;
    expect(prefix).toHaveLength(128);
    await repositoryA.putItemVersion(itemInput({
      template_id: 'tpl-len', item_id: 'prefix-a', canonical_metric: { id: suffixA, semantic_version: '1.0.0' },
    }));
    await repositoryA.putItemVersion(itemInput({
      template_id: 'tpl-len', item_id: 'prefix-b', canonical_metric: { id: suffixB, semantic_version: '1.0.0' },
    }));
    expect((await repositoryA.getItemVersion('tpl-len', 'prefix-a', 1))!.canonical_metric.id).toBe(suffixA);
    expect((await repositoryA.getItemVersion('tpl-len', 'prefix-b', 1))!.canonical_metric.id).toBe(suffixB);
    // The prefix index sees only the shared 128 characters — it is an accelerator,
    // never an identity criterion.
    const [byPrefix] = await poolA.query<any[]>(
      'SELECT COUNT(*) AS matched FROM metric_template_item_versions WHERE canonical_metric_id LIKE ?', [`${prefix}%`],
    );
    expect(Number(byPrefix[0].matched)).toBe(2);
    await expect(repositoryA.putItemVersion(itemInput({
      template_id: 'tpl-len', item_id: 'prefix-a', canonical_metric: { id: suffixB, semantic_version: '1.0.0' },
    }))).rejects.toMatchObject({ code: 'TEMPLATE_ITEM_IDENTITY_INCOMPATIBLE' });

    // The accepted ASCII/semver rules still reject non-ASCII ids and malformed versions.
    await expect(repositoryA.putItemVersion(itemInput({
      template_id: 'tpl-len', item_id: 'unicode', canonical_metric: { id: 'db.主机', semantic_version: '1.0.0' },
    }))).rejects.toThrow();
    await expect(repositoryA.putItemVersion(itemInput({
      template_id: 'tpl-len', item_id: 'bad-semver', canonical_metric: { id: 'db.uptime_seconds', semantic_version: '1.0' },
    }))).rejects.toThrow();
    expect(await repositoryA.getItemVersion('tpl-len', 'unicode', 1)).toBeNull();
    expect(await repositoryA.getItemVersion('tpl-len', 'bad-semver', 1)).toBeNull();
  });

  it('stores years 0000..9999 and canonical fractions, and refuses invalid instants', async () => {
    const cases = [
      ['tpl-y0', '0000-01-01T00:00:00.000Z', '0000-01-01T00:00:00.000Z'],
      ['tpl-y999', '0999-12-31T23:59:59Z', '0999-12-31T23:59:59.000Z'],
      ['tpl-y1000', '1000-01-01T00:00:00.1Z', '1000-01-01T00:00:00.100Z'],
      ['tpl-y9999', '9999-12-31T23:59:59.123Z', '9999-12-31T23:59:59.123Z'],
    ] as const;
    for (const [id, input, canonical] of cases) {
      await repositoryA.create(
        template(id, { created_at: input, updated_at: input }),
        draft(id, { updated_at: input }),
      );
      const record = await repositoryA.getTemplate(id);
      expect(record!.created_at).toBe(canonical);
      expect(record!.updated_at).toBe(canonical);
      const [raw] = await poolA.query<any[]>(
        'SELECT created_at, updated_at FROM metric_templates_v2 WHERE template_id = ?', [id],
      );
      expect(raw[0]).toMatchObject({ created_at: canonical, updated_at: canonical });
    }

    // Published timestamps use the same canonical representation.
    await repositoryA.create(
      template('tpl-y-pub', { created_at: '0000-01-01T00:00:00.000Z', updated_at: '0000-01-01T00:00:00.000Z' }),
      draft('tpl-y-pub'),
    );
    await repositoryA.putItemVersion(itemInput({ template_id: 'tpl-y-pub' }));
    await repositoryA.publish(command({
      templateId: 'tpl-y-pub', publishedAt: '0000-01-01T00:00:00.5Z', draftUpdatedAt: '0000-01-01T00:00:00.5Z',
      sourceChain: {
        ...chain(), created_at: '0000-01-01T00:00:00.000Z', published_at: '0000-01-01T00:00:00.5Z',
      },
      aggregate: aggregate('tpl-y-pub'), items: [item('tpl-y-pub')],
    }));
    expect((await repositoryA.getVersion('tpl-y-pub', 1))!.published_at).toBe('0000-01-01T00:00:00.500Z');

    // Closing and reopening a connection keeps the exact instants.
    const inner = newPool();
    try {
      const fresh = new MySqlTemplateRepository(inner);
      expect((await fresh.getTemplate('tpl-y999'))!.created_at).toBe('0999-12-31T23:59:59.000Z');
      expect((await fresh.getVersion('tpl-y-pub', 1))!.published_at).toBe('0000-01-01T00:00:00.500Z');
    } finally {
      await inner.end();
    }

    await expect(repositoryA.create(
      template('tpl-bad-date', { created_at: '2026-13-01T00:00:00.000Z', updated_at: AT }),
      draft('tpl-bad-date'),
    )).rejects.toThrow();
    expect(await repositoryA.getTemplate('tpl-bad-date')).toBeNull();
  });

  it('still refuses version and revision increments at the INT ceiling', async () => {
    await poolA.query(
      `INSERT INTO metric_templates_v2
        (template_id, name, status, current_published_version, revision, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['tpl-max', 'Max', 'draft', null, 2147483647, 1, AT, AT],
    );
    await expect(repositoryA.updateTemplate('tpl-max', 2147483647, { name: 'X', updated_at: AT }))
      .rejects.toMatchObject({ code: 'TEMPLATE_INVALID_INPUT' });
    expect((await repositoryA.getTemplate('tpl-max'))!.revision).toBe(2147483647);

    await repositoryA.create(template('tpl-item-max'), draft('tpl-item-max'));
    await poolA.query(
      'INSERT INTO metric_template_items (template_id, item_id, status, created_at) VALUES (?, ?, ?, ?)',
      ['tpl-item-max', 'uptime', 'active', AT],
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
