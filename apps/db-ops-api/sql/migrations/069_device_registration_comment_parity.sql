-- Forward-only parity repair for deployments that already completed the
-- original 067 migration before its table and column comments were added.
ALTER TABLE device_registrations
  COMMENT = '设备身份注册与配对记录',
  MODIFY COLUMN id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '设备注册记录 ID',
  MODIFY COLUMN user_id INT UNSIGNED NOT NULL COMMENT '所属用户 ID',
  MODIFY COLUMN device_id CHAR(64) NOT NULL COMMENT '设备公钥指纹',
  MODIFY COLUMN public_key CHAR(43) NOT NULL COMMENT 'Ed25519 公钥（Base64url）',
  MODIFY COLUMN status ENUM('paired','revoked') NOT NULL DEFAULT 'paired' COMMENT '设备状态',
  MODIFY COLUMN paired_by INT UNSIGNED NULL COMMENT '执行配对的管理员用户 ID',
  MODIFY COLUMN challenge_hash CHAR(64) NULL COMMENT '最近一次挑战值的哈希',
  MODIFY COLUMN challenge_expires_at DATETIME NULL COMMENT '挑战过期时间',
  MODIFY COLUMN last_seen_at DATETIME NULL COMMENT '设备最近一次访问时间',
  MODIFY COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';
