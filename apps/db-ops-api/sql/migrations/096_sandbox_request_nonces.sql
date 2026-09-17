-- All controllers sharing a secret must use the same authoritative writer and this table.
CREATE TABLE IF NOT EXISTS sandbox_request_nonces (
  auth_domain VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  nonce CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at_ms BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (auth_domain, nonce),
  KEY idx_sandbox_nonce_expiry (auth_domain, expires_at_ms)
) ENGINE=InnoDB;
