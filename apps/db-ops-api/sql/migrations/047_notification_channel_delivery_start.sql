-- A channel begins delivery when it is created or explicitly re-enabled.
-- Backfill existing rows at upgrade time so historical unread alerts are not replayed.
ALTER TABLE notification_channels
  ADD COLUMN delivery_start_at DATETIME NULL AFTER enabled;

UPDATE notification_channels
  SET delivery_start_at = CURRENT_TIMESTAMP
  WHERE delivery_start_at IS NULL;

ALTER TABLE notification_channels
  MODIFY COLUMN delivery_start_at DATETIME NOT NULL;
