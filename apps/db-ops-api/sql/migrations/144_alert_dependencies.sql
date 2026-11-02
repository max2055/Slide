CREATE TABLE alert_dependency_lock (id INT PRIMARY KEY COMMENT '依赖图串行化锁') COMMENT='依赖配置与新问题判定顺序';
INSERT INTO alert_dependency_lock VALUES(1);
CREATE TABLE alert_dependencies (
 id CHAR(36) PRIMARY KEY COMMENT '依赖身份',
 revision BIGINT UNSIGNED NOT NULL COMMENT '乐观并发版本',
 payload JSON NOT NULL COMMENT '授权端点与依赖来源'
) COMMENT='上游问题仅阻止新下游问题';
CREATE TABLE alert_dependency_operations (
 actor_id BIGINT NOT NULL COMMENT '操作主体', operation_key VARCHAR(128) NOT NULL COMMENT '主体内意图',
 fingerprint CHAR(64) NOT NULL COMMENT '请求摘要', payload JSON NOT NULL COMMENT '固定回执与权限范围',
 PRIMARY KEY(actor_id,operation_key)
) COMMENT='依赖未知结果恢复';
CREATE TABLE alert_dependency_audit (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '审计身份',
 dependency_id CHAR(36) NOT NULL COMMENT '依赖身份', revision BIGINT UNSIGNED NOT NULL COMMENT '版本',
 payload JSON NOT NULL COMMENT '不可变配置审计', UNIQUE KEY dependency_revision(dependency_id,revision)
) COMMENT='依赖变更审计';
CREATE TABLE alert_dependency_decisions (
 identity_hash CHAR(71) PRIMARY KEY COMMENT '下游触发身份',
 resource_key VARCHAR(128) NOT NULL COMMENT '授权资源', payload JSON NOT NULL COMMENT '最近抑制判定及来源'
) COMMENT='抑制不丢弃正式采集事实';
