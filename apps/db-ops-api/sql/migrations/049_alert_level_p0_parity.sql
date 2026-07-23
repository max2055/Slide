ALTER TABLE alerts
  MODIFY COLUMN level ENUM('info', 'warning', 'error', 'critical', 'p0') NOT NULL COMMENT '告警级别';
