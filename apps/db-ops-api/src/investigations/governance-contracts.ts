import { Type, type Static } from '@sinclair/typebox';
import { InvestigationAdmissionPolicySchema, InvestigationProfileLimitsSchema, InvestigationRuntimeAllocationSchema } from './effective-budget-contracts.js';

const strict = { additionalProperties: false } as const;
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const nullableCount = Type.Union([count, Type.Null()]);
const isoInstant = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$';
const states = Type.Object({ reserved: count, sent: count, settled: count, unknown: count, cancelled: count }, strict);
export const InvestigationBudgetPolicySchema = Type.Object({
  currency: Type.String({ pattern: '^[A-Z]{3}$' }), maxConcurrent: count, manualReserved: count,
  maxPerResourceConcurrent: count, maxAutomaticRequestsPerHour: count,
  maxAutomaticTokensPerDay: count, maxTotalTokensPerDay: count, maxCostMicrosPerDay: count,
}, strict);

// Read-only automatic-analysis facts. Configuration completeness, switches,
// entry wiring, live identity/permission facts, budget readiness and observed
// receipts are separate facts: none of them alone claims model execution.
export const InvestigationPolicyBlockerCodeSchema = Type.Union([
  Type.Literal('MASTER_CONFIG_INVALID'), Type.Literal('MASTER_SWITCH_DISABLED'),
  Type.Literal('INVESTIGATION_SWITCH_DISABLED'), Type.Literal('SERVICE_IDENTITY_NOT_CONFIGURED'),
  Type.Literal('SERVICE_IDENTITY_NOT_FOUND'), Type.Literal('SERVICE_IDENTITY_INVALID'),
  Type.Literal('SERVICE_IDENTITY_DISABLED'), Type.Literal('SERVICE_PERMISSIONS_MISSING'),
  Type.Literal('RESOURCE_SCOPE_NOT_CONFIGURED'), Type.Literal('RESOURCE_SCOPE_INVALID'),
  Type.Literal('RESOURCE_UNAVAILABLE'), Type.Literal('RESOURCE_PERMISSION_MISSING'),
  Type.Literal('RESOURCE_INSTANCE_SCOPE_MISSING'), Type.Literal('BUDGET_UNAVAILABLE'),
  Type.Literal('BUDGET_UNINITIALIZED'), Type.Literal('BUDGET_CONFLICT'), Type.Literal('BUDGET_QUOTA_REACHED'),
  Type.Literal('ENTRY_NOT_OBSERVED'),
]);
export const InvestigationPoliciesResponseSchema = Type.Object({
  schemaVersion: Type.Literal(2), source: Type.Literal('production_composition'),
  originBoundary: Type.Literal('investigation_engine_persist_only'),
  // The repository-owned pilot definition only. It is not resource coverage.
  policy: Type.Object({ id: Type.Literal('database-alert-pilot'), version: Type.Literal(1), profileId: Type.Literal('ops'),
    source: Type.Literal('database-alert-engine'), readonly: Type.Literal(true) }, strict),
  configurationStatus: Type.Union([Type.Literal('not_configured'), Type.Literal('invalid'), Type.Literal('configured')]),
  masterSwitch: Type.Object({
    source: Type.Union([Type.Literal('system_config'), Type.Literal('defaults')]),
    status: Type.Union([Type.Literal('persisted'), Type.Literal('defaulted'), Type.Literal('invalid')]),
    enabled: Type.Boolean(),
    severityLevels: Type.Array(Type.Union([Type.Literal('info'), Type.Literal('warning'), Type.Literal('error'),
      Type.Literal('critical')]), { maxItems: 4 }),
    timeWindowStart: Type.String({ pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }),
    timeWindowEnd: Type.String({ pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }),
    // Historical whitelist is database-only; no instance identifiers escape.
    instanceWhitelistCount: count,
  }, strict),
  investigationSwitch: Type.Object({ enabled: Type.Boolean(), manualEnabled: Type.Boolean(),
    legacyEnabled: Type.Boolean(), source: Type.Literal('environment') }, strict),
  serviceIdentity: Type.Object({
    status: Type.Union([Type.Literal('not_configured'), Type.Literal('not_found'), Type.Literal('invalid'),
      Type.Literal('disabled'), Type.Literal('ready')]),
    permissionsSufficient: Type.Boolean(),
    missingPermissions: Type.Array(Type.String({ pattern: '^[a-z][a-z_]*:[a-z*]+$' }), { maxItems: 8 }),
    instanceScopeSufficient: Type.Boolean(),
  }, strict),
  resourceCoverage: Type.Array(Type.Object({
    type: Type.Union([Type.Literal('database'), Type.Literal('server'), Type.Literal('network_device')]),
    status: Type.Union([Type.Literal('not_configured'), Type.Literal('covered'), Type.Literal('partial'),
      Type.Literal('unavailable')]),
    configuredCount: count, existingCount: count, permittedCount: count, typePermission: Type.Boolean(),
  }, strict), { maxItems: 3 }),
  entry: Type.Object({
    status: Type.Union([Type.Literal('not_connected'), Type.Literal('unverified'), Type.Literal('connected')]),
    observedReceiptCount: count,
    lastObservedAt: Type.Union([Type.String({ pattern: isoInstant }), Type.Null()]),
  }, strict),
  budget: Type.Object({ status: Type.Union([Type.Literal('uninitialized'), Type.Literal('matching'),
    Type.Literal('conflict'), Type.Literal('unavailable')]), quotaReached: Type.Boolean() }, strict),
  latestOutcome: Type.Object({
    total: count, accepted: count, suppressed: count, pending: count, unknown: count,
    lastStatus: Type.Union([Type.Literal('accepted'), Type.Literal('suppressed'), Type.Literal('pending'),
      Type.Literal('unknown'), Type.Null()]),
    lastReason: Type.Union([Type.String({ pattern: '^[A-Z][A-Z0-9_]{0,63}$' }), Type.Null()]),
    lastAttemptAt: Type.Union([Type.String({ pattern: isoInstant }), Type.Null()]),
  }, strict),
  automaticAnalysisStatus: Type.Union([Type.Literal('available'), Type.Literal('unverified'), Type.Literal('blocked')]),
  blockers: Type.Array(Type.Object({
    code: InvestigationPolicyBlockerCodeSchema,
    layer: Type.Union([Type.Literal('configuration'), Type.Literal('switch'), Type.Literal('wiring'),
      Type.Literal('authorization'), Type.Literal('budget'), Type.Literal('resources')]),
    remediation: Type.Union([Type.Literal('analysis_settings'), Type.Literal('budget_settings'),
      Type.Literal('user_permissions'), Type.Literal('deployment_environment'), Type.Literal('alert_engine'),
      Type.Literal('none')]),
  }, strict), { maxItems: 12 }),
}, { ...strict, $id: 'InvestigationPoliciesResponse' });
export const InvestigationBudgetResponseSchema = Type.Object({
  schemaVersion: Type.Literal(1), source: Type.Literal('investigationBudgetConfiguration'),
  policy: InvestigationBudgetPolicySchema, reserveCostMicros: count,
  persistedPolicy: Type.Union([InvestigationBudgetPolicySchema, Type.Null()]),
  admissionStatus: Type.Union([Type.Literal('uninitialized'), Type.Literal('matching'), Type.Literal('conflict')]),
  automaticTriggerStatus: Type.Union([Type.Literal('not_connected'), Type.Literal('connected')]), window: Type.Literal('UTC_admission_day_and_hour'),
  profileLimitsSource: Type.Literal('/api/investigation-profiles'),
  domain: Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' }),
  admissionRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  policySource: Type.Union([Type.Literal('settings'), Type.Literal('configuration')]),
}, { ...strict, $id: 'InvestigationBudgetResponse' });
export const InvestigationUsageResponseSchema = Type.Object({
  schemaVersion: Type.Literal(1), accessScope: Type.Literal('global_config_management'),
  window: Type.Literal('all_history'), costSemantics: Type.Literal('rate_estimate_not_provider_invoice'),
  tokenSemantics: Type.Literal('input_includes_cached_input'),
  total: count, counts: states, knownUsageCount: count, unknownUsageCount: count, pendingUsageCount: count,
  reservedTokens: count, outstandingTokens: count, settledTokens: count,
  costs: Type.Array(Type.Object({ currency: Type.String({ pattern: '^[A-Z]{3}$' }),
    reservedCostMicros: count, outstandingCostMicros: count, estimatedSettledCostMicros: count }, strict)),
  groupCount: count,
  items: Type.Array(Type.Object({
    state: Type.Union(['reserved', 'sent', 'settled', 'unknown', 'cancelled'].map(value => Type.Literal(value))),
    mode: Type.Union([Type.Literal('automatic'), Type.Literal('manual')]),
    currency: Type.String({ pattern: '^[A-Z]{3}$' }), count,
    knownUsageCount: count, unknownUsageCount: count, pendingUsageCount: count,
    knownInputTokens: count, knownCachedInputTokens: count, knownOutputTokens: count,
    reservedTokens: count, outstandingTokens: count, settledTokens: count,
    reservedCostMicros: count, outstandingCostMicros: count, estimatedSettledCostMicros: count,
    unknownCostCount: count,
  }, strict), { maxItems: 50 }), nextOffset: nullableCount,
}, { ...strict, $id: 'InvestigationUsageResponse' });

const effectiveBudgetDocument = Type.Object({
  schemaVersion: Type.Literal(1), version: count, runtime: InvestigationRuntimeAllocationSchema,
  profileLimits: InvestigationProfileLimitsSchema,
  admission: Type.Optional(Type.Object({ revision: count, policy: InvestigationAdmissionPolicySchema }, strict)),
  updatedAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$' }),
  updatedBy: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
}, strict);
export const InvestigationEffectiveBudgetViewSchema = Type.Object({
  schemaVersion: Type.Literal(1), source: Type.Union([Type.Literal('settings'), Type.Literal('defaults')]),
  effective: effectiveBudgetDocument, defaults: effectiveBudgetDocument,
  provider: Type.Union([Type.Object({ model: Type.String({ minLength: 1 }), contextWindowTokens: count,
    maxOutputTokens: Type.Optional(count), preferredOutputTokens: Type.Optional(count),
    source: Type.Union([Type.Literal('configuration'), Type.Literal('catalog'), Type.Literal('conservative-fallback')]) }, strict), Type.Null()]),
  capabilityVerified: Type.Boolean(),
  admission: Type.Object({ domain: Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' }),
    revision: count, source: Type.Union([Type.Literal('settings'), Type.Literal('defaults')]) }, strict),
}, strict);

export type InvestigationPoliciesResponse = Static<typeof InvestigationPoliciesResponseSchema>;
export type InvestigationBudgetResponse = Static<typeof InvestigationBudgetResponseSchema>;
export type InvestigationUsageResponse = Static<typeof InvestigationUsageResponseSchema>;
export type InvestigationEffectiveBudgetView = Static<typeof InvestigationEffectiveBudgetViewSchema>;
export const InvestigationGovernanceSchemas = {
  InvestigationPoliciesResponse: InvestigationPoliciesResponseSchema,
  InvestigationBudgetResponse: InvestigationBudgetResponseSchema,
  InvestigationUsageResponse: InvestigationUsageResponseSchema,
  InvestigationEffectiveBudgetView: InvestigationEffectiveBudgetViewSchema,
};
