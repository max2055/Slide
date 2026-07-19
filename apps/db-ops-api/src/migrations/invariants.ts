import type { MigrationPool } from './types.js';

const requiredColumns: Record<string, string[]> = {
  users: ['id', 'username', 'password_hash', 'session_version'],
  refresh_tokens: ['id', 'token_hash', 'user_id', 'session_version', 'revoked'],
  approval_requests: ['id', 'status', 'operation_id'],
  operations: ['id', 'actor_id', 'idempotency_key', 'state', 'correlation_id'],
  operation_events: ['id', 'operation_id', 'to_state', 'reason_code'],
  chat_session_shares: ['id', 'session_id', 'granted_by', 'recipient_user_id'],
  llm_providers: ['id', 'name', 'deployment_type', 'api_format'],
};

const requiredIndexes: Array<[string, string]> = [
  ['refresh_tokens', 'idx_rt_user_session'],
  ['operations', 'uq_operations_actor_idempotency'],
  ['operation_events', 'idx_operation_events_operation_created'],
];

export class SchemaInvariantError extends Error {}

export async function assertSchemaInvariants(pool: MigrationPool): Promise<void> {
  const tables = Object.keys(requiredColumns);
  const placeholders = tables.map(() => '?').join(', ');
  const [columns] = await pool.query<Array<{ table_name: string; column_name: string }>>(
    `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${placeholders})`,
    tables,
  );
  const present = new Set(columns.map((column) => `${column.table_name}.${column.column_name}`));
  const missingColumns = Object.entries(requiredColumns).flatMap(([table, names]) => names
    .filter((name) => !present.has(`${table}.${name}`)).map((name) => `${table}.${name}`));
  const [indexes] = await pool.query<Array<{ table_name: string; index_name: string }>>(
    `SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name
     FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${placeholders})`,
    tables,
  );
  const presentIndexes = new Set(indexes.map((index) => `${index.table_name}.${index.index_name}`));
  const missingIndexes = requiredIndexes.filter(([table, index]) => !presentIndexes.has(`${table}.${index}`)).map(([table, index]) => `${table}.${index}`);
  if (missingColumns.length || missingIndexes.length) {
    throw new SchemaInvariantError(`Schema invariant failed: missing ${[...missingColumns, ...missingIndexes].join(', ')}`);
  }
}
