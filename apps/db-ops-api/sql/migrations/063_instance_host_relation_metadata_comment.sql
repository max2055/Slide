ALTER TABLE resource_relations
  MODIFY COLUMN metadata JSON NULL COMMENT '关系元数据' AFTER provenance;
