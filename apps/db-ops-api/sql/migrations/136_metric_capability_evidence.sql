-- MAX-238 / NATIVE-CONFIGURATION-FLOW-R2: trustworthy bootstrap capability evidence.
--
-- Additive only: one `CREATE TABLE IF NOT EXISTS`. No existing table, row or
-- binding/policy/audit writer is touched. A deployment that never bootstraps an
-- unbound resource sees an empty table.
--
-- One row is exactly one probed intent: the resource, the base revision, the
-- fixed template pins with their content hashes, the credential reference and
-- the digest of the caller's exact candidate. `evidence_key` is the sha256 of
-- that identity, so concurrent probes of the same intent never create a second
-- row and evidence can never be reused across resources, credentials, pins,
-- revisions or edited drafts. `payload` is the strict read-only probe result;
-- `expires_at` bounds the cache while each capability keeps its own validity.
CREATE TABLE IF NOT EXISTS metric_capability_evidence (
  evidence_key  CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'sha256 of resource, revision, fixed pins, credential reference and candidate intent digest',
  payload       JSON     NOT NULL COMMENT 'Strict read-only probe record: capabilities, source, actor, probed_at and expires_at',
  created_at    DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) COMMENT 'First probe row creation time',
  updated_at    DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6) COMMENT 'Last probe overwrite time',
  PRIMARY KEY (evidence_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin COMMENT='Bootstrap capability evidence for unbound resources; one row per exact probed intent';
