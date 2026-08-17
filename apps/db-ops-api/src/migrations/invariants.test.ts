import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
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
  agent_tool_approvals: ['id', 'tool_name', 'requester_id', 'binding_hash', 'status', 'expires_at'],
  agent_tool_audit: ['id', 'phase', 'actor_id', 'agent_id', 'request_id', 'tool_name', 'reason_code'],
  agent_credential_references: ['ref_id', 'owner_id', 'tool_name', 'secret_encrypted', 'status', 'expires_at'],
  agent_security_policies: ['agent_id', 'tool_allowlist', 'skill_allowlist', 'allowed_effects', 'resource_scope', 'version', 'updated_by'],
  agent_security_policy_history: ['id', 'agent_id', 'version', 'policy_json', 'change_note', 'changed_by'],
};

describe('assertSchemaInvariants', () => {
  it('seeds the explicit Agent code execution permission in the sandbox migration', async () => {
    const sql = await readFile(new URL('../../sql/migrations/059_agent_sandbox_global_config.sql', import.meta.url), 'utf8');
    expect(sql).toContain("'ai:execute'");
    expect(sql).toContain('INSERT IGNORE INTO `permissions`');
  });

  it('rejects an alerts.level enum that cannot persist p0 escalations', async () => {
    const pool: MigrationPool = {
      query: (async (sql: string) => {
        if (sql.includes("config_key = 'agent_sandbox_enabled'")) {
          return [[{ config_value: 'false', value_type: 'boolean' }]];
        }
        if (sql.includes("TABLE_NAME = 'alerts'")) {
          return [[{ column_type: "enum('info','warning','error','critical')" }]];
        }
        if (sql.includes('COLUMN_COMMENT')) {
          return [[]];
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
            { table_name: 'agent_tool_approvals', index_name: 'idx_agent_tool_approval_pending' },
            { table_name: 'agent_tool_audit', index_name: 'idx_agent_tool_audit_request' },
            { table_name: 'agent_tool_audit', index_name: 'idx_agent_tool_audit_agent_created' },
            { table_name: 'agent_credential_references', index_name: 'idx_agent_credential_active' },
            { table_name: 'agent_security_policy_history', index_name: 'uq_agent_security_policy_history_version' },
          ]];
        }
        if (sql.includes('information_schema.REFERENTIAL_CONSTRAINTS')) {
          return [[
            { table_name: 'sql_execution_history', constraint_name: 'fk_sql_history_approval' },
            { table_name: 'approval_requests', constraint_name: 'fk_approval_operation' },
            { table_name: 'operations', constraint_name: 'fk_operation_approval' },
            { table_name: 'operation_events', constraint_name: 'fk_operation_events_operation' },
            { table_name: 'agent_tool_approvals', constraint_name: 'fk_agent_tool_approval_requester' },
            { table_name: 'agent_tool_audit', constraint_name: 'fk_agent_tool_audit_actor' },
            { table_name: 'agent_credential_references', constraint_name: 'fk_agent_credential_owner' },
            { table_name: 'agent_security_policies', constraint_name: 'fk_agent_security_policy_updated_by' },
            { table_name: 'agent_security_policy_history', constraint_name: 'fk_agent_security_policy_history_actor' },
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

  it('rejects a missing Agent sandbox setting', async () => {
    const pool: MigrationPool = {
      query: (async (sql: string) => {
        if (sql.includes("config_key = 'agent_sandbox_enabled'")) return [[]];
        if (sql.includes("TABLE_NAME = 'alerts'")) return [[{ column_type: "enum('info','warning','error','critical','p0')" }]];
        if (sql.includes('COLUMN_COMMENT')) return [[]];
        if (sql.includes('information_schema.COLUMNS')) {
          return [Object.entries(columns).flatMap(([table_name, names]) =>
            names.map((column_name) => ({ table_name, column_name })),
          )];
        }
        if (sql.includes('information_schema.STATISTICS')) return [[
          { table_name: 'refresh_tokens', index_name: 'idx_rt_user_session' },
          { table_name: 'operations', index_name: 'uq_operations_actor_idempotency' },
          { table_name: 'operation_events', index_name: 'idx_operation_events_operation_created' },
          { table_name: 'agent_tool_approvals', index_name: 'idx_agent_tool_approval_pending' },
          { table_name: 'agent_tool_audit', index_name: 'idx_agent_tool_audit_request' },
          { table_name: 'agent_tool_audit', index_name: 'idx_agent_tool_audit_agent_created' },
          { table_name: 'agent_credential_references', index_name: 'idx_agent_credential_active' },
          { table_name: 'agent_security_policy_history', index_name: 'uq_agent_security_policy_history_version' },
        ]];
        if (sql.includes('information_schema.REFERENTIAL_CONSTRAINTS')) return [[
          { table_name: 'sql_execution_history', constraint_name: 'fk_sql_history_approval' },
          { table_name: 'approval_requests', constraint_name: 'fk_approval_operation' },
          { table_name: 'operations', constraint_name: 'fk_operation_approval' },
          { table_name: 'operation_events', constraint_name: 'fk_operation_events_operation' },
          { table_name: 'agent_tool_approvals', constraint_name: 'fk_agent_tool_approval_requester' },
          { table_name: 'agent_tool_audit', constraint_name: 'fk_agent_tool_audit_actor' },
          { table_name: 'agent_credential_references', constraint_name: 'fk_agent_credential_owner' },
          { table_name: 'agent_security_policies', constraint_name: 'fk_agent_security_policy_updated_by' },
          { table_name: 'agent_security_policy_history', constraint_name: 'fk_agent_security_policy_history_actor' },
        ]];
        throw new Error(`Unexpected query: ${sql}`);
      }) as MigrationPool['query'],
      getConnection: async () => { throw new Error('not used'); },
    };

    await expect(assertSchemaInvariants(pool)).rejects.toThrow('agent_sandbox_enabled must exist as a strict boolean');
  });
});
