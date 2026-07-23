-- Canonical metric identity is (target_type, metric id). Server OS metrics share
-- the same metric ids as database metrics; resource type disambiguates them.
ALTER TABLE metric_definitions DROP PRIMARY KEY, ADD PRIMARY KEY (target_type, id);

UPDATE metric_definitions SET id = 'cpu_usage' WHERE target_type = 'server' AND id = 'server_cpu_usage';
UPDATE metric_definitions SET id = 'memory_usage' WHERE target_type = 'server' AND id = 'server_memory_usage';
UPDATE metric_definitions SET id = 'disk_usage' WHERE target_type = 'server' AND id = 'server_disk_usage';
UPDATE alert_rules SET metric_name = 'cpu_usage' WHERE target_type = 'server' AND metric_name = 'server_cpu_usage';
UPDATE alert_rules SET metric_name = 'memory_usage' WHERE target_type = 'server' AND metric_name = 'server_memory_usage';
UPDATE alert_rules SET metric_name = 'disk_usage' WHERE target_type = 'server' AND metric_name = 'server_disk_usage';

ALTER TABLE server_metrics ADD COLUMN dimensions JSON NULL AFTER metric_name;
UPDATE server_metrics
SET dimensions = JSON_OBJECT('mount', SUBSTRING(metric_name, CHAR_LENGTH('disk_usage_') + 1)), metric_name = 'disk_usage'
WHERE metric_name LIKE 'disk_usage_%';
UPDATE server_metrics SET metric_name = 'cpu_usage' WHERE metric_name = 'server_cpu_usage';
UPDATE server_metrics SET metric_name = 'memory_usage' WHERE metric_name = 'server_memory_usage';
UPDATE server_metrics SET metric_name = 'disk_usage' WHERE metric_name = 'server_disk_usage';

CREATE TABLE collection_schedule_state (
  resource_type ENUM('instance','server') NOT NULL,
  resource_id BIGINT UNSIGNED NOT NULL,
  provider_id VARCHAR(128) NOT NULL,
  metric_id VARCHAR(128) NOT NULL,
  schedule_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  last_success_at DATETIME NULL,
  next_due_at DATETIME NOT NULL,
  last_result ENUM('success','failure','skipped') NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (resource_type, resource_id, provider_id, metric_id),
  KEY idx_collection_due (resource_type, next_due_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
