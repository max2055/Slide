export type MetricBulkPreview = { "key": string; "resources": Array<{ "type": "instance" | "server" | "network_device"; "id": number; }>; "overrides"?: { "enabled"?: "inherit" | "enable" | "disable"; "interval_ms"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "timeout_ms"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "stale_after_ms"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "max_counter_gap_ms"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "max_rows"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "max_concurrency"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "max_series_per_resource"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "metrics"?: Record<string, "inherit" | "enable" | "disable">; }; "packages"?: Array<{ "resources": Array<{ "type": "instance" | "server" | "network_device"; "id": number; }>; "package": { "id": string; "version": string; "digest": string; }; }>; };
export type MetricBulkConfirm = { "digest": string; };
export type MetricBulkRetry = { "key": string; };
export type MetricBulkResult = { "id": string; "digest": string; "state": "draft" | "queued" | "running" | "completed" | "cancelled"; "created_at": string; "updated_at": string; "expires_at": string; "cancel_requested": boolean; "requested_overrides": { "enabled"?: "inherit" | "enable" | "disable"; "interval_ms"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "timeout_ms"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "stale_after_ms"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "max_counter_gap_ms"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "max_rows"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "max_concurrency"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "max_series_per_resource"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "metrics"?: Record<string, "inherit" | "enable" | "disable">; }; "items": Array<{ "resource": { "type": "instance" | "server" | "network_device"; "id": number; }; "state": "eligible" | "unsupported" | "skipped" | "queued" | "running" | "succeeded" | "pending_takeover" | "failed" | "cancelled"; "code": (string | null); "group": string; "checks": Array<{ "attribute": string; "value": (string | number | boolean | null); "status": string; }>; "choices": Array<{ "package": { "id": string; "version": string; "digest": string; }; "recommended": boolean; "compatibility": string; "metrics": Array<string>; "missing": Array<string>; }>; "before": ({ "resource": { "type": "instance" | "server" | "network_device"; "id": number; }; "package": { "id": string; "version": string; "digest": string; }; "group_id": (string | null); "overrides": { "enabled"?: "inherit" | "enable" | "disable"; "interval_ms"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "timeout_ms"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "stale_after_ms"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "max_counter_gap_ms"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "max_rows"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "max_concurrency"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "max_series_per_resource"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "metrics"?: Record<string, "inherit" | "enable" | "disable">; }; "revision": number; } | null); "change": ({ "expected_revision": number; "package"?: { "id": string; "version": string; "digest": string; }; "group_id"?: (string | null); "overrides"?: { "enabled"?: "inherit" | "enable" | "disable"; "interval_ms"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "timeout_ms"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "stale_after_ms"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "max_counter_gap_ms"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "max_rows"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "max_concurrency"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "max_series_per_resource"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "metrics"?: Record<string, "inherit" | "enable" | "disable">; }; } | null); "settings": (Record<string, (number | boolean)> | null); "coverage": Array<string>; "missing": Array<string>; "cost": ({ "before": number; "after": number; "unit": "logical_reads_per_hour"; "estimate": true; } | null); "retained": Array<string>; "changed": Array<string>; "revision": (number | null); "status": ({ "contract_version": "1.0.0"; "resource": { "type": "instance" | "server" | "network_device"; "id": number; }; "evaluated_at": string; "can_manage": boolean; "binding": { "state": "bound" | "unbound"; "package": ({ "id": string; "version": string; "digest": string; } | null); "published_revision": (number | null); "applied_revision": (number | null); "application": "unbound" | "pending" | "applied" | "failed"; }; "effective_enabled": { "enabled": boolean; "global_enabled": boolean; "asset_enabled": boolean; "policy_enabled": boolean; "source": "global" | "asset" | "package" | "platform" | "group" | "resource" | "unbound"; }; "collection": { "state": "disabled" | "pending" | "running" | "succeeded" | "failed" | "unknown"; "last_attempt_at": (string | null); "last_success_at": (string | null); "in_flight": boolean; }; "formal_visibility": { "state": "unbound" | "pending" | "validating" | "available" | "failed"; "source": "none" | "semantic"; "last_observed_at": (string | null); "generation": (number | null); "freshness": "fresh" | "stale" | "unknown"; }; "coverage": Array<{ "metric": { "id": string; "semantic_version": string; }; "state": "covered" | "not_covered" | "unsupported" | "unknown" | "disabled"; "reason": (string | null); }>; "legacy_configuration"?: Array<{ "kind": "custom_sql" | "deprecated_template"; "source_id": string; "source_digest": (string | null); "state": "blocked" | "reviewed"; "code": string; "package": ({ "id": string; "version": string; "digest": string; } | null); "actions": Array<string>; }>; "blockers": Array<"UNBOUND" | "GLOBAL_COLLECTION_DISABLED" | "ASSET_COLLECTION_DISABLED" | "POLICY_COLLECTION_DISABLED" | "APPLICATION_PENDING" | "APPLICATION_FAILED" | "PACKAGE_INCOMPATIBLE" | "CAPABILITY_UNKNOWN" | "COLLECTION_FAILED" | "SOURCE_VALIDATION_PENDING" | "SOURCE_VALIDATION_FAILED" | "AWAITING_SAMPLE" | "STALE_SAMPLE" | "LEGACY_CONFIGURATION_REVIEW_REQUIRED">; } | null); }>; "retry_of": (string | null); };
export type MetricBulkList = { "jobs": Array<{ "id": string; "state": string; "created_at": string; "count": number; }>; };
export type MetricBulkCancel = { "id": string; "cancel_requested": true; };
export type MetricConfigurationStatus = { "contract_version": "1.0.0"; "resource": { "type": "instance" | "server" | "network_device"; "id": number; }; "evaluated_at": string; "can_manage": boolean; "binding": { "state": "bound" | "unbound"; "package": ({ "id": string; "version": string; "digest": string; } | null); "published_revision": (number | null); "applied_revision": (number | null); "application": "unbound" | "pending" | "applied" | "failed"; }; "effective_enabled": { "enabled": boolean; "global_enabled": boolean; "asset_enabled": boolean; "policy_enabled": boolean; "source": "global" | "asset" | "package" | "platform" | "group" | "resource" | "unbound"; }; "collection": { "state": "disabled" | "pending" | "running" | "succeeded" | "failed" | "unknown"; "last_attempt_at": (string | null); "last_success_at": (string | null); "in_flight": boolean; }; "formal_visibility": { "state": "unbound" | "pending" | "validating" | "available" | "failed"; "source": "none" | "semantic"; "last_observed_at": (string | null); "generation": (number | null); "freshness": "fresh" | "stale" | "unknown"; }; "coverage": Array<{ "metric": { "id": string; "semantic_version": string; }; "state": "covered" | "not_covered" | "unsupported" | "unknown" | "disabled"; "reason": (string | null); }>; "legacy_configuration"?: Array<{ "kind": "custom_sql" | "deprecated_template"; "source_id": string; "source_digest": (string | null); "state": "blocked" | "reviewed"; "code": string; "package": ({ "id": string; "version": string; "digest": string; } | null); "actions": Array<string>; }>; "blockers": Array<"UNBOUND" | "GLOBAL_COLLECTION_DISABLED" | "ASSET_COLLECTION_DISABLED" | "POLICY_COLLECTION_DISABLED" | "APPLICATION_PENDING" | "APPLICATION_FAILED" | "PACKAGE_INCOMPATIBLE" | "CAPABILITY_UNKNOWN" | "COLLECTION_FAILED" | "SOURCE_VALIDATION_PENDING" | "SOURCE_VALIDATION_FAILED" | "AWAITING_SAMPLE" | "STALE_SAMPLE" | "LEGACY_CONFIGURATION_REVIEW_REQUIRED">; };
export type MetricConfigurationMigration = { "resource": { "type": "instance" | "server" | "network_device"; "id": number; }; "items": Array<{ "kind": "custom_sql" | "deprecated_template"; "source_id": string; "source_digest": (string | null); "state": "blocked" | "reviewed"; "code": string; "package": ({ "id": string; "version": string; "digest": string; } | null); "actions": Array<string>; }>; };
export type MetricBindingChange = { "expected_revision": number; "package"?: { "id": string; "version": string; "digest": string; }; "group_id"?: (string | null); "overrides"?: { "enabled"?: "inherit" | "enable" | "disable"; "interval_ms"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "timeout_ms"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "stale_after_ms"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "max_counter_gap_ms"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "max_rows"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "max_concurrency"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "max_series_per_resource"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "metrics"?: Record<string, "inherit" | "enable" | "disable">; }; };
export type MetricRecommendations = { "resource": { "type": "instance" | "server" | "network_device"; "id": number; }; "evaluated_at": string; "packages": Array<{ "release": { "package": { "id": string; "version": string; "contract_version": string; "digest": string; "resource_type": "instance" | "server" | "network_device"; "applicability": Array<{ "attribute": string; "values": Array<string>; }>; "collectors": Array<{ "id": string; "method": "sql" | "ssh" | "snmp"; "implementation_ref": string; "timeout_ms": number; "estimated_cost": "low" | "medium" | "high"; "mappings": Array<{ "metric": { "id": string; "semantic_version": string; }; "raw_field": string; "input_unit": "1" | "By" | "s" | "ms" | "%" | "bit/s" | "By/s" | "count" | "count/s"; "output_unit": "1" | "By" | "s" | "ms" | "%" | "bit/s" | "By/s" | "count" | "count/s"; "transform_version": string; "steps": Array<"decode" | "unit_convert" | "counter_delta" | "rate" | "derive" | "normalize">; }>; }>; }; "extensions": Array<{ "id": string; "semantic_version": string; "meaning": string; "unit": "1" | "By" | "s" | "ms" | "%" | "bit/s" | "By/s" | "count" | "count/s"; "resource_type": "instance" | "server" | "network_device"; "scope": "resource" | "database" | "filesystem" | "interface"; "kind": "gauge" | "counter" | "histogram" | "summary"; "roles": Array<"core" | "diagnostic" | "capacity" | "slo">; "temporality": "instant" | "cumulative" | "delta"; "monotonic": boolean; "value_type": "float64" | "int64" | "uint64" | "histogram" | "summary"; "dimensions": { "keys": Array<{ "name": string; "meaning": string; "required": boolean; "allowed_values"?: Array<string>; }>; "max_series_per_resource": number; "max_value_length": number; "overflow": "reject"; }; "aggregation": { "time": Array<"last" | "min" | "max" | "mean" | "sum" | "rate" | "merge" | "quantile">; "space": Array<"none" | "sum" | "min" | "max" | "weighted_mean" | "merge">; "missing": "preserve_null"; "min_coverage": number; "quantiles": "not_applicable" | "from_merged_histogram" | "non_mergeable"; }; "lifecycle": "active" | "deprecated"; "replacement_id"?: string; "category": "extension"; "namespace": string; }>; "derived": Array<{ "id": string; "output": { "id": string; "semantic_version": string; }; "transform_version": string; "inputs": Array<{ "id": string; "semantic_version": string; }>; "operation": "difference" | "rate" | "ratio" | "sum" | "scale"; "factor"?: number; "join": "same_resource_and_dimensions"; "max_skew_ms": number; "on_missing": "null"; "on_zero_denominator": "null"; "quality_propagation": "worst_input"; "accuracy_propagation": "least_certain_input"; }>; "transforms": Array<{ "id": "normalize" | "derive"; "version": string; }>; "recommendations": { "interval_ms": number; "timeout_ms": number; "stale_after_ms": number; "max_counter_gap_ms": number; "max_rows": number; "enabled": boolean; }; "documentation": Array<{ "collector_id": string; "permissions": Array<string>; "discovery": string; }>; }; "compatibility": "compatible" | "incompatible" | "unknown"; "recommended": boolean; "checks": Array<{ "attribute": string; "value": (string | number | boolean | null); "supported_values": Array<string>; "status": "supported" | "unsupported" | "unknown"; }>; "coverage": Array<{ "id": string; "semantic_version": string; }>; "missing_core_metrics": Array<string>; }>; };
export type MetricPolicyGroups = { "groups": Array<{ "id": string; "revision": number; "policy_revision"?: number; "overrides": { "enabled"?: "inherit" | "enable" | "disable"; "interval_ms"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "timeout_ms"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "stale_after_ms"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "max_counter_gap_ms"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "max_rows"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "max_concurrency"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "max_series_per_resource"?: ({ "mode": "inherit"; } | { "mode": "set"; "value": number; }); "metrics"?: Record<string, "inherit" | "enable" | "disable">; }; "can_manage": boolean; }>; };
export type OperationsCaseCandidate = { "investigationId": string; "resultVersion": number; "content": { "title": string; "symptoms": string; "faultType": string; "confirmedCause": string; "actions": string; "actualEffect": string; "counterexamples": string; }; "applicability": { "conditions": string; "productVersion": string; "resourceVersion": string; }; "validUntil": string; "humanConfirmed": true; };
export type OperationsCaseRevision = { "expectedRevision": number; "candidate": { "investigationId": string; "resultVersion": number; "content": { "title": string; "symptoms": string; "faultType": string; "confirmedCause": string; "actions": string; "actualEffect": string; "counterexamples": string; }; "applicability": { "conditions": string; "productVersion": string; "resourceVersion": string; }; "validUntil": string; "humanConfirmed": true; }; };
export type OperationsCaseReview = { "expectedRevision": number; "version": number; "contentHash": string; "decision": "approved" | "rejected"; "note": string; };
export type OperationsCaseTransition = { "expectedRevision": number; };
export type OperationsCaseWithdrawal = { "expectedRevision": number; "reason": string; };
export type OperationsCaseSearch = { "state": "draft" | "pending_review" | "published" | "expired" | "withdrawn"; "query": string; "faultType"?: string; "resourceType"?: "instance" | "server" | "network_device"; "productVersion"?: string; "resourceVersion"?: string; "limit": number; "cursor"?: string; };
export type OperationsBaselineInput = { "resource": { "type": "instance" | "server" | "network_device"; "id": number; }; "metric": string; "dimensions": Record<string, string>; "mode": "daily" | "weekly"; "staticThreshold"?: { "operator": ">" | "<"; "value": number; }; };
export type OperationsResourceRef = { "type": "instance" | "server" | "network_device"; "id": number; };
export type OperationsRelationInput = { "source": { "type": "instance" | "server" | "network_device"; "id": number; }; "target": { "type": "instance" | "server" | "network_device"; "id": number; }; "relationType": "runs_on" | "replicates_to" | "depends_on" | "connected_to" | "serves"; "evidence": Array<{ "id": string; "version": number; "hash": string; "validUntil": string; }>; "observedAt": string; "validFrom": string; "validUntil": (string | null); "origin": "manual" | "collector" | "model"; };
export type OperationsRelationRevision = { "evidence": Array<{ "id": string; "version": number; "hash": string; "validUntil": string; }>; "observedAt": string; "validFrom": string; "validUntil": (string | null); "origin": "manual" | "collector" | "model"; "expectedVersion": number; };
export type OperationsRelationTransition = { "expectedVersion": number; "action": "confirm" | "withdraw"; "reason"?: string; };
export type OperationsPlanContent = { "schemaVersion": 1; "investigationId": string; "resultVersion": number; "target": { "type": "server"; "id": number; }; "tool": { "name": "restart_demo_service"; "version": string; "hash": string; }; "parameters": { "unit": "slide-action-demo.service"; }; "evidence": Array<{ "id": string; "version": number; "hash": string; "validUntil": string; }>; "relations": Array<{ "id": string; "version": number; "hash": string; "validUntil": string; }>; "baselines": Array<{ "id": string; "version": number; "hash": string; "validUntil": string; }>; "preconditions": Array<{ "kind": string; "expected": string; }>; "risk": "low" | "medium" | "high" | "critical"; "impact": string; "policyVersion": string; "validFrom": string; "validUntil": string; "verifier": { "id": string; "version": string; "definitionHash": string; "beforeSeconds": 120; "readinessSeconds": 60; "observationSeconds": 300; "intervalSeconds": 10; "maxExtraRestarts": 0; "requireAllHealthy": true; }; "rollback": { "capability": "none"; "description": string; }; "author": { "kind": "user" | "service"; "id": number; }; "requester": { "kind": "user" | "service"; "id": number; }; };
export type OperationsPlanProposal = { "content": Record<string, unknown>; "lifetimeMs"?: number; };
export type OperationsPlanRevision = { "content": Record<string, unknown>; "lifetimeMs"?: number; "expectedVersion": number; };
export type OperationsPlanVersion = { "expectedVersion": number; };
export type OperationsPlanReview = { "expectedVersion": number; "approvalId": string; "action": "approve" | "reject"; "note"?: string; };
export type OperationsAttentionInput = { "observedAt": string; "resources": Array<{ "type": "instance" | "server" | "network_device"; "id": number; }>; };
export type OperationsAttentionOverride = { "expectedVersion": number; "reason": string; "partitions": Array<Array<string>>; };
// Generated investigation contract baseline; routes are not implemented by these types.
import type { ProjectionFrame } from '../../../../packages/agent-core/src/message-projection.ts';

export type InvestigationSubject = ({ "kind": "resource"; "resource": { "type": ("instance" | "server" | "network_device"); "id": number; }; } | { "kind": "platform"; "component": string; "releaseId"?: string; });
export type InvestigationRun = ({ "state": ("running" | "completed" | "failed" | "cancelled" | "timed_out"); "resolution"?: "known"; } | { "state": "partial"; "resolution"?: ("known" | "outcome_unknown"); });
export type InvestigationLifecycle = ("open" | "waiting" | "closed" | "archived");
export type InvestigationProblemStatus = ("unconfirmed" | "in_progress" | "resolved" | "not_applicable");
export type InvestigationExecutionState = ("running" | "completed" | "failed" | "cancelled" | "timed_out" | "partial" | "queued" | "unknown");
export type InvestigationStates = { "execution": ("running" | "completed" | "failed" | "cancelled" | "timed_out" | "partial" | "queued" | "unknown"); "lifecycle": ("open" | "waiting" | "closed" | "archived"); "problemStatus": ("unconfirmed" | "in_progress" | "resolved" | "not_applicable"); };
export type InvestigationErrorCode = ("INVESTIGATION_INPUT_INVALID" | "INVESTIGATION_OPERATION_FORBIDDEN" | "INVESTIGATION_NOT_FOUND" | "INVESTIGATION_ACTIVE_REQUEST" | "VERSION_CONFLICT" | "IDEMPOTENCY_PAYLOAD_MISMATCH" | "PROFILE_SUBJECT_UNSUPPORTED" | "INVESTIGATION_BUDGET_EXHAUSTED" | "INVESTIGATION_RATE_LIMITED" | "INVESTIGATION_QUEUE_UNAVAILABLE" | "EVIDENCE_EXPIRED");
export type InvestigationRecoveryReason = ("MODEL_OUTCOME_UNKNOWN" | "LEASE_LOST" | "AUTHORITY_REVOKED" | "SOURCE_COMMIT_MISMATCH" | "EVIDENCE_MISSING");
export type InvestigationRecoveryVerification = { "method": string; "from": string; "to": string; "evidenceIds": Array<string>; "verifiedAt": string; "verifiedBy": number; };
export type InvestigationClosure = { "lifecycle": ("closed" | "archived"); "problemStatus": ("unconfirmed" | "in_progress" | "resolved" | "not_applicable"); "verification"?: { "method": string; "from": string; "to": string; "evidenceIds": Array<string>; "verifiedAt": string; "verifiedBy": number; }; };
export type InvestigationRootCauseVerification = ({ "status": "unverified"; } | { "status": "supported"; "evidenceIds": Array<string>; } | { "status": "human_confirmed"; "method": string; "from": string; "to": string; "evidenceIds": Array<string>; "verifiedAt": string; "verifiedBy": number; } | { "status": "experimentally_verified"; "method": string; "from": string; "to": string; "evidenceIds": Array<string>; "verifiedAt": string; "verifiedBy": number; });
export type InvestigationResult = { "schemaVersion": 2; "subject": ({ "kind": "resource"; "resource": { "type": ("instance" | "server" | "network_device"); "id": number; }; } | { "kind": "platform"; "component": string; "releaseId"?: string; }); "summary": string; "facts": Array<{ "statement": string; "evidenceIds": Array<string>; }>; "hypotheses": Array<{ "statement": string; "status": ("supported" | "refuted" | "unknown"); "supportingEvidenceIds": Array<string>; "contradictingEvidenceIds": Array<string>; }>; "claims": Array<{ "statement": string; "kind": ("fact" | "inference"); "supportingEvidenceIds": Array<string>; "contradictingEvidenceIds": Array<string>; }>; "rootCauseVerification": ({ "status": "unverified"; } | { "status": "supported"; "evidenceIds": Array<string>; } | { "status": "human_confirmed"; "method": string; "from": string; "to": string; "evidenceIds": Array<string>; "verifiedAt": string; "verifiedBy": number; } | { "status": "experimentally_verified"; "method": string; "from": string; "to": string; "evidenceIds": Array<string>; "verifiedAt": string; "verifiedBy": number; }); "unresolvedQuestions": Array<string>; "recommendations": Array<{ "action": string; "priority": ("low" | "medium" | "high" | "critical"); }>; "problemStatus": ("unconfirmed" | "in_progress" | "resolved" | "not_applicable"); "recoveryVerification"?: { "method": string; "from": string; "to": string; "evidenceIds": Array<string>; "verifiedAt": string; "verifiedBy": number; }; "provenance": { "modelVersion": string; "promptVersion": string; "toolVersions": Record<string, string>; "providerId"?: number; "routeVersion"?: string; "inputHash"?: string; "runtimeRunId"?: string; "usageStatus": ("available" | "unavailable" | "partial"); }; "createdAt": string; };
export type OperationalEvent = { "schemaVersion": 1; "id": string; "source": string; "sourceEventId": string; "kind": string; "subject": ({ "kind": "resource"; "resource": { "type": ("instance" | "server" | "network_device"); "id": number; }; } | { "kind": "platform"; "component": string; "releaseId"?: string; }); "occurredAt": string; "receivedAt": string; "severity": ("info" | "warning" | "error" | "critical"); "summary": string; "correlationId"?: string; "releaseId"?: string; "commitSha"?: string; "origin": ("user_operation" | "collector" | "workflow" | "investigation_engine"); "rawRef"?: string; };
export type InvestigationStreamEvent = ({ "schemaVersion": 1; "sequence": number; "investigationId": string; "occurredAt": string; "requestId": string; "type": "request.accepted"; "payload": { "jobId": string; "version": number; }; } | { "schemaVersion": 1; "sequence": number; "investigationId": string; "occurredAt": string; "runId": string; "requestId"?: string; "type": "run.started"; "payload": {  }; } | { "schemaVersion": 1; "sequence": number; "investigationId": string; "occurredAt": string; "runId": string; "requestId"?: string; "type": "parts.operation"; "payload": ProjectionFrame; } | { "schemaVersion": 1; "sequence": number; "investigationId": string; "occurredAt": string; "runId": string; "requestId"?: string; "type": "evidence.added"; "payload": { "evidenceId": string; }; } | { "schemaVersion": 1; "sequence": number; "investigationId": string; "occurredAt": string; "runId": string; "requestId"?: string; "type": "result.persisted"; "payload": { "resultId": string; "resultVersion": number; "schemaVersion": 2; }; } | { "schemaVersion": 1; "sequence": number; "investigationId": string; "occurredAt": string; "runId": string; "requestId"?: string; "type": "run.terminal"; "payload": ({ "state": ("completed" | "failed" | "cancelled" | "timed_out"); "resolution"?: "known"; } | { "state": "partial"; "resolution"?: ("known" | "outcome_unknown"); }); } | { "schemaVersion": 1; "sequence": number; "investigationId": string; "occurredAt": string; "requestId"?: string; "runId"?: string; "type": "investigation.changed"; "payload": { "version": number; "lifecycle": ("open" | "waiting" | "closed" | "archived"); "problemStatus": ("unconfirmed" | "in_progress" | "resolved" | "not_applicable"); }; });
export type InvestigationProfile = ({ "id": "system"; "supportedSubjectKinds": Array<"platform">; "version": number; "responsibility": string; "modelScene": ("chat" | "sql_analysis" | "fault_diagnosis" | "health_check"); "prompt": { "version": string; "hash": string; }; "skills": Array<{ "id": string; "version": string; "hash": string; }>; "toolAllowlist": Array<string>; "outputSchemaVersion": 2; "resourceBoundary": "all_required_scopes"; "readonly": true; "budget": { "deadlineMs": number; "maxToolCalls": number; "maxProviderAttempts": number; "maxTokens": number; "maxRows": number; "maxBytes": number; "maxWindowMs": number; }; "outputLanguage": string; } | { "id": "ops"; "supportedSubjectKinds": Array<"resource">; "version": number; "responsibility": string; "modelScene": ("chat" | "sql_analysis" | "fault_diagnosis" | "health_check"); "prompt": { "version": string; "hash": string; }; "skills": Array<{ "id": string; "version": string; "hash": string; }>; "toolAllowlist": Array<string>; "outputSchemaVersion": 2; "resourceBoundary": "all_required_scopes"; "readonly": true; "budget": { "deadlineMs": number; "maxToolCalls": number; "maxProviderAttempts": number; "maxTokens": number; "maxRows": number; "maxBytes": number; "maxWindowMs": number; }; "outputLanguage": string; });
export type InvestigationCreateRequest = { "title": string; "goal": string; "profileId": ("ops" | "system"); "subject": ({ "kind": "resource"; "resource": { "type": ("instance" | "server" | "network_device"); "id": number; }; } | { "kind": "platform"; "component": string; "releaseId"?: string; }); "resourceRefs": Array<{ "type": ("instance" | "server" | "network_device"); "id": number; "role": ("primary" | "related"); }>; "sessionId"?: string; "from"?: string; "to"?: string; };
export type InvestigationRequest = { "message": string; "expectedVersion": number; };
export type InvestigationPatchRequest = { "expectedVersion": number; "title"?: string; "goal"?: string; "lifecycle"?: ("open" | "waiting" | "closed" | "archived"); };
export type InvestigationAccepted = { "id": string; "investigationId": string; "sessionId": string; "requestId": string; "jobId": string; "version": number; };
export type InvestigationEvidence = { "id": string; "investigationId": string; "requestId": string; "runId": string; "source": string; "summary": string; "resources": Array<{ "type": ("instance" | "server" | "network_device"); "id": number; }>; "observedFrom": (string | null); "observedTo": (string | null); "collectedAt": string; "contentHash": string; "expiresAt": string; "status": ("available" | "expired"); "expiryReason"?: "RETENTION_EXPIRED"; "raw"?: unknown; };
export type InvestigationReplay = { "events": Array<({ "schemaVersion": 1; "sequence": number; "investigationId": string; "occurredAt": string; "requestId": string; "type": "request.accepted"; "payload": { "jobId": string; "version": number; }; } | { "schemaVersion": 1; "sequence": number; "investigationId": string; "occurredAt": string; "runId": string; "requestId"?: string; "type": "run.started"; "payload": {  }; } | { "schemaVersion": 1; "sequence": number; "investigationId": string; "occurredAt": string; "runId": string; "requestId"?: string; "type": "parts.operation"; "payload": ProjectionFrame; } | { "schemaVersion": 1; "sequence": number; "investigationId": string; "occurredAt": string; "runId": string; "requestId"?: string; "type": "evidence.added"; "payload": { "evidenceId": string; }; } | { "schemaVersion": 1; "sequence": number; "investigationId": string; "occurredAt": string; "runId": string; "requestId"?: string; "type": "result.persisted"; "payload": { "resultId": string; "resultVersion": number; "schemaVersion": 2; }; } | { "schemaVersion": 1; "sequence": number; "investigationId": string; "occurredAt": string; "runId": string; "requestId"?: string; "type": "run.terminal"; "payload": ({ "state": ("completed" | "failed" | "cancelled" | "timed_out"); "resolution"?: "known"; } | { "state": "partial"; "resolution"?: ("known" | "outcome_unknown"); }); } | { "schemaVersion": 1; "sequence": number; "investigationId": string; "occurredAt": string; "requestId"?: string; "runId"?: string; "type": "investigation.changed"; "payload": { "version": number; "lifecycle": ("open" | "waiting" | "closed" | "archived"); "problemStatus": ("unconfirmed" | "in_progress" | "resolved" | "not_applicable"); }; })>; "nextCursor": number; "hasMore": boolean; "replayRequired": boolean; "watermark": number; "code"?: "replay_required"; };
export type VersionedInvestigationResult = { "id": string; "investigationId": string; "requestId": string; "runId": string; "version": number; "result": { "schemaVersion": 2; "subject": ({ "kind": "resource"; "resource": { "type": ("instance" | "server" | "network_device"); "id": number; }; } | { "kind": "platform"; "component": string; "releaseId"?: string; }); "summary": string; "facts": Array<{ "statement": string; "evidenceIds": Array<string>; }>; "hypotheses": Array<{ "statement": string; "status": ("supported" | "refuted" | "unknown"); "supportingEvidenceIds": Array<string>; "contradictingEvidenceIds": Array<string>; }>; "claims": Array<{ "statement": string; "kind": ("fact" | "inference"); "supportingEvidenceIds": Array<string>; "contradictingEvidenceIds": Array<string>; }>; "rootCauseVerification": ({ "status": "unverified"; } | { "status": "supported"; "evidenceIds": Array<string>; } | { "status": "human_confirmed"; "method": string; "from": string; "to": string; "evidenceIds": Array<string>; "verifiedAt": string; "verifiedBy": number; } | { "status": "experimentally_verified"; "method": string; "from": string; "to": string; "evidenceIds": Array<string>; "verifiedAt": string; "verifiedBy": number; }); "unresolvedQuestions": Array<string>; "recommendations": Array<{ "action": string; "priority": ("low" | "medium" | "high" | "critical"); }>; "problemStatus": ("unconfirmed" | "in_progress" | "resolved" | "not_applicable"); "recoveryVerification"?: { "method": string; "from": string; "to": string; "evidenceIds": Array<string>; "verifiedAt": string; "verifiedBy": number; }; "provenance": { "modelVersion": string; "promptVersion": string; "toolVersions": Record<string, string>; "providerId"?: number; "routeVersion"?: string; "inputHash"?: string; "runtimeRunId"?: string; "usageStatus": ("available" | "unavailable" | "partial"); }; "createdAt": string; }; };
export type InvestigationResultPage = { "items": Array<{ "id": string; "investigationId": string; "requestId": string; "runId": string; "version": number; "result": { "schemaVersion": 2; "subject": ({ "kind": "resource"; "resource": { "type": ("instance" | "server" | "network_device"); "id": number; }; } | { "kind": "platform"; "component": string; "releaseId"?: string; }); "summary": string; "facts": Array<{ "statement": string; "evidenceIds": Array<string>; }>; "hypotheses": Array<{ "statement": string; "status": ("supported" | "refuted" | "unknown"); "supportingEvidenceIds": Array<string>; "contradictingEvidenceIds": Array<string>; }>; "claims": Array<{ "statement": string; "kind": ("fact" | "inference"); "supportingEvidenceIds": Array<string>; "contradictingEvidenceIds": Array<string>; }>; "rootCauseVerification": ({ "status": "unverified"; } | { "status": "supported"; "evidenceIds": Array<string>; } | { "status": "human_confirmed"; "method": string; "from": string; "to": string; "evidenceIds": Array<string>; "verifiedAt": string; "verifiedBy": number; } | { "status": "experimentally_verified"; "method": string; "from": string; "to": string; "evidenceIds": Array<string>; "verifiedAt": string; "verifiedBy": number; }); "unresolvedQuestions": Array<string>; "recommendations": Array<{ "action": string; "priority": ("low" | "medium" | "high" | "critical"); }>; "problemStatus": ("unconfirmed" | "in_progress" | "resolved" | "not_applicable"); "recoveryVerification"?: { "method": string; "from": string; "to": string; "evidenceIds": Array<string>; "verifiedAt": string; "verifiedBy": number; }; "provenance": { "modelVersion": string; "promptVersion": string; "toolVersions": Record<string, string>; "providerId"?: number; "routeVersion"?: string; "inputHash"?: string; "runtimeRunId"?: string; "usageStatus": ("available" | "unavailable" | "partial"); }; "createdAt": string; }; }>; "nextBefore": (number | null); };
export type InvestigationWatch = { "type": "investigation.watch"; "id": string; "afterSequence"?: number; };
export type InvestigationUnwatch = { "type": "investigation.unwatch"; "id"?: string; };
export type InvestigationProfilesResponse = { "schemaVersion": 1; "source": "repository"; "allowlistSemantics": "authority_ceiling"; "items": Array<{ "profile": ({ "id": "system"; "supportedSubjectKinds": Array<"platform">; "version": number; "responsibility": string; "modelScene": ("chat" | "sql_analysis" | "fault_diagnosis" | "health_check"); "prompt": { "version": string; "hash": string; }; "skills": Array<{ "id": string; "version": string; "hash": string; }>; "toolAllowlist": Array<string>; "outputSchemaVersion": 2; "resourceBoundary": "all_required_scopes"; "readonly": true; "budget": { "deadlineMs": number; "maxToolCalls": number; "maxProviderAttempts": number; "maxTokens": number; "maxRows": number; "maxBytes": number; "maxWindowMs": number; }; "outputLanguage": string; } | { "id": "ops"; "supportedSubjectKinds": Array<"resource">; "version": number; "responsibility": string; "modelScene": ("chat" | "sql_analysis" | "fault_diagnosis" | "health_check"); "prompt": { "version": string; "hash": string; }; "skills": Array<{ "id": string; "version": string; "hash": string; }>; "toolAllowlist": Array<string>; "outputSchemaVersion": 2; "resourceBoundary": "all_required_scopes"; "readonly": true; "budget": { "deadlineMs": number; "maxToolCalls": number; "maxProviderAttempts": number; "maxTokens": number; "maxRows": number; "maxBytes": number; "maxWindowMs": number; }; "outputLanguage": string; }); "profileHash": string; "configurationStatus": "preset"; "toolAvailability": "not_evaluated"; "outputSchemaId": "InvestigationResult"; }>; };
export type InvestigationPoliciesResponse = { "schemaVersion": 1; "configurationStatus": ("not_configured" | "configured"); "integrationStatus": ("not_connected" | "connected"); "source": "production_composition"; "items": Array<{ "id": "database-alert-pilot"; "version": 1; "profileId": "ops"; "source": "database-alert-engine"; "enabled": boolean; "readonly": true; }>; "originBoundary": "investigation_engine_persist_only"; };
export type InvestigationBudgetResponse = { "schemaVersion": 1; "source": "investigationBudgetConfiguration"; "policy": { "currency": string; "maxConcurrent": number; "manualReserved": number; "maxPerResourceConcurrent": number; "maxAutomaticRequestsPerHour": number; "maxAutomaticTokensPerDay": number; "maxTotalTokensPerDay": number; "maxCostMicrosPerDay": number; }; "reserveCostMicros": number; "persistedPolicy": ({ "currency": string; "maxConcurrent": number; "manualReserved": number; "maxPerResourceConcurrent": number; "maxAutomaticRequestsPerHour": number; "maxAutomaticTokensPerDay": number; "maxTotalTokensPerDay": number; "maxCostMicrosPerDay": number; } | null); "admissionStatus": ("uninitialized" | "matching" | "conflict"); "automaticTriggerStatus": ("not_connected" | "connected"); "window": "UTC_admission_day_and_hour"; "profileLimitsSource": "/api/investigation-profiles"; };
export type InvestigationUsageResponse = { "schemaVersion": 1; "accessScope": "global_config_management"; "window": "all_history"; "costSemantics": "rate_estimate_not_provider_invoice"; "tokenSemantics": "input_includes_cached_input"; "total": number; "counts": { "reserved": number; "sent": number; "settled": number; "unknown": number; "cancelled": number; }; "knownUsageCount": number; "unknownUsageCount": number; "pendingUsageCount": number; "reservedTokens": number; "outstandingTokens": number; "settledTokens": number; "costs": Array<{ "currency": string; "reservedCostMicros": number; "outstandingCostMicros": number; "estimatedSettledCostMicros": number; }>; "groupCount": number; "items": Array<{ "state": ("reserved" | "sent" | "settled" | "unknown" | "cancelled"); "mode": ("automatic" | "manual"); "currency": string; "count": number; "knownUsageCount": number; "unknownUsageCount": number; "pendingUsageCount": number; "knownInputTokens": number; "knownCachedInputTokens": number; "knownOutputTokens": number; "reservedTokens": number; "outstandingTokens": number; "settledTokens": number; "reservedCostMicros": number; "outstandingCostMicros": number; "estimatedSettledCostMicros": number; "unknownCostCount": number; }>; "nextOffset": (number | null); };
export type LegacyAnalysisLink = { "id": string; "investigationId": string; "analysisId": number; "legacy": true; "readOnly": true; };
export type AlertInvestigationResponse = { "success": boolean; "id"?: (string | number); "investigationId"?: string; "requestId"?: string; "analysisId"?: number; "sessionKey"?: string; "session_key"?: string; "status"?: string; "disposition"?: string; "error"?: string; };
export type InvestigationFeedbackRequest = ({ "resultId": string; "resultVersion": number; "expectedVersion": number; "note": string; "kind": "rating"; "rating": ("helpful" | "unhelpful" | "incorrect"); } | { "resultId": string; "resultVersion": number; "expectedVersion": number; "note": string; "kind": "handling"; "performedAt": string; "evidenceIds": Array<string>; } | { "resultId": string; "resultVersion": number; "expectedVersion": number; "note": string; "kind": "root_cause"; "verification": { "method": string; "from": string; "to": string; "evidenceIds": Array<string>; }; } | { "resultId": string; "resultVersion": number; "expectedVersion": number; "note": string; "kind": "recovery"; "verification": { "method": string; "from": string; "to": string; "evidenceIds": Array<string>; }; } | { "resultId": string; "resultVersion": number; "expectedVersion": number; "note": string; "kind": "close"; "lifecycle": ("closed" | "archived"); "problemStatus": ("unconfirmed" | "in_progress" | "resolved" | "not_applicable"); "verification"?: { "method": string; "from": string; "to": string; "evidenceIds": Array<string>; }; });
export type InvestigationFeedbackRecord = { "id": string; "investigationId": string; "actorId": number; "createdAt": string; "version": number; "command": ({ "resultId": string; "resultVersion": number; "expectedVersion": number; "note": string; "kind": "rating"; "rating": ("helpful" | "unhelpful" | "incorrect"); } | { "resultId": string; "resultVersion": number; "expectedVersion": number; "note": string; "kind": "handling"; "performedAt": string; "evidenceIds": Array<string>; } | { "resultId": string; "resultVersion": number; "expectedVersion": number; "note": string; "kind": "root_cause"; "verification": { "method": string; "from": string; "to": string; "evidenceIds": Array<string>; }; } | { "resultId": string; "resultVersion": number; "expectedVersion": number; "note": string; "kind": "recovery"; "verification": { "method": string; "from": string; "to": string; "evidenceIds": Array<string>; }; } | { "resultId": string; "resultVersion": number; "expectedVersion": number; "note": string; "kind": "close"; "lifecycle": ("closed" | "archived"); "problemStatus": ("unconfirmed" | "in_progress" | "resolved" | "not_applicable"); "verification"?: { "method": string; "from": string; "to": string; "evidenceIds": Array<string>; }; }); "staleResult": boolean; "references": Array<{ "id": string; "status": ("available" | "expired"); "contentHash": string; }>; "verification"?: { "method": string; "from": string; "to": string; "evidenceIds": Array<string>; "verifiedBy": number; "verifiedAt": string; "status": "human_confirmed"; }; };
export type InvestigationFeedbackPage = { "items": Array<{ "id": string; "investigationId": string; "actorId": number; "createdAt": string; "version": number; "command": ({ "resultId": string; "resultVersion": number; "expectedVersion": number; "note": string; "kind": "rating"; "rating": ("helpful" | "unhelpful" | "incorrect"); } | { "resultId": string; "resultVersion": number; "expectedVersion": number; "note": string; "kind": "handling"; "performedAt": string; "evidenceIds": Array<string>; } | { "resultId": string; "resultVersion": number; "expectedVersion": number; "note": string; "kind": "root_cause"; "verification": { "method": string; "from": string; "to": string; "evidenceIds": Array<string>; }; } | { "resultId": string; "resultVersion": number; "expectedVersion": number; "note": string; "kind": "recovery"; "verification": { "method": string; "from": string; "to": string; "evidenceIds": Array<string>; }; } | { "resultId": string; "resultVersion": number; "expectedVersion": number; "note": string; "kind": "close"; "lifecycle": ("closed" | "archived"); "problemStatus": ("unconfirmed" | "in_progress" | "resolved" | "not_applicable"); "verification"?: { "method": string; "from": string; "to": string; "evidenceIds": Array<string>; }; }); "staleResult": boolean; "references": Array<{ "id": string; "status": ("available" | "expired"); "contentHash": string; }>; "verification"?: { "method": string; "from": string; "to": string; "evidenceIds": Array<string>; "verifiedBy": number; "verifiedAt": string; "status": "human_confirmed"; }; }>; "nextBefore": (number | null); };
export type SystemEventSummary = { "eventId": string; "component": string; "occurredAt": string; "summary": string; "stableErrorCode": string; "disposition": ("accepted" | "linked" | "suppressed"); "suppressionReason": (string | null); "investigationId": (string | null); };
export type SystemEventDetail = { "eventId": string; "component": string; "occurredAt": string; "summary": string; "stableErrorCode": string; "disposition": ("accepted" | "linked" | "suppressed"); "suppressionReason": (string | null); "investigationId": (string | null); "fact": unknown; };
export type SystemEventsPage = { "items": Array<{ "eventId": string; "component": string; "occurredAt": string; "summary": string; "stableErrorCode": string; "disposition": ("accepted" | "linked" | "suppressed"); "suppressionReason": (string | null); "investigationId": (string | null); }>; "truncated": boolean; };

// Generated by pnpm contracts:generate. Do not edit.

export type DatabaseType = 'mysql' | 'postgresql' | 'oracle' | 'dameng' | 'mongodb' | 'redis' | 'elasticsearch';
export type CapabilityState = 'declared' | 'configured' | 'verified' | 'degraded' | 'unsupported';
export type AdapterCapabilityName = 'connect' | 'query' | 'explain' | 'metrics' | 'health' | 'alerts' | 'reports' | 'writeApproval';
export type InstanceHostRole = 'standalone' | 'primary' | 'replica' | 'shard' | 'arbiter' | 'unknown';
export type EvidenceQuality = 'good' | 'partial' | 'unknown' | 'unsupported';
export type HostEvidenceSection = 'metrics' | 'filesystems' | 'systemLogs' | 'physicalFiles';
export type DiagnosticGapScope = 'instance' | 'host' | 'storage';
export type DiagnosticGapSection = 'instance' | 'realtime' | 'history' | 'alerts' | 'logs' | 'slowQueries' | 'storage' | 'relations' | 'hostEvidence' | 'evidencePack';

export interface QueueTypeObservation {
  jobType: string; queued: number; retry: number; scheduled: number; ready: number;
  running: number; deadLetter: number; expiredLeases: number; oldestReadyWaitMs: number | null;
}
export interface QueueObservation {
  schemaVersion: 1; generatedAt: string; persistence: 'mysql';
  quality: 'good' | 'degraded' | 'unknown'; types: QueueTypeObservation[]; gaps: string[];
}
export interface PlatformObservations {
  schemaVersion: 1; generatedAt: string; releaseId: string | null; commitSha: string | null;
  uptimeSeconds: number; components: unknown[]; logs: unknown; queue: QueueObservation;
}

export interface EventResolveRequest { resolution_notes: string; }
export interface EventRecoveryConfirmationRequest { reason: string; }
export interface EventTransitionResult { success: boolean; error?: string; }

export type NetworkDeviceStatus = 'unknown' | 'online' | 'offline' | 'error' | 'unreachable';
export type NetworkDeviceVendor = 'huawei' | 'cisco';
export interface NetworkDevice { id: number; name: string; label: string | null; host: string; site: string | null; vendor: NetworkDeviceVendor; model: string | null; os_version: string | null; serial_number: string | null; snmp_port: number; ssh_port: number; status: NetworkDeviceStatus; last_check_at: string | null; collection_enabled: boolean; created_at: string; updated_at: string; hasSnmpCredential: boolean; hasSshCredential: boolean; }
export type NetworkDevicesResponse = NetworkDevice[];
export type NetworkDeviceSnmpSecurityLevel = 'noAuthNoPriv' | 'authNoPriv' | 'authPriv';
export interface NetworkDeviceSnmpCredential { username: string; securityLevel: NetworkDeviceSnmpSecurityLevel; authProtocol?: 'MD5' | 'SHA'; authSecret?: string; privacyProtocol?: 'DES' | 'AES'; privacySecret?: string; }
export interface NetworkDeviceSnmpV2Credential { version?: 2; community: string; }
export interface NetworkDeviceSshCredential { credentialType: 'password' | 'key'; username: string; credentialValue: string; hostKeyFingerprint?: string; }
export interface NetworkDeviceTestConnectionRequest { host: string; mode?: 'snmp' | 'ssh'; version?: 2 | 3; snmpPort?: number; snmp_port?: number; sshPort?: number; ssh_port?: number; snmpv3?: NetworkDeviceSnmpCredential; snmpv2c?: NetworkDeviceSnmpV2Credential; snmpv2?: NetworkDeviceSnmpV2Credential; snmp?: NetworkDeviceSnmpCredential | NetworkDeviceSnmpV2Credential; ssh?: NetworkDeviceSshCredential; vendor?: NetworkDeviceVendor; }
export interface NetworkDeviceProbeResult { reachable: boolean; quality: string; reason?: string | null; observedAt: string; sysName?: string | null; uptimeSeconds?: number; }
export interface NetworkDeviceTestConnectionResponse { success: boolean; probe?: NetworkDeviceProbeResult; ssh?: { verified: boolean }; error?: string; }
export interface NetworkDeviceProbeResponse { success: boolean; observations?: number; interfaces?: number; error?: string; }
export interface NetworkDeviceMetric { metricId: string; value: number | null; observedAt: string | null; quality: string; source: string; dimensions?: Record<string, string> | null; }
export interface NetworkDeviceMetricsResponse { deviceId: number; metrics: NetworkDeviceMetric[]; }
export interface NetworkDeviceInterface { id: number; deviceId: number; ifIndex: number; ifName: string; ifAlias: string | null; speedBps: number | null; adminStatus: string; operStatus: string; lastSeenAt: string | null; }
export interface NetworkDeviceInterfacesResponse { interfaces: NetworkDeviceInterface[]; }
export interface NetworkDeviceCapability { key: string; state: CapabilityState; evidence: Record<string, unknown> | null; reason: string | null; checkedAt: string | null; validUntil: string | null; }
export interface NetworkDeviceCapabilitiesResponse { deviceId: number; capabilities: NetworkDeviceCapability[]; }
export interface ConfigBackupSummary { id: number; deviceId: number; versionNo: number; contentSha256: string; sourceProtocol: 'ssh'; collectedAt: string; sizeBytes: number; redactionStatus: 'redacted' | 'unredacted' | 'failed'; }
export interface ConfigBackupScheduleInput { enabled: boolean; dailyTime: string; }
export interface ConfigBackupSchedule extends ConfigBackupScheduleInput { timeZone: 'Asia/Shanghai'; lastRun: { date: string; status: 'running' | 'success' | 'failed'; errorCode: string | null } | null; }
export interface ConfigBackupDetail extends ConfigBackupSummary { preview: string; }
export interface ConfigBackupRaw extends ConfigBackupSummary { content: string; }
export type ConfigBackupResponse = ConfigBackupDetail | ConfigBackupRaw;
export interface ConfigBackupDiffResponse { fromId: number; toId: number; diff: string; }
export interface ConfigBackupSummariesResponse { backups: ConfigBackupSummary[]; }
export type NetworkResourceType = 'instance' | 'server' | 'network_device';
export interface NetworkResourceRef { type: NetworkResourceType; id: number; }
export type NetworkDeviceRelationType = 'runs_on' | 'hosts' | 'replicates_to' | 'depends_on' | 'connected_to' | 'serves';
export interface NetworkDeviceRelation { source: NetworkResourceRef; target: NetworkResourceRef; relationType: NetworkDeviceRelationType; provenance: string; metadata: Record<string, unknown> | null; validFrom: string; validUntil: string | null; }
export interface NetworkDeviceRelationInput { target: { type: 'server' | 'network_device'; id: number }; relationType: 'connected_to' | 'serves'; provenance?: string; metadata?: Record<string, unknown> | null; validFrom?: string; validUntil?: string | null; }
export interface NetworkDeviceRelationsRequest { relations: NetworkDeviceRelationInput[]; }
export interface NetworkDeviceRelationsResponse { relations: NetworkDeviceRelation[]; }

export type ResourceType = 'instance' | 'server' | 'network_device';
export interface ResourceRef { type: ResourceType; id: number; }
export interface ResourceListItem { resource: ResourceRef; label: string; status: string; attributes: Record<string, string | number | boolean | null>; }
export interface ResourceListResponse { items: ResourceListItem[]; collectedAt: string; dataQuality: 'complete' | 'partial' | 'empty'; }
export interface ResourceOverviewItem { resource: ResourceRef; label: string; status: string; quality: 'good' | 'degraded' | 'invalid' | 'unknown' | 'partial'; freshness: 'fresh' | 'stale' | 'missing'; observedAt: string | null; unresolvedAlerts: number; relationCount: number; impactScope: ResourceRef[]; gaps: string[]; }
export interface ResourceOverviewResponse { schemaVersion: 1; collectedAt: string; dataQuality: 'complete' | 'partial' | 'empty'; summary: { total: number; byType: Record<ResourceType, number>; byStatus: Record<string, number>; fresh: number; stale: number; missing: number; unresolvedAlerts: number; impactedResources: number; }; items: ResourceOverviewItem[]; }
export interface ResourceMetricAggregate { value: number | null; resourceCount: number; observedAt: string | null; }
export interface ResourceMetricsSummaryResponse { schemaVersion: 1; collectedAt: string; dataQuality: 'complete' | 'partial' | 'empty'; scopes: Record<ResourceType, { metrics: Record<string, ResourceMetricAggregate> }>; }
export interface AnalysisEvidenceSnapshot { schemaVersion: 1; id: string; hash: string; collectedAt: string; subject: { type: 'instance' | 'server' | 'network_device'; id: number }; authorizationVersion: string; data: unknown; gaps: Array<{ code: string; scope?: string }> }
export interface ResourceAgentDiagnosisResponse { success: boolean; analysisId?: number; status?: 'queued' | 'cached' | 'unknown'; error?: string; }

export type CronRunStatus = 'queued' | 'running' | 'success' | 'partial' | 'failed' | 'unknown' | 'cancelled';
export interface CronRunAccepted { runId: string; jobId: number; status: CronRunStatus; message: string; }
export interface CronRun {
  runId: string; jobId: number; triggeredBy: number | null; status: CronRunStatus;
  queuedAt: string; startedAt: string | null; runnerFinishedAt: string | null; completedAt: string | null;
  completion: Record<string, unknown> | null; outputSchema: Record<string, unknown> | null;
  logId: number | null; errorCode: string | null;
}
export interface CronJobIdentity {
  owner_user_id: number | null;
  principal_type: 'user' | 'system-maintenance';
  identity_status: 'bound' | 'owner-required';
  identity_audit: Record<string, unknown> | null;
  resource_scope: { version: 1; targetInstanceId: number | null; instanceIds: number[]; serverIds: number[]; networkDeviceIds: number[] } | null;
  [key: string]: unknown;
}
export interface CronJobUpdateRequest {
  owner_user_id?: number; task_description?: string; cron_expr?: string; enabled?: boolean;
  task_type?: 'agent' | 'script'; target_instance_id?: number | null; script_id?: number;
  control_sql_capability?: 'read-only' | 'baseline-cleanup-v1' | 'silence-cleanup-v1';
  timezone?: string; description?: string; timeout_seconds?: number; retry_count?: number;
}

export interface LLMConnectionTestRequest { providerName: string; apiKey?: string; baseURL?: string; model?: string; apiFormat?: string; deploymentType?: string; }
export interface LLMModelDiscoveryRequest extends Omit<LLMConnectionTestRequest, 'model' | 'baseURL'> { baseURL: string; providerType?: 'deepseek' | 'stepfun' | 'mimo'; }

export interface InfrastructureReadiness { ready: boolean; }

export interface HealthResponse {
  status: 'ok';
  timestamp: string;
}

export interface AdapterCapability {
  dbType: DatabaseType;
  driver: string | null;
  state: CapabilityState;
  creatable: boolean;
  capabilities: Partial<Record<AdapterCapabilityName, CapabilityState>>;
  reason?: string;
}

export interface AdapterCapabilitiesResponse {
  adapters: AdapterCapability[];
}

export interface DatabaseInstance {
  id: number;
  name: string;
  db_type: DatabaseType;
  db_version?: string | null;
  data_size_gb?: number | null;
  host: string;
  port: number;
  database_name: string;
  username?: string | null;
  health_status: 'healthy' | 'warning' | 'critical' | 'unknown' | 'error';
  health_score: number;
  status: string;
  created_at: string;
  environment?: string | null;
  description?: string | null;
  hasCredential: boolean;
  credentialVersion: number;
  lifecycle_state?: 'available' | 'deleting' | 'deleted';
  removal_requested_at?: string | null;
  removed_at?: string | null;
  removal_reasons?: string[] | null;
  [key: string]: unknown;
}

export interface InstanceRemovalResponse {
  message?: string;
  error?: string;
  lifecycle_state: 'deleting' | 'deleted';
  reasons?: string[];
}

export type DatabaseInstancesResponse = DatabaseInstance[];

export interface InstanceHostMapping {
  serverId: number;
  role: InstanceHostRole;
  notes?: string | null;
}

export interface InstanceHost extends InstanceHostMapping {
  host: string;
  port: number;
  label: string | null;
  osType: string;
  status: string;
  collectionEnabled: boolean;
  validFrom: string;
}

export interface HostedInstance extends InstanceHostMapping {
  instanceId: number;
  name: string;
  dbType: DatabaseType;
  environment: string;
  status: string;
  healthStatus: string;
  validFrom: string;
}

export interface ReplaceInstanceHostsRequest {
  hosts: InstanceHostMapping[];
}

export interface InstanceHostsResponse {
  hosts: InstanceHost[];
}

export interface ReplaceInstanceHostsResponse extends InstanceHostsResponse {
  ok: true;
}

export interface HostedInstancesResponse {
  instances: HostedInstance[];
}

export type ServerDiagnosticQuality = 'good' | 'partial' | 'unknown' | 'unsupported';
export interface ServerDiagnosticServiceStatus { name: string; loadState: string; activeState: string; subState: string; description: string | null; }
export interface ServerDiagnosticListeningPort { protocol: 'tcp' | 'udp' | 'unknown'; address: string; port: number; process: string | null; }
export interface ServerDiagnosticProcessSample { pid: number; command: string; cpuPercent: number; memoryPercent: number; }
export interface ServerDiagnosticLogEntry { timestamp: string | null; severity: string; unit: string | null; identifier: string | null; message: string; }
export interface ServerInterfaceErrorSummary { interface: string; rxBytes: number; txBytes: number; rxErrors: number; txErrors: number; rxDrops: number; txDrops: number; }
export interface ServerDiagnosticSection<T> { source: string[]; collectedAt: string; expiresAt: string; validForMs: number; quality: ServerDiagnosticQuality; reason?: string; truncated: boolean; items: T[]; }
export interface ServerDiagnostics {
  schemaVersion: 1; serverId: number; osType: string; collectedAt: string; expiresAt: string; validForMs: number;
  quality: ServerDiagnosticQuality; truncated: boolean;
  sections: {
    services: ServerDiagnosticSection<ServerDiagnosticServiceStatus>;
    listeningPorts: ServerDiagnosticSection<ServerDiagnosticListeningPort>;
    topProcesses: ServerDiagnosticSection<ServerDiagnosticProcessSample>;
    systemLogs: ServerDiagnosticSection<ServerDiagnosticLogEntry>;
    interfaceErrors: ServerDiagnosticSection<ServerInterfaceErrorSummary>;
  };
  serviceStatus: ServerDiagnosticSection<ServerDiagnosticServiceStatus>;
  listeningPorts: ServerDiagnosticSection<ServerDiagnosticListeningPort>;
  topProcesses: ServerDiagnosticSection<ServerDiagnosticProcessSample>;
  recentSystemLogs: ServerDiagnosticSection<ServerDiagnosticLogEntry>;
  interfaceErrors: ServerDiagnosticSection<ServerInterfaceErrorSummary>;
  gaps: Array<{ section: string; reason: string }>;
}
export interface CollectServerDiagnosticsResponse { success: true; diagnostics: ServerDiagnostics; }

export interface EvidenceSection {
  source: string[];
  collectedAt: string;
  quality: EvidenceQuality;
  reason?: string;
}

export interface FilesystemEvidence {
  mount: string;
  device: string;
  fsType: string | null;
  sizeBytes: number;
  usedBytes: number;
  availableBytes: number;
  usagePercent: number;
  inodeTotal: number | null;
  inodeUsed: number | null;
  inodeAvailable: number | null;
  inodeUsagePercent: number | null;
}

export interface JournalEvidence {
  timestamp: string | null;
  severity: string;
  unit: string | null;
  identifier: string | null;
  pid: string | null;
  message: string;
}

export interface PhysicalFileEvidence {
  path: string;
  quality: EvidenceQuality;
  reason?: string;
  type?: string;
  sizeBytes?: number;
  allocatedBytes?: number;
  modifiedAt?: string;
  mode?: string;
  owner?: string;
  group?: string;
  filesystem?: FilesystemEvidence;
}

export interface HostEvidenceGap {
  section: HostEvidenceSection;
  reason: string;
}

export interface LinuxHostEvidence {
  schemaVersion: 1;
  serverId: number;
  collectedAt: string;
  expiresAt: string;
  quality: EvidenceQuality;
  truncated: boolean;
  metrics: EvidenceSection & { values: Record<string, number> };
  filesystems: EvidenceSection & { items: FilesystemEvidence[] };
  systemLogs: EvidenceSection & { entries: JournalEvidence[] };
  physicalFiles: EvidenceSection & { items: PhysicalFileEvidence[] };
  gaps: HostEvidenceGap[];
}

export interface StorageDescriptor {
  path: string;
  kind: string;
  source: string;
  hostInspectable: boolean;
  tablespace?: string;
  objectName?: string;
  logicalBytes?: number;
}

export interface DiagnosticGap {
  scope: DiagnosticGapScope;
  section?: DiagnosticGapSection;
  code: string;
  resource?: { type: 'instance' | 'server' | 'network_device'; id: number };
  source?: string;
}

export interface InstanceHostEvidenceResponse {
  schemaVersion: 1;
  subject: { type: 'instance'; id: number };
  collectedAt: string;
  database: {
    instance: Record<string, unknown> | null;
    realtimeMetrics: Record<string, unknown> | null;
    metricHistory: Array<Record<string, unknown>>;
    alerts: Array<Record<string, unknown>>;
    logs: Array<Record<string, unknown>>;
    slowQueries: Array<Record<string, unknown>>;
  };
  storage: StorageDescriptor[];
  hosts: Array<{ server: InstanceHost; evidence: LinuxHostEvidence | null }>;
  gaps: DiagnosticGap[];
}
