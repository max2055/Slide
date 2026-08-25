CREATE TABLE IF NOT EXISTS device_registrations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NOT NULL,
  device_id CHAR(64) NOT NULL,
  public_key CHAR(43) NOT NULL,
  status ENUM('paired','revoked') NOT NULL DEFAULT 'paired',
  paired_by INT UNSIGNED NULL,
  challenge_hash CHAR(64) NULL,
  challenge_expires_at DATETIME NULL,
  last_seen_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_device_registration_user_device (user_id, device_id),
  KEY idx_device_registration_device (device_id),
  CONSTRAINT fk_device_registration_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_device_registration_pairer FOREIGN KEY (paired_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
