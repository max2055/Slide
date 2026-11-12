ALTER TABLE agent_tool_idempotency
  MODIFY COLUMN state ENUM('running','completed','failed','unknown') NOT NULL COMMENT '幂等执行状态，unknown 禁止自动重放',
  ADD COLUMN hash_version TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '1:历史 locale 排序，2:UTF-16 键排序',
  ADD COLUMN owner_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '本次执行唯一所有者，禁止接管未知写入',
  ADD COLUMN lease_until DATETIME(3) NULL COMMENT '数据库时钟租约；过期仅标记 unknown，不重试',
  ADD COLUMN execution_revision BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '所有者写入修订号，兼容禁用 FOUND_ROWS',
  ADD COLUMN checkpoint_json JSON NULL COMMENT '逐项执行状态与已确认结果，不含请求凭据';
