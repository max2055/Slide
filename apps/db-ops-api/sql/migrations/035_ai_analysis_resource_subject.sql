ALTER TABLE ai_analysis
  MODIFY COLUMN instance_id INT UNSIGNED NULL,
  ADD COLUMN target_type ENUM('instance','server') NOT NULL DEFAULT 'instance' AFTER analysis_type,
  ADD COLUMN server_id INT UNSIGNED NULL AFTER instance_id,
  ADD INDEX idx_ai_analysis_server (server_id);

UPDATE ai_analysis SET target_type = 'instance' WHERE instance_id IS NOT NULL;
