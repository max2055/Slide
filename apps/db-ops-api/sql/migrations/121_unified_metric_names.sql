-- MAX-189: offline deployment only, back up first; atomic rename fails closed on any target collision.
-- Historical migrations and JSON evidence are immutable. The existing migration lock serializes upgrades.
RENAME TABLE
  metric_v2_observations TO metric_observations,
  metric_v2_attempts TO metric_attempts,
  metric_v2_inventory TO metric_inventory,
  metric_v2_policy_lock TO metric_policy_lock,
  metric_v2_policy_groups TO metric_policy_groups,
  metric_v2_policy_bindings TO metric_policy_bindings,
  metric_v2_policy_audit TO metric_policy_audit,
  metric_v2_schedule TO metric_schedule,
  metric_v2_schedule_events TO metric_schedule_events,
  metric_v2_rollout TO metric_rollout,
  metric_v2_publications TO metric_publications,
  metric_v2_alert_state TO metric_alert_state,
  metric_v2_alert_transitions TO metric_alert_transitions,
  metric_v2_rollout_resources TO metric_rollout_resources,
  metric_v2_rollout_events TO metric_rollout_events,
  metric_v2_retention_state TO metric_retention_state;
ALTER TABLE metric_observations RENAME INDEX idx_metric_v2_latest TO idx_metric_latest;
ALTER TABLE metric_observations RENAME INDEX idx_metric_v2_range TO idx_metric_range;
ALTER TABLE metric_observations RENAME INDEX idx_metric_v2_retention TO idx_metric_retention;
ALTER TABLE metric_observations RENAME INDEX idx_metric_v2_evidence TO idx_metric_evidence;
ALTER TABLE metric_attempts RENAME INDEX idx_metric_v2_attempt_retention TO idx_metric_attempt_retention;
ALTER TABLE metric_policy_bindings RENAME INDEX idx_metric_v2_policy_group TO idx_metric_policy_group;
ALTER TABLE metric_policy_audit RENAME INDEX idx_metric_v2_policy_audit_target TO idx_metric_policy_audit_target;
ALTER TABLE metric_policy_bindings DROP FOREIGN KEY fk_metric_v2_policy_group, ADD CONSTRAINT fk_metric_policy_group FOREIGN KEY (group_id) REFERENCES metric_policy_groups(id);
