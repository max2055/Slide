ALTER TABLE metric_trigger_heads ADD COLUMN source_watermarks JSON NULL
  COMMENT 'Latest accepted observation time by metric for combination rules, independent of cached evidence';
