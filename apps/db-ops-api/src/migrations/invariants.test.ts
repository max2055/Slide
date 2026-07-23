import { describe, expect, it } from 'vitest';
import { assertSchemaInvariants } from './invariants.js';
import type { MigrationPool } from './types.js';

const columns = {
  users: ['id', 'username', 'password_hash', 'session_version'],
  refresh_tokens: ['id', 'token_hash', 'user_id', 'session_version', 'revoked'],
  approval_requests: ['id', 'status', 'operation_id'],
  operations: ['id', 'actor_id', 'idempotency_key', 'state', 'correlation_id'],
  operation_events: ['id', 'operation_id', 'to_state', 'reason_code'],
  chat_session_shares: ['id', 'session_id', 'granted_by', 'recipient_user_id'],
  llm_providers: ['id', 'name', 'deployment_type', 'api_format'],
  ai_analysis: ['id', 'analysis_type', 'execution_trace', 'analysis_envelope'],
  health_check_history: ['id', 'instance_id', 'health_score', 'status', 'dimensions', 'checks'],
};

describe('assertSchemaInvariants', () => {
  it('rejects an alerts.level enum that cannot persist p0 escalations', async () => {
    const pool: MigrationPool = {
      query: (async (sql: string) => {
        if (sql.includes("TABLE_NAME = 'alerts'")) {
          return [[{ column_type: "enum('info','warning','error','critical')" }]];
        }
        if (sql.includes('information_schema.COLUMNS')) {
          return [Object.entries(columns).flatMap(([table_name, names]) =>
            names.map((column_name) => ({ table_name, column_name })),
          )];
        }
        if (sql.includes('information_schema.STATISTICS')) {
          return [[
            { table_name: 'refresh_tokens', index_name: 'idx_rt_user_session' },
            { table_name: 'operations', index_name: 'uq_operations_actor_idempotency' },
            { table_name: 'operation_events', index_name: 'idx_operation_events_operation_created' },
          ]];
        }
        if (sql.includes('information_schema.REFERENTIAL_CONSTRAINTS')) {
          return [[
            { table_name: 'sql_execution_history', constraint_name: 'fk_sql_history_approval' },
            { table_name: 'approval_requests', constraint_name: 'fk_approval_operation' },
            { table_name: 'operations', constraint_name: 'fk_operation_approval' },
            { table_name: 'operation_events', constraint_name: 'fk_operation_events_operation' },
          ]];
        }
        throw new Error(`Unexpected query: ${sql}`);
      }) as MigrationPool['query'],
      getConnection: async () => { throw new Error('not used'); },
    };

    await expect(assertSchemaInvariants(pool)).rejects.toThrow(
      'alerts.level missing enum value p0',
    );
  });
});
