ALTER TABLE metric_schedule ADD COLUMN cadence JSON NULL
  COMMENT 'Template item cadence deadlines and the deadline cutoff frozen for the queued batch';

ALTER TABLE metric_policy_bindings ADD COLUMN item_attempt_ids JSON NULL
  COMMENT 'Latest collection attempt ID by scheduled metric';
