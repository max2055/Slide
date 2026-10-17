-- MAX-192: finish neutral naming in active schema metadata without rewriting history.
ALTER TABLE metric_observations COMMENT = 'Metric observations; Canonical and Extension share one contract';
ALTER TABLE metric_schedule COMMENT = 'Durable metric scheduling';
ALTER TABLE metric_schedule_events COMMENT = 'Durable metric scheduling events';
ALTER TABLE metric_rollout_resources MODIFY COLUMN phase VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'shadow, cutover_pending, semantic, or legacy source state';
