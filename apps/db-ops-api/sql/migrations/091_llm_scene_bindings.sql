-- Preserve dangling references so deleted providers cannot silently change routing.
CREATE TABLE IF NOT EXISTS llm_scene_bindings (
  scene VARCHAR(32) NOT NULL COMMENT '业务场景',
  provider_id INT NOT NULL COMMENT '提供商引用，删除后保留以提示配置错误',
  model VARCHAR(255) NOT NULL COMMENT '场景模型 ID',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (scene)
) COMMENT='LLM 场景模型分配';
