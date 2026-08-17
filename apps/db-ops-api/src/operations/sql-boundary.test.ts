import { describe, expect, it } from 'vitest';
import { classifySql } from '../sql-validator.js';

describe('SQL read-only boundary', () => {
  it.each([
    ['mysql', 'SELECT id FROM users', 'read', 'READ_ONLY'],
    ['postgresql', 'WITH x AS (SELECT 1) SELECT * FROM x', 'read', 'READ_ONLY'],
    ['oracle', 'SELECT 1 FROM DUAL', 'read', 'READ_ONLY'],
    ['dameng', 'SELECT 1 FROM DUAL', 'read', 'READ_ONLY'],
    ['oracle', 'UPDATE users SET username = username', 'write', 'UNCLASSIFIED'],
    ['dameng', 'DROP TABLE users', 'ddl', 'UNCLASSIFIED'],
    ['mysql', 'UPDATE users SET username = username', 'write', 'UNCLASSIFIED'],
    ['mysql', 'CREATE TABLE test (id INT)', 'ddl', 'UNCLASSIFIED'],
    ['mysql', 'BEGIN', 'transaction', 'UNCLASSIFIED'],
    ['mysql', 'SET @x = 1', 'session', 'UNCLASSIFIED'],
    ['mysql', 'SELECT 1; SELECT 2', 'unknown', 'MULTI_STATEMENT'],
    ['mysql', 'SELECT * FROM users FOR UPDATE', 'unknown', 'LOCKING_READ'],
    ['mysql', 'SELECT SLEEP(1)', 'unknown', 'DANGEROUS_FUNCTION'],
    ['postgresql', "SELECT nextval('audit_seq')", 'unknown', 'DANGEROUS_FUNCTION'],
    ['postgresql', "SELECT setval('audit_seq', 1)", 'unknown', 'DANGEROUS_FUNCTION'],
    ['postgresql', 'SELECT pg_terminate_backend(123)', 'unknown', 'DANGEROUS_FUNCTION'],
    ['postgresql', "SELECT dblink_connect('x', 'host=169.254.169.254')", 'unknown', 'DANGEROUS_FUNCTION'],
    ['postgresql', 'SELECT pg_advisory_lock(1)', 'unknown', 'DANGEROUS_FUNCTION'],
    ['postgresql', 'SELECT pg_sleep(1)', 'unknown', 'DANGEROUS_FUNCTION'],
    ['postgresql', 'SELECT unreviewed_extension_function(1)', 'unknown', 'DANGEROUS_FUNCTION'],
  ] as const)('%s classifies %s', (dialect, sql, commandType, reasonCode) => {
    expect(classifySql(sql, dialect)).toMatchObject({ commandType, reasonCode });
  });

  it.each([
    ['mysql', 'SELECT COUNT(*), MAX(id), LOWER(name) FROM users'],
    ['postgresql', "SELECT COUNT(*), COALESCE(name, ''), CURRENT_DATE FROM users"],
    ['oracle', "SELECT COUNT(*), UPPER(name), SYSDATE FROM users"],
    ['dameng', "SELECT COUNT(*), UPPER(name), SYSDATE FROM users"],
  ] as const)('allows explicitly safe functions for %s', (dialect, sql) => {
    expect(classifySql(sql, dialect)).toMatchObject({ commandType: 'read', reasonCode: 'READ_ONLY' });
  });

  it('fails closed for unparseable Oracle and Dameng syntax', () => {
    expect(classifySql('SELECT /*+ malformed', 'oracle')).toMatchObject({ commandType: 'unknown' });
    expect(classifySql('not sql', 'dameng')).toMatchObject({ commandType: 'unknown' });
  });

  it('rejects oversized SQL before invoking the parser', () => {
    expect(classifySql(`SELECT '${'x'.repeat(70_000)}'`, 'postgresql')).toMatchObject({
      commandType: 'unknown',
      reasonCode: 'SQL_TOO_LARGE',
    });
  });

});
