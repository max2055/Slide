ALTER TABLE resource_relations
  ADD COLUMN metadata JSON NULL AFTER provenance,
  ADD KEY idx_resource_relation_source_current
    (source_type, source_id, relation_type, valid_until),
  ADD KEY idx_resource_relation_target_current
    (target_type, target_id, relation_type, valid_until);
