/**
 * MAX-238 / B2E — strict persistence codec for the per-resource binding row.
 *
 * One physical row (`metric_policy_bindings.payload`) carries either the legacy
 * single-package `Published` value or the template `templates-v1` envelope. This
 * module is the only place that decides which one a stored payload is, validates
 * every field of the template form, and builds the next pending payload while
 * preserving the previously effective snapshot. It never talks to a database,
 * never mutates its input, and never echoes a payload or a driver message in an
 * error: every failure is a stable machine code.
 *
 * It is still **unmounted**: no reader, store, route or scheduler imports it in
 * this package. `bindingPayloadSource` is the minimal fence a legacy reader can
 * call before decoding; changing that reader is a later wiring package.
 */
import { z } from 'zod';
import { TimestampSchema } from '../../contracts/metrics/definitions.js';
import {
  HashIdSchema, ResourceBindingCandidateSchema,
  type HashId, type ResourceBindingCandidate,
} from '../../contracts/metrics/templates.js';
import type { TemplateCollectionPlan } from './plan.js';

/** The storage discriminant of the template form. It lives at the top level only. */
export const BINDING_PAYLOAD_ENVELOPE = 'templates-v1';

export type BindingPersistenceErrorCode =
  | 'BINDING_PAYLOAD_INVALID_JSON'
  | 'BINDING_PAYLOAD_NOT_OBJECT'
  | 'BINDING_PAYLOAD_UNKNOWN_ENVELOPE'
  | 'BINDING_PAYLOAD_SHAPE_INVALID'
  | 'BINDING_PAYLOAD_AMBIGUOUS_SOURCE'
  | 'BINDING_PAYLOAD_MISSING_SOURCE'
  | 'BINDING_PAYLOAD_LEGACY_INVALID'
  | 'BINDING_PAYLOAD_BINDING_INVALID'
  | 'BINDING_PAYLOAD_PENDING_INVALID'
  | 'BINDING_PAYLOAD_APPLICATION_INVALID'
  | 'BINDING_PAYLOAD_REVISION_INVALID'
  | 'BINDING_PAYLOAD_IDENTITY_MISMATCH'
  | 'BINDING_PAYLOAD_PLAN_INVALID'
  | 'BINDING_PAYLOAD_EFFECTIVE_INVALID';

export class BindingPersistenceError extends Error {
  constructor(public readonly code: BindingPersistenceErrorCode) {
    super(code);
    this.name = 'BindingPersistenceError';
  }
}

const fail = (code: BindingPersistenceErrorCode): never => {
  throw new BindingPersistenceError(code);
};

const MAX_REVISION = Number.MAX_SAFE_INTEGER;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
};

const RevisionSchema = z.number().int().nonnegative().max(MAX_REVISION);
const TargetRevisionSchema = z.number().int().positive().max(MAX_REVISION);
const OperationKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:#@-]{0,1023}$/);

/** The legacy `Applied` value written by `policy/store.ts`; it has no resolution identity. */
const LegacyApplicationSchema = z.strictObject({
  applied_revision: TargetRevisionSchema.nullable(),
  reported_at: TimestampSchema.nullable(),
  status: z.enum(['pending', 'applied', 'failed']),
  error_code: z.literal('apply_failed').nullable(),
});
const LegacyPayloadSchema = z.strictObject({
  binding: z.unknown(),
  resolved: z.record(z.string(), z.unknown()),
  published_at: TimestampSchema,
  application: LegacyApplicationSchema,
});
/** The template form's application state: the previous applied revision is preserved, never promoted. */
const TemplateApplicationSchema = z.strictObject({
  status: z.enum(['pending', 'applied', 'failed']),
  applied_revision: TargetRevisionSchema.nullable(),
  reported_at: TimestampSchema.nullable(),
  error_code: z.literal('apply_failed').nullable(),
  resolution_identity: HashIdSchema.nullable(),
});
const PendingSchema = z.strictObject({
  base_revision: RevisionSchema,
  target_revision: TargetRevisionSchema,
  resolution_identity: HashIdSchema,
  plan: z.unknown(),
  decided_at: TimestampSchema,
  operation_key: OperationKeySchema,
});

/**
 * The previously effective plan, tagged by where it came from. A package snapshot
 * keeps the legacy `resolved` value untouched; a template snapshot keeps its plan
 * and resolution identity. Neither is ever the current pending plan.
 */
export type EffectiveSnapshot =
  | {
    source: 'package';
    revision: number;
    resolution_identity: null;
    resolved: Record<string, unknown>;
  }
  | {
    source: 'template';
    revision: number;
    resolution_identity: HashId;
    plan: TemplateCollectionPlan;
  };

export interface DecodedLegacyBindingPayload {
  kind: 'legacy_published';
  source: 'package';
  /** The exact stored value (deep copy); re-encoding it reproduces the row unchanged. */
  payload: Record<string, unknown>;
  /** The normalized candidate (`template_pins` defaults to an empty array). */
  binding: ResourceBindingCandidate;
  application: {
    status: 'pending' | 'applied' | 'failed';
    applied_revision: number | null;
    reported_at: string | null;
    error_code: 'apply_failed' | null;
  };
  effective: EffectiveSnapshot | null;
  /** True when `applied_revision` names no revision this row can prove a plan for. */
  effective_missing: boolean;
}

export interface DecodedTemplateBindingPayload {
  kind: 'template_pending';
  source: 'template';
  payload: Record<string, unknown>;
  binding: ResourceBindingCandidate;
  pending: {
    base_revision: number;
    target_revision: number;
    resolution_identity: HashId;
    plan: TemplateCollectionPlan;
    decided_at: string;
    operation_key: string;
  };
  application: {
    status: 'pending' | 'applied' | 'failed';
    applied_revision: number | null;
    reported_at: string | null;
    error_code: 'apply_failed' | null;
    resolution_identity: HashId | null;
  };
  effective: EffectiveSnapshot | null;
  effective_missing: false;
  published_at: string;
}

export type DecodedBindingPayload = DecodedLegacyBindingPayload | DecodedTemplateBindingPayload;
export type BindingPayloadSource = 'package' | 'template';

/**
 * The minimal fence for a legacy reader: it answers which form a payload is and
 * rejects anything ambiguous or malformed. A reader must skip/reject a template
 * payload instead of falling through a single-package path.
 */
export function bindingPayloadSource(raw: string | unknown): BindingPayloadSource {
  return decodeBindingPayload(raw).source;
}

const parseText = (raw: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail('BINDING_PAYLOAD_INVALID_JSON');
  }
  if (!isPlainObject(parsed)) return fail('BINDING_PAYLOAD_NOT_OBJECT');
  return parsed;
};

const clone = (raw: unknown): Record<string, unknown> => {
  if (!isPlainObject(raw)) return fail('BINDING_PAYLOAD_NOT_OBJECT');
  let copied: unknown;
  try {
    copied = structuredClone(raw);
  } catch {
    // A value that cannot be cloned is not a JSON row.
    return fail('BINDING_PAYLOAD_NOT_OBJECT');
  }
  return copied as Record<string, unknown>;
};

/**
 * Decode one stored payload. `string` input is parsed as JSON; object input is
 * deep-copied first, so neither validation nor a later encode can mutate it.
 */
export function decodeBindingPayload(raw: string | unknown): DecodedBindingPayload {
  const payload = typeof raw === 'string' ? parseText(raw) : clone(raw);

  const hasEnvelope = Object.hasOwn(payload, 'envelope');
  if (hasEnvelope) {
    if (payload.envelope !== BINDING_PAYLOAD_ENVELOPE) return fail('BINDING_PAYLOAD_UNKNOWN_ENVELOPE');
    return decodeTemplatePayload(payload);
  }
  return decodeLegacyPayload(payload);
}

function decodeLegacyPayload(payload: Record<string, unknown>): DecodedLegacyBindingPayload {
  if (!isPlainObject(payload.binding)) return fail('BINDING_PAYLOAD_BINDING_INVALID');
  const binding = payload.binding;
  // No envelope: only the legacy single-package form is readable. A null package
  // (with or without pins) has no version identity here; package + pins together
  // is ambiguous and never guessed.
  if (binding.package === null || binding.package === undefined) return fail('BINDING_PAYLOAD_MISSING_SOURCE');
  if (Array.isArray(binding.template_pins) && binding.template_pins.length > 0) {
    return fail('BINDING_PAYLOAD_AMBIGUOUS_SOURCE');
  }

  const parsed = LegacyPayloadSchema.safeParse(payload);
  if (!parsed.success) return fail('BINDING_PAYLOAD_LEGACY_INVALID');
  const normalized = ResourceBindingCandidateSchema.safeParse({
    ...binding, template_pins: Array.isArray(binding.template_pins) ? binding.template_pins : [],
  });
  if (!normalized.success) return fail('BINDING_PAYLOAD_BINDING_INVALID');
  const application = parsed.data.application;
  if (application.status === 'applied' && application.applied_revision === null) {
    return fail('BINDING_PAYLOAD_APPLICATION_INVALID');
  }
  if (application.error_code !== null && application.status !== 'failed') {
    return fail('BINDING_PAYLOAD_APPLICATION_INVALID');
  }

  const applied = application.applied_revision;
  // Only a row whose resolved value belongs to the applied revision proves an
  // effective plan. A legacy row that kept the *pending* revision's resolved
  // value cannot prove the older applied one; that fact is reported, never filled.
  const provable = applied !== null && applied === normalized.data.revision;
  return {
    kind: 'legacy_published',
    source: 'package',
    payload,
    binding: normalized.data,
    application: {
      status: application.status,
      applied_revision: application.applied_revision,
      reported_at: application.reported_at,
      error_code: application.error_code,
    },
    effective: provable
      ? {
        source: 'package',
        revision: applied,
        resolution_identity: null,
        resolved: structuredClone(parsed.data.resolved),
      }
      : null,
    effective_missing: applied !== null && !provable,
  };
}

function decodeTemplatePayload(payload: Record<string, unknown>): DecodedTemplateBindingPayload {
  if (!hasOnlyKeys(payload, ['envelope', 'binding', 'template_resolution', 'application', 'effective', 'published_at'])) {
    return fail('BINDING_PAYLOAD_SHAPE_INVALID');
  }
  if (!isPlainObject(payload.binding)) return fail('BINDING_PAYLOAD_BINDING_INVALID');
  // The template form never carries a legacy package pin; both sources at once
  // is ambiguous, and no source at all has no version identity. These are read
  // before the candidate schema, whose own refine would collapse them into one
  // generic binding error.
  if (payload.binding.package !== null) {
    return fail(payload.binding.package === undefined
      ? 'BINDING_PAYLOAD_BINDING_INVALID'
      : 'BINDING_PAYLOAD_AMBIGUOUS_SOURCE');
  }
  if (!Array.isArray(payload.binding.template_pins) || payload.binding.template_pins.length === 0) {
    return fail('BINDING_PAYLOAD_MISSING_SOURCE');
  }
  const binding = ResourceBindingCandidateSchema.safeParse(payload.binding);
  if (!binding.success) return fail('BINDING_PAYLOAD_BINDING_INVALID');

  const resolution = payload.template_resolution;
  if (!isPlainObject(resolution) || !hasOnlyKeys(resolution, ['pending'])) {
    return fail('BINDING_PAYLOAD_PENDING_INVALID');
  }
  const pending = PendingSchema.safeParse(resolution.pending);
  if (!pending.success) return fail('BINDING_PAYLOAD_PENDING_INVALID');
  const base = pending.data.base_revision;
  const target = pending.data.target_revision;
  if (!Number.isSafeInteger(base + 1) || base + 1 !== target || binding.data.revision !== target) {
    return fail('BINDING_PAYLOAD_REVISION_INVALID');
  }

  const application = TemplateApplicationSchema.safeParse(payload.application);
  if (!application.success) return fail('BINDING_PAYLOAD_APPLICATION_INVALID');
  if (application.data.status === 'applied' && application.data.applied_revision === null) {
    return fail('BINDING_PAYLOAD_APPLICATION_INVALID');
  }
  if (application.data.error_code !== null && application.data.status !== 'failed') {
    return fail('BINDING_PAYLOAD_APPLICATION_INVALID');
  }
  if (application.data.applied_revision !== null && application.data.applied_revision > base) {
    return fail('BINDING_PAYLOAD_REVISION_INVALID');
  }

  // The plan keeps the identity of the **base** revision's resolution; the target
  // binding revision is mapped explicitly by `pending`, never by rewriting it.
  const pendingPlan = parsePlan(pending.data.plan, {
    identity: pending.data.resolution_identity,
    revision: base,
    resource: binding.data.resource,
  }, 'BINDING_PAYLOAD_PLAN_INVALID');

  const effective = parseEffective(payload.effective);
  const applied = application.data.applied_revision;
  if (applied === null) {
    if (effective !== null) return fail('BINDING_PAYLOAD_EFFECTIVE_INVALID');
  } else if (effective === null || effective.revision !== applied) {
    return fail('BINDING_PAYLOAD_EFFECTIVE_INVALID');
  }
  if ((effective?.resolution_identity ?? null) !== application.data.resolution_identity) {
    return fail('BINDING_PAYLOAD_IDENTITY_MISMATCH');
  }
  const publishedAt = TimestampSchema.safeParse(payload.published_at);
  if (!publishedAt.success) return fail('BINDING_PAYLOAD_SHAPE_INVALID');

  return {
    kind: 'template_pending',
    source: 'template',
    payload,
    binding: binding.data,
    pending: {
      base_revision: base,
      target_revision: target,
      resolution_identity: pending.data.resolution_identity,
      plan: pendingPlan,
      decided_at: pending.data.decided_at,
      operation_key: pending.data.operation_key,
    },
    application: {
      status: application.data.status,
      applied_revision: application.data.applied_revision,
      reported_at: application.data.reported_at,
      error_code: application.data.error_code,
      resolution_identity: application.data.resolution_identity,
    },
    effective,
    effective_missing: false,
    published_at: publishedAt.data,
  };
}

function parsePlan(
  value: unknown,
  expected: { identity: HashId; revision: number; resource?: { type: string; id: number } },
  code: BindingPersistenceErrorCode,
): TemplateCollectionPlan {
  if (!isPlainObject(value)
    || value.kind !== 'template_collection_plan'
    || value.identity !== expected.identity
    || value.revision !== expected.revision) {
    return fail(code);
  }
  const resource = value.resource;
  if (!isPlainObject(resource) || typeof resource.type !== 'string' || typeof resource.id !== 'string') {
    return fail(code);
  }
  if (expected.resource !== undefined
    && (resource.type !== expected.resource.type || resource.id !== String(expected.resource.id))) {
    return fail(code);
  }
  return value as unknown as TemplateCollectionPlan;
}

function parseEffective(value: unknown): EffectiveSnapshot | null {
  if (value === null) return null;
  if (!isPlainObject(value)) return fail('BINDING_PAYLOAD_EFFECTIVE_INVALID');
  if (value.source === 'package') {
    if (!hasOnlyKeys(value, ['source', 'revision', 'resolution_identity', 'resolved'])) {
      return fail('BINDING_PAYLOAD_EFFECTIVE_INVALID');
    }
    const revision = RevisionSchema.safeParse(value.revision);
    if (!revision.success || value.resolution_identity !== null || !isPlainObject(value.resolved)) {
      return fail('BINDING_PAYLOAD_EFFECTIVE_INVALID');
    }
    return {
      source: 'package', revision: revision.data, resolution_identity: null,
      resolved: structuredClone(value.resolved),
    };
  }
  if (value.source === 'template') {
    if (!hasOnlyKeys(value, ['source', 'revision', 'resolution_identity', 'plan'])) {
      return fail('BINDING_PAYLOAD_EFFECTIVE_INVALID');
    }
    const revision = RevisionSchema.safeParse(value.revision);
    const identity = HashIdSchema.safeParse(value.resolution_identity);
    if (!revision.success || !identity.success) return fail('BINDING_PAYLOAD_EFFECTIVE_INVALID');
    const plan = parsePlan(value.plan, { identity: identity.data, revision: revision.data }, 'BINDING_PAYLOAD_EFFECTIVE_INVALID');
    return { source: 'template', revision: revision.data, resolution_identity: identity.data, plan };
  }
  return fail('BINDING_PAYLOAD_EFFECTIVE_INVALID');
}

/** Re-serialize a decoded payload unchanged; a legacy row keeps its exact fields. */
export function encodeBindingPayload(decoded: DecodedBindingPayload): string {
  return JSON.stringify(decoded.payload);
}

export interface TemplatePendingWriteInput {
  /** The raw candidate with the target revision; never the resolved plan. */
  binding: ResourceBindingCandidate;
  base_revision: number;
  target_revision: number;
  resolution_identity: HashId;
  plan: TemplateCollectionPlan;
  decided_at: string;
  operation_key: string;
  /** Preserved from the previous application; a pending revision never promotes it. */
  applied_revision: number | null;
  previous_resolution_identity: HashId | null;
  previous_effective: EffectiveSnapshot | null;
  published_at: string;
}

/**
 * Build the next pending template payload. The previously effective snapshot and
 * applied revision are copied, never replaced by the pending plan, and the result
 * is validated through the same decoder before it is returned, so a writer cannot
 * persist a row this module would later reject.
 */
export function encodeTemplatePendingPayload(input: TemplatePendingWriteInput): string {
  const previousIdentity = input.previous_effective?.resolution_identity ?? null;
  if (input.previous_resolution_identity !== previousIdentity) {
    return fail('BINDING_PAYLOAD_IDENTITY_MISMATCH');
  }
  if ((input.previous_effective?.revision ?? null) !== input.applied_revision) {
    return fail('BINDING_PAYLOAD_EFFECTIVE_INVALID');
  }
  const payload = {
    envelope: BINDING_PAYLOAD_ENVELOPE,
    binding: structuredClone(input.binding),
    template_resolution: {
      pending: {
        base_revision: input.base_revision,
        target_revision: input.target_revision,
        resolution_identity: input.resolution_identity,
        plan: structuredClone(input.plan),
        decided_at: input.decided_at,
        operation_key: input.operation_key,
      },
    },
    application: {
      status: 'pending',
      applied_revision: input.applied_revision,
      reported_at: null,
      error_code: null,
      resolution_identity: input.previous_resolution_identity,
    },
    effective: input.previous_effective === null ? null : structuredClone(input.previous_effective),
    published_at: input.published_at,
  };
  const text = JSON.stringify(payload);
  // Self-check: never hand a writer a payload this decoder would reject.
  if (decodeBindingPayload(text).kind !== 'template_pending') {
    return fail('BINDING_PAYLOAD_SHAPE_INVALID');
  }
  return text;
}
