CREATE TABLE IF NOT EXISTS device_registrations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '设备注册记录 ID',
  user_id INT UNSIGNED NOT NULL COMMENT '所属用户 ID',
  device_id CHAR(64) NOT NULL COMMENT '设备公钥指纹',
  public_key CHAR(43) NOT NULL COMMENT 'Ed25519 公钥（Base64url）',
  status ENUM('paired','revoked') NOT NULL DEFAULT 'paired' COMMENT '设备状态',
  paired_by INT UNSIGNED NULL COMMENT '执行配对的管理员用户 ID',
  challenge_hash CHAR(64) NULL COMMENT '最近一次挑战值的哈希',
  challenge_expires_at DATETIME NULL COMMENT '挑战过期时间',
  last_seen_at DATETIME NULL COMMENT '设备最近一次访问时间',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (id),
  UNIQUE KEY uq_device_registration_user_device (user_id, device_id),
  KEY idx_device_registration_device (device_id),
  CONSTRAINT fk_device_registration_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_device_registration_pairer FOREIGN KEY (paired_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='设备身份注册与配对记录';
