/**
 * MAX-376 dialect gate for custom collection.
 *
 * validateSqlIsSelectOnly callers at the time of this change:
 * - collectors/custom-sql.provider.ts passes the instance db_type
 * - sql-generator.ts and server.ts metric registry routes omit the dialect
 *   and therefore stay on the MySQL default
 * - sql-generator.test.ts and __tests__/sql-validator.test.ts call the default
 */
import { describe, expect, it } from 'vitest';
import { classifySql, validateSqlIsSelectOnly } from './sql-validator.js';

const POSTGRES_READS = [
  "SELECT * FROM t WHERE name ILIKE 'a%'",
  "SELECT 'a'::text",
  'SELECT DISTINCT ON (id) id FROM t',
] as const;

describe('MAX-376 validateSqlIsSelectOnly dialect', () => {
  it.each(POSTGRES_READS)('accepts PostgreSQL read %s', (sql) => {
    expect(validateSqlIsSelectOnly(sql, 'postgresql')).toEqual({ valid: true });
    expect(classifySql(sql, 'postgresql')).toMatchObject({ commandType: 'read', reasonCode: 'READ_ONLY' });
  });

  it.each(POSTGRES_READS)('keeps the default and explicit MySQL gate closed for %s', (sql) => {
    expect(validateSqlIsSelectOnly(sql).valid).toBe(false);
    expect(validateSqlIsSelectOnly(sql, 'mysql').valid).toBe(false);
  });

  it('rejects an unknown dialect instead of parsing it as MySQL', () => {
    expect(validateSqlIsSelectOnly('SELECT 1', 'sqlserver')).toMatchObject({ valid: false });
    expect(validateSqlIsSelectOnly('SELECT 1', '')).toMatchObject({ valid: false });
    expect(validateSqlIsSelectOnly('SELECT 1', 'PostgreSQL')).toMatchObject({ valid: false });
    expect(validateSqlIsSelectOnly('SELECT 1').valid).toBe(true);
  });

  it.each([
    'WITH x AS (INSERT INTO t(id) VALUES (1) RETURNING id) SELECT id FROM x',
    'WITH x AS (UPDATE t SET id = id RETURNING id) SELECT id FROM x',
    'WITH x AS (SELECT 1 AS id), y AS (INSERT INTO t(id) VALUES (1) RETURNING id) SELECT id FROM y',
    'WITH x AS (DELETE FROM t RETURNING id) SELECT id FROM x',
    'SELECT 1; DROP TABLE t',
    'SELECT id FROM t FOR UPDATE',
    'SELECT id FROM t FOR SHARE',
    'SELECT id FROM t FOR NO KEY UPDATE',
    'SELECT id FROM t FOR KEY SHARE',
    'SELECT id FROM t FOR/**/UPDATE',
    'SELECT pg_sleep(1)',
    "SELECT pg_read_file('/etc/passwd')",
    "SELECT lo_export(1, '/tmp/x')",
    "SELECT set_config('a', 'b', false)",
    "SELECT nextval('s')",
    'COPY t TO STDOUT',
    'SELECT id INTO dest FROM t',
  ] as const)('rejects PostgreSQL collection bypass %s', (sql) => {
    expect(validateSqlIsSelectOnly(sql, 'postgresql').valid).toBe(false);
    expect(classifySql(sql, 'postgresql').commandType).not.toBe('read');
  });

  it('still allows a PostgreSQL read CTE and quoted lock text', () => {
    expect(validateSqlIsSelectOnly('WITH x AS (SELECT 1 AS id) SELECT id FROM x', 'postgresql').valid).toBe(true);
    expect(validateSqlIsSelectOnly("SELECT msg FROM t WHERE msg = 'for update'", 'postgresql').valid).toBe(true);
    expect(validateSqlIsSelectOnly('SELECT id FROM t /* FOR UPDATE */', 'postgresql').valid).toBe(true);
  });

  it.each([
    ['SELECT 1 /*! FOR UPDATE */', 'LOCKING_READ'],
    ['SELECT * FROM t LOCK IN SHARE MODE', 'LOCKING_READ'],
    ["SELECT 'a\\' , SLEEP(0) AS executed -- '", 'DANGEROUS_FUNCTION'],
    ['SELECT `SLEEP`(0)', 'DANGEROUS_FUNCTION'],
    ['SELECT SLEEP(1)', 'DANGEROUS_FUNCTION'],
    ['SELECT 1; SELECT 2', 'MULTI_STATEMENT'],
  ] as const)('keeps the MySQL read boundary for %s', (sql, reasonCode) => {
    expect(classifySql(sql)).toMatchObject({ commandType: 'unknown', reasonCode });
    expect(validateSqlIsSelectOnly(sql).valid).toBe(false);
  });

  it('still rejects a MySQL write', () => {
    expect(classifySql('INSERT INTO t VALUES (1)')).toMatchObject({ commandType: 'write', reasonCode: 'UNCLASSIFIED' });
    expect(validateSqlIsSelectOnly('INSERT INTO t VALUES (1)').valid).toBe(false);
  });

  it('keeps MySQL string literals and the safe function whitelist readable', () => {
    expect(validateSqlIsSelectOnly("SELECT msg FROM t WHERE msg = 'please for update now'").valid).toBe(true);
    expect(validateSqlIsSelectOnly('SELECT COUNT(*), LOWER(name) FROM t').valid).toBe(true);
    expect(classifySql('SELECT $$sleep(0)$$')).toMatchObject({ commandType: 'unknown', reasonCode: 'UNCLASSIFIED' });
  });

  it.each(['oracle', 'dameng'] as const)('uses the existing %s read capability without admitting PostgreSQL syntax', (dialect) => {
    expect(validateSqlIsSelectOnly('SELECT 1 FROM DUAL', dialect).valid).toBe(true);
    expect(validateSqlIsSelectOnly("SELECT * FROM t WHERE name ILIKE 'a%'", dialect).valid).toBe(false);
    expect(validateSqlIsSelectOnly("SELECT 'a'::text FROM DUAL", dialect).valid).toBe(false);
    expect(validateSqlIsSelectOnly('SELECT DISTINCT ON (id) id FROM t', dialect).valid).toBe(false);
    expect(validateSqlIsSelectOnly('UPDATE t SET id = 1', dialect).valid).toBe(false);
    expect(validateSqlIsSelectOnly('SELECT id FROM t FOR UPDATE', dialect).valid).toBe(false);
  });
});
