-- Explicit nulls disable metadata defaults; legacy rows retain NULL provenance.
ALTER TABLE metric_definitions
  ADD COLUMN higher_is_worse BOOLEAN DEFAULT NULL COMMENT '指标值越高是否越差，NULL 表示未指定',
  ADD COLUMN metadata_overrides JSON DEFAULT NULL COMMENT '显式配置的指标字段名，包含用户清空的字段';
