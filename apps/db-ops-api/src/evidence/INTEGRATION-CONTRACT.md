# Integration contract for parent

Task received and underway. API implementation will register under:
- GET or POST /api/resources/:type/:id/evaluation with empty body. Returns schemaVersion, resource, generatedAt, rulesVersion (number, not ruleSetVersion), invariants[], expectations[], evidenceRefs[], gaps[]. Rules read from system_config key evidence_invariants:<type>:<id> with JSON {schemaVersion:1,version:1,rules:[InvariantRule]}.
- GET /api/resources/:type/:id/invariants returns that rule configuration. PUT same URL is admin-only, accepts {expectedVersion:0,rules:[{id,version,metricId,min?,max?,dimensions?}]}, returns new configuration version; conflict is HTTP409. Empty config version starts at0.
- POST /api/resources/:type/:id/decisions with {statement,status:'inference'|'hypothesis',evidenceRefs:string[],from,to}. Returns actor-owned durable decision {id,schemaVersion,resource,statement,status,evidenceRefs,from,to,createdAt}. References must exist for actor/resource inside window. User claims cannot be recorded as facts.
- GET /api/resources/:type/:id/decisions/:decisionId returns that decision.
- GET /api/resources/:type/:id/recovery/:operationId checks existing actor-owned operation/resource. Returns schemaVersion,resource,status:'unknown', reason:'RECOVERY_PLAN_NOT_BOUND', operationId, operationState, evidenceRefs:[], verifiedBy:'operation-metadata-v1'. Existing operation schema contains no trusted recovery metric plan. It cannot safely certify recovery from claimed success or caller-provided thresholds.

No operational writes introduced. Rules use admin-only compare-and-swap; internal decision records are metadata writes.
