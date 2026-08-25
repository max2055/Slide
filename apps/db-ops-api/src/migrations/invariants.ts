import type { MigrationPool } from './types.js';

const requiredColumns: Record<string, string[]> = {
  users: ['id', 'username', 'password_hash', 'session_version'],
  refresh_tokens: ['id', 'token_hash', 'user_id', 'session_version', 'revoked'],
  approval_requests: ['id', 'status', 'operation_id'],
  operations: ['id', 'actor_id', 'idempotency_key', 'state', 'correlation_id'],
  operation_events: ['id', 'operation_id', 'to_state', 'reason_code'],
  chat_session_shares: ['id', 'session_id', 'granted_by', 'recipient_user_id'],
  llm_providers: ['id', 'name', 'deployment_type', 'api_format'],
  ai_analysis: ['id', 'analysis_type', 'execution_trace', 'analysis_envelope'],
  health_check_history: ['id', 'instance_id', 'health_score', 'status', 'dimensions', 'checks'],
  agent_tool_approvals: ['id', 'tool_name', 'requester_id', 'binding_hash', 'status', 'scope', 'session_key', 'risk_level', 'max_uses', 'used_count', 'expires_at'],
  agent_tool_audit: ['id', 'phase', 'actor_id', 'agent_id', 'request_id', 'tool_name', 'reason_code'],
  agent_credential_references: ['ref_id', 'owner_id', 'tool_name', 'secret_encrypted', 'status', 'expires_at'],
  agent_security_policies: ['agent_id', 'tool_allowlist', 'skill_allowlist', 'allowed_effects', 'resource_scope', 'version', 'updated_by'],
  agent_security_policy_history: ['id', 'agent_id', 'version', 'policy_json', 'change_note', 'changed_by'],
};

const requiredIndexes: Array<[string, string]> = [
  ['refresh_tokens', 'idx_rt_user_session'],
  ['operations', 'uq_operations_actor_idempotency'],
  ['operation_events', 'idx_operation_events_operation_created'],
  ['agent_tool_approvals', 'idx_agent_tool_approval_pending'],
  ['agent_tool_approvals', 'idx_agent_tool_approval_scope'],
  ['agent_tool_audit', 'idx_agent_tool_audit_request'],
  ['agent_tool_audit', 'idx_agent_tool_audit_agent_created'],
  ['agent_credential_references', 'idx_agent_credential_active'],
  ['agent_security_policy_history', 'uq_agent_security_policy_history_version'],
];

const requiredForeignKeys: Array<[string, string]> = [
  ['sql_execution_history', 'fk_sql_history_approval'],
  ['approval_requests', 'fk_approval_operation'],
  ['operations', 'fk_operation_approval'],
  ['operation_events', 'fk_operation_events_operation'],
  ['agent_tool_approvals', 'fk_agent_tool_approval_requester'],
  ['agent_tool_audit', 'fk_agent_tool_audit_actor'],
  ['agent_credential_references', 'fk_agent_credential_owner'],
  ['agent_security_policies', 'fk_agent_security_policy_updated_by'],
  ['agent_security_policy_history', 'fk_agent_security_policy_history_actor'],
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
  const [foreignKeys] = await pool.query<Array<{ table_name: string; constraint_name: string }>>(
    `SELECT TABLE_NAME AS table_name, CONSTRAINT_NAME AS constraint_name
     FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()`,
  );
  const presentForeignKeys = new Set(foreignKeys.map((key) => `${key.table_name}.${key.constraint_name}`));
  const missingForeignKeys = requiredForeignKeys
    .filter(([table, key]) => !presentForeignKeys.has(`${table}.${key}`))
    .map(([table, key]) => `${table}.${key}`);
  const [alertLevelColumns] = await pool.query<Array<{ column_type: string }>>(
    `SELECT COLUMN_TYPE AS column_type
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alerts' AND COLUMN_NAME = 'level'`,
  );
  const missingEnumValues = alertLevelColumns[0]?.column_type.includes("'p0'")
    ? []
    : ['alerts.level missing enum value p0'];
  const [commentGaps] = await pool.query<Array<{ table_name: string; column_name: string | null }>>(
    `SELECT TABLE_NAME AS table_name, NULL AS column_name
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
       AND TABLE_NAME NOT IN ('llm_providers_backup', 'schema_migrations')
       AND TRIM(COALESCE(TABLE_COMMENT, '')) = ''
     UNION ALL
     SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME NOT IN ('llm_providers_backup', 'schema_migrations')
       AND TRIM(COALESCE(COLUMN_COMMENT, '')) = ''`,
  );
  const missingComments = commentGaps.map((gap) => gap.column_name
    ? `${gap.table_name}.${gap.column_name}`
    : gap.table_name);
  const [sandboxConfigRows] = await pool.query<Array<{ config_value: string; value_type: string }>>(
    `SELECT config_value, value_type FROM system_config
     WHERE config_key = 'agent_sandbox_enabled' LIMIT 1`,
  );
  const missingSandboxDefault = (sandboxConfigRows[0]?.config_value === 'false' || sandboxConfigRows[0]?.config_value === 'true')
    && sandboxConfigRows[0]?.value_type === 'boolean'
    ? []
    : ['agent_sandbox_enabled must exist as a strict boolean'];
  if (missingColumns.length || missingIndexes.length || missingForeignKeys.length || missingEnumValues.length || missingComments.length || missingSandboxDefault.length) {
    throw new SchemaInvariantError(`Schema invariant failed: ${[
      ...[...missingColumns, ...missingIndexes, ...missingForeignKeys].map((item) => `missing ${item}`),
      ...missingEnumValues,
      ...missingComments.map((item) => `missing comment ${item}`),
      ...missingSandboxDefault,
    ].join(', ')}`);
  }
}
