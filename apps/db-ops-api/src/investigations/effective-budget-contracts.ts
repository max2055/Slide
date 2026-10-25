import { Type, type Static } from '@sinclair/typebox';

const strict = { additionalProperties: false } as const;
const integer = (min: number, max: number) => Type.Integer({ minimum: min, maximum: max });

export const INVESTIGATION_EFFECTIVE_BUDGET_LIMITS = Object.freeze({
  contextWindowTokens: { min: 1, max: 1_000_000 },
  outputTokens: { min: 1, max: 1_000_000 },
  summaryOutputTokens: { min: 1, max: 1_000_000 },
  maxExecutionTokens: { min: 1, max: 1_000_000 },
  deadlineMs: { min: 1, max: 900_000 },
  maxToolCalls: { min: 1, max: 64 },
  maxProviderAttempts: { min: 1, max: 16 },
  maxRows: { min: 1, max: 1_000 },
  maxBytes: { min: 1, max: 1_000_000 },
  maxWindowMs: { min: 1, max: 86_400_000 },
});

export const InvestigationRuntimeAllocationSchema = Type.Object({
  contextWindowTokens: integer(1, 1_000_000),
  outputTokens: integer(1, 1_000_000),
  summaryOutputTokens: integer(1, 1_000_000),
  maxExecutionTokens: integer(1, 1_000_000),
}, strict);
export const InvestigationProfileLimitsSchema = Type.Object({
  deadlineMs: integer(1, 900_000),
  maxToolCalls: integer(1, 64),
  maxProviderAttempts: integer(1, 16),
  maxRows: integer(1, 1_000),
  maxBytes: integer(1, 1_000_000),
  maxWindowMs: integer(1, 86_400_000),
}, strict);

export type InvestigationRuntimeAllocation = Static<typeof InvestigationRuntimeAllocationSchema>;
export type InvestigationProfileLimits = Static<typeof InvestigationProfileLimitsSchema>;
