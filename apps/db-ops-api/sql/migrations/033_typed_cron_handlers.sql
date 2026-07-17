ALTER TABLE cron_jobs ADD COLUMN handler_key VARCHAR(128) NULL AFTER task_type;
UPDATE cron_jobs SET handler_key = 'capacity.collect' WHERE name = '容量数据采集';
UPDATE cron_jobs SET handler_key = 'baseline.cleanup' WHERE name = '基线清理';
UPDATE cron_jobs SET handler_key = 'report.schedule' WHERE name = '定时报表调度';
UPDATE cron_jobs SET handler_key = 'alert.evaluate' WHERE name = '(预留) 升级规则监控';
UPDATE cron_jobs SET handler_key = 'notification.dispatch' WHERE name = '(预留) 通知推送检查';
