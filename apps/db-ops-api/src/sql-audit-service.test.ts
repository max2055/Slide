import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Client as PgClient } from 'pg';

vi.mock('./ai-agent-bridge.js', () => ({ dispatchOrReuse: vi.fn() }));
vi.mock('./auth/actor-context.js', () => ({ actorContextService: { revalidateActor: vi.fn() } }));
vi.mock('./database-service.js', () => ({ databaseService: { getConnection: vi.fn(), detectVersion: vi.fn(), getExplainPlan: vi.fn() } }));
vi.mock('./instance-database-service.js', () => ({ instanceDatabaseService: { getInstanceById: vi.fn() } }));
vi.mock('./ai-analysis-database-service.js', () => ({ aiAnalysisDatabaseService: {
  getAnalysisById: vi.fn(),
} }));
vi.mock('./db-connection.js', () => ({ dbConnection: { getPool: vi.fn() } }));

import { sqlAuditService } from './sql-audit-service.js';
import { dbConnection } from './db-connection.js';
import { databaseService } from './database-service.js';
import { instanceDatabaseService } from './instance-database-service.js';
import { aiAnalysisDatabaseService } from './ai-analysis-database-service.js';
import { dispatchOrReuse } from './ai-agent-bridge.js';
import { actorContextService } from './auth/actor-context.js';
const actor = { userId: 7, username: 'tester', roles: [], permissions: ['sql:audit'], sessionVersion: 1, instanceScopes: { 1: 'read-only' as const }, requestId: 'test' };

const internal = sqlAuditService as any;
const list = (count: number) => Array.from({ length: count }, (_, i) => String(i)).join(',');
const risks = (sql: string, pattern: string) => sqlAuditService.detectRisks(sql).filter(r => r.pattern === pattern);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(actorContextService.revalidateActor).mockResolvedValue(actor);
  vi.mocked(dispatchOrReuse).mockResolvedValue({ analysisId: 31, cached: false, success: true, status: 'pending' });
  vi.mocked(aiAnalysisDatabaseService.getAnalysisById).mockResolvedValue({ related_id: 21 } as any);
});

describe('MAX-545 / #594: audit context table names', () => {
  it.each([
    ['SELECT * FROM users', ['users']],
    ["SELECT * FROM fd_db.users WHERE note='from secrets'", ['fd_db.users']],
    ['SELECT * FROM db.schema.users JOIN db.schema.roles ON 1=1', ['db.schema.users', 'db.schema.roles']],
    ['SELECT * FROM `fd_db`.`user``names`', ['`fd_db`.`user``names`']],
    ['SELECT * FROM "db"."User Names"', ['"db"."User Names"']],
    ['UPDATE fd_db.users SET x=1', ['fd_db.users']],
    ['INSERT INTO fd_db.users SELECT * FROM other.roles', ['fd_db.users', 'other.roles']],
    ['SELECT * FROM users /* JOIN secrets */ -- FROM hidden\n WHERE id=1', ['users']],
    ["SELECT 'FROM secrets', $$JOIN hidden$$ FROM users", ['users']],
    ['SELECT * FROM (SELECT * FROM fd_db.users) u JOIN roles r ON 1=1', ['fd_db.users', 'roles']],
    ["SELECT 'it''s from secrets', $tag$JOIN hidden$tag$ FROM users", ['users']],
    ['SELECT extract(year FROM created_at) FROM a.users, b.users WHERE id IN (1, 2)', ['a.users', 'b.users']],
    ['SELECT * FROM "a.b".users JOIN a."b.users" ON 1=1', ['"a.b".users', 'a."b.users"']],
    ['WITH users(id) AS (SELECT id FROM origin.users), events AS (SELECT id FROM users) SELECT id FROM events', ['origin.users']],
  ])('extracts actual table names: %s', (sql, expected) => {
    expect(internal._extractTableNames(sql, sql.includes('`') ? 'mysql' : 'postgresql').map((parts: string[]) => parts.join('.'))).toEqual(expected);
  });

  it.each([
    ['mysql', 'WITH events AS (SELECT id FROM events) SELECT id FROM events', ['events']],
    ['postgresql', 'WITH events AS (SELECT id FROM events) SELECT id FROM events', ['events']],
    ['postgresql', 'WITH "Events" AS (SELECT 999 AS id) SELECT id FROM events', ['events']],
    ['postgresql', 'WITH "events" AS (SELECT 999 AS id) SELECT id FROM EVENTS', []],
    ['postgresql', 'WITH "Ev""ents" AS (SELECT 999 AS id) SELECT id FROM "Ev""ents"', []],
    ['postgresql', 'WITH earlier AS NOT MATERIALIZED (SELECT id FROM later), later AS (SELECT 999 AS id) SELECT id FROM earlier', ['later']],
    ['postgresql', 'WITH RECURSIVE earlier AS (SELECT id FROM later), later AS (SELECT 999 AS id) SELECT id FROM earlier', []],
    ['postgresql', 'WITH RECURSIVE events(id) AS (SELECT id FROM app.events UNION ALL SELECT id + 1 FROM events WHERE id < 3) SEARCH DEPTH FIRST BY id SET ord CYCLE id SET looped USING path, next AS (SELECT id FROM events) SELECT id FROM next', ['app.events']],
    ['postgresql', 'WITH events AS (SELECT 1 AS id) UPDATE events SET id=(SELECT id FROM events)', ['events']],
    ['postgresql', 'WITH events AS (SELECT 1 AS id) DELETE FROM events WHERE id IN (SELECT id FROM events)', ['events']],
    ['mysql', 'WITH RECURSIVE earlier AS (SELECT id FROM later), later AS (SELECT 999 AS id) SELECT id FROM earlier', ['later']],
    ['mysql', 'WITH RECURSIVE events(id) AS (SELECT id FROM app.events UNION ALL SELECT id + 1 FROM events WHERE id < 3) SELECT id FROM events', ['app.events']],
    ['mysql', 'WITH `Events` AS (SELECT 999 AS id) SELECT id FROM events', ['events']],
    ['postgresql', 'WITH events AS (SELECT id FROM app.events) SELECT * FROM (WITH events AS (SELECT id FROM events) SELECT id FROM events) v JOIN events e ON 1=1', ['app.events']],
    ['postgresql', 'SELECT * FROM (WITH events AS (SELECT 1 AS id) SELECT id FROM events) a JOIN (SELECT id FROM events) b ON 1=1', ['events']],
    ['postgresql', 'WITH events AS (SELECT 1 AS id) SELECT id FROM events; SELECT id FROM events', ['events']],
    ['oracle', 'WITH "Events" AS (SELECT 1 AS id FROM dual) SELECT id FROM events', ['dual', 'events']],
    ['dameng', 'WITH "EVENTS" AS (SELECT 1 AS id FROM dual) SELECT id FROM events', ['dual']],
    ['oracle', 'WITH events(id) AS (SELECT id FROM app.events UNION ALL SELECT id + 1 FROM events WHERE id < 3) SELECT id FROM events', ['app.events']],
  ])('resolves CTE visibility for %s: %s', (dialect, sql, expected) => {
    expect(internal._extractTableNames(sql, dialect).map((parts: string[]) => parts.join('.'))).toEqual(expected);
  });

  it.each([0, 1, 2])('uses the target MySQL case mode %s only for ambiguous CTE names', async mode => {
    const execute = vi.fn().mockResolvedValueOnce([[{ case_mode: mode }]]).mockResolvedValueOnce([[]]);
    vi.mocked(databaseService.getConnection).mockReturnValue({ db_type: 'mysql', connected: true, pool: { execute } } as any);
    await sqlAuditService.submitAudit('WITH `Events` AS (SELECT 1 AS id) SELECT id FROM events', 1, actor);
    expect(execute).toHaveBeenNthCalledWith(1, 'SELECT @@lower_case_table_names AS case_mode');
    expect(execute).toHaveBeenCalledTimes(mode === 0 ? 2 : 1);
    if (mode === 0) expect(execute).toHaveBeenNthCalledWith(2, expect.stringContaining('information_schema.TABLES'), [null, 'events']);
  });

  it('preserves qualified evidence when the MySQL case mode cannot be read', async () => {
    const execute = vi.fn().mockRejectedValueOnce(new Error('mode unavailable')).mockResolvedValueOnce([[{
      table_schema: 'other', table_name: 'events', table_rows: 2, index_name: 'events_idx', column_name: 'id',
    }]]);
    vi.mocked(databaseService.getConnection).mockReturnValue({ db_type: 'mysql', connected: true, pool: { execute } } as any);
    await sqlAuditService.submitAudit('WITH `Events` AS (SELECT 1 AS id) SELECT a.id FROM events a JOIN other.events b ON b.id=a.id', 1, actor);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(2, expect.stringContaining('information_schema.TABLES'), ['other', 'events']);
    const evidence = vi.mocked(dispatchOrReuse).mock.lastCall?.[0].evidenceData as { index_info: string; table_stats: string };
    expect(evidence.index_info).toContain('索引证据不可用（无法确认目标数据库标识符大小写规则）');
    expect(evidence.index_info).toContain('表: `other`.`events`\n  events_idx');
    expect(evidence.table_stats).toContain('表统计证据不可用（无法确认目标数据库标识符大小写规则）');
    expect(evidence.table_stats).toContain('表: `other`.`events`\n  行数: 2');
  });

  it('binds both evidence fields to each qualified MySQL table and the connection default', async () => {
    const execute = vi.fn(async (_sql: string, [schema, name]: [string | null, string]) => {
      const db = schema ?? 'default_db';
      if (db === 'hidden') return [[]];
      return [[{
        table_schema: db, table_name: name, table_rows: db === 'tenant_a' ? 12 : 34,
        index_name: db + '_idx', column_name: 'id', index_type: 'BTREE', non_unique: 0,
      }]];
    });
    vi.mocked(databaseService.getConnection).mockReturnValue({ db_type: 'mysql', connected: true, pool: { execute } } as any);
    const sql = "SELECT a.id FROM tenant_a.users a JOIN users b ON a.id=b.id JOIN hidden.users c ON a.id=c.id WHERE a.note='from secrets'";
    await sqlAuditService.submitAudit(sql, 1, actor);
    expect(execute.mock.calls.map(call => call[1])).toEqual([
      ['tenant_a', 'users'], [null, 'users'], ['hidden', 'users'],
    ]);
    const evidence = vi.mocked(dispatchOrReuse).mock.calls[0][0].evidenceData as any;
    expect(evidence.index_info).toContain('表: `tenant_a`.`users`\n  tenant_a_idx');
    expect(evidence.index_info).toContain('表: `default_db`.`users`\n  default_db_idx');
    expect(evidence.index_info).toContain('表: hidden.users - 索引证据不可用');
    expect(evidence.table_stats).toContain('表: `tenant_a`.`users`\n  行数: 12');
    expect(evidence.table_stats).toContain('表: `default_db`.`users`\n  行数: 34');
    expect(evidence.table_stats).toContain('表: hidden.users - 表统计证据不可用');
    expect(dbConnection.getPool).not.toHaveBeenCalled();
  });

  it.each(['oracle', 'dameng'])('binds owner and table using %s identifier rules', async dialect => {
    const execute = vi.fn().mockResolvedValue({ rows: [
      ['Audit.Team', 'EVENTS', 42, 16, 'EVENTS_IDX', 'ID', 'UNIQUE', 'NORMAL'],
    ] });
    const driver = dialect === 'oracle' ? 'oracleConnection' : 'dmConnection';
    vi.mocked(databaseService.getConnection).mockReturnValue({ db_type: dialect, connected: true, [driver]: { execute } } as any);
    await sqlAuditService.submitAudit('SELECT id FROM "Audit.Team".events', 1, actor);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('i.TABLE_OWNER = t.OWNER'), ['Audit.Team', 'EVENTS']);
    const evidence = vi.mocked(dispatchOrReuse).mock.calls[0][0].evidenceData as any;
    expect(evidence.index_info).toContain('表: "Audit.Team"."EVENTS"\n  EVENTS_IDX (ID)');
    expect(evidence.table_stats).toContain('表: "Audit.Team"."EVENTS"\n  行数: 42');
  });

  it('rechecks instance authority after collecting table evidence', async () => {
    const execute = vi.fn().mockResolvedValue([[]]);
    vi.mocked(databaseService.getConnection).mockReturnValue({ db_type: 'mysql', connected: true, pool: { execute } } as any);
    vi.mocked(actorContextService.revalidateActor).mockResolvedValueOnce(actor).mockResolvedValueOnce({ ...actor, instanceScopes: {} });
    await expect(sqlAuditService.submitAudit('SELECT id FROM tenant_a.users', 1, actor)).rejects.toThrow('ANALYSIS_AUTHORITY_REVOKED');
    expect(execute).toHaveBeenCalledOnce();
    expect(dispatchOrReuse).not.toHaveBeenCalled();
  });
});

it.skipIf(process.env.SQL_AUDIT_PG_TEST !== '1')('resolves PostgreSQL catalog evidence via active search_path and relation grants (#1029)', async () => {
  const { SQL_AUDIT_PG_PORT: port, SQL_AUDIT_PG_PASSWORD: password } = process.env;
  if (!port || password === undefined) throw new Error('Explicit SQL_AUDIT_PG_PORT and SQL_AUDIT_PG_PASSWORD are required');
  const pgClient = new PgClient({ host: '127.0.0.1', port: Number(port), user: 'postgres', database: 'postgres', password });
  const suffix = randomBytes(6).toString('hex');
  const first = `first_${suffix}`;
  const second = `"Second.${suffix}"`;
  const hidden = `hidden_${suffix}`;
  const role = `reader_${suffix}`;
  await pgClient.connect();
  try {
    await pgClient.query(`CREATE ROLE ${role};
      CREATE SCHEMA ${first}; CREATE SCHEMA ${second}; CREATE SCHEMA ${hidden};
      CREATE TABLE ${first}.events (id int); CREATE INDEX first_idx ON ${first}.events(id);
      CREATE TABLE ${second}.events (id int); CREATE INDEX second_idx ON ${second}.events(id);
      CREATE TABLE ${second}."Events" (id int); CREATE INDEX quoted_idx ON ${second}."Events"(id);
      CREATE TABLE ${hidden}.events (id int); CREATE INDEX hidden_idx ON ${hidden}.events(id);
      INSERT INTO ${first}.events VALUES (1);
      INSERT INTO ${second}.events VALUES (1), (2);
      INSERT INTO ${second}."Events" VALUES (3);
      ANALYZE ${first}.events; ANALYZE ${second}.events; ANALYZE ${second}."Events";
      GRANT USAGE ON SCHEMA ${first}, ${second}, ${hidden} TO ${role};
      GRANT SELECT ON ${first}.events, ${second}.events, ${second}."Events" TO ${role};
      SET ROLE ${role}; SET search_path TO ${second}, ${first};`);
    vi.mocked(databaseService.getConnection).mockReturnValue({ db_type: 'postgresql', connected: true, pgClient } as any);
    await sqlAuditService.submitAudit(`SELECT a.id FROM ${first}.EVENTS a JOIN events b ON a.id=b.id
      JOIN ${hidden}.events h ON h.id=a.id`, 1, actor);
    const evidence = vi.mocked(dispatchOrReuse).mock.calls[0][0].evidenceData as any;
    expect(evidence.index_info).toContain(`表: "${first}"."events"\n  CREATE INDEX first_idx`);
    expect(evidence.index_info).toContain(`表: ${second}."events"\n  CREATE INDEX second_idx`);
    expect(evidence.index_info).toContain(`表: ${hidden}.events - 索引证据不可用`);
    expect(evidence.index_info).not.toContain('hidden_idx');
    expect(evidence.table_stats).toContain(`表: "${first}"."events"\n  行数: 1`);
    expect(evidence.table_stats).toContain(`表: ${second}."events"\n  行数: 2`);
    expect(evidence.table_stats).toContain(`表: ${hidden}.events - 表统计证据不可用`);

    await pgClient.query(`SET search_path TO ${hidden}, ${second};`);
    await sqlAuditService.submitAudit('SELECT id FROM events', 1, actor);
    expect(vi.mocked(dispatchOrReuse).mock.calls[1][0].evidenceData).toMatchObject({
      index_info: expect.stringContaining('表: events - 索引证据不可用'),
    });

    const quoted = 'WITH events AS (SELECT 999 AS id) SELECT id FROM "Events"';
    expect((await pgClient.query(quoted)).rows).toEqual([{ id: 3 }]);
    await sqlAuditService.submitAudit(quoted, 1, actor);
    expect(vi.mocked(dispatchOrReuse).mock.lastCall?.[0].evidenceData).toMatchObject({
      index_info: expect.stringContaining(`表: ${second}."Events"\n  CREATE INDEX quoted_idx`),
      table_stats: expect.stringContaining(`表: ${second}."Events"\n  行数: 1`),
    });

    const filtered = 'WITH RECURSIVE earlier AS (SELECT id FROM events), events AS (SELECT 999 AS id) SELECT id FROM earlier';
    expect((await pgClient.query(filtered)).rows).toEqual([{ id: 999 }]);
    await sqlAuditService.submitAudit(filtered, 1, actor);
    expect(vi.mocked(dispatchOrReuse).mock.lastCall?.[0].evidenceData).toMatchObject({
      index_info: '索引证据不可用（未识别到可查询的表）',
      table_stats: '表统计证据不可用（未识别到可查询的表）',
    });
  } finally {
    try {
      await pgClient.query(`RESET ROLE; DROP SCHEMA IF EXISTS ${first}, ${second}, ${hidden} CASCADE; DROP ROLE IF EXISTS ${role};`);
    } finally {
      await pgClient.end();
    }
  }
});

describe('MAX-547 / #597: WHERE belongs to the audited statement', () => {
  it.each([
    'UPDATE users SET x=1', 'DELETE FROM users',
    "UPDATE users SET note='WHERE id=1'", 'UPDATE users SET somewhere=1 /* WHERE id=1 */',
    'UPDATE users SET x=(SELECT id FROM other WHERE id=1)',
    'SELECT * FROM other WHERE id=1; UPDATE users SET x=1',
    'WITH source AS (SELECT * FROM other WHERE id=1) UPDATE users SET x=1',
    'DELETE FROM users WHERE id=1; UPDATE users SET x=1',
    'UPDATE users SET `where`=1',
  ])('reports unsafe writes: %s', sql => {
    expect(risks(sql, 'MISSING WHERE')).toEqual([expect.objectContaining({ level: 'error' })]);
  });

  it.each(['SELECT COUNT(*) FROM users', 'SELECT * FROM users'])('does not turn an unfiltered read into P0: %s', sql => {
    expect(internal._calculateRiskLevel(sqlAuditService.detectRisks(sql))).not.toBe('P0');
  });

  it.each([
    'SELECT * FROM users WHERE id=1', 'UPDATE users SET x=1 WHERE id=1', 'DELETE FROM users WHERE id=1',
    'SELECT * FROM users WHERE id=1 FOR UPDATE',
  ])('does not report filtered statements: %s', sql => {
    expect(risks(sql, 'MISSING WHERE')).toEqual([]);
  });
});

describe('MAX-550 / #593: IN list boundaries', () => {
  it.each([
    `SELECT * FROM users JOIN (SELECT ${list(101)} FROM roles) r ON 1=1`,
    `SELECT 'in (${list(101)})' FROM users`,
    `SELECT * FROM users /* IN (${list(101)}) */`,
    `SELECT $body$in (${list(101)})$body$ FROM users`,
    `SELECT * FROM users WHERE id IN (SELECT ${list(101)} FROM roles)`,
    'SELECT * FROM users WHERE id IN (1,2,3)',
    `SELECT * FROM users WHERE id IN (${list(100)})`,
    `SELECT * FROM users WHERE id IN (concat('${list(101)}', 'x'), 2)`,
  ])('ignores non-lists and lists up to 100: %s', sql => {
    expect(risks(sql, 'LARGE IN CLAUSE')).toEqual([]);
  });

  it.each([
    `SELECT * FROM users WHERE id IN (${list(101)})`,
    `SELECT * FROM users WHERE id NOT IN (${Array.from({ length: 101 }, () => "concat('a,b', 'c')").join(',')})`,
  ])('warns for 101 actual values: %s', sql => {
    expect(risks(sql, 'LARGE IN CLAUSE')).toEqual([expect.objectContaining({ message: expect.stringContaining('101') })]);
  });
});

describe('MAX-688 / #1013: MySQL executable comments in preflight', () => {
  it.each(['UPDATE audit_fixture SET marker =', 'DELETE FROM'])(
    'classifies an offline unfiltered DML fragment consistently (%s)',
    fragment => {
      const plain = sqlAuditService.detectRisks(fragment, 'mysql');
      expect(internal._calculateRiskLevel(plain)).toBe('P0');
      expect(sqlAuditService.detectRisks(`/*! ${fragment} */`, 'mysql')).toEqual(plain);
    },
  );

  it('retains P0 for an equivalent unfiltered update with an inline expression', () => {
    const plain = sqlAuditService.detectRisks('UPDATE audit_fixture SET marker = marker', 'mysql');
    const inline = sqlAuditService.detectRisks('UPDATE audit_fixture SET marker = /*! marker */', 'mysql');
    expect(inline).toEqual(plain);
    expect(internal._calculateRiskLevel(inline)).toBe('P0');
  });

  it.each([
    ['SELECT /*! * */ FROM audit_fixture', 'SELECT * FROM audit_fixture'],
    ["SELECT /*! 'nonclosing */ text', * */ FROM audit_fixture", "SELECT 'nonclosing */ text', * FROM audit_fixture"],
    ['SELECT 1; /*! SELECT COUNT(*) FROM audit_fixture */', 'SELECT 1; SELECT COUNT(*) FROM audit_fixture'],
  ])('analyzes active SQL in its surrounding statement (%s)', (input, equivalent) => {
    const findings = sqlAuditService.detectRisks(input, 'mysql');
    expect(findings).toEqual(sqlAuditService.detectRisks(equivalent, 'mysql'));
    expect(findings).toContainEqual(expect.objectContaining({ pattern: 'MISSING WHERE', level: 'warning' }));
    expect(internal._calculateRiskLevel(findings)).toBe('P2');
  });

  it.each([
    "SELECT 'it''s /*!80030 FROM audit_fixture */'",
    "SELECT 'it\\'s /*!80030 FROM audit_fixture */'",
    'SELECT `column /*!80030 FROM audit_fixture */`',
    'SELECT 1 -- /*!80030 FROM audit_fixture */',
    'SELECT 1 # /*!80030 FROM audit_fixture */',
    'SELECT 1 /* ordinary /*!80030 FROM audit_fixture */',
    'SELECT /*+ hint */ 1 /* FROM audit_fixture */',
  ])('keeps inactive comment markers inert (%s)', sql => {
    expect(sqlAuditService.detectRisks(sql, 'mysql')).toEqual([]);
  });

  it.each(['#', '--'])('keeps a versioned marker after a lone CR inside a %s comment at admission', async marker => {
    vi.mocked(databaseService.getConnection).mockReturnValue({ db_type: 'mysql' } as any);
    const sql = 'SELECT 1 ' + marker + ' note\r/*!80030 FROM audit_fixture */';
    const result = await sqlAuditService.submitAudit(sql, 1, actor);
    expect(result.preAuditResults).toEqual([]);
    expect(databaseService.detectVersion).not.toHaveBeenCalled();
  });

  it.each(['#', '--'])('keeps a plain predicate after a lone CR inside a %s comment', marker => {
    const sql = 'SELECT 1 FROM audit_fixture ' + marker + ' note\rWHERE id = 1';
    expect(sqlAuditService.detectRisks(sql, 'mysql')).toEqual([
      expect.objectContaining({ pattern: 'MISSING WHERE', level: 'warning' }),
    ]);
  });

  it.each([
    { marker: '#', ending: 'LF', separator: '\n' },
    { marker: '--', ending: 'LF', separator: '\n' },
    { marker: '#', ending: 'CRLF', separator: '\r\n' },
    { marker: '--', ending: 'CRLF', separator: '\r\n' },
  ])('applies the MySQL version threshold after a $marker comment ending in $ending', ({ marker, separator }) => {
    const sql = 'SELECT 1 ' + marker + ' note' + separator + '/*!80030 FROM audit_fixture */';
    const unfilteredRead = expect.objectContaining({ pattern: 'MISSING WHERE', level: 'warning' });
    expect(sqlAuditService.detectRisks(sql, 'mysql', '8.0.29')).toEqual([]);
    expect(sqlAuditService.detectRisks(sql, 'mysql', '8.0.30')).toEqual([unfilteredRead]);
    expect(sqlAuditService.detectRisks(sql, 'mysql')).toEqual([
      unfilteredRead,
      expect.objectContaining({ pattern: 'MYSQL EXECUTABLE COMMENT VERSION UNKNOWN', level: 'warning' }),
    ]);
  });

  it.each(['postgresql', 'oracle', 'dameng', 'unknown'])('keeps executable comment syntax inert for %s', dialect => {
    expect(sqlAuditService.detectRisks('/*!80030 SELECT COUNT(*) FROM audit_fixture */', dialect)).toEqual([]);
  });

  it.each([
    ['/*!80030 SELECT COUNT(*) FROM audit_fixture */', '8.0.30-log', true],
    ['/*!80030 SELECT COUNT(*) FROM audit_fixture */', '8.0.29', false],
    ['/*!080401 SELECT COUNT(*) FROM audit_fixture */', '8.4.1', true],
    ['/*!080401 SELECT COUNT(*) FROM audit_fixture */', '8.4.0', false],
    ['/*!80030SELECT COUNT(*) FROM audit_fixture */', '8.0.46', true],
  ])('applies the version threshold for %s on %s', (sql, version, active) => {
    const findings = sqlAuditService.detectRisks(sql, 'mysql', version);
    if (active) {
      expect(findings).toEqual([expect.objectContaining({ pattern: 'MISSING WHERE', level: 'warning' })]);
    } else {
      expect(findings).toEqual([]);
    }
  });

  it('retains a finding if a version-dependent filter may be inactive', () => {
    const findings = sqlAuditService.detectRisks('SELECT COUNT(*) FROM audit_fixture /*!80030 WHERE id=1 */', 'mysql');
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ pattern: 'MYSQL EXECUTABLE COMMENT VERSION UNKNOWN', level: 'warning' }),
      expect.objectContaining({ pattern: 'MISSING WHERE', level: 'warning' }),
    ]));
  });

  it.each([['mysql', '8.0.30', true], ['postgresql', null, false]] as const)(
    'uses the connected dialect at admission and only probes a MySQL version (%s)',
    async (dialect, version, active) => {
      vi.mocked(databaseService.getConnection).mockReturnValue({ db_type: dialect } as any);
      vi.mocked(databaseService.detectVersion).mockResolvedValue(version);
      const sql = '/*!80030 SELECT COUNT(*) FROM audit_fixture */';
      const result = await sqlAuditService.submitAudit(sql, 1, actor);
      expect(databaseService.detectVersion).toHaveBeenCalledTimes(active ? 1 : 0);
      expect(result.preAuditResults).toEqual(active ? [expect.objectContaining({ pattern: 'MISSING WHERE' })] : []);
      expect(dispatchOrReuse).toHaveBeenCalledWith(expect.objectContaining({
        evidenceData: expect.objectContaining({ dialect, sql_text: sql, pre_audit_results: result.preAuditResults }),
        sqlAuditRecord: expect.objectContaining({ sqlText: sql, riskLevel: 'P2' }),
      }));
    },
  );

  it('uses the registered dialect for a disconnected instance and surfaces the unknown version', async () => {
    vi.mocked(databaseService.detectVersion).mockResolvedValue(null);
    vi.mocked(instanceDatabaseService.getInstanceById).mockResolvedValue({ db_type: 'mysql' } as any);
    const result = await sqlAuditService.submitAudit('/*!80030 SELECT COUNT(*) FROM audit_fixture */', 1, actor);
    expect(instanceDatabaseService.getInstanceById).toHaveBeenCalledWith(1);
    expect(result.preAuditResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ pattern: 'MYSQL EXECUTABLE COMMENT VERSION UNKNOWN' }),
      expect.objectContaining({ pattern: 'MISSING WHERE' }),
    ]));
  });

  it('does not probe the version for a marker inside quoted text', async () => {
    vi.mocked(databaseService.getConnection).mockReturnValue({ db_type: 'mysql' } as any);
    const result = await sqlAuditService.submitAudit("SELECT '/*!80030 quoted text */'", 1, actor);
    expect(databaseService.detectVersion).not.toHaveBeenCalled();
    expect(result.preAuditResults).toEqual([]);
  });
});

describe('MAX-533 audit admission and cache identity', () => {
  it('keeps static risks and explicit degradation in frozen evidence', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('metadata unavailable'));
    vi.mocked(databaseService.getConnection).mockReturnValue({ db_type: 'mysql', connected: true, pool: { execute } } as any);
    vi.mocked(databaseService.getExplainPlan).mockRejectedValue(new Error('explain unavailable'));
    const submitted = await sqlAuditService.submitAudit('UPDATE db.users SET x=1', 1, actor);
    expect(submitted.preAuditResults).toContainEqual(expect.objectContaining({ pattern: 'MISSING WHERE', level: 'error' }));
    const evidence = vi.mocked(dispatchOrReuse).mock.calls[0][0].evidenceData as any;
    expect(evidence.index_info).toContain('表: db.users - 索引证据不可用（查询失败）');
    expect(evidence.table_stats).toContain('表: db.users - 表统计证据不可用（查询失败）');
    expect(evidence.explain).toBe('EXPLAIN 获取失败');
  });

  it.each([
    ['UPDATE users SET x=1', 'error', 'P0'],
    ['SELECT COUNT(*) FROM users', 'warning', 'P2'],
    ['UPDATE users SET x=1 WHERE id=1', 'info', 'P2'],
  ])('retains static risk on admission and completed reuse: %s', async (sql, auditLevel, riskLevel) => {
    vi.mocked(dispatchOrReuse).mockResolvedValue({ analysisId: 31, cached: true, success: true, status: 'completed' });
    const result = await sqlAuditService.submitAudit(sql, 1, actor);
    expect(result.recordId).toBe(21);
    expect(dispatchOrReuse).toHaveBeenCalledWith(expect.objectContaining({
      actor, type: 'sql_audit', instanceId: 1,
      sqlAuditRecord: expect.objectContaining({ auditLevel, riskLevel, createdBy: 'tester' }),
      evidenceData: expect.objectContaining({ pre_audit_results: result.preAuditResults }),
    }));
  });

  it('binds distinct literals to distinct cache keys even after SQL redaction', async () => {
    await sqlAuditService.submitAudit('SELECT 1', 1, actor);
    await sqlAuditService.submitAudit('SELECT 2', 1, actor);
    const [first, second] = vi.mocked(dispatchOrReuse).mock.calls.map(c => c[0]);
    expect(first.cacheKey).not.toBe(second.cacheKey);
    expect((first.evidenceData as any).input_hash).not.toBe((second.evidenceData as any).input_hash);
  });

  it.each([
    { ...actor, permissions: [] },
    { ...actor, instanceScopes: {} },
    { ...actor, resourceBoundary: { instanceIds: [], serverIds: [], networkDeviceIds: [] } },
  ])('rejects revoked permission or scope before collecting evidence', async current => {
    vi.mocked(actorContextService.revalidateActor).mockResolvedValue(current);
    await expect(sqlAuditService.submitAudit('SELECT 1', 1, actor)).rejects.toThrow('ANALYSIS_AUTHORITY_REVOKED');
    expect(databaseService.getExplainPlan).not.toHaveBeenCalled();
    expect(dispatchOrReuse).not.toHaveBeenCalled();
  });

  it('never reports an unknown provider result as a cache hit', async () => {
    vi.mocked(dispatchOrReuse).mockResolvedValue({ analysisId: 31, cached: false, success: false, status: 'unknown' });
    await expect(sqlAuditService.submitAudit('SELECT 1', 1, actor)).rejects.toThrow('ANALYSIS_PROVIDER_RESULT_UNKNOWN');
    expect(aiAnalysisDatabaseService.getAnalysisById).not.toHaveBeenCalled();
  });
});
