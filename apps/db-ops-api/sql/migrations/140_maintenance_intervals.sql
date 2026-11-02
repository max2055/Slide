CREATE TABLE maintenance_scope_lock (id INT PRIMARY KEY COMMENT '维护事务串行锁') COMMENT='维护范围序列化';
INSERT INTO maintenance_scope_lock VALUES (1);
CREATE TABLE maintenance_intervals (
 id CHAR(36) PRIMARY KEY COMMENT '维护稳定身份', revision INT NOT NULL COMMENT '当前修订', payload JSON NOT NULL COMMENT '维护权威状态'
) COMMENT='维护窗口当前状态';
CREATE TABLE maintenance_interval_history (
 id CHAR(36) NOT NULL COMMENT '维护稳定身份', revision INT NOT NULL COMMENT '不可变修订', payload JSON NOT NULL COMMENT '发生时范围期限原因',
 PRIMARY KEY(id,revision)
) COMMENT='维护不可变区间修订审计';
CREATE TABLE maintenance_operations (
 actor_id BIGINT NOT NULL COMMENT '操作主体', operation_key VARCHAR(128) NOT NULL COMMENT '主体内幂等键',
 fingerprint CHAR(64) NOT NULL COMMENT '原始意图摘要', payload JSON NOT NULL COMMENT '原始提交结果',
 PRIMARY KEY(actor_id,operation_key)
) COMMENT='维护操作未知结果恢复';
CREATE TABLE maintenance_event_links (
 alert_id BIGINT NOT NULL PRIMARY KEY COMMENT '唯一告警身份', payload JSON NOT NULL COMMENT '事件身份与发生时维护修订'
) COMMENT='维护与唯一事件链不可变关联';
