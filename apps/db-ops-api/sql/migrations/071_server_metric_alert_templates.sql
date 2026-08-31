-- Server metric alert presets for the fixed-profile collector.
-- This migration is idempotent so existing installations receive the new
-- evidence rules without duplicating rows when startup is retried.

START TRANSACTION;

INSERT INTO `alert_rule_templates`
  (`name`, `description`, `target_type`, `metric_name`, `operator`, `threshold_template`,
   `duration_seconds`, `severity`, `silence_minutes`, `enabled`)
SELECT seed.`name`, seed.`description`, seed.`target_type`, seed.`metric_name`, seed.`operator`,
       seed.`threshold_template`, seed.`duration_seconds`, seed.`severity`, seed.`silence_minutes`, seed.`enabled`
FROM (
  SELECT '服务器不可达' AS `name`, '服务器连接连续失败或无法访问' AS `description`, 'server' AS `target_type`,
         'reachability' AS `metric_name`, '=' AS `operator`, '{"warning":1,"error":2,"critical":3}' AS `threshold_template`,
         600 AS `duration_seconds`, 'error' AS `severity`, 5 AS `silence_minutes`, TRUE AS `enabled`
  UNION ALL SELECT '网络接收错误过高', '服务器网络接口接收错误累计值超过阈值', 'server',
         'network_rx_errors', '>=', '{"warning":1,"error":10,"critical":100}', 120, 'warning', 5, TRUE
  UNION ALL SELECT '网络发送错误过高', '服务器网络接口发送错误累计值超过阈值', 'server',
         'network_tx_errors', '>=', '{"warning":1,"error":10,"critical":100}', 120, 'warning', 5, TRUE
  UNION ALL SELECT '网络接收丢包过高', '服务器网络接口接收丢弃累计值超过阈值', 'server',
         'network_rx_drops', '>=', '{"warning":1,"error":10,"critical":100}', 120, 'warning', 5, TRUE
  UNION ALL SELECT '网络发送丢包过高', '服务器网络接口发送丢弃累计值超过阈值', 'server',
         'network_tx_drops', '>=', '{"warning":1,"error":10,"critical":100}', 120, 'warning', 5, TRUE
  UNION ALL SELECT '磁盘 I/O 时间过高', '服务器块设备累计 I/O 时间超过阈值', 'server',
         'disk_io_time_ms', '>=', '{"warning":100,"error":500,"critical":1000}', 180, 'warning', 5, TRUE
  UNION ALL SELECT '进程数过高', '服务器当前进程数量超过阈值', 'server',
         'process_count', '>=', '{"warning":500,"error":1000,"critical":2000}', 120, 'warning', 5, TRUE
) AS seed
WHERE NOT EXISTS (
  SELECT 1 FROM `alert_rule_templates` existing
  WHERE existing.`target_type` = seed.`target_type`
    AND existing.`name` = seed.`name`
    AND existing.`metric_name` = seed.`metric_name`
);

COMMIT;
