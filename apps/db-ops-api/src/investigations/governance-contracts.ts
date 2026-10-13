import { Type, type Static } from '@sinclair/typebox';

const strict = { additionalProperties: false } as const;
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const nullableCount = Type.Union([count, Type.Null()]);
const states = Type.Object({ reserved: count, sent: count, settled: count, unknown: count, cancelled: count }, strict);
export const InvestigationBudgetPolicySchema = Type.Object({
  currency: Type.String({ pattern: '^[A-Z]{3}$' }), maxConcurrent: count, manualReserved: count,
  maxPerResourceConcurrent: count, maxAutomaticRequestsPerHour: count,
  maxAutomaticTokensPerDay: count, maxTotalTokensPerDay: count, maxCostMicrosPerDay: count,
}, strict);

// Repository/operator-owned database pilot only. Runtime grants/budget are
// rechecked at ingestion; configuration does not imply authorization.
export const InvestigationPoliciesResponseSchema = Type.Object({
  schemaVersion: Type.Literal(1), configurationStatus: Type.Union([Type.Literal('not_configured'), Type.Literal('configured')]),
  integrationStatus: Type.Union([Type.Literal('not_connected'), Type.Literal('connected')]), source: Type.Literal('production_composition'),
  items: Type.Array(Type.Object({ id: Type.Literal('database-alert-pilot'), version: Type.Literal(1), profileId: Type.Literal('ops'),
    source: Type.Literal('database-alert-engine'), enabled: Type.Boolean(), readonly: Type.Literal(true) }, strict), { maxItems: 1 }),
  originBoundary: Type.Literal('investigation_engine_persist_only'),
}, { ...strict, $id: 'InvestigationPoliciesResponse' });
export const InvestigationBudgetResponseSchema = Type.Object({
  schemaVersion: Type.Literal(1), source: Type.Literal('investigationBudgetConfiguration'),
  policy: InvestigationBudgetPolicySchema, reserveCostMicros: count,
  persistedPolicy: Type.Union([InvestigationBudgetPolicySchema, Type.Null()]),
  admissionStatus: Type.Union([Type.Literal('uninitialized'), Type.Literal('matching'), Type.Literal('conflict')]),
  automaticTriggerStatus: Type.Union([Type.Literal('not_connected'), Type.Literal('connected')]), window: Type.Literal('UTC_admission_day_and_hour'),
  profileLimitsSource: Type.Literal('/api/investigation-profiles'),
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

export type InvestigationBudgetResponse = Static<typeof InvestigationBudgetResponseSchema>;
export type InvestigationUsageResponse = Static<typeof InvestigationUsageResponseSchema>;
export const InvestigationGovernanceSchemas = {
  InvestigationPoliciesResponse: InvestigationPoliciesResponseSchema,
  InvestigationBudgetResponse: InvestigationBudgetResponseSchema,
  InvestigationUsageResponse: InvestigationUsageResponseSchema,
};
