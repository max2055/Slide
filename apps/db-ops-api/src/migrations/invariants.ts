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

const networkRequiredColumns: Record<string, string[]> = {
  network_devices: ['id', 'name', 'host', 'vendor', 'snmp_port', 'ssh_port', 'status', 'collection_enabled'],
  network_device_credentials: ['id', 'device_id', 'protocol', 'username'],
  network_device_interfaces: ['id', 'device_id', 'if_index', 'if_name', 'admin_status', 'oper_status'],
  network_device_observations: ['id', 'device_id', 'metric_id', 'metric_value', 'observed_at', 'quality', 'source'],
  network_device_config_backups: ['id', 'device_id', 'version_no', 'content_encrypted', 'content_sha256', 'source_protocol', 'size_bytes'],
};

const networkTargetColumns: Record<string, string[]> = {
  resource_relations: ['source_type', 'target_type', 'relation_type'],
  resource_capabilities: ['resource_type'],
  alert_rules: ['target_type', 'network_device_id'],
  alert_rule_templates: ['target_type'],
  metric_definitions: ['target_type'],
  alerts: ['target_type', 'network_device_id'],
  alert_events: ['target_type', 'network_device_id'],
  ai_analysis: ['target_type', 'network_device_id'],
  reports: ['network_device_id'],
  report_configs: ['network_device_id'],
};

const networkRequiredIndexes: Array<[string, string]> = [
  ['network_devices', 'uq_network_device_host_snmp'],
  ['network_device_credentials', 'uq_network_device_credential_protocol'],
  ['network_device_interfaces', 'uq_network_device_interface'],
  ['network_device_observations', 'idx_network_device_observation_latest'],
  ['network_device_config_backups', 'uq_network_device_backup_version'],
  ['network_device_config_backups', 'uq_network_device_backup_hash'],
  ['alert_rules', 'idx_alert_rule_network_device'],
  ['alerts', 'idx_alert_network_device'],
  ['alert_events', 'idx_alert_event_network_device'],
  ['ai_analysis', 'idx_ai_analysis_network_device'],
  ['reports', 'idx_report_network_device_id'],
  ['report_configs', 'idx_report_config_network_device_id'],
];

const networkRequiredForeignKeys: Array<[string, string]> = [
  ['network_device_credentials', 'fk_network_device_credentials_device'],
  ['network_device_interfaces', 'fk_network_device_interfaces_device'],
  ['network_device_observations', 'fk_network_device_observations_device'],
  ['network_device_config_backups', 'fk_network_device_config_backups_device'],
  ['network_device_config_backups', 'fk_network_device_config_backups_creator'],
  ['alert_rules', 'fk_alert_rule_network_device'],
  ['alerts', 'fk_alert_network_device'],
  ['alert_events', 'fk_alert_event_network_device'],
  ['ai_analysis', 'fk_ai_analysis_network_device'],
  ['reports', 'fk_report_network_device'],
  ['report_configs', 'fk_report_config_network_device'],
];

export class SchemaInvariantError extends Error {}

export async function assertSchemaInvariants(pool: MigrationPool): Promise<void> {
  const tables = Object.keys(requiredColumns);
  const inspectedTables = [...new Set([
    ...tables,
    ...Object.keys(networkRequiredColumns),
    ...Object.keys(networkTargetColumns),
  ])];
  const placeholders = inspectedTables.map(() => '?').join(', ');
  const [columns] = await pool.query<Array<{ table_name: string; column_name: string }>>(
    `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${placeholders})`,
    inspectedTables,
  );
  const present = new Set(columns.map((column) => `${column.table_name}.${column.column_name}`));
  const missingColumns = Object.entries(requiredColumns).flatMap(([table, names]) => names
    .filter((name) => !present.has(`${table}.${name}`)).map((name) => `${table}.${name}`));
  // Network-device objects are introduced by migration 070. Keep the legacy
  // test/fallback schema valid before that migration, but enforce the complete
  // contract as soon as the anchor table exists.
  const networkInstalled = columns.some((column) => column.table_name === 'network_devices');
  const networkMissingColumns = networkInstalled
    ? Object.entries(networkRequiredColumns).flatMap(([table, names]) => names
      .filter((name) => !present.has(`${table}.${name}`)).map((name) => `${table}.${name}`))
    : [];
  const networkTargetMissingColumns = networkInstalled
    ? Object.entries(networkTargetColumns).flatMap(([table, names]) => names
      .filter((name) => !present.has(`${table}.${name}`)).map((name) => `${table}.${name}`))
    : [];
  const [indexes] = await pool.query<Array<{ table_name: string; index_name: string }>>(
    `SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name
     FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${placeholders})`,
    inspectedTables,
  );
  const presentIndexes = new Set(indexes.map((index) => `${index.table_name}.${index.index_name}`));
  const missingIndexes = requiredIndexes.filter(([table, index]) => !presentIndexes.has(`${table}.${index}`)).map(([table, index]) => `${table}.${index}`);
  const networkMissingIndexes = networkInstalled
    ? networkRequiredIndexes.filter(([table, index]) => !presentIndexes.has(`${table}.${index}`)).map(([table, index]) => `${table}.${index}`)
    : [];
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
  const networkMissingForeignKeys = networkInstalled
    ? networkRequiredForeignKeys.filter(([table, key]) => !presentForeignKeys.has(`${table}.${key}`)).map(([table, key]) => `${table}.${key}`)
    : [];
  const networkEnumGaps: string[] = [];
  if (networkInstalled) {
    const enumTargets = [
      ['resource_relations', 'source_type'], ['resource_relations', 'target_type'], ['resource_relations', 'relation_type'],
      ['resource_capabilities', 'resource_type'], ['alert_rules', 'target_type'], ['alert_rule_templates', 'target_type'],
      ['metric_definitions', 'target_type'], ['alerts', 'target_type'], ['alert_events', 'target_type'],
      ['ai_analysis', 'target_type'],
    ];
    const enumPlaceholders = enumTargets.map(() => '(?, ?)').join(', ');
    const enumValues = enumTargets.flat();
    const [enumRows] = await pool.query<Array<{ table_name: string; column_name: string; column_type: string }>>(
      `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, COLUMN_TYPE AS column_type
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND (TABLE_NAME, COLUMN_NAME) IN (${enumPlaceholders})`, enumValues,
    );
    const enumMap = new Map(enumRows.map((row) => [`${row.table_name}.${row.column_name}`, row.column_type]));
    const requiredEnumValues: Record<string, string[]> = {
      'resource_relations.source_type': ['network_device'],
      'resource_relations.target_type': ['network_device'],
      'resource_relations.relation_type': ['connected_to', 'serves'],
      'resource_capabilities.resource_type': ['network_device'],
      'alert_rules.target_type': ['network_device'],
      'alert_rule_templates.target_type': ['network_device'],
      'metric_definitions.target_type': ['network_device'],
      'alerts.target_type': ['network_device'],
      'alert_events.target_type': ['network_device'],
      'ai_analysis.target_type': ['network_device'],
    };
    for (const [key, values] of Object.entries(requiredEnumValues)) {
      const type = enumMap.get(key) ?? '';
      for (const value of values) if (!type.includes(`'${value}'`)) networkEnumGaps.push(`${key} missing enum value ${value}`);
    }
  }
  if (missingColumns.length || networkMissingColumns.length || networkTargetMissingColumns.length || missingIndexes.length || networkMissingIndexes.length || missingForeignKeys.length || networkMissingForeignKeys.length || networkEnumGaps.length || missingEnumValues.length || missingComments.length || missingSandboxDefault.length) {
    throw new SchemaInvariantError(`Schema invariant failed: ${[
      ...[...missingColumns, ...networkMissingColumns, ...networkTargetMissingColumns, ...missingIndexes, ...networkMissingIndexes, ...missingForeignKeys, ...networkMissingForeignKeys].map((item) => `missing ${item}`),
      ...networkEnumGaps,
      ...missingEnumValues,
      ...missingComments.map((item) => `missing comment ${item}`),
      ...missingSandboxDefault,
    ].join(', ')}`);
  }
}
