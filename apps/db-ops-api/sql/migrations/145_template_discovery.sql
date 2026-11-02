CREATE TABLE metric_discovery_states (
 resource_key VARCHAR(128) NOT NULL COMMENT '资源隔离键',
 template_id VARCHAR(64) NOT NULL COMMENT '模板稳定身份',
 rule_id VARCHAR(64) NOT NULL COMMENT '模板内规则身份',
 revision INT NOT NULL DEFAULT 0 COMMENT '实例状态 CAS 版本',
 payload JSON NOT NULL COMMENT '固定模板版本、项和触发器原型及实例生命周期',
 PRIMARY KEY(resource_key,template_id,rule_id)
) COMMENT='发现实例状态；退役不删除历史';
CREATE TABLE metric_discovery_audit (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '审计身份',
 resource_key VARCHAR(128) NOT NULL COMMENT '资源隔离键',
 template_id VARCHAR(64) NOT NULL COMMENT '模板身份',
 rule_id VARCHAR(64) NOT NULL COMMENT '规则身份',
 payload JSON NOT NULL COMMENT '状态变化、主体、revision 和固定原型版本',
 recorded_at DATETIME(3) NOT NULL COMMENT '服务端时间',
 KEY discovery_audit_scope(resource_key,template_id,rule_id)
) COMMENT='发现生命周期追加审计';
