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
  ] as const)('%s classifies %s', (dialect, sql, commandType, reasonCode) => {
    expect(classifySql(sql, dialect)).toMatchObject({ commandType, reasonCode });
  });

  it('fails closed for unparseable Oracle and Dameng syntax', () => {
    expect(classifySql('SELECT /*+ malformed', 'oracle')).toMatchObject({ commandType: 'unknown' });
    expect(classifySql('not sql', 'dameng')).toMatchObject({ commandType: 'unknown' });
  });

});
