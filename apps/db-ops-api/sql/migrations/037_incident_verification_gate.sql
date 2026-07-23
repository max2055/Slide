ALTER TABLE alert_events
  ADD COLUMN verification_passed_at DATETIME NULL,
  ADD COLUMN verification_actor_id INT UNSIGNED NULL,
  ADD COLUMN verification_reason VARCHAR(1024) NULL,
  ADD KEY idx_alert_event_verification (status, verification_passed_at);
