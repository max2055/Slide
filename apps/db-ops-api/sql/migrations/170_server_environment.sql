ALTER TABLE servers
  ADD COLUMN environment ENUM('development','testing','staging','production')
    NULL DEFAULT NULL COMMENT '部署环境，空值表示未标注';
