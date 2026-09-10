import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { assertSchemaInvariants } from './invariants.js';
import type { MigrationPool } from './types.js';

const columns = {
  agent_evidence: ['id', 'owner_user_id', 'resource_type', 'resource_id', 'correlation_id', 'evidence_json', 'observed_at', 'valid_until'],
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
            { table_name: 'agent_tool_approvals', index_name: 'idx_agent_tool_approval_scope' },
            { table_name: 'agent_tool_audit', index_name: 'idx_agent_tool_audit_request' },
            { table_name: 'agent_tool_audit', index_name: 'idx_agent_tool_audit_agent_created' },
            { table_name: 'agent_credential_references', index_name: 'idx_agent_credential_active' },
            { table_name: 'agent_security_policy_history', index_name: 'uq_agent_security_policy_history_version' },
            { table_name: 'agent_evidence', index_name: 'idx_agent_evidence_resource_time' },
            { table_name: 'agent_evidence', index_name: 'idx_agent_evidence_correlation' },
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
            { table_name: 'agent_evidence', constraint_name: 'fk_agent_evidence_owner' },
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
          { table_name: 'agent_tool_approvals', index_name: 'idx_agent_tool_approval_scope' },
          { table_name: 'agent_tool_audit', index_name: 'idx_agent_tool_audit_request' },
          { table_name: 'agent_tool_audit', index_name: 'idx_agent_tool_audit_agent_created' },
          { table_name: 'agent_credential_references', index_name: 'idx_agent_credential_active' },
          { table_name: 'agent_security_policy_history', index_name: 'uq_agent_security_policy_history_version' },
          { table_name: 'agent_evidence', index_name: 'idx_agent_evidence_resource_time' },
          { table_name: 'agent_evidence', index_name: 'idx_agent_evidence_correlation' },
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
          { table_name: 'agent_evidence', constraint_name: 'fk_agent_evidence_owner' },
        ]];
        throw new Error(`Unexpected query: ${sql}`);
      }) as MigrationPool['query'],
      getConnection: async () => { throw new Error('not used'); },
    };

    await expect(assertSchemaInvariants(pool)).rejects.toThrow('agent_sandbox_enabled must exist as a strict boolean');
  });

  it('inspects network tables and rejects a missing network index', async () => {
    const legacyColumns = Object.entries(columns).flatMap(([table_name, names]) =>
      names.map((column_name) => ({ table_name, column_name })),
    );
    const networkColumnNames: Record<string, string[]> = {
      network_devices: ['id', 'name', 'host', 'vendor', 'snmp_port', 'ssh_port', 'status', 'collection_enabled'],
      network_device_credentials: ['id', 'device_id', 'protocol', 'username'],
      network_device_interfaces: ['id', 'device_id', 'if_index', 'if_name', 'admin_status', 'oper_status'],
      network_device_observations: ['id', 'device_id', 'metric_id', 'metric_value', 'observed_at', 'quality', 'source'],
      network_device_config_backups: ['id', 'device_id', 'version_no', 'content_encrypted', 'content_sha256', 'source_protocol', 'size_bytes'],
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
    const networkColumns = Object.entries(networkColumnNames).flatMap(([table_name, names]) =>
      names.map((column_name) => ({ table_name, column_name })),
    );
    const indexes = [
      { table_name: 'refresh_tokens', index_name: 'idx_rt_user_session' },
      { table_name: 'operations', index_name: 'uq_operations_actor_idempotency' },
      { table_name: 'operation_events', index_name: 'idx_operation_events_operation_created' },
      { table_name: 'agent_tool_approvals', index_name: 'idx_agent_tool_approval_pending' },
      { table_name: 'agent_tool_approvals', index_name: 'idx_agent_tool_approval_scope' },
      { table_name: 'agent_tool_audit', index_name: 'idx_agent_tool_audit_request' },
      { table_name: 'agent_tool_audit', index_name: 'idx_agent_tool_audit_agent_created' },
      { table_name: 'agent_credential_references', index_name: 'idx_agent_credential_active' },
      { table_name: 'agent_security_policy_history', index_name: 'uq_agent_security_policy_history_version' },
      { table_name: 'agent_evidence', index_name: 'idx_agent_evidence_resource_time' },
      { table_name: 'agent_evidence', index_name: 'idx_agent_evidence_correlation' },
      { table_name: 'network_devices', index_name: 'uq_network_device_host_snmp' },
      { table_name: 'network_device_credentials', index_name: 'uq_network_device_credential_protocol' },
      { table_name: 'network_device_interfaces', index_name: 'uq_network_device_interface' },
      { table_name: 'network_device_observations', index_name: 'idx_network_device_observation_latest' },
      { table_name: 'network_device_config_backups', index_name: 'uq_network_device_backup_version' },
      { table_name: 'network_device_config_backups', index_name: 'uq_network_device_backup_hash' },
      { table_name: 'alert_rules', index_name: 'idx_alert_rule_network_device' },
      { table_name: 'alerts', index_name: 'idx_alert_network_device' },
      { table_name: 'alert_events', index_name: 'idx_alert_event_network_device' },
      { table_name: 'ai_analysis', index_name: 'idx_ai_analysis_network_device' },
      { table_name: 'reports', index_name: 'idx_report_network_device_id' },
      { table_name: 'report_configs', index_name: 'idx_report_config_network_device_id' },
    ].filter((entry) => entry.index_name !== 'idx_network_device_observation_latest');
    const foreignKeys = [
      ['sql_execution_history', 'fk_sql_history_approval'], ['approval_requests', 'fk_approval_operation'],
      ['operations', 'fk_operation_approval'], ['operation_events', 'fk_operation_events_operation'],
      ['agent_tool_approvals', 'fk_agent_tool_approval_requester'], ['agent_tool_audit', 'fk_agent_tool_audit_actor'],
      ['agent_credential_references', 'fk_agent_credential_owner'], ['agent_security_policies', 'fk_agent_security_policy_updated_by'],
      ['agent_security_policy_history', 'fk_agent_security_policy_history_actor'],
      ['agent_evidence', 'fk_agent_evidence_owner'],
      ['network_device_credentials', 'fk_network_device_credentials_device'],
      ['network_device_interfaces', 'fk_network_device_interfaces_device'],
      ['network_device_observations', 'fk_network_device_observations_device'],
      ['network_device_config_backups', 'fk_network_device_config_backups_device'],
      ['network_device_config_backups', 'fk_network_device_config_backups_creator'],
      ['alert_rules', 'fk_alert_rule_network_device'], ['alerts', 'fk_alert_network_device'],
      ['alert_events', 'fk_alert_event_network_device'], ['ai_analysis', 'fk_ai_analysis_network_device'],
      ['reports', 'fk_report_network_device'], ['report_configs', 'fk_report_config_network_device'],
    ].map(([table_name, constraint_name]) => ({ table_name, constraint_name }));
    const enumTypes: Record<string, string> = {
      'resource_relations.source_type': "enum('instance','server','network_device')",
      'resource_relations.target_type': "enum('instance','server','network_device')",
      'resource_relations.relation_type': "enum('runs_on','hosts','replicates_to','depends_on','connected_to','serves')",
      'resource_capabilities.resource_type': "enum('instance','server','network_device')",
      'alert_rules.target_type': "enum('instance','server','network_device')",
      'alert_rule_templates.target_type': "enum('instance','server','network_device')",
      'metric_definitions.target_type': "enum('instance','server','network_device')",
      'alerts.target_type': "enum('instance','server','network_device')",
      'alert_events.target_type': "enum('instance','server','network_device')",
      'ai_analysis.target_type': "enum('instance','server','network_device')",
    };
    const pool: MigrationPool = {
      query: (async (sql: string) => {
        if (sql.includes("config_key = 'agent_sandbox_enabled'")) return [[{ config_value: 'false', value_type: 'boolean' }]];
        if (sql.includes("TABLE_NAME = 'alerts'")) return [[{ column_type: "enum('info','warning','error','critical','p0')" }]];
        if (sql.includes('COLUMN_TYPE') && sql.includes('TABLE_NAME, COLUMN_NAME')) {
          return [Object.entries(enumTypes).map(([key, column_type]) => {
            const [table_name, column_name] = key.split('.');
            return { table_name, column_name, column_type };
          })];
        }
        if (sql.includes('COLUMN_COMMENT')) return [[]];
        if (sql.includes('information_schema.COLUMNS')) return [legacyColumns.concat(networkColumns)];
        if (sql.includes('information_schema.STATISTICS')) return [indexes];
        if (sql.includes('information_schema.REFERENTIAL_CONSTRAINTS')) return [foreignKeys];
        throw new Error(`Unexpected query: ${sql}`);
      }) as MigrationPool['query'],
      getConnection: async () => { throw new Error('not used'); },
    };

    await expect(assertSchemaInvariants(pool)).rejects.toThrow('missing network_device_observations.idx_network_device_observation_latest');
  });
});
