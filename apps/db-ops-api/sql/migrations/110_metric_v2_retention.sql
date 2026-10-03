ALTER TABLE metric_v2_observations ADD COLUMN tombstone JSON NULL COMMENT 'Expired raw identity and provenance only; no value or raw field';

CREATE TABLE metric_v2_retention_state (
  id TINYINT NOT NULL PRIMARY KEY COMMENT 'Internal singleton maintenance state',
  preview_policy_hash CHAR(64) NULL COMMENT 'Policy verified in a successful dry-run',
  preview_at DATETIME(3) NULL COMMENT 'Last dry-run time',
  last_report JSON NULL COMMENT 'Counts, time range, reason, mode and bounded work; no payloads',
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'Last maintenance evidence update'
) ENGINE=InnoDB COMMENT='Fixed internal metric retention checkpoint';
INSERT INTO metric_v2_retention_state (id) VALUES (1);
