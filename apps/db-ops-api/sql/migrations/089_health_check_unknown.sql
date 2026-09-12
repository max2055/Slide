-- Preserve incomplete assessments separately from confirmed critical health.
ALTER TABLE health_check_history MODIFY COLUMN status ENUM('healthy', 'warning', 'critical', 'unknown') NOT NULL;
