import { afterEach, describe, expect, it, vi } from 'vitest';
import { databaseService } from './database-service.js';

const connections = (databaseService as any).connections as Map<number, any>;

function installPostgresConnection(query: ReturnType<typeof vi.fn>) {
  connections.set(991, {
    id: 991,
    name: 'security-test',
    config: {},
    pool: null,
    pgClient: { query },
    oracleConnection: null,
    oraclePool: null,
    dmConnection: null,
    connected: true,
    db_type: 'postgresql',
  });
}

describe('DatabaseService EXPLAIN security boundary', () => {
  afterEach(() => connections.delete(991));

  it.each([
    'SELECT 1; DELETE FROM audit_log',
    "SELECT nextval('audit_seq')",
    'SELECT unreviewed_extension_function(1)',
  ])('rejects unsafe SQL before the text EXPLAIN driver call: %s', async (sql) => {
    const query = vi.fn();
    installPostgresConnection(query);

    await expect(databaseService.getExplainPlan(991, sql)).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects unsafe SQL before the JSON EXPLAIN driver call', async () => {
    const query = vi.fn();
    installPostgresConnection(query);

    await expect(databaseService.getExplainPlanJson(991, 'SELECT 1; DROP TABLE users')).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('uses non-executing PostgreSQL EXPLAIN for a safe SELECT', async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [{ 'QUERY PLAN': 'Result' }] }));
    installPostgresConnection(query);

    await databaseService.getExplainPlan(991, 'SELECT 1');

    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN READ ONLY',
      'SET LOCAL statement_timeout = 15000',
      'EXPLAIN SELECT 1',
      'COMMIT',
    ]);
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('ANALYZE'));
  });
});
