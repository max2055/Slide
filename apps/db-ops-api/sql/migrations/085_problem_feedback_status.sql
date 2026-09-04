ALTER TABLE `problem_feedback`
  ADD COLUMN `status` ENUM('pending','accepted','resolved') NOT NULL DEFAULT 'pending' COMMENT '处理状态' AFTER `source`;
