CREATE TABLE IF NOT EXISTS network_config_backup_schedules (
  device_id BIGINT UNSIGNED NOT NULL COMMENT '网络设备 ID',
  enabled TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否启用每日备份',
  daily_time CHAR(5) NOT NULL DEFAULT '00:00' COMMENT '北京时间 HH:mm',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (device_id),
  CONSTRAINT fk_config_backup_schedule_device FOREIGN KEY (device_id) REFERENCES network_devices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='网络设备每日配置备份设置';

CREATE TABLE IF NOT EXISTS network_config_backup_runs (
  device_id BIGINT UNSIGNED NOT NULL COMMENT '网络设备 ID',
  scheduled_date CHAR(10) NOT NULL COMMENT '北京时间执行日期 YYYY-MM-DD',
  status ENUM('running','success','failed') NOT NULL COMMENT '执行结果',
  error_code VARCHAR(64) NULL COMMENT '脱敏错误码',
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '开始时间',
  finished_at TIMESTAMP NULL DEFAULT NULL COMMENT '结束时间',
  PRIMARY KEY (device_id, scheduled_date),
  CONSTRAINT fk_config_backup_run_device FOREIGN KEY (device_id) REFERENCES network_devices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='网络设备每日配置备份执行记录';
