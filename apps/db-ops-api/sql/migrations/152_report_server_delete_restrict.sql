-- MAX-368 / GitHub 472: historical reports keep their server identity.
-- MySQL commits each DDL statement by itself. Dropping fk_report_server and
-- adding it again as two statements leaves a window with no foreign key, so a
-- concurrent delete can remove the server and leave the report behind.
-- Reusing the name fk_report_server in the same statement is ER_FK_DUP_NAME
-- (1826) and rolls that statement back, so this replacement uses a new name.
-- ALGORITHM=COPY, LOCK=SHARED keeps the old constraint in place until the new
-- one is installed and makes writers wait through the copy. If validation
-- fails, the original fk_report_server delete rule is unchanged.
-- The migration runner records a failure and does not execute this statement
-- again; a failed attempt must be repaired explicitly.
-- Report configs and server metrics keep their existing delete rules.
ALTER TABLE reports
  DROP FOREIGN KEY fk_report_server,
  ADD CONSTRAINT fk_report_server_restrict
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE RESTRICT,
  ALGORITHM=COPY,
  LOCK=SHARED;
