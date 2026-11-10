-- MAX-368 / GitHub 472: historical reports keep their server identity.
-- ON DELETE RESTRICT stops a server delete from cascading reports away.
-- Report configs and server metrics keep their existing delete rules.
ALTER TABLE reports DROP FOREIGN KEY fk_report_server;
ALTER TABLE reports ADD CONSTRAINT fk_report_server
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE RESTRICT;
