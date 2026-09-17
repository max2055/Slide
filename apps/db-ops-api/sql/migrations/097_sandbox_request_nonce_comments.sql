-- Preserve migration 096 checksums for databases that already applied it.
ALTER TABLE sandbox_request_nonces
  COMMENT = 'Shared durable nonce claims preventing sandbox request replay',
  MODIFY COLUMN auth_domain VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Hash identifying controllers sharing an authentication secret',
  MODIFY COLUMN nonce CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Unique signed request nonce within the authentication domain',
  MODIFY COLUMN expires_at_ms BIGINT UNSIGNED NOT NULL COMMENT 'Expiry time in Unix milliseconds after the request freshness window';
