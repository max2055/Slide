/**
 * MAX-237 / T2A — internal MySQL adapter for the template repository port.
 *
 * Unmounted: no route, process registration, shared pool, migration or consumer
 * imports this file. The only way it reaches a database is the `mysql2` pool a
 * caller passes to the constructor; this module never creates, connects or
 * closes a pool itself and never reads an application `.env`.
 *
 * Storage shape is the accepted MAX-236 D1 candidate DDL 140
 * (`docs/slide/development/MAX-237/t2a/sql/140_metric_template_aggregate.sql`,
 * byte-identical copy of
 * `b5377142497282afa364a53b7aeab38088d095fb:docs/slide/development/MAX-236/real-a/sql/140_metric_template_aggregate.sql`).
 * Five fixed tables, no sixth shadow table, no column or DDL change here:
 *
 * | port value            | column(s)                                                        |
 * |-----------------------|------------------------------------------------------------------|
 * | TemplateRecord        | `metric_templates_v2` same-named columns; SQL NULL stays NULL    |
 * | TemplateDraft         | `metric_template_drafts` same-named columns; revision 0 start    |
 * | TemplateItemVersion   | `metric_template_item_versions`; `canonical_metric.id`/`semantic_version` split into `canonical_metric_id`/`canonical_semantic_version` |
 * | item identity         | `metric_template_items`; `status='active'` and `created_at` set only on the first item input |
 * | TemplateVersion       | `metric_template_versions`; JSON snapshots stored as given        |
 *
 * Guarantees, in the order the port documents them:
 *
 * - Every write transaction locks the template parent row first, then the draft
 *   and finally item rows in ASCII `item_id` order. The parent lock is what
 *   serialises different connections/processes; no in-process lock exists here
 *   and none is used as a substitute.
 * - `create`/`updateTemplate`/`updateDraft`/`putItemVersion`/`publish` run in one
 *   transaction on ONE connection; reads never write through another pooled
 *   connection.
 * - Revision and version CAS checks happen before the first write; deadlocks and
 *   disconnects are never retried automatically.
 * - A commit whose acknowledgement is lost is reported as
 *   {@link TemplateStorageUnknownCommitError} (adapter-local, no public error
 *   code change) with a redacted operation identity for a read-only re-check.
 * - SQL-bound values are checked for representability **before any write**
 *   ({@link toSqlDateTime}, {@link sqlInt}, {@link sqlCanonicalId},
 *   {@link sqlSemanticVersion}, {@link sqlNextVersion}, {@link sqlNextRevision}).
 *   These are internal storage boundaries of this candidate DDL, reported as
 *   `TEMPLATE_INVALID_INPUT` with an explicit "internal storage boundary" note —
 *   never as a claim that the public schema rejects the value.
 *
 * Known limits carried into T2B (see `docs/slide/development/MAX-237/t2a/README.md`):
 * `created_by`/`updated_by` are INT, canonical ids VARCHAR(128), semantic
 * versions VARCHAR(16) and DATETIME years 1000..9999 — all narrower than the
 * accepted schemas.
 */
import { TemplateError } from './errors.js';
import {
  TemplateDraftSchema, TemplateItemVersionSchema, TemplateRecordSchema, TemplateVersionSchema,
  type HashId, type Revision, type TemplateDraft, type TemplateItemVersion, type TemplateRecord,
  type TemplateStatus, type TemplateVersion, type TemplateVersionSummary, type VersionNumber,
} from './model.js';
import {
  identityConflict, itemContent,
  type DraftUpdate, type ItemVersionInput, type ItemVersionResult, type PublishCommand, type PublishOutcome,
  type TemplateListPage, type TemplateListQuery, type TemplatePatch, type TemplateRepository, type TemplateSummary,
} from './repository.js';

/**
 * The narrow slice of a `mysql2/promise` pool/connection this adapter uses.
 * Both the real `Pool`/`PoolConnection` and the fault-injecting wrappers in the
 * MySQL test satisfy it; nothing here opens or configures a connection.
 */
export interface TemplateSqlConnection {
  execute(sql: string, values?: any[]): Promise<[unknown, unknown]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

export interface TemplateSqlPool {
  getConnection(): Promise<TemplateSqlConnection>;
}

/** A commit whose result the adapter could not observe. Never a claim of failure or success. */
export class TemplateStorageUnknownCommitError extends Error {
  readonly code = 'TEMPLATE_STORAGE_UNKNOWN_COMMIT';
  readonly operation: string;
  /** Redacted identifiers only: no values, secrets or payloads. */
  readonly identity: Readonly<Record<string, string | number | null>>;

  constructor(
    operation: string,
    identity: Record<string, string | number | null>,
    cause: unknown,
  ) {
    super(`commit outcome unknown for ${operation} ${JSON.stringify(identity)}; re-read by identity before retrying`, { cause });
    this.name = 'TemplateStorageUnknownCommitError';
    this.operation = operation;
    this.identity = Object.freeze({ ...identity });
  }
}

const MAX_SQL_INT = 2147483647;
const CANONICAL_ID_MAX = 128;
const SEMANTIC_VERSION_MAX = 16;

const storageBoundary = (detail: string): never => {
  throw new TemplateError(
    'TEMPLATE_INVALID_INPUT',
    `${detail}; this is the internal T2A storage boundary of the candidate DDL, not a public contract violation`,
  );
};

/** `INT` columns hold 0..2147483647 or NULL; anything else is refused, never truncated. */
export const sqlInt = (name: string, value: number | null): number | null => {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 0 || value > MAX_SQL_INT) {
    return storageBoundary(`${name}=${String(value)} does not fit the INT column (0..${MAX_SQL_INT})`);
  }
  return value;
};

/** Revision CAS increments are refused at the ceiling instead of overflowing. */
export const sqlNextRevision = (name: string, current: number): number => {
  if (!Number.isInteger(current) || current < 0 || current >= MAX_SQL_INT) {
    return storageBoundary(`${name}=${String(current)} cannot be incremented within INT`);
  }
  return current + 1;
};

/** Item/published version numbers are 1..2147483647; the next one is checked before it is written. */
export const sqlNextVersion = (name: string, current: number): number => {
  if (!Number.isInteger(current) || current < 0 || current >= MAX_SQL_INT) {
    return storageBoundary(`${name}=${String(current)} cannot be incremented within INT`);
  }
  return current + 1;
};

export const sqlCanonicalId = (name: string, value: string): string => {
  if (value.length > CANONICAL_ID_MAX) {
    return storageBoundary(`${name}=${JSON.stringify(value)} is ${value.length} characters; canonical_metric_id is VARCHAR(${CANONICAL_ID_MAX})`);
  }
  return value;
};

export const sqlSemanticVersion = (name: string, value: string): string => {
  if (value.length > SEMANTIC_VERSION_MAX) {
    return storageBoundary(`${name}=${JSON.stringify(value)} is ${value.length} characters; canonical_semantic_version is VARCHAR(${SEMANTIC_VERSION_MAX})`);
  }
  return value;
};

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/**
 * ISO-8601 UTC instant → MySQL `DATETIME(3)` literal `YYYY-MM-DD HH:MM:SS.mmm`.
 * The value is written as the same UTC wall clock, so it round-trips as the same
 * instant; `.1Z` becomes `.100` (allowed) and 3-digit fractions are preserved.
 * Years outside the `DATETIME` range are rejected instead of being clipped.
 */
export const toSqlDateTime = (name: string, iso: string): string => {
  const instant = Date.parse(iso);
  if (!Number.isFinite(instant)) {
    throw new TemplateError('TEMPLATE_INVALID_INPUT', `${name}=${JSON.stringify(iso)} is not a valid instant`);
  }
  const date = new Date(instant);
  const year = date.getUTCFullYear();
  if (year < 1000 || year > 9999) {
    return storageBoundary(`${name}=${JSON.stringify(iso)} is outside the DATETIME year range 1000..9999`);
  }
  return `${pad(year, 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`;
};

/**
 * `DATE_FORMAT(col, '%Y-%m-%dT%H:%i:%s.%fZ')` → the contract's
 * `YYYY-MM-DDTHH:mm:ss.SSSZ`. `DATETIME(3)` always has six microsecond digits
 * from `%f`, of which only the first three can be non-zero.
 */
export const fromSqlDateTime = (value: unknown): string => {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/.exec(text);
  if (!match) {
    throw new TemplateError('TEMPLATE_INVALID_INPUT', `unexpected DATETIME(3) rendering ${JSON.stringify(text)}`);
  }
  return `${match[1]}.${match[2]!.slice(0, 3)}Z`;
};

type Row = Record<string, unknown>;

const rowsOf = (rows: unknown): Row[] => (Array.isArray(rows) ? rows as Row[] : []);

/** `execute` resolves to `[rows, fields]`; this returns the row array, never the tuple. */
const resultRows = (result: unknown): Row[] => {
  if (!Array.isArray(result) || result.length === 0) return [];
  return rowsOf(result[0]);
};

const firstRow = (result: unknown): Row | null => resultRows(result)[0] ?? null;

const affectedRows = (result: unknown): number => {
  if (typeof result !== 'object' || result === null) return 0;
  const value = (result as { affectedRows?: unknown }).affectedRows;
  return typeof value === 'number' ? value : Number(value ?? 0);
};

const isDuplicateKey = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ER_DUP_ENTRY';

const intOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/** mysql2 parses JSON columns; string handling keeps a text rendering equivalent. */
const jsonColumn = (value: unknown): unknown => (typeof value === 'string' ? JSON.parse(value) as unknown : value);

const itemValues = (item: TemplateItemVersion): unknown[] => [
  item.template_id,
  item.item_id,
  item.version,
  item.display_name,
  item.canonical_metric.id,
  item.canonical_metric.semantic_version,
  item.unit,
  JSON.stringify(item.dimensions),
  JSON.stringify(item.collector_ref),
  JSON.stringify(item.params_default),
  JSON.stringify(item.source_chain),
];

/** Explicit UTC/wall-clock rendering; never relies on the pool's `dateStrings`/`timezone` config. */
const DATE = (column: string): string => `DATE_FORMAT(${column}, '%Y-%m-%dT%H:%i:%s.%fZ') AS ${column}`;

const TEMPLATE_SELECT = `template_id, name, status, current_published_version, revision, created_by,
  ${DATE('created_at')}, ${DATE('updated_at')}`;
const DRAFT_SELECT = `template_id, revision, aggregate, published_version, updated_by, ${DATE('updated_at')}`;
const ITEM_FIELDS = [
  'template_id', 'item_id', 'version', 'display_name', 'canonical_metric_id', 'canonical_semantic_version',
  'unit', 'dimensions', 'collector_ref', 'params_default', 'source_chain',
];
const itemSelect = (prefix = ''): string => ITEM_FIELDS.map(field => `${prefix}${field}`).join(', ');
const VERSION_SELECT = `template_id, version, status, content_hash, aggregate, items,
  package_composition, source_chain, ${DATE('published_at')}, ${DATE('retired_at')}`;

/** `SET` statement applied to every freshly acquired connection (once per object). */
const SESSION_SQL = "SET SESSION time_zone = '+00:00', SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'";

const asciiCompare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

export class MySqlTemplateRepository implements TemplateRepository {
  private readonly prepared = new WeakSet<object>();

  /** The pool is injected by the caller; this adapter never creates or ends one. */
  constructor(private readonly pool: TemplateSqlPool) {}

  // ------------------------------------------------------------ plumbing

  private release(connection: TemplateSqlConnection): void {
    try {
      connection.release();
    } catch {
      // A failed release must not replace the operation's own outcome.
    }
  }

  private async prepare(connection: TemplateSqlConnection): Promise<void> {
    if (this.prepared.has(connection as unknown as object)) return;
    await connection.execute(SESSION_SQL);
    this.prepared.add(connection as unknown as object);
  }

  private async withConnection<T>(run: (connection: TemplateSqlConnection) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      await this.prepare(connection);
      return await run(connection);
    } finally {
      this.release(connection);
    }
  }

  private async transaction<T>(
    operation: string,
    identity: Record<string, string | number | null>,
    run: (connection: TemplateSqlConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      await this.prepare(connection);
      await connection.beginTransaction();
      let result: T;
      try {
        result = await run(connection);
      } catch (error) {
        try {
          await connection.rollback();
        } catch {
          // If rollback itself cannot be observed, keep the original outcome; a
          // closed connection rolls back server-side.
        }
        throw error;
      }
      try {
        await connection.commit();
      } catch (cause) {
        throw new TemplateStorageUnknownCommitError(operation, identity, cause);
      }
      return result;
    } finally {
      this.release(connection);
    }
  }

  // ------------------------------------------------------- row mapping

  private templateFromRow(row: Row): TemplateRecord {
    return TemplateRecordSchema.parse({
      template_id: row.template_id,
      name: row.name,
      status: row.status,
      current_published_version: intOrNull(row.current_published_version),
      revision: Number(row.revision),
      created_by: intOrNull(row.created_by),
      created_at: fromSqlDateTime(row.created_at),
      updated_at: fromSqlDateTime(row.updated_at),
    });
  }

  private draftFromRow(row: Row): TemplateDraft {
    return TemplateDraftSchema.parse({
      template_id: row.template_id,
      revision: Number(row.revision),
      aggregate: jsonColumn(row.aggregate),
      published_version: intOrNull(row.published_version),
      updated_by: intOrNull(row.updated_by),
      updated_at: fromSqlDateTime(row.updated_at),
    });
  }

  private itemFromRow(row: Row): TemplateItemVersion {
    return TemplateItemVersionSchema.parse({
      template_id: row.template_id,
      item_id: row.item_id,
      version: Number(row.version),
      display_name: row.display_name,
      canonical_metric: {
        id: row.canonical_metric_id,
        semantic_version: row.canonical_semantic_version,
      },
      unit: row.unit,
      dimensions: jsonColumn(row.dimensions),
      collector_ref: jsonColumn(row.collector_ref),
      params_default: jsonColumn(row.params_default),
      source_chain: jsonColumn(row.source_chain),
    });
  }

  private versionFromRow(row: Row): TemplateVersion {
    return TemplateVersionSchema.parse({
      template_id: row.template_id,
      version: Number(row.version),
      status: row.status,
      content_hash: row.content_hash,
      aggregate: jsonColumn(row.aggregate),
      items: jsonColumn(row.items),
      package_composition: jsonColumn(row.package_composition),
      source_chain: jsonColumn(row.source_chain),
      published_at: fromSqlDateTime(row.published_at),
      retired_at: row.retired_at === null || row.retired_at === undefined ? null : fromSqlDateTime(row.retired_at),
    });
  }

  private summaryFromRow(row: Row): TemplateSummary {
    return {
      template_id: String(row.template_id),
      name: String(row.name),
      status: row.status as TemplateStatus,
      current_published_version: intOrNull(row.current_published_version),
      revision: Number(row.revision),
    };
  }

  // -------------------------------------------------------------- writes

  async create(template: TemplateRecord, draft: TemplateDraft, items: ItemVersionInput[] = []): Promise<TemplateItemVersion[]> {
    const record = TemplateRecordSchema.parse(template);
    const next = TemplateDraftSchema.parse(draft);
    if (next.template_id !== record.template_id || next.revision !== 0 || record.revision !== 0) {
      throw new TemplateError('TEMPLATE_EXISTS', 'a new template starts at revision 0 with its own draft');
    }
    const copies = new Map<string, TemplateItemVersion>();
    for (const input of items) {
      if (input.template_id !== record.template_id) {
        throw new TemplateError('TEMPLATE_ITEM_NOT_FOUND', 'copied item versions must belong to the new template');
      }
      if (copies.has(input.item_id)) {
        throw new TemplateError('TEMPLATE_ITEM_DUPLICATE', `item ${input.item_id} appears twice in one copy`);
      }
      copies.set(input.item_id, TemplateItemVersionSchema.parse({ ...input, version: 1 }));
    }
    // Every SQL-bound value is checked before the first INSERT, so a storage
    // boundary never leaves a parent or draft row behind through a partial write.
    const createdAt = toSqlDateTime('template.created_at', record.created_at);
    const updatedAt = toSqlDateTime('template.updated_at', record.updated_at);
    const draftUpdatedAt = toSqlDateTime('draft.updated_at', next.updated_at);
    const createdBy = sqlInt('template.created_by', record.created_by);
    const currentPublishedVersion = sqlInt('template.current_published_version', record.current_published_version);
    const draftUpdatedBy = sqlInt('draft.updated_by', next.updated_by);
    const draftPublishedVersion = sqlInt('draft.published_version', next.published_version);
    const ordered = [...copies.values()].sort((a, b) => asciiCompare(a.item_id, b.item_id));
    const itemCreatedAt = new Map<string, string>();
    for (const item of ordered) {
      sqlCanonicalId(`item ${item.item_id} canonical_metric.id`, item.canonical_metric.id);
      sqlSemanticVersion(`item ${item.item_id} canonical_metric.semantic_version`, item.canonical_metric.semantic_version);
      itemCreatedAt.set(item.item_id, toSqlDateTime(`item ${item.item_id} source_chain.created_at`, item.source_chain.created_at));
    }

    await this.transaction('create', { template_id: record.template_id }, async connection => {
      try {
        await connection.execute(
          `INSERT INTO metric_templates_v2
            (template_id, name, status, current_published_version, revision, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [record.template_id, record.name, record.status, currentPublishedVersion, record.revision, createdBy, createdAt, updatedAt],
        );
      } catch (error) {
        if (isDuplicateKey(error)) {
          throw new TemplateError('TEMPLATE_EXISTS', `template ${record.template_id} already exists`);
        }
        throw error;
      }
      await connection.execute(
        `INSERT INTO metric_template_drafts
          (template_id, revision, aggregate, published_version, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [next.template_id, next.revision, JSON.stringify(next.aggregate), draftPublishedVersion, draftUpdatedBy, draftUpdatedAt],
      );
      for (const item of ordered) {
        try {
          await connection.execute(
            'INSERT INTO metric_template_items (template_id, item_id, status, created_at) VALUES (?, ?, ?, ?)',
            [item.template_id, item.item_id, 'active', itemCreatedAt.get(item.item_id)!],
          );
        } catch (error) {
          if (isDuplicateKey(error)) {
            throw new TemplateError('TEMPLATE_ITEM_DUPLICATE', `item ${item.item_id} already exists in template ${item.template_id}`);
          }
          throw error;
        }
        await connection.execute(
          `INSERT INTO metric_template_item_versions
            (template_id, item_id, version, display_name, canonical_metric_id, canonical_semantic_version,
             unit, dimensions, collector_ref, params_default, source_chain)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          itemValues(item),
        );
      }
    });
    return ordered;
  }

  async updateTemplate(templateId: string, expectedRevision: Revision, patch: TemplatePatch): Promise<TemplateRecord> {
    toSqlDateTime('patch.updated_at', patch.updated_at);
    return this.transaction('updateTemplate', { template_id: templateId, expected_revision: expectedRevision }, async connection => {
      const row = firstRow(await connection.execute(
        `SELECT ${TEMPLATE_SELECT} FROM metric_templates_v2 WHERE template_id = ? FOR UPDATE`,
        [templateId],
      ));
      if (!row) throw new TemplateError('TEMPLATE_NOT_FOUND', `template ${templateId} does not exist`);
      const current = this.templateFromRow(row);
      if (current.revision !== expectedRevision) {
        throw new TemplateError('TEMPLATE_REVISION_CONFLICT',
          `template ${templateId} is at revision ${current.revision}, expected ${expectedRevision}`);
      }
      const revision = sqlNextRevision(`template ${templateId} revision`, current.revision);
      const next = TemplateRecordSchema.parse({
        ...current,
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.current_published_version === undefined
          ? {} : { current_published_version: patch.current_published_version }),
        revision,
        updated_at: patch.updated_at,
      });
      const currentPublishedVersion = sqlInt('template.current_published_version', next.current_published_version);
      const updatedAt = toSqlDateTime('template.updated_at', next.updated_at);
      const [result] = await connection.execute(
        `UPDATE metric_templates_v2
            SET name = ?, status = ?, current_published_version = ?, revision = ?, updated_at = ?
          WHERE template_id = ? AND revision = ?`,
        [next.name, next.status, currentPublishedVersion, next.revision, updatedAt, templateId, expectedRevision],
      );
      if (affectedRows(result) !== 1) {
        throw new TemplateError('TEMPLATE_REVISION_CONFLICT',
          `template ${templateId} moved away from revision ${expectedRevision} during the update`);
      }
      return next;
    });
  }

  async updateDraft(templateId: string, expectedRevision: Revision, next: DraftUpdate): Promise<TemplateDraft> {
    toSqlDateTime('draft.updated_at', next.updated_at);
    sqlInt('draft.updated_by', next.updated_by);
    return this.transaction('updateDraft', { template_id: templateId, expected_revision: expectedRevision }, async connection => {
      // Lock order: template parent row first, then the draft row.
      const parent = firstRow(await connection.execute(
        'SELECT template_id FROM metric_templates_v2 WHERE template_id = ? FOR UPDATE',
        [templateId],
      ));
      if (!parent) throw new TemplateError('TEMPLATE_NOT_FOUND', `template ${templateId} does not exist`);
      const row = firstRow(await connection.execute(
        `SELECT ${DRAFT_SELECT} FROM metric_template_drafts WHERE template_id = ? FOR UPDATE`,
        [templateId],
      ));
      if (!row) throw new TemplateError('TEMPLATE_NOT_FOUND', `draft for template ${templateId} does not exist`);
      const current = this.draftFromRow(row);
      if (current.revision !== expectedRevision) {
        throw new TemplateError('TEMPLATE_DRAFT_CONFLICT',
          `draft ${templateId} is at revision ${current.revision}, expected ${expectedRevision}`);
      }
      const revision = sqlNextRevision(`draft ${templateId} revision`, current.revision);
      const updated = TemplateDraftSchema.parse({
        ...current,
        revision,
        aggregate: next.aggregate,
        updated_by: next.updated_by,
        updated_at: next.updated_at,
      });
      const updatedAt = toSqlDateTime('draft.updated_at', updated.updated_at);
      const updatedBy = sqlInt('draft.updated_by', updated.updated_by);
      const [result] = await connection.execute(
        `UPDATE metric_template_drafts
            SET revision = ?, aggregate = ?, updated_by = ?, updated_at = ?
          WHERE template_id = ? AND revision = ?`,
        [updated.revision, JSON.stringify(updated.aggregate), updatedBy, updatedAt, templateId, expectedRevision],
      );
      if (affectedRows(result) !== 1) {
        throw new TemplateError('TEMPLATE_DRAFT_CONFLICT',
          `draft ${templateId} moved away from revision ${expectedRevision} during the update`);
      }
      return updated;
    });
  }

  async putItemVersion(input: ItemVersionInput): Promise<ItemVersionResult> {
    // Content shape and SQL-bound item columns are checked before locking/writing.
    TemplateItemVersionSchema.parse({ ...input, version: 1 });
    sqlCanonicalId(`item ${input.item_id} canonical_metric.id`, input.canonical_metric.id);
    sqlSemanticVersion(`item ${input.item_id} canonical_metric.semantic_version`, input.canonical_metric.semantic_version);
    toSqlDateTime(`item ${input.item_id} source_chain.created_at`, input.source_chain.created_at);

    return this.transaction('putItemVersion', { template_id: input.template_id, item_id: input.item_id }, async connection => {
      // The existing template row is the lock that serialises first-item races;
      // a not-yet-existing item row can never play that role.
      const parent = firstRow(await connection.execute(
        'SELECT template_id FROM metric_templates_v2 WHERE template_id = ? FOR UPDATE',
        [input.template_id],
      ));
      if (!parent) throw new TemplateError('TEMPLATE_NOT_FOUND', `template ${input.template_id} does not exist`);
      const latestRow = firstRow(await connection.execute(
        `SELECT ${itemSelect()} FROM metric_template_item_versions
          WHERE template_id = ? AND item_id = ? ORDER BY version DESC LIMIT 1 FOR UPDATE`,
        [input.template_id, input.item_id],
      ));
      const latest = latestRow ? this.itemFromRow(latestRow) : null;
      if (latest) {
        const conflict = identityConflict(latest, input);
        if (conflict) {
          throw new TemplateError('TEMPLATE_ITEM_IDENTITY_INCOMPATIBLE',
            `item ${input.item_id} is v${latest.version} with ${conflict}; a stable item identity cannot switch to incompatible semantics, use a new item_id`);
        }
        if (itemContent(latest) === itemContent(input)) {
          return { item: latest, reused: true };
        }
      }
      const version = sqlNextVersion(`item ${input.item_id} version`, latest?.version ?? 0);
      const item = TemplateItemVersionSchema.parse({ ...input, version });
      if (!latest) {
        // First identity row only: status and created_at are never rewritten by
        // later appends or reuses.
        try {
          await connection.execute(
            'INSERT INTO metric_template_items (template_id, item_id, status, created_at) VALUES (?, ?, ?, ?)',
            [input.template_id, input.item_id, 'active',
              toSqlDateTime(`item ${input.item_id} source_chain.created_at`, input.source_chain.created_at)],
          );
        } catch (error) {
          if (isDuplicateKey(error)) {
            throw new TemplateError('TEMPLATE_ITEM_DUPLICATE',
              `item ${input.item_id} already exists in template ${input.template_id}`);
          }
          throw error;
        }
      }
      await connection.execute(
        `INSERT INTO metric_template_item_versions
          (template_id, item_id, version, display_name, canonical_metric_id, canonical_semantic_version,
           unit, dimensions, collector_ref, params_default, source_chain)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        itemValues(item),
      );
      return { item, reused: false };
    });
  }

  async publish(command: PublishCommand): Promise<PublishOutcome> {
    // The snapshot is validated once, with the version number supplied later by
    // the transaction (shape checks are version-independent).
    const snapshot = TemplateVersionSchema.parse({
      template_id: command.templateId,
      version: 1,
      status: 'published',
      content_hash: command.contentHash,
      aggregate: command.aggregate,
      items: command.items,
      package_composition: command.packageComposition,
      source_chain: command.sourceChain,
      published_at: command.publishedAt,
      retired_at: null,
    });
    const publishedAt = toSqlDateTime('publish.published_at', command.publishedAt);
    const draftUpdatedAt = toSqlDateTime('publish.draft_updated_at', command.draftUpdatedAt);
    const actorId = sqlInt('publish.actor_id', command.actorId);

    return this.transaction('publish', {
      template_id: command.templateId,
      content_hash: command.contentHash,
      expected_revision: command.expectedTemplateRevision,
    }, async connection => {
      const templateRow = firstRow(await connection.execute(
        `SELECT ${TEMPLATE_SELECT} FROM metric_templates_v2 WHERE template_id = ? FOR UPDATE`,
        [command.templateId],
      ));
      if (!templateRow) throw new TemplateError('TEMPLATE_NOT_FOUND', `template ${command.templateId} does not exist`);
      const template = this.templateFromRow(templateRow);
      const draftRow = firstRow(await connection.execute(
        `SELECT ${DRAFT_SELECT} FROM metric_template_drafts WHERE template_id = ? FOR UPDATE`,
        [command.templateId],
      ));
      if (!draftRow) throw new TemplateError('TEMPLATE_NOT_FOUND', `draft for template ${command.templateId} does not exist`);
      const draft = this.draftFromRow(draftRow);
      // Both CAS revisions are checked before the idempotency lookup: a fresh
      // hash must never bypass a stale revision.
      if (template.revision !== command.expectedTemplateRevision) {
        throw new TemplateError('TEMPLATE_REVISION_CONFLICT',
          `template ${command.templateId} is at revision ${template.revision}, expected ${command.expectedTemplateRevision}`);
      }
      if (draft.revision !== command.expectedDraftRevision) {
        throw new TemplateError('TEMPLATE_DRAFT_CONFLICT',
          `draft ${command.templateId} is at revision ${draft.revision}, expected ${command.expectedDraftRevision}`);
      }
      const existing = firstRow(await connection.execute(
        `SELECT ${VERSION_SELECT} FROM metric_template_versions WHERE template_id = ? AND content_hash = ?`,
        [command.templateId, command.contentHash],
      ));
      if (existing) {
        const version = this.versionFromRow(existing);
        return {
          noop: true, version: version.version, content_hash: version.content_hash, revision: template.revision,
        };
      }
      const maxRow = firstRow(await connection.execute(
        'SELECT COALESCE(MAX(version), 0) AS max_version FROM metric_template_versions WHERE template_id = ?',
        [command.templateId],
      ));
      const versionNumber = sqlNextVersion(`template ${command.templateId} version`, Number(maxRow?.max_version ?? 0));
      const templateRevision = sqlNextRevision(`template ${command.templateId} revision`, template.revision);
      const draftRevision = sqlNextRevision(`draft ${command.templateId} revision`, draft.revision);
      const record = TemplateVersionSchema.parse({ ...snapshot, version: versionNumber });
      try {
        await connection.execute(
          `INSERT INTO metric_template_versions
            (template_id, version, status, content_hash, aggregate, items, package_composition, source_chain,
             published_at, retired_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            record.template_id, record.version, record.status, record.content_hash,
            JSON.stringify(record.aggregate), JSON.stringify(record.items),
            JSON.stringify(record.package_composition), JSON.stringify(record.source_chain),
            publishedAt, null,
          ],
        );
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        // Another writer inserted this exact hash despite the parent-row lock
        // (it would have had to ignore the lock order). The content is already
        // stored, so return the idempotent outcome instead of appending again.
        const raced = firstRow(await connection.execute(
          `SELECT ${VERSION_SELECT} FROM metric_template_versions WHERE template_id = ? AND content_hash = ?`,
          [command.templateId, command.contentHash],
        ));
        if (raced) {
          const version = this.versionFromRow(raced);
          return { noop: true, version: version.version, content_hash: version.content_hash, revision: template.revision };
        }
        throw error;
      }
      const [templateUpdate] = await connection.execute(
        `UPDATE metric_templates_v2
            SET current_published_version = ?, revision = ?, updated_at = ?
          WHERE template_id = ? AND revision = ?`,
        [versionNumber, templateRevision, publishedAt, command.templateId, command.expectedTemplateRevision],
      );
      if (affectedRows(templateUpdate) !== 1) {
        throw new TemplateError('TEMPLATE_REVISION_CONFLICT',
          `template ${command.templateId} moved away from revision ${command.expectedTemplateRevision} during publish`);
      }
      const [draftUpdate] = await connection.execute(
        `UPDATE metric_template_drafts
            SET revision = ?, published_version = ?, updated_by = ?, updated_at = ?
          WHERE template_id = ? AND revision = ?`,
        [draftRevision, versionNumber, actorId, draftUpdatedAt, command.templateId, command.expectedDraftRevision],
      );
      if (affectedRows(draftUpdate) !== 1) {
        throw new TemplateError('TEMPLATE_DRAFT_CONFLICT',
          `draft ${command.templateId} moved away from revision ${command.expectedDraftRevision} during publish`);
      }
      return { noop: false, version: versionNumber, content_hash: command.contentHash, revision: templateRevision };
    });
  }

  // --------------------------------------------------------------- reads

  async getTemplate(templateId: string): Promise<TemplateRecord | null> {
    return this.withConnection(async connection => {
      const row = firstRow(await connection.execute(
        `SELECT ${TEMPLATE_SELECT} FROM metric_templates_v2 WHERE template_id = ?`,
        [templateId],
      ));
      return row ? this.templateFromRow(row) : null;
    });
  }

  async listTemplates(query: TemplateListQuery): Promise<TemplateListPage> {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (query.status !== undefined) {
      conditions.push('status = ?');
      values.push(query.status);
    }
    if (query.cursor !== undefined) {
      conditions.push('template_id > ?');
      values.push(query.cursor);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.withConnection(async connection => {
      const [result] = await connection.execute(
        `SELECT template_id, name, status, current_published_version, revision
           FROM metric_templates_v2 ${where}
          ORDER BY template_id ASC LIMIT ${limit + 1}`,
        values,
      );
      const rows = rowsOf(result);
      const page = rows.slice(0, limit).map(row => this.summaryFromRow(row));
      return {
        items: page,
        next_cursor: rows.length > limit ? page[page.length - 1]!.template_id : null,
      };
    });
  }

  async getDraft(templateId: string): Promise<TemplateDraft | null> {
    return this.withConnection(async connection => {
      const row = firstRow(await connection.execute(
        `SELECT ${DRAFT_SELECT} FROM metric_template_drafts WHERE template_id = ?`,
        [templateId],
      ));
      return row ? this.draftFromRow(row) : null;
    });
  }

  async getItemVersion(templateId: string, itemId: string, version: VersionNumber): Promise<TemplateItemVersion | null> {
    return this.withConnection(async connection => {
      const row = firstRow(await connection.execute(
        `SELECT ${itemSelect()} FROM metric_template_item_versions
          WHERE template_id = ? AND item_id = ? AND version = ?`,
        [templateId, itemId, version],
      ));
      return row ? this.itemFromRow(row) : null;
    });
  }

  async latestItemVersions(templateId: string): Promise<TemplateItemVersion[]> {
    return this.withConnection(async connection => {
      const [result] = await connection.execute(
        `SELECT ${itemSelect('current.')}
           FROM metric_template_item_versions current
           JOIN (
             SELECT item_id, MAX(version) AS version
               FROM metric_template_item_versions
              WHERE template_id = ?
              GROUP BY item_id
           ) latest ON latest.item_id = current.item_id AND latest.version = current.version
          WHERE current.template_id = ?
          ORDER BY current.item_id ASC`,
        [templateId, templateId],
      );
      return rowsOf(result).map(row => this.itemFromRow(row));
    });
  }

  async getVersion(templateId: string, version: VersionNumber): Promise<TemplateVersion | null> {
    return this.withConnection(async connection => {
      const row = firstRow(await connection.execute(
        `SELECT ${VERSION_SELECT} FROM metric_template_versions WHERE template_id = ? AND version = ?`,
        [templateId, version],
      ));
      return row ? this.versionFromRow(row) : null;
    });
  }

  async listVersions(templateId: string): Promise<TemplateVersionSummary[]> {
    return this.withConnection(async connection => {
      const [result] = await connection.execute(
        `SELECT version, content_hash, status FROM metric_template_versions
          WHERE template_id = ? ORDER BY version ASC`,
        [templateId],
      );
      return rowsOf(result).map(row => ({
        version: Number(row.version),
        content_hash: String(row.content_hash) as HashId,
        status: row.status as TemplateVersionSummary['status'],
      }));
    });
  }

  async findVersionByContentHash(templateId: string, contentHash: HashId): Promise<TemplateVersion | null> {
    return this.withConnection(async connection => {
      const row = firstRow(await connection.execute(
        `SELECT ${VERSION_SELECT} FROM metric_template_versions WHERE template_id = ? AND content_hash = ?`,
        [templateId, contentHash],
      ));
      return row ? this.versionFromRow(row) : null;
    });
  }
}
