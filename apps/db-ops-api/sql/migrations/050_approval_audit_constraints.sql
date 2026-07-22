-- Preserve approval execution provenance while allowing retained audit rows
-- to survive deletion of their source instance or user.

ALTER TABLE sql_execution_history
  ADD CONSTRAINT fk_sql_history_approval
  FOREIGN KEY (approval_request_id) REFERENCES approval_requests(id)
  ON DELETE SET NULL;

ALTER TABLE approval_requests
  ADD CONSTRAINT fk_approval_operation
  FOREIGN KEY (operation_id) REFERENCES operations(id)
  ON DELETE SET NULL;

ALTER TABLE operations
  ADD CONSTRAINT fk_operation_approval
  FOREIGN KEY (approval_id) REFERENCES approval_requests(id)
  ON DELETE SET NULL;
