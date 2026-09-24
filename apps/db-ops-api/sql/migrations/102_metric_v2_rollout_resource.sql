ALTER TABLE metric_v2_rollout
  ADD COLUMN resource_type VARCHAR(32) NULL COMMENT 'server-owned resource identity for scheduling',
  ADD COLUMN resource_id VARCHAR(128) NULL COMMENT 'server-owned resource identifier',
  ADD INDEX idx_metric_rollout_resource (resource_type, resource_id);

UPDATE metric_v2_rollout SET
  resource_type = JSON_UNQUOTE(JSON_EXTRACT(latest_payload, '$.resource_type')),
  resource_id = JSON_UNQUOTE(JSON_EXTRACT(latest_payload, '$.resource_id'))
WHERE latest_payload IS NOT NULL;
