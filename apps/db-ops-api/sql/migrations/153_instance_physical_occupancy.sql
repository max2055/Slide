-- Physical address occupancy for database instances.
-- available and deleting rows share one slot (0) per host + port + database name.
-- deleted tombstones store NULL in the slot. InnoDB unique indexes allow multiple
-- NULLs, so a tombstone keeps its row, name, and credentials without holding the address.
-- NULL and empty database_name are the same address. Equality follows the table
-- collation, so case and trailing spaces compare equal. This statement does not
-- rewrite existing name, host, credential, lifecycle, or reference values.
-- If two available or deleting rows already share an address, this ALTER fails and
-- rolls back. Stop writes to database_instances. Identify the occupying rows with a
-- read-only query and back them up.
-- Correct the collision only through an approved identity or lifecycle change.
-- Do not delete historical rows, credentials, or references to clear it.
-- Leave the ledger failed.
-- Do not mark it completed and do not replay while it is failed.
-- Explicit repair is allowed only after the approved correction, and only after
-- confirming this DDL rolled back and neither generated column nor the unique index remains.
-- Then delete this migration's failed ledger row and run migrations again.
-- That ledger delete is not permission to remove history.
ALTER TABLE database_instances
  ADD COLUMN physical_database_key VARCHAR(100)
    AS (IFNULL(database_name, '')) VIRTUAL INVISIBLE
    COMMENT 'Occupancy key; empty string stands for NULL database_name',
  ADD COLUMN physical_occupancy_slot TINYINT UNSIGNED
    AS (IF(lifecycle_state = 'deleted', NULL, 0)) VIRTUAL INVISIBLE
    COMMENT 'NULL releases a deleted address; 0 is held by available and deleting',
  ADD UNIQUE INDEX uk_instance_physical_occupancy (host, port, physical_database_key, physical_occupancy_slot);
