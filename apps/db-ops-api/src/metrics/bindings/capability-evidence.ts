/**
 * MAX-238 / NATIVE-CONFIGURATION-FLOW-R2 — trustworthy bootstrap capability
 * evidence.
 *
 * A resource that has never been bound has no row in `metric_policy_bindings`,
 * so the accepted `reportCapabilities` writer has nothing to update and the
 * existing activation predicate correctly refuses to enable it. This module adds
 * the missing *producer* side of that chain, without touching the predicate:
 *
 * - an explicit bounded read-only probe (performed by the service through the
 *   accepted `CollectorAccess` and `runPackage`) writes the capability facts it
 *   actually observed;
 * - the facts are stored under one exact identity — resource, pinned template
 *   versions and content hashes, credential reference, base revision and the
 *   caller's exact candidate intent — so they can never be reused for another
 *   resource, credential, pin, revision or edited draft;
 * - a row that is expired, unparsable or inconsistent is a refusal, never an
 *   implicit "absent" (an absent row is the only proof that nothing was probed).
 *
 * The writer is not a binding/policy/audit publisher: it owns one additive table
 * and one upsert. The first binding is still written by the existing host
 * transaction/CAS/journal.
 */
import type { Pool, PoolConnection } from 'mysql2/promise';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Ref } from '../policy/model.js';
import { RefSchema, refKey } from '../policy/model.js';
import { CapabilitySchema, TimestampSchema, type Capability } from '../../contracts/metrics/index.js';
import { ResourceBindingCandidateInputSchema, TemplatePinSchema } from '../../contracts/metrics/templates.js';
import { stable } from '../packages/model.js';
import { withPolicyAdmission } from '../policy/store.js';

/** Machine codes; a driver message never leaves this module. */
export type CapabilityEvidenceErrorCode =
  | 'CAPABILITY_EVIDENCE_UNAVAILABLE'
  | 'CAPABILITY_EVIDENCE_INVALID'
  | 'CAPABILITY_EVIDENCE_EXPIRED';

export class CapabilityEvidenceError extends Error {
  constructor(public readonly code: CapabilityEvidenceErrorCode) {
    super(code);
    this.name = 'CapabilityEvidenceError';
  }
}

export const CAPABILITY_EVIDENCE_FORMAT = 'max238.capability-evidence.v1';
/** The stored facts are a probe cache; the capability's own `valid_until` still governs enablement. */
export const CAPABILITY_EVIDENCE_TTL_MS = 900_000;

const HashTextSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const TimestampTextSchema = TimestampSchema;

const IdentitySchema = z.strictObject({
  resource: RefSchema,
  /** The base the caller read; 0 is the first binding of an unbound resource. */
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  /** Exact fixed pins, canonical order (template id, version). */
  template_pins: z.array(TemplatePinSchema).min(1),
  credential_ref: z.string().regex(/^credential:[A-Za-z0-9_-]{1,128}$/),
  /** Digest of the exact candidate intent the probe was authorized for. */
  intent_digest: HashTextSchema,
});
export type CapabilityEvidenceIdentity = z.infer<typeof IdentitySchema>;

const RecordSchema = z.strictObject({
  format: z.literal(CAPABILITY_EVIDENCE_FORMAT),
  evidence_key: HashTextSchema,
  resource: RefSchema,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  template_pins: z.array(TemplatePinSchema).min(1),
  credential_ref: z.string().regex(/^credential:[A-Za-z0-9_-]{1,128}$/),
  intent_digest: HashTextSchema,
  capabilities: z.array(CapabilitySchema).min(1),
  source: z.literal('read_only_probe'),
  actor_id: z.number().int().positive().nullable(),
  probed_at: TimestampTextSchema,
  expires_at: TimestampTextSchema,
});
export type CapabilityEvidenceRecord = z.infer<typeof RecordSchema>;

const copyPin = (pin: z.infer<typeof TemplatePinSchema>) => ({
  template_id: pin.template_id, version: pin.version, content_hash: pin.content_hash,
});

const sortedPins = (pins: ReadonlyArray<z.infer<typeof TemplatePinSchema>>) =>
  pins.map(copyPin).sort((left, right) => left.template_id < right.template_id ? -1
    : left.template_id > right.template_id ? 1 : left.version - right.version);

/** The exact candidate intent: every field the probe was authorized for. */
export function probeIntentDigest(candidate: unknown): string {
  return `sha256:${createHash('sha256').update(stable({
    format: `${CAPABILITY_EVIDENCE_FORMAT}.intent`,
    binding: ResourceBindingCandidateInputSchema.parse(candidate),
  })).digest('hex')}`;
}

/** One identity hash; every reuse boundary is folded into the key itself. */
export function capabilityEvidenceKey(input: CapabilityEvidenceIdentity): string {
  const identity = IdentitySchema.parse(input);
  return `sha256:${createHash('sha256').update(stable({
    format: CAPABILITY_EVIDENCE_FORMAT,
    resource: refKey(identity.resource),
    revision: identity.revision,
    template_pins: sortedPins(identity.template_pins),
    credential_ref: identity.credential_ref,
    intent_digest: identity.intent_digest,
  })).digest('hex')}`;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function decodePayload(value: unknown): unknown {
  if (typeof value === 'string') {
    try { return JSON.parse(value) as unknown; } catch { throw new CapabilityEvidenceError('CAPABILITY_EVIDENCE_INVALID'); }
  }
  if (isPlainObject(value)) return value;
  throw new CapabilityEvidenceError('CAPABILITY_EVIDENCE_INVALID');
}

/**
 * Parse one stored row and prove it is the exact identity that was asked for and
 * still inside its validity window. A broken row is an error, never a miss.
 */
export function parseCapabilityEvidence(
  raw: unknown,
  identity: CapabilityEvidenceIdentity,
  now: number,
): CapabilityEvidenceRecord {
  const parsed = RecordSchema.safeParse(decodePayload(raw));
  if (!parsed.success) throw new CapabilityEvidenceError('CAPABILITY_EVIDENCE_INVALID');
  const record = parsed.data;
  const expected = capabilityEvidenceKey(identity);
  if (record.evidence_key !== expected) throw new CapabilityEvidenceError('CAPABILITY_EVIDENCE_INVALID');
  if (record.revision !== identity.revision
    || record.credential_ref !== identity.credential_ref
    || record.intent_digest !== identity.intent_digest
    || refKey(record.resource) !== refKey(identity.resource)
    || stable(sortedPins(record.template_pins)) !== stable(sortedPins(identity.template_pins))) {
    throw new CapabilityEvidenceError('CAPABILITY_EVIDENCE_INVALID');
  }
  if (!(Date.parse(record.probed_at) <= now) || !(now < Date.parse(record.expires_at))) {
    throw new CapabilityEvidenceError('CAPABILITY_EVIDENCE_EXPIRED');
  }
  for (const capability of record.capabilities) {
    if (capability.resource_id !== String(identity.resource.id)) {
      throw new CapabilityEvidenceError('CAPABILITY_EVIDENCE_INVALID');
    }
  }
  return record;
}

export type CapabilityEvidenceExecutor = Pick<PoolConnection, 'execute'>;

/** The exact read; a missing row is null, everything else is a stable refusal. */
export async function readCapabilityEvidence(
  executor: CapabilityEvidenceExecutor,
  identity: CapabilityEvidenceIdentity,
  now: number,
): Promise<CapabilityEvidenceRecord | null> {
  const key = capabilityEvidenceKey(identity);
  let rows: unknown;
  try {
    [rows] = await executor.execute(
      'SELECT payload FROM metric_capability_evidence WHERE evidence_key = ?', [key],
    ) as unknown as [unknown, unknown];
  } catch {
    throw new CapabilityEvidenceError('CAPABILITY_EVIDENCE_UNAVAILABLE');
  }
  if (!Array.isArray(rows)) throw new CapabilityEvidenceError('CAPABILITY_EVIDENCE_UNAVAILABLE');
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !isPlainObject(rows[0])) throw new CapabilityEvidenceError('CAPABILITY_EVIDENCE_INVALID');
  return parseCapabilityEvidence(rows[0].payload, identity, now);
}

/** The one upsert; same identity means one row, never a duplicate publication. */
export const CAPABILITY_EVIDENCE_UPSERT_SQL =
  'INSERT INTO metric_capability_evidence (evidence_key, payload) VALUES (?, ?) '
  + 'ON DUPLICATE KEY UPDATE payload = VALUES(payload)';

export interface CapabilityEvidenceWriterDeps {
  readonly pool: () => Pool | null;
  /**
   * The trusted live grant at every boundary that can wait (admission, pool,
   * INSERT row lock, commit). A public caller must supply it; a missing source is
   * a refusal, never an implicit pass.
   */
  readonly authorize?: (connection?: CapabilityEvidenceExecutor) => Promise<void>;
}

export interface CapabilityEvidenceWriteInput extends CapabilityEvidenceIdentity {
  capabilities: Capability[];
  actor_id: number | null;
  probed_at: string;
  expires_at: string;
}

export interface CapabilityEvidenceWriteOutcome {
  readonly evidence_key: string;
  readonly record: CapabilityEvidenceRecord;
}

function affectedRowsOf(result: unknown): number | null {
  if (!Array.isArray(result) || !isPlainObject(result[0])) return null;
  const affected = result[0].affectedRows;
  return typeof affected === 'number' && Number.isSafeInteger(affected) && affected >= 0 ? affected : null;
}

/**
 * Persist one probe result. The upsert means a concurrent probe of the same
 * exact intent never creates a second row; the row that won is read back on the
 * same connection and returned, so every caller works from the stored facts.
 * A refused boundary rolls the upsert back: nothing is committed and rejected.
 */
export async function writeCapabilityEvidence(
  input: CapabilityEvidenceWriteInput,
  deps: CapabilityEvidenceWriterDeps,
): Promise<CapabilityEvidenceWriteOutcome> {
  const identity = IdentitySchema.parse({
    resource: input.resource, revision: input.revision, template_pins: input.template_pins,
    credential_ref: input.credential_ref, intent_digest: input.intent_digest,
  });
  const key = capabilityEvidenceKey(identity);
  const record = RecordSchema.parse({
    format: CAPABILITY_EVIDENCE_FORMAT, evidence_key: key,
    ...identity, capabilities: input.capabilities, source: 'read_only_probe',
    actor_id: input.actor_id, probed_at: input.probed_at, expires_at: input.expires_at,
  });
  const text = JSON.stringify(record);

  const pool = deps?.pool?.();
  if (pool === null || pool === undefined || typeof pool.getConnection !== 'function') {
    throw new CapabilityEvidenceError('CAPABILITY_EVIDENCE_UNAVAILABLE');
  }

  return withPolicyAdmission(pool, async () => {
    const authorize = deps.authorize;
    await authorize?.();
    let connection: PoolConnection;
    try { connection = await pool.getConnection(); }
    catch { throw new CapabilityEvidenceError('CAPABILITY_EVIDENCE_UNAVAILABLE'); }
    let settled = false;
    try {
      try {
        await connection.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await connection.beginTransaction();
      } catch { throw new CapabilityEvidenceError('CAPABILITY_EVIDENCE_UNAVAILABLE'); }
      try {
        await authorize?.(connection);
        let written: unknown;
        try {
          written = await connection.execute(CAPABILITY_EVIDENCE_UPSERT_SQL, [key, text]);
        } catch { throw new CapabilityEvidenceError('CAPABILITY_EVIDENCE_UNAVAILABLE'); }
        const affected = affectedRowsOf(written);
        // 1 insert, 2 update, 0 unchanged: all leave exactly one row.
        if (affected === null || affected > 2) throw new CapabilityEvidenceError('CAPABILITY_EVIDENCE_UNAVAILABLE');
        // The upsert can wait on a row lock; the grant that held after that wait
        // is the one that may commit.
        await authorize?.(connection);
        let rows: unknown;
        try {
          [rows] = await connection.execute(
            'SELECT payload FROM metric_capability_evidence WHERE evidence_key = ?', [key],
          ) as unknown as [unknown, unknown];
        } catch { throw new CapabilityEvidenceError('CAPABILITY_EVIDENCE_UNAVAILABLE'); }
        if (!Array.isArray(rows) || rows.length !== 1 || !isPlainObject(rows[0])) {
          throw new CapabilityEvidenceError('CAPABILITY_EVIDENCE_UNAVAILABLE');
        }
        // Another probe with the same exact intent may have won the upsert; its
        // row is the stored fact every caller must work from. It is validated at
        // the later of the two probe instants, never at an unrelated wall clock.
        const storedAt = (decodePayload(rows[0].payload) as { probed_at?: unknown }).probed_at;
        const storedInstant = typeof storedAt === 'string' ? Date.parse(storedAt) : Number.NaN;
        const stored = parseCapabilityEvidence(
          rows[0].payload, identity,
          Math.max(Date.parse(record.probed_at), Number.isFinite(storedInstant) ? storedInstant : 0),
        );
        try { await connection.commit(); } catch { throw new CapabilityEvidenceError('CAPABILITY_EVIDENCE_UNAVAILABLE'); }
        settled = true;
        return { evidence_key: key, record: stored };
      } catch (error) {
        if (!settled) {
          try { await connection.rollback(); settled = true; } catch { /* discard instead */ }
        }
        throw error;
      }
    } finally {
      if (settled) { try { connection.release(); } catch { /* released once */ } }
      else { try { connection.destroy(); } catch { /* discarded once */ } }
    }
  });
}
