/**
 * MAX-237 / T2B — focused adapter checks that need no database.
 *
 * Everything transactional (CAS, first-item races, rollback, commit-loss) is
 * exercised against real MySQL in `mysql-repository.mysql.test.ts`; these tests
 * prove the pure storage-boundary and timestamp rules plus the error branches a
 * fake connection can reach deterministically.
 */
import { describe, expect, it } from 'vitest';
import { TemplateError } from './errors.js';
import { emptyDraftAggregate, TemplateItemVersionSchema, type TemplateDraft, type TemplateRecord } from './model.js';
import {
  MySqlTemplateRepository, TemplateStorageUnknownCommitError, fromSqlActorId, fromSqlTimestamp,
  sqlActorId, sqlInt, sqlNextRevision, sqlNextVersion, toSqlTimestamp,
  type TemplateSqlConnection, type TemplateSqlPool,
} from './mysql-repository.js';

const AT = '2026-10-27T00:00:00.000Z';

const template = (templateId = 'tpl-a'): TemplateRecord => ({
  template_id: templateId, name: 'Template A', status: 'draft', current_published_version: null,
  revision: 0, created_by: 1, created_at: AT, updated_at: AT,
});
const draft = (templateId = 'tpl-a'): TemplateDraft => ({
  template_id: templateId, revision: 0, aggregate: emptyDraftAggregate(templateId),
  published_version: null, updated_by: 1, updated_at: AT,
});

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TemplateError);
    return (error as TemplateError).code;
  }
  throw new Error('expected the call to fail');
}

class FakeConnection implements TemplateSqlConnection {
  readonly statements: string[] = [];
  commits = 0;
  rollbacks = 0;
  releases = 0;
  destroys = 0;
  failBegin: Error | null = null;
  failRollback: Error | null = null;

  constructor(
    private readonly beforeExecute: (sql: string) => void = () => {},
    private readonly beforeCommit: () => void = () => {},
    private readonly onRelease: () => void = () => {},
    private readonly onDestroy: () => void = () => {},
  ) {}

  async execute(sql: string): Promise<[unknown, unknown]> {
    this.statements.push(sql);
    this.beforeExecute(sql);
    return [{ affectedRows: 1 }, []];
  }

  async beginTransaction(): Promise<void> {
    if (this.failBegin) throw this.failBegin;
  }

  async commit(): Promise<void> {
    this.commits += 1;
    this.beforeCommit();
  }

  async rollback(): Promise<void> {
    this.rollbacks += 1;
    if (this.failRollback) throw this.failRollback;
  }

  release(): void {
    this.releases += 1;
    this.onRelease();
  }

  destroy(): void {
    this.destroys += 1;
    this.onDestroy();
  }
}

const poolOf = (connection: TemplateSqlConnection): TemplateSqlPool => ({
  getConnection: async () => connection,
});

describe('T2B SQL value boundaries', () => {
  it('accepts the full BIGINT UNSIGNED actor range and refuses unsafe integers', () => {
    expect(sqlActorId('actor', 0)).toBe(0);
    expect(sqlActorId('actor', 2147483648)).toBe(2147483648);
    expect(sqlActorId('actor', 9007199254740991)).toBe(9007199254740991);
    expect(sqlActorId('actor', null)).toBeNull();
    expect(codeOf(() => sqlActorId('actor', 9007199254740992))).toBe('TEMPLATE_INVALID_INPUT');
    expect(codeOf(() => sqlActorId('actor', -1))).toBe('TEMPLATE_INVALID_INPUT');
    expect(codeOf(() => sqlActorId('actor', 1.5))).toBe('TEMPLATE_INVALID_INPUT');
    expect(codeOf(() => sqlActorId('actor', Number.NaN))).toBe('TEMPLATE_INVALID_INPUT');
  });

  it('reads both driver forms and refuses values outside the safe range', () => {
    expect(fromSqlActorId('actor', null)).toBeNull();
    expect(fromSqlActorId('actor', 42)).toBe(42);
    expect(fromSqlActorId('actor', '9007199254740991')).toBe(9007199254740991);
    expect(fromSqlActorId('actor', 2147483648n)).toBe(2147483648);
    expect(codeOf(() => fromSqlActorId('actor', '9007199254740992'))).toBe('TEMPLATE_INVALID_INPUT');
    expect(codeOf(() => fromSqlActorId('actor', '12x'))).toBe('TEMPLATE_INVALID_INPUT');
    expect(codeOf(() => fromSqlActorId('actor', 1.5))).toBe('TEMPLATE_INVALID_INPUT');
  });

  it('keeps version/pointer INT boundaries unchanged', () => {
    expect(sqlInt('pointer', 0)).toBe(0);
    expect(sqlInt('pointer', 2147483647)).toBe(2147483647);
    expect(sqlInt('pointer', null)).toBeNull();
    expect(codeOf(() => sqlInt('pointer', 2147483648))).toBe('TEMPLATE_INVALID_INPUT');
    expect(sqlNextRevision('revision', 0)).toBe(1);
    expect(sqlNextRevision('revision', 2147483646)).toBe(2147483647);
    expect(codeOf(() => sqlNextRevision('revision', 2147483647))).toBe('TEMPLATE_INVALID_INPUT');
    expect(sqlNextVersion('version', 0)).toBe(1);
    expect(codeOf(() => sqlNextVersion('version', 2147483647))).toBe('TEMPLATE_INVALID_INPUT');
  });

  it('accepts full canonical identities and keeps the accepted ASCII rule', () => {
    const longId = `a.${'b'.repeat(510)}`;
    const longVersion = `${'1'.repeat(96)}.0.0`;
    expect(longId).toHaveLength(512);
    expect(longVersion).toHaveLength(100);
    const shape = (id: string, semanticVersion: string) => ({
      template_id: 'tpl-a', item_id: 'uptime', version: 1, display_name: 'Uptime',
      canonical_metric: { id, semantic_version: semanticVersion }, unit: 's', dimensions: {},
      collector_ref: { package_release: `mysql-basic@1.0.0#sha256:${'a'.repeat(64)}`, implementation_id: 'builtin:mysql.status.v1' },
      params_default: {}, source_chain: {
        actor_id: 1, request_id: 'req-1', base: null, created_at: AT, published_at: AT, retired_at: null, migration_ref: null,
      },
    });
    expect(TemplateItemVersionSchema.safeParse(shape(longId, longVersion)).success).toBe(true);
    expect(TemplateItemVersionSchema.safeParse(shape('db.uptime_seconds', '1.0.0')).success).toBe(true);
    expect(TemplateItemVersionSchema.safeParse(shape('db.主机', '1.0.0')).success).toBe(false);
    expect(TemplateItemVersionSchema.safeParse(shape('db.uptime_seconds', '1.0')).success).toBe(false);
  });

  it('names the internal storage boundary, not the public contract', () => {
    try {
      sqlActorId('actor', 9007199254740992);
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as TemplateError).message).toContain('internal T2B storage boundary');
      expect((error as TemplateError).code).toBe('TEMPLATE_INVALID_INPUT');
    }
  });
});

describe('T2B canonical CHAR(24) timestamp round-trip', () => {
  it('normalizes 0–3 fraction digits to the same canonical instant', () => {
    for (const fraction of ['', '.1', '.12', '.123']) {
      const iso = `2026-10-27T01:02:03${fraction}Z`;
      const stored = toSqlTimestamp('at', iso);
      expect(stored).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(stored).toHaveLength(24);
      expect(Date.parse(fromSqlTimestamp(stored))).toBe(Date.parse(iso));
    }
    expect(toSqlTimestamp('at', '2026-10-27T01:02:03.1Z')).toBe('2026-10-27T01:02:03.100Z');
  });

  it('preserves years 0000..9999 instead of clipping them', () => {
    expect(toSqlTimestamp('at', '0000-01-01T00:00:00.000Z')).toBe('0000-01-01T00:00:00.000Z');
    expect(toSqlTimestamp('at', '0999-12-31T23:59:59.000Z')).toBe('0999-12-31T23:59:59.000Z');
    expect(toSqlTimestamp('at', '1000-01-01T00:00:00.000Z')).toBe('1000-01-01T00:00:00.000Z');
    expect(toSqlTimestamp('at', '9999-12-31T23:59:59.999Z')).toBe('9999-12-31T23:59:59.999Z');
  });

  it('rejects non-canonical contract timestamps and non-canonical stored values', () => {
    expect(codeOf(() => toSqlTimestamp('at', '2026-10-27 01:02:03'))).toBe('TEMPLATE_INVALID_INPUT');
    expect(codeOf(() => toSqlTimestamp('at', '2026-13-01T00:00:00.000Z'))).toBe('TEMPLATE_INVALID_INPUT');
    expect(codeOf(() => toSqlTimestamp('at', '2026-10-27T01:02:03.1234Z'))).toBe('TEMPLATE_INVALID_INPUT');
    expect(codeOf(() => fromSqlTimestamp('2026-10-27 01:02:03.000'))).toBe('TEMPLATE_INVALID_INPUT');
    expect(codeOf(() => fromSqlTimestamp('2026-10-27T01:02:03.100'))).toBe('TEMPLATE_INVALID_INPUT');
  });
});

describe('T2B adapter error branches', () => {
  it('checks SQL-bound values before acquiring a connection', async () => {
    let acquired = 0;
    const repository = new MySqlTemplateRepository({
      getConnection: async () => {
        acquired += 1;
        throw new Error('must not connect');
      },
    });
    await expect(repository.updateDraft('tpl-a', 0, {
      aggregate: emptyDraftAggregate('tpl-a'), updated_by: 1.5, updated_at: AT,
    })).rejects.toMatchObject({ code: 'TEMPLATE_INVALID_INPUT' });
    expect(acquired).toBe(0);
  });

  it('maps a duplicate parent insert to TEMPLATE_EXISTS and rolls back', async () => {
    const connection = new FakeConnection(sql => {
      if (sql.startsWith('INSERT INTO metric_templates_v2')) {
        throw Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
      }
    });
    const repository = new MySqlTemplateRepository(poolOf(connection));
    await expect(repository.create(template(), draft())).rejects.toMatchObject({ code: 'TEMPLATE_EXISTS' });
    expect(connection.rollbacks).toBe(1);
    expect(connection.commits).toBe(0);
    expect(connection.releases).toBe(1);
    expect(connection.destroys).toBe(0);
  });

  it('rolls back and keeps the original error when a statement fails mid-transaction', async () => {
    const failure = new Error('injected statement failure');
    const connection = new FakeConnection(sql => {
      if (sql.startsWith('INSERT INTO metric_template_drafts')) throw failure;
    });
    const repository = new MySqlTemplateRepository(poolOf(connection));
    await expect(repository.create(template(), draft())).rejects.toBe(failure);
    expect(connection.rollbacks).toBe(1);
    expect(connection.commits).toBe(0);
    expect(connection.releases).toBe(1);
    expect(connection.destroys).toBe(0);
  });

  it('discards the connection and keeps the original error when rollback is unconfirmed', async () => {
    const failure = new Error('injected statement failure');
    const connection = new FakeConnection(sql => {
      if (sql.startsWith('INSERT INTO metric_template_drafts')) throw failure;
    });
    connection.failRollback = new Error('rollback unavailable; socket remains live');
    const repository = new MySqlTemplateRepository(poolOf(connection));
    await expect(repository.create(template(), draft())).rejects.toBe(failure);
    expect(connection.rollbacks).toBe(1);
    expect(connection.commits).toBe(0);
    expect(connection.releases).toBe(0);
    expect(connection.destroys).toBe(1);
  });

  it('discards the connection when the transaction cannot be started', async () => {
    const failure = new Error('begin failed');
    const connection = new FakeConnection();
    connection.failBegin = failure;
    const repository = new MySqlTemplateRepository(poolOf(connection));
    await expect(repository.create(template(), draft())).rejects.toBe(failure);
    expect(connection.commits).toBe(0);
    expect(connection.rollbacks).toBe(0);
    expect(connection.releases).toBe(0);
    expect(connection.destroys).toBe(1);
  });

  it('reports an unknown commit outcome instead of success or failure', async () => {
    const connection = new FakeConnection(() => {}, () => {
      throw new Error('acknowledgement lost');
    });
    const repository = new MySqlTemplateRepository(poolOf(connection));
    const error = await repository.create(template(), draft()).catch(caught => caught);
    expect(error).toBeInstanceOf(TemplateStorageUnknownCommitError);
    expect(error).toMatchObject({
      code: 'TEMPLATE_STORAGE_UNKNOWN_COMMIT',
      operation: 'create',
      identity: { template_id: 'tpl-a' },
    });
    expect(connection.commits).toBe(1);
    expect(connection.rollbacks).toBe(0);
    expect(connection.releases).toBe(0);
    expect(connection.destroys).toBe(1);
  });

  it('keeps the unknown-commit outcome even when discarding the connection fails', async () => {
    const connection = new FakeConnection(() => {}, () => {
      throw new Error('acknowledgement lost');
    }, () => {}, () => {
      throw new Error('discard failed');
    });
    const repository = new MySqlTemplateRepository(poolOf(connection));
    await expect(repository.create(template(), draft()))
      .rejects.toBeInstanceOf(TemplateStorageUnknownCommitError);
    expect(connection.releases).toBe(0);
    expect(connection.destroys).toBe(1);
  });
});
