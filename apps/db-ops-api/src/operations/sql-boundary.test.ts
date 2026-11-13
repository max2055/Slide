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

  it.each([
    ['SELECT * FROM t LOCK IN SHARE MODE', 'LOCKING_READ'],
    ['select * from t lock in share mode', 'LOCKING_READ'],
    ['SELECT * FROM t LOCK\nIN\tSHARE MODE', 'LOCKING_READ'],
    ['SELECT * FROM t LOCK/**/IN/**/SHARE/**/MODE', 'LOCKING_READ'],
    ['SELECT * FROM t LOCK IN SHARE MODE NOWAIT', 'LOCKING_READ'],
    ['SELECT * FROM t FOR SHARE', 'LOCKING_READ'],
    ['SELECT * FROM t FOR/**/UPDATE', 'LOCKING_READ'],
    ['SELECT * FROM t FOR UPDATE NOWAIT', 'LOCKING_READ'],
    ['SELECT * FROM t FOR UPDATE OF t SKIP LOCKED', 'LOCKING_READ'],
    ['SELECT * FROM (SELECT id FROM t FOR UPDATE) nested', 'LOCKING_READ'],
    ["SELECT 1 /*! LOCK IN SHARE MODE */", 'LOCKING_READ'],
    ["SELECT 1 /*!50110 FOR UPDATE */", 'LOCKING_READ'],
    ["SELECT 1 /*!99999 LOCK IN SHARE MODE */", 'LOCKING_READ'],
    ["SELECT 1 /*! INTO OUTFILE '/tmp/x' */", 'SELECT_INTO'],
    ["SELECT 1 /*!50110 INTO DUMPFILE '/tmp/x' */", 'SELECT_INTO'],
    ['SELECT 1 INTO/**/OUTFILE \'/tmp/x\'', 'SELECT_INTO'],
    ['SELECT id INTO @bucket FROM t', 'SELECT_INTO'],
    ['SELECT SLEEP(1)', 'DANGEROUS_FUNCTION'],
    ["SELECT 1 /*! SLEEP(1) */", 'DANGEROUS_FUNCTION'],
    ['SELECT BENCHMARK(1, 1)', 'DANGEROUS_FUNCTION'],
    ["SELECT 1 /*!; DROP TABLE t */", 'MULTI_STATEMENT'],
    ["SELECT 'a\\' , SLEEP(0) AS executed -- '", 'DANGEROUS_FUNCTION'],
    ["SELECT 'a\\' FROM t FOR UPDATE -- '", 'LOCKING_READ'],
    ["SELECT 'a\\' FROM t LOCK IN SHARE MODE -- '", 'LOCKING_READ'],
    ["SELECT 'a\\' INTO OUTFILE '/tmp/x' -- '", 'SELECT_INTO'],
    ["SELECT 'a\\' FROM t /*!50110 FOR UPDATE */ -- '", 'LOCKING_READ'],
    ["SELECT 'a\\' /*! , SLEEP(0) AS executed */ -- '", 'DANGEROUS_FUNCTION'],
    ["SELECT 'a\\', SLEEP(0)", 'DANGEROUS_FUNCTION'],
    ['SELECT "a\\" , SLEEP(0) AS executed -- "', 'DANGEROUS_FUNCTION'],
    ['SELECT "a\\" FROM t FOR UPDATE -- "', 'LOCKING_READ'],
    ["SELECT 'a\\' , `SLEEP`(0) AS executed -- '", 'DANGEROUS_FUNCTION'],
    ["SELECT 'a\\' , `UUID`() AS executed -- '", 'DANGEROUS_FUNCTION'],
    ["SELECT 'a\\' , UUID() AS executed -- '", 'DANGEROUS_FUNCTION'],
    ["SELECT 'a\\' , CONNECTION_ID() AS executed -- '", 'DANGEROUS_FUNCTION'],
    ["SELECT 'a\\' , not_a_real_function(0) AS executed -- '", 'DANGEROUS_FUNCTION'],
    ["SELECT 'a\\' , UUID() AS executed # '", 'DANGEROUS_FUNCTION'],
    ["SELECT 'a\\' , /* mode */ CONNECTION_ID() AS executed -- '", 'DANGEROUS_FUNCTION'],
    ["SELECT 'a\\' /*! , `SLEEP`(0) */ -- '", 'DANGEROUS_FUNCTION'],
    ["SELECT 'a\\' , BENCHMARK(1, 1) /* ' */", 'DANGEROUS_FUNCTION'],
  ] as const)('rejects MySQL read bypass %s', (sql, reasonCode) => {
    expect(classifySql(sql, 'mysql')).toMatchObject({ commandType: 'unknown', reasonCode });
  });

  it.each([
    ["SELECT msg FROM t WHERE msg = 'please for update now'"],
    ["SELECT msg FROM t WHERE msg LIKE '%into%'"],
    ["SELECT msg FROM t WHERE msg = 'sleep('"],
    ["SELECT msg FROM t WHERE msg = 'lock in share mode'"],
    ["SELECT msg FROM t WHERE msg = '/*! INTO OUTFILE \"/tmp/x\" */'"],
    ["SELECT msg FROM t WHERE msg = 'it\\'s for update now'"],
    ['SELECT msg FROM t WHERE msg = "for update"'],
    ['SELECT `for update` FROM t'],
    ['SELECT 1 /* FOR UPDATE */'],
    ['SELECT 1 /*+ FOR UPDATE */'],
    ['SELECT 1 -- FOR UPDATE\n'],
    ['SELECT 1 # LOCK IN SHARE MODE\n'],
    ['SELECT 1 /*! + 1 */'],
    ["SELECT 'a\\\\', 1 AS n -- '"],
    ["SELECT 'a\\', 1 AS still_text'"],
    ['SELECT `uuid` FROM t'],
    ['SELECT `sleep` FROM t'],
    ["SELECT msg FROM t WHERE msg = 'uuid()'"],
    ["SELECT msg FROM t WHERE msg = '`SLEEP`(0)'"],
  ] as const)('keeps ordinary MySQL text read-only: %s', (sql) => {
    expect(classifySql(sql, 'mysql')).toMatchObject({ commandType: 'read', reasonCode: 'READ_ONLY' });
  });

  it('does not treat MySQL dollar text as a readable literal', () => {
    expect(classifySql('SELECT $$sleep(0)$$', 'mysql')).toMatchObject({ commandType: 'unknown', reasonCode: 'UNCLASSIFIED' });
  });

  it('does not treat a MySQL executable comment as executable on PostgreSQL', () => {
    expect(classifySql('SELECT 1 /*! FOR UPDATE */', 'postgresql')).toMatchObject({
      commandType: 'read',
      reasonCode: 'READ_ONLY',
    });
    expect(classifySql("SELECT $body$ for update $body$", 'postgresql')).toMatchObject({
      commandType: 'read',
      reasonCode: 'READ_ONLY',
    });
  });

});
