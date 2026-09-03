INSERT IGNORE INTO system_config (config_key, config_value, value_type, description)
VALUES
  ('monitor.server_collection_interval_seconds', '300', 'number', '服务器 SSH 指标采集间隔（秒）'),
  ('monitor.network_device_collection_interval_seconds', '300', 'number', '网络设备 SNMP 指标采集间隔（秒）');
