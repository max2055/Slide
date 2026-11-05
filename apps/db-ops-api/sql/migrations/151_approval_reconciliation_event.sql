-- SQL may have committed even if its result could not be recorded. Preserve the
-- claimed approval and allow its reconciliation diagnostic to be persisted.
ALTER TABLE approval_events
  MODIFY COLUMN event_type ENUM('submitted','ai_reviewed','claimed','approved','rejected','executed','execution_failed','notified','reconciliation_required') COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '事件类型';
