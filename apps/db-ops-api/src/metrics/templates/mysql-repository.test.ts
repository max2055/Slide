/**
 * MAX-237 / T2A — focused adapter checks that need no database.
 *
 * Everything transactional (CAS, first-item races, rollback, commit-loss) is
 * exercised against real MySQL in `mysql-repository.mysql.test.ts`; these tests
 * prove the pure storage-boundary and timestamp rules plus the error branches a
 * fake connection can reach deterministically.
 */
import { describe, expect, it } from 'vitest';
import { TemplateError } from './errors.js';
import { emptyDraftAggregate, type TemplateDraft, type TemplateRecord } from './model.js';
import {
  MySqlTemplateRepository, TemplateStorageUnknownCommitError, fromSqlDateTime, sqlCanonicalId, sqlInt,
  sqlNextRevision, sqlNextVersion, sqlSemanticVersion, toSqlDateTime,
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

/** The rendering `DATE_FORMAT(col, '%Y-%m-%dT%H:%i:%s.%fZ')` produces for a DATETIME(3). */
const readBack = (sqlDateTime: string): string => `${sqlDateTime.replace(' ', 'T')}000Z`;

class FakeConnection implements TemplateSqlConnection {
  readonly statements: string[] = [];
  commits = 0;
  rollbacks = 0;
  releases = 0;

  constructor(
    private readonly beforeExecute: (sql: string) => void = () => {},
    private readonly beforeCommit: () => void = () => {},
    private readonly onRelease: () => void = () => {},
  ) {}

  async execute(sql: string): Promise<[unknown, unknown]> {
    this.statements.push(sql);
    this.beforeExecute(sql);
    return [{ affectedRows: 1 }, []];
  }

  async beginTransaction(): Promise<void> {}

  async commit(): Promise<void> {
    this.commits += 1;
    this.beforeCommit();
  }

  async rollback(): Promise<void> {
    this.rollbacks += 1;
  }

  release(): void {
    this.releases += 1;
    this.onRelease();
  }
}

const poolOf = (connection: TemplateSqlConnection): TemplateSqlPool => ({
  getConnection: async () => connection,
});

describe('T2A SQL value boundaries', () => {
  it('rejects INT values outside 0..2147483647 instead of truncating', () => {
    expect(sqlInt('actor', 0)).toBe(0);
    expect(sqlInt('actor', 2147483647)).toBe(2147483647);
    expect(sqlInt('actor', null)).toBeNull();
    expect(codeOf(() => sqlInt('actor', 2147483648))).toBe('TEMPLATE_INVALID_INPUT');
    expect(codeOf(() => sqlInt('actor', -1))).toBe('TEMPLATE_INVALID_INPUT');
    expect(codeOf(() => sqlInt('actor', 1.5))).toBe('TEMPLATE_INVALID_INPUT');
  });

  it('refuses revision/version increments at the INT ceiling', () => {
    expect(sqlNextRevision('revision', 0)).toBe(1);
    expect(sqlNextRevision('revision', 2147483646)).toBe(2147483647);
    expect(codeOf(() => sqlNextRevision('revision', 2147483647))).toBe('TEMPLATE_INVALID_INPUT');
    expect(sqlNextVersion('version', 0)).toBe(1);
    expect(codeOf(() => sqlNextVersion('version', 2147483647))).toBe('TEMPLATE_INVALID_INPUT');
  });

  it('enforces the VARCHAR widths of the canonical columns', () => {
    expect(sqlCanonicalId('id', 'a'.repeat(128))).toHaveLength(128);
    expect(codeOf(() => sqlCanonicalId('id', 'a'.repeat(129)))).toBe('TEMPLATE_INVALID_INPUT');
    expect(sqlSemanticVersion('semver', '1'.repeat(16))).toHaveLength(16);
    expect(codeOf(() => sqlSemanticVersion('semver', '1'.repeat(17)))).toBe('TEMPLATE_INVALID_INPUT');
  });

  it('names the internal storage boundary, not the public contract', () => {
    try {
      sqlCanonicalId('canonical', 'a'.repeat(129));
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as TemplateError).message).toContain('internal T2A storage boundary');
      expect((error as TemplateError).code).toBe('TEMPLATE_INVALID_INPUT');
    }
  });
});

describe('T2A DATETIME(3) round-trip', () => {
  it('writes UTC wall clock and preserves the instant for 0–3 digit fractions', () => {
    for (const fraction of ['', '.1', '.12', '.123']) {
      const iso = `2026-10-27T01:02:03${fraction}Z`;
      const stored = toSqlDateTime('at', iso);
      expect(stored).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
      const rendered = fromSqlDateTime(readBack(stored));
      expect(Date.parse(rendered)).toBe(Date.parse(iso));
      expect(rendered).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
    expect(fromSqlDateTime(readBack(toSqlDateTime('at', '2026-10-27T01:02:03.1Z'))))
      .toBe('2026-10-27T01:02:03.100Z');
  });

  it('rejects years the DATETIME column cannot store', () => {
    expect(toSqlDateTime('at', '1000-01-01T00:00:00.000Z')).toBe('1000-01-01 00:00:00.000');
    expect(toSqlDateTime('at', '9999-12-31T23:59:59.999Z')).toBe('9999-12-31 23:59:59.999');
    expect(codeOf(() => toSqlDateTime('at', '0999-12-31T23:59:59.000Z'))).toBe('TEMPLATE_INVALID_INPUT');
  });
});

describe('T2A adapter error branches', () => {
  it('checks SQL-bound values before acquiring a connection', async () => {
    let acquired = 0;
    const repository = new MySqlTemplateRepository({
      getConnection: async () => {
        acquired += 1;
        throw new Error('must not connect');
      },
    });
    await expect(repository.create({ ...template(), created_by: 2147483648 }, draft()))
      .rejects.toMatchObject({ code: 'TEMPLATE_INVALID_INPUT' });
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
    expect(connection.releases).toBe(1);
  });

  it('keeps the unknown-commit outcome even when releasing the connection fails', async () => {
    const connection = new FakeConnection(() => {}, () => {
      throw new Error('acknowledgement lost');
    }, () => {
      throw new Error('release failed');
    });
    const repository = new MySqlTemplateRepository(poolOf(connection));
    await expect(repository.create(template(), draft()))
      .rejects.toBeInstanceOf(TemplateStorageUnknownCommitError);
  });
});
