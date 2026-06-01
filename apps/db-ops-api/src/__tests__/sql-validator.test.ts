/**
 * SQL validator tests (Phase 106-01)
 *
 * Verifies validateSqlIsSelectOnly correctly whitelists SELECT
 * and rejects all non-SELECT DML/DDL statements.
 */
import { describe, it, expect } from 'vitest';
import { validateSqlIsSelectOnly } from '../sql-validator';

describe('validateSqlIsSelectOnly', () => {
  it('allows simple SELECT', () => {
    const result = validateSqlIsSelectOnly('SELECT 1');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('allows SELECT with FROM clause', () => {
    const result = validateSqlIsSelectOnly('SELECT * FROM users');
    expect(result.valid).toBe(true);
  });

  it('rejects DROP TABLE', () => {
    const result = validateSqlIsSelectOnly('DROP TABLE users');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('rejects INSERT', () => {
    const result = validateSqlIsSelectOnly('INSERT INTO t VALUES(1)');
    expect(result.valid).toBe(false);
  });

  it('rejects DELETE', () => {
    const result = validateSqlIsSelectOnly('DELETE FROM t');
    expect(result.valid).toBe(false);
  });

  it('rejects ALTER TABLE', () => {
    const result = validateSqlIsSelectOnly('ALTER TABLE t DROP COLUMN c');
    expect(result.valid).toBe(false);
  });

  it('rejects invalid SQL syntax', () => {
    const result = validateSqlIsSelectOnly('invalid sql !!!');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('rejects UPDATE', () => {
    const result = validateSqlIsSelectOnly('UPDATE users SET name = \'x\'');
    expect(result.valid).toBe(false);
  });

  it('rejects TRUNCATE', () => {
    const result = validateSqlIsSelectOnly('TRUNCATE TABLE users');
    expect(result.valid).toBe(false);
  });

  it('rejects CREATE TABLE', () => {
    const result = validateSqlIsSelectOnly('CREATE TABLE t (id INT)');
    expect(result.valid).toBe(false);
  });

  it('allows SELECT with complex WHERE', () => {
    const result = validateSqlIsSelectOnly("SELECT id, name FROM users WHERE status = 'active' ORDER BY name LIMIT 10");
    expect(result.valid).toBe(true);
  });
});
