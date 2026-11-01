ALTER TABLE maintenance_windows ADD COLUMN revision INT NOT NULL DEFAULT 0 COMMENT '兼容管理乐观版本';
CREATE TABLE maintenance_weekly_history (
 id INT UNSIGNED NOT NULL COMMENT '原周期窗口身份',
 revision INT NOT NULL COMMENT '不可变管理修订',
 payload JSON NOT NULL COMMENT '周期配置与操作主体快照',
 PRIMARY KEY(id,revision)
) COMMENT='周期维护兼容管理审计';
INSERT INTO maintenance_weekly_history(id,revision,payload)
 SELECT id,revision,JSON_OBJECT('id',id,'revision',revision,'name',name,'description',description,
 'instance_id',instance_id,'day_of_week',day_of_week,'start_time',CAST(start_time AS CHAR),
 'end_time',CAST(end_time AS CHAR),'timezone',timezone,'enabled',enabled,
 'suppress_evaluation',suppress_evaluation,'source','upgrade') FROM maintenance_windows;
