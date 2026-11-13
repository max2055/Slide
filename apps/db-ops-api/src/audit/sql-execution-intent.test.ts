import { describe, expect, it } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { SqlExecutionIntentStore, sqlIntentEnumAccepts } from './sql-execution-intent.js';

const legacy = "enum('unknown','succeeded','reconciled_applied','reconciled_not_applied')";
const current = `${legacy.slice(0, -1)},'rolled_back','not_executed')`;

describe('sql intent enum gate', () => {
  it('rejects receipt states the legacy column cannot store', () => {
    expect(sqlIntentEnumAccepts(legacy, 'rolled_back')).toBe(false);
    expect(sqlIntentEnumAccepts(legacy, 'not_executed')).toBe(false);
    expect(sqlIntentEnumAccepts(legacy, 'unknown')).toBe(true);
    expect(sqlIntentEnumAccepts(legacy, 'succeeded')).toBe(true);
  });

  it('accepts receipt states after migration 154', () => {
    expect(sqlIntentEnumAccepts(current, 'rolled_back')).toBe(true);
    expect(sqlIntentEnumAccepts(current, 'not_executed')).toBe(true);
    expect(sqlIntentEnumAccepts(current, 'reconciled_not_applied')).toBe(true);
  });

  it('does not treat a prefix, escaped member, or non-enum type as support', () => {
    expect(sqlIntentEnumAccepts(legacy, 'reconciled')).toBe(false);
    expect(sqlIntentEnumAccepts("enum('rolled_back_later','unknown')", 'rolled_back')).toBe(false);
    expect(sqlIntentEnumAccepts("enum('it''s','rolled_back')", 'rolled_back')).toBe(true);
    expect(sqlIntentEnumAccepts("enum('it''s')", "it's")).toBe(true);
    expect(sqlIntentEnumAccepts('', 'unknown')).toBe(false);
    expect(sqlIntentEnumAccepts('varchar(32)', 'unknown')).toBe(false);
  });
});

function recordingPool(columnType: string, storedState = 'rolled_back') {
  const sql: string[] = [];
  const connection = {
    async query(statement: string) {
      sql.push(statement);
      return [[{ column_type: columnType }]];
    },
    async execute(statement: string) {
      sql.push(statement);
      if (statement.startsWith('SELECT')) return [[{ state: storedState }]];
      return [{ affectedRows: 1 }];
    },
    async beginTransaction() { sql.push('BEGIN'); },
    async commit() { sql.push('COMMIT'); },
    async rollback() { sql.push('ROLLBACK'); },
    release() { sql.push('RELEASE'); },
  };
  return { sql, pool: { getConnection: async () => connection } as unknown as Pool };
}

describe('sql intent finish refuses an unsupported receipt before writing', () => {
  it('does not open a transaction when the legacy enum lacks the receipt', async () => {
    const recorded = recordingPool(legacy);
    const store = new SqlExecutionIntentStore(() => recorded.pool);
    await expect(store.finish('op', 'rolled_back', { receipt: 'rolled_back' })).rejects.toThrow('SQL_INTENT_STATE_UNSUPPORTED');
    await expect(store.finish('op', 'not_executed', { receipt: 'not_executed' })).rejects.toThrow('SQL_INTENT_STATE_UNSUPPORTED');
    expect(recorded.sql.some((statement) => statement.startsWith('UPDATE') || statement === 'BEGIN')).toBe(false);
  });

  it('commits a supported receipt only after the stored state matches', async () => {
    const recorded = recordingPool(current, 'rolled_back');
    const store = new SqlExecutionIntentStore(() => recorded.pool);
    await store.finish('op', 'rolled_back', { receipt: 'rolled_back' });
    expect(recorded.sql).toContain('BEGIN');
    expect(recorded.sql.some((statement) => statement.startsWith('UPDATE'))).toBe(true);
    expect(recorded.sql.at(-2)).toBe('COMMIT');
    expect(recorded.sql).not.toContain('ROLLBACK');
  });

  it('rolls back when the stored value is not the requested receipt', async () => {
    const recorded = recordingPool(current, '');
    const store = new SqlExecutionIntentStore(() => recorded.pool);
    await expect(store.finish('op', 'rolled_back', { receipt: 'rolled_back' })).rejects.toThrow('SQL_INTENT_STATE_UNSUPPORTED');
    expect(recorded.sql).toContain('ROLLBACK');
    expect(recorded.sql).not.toContain('COMMIT');
  });
});
