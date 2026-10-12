import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { validProjectionFrame, type ProjectionFrame } from '@slide/agent-core/message-projection';
import { validateAnalysisEnvelope, type AnalysisEnvelope } from '../analysis/analysis-envelope.js';
import type { AgentRunState } from '../adapter/agent-run-service.js';
import { LLM_SCENES } from '../llm/scene-routing.js';

// T01 is a contract baseline. These validators do no IO and grant no authority.
const strict = { additionalProperties: false } as const;
const text = (maxLength = 2_000) => Type.String({ minLength: 1, maxLength, pattern: '\\S' });
const id = () => text(128);
const ordinal = (minimum = 1) => Type.Integer({ minimum, maximum: Number.MAX_SAFE_INTEGER });
const utc = () => Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$' });
const hash = () => Type.String({ pattern: '^[a-f0-9]{64}$' });
const evidenceIds = (minItems = 0) => Type.Array(id(), { minItems, maxItems: 100, uniqueItems: true });
const resource = Type.Object({
  type: Type.Union([Type.Literal('instance'), Type.Literal('server'), Type.Literal('network_device')]), id: ordinal(),
}, strict);

export const InvestigationSubjectSchema = Type.Union([
  Type.Object({ kind: Type.Literal('resource'), resource }, strict),
  Type.Object({ kind: Type.Literal('platform'), component: text(128), releaseId: Type.Optional(id()) }, strict),
], { $id: 'InvestigationSubject' });
export type InvestigationSubject = Static<typeof InvestigationSubjectSchema>;

export const InvestigationLifecycleSchema = Type.Union([
  Type.Literal('open'), Type.Literal('waiting'), Type.Literal('closed'), Type.Literal('archived'),
], { $id: 'InvestigationLifecycle' });
export const InvestigationProblemStatusSchema = Type.Union([
  Type.Literal('unconfirmed'), Type.Literal('in_progress'), Type.Literal('resolved'), Type.Literal('not_applicable'),
], { $id: 'InvestigationProblemStatus' });
// Compile-time parity with the existing Run owner. No queued/unknown state added.
const knownRunStates = ['running', 'completed', 'failed', 'cancelled', 'timed_out'] as const satisfies readonly AgentRunState[];
export const InvestigationRunSchema = Type.Union([
  Type.Object({ state: Type.Union(knownRunStates.map(state => Type.Literal(state))), resolution: Type.Optional(Type.Literal('known')) }, strict),
  Type.Object({ state: Type.Literal('partial'), resolution: Type.Optional(Type.Union([Type.Literal('known'), Type.Literal('outcome_unknown')])) }, strict),
], { $id: 'InvestigationRun' });
export type InvestigationRun = Static<typeof InvestigationRunSchema>;
type RunParity = Exclude<AgentRunState, InvestigationRun['state']>;
const runParity: RunParity extends never ? true : never = true;
void runParity;
export const InvestigationExecutionStateSchema = Type.Union([
  ...knownRunStates.map(state => Type.Literal(state)), Type.Literal('partial'), Type.Literal('queued'), Type.Literal('unknown'),
], { $id: 'InvestigationExecutionState' });
export const InvestigationStatesSchema = Type.Object({
  execution: InvestigationExecutionStateSchema, lifecycle: InvestigationLifecycleSchema, problemStatus: InvestigationProblemStatusSchema,
}, { $id: 'InvestigationStates', ...strict });

export const INVESTIGATION_ERROR_STATUS = Object.freeze({
  INVESTIGATION_INPUT_INVALID: 400, INVESTIGATION_OPERATION_FORBIDDEN: 403, INVESTIGATION_NOT_FOUND: 404,
  INVESTIGATION_ACTIVE_REQUEST: 409, VERSION_CONFLICT: 409, IDEMPOTENCY_PAYLOAD_MISMATCH: 409,
  PROFILE_SUBJECT_UNSUPPORTED: 422, INVESTIGATION_BUDGET_EXHAUSTED: 429, INVESTIGATION_RATE_LIMITED: 429,
  INVESTIGATION_QUEUE_UNAVAILABLE: 503, EVIDENCE_EXPIRED: 410,
} as const);
export const InvestigationErrorCodeSchema = Type.Union(
  (Object.keys(INVESTIGATION_ERROR_STATUS) as Array<keyof typeof INVESTIGATION_ERROR_STATUS>).map(code => Type.Literal(code)),
  { $id: 'InvestigationErrorCode' },
);
export const InvestigationRecoveryReasonSchema = Type.Union([
  Type.Literal('MODEL_OUTCOME_UNKNOWN'), Type.Literal('LEASE_LOST'), Type.Literal('AUTHORITY_REVOKED'),
  Type.Literal('SOURCE_COMMIT_MISMATCH'), Type.Literal('EVIDENCE_MISSING'),
], { $id: 'InvestigationRecoveryReason' });

// Implementation requirements for T03; not a substitute for current live grants.
export const INVESTIGATION_PERMISSION_RULES = Object.freeze({
  toolAuthority: Object.freeze(['profile_allowlist', 'live_actor_grants', 'investigation_scope', 'live_tool_policy'] as const),
  visibility: 'all_required_scopes',
  revalidate: Object.freeze(['admission', 'execution', 'tool_call', 'model_call', 'subscription', 'content_read'] as const),
  ordinaryChatReadShareAllowsAppend: false, serviceActorMayInheritAdmin: false, modelMayGrantAuthority: false,
  serviceActorInteractiveLogin: false, authorizationVersionChangesRequireNewContext: true,
} as const);

const verificationFields = {
  method: text(), from: utc(), to: utc(), evidenceIds: evidenceIds(1), verifiedAt: utc(), verifiedBy: ordinal(),
};
export const InvestigationRecoveryVerificationSchema = Type.Object(verificationFields, { $id: 'InvestigationRecoveryVerification', ...strict });
export const InvestigationClosureSchema = Type.Object({
  lifecycle: Type.Union([Type.Literal('closed'), Type.Literal('archived')]),
  problemStatus: InvestigationProblemStatusSchema,
  verification: Type.Optional(InvestigationRecoveryVerificationSchema),
}, { $id: 'InvestigationClosure', ...strict });
export const InvestigationRootCauseVerificationSchema = Type.Union([
  Type.Object({ status: Type.Literal('unverified') }, strict),
  Type.Object({ status: Type.Literal('supported'), evidenceIds: evidenceIds(1) }, strict),
  Type.Object({ status: Type.Literal('human_confirmed'), ...verificationFields }, strict),
  Type.Object({ status: Type.Literal('experimentally_verified'), ...verificationFields }, strict),
], { $id: 'InvestigationRootCauseVerification' });
const references = { supportingEvidenceIds: evidenceIds(), contradictingEvidenceIds: evidenceIds() };
export const InvestigationResultSchema = Type.Object({
  schemaVersion: Type.Literal(2), subject: InvestigationSubjectSchema, summary: text(4_000),
  facts: Type.Array(Type.Object({ statement: text(4_000), evidenceIds: evidenceIds(1) }, strict), { maxItems: 100 }),
  hypotheses: Type.Array(Type.Object({ statement: text(), status: Type.Union([Type.Literal('supported'), Type.Literal('refuted'), Type.Literal('unknown')]), ...references }, strict), { maxItems: 50 }),
  claims: Type.Array(Type.Object({ statement: text(4_000), kind: Type.Union([Type.Literal('fact'), Type.Literal('inference')]), ...references }, strict), { maxItems: 100 }),
  rootCauseVerification: InvestigationRootCauseVerificationSchema,
  unresolvedQuestions: Type.Array(text(), { maxItems: 50 }),
  recommendations: Type.Array(Type.Object({ action: text(), priority: Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high'), Type.Literal('critical')]) }, strict), { maxItems: 50 }),
  problemStatus: InvestigationProblemStatusSchema,
  recoveryVerification: Type.Optional(InvestigationRecoveryVerificationSchema),
  provenance: Type.Object({
    modelVersion: text(256), promptVersion: text(256), toolVersions: Type.Record(text(128), text(128), { maxProperties: 100 }),
    providerId: Type.Optional(ordinal()), routeVersion: Type.Optional(text(256)), inputHash: Type.Optional(hash()),
    runtimeRunId: Type.Optional(id()), usageStatus: Type.Union([Type.Literal('available'), Type.Literal('unavailable'), Type.Literal('partial')]),
  }, strict), createdAt: utc(),
}, { $id: 'InvestigationResult', ...strict });
export type InvestigationResult = Static<typeof InvestigationResultSchema>;

export const OperationalEventSchema = Type.Object({
  schemaVersion: Type.Literal(1), id: id(), source: text(128), sourceEventId: id(), kind: text(128), subject: InvestigationSubjectSchema,
  occurredAt: utc(), receivedAt: utc(), severity: Type.Union([Type.Literal('info'), Type.Literal('warning'), Type.Literal('error'), Type.Literal('critical')]),
  summary: text(4_000), correlationId: Type.Optional(id()), releaseId: Type.Optional(id()),
  commitSha: Type.Optional(Type.String({ pattern: '^[a-f0-9]{40}$' })),
  origin: Type.Union([Type.Literal('user_operation'), Type.Literal('collector'), Type.Literal('workflow'), Type.Literal('investigation_engine')]),
  rawRef: Type.Optional(id()),
}, { $id: 'OperationalEvent', ...strict });
export type OperationalEvent = Static<typeof OperationalEventSchema>;

const streamFields = { schemaVersion: Type.Literal(1), sequence: ordinal(), investigationId: id(), occurredAt: utc() };
const requestFields = { requestId: id() };
const runFields = { runId: id(), requestId: Type.Optional(id()) };
// Shared schema is a TS/runtime contract, not a second Parts/tool state machine.
const projectionFrame = Type.Unsafe<ProjectionFrame>({ ...Type.Unknown(), 'x-typescript-type': 'ProjectionFrame' });
const terminalRun = Type.Union([
  Type.Object({ state: Type.Union(knownRunStates.filter(state => state !== 'running').map(state => Type.Literal(state))), resolution: Type.Optional(Type.Literal('known')) }, strict),
  InvestigationRunSchema.anyOf[1],
]);
export const InvestigationStreamEventSchema = Type.Union([
  Type.Object({ ...streamFields, ...requestFields, type: Type.Literal('request.accepted'), payload: Type.Object({ jobId: id(), version: ordinal() }, strict) }, strict),
  Type.Object({ ...streamFields, ...runFields, type: Type.Literal('run.started'), payload: Type.Object({}, strict) }, strict),
  Type.Object({ ...streamFields, ...runFields, type: Type.Literal('parts.operation'), payload: projectionFrame }, strict),
  Type.Object({ ...streamFields, ...runFields, type: Type.Literal('evidence.added'), payload: Type.Object({ evidenceId: id() }, strict) }, strict),
  Type.Object({ ...streamFields, ...runFields, type: Type.Literal('result.persisted'), payload: Type.Object({ resultId: id(), resultVersion: ordinal(), schemaVersion: Type.Literal(2) }, strict) }, strict),
  Type.Object({ ...streamFields, ...runFields, type: Type.Literal('run.terminal'), payload: terminalRun }, strict),
  Type.Object({ ...streamFields, requestId: Type.Optional(id()), runId: Type.Optional(id()), type: Type.Literal('investigation.changed'), payload: Type.Object({ version: ordinal(), lifecycle: InvestigationLifecycleSchema, problemStatus: InvestigationProblemStatusSchema }, strict) }, strict),
], { $id: 'InvestigationStreamEvent' });
export type InvestigationStreamEvent = Static<typeof InvestigationStreamEventSchema>;

const versionedHash = { version: text(128), hash: hash() };
const profileFields = {
  version: ordinal(), responsibility: text(), modelScene: Type.Union(LLM_SCENES.map(scene => Type.Literal(scene))), prompt: Type.Object(versionedHash, strict),
  skills: Type.Array(Type.Object({ id: id(), ...versionedHash }, strict), { maxItems: 50 }),
  toolAllowlist: Type.Array(Type.String({ minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$' }), { maxItems: 100, uniqueItems: true }),
  outputSchemaVersion: Type.Literal(2), resourceBoundary: Type.Literal('all_required_scopes'), readonly: Type.Literal(true),
  budget: Type.Object({ deadlineMs: ordinal(), maxToolCalls: ordinal(), maxProviderAttempts: ordinal(), maxTokens: ordinal(), maxRows: ordinal(), maxBytes: ordinal(), maxWindowMs: ordinal() }, strict),
  outputLanguage: text(32),
};
export const InvestigationProfileSchema = Type.Union([
  Type.Object({ id: Type.Literal('system'), supportedSubjectKinds: Type.Array(Type.Literal('platform'), { minItems: 1, maxItems: 1 }), ...profileFields }, strict),
  Type.Object({ id: Type.Literal('ops'), supportedSubjectKinds: Type.Array(Type.Literal('resource'), { minItems: 1, maxItems: 1 }), ...profileFields }, strict),
], { $id: 'InvestigationProfile' });
export type InvestigationProfile = Static<typeof InvestigationProfileSchema>;

export const InvestigationSchemas = {
  InvestigationSubject: InvestigationSubjectSchema, InvestigationRun: InvestigationRunSchema,
  InvestigationLifecycle: InvestigationLifecycleSchema, InvestigationProblemStatus: InvestigationProblemStatusSchema,
  InvestigationExecutionState: InvestigationExecutionStateSchema, InvestigationStates: InvestigationStatesSchema,
  InvestigationErrorCode: InvestigationErrorCodeSchema, InvestigationRecoveryReason: InvestigationRecoveryReasonSchema,
  InvestigationRecoveryVerification: InvestigationRecoveryVerificationSchema, InvestigationClosure: InvestigationClosureSchema,
  InvestigationRootCauseVerification: InvestigationRootCauseVerificationSchema, InvestigationResult: InvestigationResultSchema,
  OperationalEvent: OperationalEventSchema, InvestigationStreamEvent: InvestigationStreamEventSchema, InvestigationProfile: InvestigationProfileSchema,
} as const satisfies Record<string, TSchema>;

type Validation<T> = { ok: true; value: T } | { ok: false; error: string };
const invalid = (): { ok: false; error: string } => ({ ok: false, error: 'INVESTIGATION_INPUT_INVALID' });
function validInstant(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === (value.includes('.') ? value : value.replace('Z', '.000Z'));
}
function validVerification(value: Static<typeof InvestigationRecoveryVerificationSchema>, bindings: ReadonlySet<string>): boolean {
  return [value.from, value.to, value.verifiedAt].every(validInstant)
    && Date.parse(value.from) < Date.parse(value.to) && Date.parse(value.verifiedAt) >= Date.parse(value.to)
    && value.evidenceIds.every(ref => bindings.has(ref));
}
const noBindings: ReadonlySet<string> = new Set();

/** Caller supplies current, authorized, unexpired evidence of this investigation.
 * Verifier identity and verification record must come from authenticated server
 * facts, never model output. This checks shape/binding, not authorization/truth. */
export function validateInvestigationClosure(value: unknown, bindings: ReadonlySet<string> = noBindings): Validation<Static<typeof InvestigationClosureSchema>> {
  if (!Value.Check(InvestigationClosureSchema, value)) return invalid();
  if (value.problemStatus === 'resolved' && !value.verification) return invalid();
  if (value.verification && !validVerification(value.verification, bindings)) return invalid();
  return { ok: true, value };
}
export function projectInvestigationRun(value: unknown): Static<typeof InvestigationExecutionStateSchema> {
  if (!Value.Check(InvestigationRunSchema, value)) throw new Error('INVESTIGATION_INPUT_INVALID');
  return value.resolution === 'outcome_unknown' ? 'unknown' : value.state;
}
/** A contract guard for the existing Run owner, not another state machine. */
export function validateInvestigationRunTransition(previous: unknown, next: unknown): Validation<InvestigationRun> {
  if (!Value.Check(InvestigationRunSchema, previous) || !Value.Check(InvestigationRunSchema, next)) return invalid();
  if (previous.state !== 'running' && (previous.state !== next.state
    || (previous.resolution ?? 'known') !== (next.resolution ?? 'known'))) return invalid();
  return { ok: true, value: next };
}
export function validateOperationalEvent(value: unknown): Validation<OperationalEvent> {
  if (!Value.Check(OperationalEventSchema, value) || !validInstant(value.occurredAt) || !validInstant(value.receivedAt)) return invalid();
  return { ok: true, value };
}
export function validateInvestigationStreamEvent(value: unknown): Validation<InvestigationStreamEvent> {
  if (!Value.Check(InvestigationStreamEventSchema, value) || !validInstant(value.occurredAt)) return invalid();
  if (value.type === 'parts.operation' && !validProjectionFrame(value.payload, value.runId)) return invalid();
  return { ok: true, value };
}
export function validateInvestigationProfile(value: unknown): Validation<InvestigationProfile> {
  return Value.Check(InvestigationProfileSchema, value) ? { ok: true, value } : invalid();
}
export function validateInvestigationResult(value: unknown, bindings: ReadonlySet<string> = noBindings): Validation<InvestigationResult> {
  if (!Value.Check(InvestigationResultSchema, value) || !validInstant(value.createdAt)) return invalid();
  const refs = value.facts.flatMap(fact => fact.evidenceIds);
  for (const claim of value.claims) {
    if (claim.kind === 'fact' && claim.supportingEvidenceIds.length === 0) return invalid();
    refs.push(...claim.supportingEvidenceIds, ...claim.contradictingEvidenceIds);
  }
  for (const hypothesis of value.hypotheses) {
    if (hypothesis.status === 'supported' && hypothesis.supportingEvidenceIds.length === 0
      || hypothesis.status === 'refuted' && hypothesis.contradictingEvidenceIds.length === 0) return invalid();
    refs.push(...hypothesis.supportingEvidenceIds, ...hypothesis.contradictingEvidenceIds);
  }
  const root = value.rootCauseVerification;
  if (root.status !== 'unverified') refs.push(...root.evidenceIds);
  if (root.status === 'human_confirmed' || root.status === 'experimentally_verified') {
    if (!validVerification(root, bindings)) return invalid();
  }
  if (!refs.every(ref => bindings.has(ref))) return invalid();
  if (!validateInvestigationClosure({ lifecycle: 'closed', problemStatus: value.problemStatus,
    ...(value.recoveryVerification ? { verification: value.recoveryVerification } : {}) }, bindings).ok) return invalid();
  return { ok: true, value };
}
export function readInvestigationResult(value: unknown, legacyMarkdown = '', bindings: ReadonlySet<string> = noBindings):
  | { kind: 'v1'; value: AnalysisEnvelope }
  | { kind: 'v2'; value: InvestigationResult }
  | { kind: 'legacy'; displayMarkdown: string } {
  const v1 = validateAnalysisEnvelope(value);
  if (v1.ok) return { kind: 'v1', value: v1.value };
  const v2 = validateInvestigationResult(value, bindings);
  if (v2.ok) return { kind: 'v2', value: v2.value };
  return { kind: 'legacy', displayMarkdown: legacyMarkdown };
}
