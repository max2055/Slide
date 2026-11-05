-- Null preserves the password policy and means pending for unpinned key logins.
ALTER TABLE servers ADD COLUMN ssh_trust_mode VARCHAR(16) NULL COMMENT 'key-only host trust: pinned/insecure/pending';
ALTER TABLE network_device_credentials ADD COLUMN ssh_trust_mode VARCHAR(16) NULL COMMENT 'key-only host trust: pinned/insecure/pending';
CREATE TABLE IF NOT EXISTS ssh_trust_decisions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'decision request id',
  actor_id INT UNSIGNED NOT NULL COMMENT 'authenticated requesting user',
  resource_type VARCHAR(32) NOT NULL COMMENT 'resource or stateless probe kind',
  resource_id VARCHAR(255) NOT NULL COMMENT 'resource id or probe hostname',
  mode VARCHAR(16) NOT NULL COMMENT 'explicitly requested compatibility mode',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'request recorded before mutation or probe'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Explicit SSH trust change requests; no credentials';
