-- #300: forward repair of unintended constraint changes in immutable 058.
-- Reject unknown legacy values before any data changes; operators must inspect
-- and explicitly repair them. NULL uses the original application defaults.
CREATE TEMPORARY TABLE slide_158_contract_guard (
  invalid_rows BIGINT NOT NULL CHECK (invalid_rows = 0)
);
INSERT INTO slide_158_contract_guard
SELECT COUNT(*) FROM alert_rules
WHERE (threshold_type IS NOT NULL AND BINARY threshold_type NOT IN ('static', 'dynamic'))
   OR silence_minutes < 0;
DROP TEMPORARY TABLE slide_158_contract_guard;

UPDATE alert_rules SET threshold_type = 'static' WHERE threshold_type IS NULL;
UPDATE alert_rules SET silence_minutes = 5 WHERE silence_minutes IS NULL;

ALTER TABLE llm_providers
  MODIFY COLUMN display_name VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '显示名称';
ALTER TABLE alert_rules
  MODIFY COLUMN threshold_type ENUM('static', 'dynamic') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'static' COMMENT '阈值类型',
  MODIFY COLUMN silence_minutes INT NOT NULL DEFAULT 5 COMMENT '静默分钟';

SET @slide_158_check_sql = IF(
  EXISTS (SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'alert_rules'
      AND CONSTRAINT_NAME = 'chk_158_alert_contract'),
  'SELECT 1',
  'ALTER TABLE alert_rules ADD CONSTRAINT chk_158_alert_contract CHECK (silence_minutes >= 0 AND threshold_type IN (''static'', ''dynamic''))'
);
PREPARE slide_158_check FROM @slide_158_check_sql;
EXECUTE slide_158_check;
DEALLOCATE PREPARE slide_158_check;
