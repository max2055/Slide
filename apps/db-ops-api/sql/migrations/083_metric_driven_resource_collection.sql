-- Server and network-device collectors share the metric registry scheduler.
-- The heartbeat only scans due work; metric_definitions.default_interval is
-- the sole collection-frequency setting.
ALTER TABLE collection_schedule_state
  MODIFY COLUMN resource_type ENUM('instance','server','network_device') NOT NULL;
