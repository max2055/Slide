-- Source control metadata changes; immutable observations/audits retain original bytes.
UPDATE metric_rollout SET source = 'semantic' WHERE source = 'v2';
UPDATE metric_rollout SET read_mode = 'semantic' WHERE read_mode = 'v2';
UPDATE metric_rollout_resources SET phase = 'semantic' WHERE phase = 'v2';
ALTER TABLE metric_rollout MODIFY COLUMN read_mode VARCHAR(16) NOT NULL COMMENT 'formal semantic, historical legacy, or pending source';
ALTER TABLE metric_rollout_resources COMMENT = 'Resource metric source coordination';
ALTER TABLE metric_rollout_events COMMENT = 'Immutable metric source transition audit';
