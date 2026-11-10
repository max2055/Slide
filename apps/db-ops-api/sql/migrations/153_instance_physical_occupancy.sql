-- Physical address occupancy for database instances.
-- available and deleting rows share one slot (0) per host + port + database name.
-- deleted tombstones store NULL in the slot. InnoDB unique indexes allow multiple
-- NULLs, so a tombstone keeps its row, name, and credentials without holding the address.
-- NULL and empty database_name are the same address. This statement does not rewrite
-- existing name, host, credential, or lifecycle values.
-- If two available/deleting rows already share an address, this ALTER fails and
-- rolls back; the table and its rows stay as they were. The migration ledger then
-- stays failed and must not be acknowledged as completed: remove only the duplicate
-- occupying rows, delete this migration's failed ledger row, and run migrations again.
ALTER TABLE database_instances
  ADD COLUMN physical_database_key VARCHAR(100)
    AS (IFNULL(database_name, '')) VIRTUAL INVISIBLE
    COMMENT 'Occupancy key; empty string stands for NULL database_name',
  ADD COLUMN physical_occupancy_slot TINYINT UNSIGNED
    AS (IF(lifecycle_state = 'deleted', NULL, 0)) VIRTUAL INVISIBLE
    COMMENT 'NULL releases a deleted address; 0 is held by available and deleting',
  ADD UNIQUE INDEX uk_instance_physical_occupancy (host, port, physical_database_key, physical_occupancy_slot);
