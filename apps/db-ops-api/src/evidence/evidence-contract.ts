import { createHash } from 'node:crypto';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const timestamp = Type.String({ minLength: 24, maxLength: 24, pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' });
export const EvidenceResourceSchema = Type.Object({ type: Type.Union([Type.Literal('instance'), Type.Literal('server'), Type.Literal('network_device')]), id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }, { additionalProperties: false });
export const EvidenceItemSchema = Type.Object({
  schemaVersion: Type.Literal(1), id: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  kind: Type.Union(['observation', 'invariant', 'expectation', 'deployment', 'source', 'history'].map(value => Type.Literal(value))),
  status: Type.Union([Type.Literal('fact'), Type.Literal('inference'), Type.Literal('hypothesis')]),
  subject: Type.Object({ resource: EvidenceResourceSchema }, { additionalProperties: false }),
  quality: Type.Union([Type.Literal('good'), Type.Literal('degraded'), Type.Literal('invalid'), Type.Literal('unknown')]),
  observedAt: timestamp, validUntil: timestamp, source: text(256), correlationId: text(128), provenance: text(512),
  dimensions: Type.Optional(Type.Record(Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' }), Type.String({ maxLength: 256 }), { maxProperties: 16, additionalProperties: false })),
  payload: Type.Object({ metricId: Type.Optional(text(128)), value: Type.Optional(Type.Union([Type.Number(), Type.Null()])), statement: Type.Optional(text(2000)), reason: Type.Optional(text(512)), sourceVersion: Type.Optional(text(256)) }, { additionalProperties: false }),
}, { additionalProperties: false });
export type EvidenceItem = Static<typeof EvidenceItemSchema>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]));
  return value;
}
export function evidenceId(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function validateEvidenceItem(value: unknown): value is EvidenceItem {
  if (!Value.Check(EvidenceItemSchema, value)) return false;
  const { id, ...content } = value;
  const start = Date.parse(value.observedAt), end = Date.parse(value.validUntil);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    && new Date(start).toISOString() === value.observedAt && new Date(end).toISOString() === value.validUntil
    && Buffer.byteLength(JSON.stringify(value)) <= 16_384 && id === evidenceId(content);
}
export function sortEvidence(items: EvidenceItem[]): EvidenceItem[] {
  const rank = { fact: 0, inference: 1, hypothesis: 2 };
  return [...items].sort((a, b) => b.observedAt.localeCompare(a.observedAt) || rank[a.status] - rank[b.status] || a.id.localeCompare(b.id));
}
