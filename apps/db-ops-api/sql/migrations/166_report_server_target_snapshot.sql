ALTER TABLE reports
  ADD COLUMN server_target_ids JSON NULL COMMENT 'Server IDs captured when generating a server health summary';
