CREATE TABLE metric_template_rollouts (
 id CHAR(36) PRIMARY KEY COMMENT '治理批次身份',
 actor_id BIGINT NOT NULL COMMENT '发起主体',
 operation_key VARCHAR(128) NOT NULL COMMENT '主体内幂等键',
 fingerprint CHAR(64) NOT NULL COMMENT '原始意图摘要',
 payload JSON NOT NULL COMMENT '固定选择及创建时间',
 UNIQUE KEY rollout_actor_key(actor_id,operation_key)
) COMMENT='模板灰度批次不可变意图';
CREATE TABLE metric_template_rollout_items (
 batch_id CHAR(36) NOT NULL COMMENT '批次身份',
 resource_key VARCHAR(128) NOT NULL COMMENT '资源稳定身份',
 payload JSON NOT NULL COMMENT '逐资源前版及应用回执',
 PRIMARY KEY(batch_id,resource_key)
) COMMENT='模板灰度逐资源恢复状态';
CREATE TABLE metric_template_rollout_audit (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '审计身份',
 batch_id CHAR(36) NOT NULL COMMENT '批次身份',
 resource_key VARCHAR(128) NOT NULL COMMENT '资源稳定身份',
 payload JSON NOT NULL COMMENT '不可变阶段回执与操作主体'
) COMMENT='模板灰度重试回退审计';
